import { defineAction, fail } from "@agent-native/core/action";
import { resolveSecretDetailed } from "@agent-native/core/server";
import { z } from "zod";

import { getDb } from "../server/db/index.js";
import {
  buildDebateEvidencePack,
  isDebateEvidenceError,
  type EvidencePack,
} from "../server/lib/debate-evidence.js";
import {
  isDebateLlmError,
  runDebateRole,
  type RoleUsage,
  type DebateLlmDependencies,
  type JudgeOutput,
  type OpponentOutput,
  type ProponentOutput,
} from "../server/lib/debate-llm.js";
import {
  claimRun,
  completeRun,
  createQueuedRun,
  failRun,
  getDebateRunById,
  isDebateRunError,
  parseEvidenceSnapshot,
  persistRoleMessage,
  type DebateDb,
} from "../server/lib/debate-run.js";

/** Fixed default OpenRouter model id — never read from env. */
import { DEFAULT_DEBATE_RUN_MODEL_ID, FREE_MODEL_RATE_LIMIT } from "../shared/debate-model.js";
export { DEFAULT_DEBATE_RUN_MODEL_ID };

/** Wall-clock budget advertised to agent tooling. */
const ACTION_TIMEOUT_MS = 300_000;

const OPENROUTER_SECRET_KEY = "OPENROUTER_API_KEY";
const MODEL_ID_MAX_CHARS = 128;
const MODEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/;
const FAIL_RUN_MESSAGE_MAX = 200;

export type StartDebateRunTestOverrides = {
  runDebateRole?: typeof runDebateRole;
  resolveOpenRouterSecret?: DebateLlmDependencies["resolveOpenRouterSecret"];
  createQueuedRun?: typeof createQueuedRun;
  claimRun?: typeof claimRun;
  persistRoleMessage?: typeof persistRoleMessage;
  completeRun?: typeof completeRun;
  failRun?: typeof failRun;
  /** Invoked after a successful completeRun; tests may throw here. */
  afterComplete?: () => void | Promise<void>;
};

let testOverrides: StartDebateRunTestOverrides | undefined;

/**
 * Vitest sets VITEST=true. We intentionally do not treat NODE_ENV=test alone as
 * sufficient, so a production process with NODE_ENV=test cannot open the hook.
 * Remaining risk: an operator who sets VITEST=true in a real deploy could enable
 * the setter — that misconfiguration must be avoided.
 */
export function isStartDebateRunTestRuntime(): boolean {
  return process.env.VITEST === "true" || process.env.VITEST === "1";
}

function getTestOverrides(): StartDebateRunTestOverrides | undefined {
  if (!isStartDebateRunTestRuntime()) return undefined;
  return testOverrides;
}

/** Test-only hook — rejected outside Vitest. */
export function setStartDebateRunTestOverrides(
  overrides: StartDebateRunTestOverrides | undefined,
): void {
  if (!isStartDebateRunTestRuntime()) {
    throw new Error(
      "setStartDebateRunTestOverrides is only available under Vitest.",
    );
  }
  testOverrides = overrides;
}

function normalizeModelId(raw: string | undefined): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  const modelId = trimmed.length > 0 ? trimmed : DEFAULT_DEBATE_RUN_MODEL_ID;

  if (modelId.length > MODEL_ID_MAX_CHARS) {
    fail("modelId is too long.", { statusCode: 400 });
  }
  if (/\s/.test(modelId) || /[\u0000-\u001f\u007f]/.test(modelId)) {
    fail("modelId contains invalid whitespace or control characters.", {
      statusCode: 400,
    });
  }
  if (!MODEL_ID_PATTERN.test(modelId)) {
    fail(
      'modelId must look like an OpenRouter id (e.g. "openai/gpt-4o-mini").',
      { statusCode: 400 },
    );
  }
  if (modelId !== DEFAULT_DEBATE_RUN_MODEL_ID) {
    fail("Only the configured Scientific Debate model is enabled.", { statusCode: 400 });
  }
  return modelId;
}

/** Fixed, short failRun texts for known domain errors — never raw Error.message of unknowns. */
function safeFailRunMessage(error: unknown): string {
  if (isDebateEvidenceError(error)) {
    switch (error.code) {
      case "debate_evidence_not_found":
        return "Debate not found.";
      case "debate_evidence_no_papers":
        return "Debate has no attached papers.";
      case "debate_evidence_invalid_paper":
        return "Debate evidence paper is invalid.";
      case "debate_evidence_invalid_citation":
        return "Debate evidence citation is invalid.";
      default:
        return "Debate evidence error.";
    }
  }
  if (isDebateLlmError(error)) {
    switch (error.code) {
      case "debate_llm_missing_key":
        return "OpenRouter API key is not configured.";
      case "debate_llm_secret_lookup_failed":
        return "Credential store lookup failed.";
      case "debate_llm_model_call_failed":
        return "Debate model call failed or timed out.";
      case "debate_llm_rate_limited":
        return FREE_MODEL_RATE_LIMIT;
      case "debate_llm_invalid_output":
        return "Debate model output was invalid.";
      case "debate_llm_invalid_citation":
        return "Debate model cited an id outside the evidence snapshot.";
      case "debate_llm_citation_mismatch":
        return "Debate model citation fields were inconsistent.";
      case "debate_llm_missing_prerequisite":
        return "Debate model prerequisites were missing.";
      case "debate_llm_invalid_model_id":
        return "modelId is invalid.";
      default:
        return "Debate model error.";
    }
  }
  if (isDebateRunError(error)) {
    switch (error.code) {
      case "debate_run_active_conflict":
        return "A debate run is already in progress.";
      case "debate_run_not_eligible":
        return "Debate run is not eligible for this transition.";
      case "debate_run_message_conflict":
        return "Debate role message already exists.";
      case "debate_run_validation_error":
        return "Debate run validation failed.";
      case "debate_run_serialization_error":
        return "Debate run serialization failed.";
      default:
        return "Debate run persistence error.";
    }
  }
  return "Debate run failed.".slice(0, FAIL_RUN_MESSAGE_MAX);
}

function rethrowAsActionFailure(error: unknown): never {
  if (isDebateEvidenceError(error)) {
    fail(error.message, { statusCode: error.statusCode });
  }
  if (isDebateLlmError(error)) {
    fail(error.message, { statusCode: error.statusCode });
  }
  if (isDebateRunError(error)) {
    fail(error.message, { statusCode: error.statusCode });
  }
  fail("Debate run failed unexpectedly.", { statusCode: 500 });
}

async function preflightOpenRouterSecret(
  resolveSecret: NonNullable<
    DebateLlmDependencies["resolveOpenRouterSecret"]
  >,
): Promise<void> {
  const secret = await resolveSecret();
  if (secret.lookupFailed) {
    fail("Credential store lookup failed. Retry shortly.", {
      statusCode: 503,
    });
  }
  if (!secret.value) {
    fail(
      "OpenRouter API key is not configured. Connect OpenRouter in Settings.",
      { statusCode: 400 },
    );
  }
}

async function defaultResolveOpenRouterSecret(): Promise<{
  value: string | null;
  lookupFailed: boolean;
}> {
  const detail = await resolveSecretDetailed(OPENROUTER_SECRET_KEY);
  return {
    value: detail.value,
    lookupFailed: detail.lookupFailed,
  };
}

export default defineAction({
  description:
    "Start a synchronous scientific debate run for a claim the signed-in user owns. Builds an EvidencePack from attached papers, runs Proponent → Opponent → Judge via OpenRouter, and persists the run. Does not accept client-supplied evidence or owner identity.",
  schema: z.object({
    debateId: z
      .string()
      .trim()
      .min(1)
      .describe("Debate id returned by create-debate"),
    modelId: z
      .string()
      .trim()
      .max(MODEL_ID_MAX_CHARS)
      .optional()
      .describe(
        `Optional OpenRouter model id; defaults to ${DEFAULT_DEBATE_RUN_MODEL_ID}`,
      ),
  }),
  timeoutMs: ACTION_TIMEOUT_MS,
  run: async (args, ctx) => {
    // Intentionally do not forward ctx.signal to runDebateRole: sync MVP continues
    // after client disconnect when possible (see delivery report §G).
    const userEmail =
      ctx?.userEmail ??
      fail("Sign in to start a debate run.", { statusCode: 401 });

    const modelId = normalizeModelId(args.modelId);
    const db: DebateDb = getDb();

    const overrides = getTestOverrides();
    const resolveSecret =
      overrides?.resolveOpenRouterSecret ?? defaultResolveOpenRouterSecret;
    const runRole = overrides?.runDebateRole ?? runDebateRole;
    const createRun = overrides?.createQueuedRun ?? createQueuedRun;
    const claim = overrides?.claimRun ?? claimRun;
    const persistMessage = overrides?.persistRoleMessage ?? persistRoleMessage;
    const complete = overrides?.completeRun ?? completeRun;
    const failQueued = overrides?.failRun ?? failRun;

    await preflightOpenRouterSecret(resolveSecret);

    let builtPack: EvidencePack;
    try {
      builtPack = await buildDebateEvidencePack(db, args.debateId, userEmail);
    } catch (error) {
      rethrowAsActionFailure(error);
    }

    let runId: string | undefined;
    let completed = false;

    try {
      const queued = await createRun({
        db,
        debateId: args.debateId,
        modelId,
        evidencePack: builtPack,
        createdByEmail: userEmail,
      });
      runId = queued.id;

      // Authority for LLM is the persisted snapshot, not the pre-insert object.
      const evidencePack = parseEvidenceSnapshot(queued.evidenceSnapshotJson);

      await claim({ db, runId });

      const llmDeps: DebateLlmDependencies = {
        resolveOpenRouterSecret: resolveSecret,
      };

      let proponentUsage: RoleUsage | undefined;
      const proponent = (await runRole({
        onUsage: usage => { proponentUsage = usage; },
        role: "proponent",
        modelId,
        evidencePack,
        dependencies: llmDeps,
      })) as ProponentOutput;
      const proponentMessage = await persistMessage({
        db,
        runId,
        role: "proponent",
        output: proponent,
        usage: proponentUsage,
      });

      let opponentUsage: RoleUsage | undefined;
      const opponent = (await runRole({
        onUsage: usage => { opponentUsage = usage; },
        role: "opponent",
        modelId,
        evidencePack,
        proponentOutput: proponent,
        dependencies: llmDeps,
      })) as OpponentOutput;
      const opponentMessage = await persistMessage({
        db,
        runId,
        role: "opponent",
        output: opponent,
        usage: opponentUsage,
      });

      let judgeUsage: RoleUsage | undefined;
      const judge = (await runRole({
        onUsage: usage => { judgeUsage = usage; },
        role: "judge",
        modelId,
        evidencePack,
        proponentOutput: proponent,
        opponentOutput: opponent,
        dependencies: llmDeps,
      })) as JudgeOutput;
      const judgeMessage = await persistMessage({
        db,
        runId,
        role: "judge",
        output: judge,
        usage: judgeUsage,
      });

      const finished = await complete({ db, runId });
      completed = true;

      if (overrides?.afterComplete) {
        await overrides.afterComplete();
      }

      return {
        success: true as const,
        debateId: args.debateId,
        runId: finished.id,
        status: "completed" as const,
        modelId: finished.modelId,
        roles: {
          proponent: {
            messageId: proponentMessage.id,
            summary: proponent.summary,
          },
          opponent: {
            messageId: opponentMessage.id,
            summary: opponent.summary,
          },
          judge: {
            messageId: judgeMessage.id,
            summary: judge.summary,
          },
        },
      };
    } catch (error) {
      if (runId && !completed) {
        try {
          await failQueued({
            db,
            runId,
            errorMessage: safeFailRunMessage(error),
          });
        } catch (finalizationError) {
          if (isDebateRunError(finalizationError) && finalizationError.code === "debate_run_not_eligible") {
            const terminal = await getDebateRunById(db, runId).catch(() => null);
            if (terminal?.status === "failed" && terminal.errorMessage === "Cancelled by the owner.") {
              fail("Cancelled by the owner.", { statusCode: 409 });
            }
          }
          fail(
            "Debate run failed and could not be marked failed; it may still appear active.",
            { statusCode: 500 },
          );
        }
      }
      rethrowAsActionFailure(error);
    }
  },
});

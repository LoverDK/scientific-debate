import { resolveSecretDetailed } from "@agent-native/core/server";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  APICallError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  generateText,
  Output,
} from "ai";
import { z } from "zod";
import { DEFAULT_DEBATE_RUN_MODEL_ID, FREE_MODEL_ROUTING } from "../../shared/debate-model.js";

import {
  classifyPaperStance,
  type EvidenceStance,
} from "./evidence-stance.js";
import type { OpenAlexMappedWork } from "./openalex-works.js";

const OPENROUTER_SECRET_KEY = "OPENROUTER_API_KEY";
/** Must stay on the Scientific Debate free allowlist (no paid models). */
export const FREE_EVIDENCE_CLASSIFIER_MODEL_ID = DEFAULT_DEBATE_RUN_MODEL_ID;
const BATCH_SIZE = 5;
const BATCH_TIMEOUT_MS = 60_000;

const stanceBatchSchema = z.strictObject({
  papers: z
    .array(
      z.strictObject({
        externalId: z.string().min(1).max(64),
        stance: z.enum(["supports", "opposes", "uncertain"]),
        rationale: z.string().min(1).max(400),
      }),
    )
    .min(1)
    .max(BATCH_SIZE),
});

export type ClassifiedEvidencePaper = OpenAlexMappedWork & {
  stance: EvidenceStance;
  rationale: string;
  classifier: "openrouter-free" | "heuristic-fallback";
};

function escapeForPrompt(value: string): string {
  return value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String((error as { name?: unknown }).name) : "";
  return name === "AbortError" || name === "TimeoutError";
}

async function classifyBatchWithOpenRouter(options: {
  apiKey: string;
  modelId: string;
  claim: string;
  papers: OpenAlexMappedWork[];
}): Promise<Map<string, { stance: EvidenceStance; rationale: string }>> {
  const paperBlocks = options.papers
    .map((paper, index) => {
      const abstract =
        paper.abstract && paper.abstract.trim()
          ? paper.abstract.slice(0, 1200)
          : "(no abstract)";
      return [
        `<paper index="${index + 1}">`,
        `  <externalId>${escapeForPrompt(paper.externalId)}</externalId>`,
        `  <title>${escapeForPrompt(paper.title ?? "(untitled)")}</title>`,
        `  <abstract>${escapeForPrompt(abstract)}</abstract>`,
        `</paper>`,
      ].join("\n");
    })
    .join("\n");

  const openrouter = createOpenRouter({ apiKey: options.apiKey });
  const result = await generateText({
    model: openrouter(options.modelId, { provider: FREE_MODEL_ROUTING }),
    output: Output.object({ schema: stanceBatchSchema }),
    maxRetries: 0,
    timeout: BATCH_TIMEOUT_MS,
    system: [
      "You classify whether scholarly papers support or oppose a scientific claim.",
      "Use ONLY the provided title/abstract metadata. Do not invent full-text methods or results.",
      "Return one entry per input paper, reusing the exact externalId.",
      "stance=supports: abstract/title evidence leans in favor of the claim.",
      "stance=opposes: abstract/title evidence leans against, limits, fails, or contradicts the claim.",
      "stance=uncertain: irrelevant, mixed, or insufficient metadata.",
      "Keep rationale short and evidence-based.",
    ].join(" "),
    prompt: [
      `<claim>${escapeForPrompt(options.claim)}</claim>`,
      "<papers>",
      paperBlocks,
      "</papers>",
    ].join("\n"),
  });

  const parsed = stanceBatchSchema.parse(result.output);
  const map = new Map<string, { stance: EvidenceStance; rationale: string }>();
  for (const item of parsed.papers) {
    map.set(item.externalId, {
      stance: item.stance,
      rationale: `${item.rationale} (OpenRouter free model; title/abstract only)`,
    });
  }
  return map;
}

/**
 * Classify candidate papers with the allowlisted free OpenRouter model.
 * Requires OPENROUTER_API_KEY. Per-batch failures fall back to heuristics for
 * that batch only so gathering can still complete.
 */
export async function classifyPapersWithFreeOpenRouter(options: {
  claim: string;
  papers: OpenAlexMappedWork[];
  keywords: string[];
}): Promise<{
  classified: ClassifiedEvidencePaper[];
  modelId: string;
  usedFallback: boolean;
}> {
  const detail = await resolveSecretDetailed(OPENROUTER_SECRET_KEY);
  if (detail.lookupFailed) {
    throw new Error("OPENROUTER_SECRET_LOOKUP_FAILED");
  }
  if (!detail.value) {
    throw new Error("OPENROUTER_KEY_MISSING");
  }

  const modelId = FREE_EVIDENCE_CLASSIFIER_MODEL_ID;
  const classified: ClassifiedEvidencePaper[] = [];
  let usedFallback = false;

  for (let i = 0; i < options.papers.length; i += BATCH_SIZE) {
    const batch = options.papers.slice(i, i + BATCH_SIZE);
    try {
      const labels = await classifyBatchWithOpenRouter({
        apiKey: detail.value,
        modelId,
        claim: options.claim,
        papers: batch,
      });
      for (const paper of batch) {
        const labeled = labels.get(paper.externalId);
        if (labeled) {
          classified.push({
            ...paper,
            stance: labeled.stance,
            rationale: labeled.rationale,
            classifier: "openrouter-free",
          });
          continue;
        }
        const heuristic = classifyPaperStance(
          options.claim,
          paper,
          options.keywords,
        );
        usedFallback = true;
        classified.push({
          ...paper,
          stance: heuristic.stance,
          rationale: `Model omitted this id; heuristic fallback (support=${heuristic.supportScore}, oppose=${heuristic.opposeScore}).`,
          classifier: "heuristic-fallback",
        });
      }
    } catch (error) {
      if (APICallError.isInstance(error) && error.statusCode === 429) throw error;
      if (
        APICallError.isInstance(error) ||
        NoObjectGeneratedError.isInstance(error) ||
        NoOutputGeneratedError.isInstance(error) ||
        isAbortError(error)
      ) {
        console.warn(
          "[evidence-stance-llm] Free-model batch failed; using heuristic fallback.",
          error instanceof Error ? error.name : "unknown",
        );
      } else {
        console.warn(
          "[evidence-stance-llm] Unexpected classify failure; using heuristic fallback.",
        );
      }
      usedFallback = true;
      for (const paper of batch) {
        const heuristic = classifyPaperStance(
          options.claim,
          paper,
          options.keywords,
        );
        classified.push({
          ...paper,
          stance: heuristic.stance,
          rationale: `Free-model batch failed; heuristic fallback (support=${heuristic.supportScore}, oppose=${heuristic.opposeScore}).`,
          classifier: "heuristic-fallback",
        });
      }
    }
  }

  return { classified, modelId, usedFallback };
}

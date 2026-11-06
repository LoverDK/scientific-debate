import { defineAction, fail } from "@agent-native/core/action";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  judgeOutputSchema,
  opponentOutputSchema,
  proponentOutputSchema,
} from "../server/lib/debate-llm.js";
import { toSafeRunErrorSummary } from "../server/lib/safe-run-error.js";
import { parseEvidenceSnapshot } from "../server/lib/debate-run.js";
import type { JudgeOutput } from "../server/lib/debate-llm.js";

const messageSchema = z.discriminatedUnion("role", [
  proponentOutputSchema,
  opponentOutputSchema,
  judgeOutputSchema,
]);

/**
 * Compact result view for Agents: prefer a specific runId, else latest completed,
 * else latest run (may be failed/partial).
 */
export default defineAction({
  description:
    "Get the debate result for an owned debate: judge verdict when present, role summaries, status, and safe errorSummary. Pass runId or omit to use the latest completed run (else latest run).",
  schema: z.object({
    debateId: z.string().trim().min(1),
    runId: z.string().trim().min(1).optional(),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ debateId, runId }, ctx) => {
    const owner =
      ctx?.userEmail ??
      fail("Sign in to view debate results.", { statusCode: 401 });
    const { debates, debateRuns, debateMessages } = schema;
    const db = getDb();

    const [owned] = await db
      .select({ id: debates.id, claim: debates.claim })
      .from(debates)
      .where(and(eq(debates.id, debateId), eq(debates.ownerEmail, owner)))
      .limit(1);
    if (!owned) fail("Debate not found.", { statusCode: 404 });

    let runRow;
    if (runId) {
      [runRow] = await db
        .select()
        .from(debateRuns)
        .where(
          and(eq(debateRuns.id, runId), eq(debateRuns.debateId, debateId)),
        )
        .limit(1);
      if (!runRow) fail("Debate run not found.", { statusCode: 404 });
    } else {
      const completed = await db
        .select()
        .from(debateRuns)
        .where(
          and(
            eq(debateRuns.debateId, debateId),
            eq(debateRuns.status, "completed"),
          ),
        )
        .orderBy(desc(debateRuns.createdAt), desc(debateRuns.id))
        .limit(1);
      if (completed[0]) {
        runRow = completed[0];
      } else {
        const latest = await db
          .select()
          .from(debateRuns)
          .where(eq(debateRuns.debateId, debateId))
          .orderBy(desc(debateRuns.createdAt), desc(debateRuns.id))
          .limit(1);
        runRow = latest[0];
      }
      if (!runRow) {
        fail("No debate runs yet for this debate.", { statusCode: 404 });
      }
    }

    const messageRows = await db
      .select({
        role: debateMessages.role,
        payloadJson: debateMessages.payloadJson,
      })
      .from(debateMessages)
      .where(eq(debateMessages.runId, runRow.id));

    const roles: {
      proponentSummary: string | null;
      opponentSummary: string | null;
      judge: {
        verdict: "supports" | "opposes" | "insufficient_evidence";
        confidence: number;
        summary: string;
        limitations: string[];
        arguments: JudgeOutput["arguments"];
        researchNotes?: JudgeOutput["researchNotes"];
      } | null;
    } = {
      proponentSummary: null,
      opponentSummary: null,
      judge: null,
    };

    for (const row of messageRows) {
      try {
        const output = messageSchema.parse(JSON.parse(row.payloadJson));
        if (output.role !== row.role) continue;
        if (output.role === "proponent") roles.proponentSummary = output.summary;
        if (output.role === "opponent") roles.opponentSummary = output.summary;
        if (output.role === "judge") {
          roles.judge = {
            verdict: output.verdict,
            confidence: output.confidence,
            summary: output.summary,
            limitations: output.limitations,
            arguments: output.arguments,
            researchNotes: output.researchNotes,
          };
        }
      } catch {
        // Skip corrupt payloads; get-debate-run remains the full inspector.
      }
    }

    return {
      debateId,
      claim: parseEvidenceSnapshot(runRow.evidenceSnapshotJson).claim,
      runId: runRow.id,
      status: runRow.status,
      modelId: runRow.modelId,
      createdAt: runRow.createdAt,
      finishedAt: runRow.finishedAt,
      errorSummary: toSafeRunErrorSummary(runRow.errorMessage),
      ...roles,
    };
  },
});

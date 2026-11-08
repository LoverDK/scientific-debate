import { defineAction, fail } from "@agent-native/core/action";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import getRun from "./get-debate-run.js";
import type { JudgeOutput } from "../server/lib/debate-llm.js";

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
    const { debates, debateRuns } = schema;
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

    // Reuse the same owner, snapshot and citation validation as the inspector
    // and exports. Corrupt stored messages must not silently disappear.
    const run = await getRun.run({ runId: runRow.id }, ctx);

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

    for (const { output } of run.messages) {
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
    }

    return {
      debateId,
      claim: run.evidencePack.claim,
      runId: run.id,
      status: run.status,
      modelId: run.modelId,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
      errorSummary: run.errorSummary,
      ...roles,
    };
  },
});

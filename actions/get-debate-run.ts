import { defineAction, fail } from "@agent-native/core/action";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { roleUsageSchema, judgeOutputSchema, opponentOutputSchema, proponentOutputSchema } from "../server/lib/debate-llm.js";
import { parseEvidenceSnapshot } from "../server/lib/debate-run.js";
import { toSafeRunErrorSummary } from "../server/lib/safe-run-error.js";

const messageSchema = z.discriminatedUnion("role", [
  proponentOutputSchema, opponentOutputSchema, judgeOutputSchema,
]);

export default defineAction({
  description:
    "Read a debate run owned by the signed-in user: status, modelId, timestamps, safe errorSummary, EvidencePack snapshot, and saved role messages.",
  schema: z.object({ runId: z.string().trim().min(1) }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ runId }, ctx) => {
    const owner = ctx?.userEmail ?? fail("Sign in to view a debate run.", { statusCode: 401 });
    const { debates, debateRuns: runs, debateMessages: messages } = schema;
    const rows = await getDb().select({
      id: runs.id,
      debateId: runs.debateId,
      status: runs.status,
      modelId: runs.modelId,
      createdAt: runs.createdAt,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
      errorMessage: runs.errorMessage,
      currentRunId: debates.currentRunId,
      evidenceSnapshotJson: runs.evidenceSnapshotJson,
      message: { id: messages.id, role: messages.role, payload: messages.payloadJson, usageJson: messages.usageJson },
    }).from(runs)
      .innerJoin(debates, eq(debates.id, runs.debateId))
      .leftJoin(messages, eq(messages.runId, runs.id))
      .where(and(eq(runs.id, runId), eq(debates.ownerEmail, owner)))
      .orderBy(asc(messages.createdAt), asc(messages.id));

    const row = rows[0] ?? fail("Debate run not found.", { statusCode: 404 });
    const {
      evidenceSnapshotJson,
      message: _message,
      errorMessage,
      currentRunId,
      ...run
    } = row;
    try {
      return {
        ...run,
        errorSummary: toSafeRunErrorSummary(errorMessage),
        isActive:
          (run.status === "queued" || run.status === "running") &&
          run.id === currentRunId,
        evidencePack: parseEvidenceSnapshot(evidenceSnapshotJson),
        messages: rows.flatMap(({ message }) => {
          if (!message) return [];
          const output = messageSchema.parse(JSON.parse(message.payload));
          if (output.role !== message.role) throw new Error("Role mismatch.");
          return [{ id: message.id, role: output.role, output, usage: message.usageJson ? roleUsageSchema.parse(JSON.parse(message.usageJson)) : null }];
        }),
      };
    } catch {
      fail("Stored debate run data could not be read.", { statusCode: 500 });
    }
  },
});

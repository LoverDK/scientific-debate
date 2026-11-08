import { defineAction, fail } from "@agent-native/core/action";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { roleUsageSchema, judgeOutputSchema, opponentOutputSchema, proponentOutputSchema } from "../server/lib/debate-llm.js";
import { parseEvidenceSnapshot } from "../server/lib/debate-run.js";
import { toSafeRunErrorSummary } from "../server/lib/safe-run-error.js";
import { debateSnapshotSchema } from "../server/lib/debate-snapshot.js";
import { validateCitedExternalIds } from "../server/lib/debate-evidence.js";

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
      ...run
    } = row;
    try {
      const evidencePack = debateSnapshotSchema.parse(parseEvidenceSnapshot(evidenceSnapshotJson));
      if (evidencePack.debateId !== run.debateId) throw new Error("Snapshot scope mismatch.");
      const roleOrder = { proponent: 0, opponent: 1, judge: 2 };
      return {
        ...run,
        errorSummary: toSafeRunErrorSummary(errorMessage),
        isActive: run.status === "queued" || run.status === "running",
        evidencePack,
        messages: rows.flatMap(({ message }) => {
          if (!message) return [];
          const output = messageSchema.parse(JSON.parse(message.payload));
          if (output.role !== message.role) throw new Error("Role mismatch.");
          validateCitedExternalIds(output.citedExternalIds, evidencePack);
          const argumentIds = new Set<string>();
          for (const argument of output.arguments) {
            validateCitedExternalIds(argument.citedExternalIds, evidencePack);
            argument.citedExternalIds.forEach(id => argumentIds.add(id));
          }
          const topIds = new Set(output.citedExternalIds);
          if (topIds.size !== argumentIds.size || [...topIds].some(id => !argumentIds.has(id))) {
            throw new Error("Citation mismatch.");
          }
          return [{ id: message.id, role: output.role, output, usage: message.usageJson ? roleUsageSchema.parse(JSON.parse(message.usageJson)) : null }];
        }).sort((a, b) => roleOrder[a.role] - roleOrder[b.role]),
      };
    } catch {
      fail("Stored debate run data could not be read.", { statusCode: 500 });
    }
  },
});

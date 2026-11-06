import { defineAction, fail } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { parseEvidenceSnapshot } from "../server/lib/debate-run.js";

export default defineAction({
  description: "Save a signed-in owner's human contribution to a debate run. Citation IDs must belong to that run's evidence snapshot.",
  schema: z.object({
    runId: z.string().trim().min(1),
    kind: z.enum(["viewpoint", "question", "challenge", "citation_explanation", "follow_up"]),
    role: z.enum(["proponent", "opponent", "judge"]).optional(),
    citedExternalId: z.string().trim().min(1).max(256).optional(),
    body: z.string().trim().min(1).max(4000),
  }),
  run: async ({ runId, kind, role, citedExternalId, body }, ctx) => {
    const owner = ctx?.userEmail ?? fail("Sign in to contribute.", { statusCode: 401 });
    const { debates, debateRuns: runs, debateRunDiscussion: notes, debateMessages: messages } = schema;
    return getDb().transaction(async tx => {
      const [run] = await tx.select({ archivedAt: debates.archivedAt, snapshot: runs.evidenceSnapshotJson })
        .from(runs).innerJoin(debates, eq(runs.debateId, debates.id))
        .where(and(eq(runs.id, runId), eq(debates.ownerEmail, owner))).for("share", { of: debates });
      if (!run) fail("Debate run not found.", { statusCode: 404 });
      if (run.archivedAt) fail("This debate is archived.", { statusCode: 409 });
      if (role) {
        const [message] = await tx.select({ id: messages.id }).from(messages).where(and(eq(messages.runId, runId), eq(messages.role, role)));
        if (!message) fail("This role has no saved message in this run.", { statusCode: 400 });
      }
      if (kind === "citation_explanation" && !citedExternalId) fail("Choose a paper from the run.", { statusCode: 400 });
      if (citedExternalId && !parseEvidenceSnapshot(run.snapshot).papers.some(paper => paper.externalId === citedExternalId)) {
        fail("Citation is outside this run's evidence snapshot.", { statusCode: 400 });
      }
      const id = crypto.randomUUID();
      await tx.insert(notes).values({ id, runId, authorEmail: owner, kind, role, citedExternalId, body, createdAt: new Date().toISOString() });
      return { id, runId };
    });
  },
});

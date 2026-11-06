import { defineAction, fail } from "@agent-native/core/action";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";

export default defineAction({
  description: "Read human contributions to an owned debate run, oldest first.",
  schema: z.object({ runId: z.string().trim().min(1) }),
  http: { method: "GET" }, readOnly: true,
  run: async ({runId}, ctx) => {
    const owner = ctx?.userEmail ?? fail("Sign in to view discussion.", {statusCode:401});
    const { debates, debateRuns:runs, debateRunDiscussion:notes } = schema;
    const rows = await getDb().select({ archivedAt:debates.archivedAt, note:{
      id:notes.id, kind:notes.kind, role:notes.role, citedExternalId:notes.citedExternalId, body:notes.body, createdAt:notes.createdAt,
    }}).from(runs).innerJoin(debates, eq(debates.id,runs.debateId))
      .leftJoin(notes,and(eq(notes.runId,runs.id),eq(notes.authorEmail,owner)))
      .where(and(eq(runs.id,runId),eq(debates.ownerEmail,owner))).orderBy(asc(notes.createdAt),asc(notes.id));
    if (!rows.length) fail("Debate run not found.", {statusCode:404});
    return { runId, archived: Boolean(rows[0]!.archivedAt), notes: rows.flatMap(row => row.note ? [row.note] : []) };
  },
});

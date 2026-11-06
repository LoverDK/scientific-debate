import { defineAction, fail } from "@agent-native/core/action";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { toSafeRunErrorSummary } from "../server/lib/safe-run-error.js";

const PAGE_SIZE = 20;
const cursorField = z.string().min(1).regex(/^[^\u0000]+$/);
const cursorSchema = z.tuple([cursorField, cursorField, cursorField]);

function decodeCursor(cursor: string, debateId: string) {
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) throw new Error();
    const [scope, createdAt, id] = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (scope !== debateId) throw new Error();
    return { createdAt, id };
  } catch {
    fail("Invalid debate run cursor.", { statusCode: 400 });
  }
}

export default defineAction({
  description:
    "List runs for a debate owned by the signed-in user, newest first. Includes status, modelId, timestamps, and a safe errorSummary for failed runs (never raw internals).",
  schema: z.object({ debateId: z.string().trim().min(1), cursor: z.string().max(4096).optional() }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ debateId, cursor }, ctx) => {
    const owner = ctx?.userEmail ?? fail("Sign in to view debate runs.", { statusCode: 401 });
    const { debates, debateRuns: runs } = schema;
    const after = cursor === undefined ? undefined : decodeCursor(cursor, debateId);
    const older = after && or(
      lt(runs.createdAt, after.createdAt),
      and(eq(runs.createdAt, after.createdAt), lt(runs.id, after.id)),
    );
    const rows = await getDb().select({
      debateId: debates.id,
      run: {
        id: runs.id,
        status: runs.status,
        modelId: runs.modelId,
        createdAt: runs.createdAt,
        startedAt: runs.startedAt,
        finishedAt: runs.finishedAt,
        errorMessage: runs.errorMessage,
      },
      currentRunId: debates.currentRunId,
    }).from(debates)
      .leftJoin(runs, and(eq(runs.debateId, debates.id), older))
      .where(and(eq(debates.id, debateId), eq(debates.ownerEmail, owner)))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(PAGE_SIZE + 1);

    if (!rows.length) fail("Debate not found.", { statusCode: 404 });
    const activeRunId = rows[0]?.currentRunId ?? null;
    const page = rows.slice(0, PAGE_SIZE).flatMap(({ run }) => {
      if (!run) return [];
      const { errorMessage, ...rest } = run;
      return [
        {
          ...rest,
          errorSummary: toSafeRunErrorSummary(errorMessage),
          isActive:
            (rest.status === "queued" || rest.status === "running") &&
            rest.id === activeRunId,
        },
      ];
    });
    const last = page[page.length - 1];
    const nextCursor = rows.length > PAGE_SIZE && last
      ? Buffer.from(JSON.stringify([debateId, last.createdAt, last.id])).toString("base64url")
      : null;
    return { runs: page, nextCursor, activeRunId };
  },
});

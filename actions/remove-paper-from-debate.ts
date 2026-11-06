import { defineAction, fail } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";

const OPENALEX_WORK_ID_RE = /^W\d+$/;

/**
 * Detach one paper from an owned debate. Does not delete the global papers cache.
 * Blocked while an active run is fenced on the debate.
 */
export default defineAction({
  description:
    "Remove an attached OpenAlex paper from a debate the signed-in user owns. Does not delete the global paper cache. Blocked while a queued/running debate run is active.",
  schema: z.object({
    debateId: z.string().trim().min(1),
    externalId: z
      .string()
      .trim()
      .regex(OPENALEX_WORK_ID_RE, "externalId must be an OpenAlex work id like W123"),
  }),
  run: async ({ debateId, externalId }, ctx) => {
    const owner =
      ctx?.userEmail ??
      fail("Sign in to remove a paper from a debate.", { statusCode: 401 });

    const { debates, papers, debatePapers, debateRuns } = schema;
    const db = getDb();

    const [owned] = await db
      .select({ id: debates.id, currentRunId: debates.currentRunId })
      .from(debates)
      .where(and(eq(debates.id, debateId), eq(debates.ownerEmail, owner)))
      .limit(1);
    if (!owned) fail("Debate not found.", { statusCode: 404 });

    if (owned.currentRunId) {
      const [active] = await db
        .select({ status: debateRuns.status })
        .from(debateRuns)
        .where(eq(debateRuns.id, owned.currentRunId))
        .limit(1);
      if (active && (active.status === "queued" || active.status === "running")) {
        fail(
          "Cannot remove papers while a debate run is in progress. Cancel the run first.",
          { statusCode: 409 },
        );
      }
    }

    const [paper] = await db
      .select({ id: papers.id, externalId: papers.externalId })
      .from(papers)
      .where(
        and(eq(papers.source, "openalex"), eq(papers.externalId, externalId)),
      )
      .limit(1);
    if (!paper) fail("Paper is not attached to this debate.", { statusCode: 404 });

    const removed = await db
      .delete(debatePapers)
      .where(
        and(
          eq(debatePapers.debateId, debateId),
          eq(debatePapers.paperId, paper.id),
        ),
      )
      .returning({ id: debatePapers.id });

    if (!removed[0]) {
      fail("Paper is not attached to this debate.", { statusCode: 404 });
    }

    return {
      success: true as const,
      debateId,
      externalId: paper.externalId,
      removed: true as const,
    };
  },
});

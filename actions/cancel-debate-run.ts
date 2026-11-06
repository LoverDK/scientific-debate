import { defineAction, fail } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  failRun,
  isDebateRunError,
} from "../server/lib/debate-run.js";

/**
 * Owner-initiated cancel of an active (queued|running) run.
 * Creates a failed terminal state so a new start-debate-run can proceed.
 * Does not delete role messages already saved.
 */
export default defineAction({
  description:
    "Cancel the active debate run owned by the signed-in user (queued or running → failed). Use on an explicit owner cancellation. An in-flight provider request can finish. Never retries the cancelled run id.",
  schema: z.object({
    runId: z.string().trim().min(1).describe("Active run id to cancel"),
  }),
  run: async ({ runId }, ctx) => {
    const owner =
      ctx?.userEmail ??
      fail("Sign in to cancel a debate run.", { statusCode: 401 });

    const { debates, debateRuns } = schema;
    const db = getDb();
    const [owned] = await db
      .select({
        id: debateRuns.id,
        status: debateRuns.status,
        debateId: debateRuns.debateId,
      })
      .from(debateRuns)
      .innerJoin(debates, eq(debates.id, debateRuns.debateId))
      .where(and(eq(debateRuns.id, runId), eq(debates.ownerEmail, owner)))
      .limit(1);

    if (!owned) fail("Debate run not found.", { statusCode: 404 });
    if (owned.status !== "queued" && owned.status !== "running") {
      fail("Only queued or running debate runs can be cancelled.", {
        statusCode: 409,
      });
    }

    try {
      const record = await failRun({
        db,
        runId: owned.id,
        errorMessage: "Cancelled by the owner.",
      });
      return {
        success: true as const,
        runId: record.id,
        debateId: record.debateId,
        status: record.status,
        errorSummary: "Cancelled by the owner.",
        note: "Cancelled runs and saved messages stay in history. An in-flight model request may still finish.",
      };
    } catch (error) {
      if (isDebateRunError(error)) {
        fail(error.message, { statusCode: error.statusCode });
      }
      fail("Could not cancel debate run.", { statusCode: 500 });
    }
  },
});

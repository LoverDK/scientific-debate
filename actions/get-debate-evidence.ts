import { defineAction, fail } from "@agent-native/core/action";
import { z } from "zod";

import { getDb } from "../server/db/index.js";
import {
  buildDebateEvidencePack,
  isDebateEvidenceError,
} from "../server/lib/debate-evidence.js";

/** Agent-friendly EvidencePack reader (same snapshot builder as start-debate-run). */
export default defineAction({
  description:
    "Get the current EvidencePack for an owned debate (claim + attached papers). Prefer this when the Agent needs evidence before start-debate-run. Requires at least one attached paper.",
  schema: z.object({
    debateId: z.string().trim().min(1),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ debateId }, ctx) => {
    const owner =
      ctx?.userEmail ??
      fail("Sign in to view debate evidence.", { statusCode: 401 });
    try {
      const evidencePack = await buildDebateEvidencePack(
        getDb(),
        debateId,
        owner,
      );
      return {
        debateId,
        paperCount: evidencePack.papers.length,
        evidencePack,
      };
    } catch (error) {
      if (isDebateEvidenceError(error)) {
        fail(error.message, { statusCode: error.statusCode });
      }
      fail("Could not build debate evidence.", { statusCode: 500 });
    }
  },
});

import { defineAction, fail } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";

export default defineAction({
  description:
    "Get one scientific debate by id. Returns the debate only if the signed-in user owns it.",
  schema: z.object({
    debateId: z
      .string()
      .trim()
      .min(1)
      .describe("The debate id returned by create-debate"),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args, ctx) => {
    const userEmail =
      ctx?.userEmail ?? fail("Sign in to view a debate.", { statusCode: 401 });

    const { debates } = schema;
    const [row] = await getDb()
      .select({
        id: debates.id,
        claim: debates.claim,
        inputType: debates.inputType,
        status: debates.status,
        createdAt: debates.createdAt,
        updatedAt: debates.updatedAt,
      })
      .from(debates)
      .where(
        and(eq(debates.id, args.debateId), eq(debates.ownerEmail, userEmail)),
      )
      .limit(1);

    if (!row) {
      fail("Debate not found.", { statusCode: 404 });
    }

    return row;
  },
});

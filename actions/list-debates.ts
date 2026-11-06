import { defineAction, fail } from "@agent-native/core/action";
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";

export default defineAction({
  description:
    "List scientific debates owned by the signed-in user, newest first. Returns at most 20 debates.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async (_args, ctx) => {
    const userEmail =
      ctx?.userEmail ?? fail("Sign in to list debates.", { statusCode: 401 });

    const { debates } = schema;
    const rows = await getDb()
      .select({
        id: debates.id,
        claim: debates.claim,
        inputType: debates.inputType,
        status: debates.status,
        createdAt: debates.createdAt,
        updatedAt: debates.updatedAt,
      })
      .from(debates)
      .where(eq(debates.ownerEmail, userEmail))
      .orderBy(desc(debates.createdAt), asc(debates.id))
      .limit(20);

    return { debates: rows };
  },
});

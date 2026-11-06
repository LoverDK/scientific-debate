import { defineAction, fail } from "@agent-native/core/action";
import { z } from "zod";
import { changeDebate } from "../server/lib/debate-management.js";

export default defineAction({
  description: "Archive an owned debate while retaining its evidence and history.",
  schema: z.object({ debateId: z.string().trim().min(1) }),
  run: ({ debateId }, ctx) => changeDebate(debateId, ctx?.userEmail ?? fail("Sign in to archive a debate.", { statusCode: 401 }), { archive: true }),
});

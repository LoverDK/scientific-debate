import { defineAction, fail } from "@agent-native/core/action";
import { z } from "zod";
import { changeDebate } from "../server/lib/debate-management.js";

export default defineAction({
  description: "Update an owned debate claim when it has no active run.",
  schema: z.object({ debateId: z.string().trim().min(1), claim: z.string().trim().min(1) }),
  run: ({ debateId, claim }, ctx) => changeDebate(debateId, ctx?.userEmail ?? fail("Sign in to edit a debate.", { statusCode: 401 }), { claim }),
});

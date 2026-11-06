import { defineAction, fail } from "@agent-native/core/action";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";

export default defineAction({
  description:
    "Create a scientific debate for a claim. Saves the claim with status pending. After creating, call gather-debate-evidence next so the Agent searches OpenAlex for both supporting and opposing papers, classifies stance, and attaches them automatically. Do not ask the user to manually search or pick papers unless gather-debate-evidence fails or the user explicitly wants to override. Then confirm list-debate-papers and offer start-debate-run.",
  schema: z.object({
    claim: z
      .string()
      .trim()
      .min(1)
      .describe("The scientific claim to evaluate (required, non-empty after trim)"),
    inputType: z
      .enum(["text", "paper"])
      .default("text")
      .describe('How the claim was provided: "text" or "paper"; defaults to "text"'),
  }),
  run: async (args, ctx) => {
    const ownerEmail =
      ctx?.userEmail ??
      fail("Sign in to create a debate.", { statusCode: 401 });
    const orgId = ctx?.orgId ?? null;
    const visibility = orgId ? ("org" as const) : ("private" as const);

    const now = new Date().toISOString();
    const debate = {
      id: crypto.randomUUID(),
      claim: args.claim,
      inputType: args.inputType,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      ownerEmail,
      orgId,
      visibility,
    };

    await getDb().insert(schema.debates).values(debate);

    return {
      success: true as const,
      debateId: debate.id,
      claim: debate.claim,
      status: debate.status,
      createdAt: debate.createdAt,
    };
  },
});

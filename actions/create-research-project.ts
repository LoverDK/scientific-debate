import { defineAction, fail } from "@agent-native/core/action";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";

export default defineAction({
  description:
    "Create a research workspace project that can group multiple debates. Does not start a debate run.",
  schema: z.object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).default(""),
  }),
  run: async (args, ctx) => {
    const ownerEmail =
      ctx?.userEmail ??
      fail("Sign in to create a research project.", { statusCode: 401 });
    const now = new Date().toISOString();
    const project = {
      id: crypto.randomUUID(),
      title: args.title,
      description: args.description,
      createdAt: now,
      updatedAt: now,
      archivedAt: null as string | null,
      ownerEmail,
      orgId: ctx?.orgId ?? null,
      visibility: ctx?.orgId ? ("org" as const) : ("private" as const),
    };
    await getDb().insert(schema.researchProjects).values(project);
    return {
      success: true as const,
      projectId: project.id,
      title: project.title,
      description: project.description,
    };
  },
});

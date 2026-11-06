import { defineAction, fail } from "@agent-native/core/action";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";

export default defineAction({
  description: "Add an owned claim to an active research project.",
  schema: z.object({
    projectId: z.string().trim().min(1),
    debateId: z.string().trim().min(1),
  }),
  run: async ({ projectId, debateId }, ctx) => {
    const owner =
      ctx?.userEmail ??
      fail("Sign in to manage projects.", { statusCode: 401 });
    const { researchProjects, researchProjectDebates, debates } = schema;
    return getDb().transaction(async (tx) => {
      const [project] = await tx
        .select({ archivedAt: researchProjects.archivedAt })
        .from(researchProjects)
        .where(
          and(
            eq(researchProjects.id, projectId),
            eq(researchProjects.ownerEmail, owner),
          ),
        )
        .for("update");
      if (!project) fail("Research project not found.", { statusCode: 404 });
      if (project.archivedAt) fail("Project is archived.", { statusCode: 409 });
      const [debate] = await tx
        .select({ id: debates.id })
        .from(debates)
        .where(
          and(
            eq(debates.id, debateId),
            eq(debates.ownerEmail, owner),
            isNull(debates.archivedAt),
          ),
        )
        .for("share");
      if (!debate) fail("Debate not found.", { statusCode: 404 });
      const now = new Date().toISOString();
      const rows = await tx
        .insert(researchProjectDebates)
        .values({
          id: crypto.randomUUID(),
          projectId,
          debateId,
          addedAt: now,
          addedByEmail: owner,
        })
        .onConflictDoNothing({
          target: [
            researchProjectDebates.projectId,
            researchProjectDebates.debateId,
          ],
        })
        .returning({ id: researchProjectDebates.id });
      if (rows.length)
        await tx
          .update(researchProjects)
          .set({ updatedAt: now })
          .where(eq(researchProjects.id, projectId));
      return { success: true as const, alreadyLinked: !rows.length };
    });
  },
});

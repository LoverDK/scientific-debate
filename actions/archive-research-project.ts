import { defineAction, fail } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";

export default defineAction({
  description: "Archive a project while retaining its debates and papers.",
  schema: z.object({ projectId: z.string().trim().min(1) }),
  run: async ({ projectId }, ctx) => {
    const owner =
      ctx?.userEmail ??
      fail("Sign in to manage projects.", { statusCode: 401 });
    const { researchProjects } = schema;
    return getDb().transaction(async (tx) => {
      const owned = and(
        eq(researchProjects.id, projectId),
        eq(researchProjects.ownerEmail, owner),
      );
      const [row] = await tx
        .select({ archivedAt: researchProjects.archivedAt })
        .from(researchProjects)
        .where(owned)
        .for("update");
      if (!row) fail("Research project not found.", { statusCode: 404 });
      const archivedAt = row.archivedAt ?? new Date().toISOString();
      if (!row.archivedAt)
        await tx
          .update(researchProjects)
          .set({ archivedAt, updatedAt: archivedAt })
          .where(owned);
      return { projectId, archivedAt };
    });
  },
});

import { defineAction, fail } from "@agent-native/core/action";
import { and, asc, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";

export default defineAction({
  description:
    "Search owned projects by title or description, optionally viewing the archive.",
  schema: z.object({
    query: z.string().trim().max(200).optional(),
    scope: z.enum(["active", "archived"]).optional(),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ query, scope }, ctx) => {
    const owner =
      ctx?.userEmail ??
      fail("Sign in to list research projects.", { statusCode: 401 });
    const { researchProjects: projects } = schema;
    const rows = await getDb()
      .select({
        id: projects.id,
        title: projects.title,
        description: projects.description,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
        archivedAt: projects.archivedAt,
      })
      .from(projects)
      .where(
        and(
          eq(projects.ownerEmail, owner),
          scope === "archived"
            ? isNotNull(projects.archivedAt)
            : isNull(projects.archivedAt),
          query
            ? or(
                sql`strpos(lower(${projects.title}), lower(${query})) > 0`,
                sql`strpos(lower(${projects.description}), lower(${query})) > 0`,
              )
            : undefined,
        ),
      )
      .orderBy(desc(projects.updatedAt), asc(projects.id))
      .limit(51);
    return { projects: rows.slice(0, 50), truncated: rows.length > 50 };
  },
});

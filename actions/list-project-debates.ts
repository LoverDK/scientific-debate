import { defineAction, fail } from "@agent-native/core/action";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";

export default defineAction({
  description:
    "Read an owned project's claims, latest runs, and papers with their associated claims.",
  schema: z.object({ projectId: z.string().trim().min(1) }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ projectId }, ctx) => {
    const owner =
      ctx?.userEmail ??
      fail("Sign in to list project debates.", { statusCode: 401 });
    const db = getDb();
    const {
      researchProjects: projects,
      researchProjectDebates: links,
      debates,
      debateRuns,
      papers,
      debatePapers,
    } = schema;
    const [project] = await db
      .select({
        id: projects.id,
        title: projects.title,
        description: projects.description,
        archivedAt: projects.archivedAt,
      })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.ownerEmail, owner)));
    if (!project) fail("Research project not found.", { statusCode: 404 });
    const ownedDebate = and(
      eq(debates.id, links.debateId),
      eq(debates.ownerEmail, owner),
    );
    const rows = await db
      .select({
        debateId: debates.id,
        claim: debates.claim,
        status: debates.status,
        currentRunId: debateRuns.id,
        runStatus: debateRuns.status,
        createdAt: debates.createdAt,
        updatedAt: debates.updatedAt,
        addedAt: links.addedAt,
      })
      .from(links)
      .innerJoin(debates, ownedDebate)
      .leftJoin(
        debateRuns,
        and(
          eq(debateRuns.id, debates.currentRunId),
          eq(debateRuns.debateId, debates.id),
        ),
      )
      .where(eq(links.projectId, projectId))
      .orderBy(desc(links.addedAt), asc(debates.id));
    const attachments = await db
      .select({
        id: papers.id,
        title: papers.title,
        externalId: papers.externalId,
        year: papers.year,
        debateId: debates.id,
      })
      .from(links)
      .innerJoin(debates, ownedDebate)
      .innerJoin(debatePapers, eq(debatePapers.debateId, debates.id))
      .innerJoin(papers, eq(papers.id, debatePapers.paperId))
      .where(eq(links.projectId, projectId))
      .orderBy(asc(papers.title), asc(papers.id), asc(debates.id));
    const grouped = new Map<
      string,
      {
        id: string;
        title: string | null;
        externalId: string;
        year: number | null;
        debateIds: string[];
      }
    >();
    for (const { debateId, ...paper } of attachments) {
      const existing = grouped.get(paper.id);
      if (existing) existing.debateIds.push(debateId);
      else grouped.set(paper.id, { ...paper, debateIds: [debateId] });
    }
    return { project, debates: rows, papers: [...grouped.values()] };
  },
});

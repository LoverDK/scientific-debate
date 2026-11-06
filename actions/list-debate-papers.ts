import { defineAction, fail } from "@agent-native/core/action";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";

const LIST_LIMIT = 50;
const LIST_FETCH_LIMIT = LIST_LIMIT + 1;

/** Same contract as attach-paper-to-debate: invalid JSON → []. */
function parseAuthorsJson(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

export default defineAction({
  description:
    "List papers attached to a scientific debate owned by the signed-in user. Returns at most 50 papers, newest attachment first. Does not call OpenAlex.",
  schema: z.object({
    debateId: z
      .string()
      .trim()
      .min(1)
      .describe("The debate id returned by create-debate"),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ debateId }, ctx) => {
    const userEmail =
      ctx?.userEmail ??
      fail("Sign in to list debate papers.", { statusCode: 401 });

    const { debates, papers, debatePapers } = schema;
    const db = getDb();

    const [ownedDebate] = await db
      .select({ id: debates.id })
      .from(debates)
      .where(and(eq(debates.id, debateId), eq(debates.ownerEmail, userEmail)))
      .limit(1);

    if (!ownedDebate) {
      fail("Debate not found.", { statusCode: 404 });
    }

    const rows = await db
      .select({
        id: papers.id,
        source: papers.source,
        externalId: papers.externalId,
        providerUrl: papers.providerUrl,
        title: papers.title,
        authorsJson: papers.authorsJson,
        year: papers.year,
        doi: papers.doi,
        citationCount: papers.citationCount,
        url: papers.url,
        linkId: debatePapers.id,
        linkAddedAt: debatePapers.addedAt,
        stance: debatePapers.stance,
        stanceRationale: debatePapers.stanceRationale,
      })
      .from(debatePapers)
      .innerJoin(papers, eq(papers.id, debatePapers.paperId))
      .where(eq(debatePapers.debateId, debateId))
      .orderBy(desc(debatePapers.addedAt), asc(debatePapers.id))
      .limit(LIST_FETCH_LIMIT);

    const truncated = rows.length > LIST_LIMIT;
    const page = truncated ? rows.slice(0, LIST_LIMIT) : rows;

    const mapped = page.map((row) => ({
      id: row.id,
      source: row.source,
      externalId: row.externalId,
      providerUrl: row.providerUrl,
      title: row.title,
      authors: parseAuthorsJson(row.authorsJson),
      year: row.year,
      doi: row.doi,
      citationCount: row.citationCount,
      url: row.url,
      stance: row.stance,
      stanceRationale: row.stanceRationale,
      link: {
        id: row.linkId,
        addedAt: row.linkAddedAt,
      },
    }));

    const byStance = {
      supports: mapped.filter((item) => item.stance === "supports"),
      opposes: mapped.filter((item) => item.stance === "opposes"),
      uncertain: mapped.filter(
        (item) => item.stance === "uncertain" || !item.stance,
      ),
    };

    return {
      debateId,
      papers: mapped,
      byStance,
      meta: {
        resultCount: mapped.length,
        truncated,
      },
    };
  },
});

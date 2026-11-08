import { defineAction, fail } from "@agent-native/core/action";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { APICallError } from "ai";
import { FREE_MODEL_RATE_LIMIT } from "../shared/debate-model.js";

import { getDb, schema } from "../server/db/index.js";
import {
  buildEvidenceSearchQueries,
  type EvidenceStance,
} from "../server/lib/evidence-stance.js";
import {
  classifyPapersWithFreeOpenRouter,
  FREE_EVIDENCE_CLASSIFIER_MODEL_ID,
} from "../server/lib/evidence-stance-llm.js";
import {
  OpenAlexSearchError,
  pauseBetweenOpenAlexCalls,
  searchOpenAlexWorks,
} from "../server/lib/openalex-search.js";
import type { OpenAlexMappedWork } from "../server/lib/openalex-works.js";
import { rankPapersByKeywordCoverage } from "../server/lib/paper-keyword-rank.js";
import { selectEvidenceCandidates } from "../server/lib/evidence-candidates.js";
import { canAttachAssessedEvidence } from "../server/lib/evidence-assessment.js";

const OPENALEX_SOURCE = "openalex" as const;
const CANDIDATE_LIMIT = 15;

async function upsertPaperAndLink(options: {
  debateId: string;
  ownerEmail: string;
  paper: OpenAlexMappedWork;
  stance: EvidenceStance;
  rationale: string;
}): Promise<"created" | "updated"> {
  const { debates, papers, debatePapers } = schema;
  const db = getDb();
  const now = new Date().toISOString();

  return db.transaction(async (tx) => {
    const [owned] = await tx
      .select({ id: debates.id })
      .from(debates)
      .where(
        and(
          eq(debates.id, options.debateId),
          eq(debates.ownerEmail, options.ownerEmail),
        ),
      )
      .limit(1);
    if (!owned) fail("Debate not found.", { statusCode: 404 });

    await tx
      .insert(papers)
      .values({
        id: crypto.randomUUID(),
        source: OPENALEX_SOURCE,
        externalId: options.paper.externalId,
        providerUrl: options.paper.providerUrl,
        title: options.paper.title,
        authorsJson: JSON.stringify(options.paper.authors),
        year: options.paper.year,
        doi: options.paper.doi,
        abstract: options.paper.abstract,
        citationCount: options.paper.citationCount,
        url: options.paper.url,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [papers.source, papers.externalId],
      });

    const [paperRow] = await tx
      .select({ id: papers.id, title: papers.title, abstract: papers.abstract })
      .from(papers)
      .where(
        and(
          eq(papers.source, OPENALEX_SOURCE),
          eq(papers.externalId, options.paper.externalId),
        ),
      )
      .limit(1);
    if (!paperRow) fail("Failed to load paper after gather.", { statusCode: 500 });
    if (paperRow.title !== options.paper.title || paperRow.abstract !== options.paper.abstract) {
      fail("Paper metadata changed during assessment. Refresh evidence before gathering again.", { statusCode: 409 });
    }

    const inserted = await tx
      .insert(debatePapers)
      .values({
        id: crypto.randomUUID(),
        debateId: options.debateId,
        paperId: paperRow.id,
        addedAt: now,
        addedByEmail: options.ownerEmail,
        stance: options.stance,
        stanceRationale: options.rationale,
      })
      .onConflictDoNothing({
        target: [debatePapers.debateId, debatePapers.paperId],
      })
      .returning({ id: debatePapers.id });

    if (inserted[0]) return "created" as const;

    await tx
      .update(debatePapers)
      .set({
        stance: options.stance,
        stanceRationale: options.rationale,
      })
      .where(
        and(
          eq(debatePapers.debateId, options.debateId),
          eq(debatePapers.paperId, paperRow.id),
        ),
      );
    return "updated" as const;
  });
}

export default defineAction({
  description:
    "Search OpenAlex with focused, synonym-expanded and challenging queries; assess relevance before stance using the free model. Automatically attach only relevant papers with a verified abstract excerpt. Unrelated or unverified candidates are excluded, never forced into opposing sides. Prefer after create-debate; no automatic model retries.",
  schema: z.object({
    debateId: z.string().trim().min(1),
    searchTerms: z.string().trim().min(1).max(180).optional(),
    maxPerStance: z.coerce.number().int().min(1).max(10).default(5),
  }),
  timeoutMs: 300_000,
  run: async ({ debateId, maxPerStance, searchTerms }, ctx) => {
    const ownerEmail =
      ctx?.userEmail ??
      fail("Sign in to gather debate evidence.", { statusCode: 401 });

    const { debates } = schema;
    const [debate] = await getDb()
      .select({ id: debates.id, claim: debates.claim })
      .from(debates)
      .where(and(eq(debates.id, debateId), eq(debates.ownerEmail, ownerEmail)))
      .limit(1);
    if (!debate) fail("Debate not found.", { statusCode: 404 });

    const queries = buildEvidenceSearchQueries(searchTerms ?? debate.claim);

    let supportHits: OpenAlexMappedWork[] = [];
    let opposeHits: OpenAlexMappedWork[] = [];
    const searchesExecuted: { kind: string; query: string; resultCount: number }[] = [];
    const searchWarnings: string[] = [];
    try {
      // At most three distinct search queries, sequentially. A query's purpose
      // never determines a paper's stance. No extra classifier calls for planning.
      for (const search of queries.searches) {
        if (searchesExecuted.length) await pauseBetweenOpenAlexCalls();
        try {
          const hits = await searchOpenAlexWorks({ query: search.query, bridgeQuery: queries.keywords.join(" "), page: 1, perPage: 10 });
          searchesExecuted.push({ ...search, resultCount: hits.length });
          if (search.kind === "challenging") opposeHits.push(...hits);
          else supportHits.push(...hits);
        } catch (error) {
          if (search.kind === "expanded" && error instanceof OpenAlexSearchError && error.statusCode === 429 && (supportHits.length || opposeHits.length)) {
            searchWarnings.push("The optional synonym search was rate limited; results cover the completed queries only.");
            break;
          }
          throw error;
        }
      }
      // Rank against the claim concepts, not boilerplate like limitation/failure.
      supportHits = rankPapersByKeywordCoverage(supportHits, queries.keywords);
      opposeHits = rankPapersByKeywordCoverage(opposeHits, queries.keywords);
    } catch (error) {
      if (error instanceof OpenAlexSearchError) {
        if (error.statusCode === 429) {
          fail(
            "OpenAlex rate limit hit. Wait ~20 seconds and click Gather evidence again.",
            { statusCode: 429 },
          );
        }
        fail(error.message, {
          statusCode: error.statusCode === 503 ? 503 : error.statusCode,
        });
      }
      fail("OpenAlex network request failed.", { statusCode: 502 });
    }

    let candidates = selectEvidenceCandidates(supportHits, opposeHits, CANDIDATE_LIMIT);
    if (candidates.length === 0) {
      fail(
        "Literature search returned no usable papers. Try a paper title or shorter search terms below.",
        { statusCode: 404 },
      );
    }

    // A cached paper is the record that will be attached and snapshotted. Assess
    // that same title/abstract, rather than promising findings from newer text
    // which ON CONFLICT DO NOTHING would not save.
    const cached = await getDb().select({ externalId: schema.papers.externalId, title: schema.papers.title, abstract: schema.papers.abstract })
      .from(schema.papers).where(and(eq(schema.papers.source, OPENALEX_SOURCE), inArray(schema.papers.externalId, candidates.map(p => p.externalId))));
    const cacheById = new Map(cached.map(p => [p.externalId, p]));
    candidates = candidates.map(p => {
      const saved = cacheById.get(p.externalId);
      return saved ? { ...p, title: saved.title, abstract: saved.abstract } : p;
    });

    let classified;
    try {
      classified = await classifyPapersWithFreeOpenRouter({
        claim: debate.claim,
        papers: candidates,
        keywords: queries.keywords,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (APICallError.isInstance(error) && error.statusCode === 429) {
        fail(FREE_MODEL_RATE_LIMIT, { statusCode: 429 });
      }
      if (message === "OPENROUTER_KEY_MISSING") {
        fail(
          "OpenRouter is not connected. Connect OpenRouter in Settings (free model path) before gathering evidence.",
          { statusCode: 400 },
        );
      }
      if (message === "OPENROUTER_SECRET_LOOKUP_FAILED") {
        fail("Credential store lookup failed. Retry shortly.", {
          statusCode: 503,
        });
      }
      fail(
        "Free OpenRouter stance classification failed.",
        { statusCode: 502 },
      );
    }

    const eligible = classified.classified.filter(p => canAttachAssessedEvidence(p) && p.title?.trim())
      .sort((a, b) => Number(b.relevance === "direct") - Number(a.relevance === "direct"));
    const rejected = classified.classified.filter(p => !eligible.includes(p));
    if (eligible.length === 0) {
      fail(classified.usedFallback
        ? "No papers passed relevance and abstract-evidence checks because model assessment was incomplete. No new papers were attached."
        : "No retrieved papers directly address the claim or provide usable background with abstract evidence. No new papers were attached.",
      { statusCode: classified.usedFallback ? 502 : 422 });
    }
    const pick = (stance: EvidenceStance) =>
      eligible
        .filter((item) => item.stance === stance)
        .slice(0, maxPerStance);

    const selected = [
      ...pick("supports"),
      ...pick("opposes"),
      ...pick("uncertain").slice(0, Math.max(1, Math.floor(maxPerStance / 2))),
    ];

    const attached = {
      supports: [] as Array<{ externalId: string; title: string | null }>,
      opposes: [] as Array<{ externalId: string; title: string | null }>,
      uncertain: [] as Array<{ externalId: string; title: string | null }>,
      created: 0,
      updated: 0,
    };

    for (const paper of selected) {
      const result = await upsertPaperAndLink({
        debateId,
        ownerEmail,
        paper,
        stance: paper.stance,
        rationale: `${paper.relevance === "direct" ? "Directly relevant" : "Background only"}. ${paper.rationale}\nAbstract excerpt: "${paper.evidenceExcerpt}"\nAssessment uses metadata and the supplied abstract excerpt, not full text.`,
      });
      if (result === "created") attached.created += 1;
      else attached.updated += 1;
      const entry = { externalId: paper.externalId, title: paper.title };
      if (paper.stance === "supports") attached.supports.push(entry);
      else if (paper.stance === "opposes") attached.opposes.push(entry);
      else attached.uncertain.push(entry);
    }

    if (
      attached.supports.length === 0 &&
      attached.opposes.length === 0 &&
      attached.uncertain.length === 0
    ) {
      fail(
        "No usable papers found for this claim. Refine the claim or try again later.",
        { statusCode: 404 },
      );
    }

    return {
      success: true as const,
      debateId,
      claim: debate.claim,
      classifierModelId: FREE_EVIDENCE_CLASSIFIER_MODEL_ID,
      // Retain the legacy response field without claiming heuristics ran.
      usedHeuristicFallback: false,
      hasUnclassifiedPapers: classified.usedFallback,
      queries: {
        supportQuery: queries.supportQuery,
        opposeQuery: queries.opposeQuery,
        keywords: queries.keywords,
        executed: searchesExecuted,
      },
      review: {
        candidateCount: candidates.length,
        eligibleCount: eligible.length,
        excludedCount: rejected.length,
        excluded: rejected.map(p => ({ externalId: p.externalId, title: p.title, reason: p.rationale })),
        warnings: searchWarnings,
      },
      attached,
      note: classified.usedFallback
        ? "Some candidates were excluded because assessment could not be verified. Attached papers passed relevance and abstract-excerpt checks. Search direction is not stance; no full-text review was performed."
        : "Attached papers passed relevance and abstract-excerpt checks. Background papers stay uncertain; supporting/opposing labels require direct relevance. These model judgments are not full-text peer review.",
    };
  },
});

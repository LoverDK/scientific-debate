import { defineAction, fail } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
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
      .select({ id: papers.id })
      .from(papers)
      .where(
        and(
          eq(papers.source, OPENALEX_SOURCE),
          eq(papers.externalId, options.paper.externalId),
        ),
      )
      .limit(1);
    if (!paperRow) fail("Failed to load paper after gather.", { statusCode: 500 });

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
    "Agent-first evidence gathering: search OpenAlex for supportive and critical literature, then classify each paper's stance with the allowlisted free OpenRouter model (title/abstract only), and attach papers automatically. Prefer this over asking the user to search or pick papers. After create-debate, call gather-debate-evidence next. Requires OpenRouter to be connected; uses only the free allowlisted model.",
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
    try {
      // Sequential + polite-pool mailto: parallel bursts hit OpenAlex 429 easily.
      const page1 = await searchOpenAlexWorks({
        query: queries.supportQuery,
        page: 1,
        perPage: 10,
      });
      await pauseBetweenOpenAlexCalls();
      const opposePage = await searchOpenAlexWorks({
        query: queries.opposeQuery,
        page: 1,
        perPage: 10,
      });
      let page2: OpenAlexMappedWork[] = [];
      try {
        await pauseBetweenOpenAlexCalls();
        page2 = await searchOpenAlexWorks({
          query: queries.supportQuery,
          page: 2,
          perPage: 10,
        });
      } catch (error) {
        if (
          !(error instanceof OpenAlexSearchError && error.statusCode === 429)
        ) {
          throw error;
        }
        // Page 2 is optional enrichment; keep going with page 1 + oppose hits.
      }
      supportHits = rankPapersByKeywordCoverage(
        [...page1, ...page2],
        queries.supportQuery,
      );
      opposeHits = rankPapersByKeywordCoverage(
        opposePage,
        queries.opposeQuery,
      );
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

    const candidates = selectEvidenceCandidates(supportHits, opposeHits, CANDIDATE_LIMIT);
    if (candidates.length === 0) {
      fail(
        "Literature search returned no usable papers. Try a paper title or shorter search terms below.",
        { statusCode: 404 },
      );
    }

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

    const pick = (stance: EvidenceStance) =>
      classified.classified
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
        rationale: paper.rationale,
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
      usedHeuristicFallback: false,
      hasUnclassifiedPapers: classified.usedFallback,
      queries: {
        supportQuery: queries.supportQuery,
        opposeQuery: queries.opposeQuery,
        keywords: queries.keywords,
      },
      attached,
      note: classified.usedFallback
        ? "Some papers could not be classified and remain uncertain. Stance labels use the free OpenRouter model over title/abstract metadata only, not full text."
        : "Stance labels come from the allowlisted free OpenRouter model over OpenAlex title/abstract metadata only — not full-text peer review.",
    };
  },
});

import { describe, expect, it } from "vitest";

import type { OpenAlexMappedWork } from "./openalex-works.js";
import {
  keywordVariants,
  rankPapersByKeywordCoverage,
} from "./paper-keyword-rank.js";

function paper(
  overrides: Partial<OpenAlexMappedWork> & Pick<OpenAlexMappedWork, "externalId">,
): OpenAlexMappedWork {
  return {
    title: null,
    authors: [],
    year: null,
    doi: null,
    abstract: null,
    citationCount: null,
    relevanceScore: null,
    url: null,
    providerUrl: `https://openalex.org/${overrides.externalId}`,
    ...overrides,
  };
}

describe("rankPapersByKeywordCoverage", () => {
  it("prefers papers that cover more query phrases", () => {
    const query = `"llm reasoning" robustness`;
    const ranked = rankPapersByKeywordCoverage(
      [
        paper({
          externalId: "W1",
          title: "Only robustness matters",
          abstract: "robustness study",
          relevanceScore: 99,
        }),
        paper({
          externalId: "W2",
          title: "LLM reasoning and robustness",
          abstract: "We study llm reasoning under robustness pressures.",
          relevanceScore: 10,
        }),
      ],
      query,
    );
    expect(ranked.map((item) => item.externalId)).toEqual(["W2", "W1"]);
  });

  it("gives near-match credit for related word forms", () => {
    expect(keywordVariants("reasoning")).toContain("reason");
    const ranked = rankPapersByKeywordCoverage(
      [
        paper({
          externalId: "W1",
          title: "Unrelated astronomy",
          abstract: "stars and planets",
        }),
        paper({
          externalId: "W2",
          title: "Models reason better with robustness",
          abstract: "reason and robust systems",
        }),
      ],
      "reasoning robustness",
    );
    expect(ranked[0]?.externalId).toBe("W2");
  });
});

it("matches known concept aliases rather than requiring the acronym", () => {
  const ranked = rankPapersByKeywordCoverage([
    paper({ externalId: "W1", title: "Robustness in materials", relevanceScore: 999999 }),
    paper({ externalId: "W2", title: "Robust reasoning in large language models", relevanceScore: 1 }),
  ], ["llm", "robustness", "reasoning"]);
  expect(ranked[0]?.externalId).toBe("W2");
});

it("does not count substrings such as reason inside unreasonable", () => {
  const ranked = rankPapersByKeywordCoverage([
    paper({ externalId: "W1", title: "Unreasonable concerns about robustness", relevanceScore: 1000 }),
    paper({ externalId: "W2", title: "Models reason about robustness", relevanceScore: 1 }),
  ], "reasoning robustness");
  expect(ranked[0]?.externalId).toBe("W2");
});

it("deduplicates synonymous query concepts and ignores Boolean operators", () => {
  const input = [paper({ externalId: "W1", title: "LLM", relevanceScore: 1000 }), paper({ externalId: "W2", title: "Robustness reasoning" })];
  expect(rankPapersByKeywordCoverage(input, '(llm OR "large language model") AND robustness AND reasoning')[0]?.externalId).toBe("W2");
});

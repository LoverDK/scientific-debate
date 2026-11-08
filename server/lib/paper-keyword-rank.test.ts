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

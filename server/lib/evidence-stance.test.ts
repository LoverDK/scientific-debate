import { describe, expect, it } from "vitest";

import {
  buildEvidenceSearchQueries,
  classifyPaperStance,
} from "./evidence-stance.js";

describe("evidence-stance", () => {
  it("builds distinct support and oppose OpenAlex queries", () => {
    const built = buildEvidenceSearchQueries(
      "Robustness can enhance the LLM's reasoning ability",
    );
    expect(built.supportQuery.length).toBeGreaterThan(0);
    expect(built.opposeQuery).toContain("limitation");
  });

  it("classifies supportive abstracts as supports", () => {
    const result = classifyPaperStance(
      "Robustness improves LLM reasoning",
      {
        title: "Robustness enhances LLM reasoning ability",
        abstract:
          "We demonstrate that robustness training improves and enhances reasoning performance.",
      },
      ["robustness", "llm", "reasoning"],
    );
    expect(result.stance).toBe("supports");
  });

  it("classifies critical abstracts as opposes", () => {
    const result = classifyPaperStance(
      "Robustness improves LLM reasoning",
      {
        title: "Limitations of robustness for LLM reasoning",
        abstract:
          "Robustness fails to improve reasoning. We find no significant gains and challenge prior claims.",
      },
      ["robustness", "llm", "reasoning"],
    );
    expect(result.stance).toBe("opposes");
  });
});

it("builds distinct bounded plans using explicit synonyms without changing the claim", () => {
  const claim = "robustness can enhance the LLM's reasoning ability";
  const plan = buildEvidenceSearchQueries(claim);
  expect(plan.searches.map(q => q.kind)).toEqual(["focused", "challenging", "expanded"]);
  expect(plan.searches.find(q => q.kind === "expanded")?.query).toContain(" OR llm");
  expect(plan.supportQuery).not.toContain('"robustness llm"');
  expect(new Set(plan.searches.map(q => q.query)).size).toBe(plan.searches.length);
  expect(plan.searches.every(q => q.query.length <= 300)).toBe(true);
});

it("does not duplicate a query when no explicit synonym is known", () => {
  expect(buildEvidenceSearchQueries("galaxies rotate").searches.map(q => q.kind)).toEqual(["focused", "challenging"]);
});

it("bounds clauses without leaving unmatched quotes or parentheses", () => {
  const plan = buildEvidenceSearchQueries("intermittent fasting insulin sensitivity type 2 diabetes large language models adversarial training retrieval augmented generation robustness reasoning");
  for (const { query } of plan.searches) {
    expect(query.length).toBeLessThanOrEqual(300);
    expect((query.match(/"/g) ?? []).length % 2).toBe(0);
    expect((query.match(/\(/g) ?? []).length).toBe((query.match(/\)/g) ?? []).length);
  }
});

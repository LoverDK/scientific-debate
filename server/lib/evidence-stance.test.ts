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

import { describe, expect, it } from "vitest";

import { extractClaimKeywords } from "./claim-keywords.js";

describe("extractClaimKeywords", () => {
  it("preserves scientific concepts and numeric population qualifiers", () => {
    const { keywords, query } = extractClaimKeywords(
      "Intermittent fasting improves insulin sensitivity in adults with type 2 diabetes",
    );
    expect(query.length).toBeGreaterThan(0);
    expect(query.toLowerCase()).toContain("insulin");
    expect(query.toLowerCase()).toContain("diabetes");
    expect(keywords.some((k) => /fasting/i.test(k))).toBe(true);
    expect(query).not.toMatch(/\bimproves\b/);
    expect(query).not.toMatch(/\bwith\b/);
    expect(query).toContain('"type 2 diabetes"');
    // No pair+single duplication like "insulin sensitivity insulin sensitivity".
    const lowered = query.toLowerCase();
    expect(lowered.indexOf("insulin")).toBe(lowered.lastIndexOf("insulin"));
  });

  it("builds a compact query for LLM robustness claims", () => {
    const { keywords, query } = extractClaimKeywords(
      "robustness can enhance the LLM's reasoning ability",
    );
    expect(keywords.join(" | ").toLowerCase()).not.toContain(
      "robustness enhance enhance",
    );
    expect(query.toLowerCase()).toMatch(/robustness/);
    expect(query.toLowerCase()).toMatch(/reasoning/);
    expect(query.toLowerCase()).toContain("large language model");
    expect(query).not.toContain('"robustness llm"');
    // Quoted phrases for multi-word terms.
    expect(query).toMatch(/"/);
  });

  it("falls back to trimmed claim text when nothing survives filtering", () => {
    const { query } = extractClaimKeywords("the and or");
    expect(query).toBe("the and or");
  });

  it("keeps alphanumeric scientific tokens", () => {
    const { query } = extractClaimKeywords("CRISPR-Cas9 editing in HEK293 cells");
    expect(query.toLowerCase()).toMatch(/crispr/);
  });
});

it("keeps UI and server extraction identical", async () => {
  const client = await import("../../app/lib/claim-keywords.js");
  expect(client.extractClaimKeywords("LLM robustness improves reasoning"))
    .toEqual(extractClaimKeywords("LLM robustness improves reasoning"));
});

it.each([
  ["Adversarial training improves LLM reasoning", ["adversarial training", "large language model", "reasoning"]],
  ["Chain-of-thought improves arithmetic reasoning", ["chain of thought", "arithmetic", "reasoning"]],
  ["RAG reduces hallucinations in LLMs", ["retrieval augmented generation", "hallucinations", "large language model"]],
  ["Adults with type 1 diabetes", ["adults", "type 1 diabetes"]],
  ["大语言模型的鲁棒性可以提高推理能力", ["large language model", "robustness", "reasoning"]],
])("extracts concepts from %s without inventing adjacent phrases", (claim, concepts) => {
  expect(extractClaimKeywords(claim).keywords).toEqual(concepts);
});

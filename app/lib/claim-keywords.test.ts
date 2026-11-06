import { describe, expect, it } from "vitest";

import { extractClaimKeywords } from "./claim-keywords.js";

describe("extractClaimKeywords", () => {
  it("extracts non-overlapping phrases from an English claim", () => {
    const { keywords, query } = extractClaimKeywords(
      "Intermittent fasting improves insulin sensitivity in adults with type 2 diabetes",
    );
    expect(query.length).toBeGreaterThan(0);
    expect(query.toLowerCase()).toContain("insulin");
    expect(query.toLowerCase()).toContain("diabetes");
    expect(keywords.some((k) => /fasting/i.test(k))).toBe(true);
    expect(query).not.toMatch(/\bimproves\b/);
    expect(query).not.toMatch(/\bwith\b/);
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
    expect(query.toLowerCase()).toMatch(/llm|ability/);
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

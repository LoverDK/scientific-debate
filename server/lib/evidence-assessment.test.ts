import { expect, it } from "vitest";
import { evidenceAssessmentSchema, groundEvidenceAssessment, canAttachAssessedEvidence, reviewAbstract } from "./evidence-assessment.js";
import type { OpenAlexMappedWork } from "./openalex-works.js";

// Synthetic fixture, not a claim about an actual publication.
const excerpt = "The intervention improved accuracy on the specified reasoning task.";
const paper: OpenAlexMappedWork = { externalId: "W1", title: "Synthetic study", authors: [], abstract: excerpt,
  year: null, doi: null, url: null, providerUrl: "https://openalex.org/W1", citationCount: null, relevanceScore: null };
const assessment = { externalId: "W1", relevance: "direct" as const, stance: "supports" as const,
  rationale: "The abstract reports an improvement on the claimed task.", evidenceExcerpt: excerpt };

it("accepts a direct result with a verifiable abstract excerpt", () => {
  const result = groundEvidenceAssessment(paper, assessment);
  expect(result.stance).toBe("supports");
  expect(result.evidenceExcerpt).toBe(excerpt);
  expect(canAttachAssessedEvidence(result)).toBe(true);
});
it("keeps related background uncertain even when the model proposes support", () => {
  expect(groundEvidenceAssessment(paper, { ...assessment, relevance: "contextual" })).toMatchObject({ relevance: "contextual", stance: "uncertain" });
});
it.each(["irrelevant", "insufficient_metadata"] as const)("excludes %s rather than treating it as supporting evidence", relevance => {
  const result = groundEvidenceAssessment(paper, { ...assessment, relevance });
  expect(result.stance).toBe("uncertain");
  expect(canAttachAssessedEvidence(result)).toBe(false);
});
it("never treats a title-only paper as evidence of a finding", () => {
  const result = groundEvidenceAssessment({ ...paper, abstract: null }, assessment);
  expect(result.relevance).toBe("insufficient_metadata");
  expect(canAttachAssessedEvidence(result)).toBe(false);
});
it.each(["Invented experiment proves the claim with certainty.", "The intervention ... reasoning task.", "accuracy"])("rejects unverifiable or insufficient excerpts: %s", evidenceExcerpt => {
  const result = groundEvidenceAssessment(paper, { ...assessment, evidenceExcerpt });
  expect(result.relevance).toBe("unassessed");
  expect(canAttachAssessedEvidence(result)).toBe(false);
});
it("allows whitespace differences but does not match text outside the supplied budget", () => {
  expect(groundEvidenceAssessment({ ...paper, abstract: excerpt.replace(/ /g, "\n") }, assessment).relevance).toBe("direct");
  expect(groundEvidenceAssessment({ ...paper, abstract: "x".repeat(1200) + excerpt }, assessment).relevance).toBe("unassessed");
});
it("truncates review text without splitting an emoji", () => {
  expect(reviewAbstract("a".repeat(1199) + "😀")).toBe("a".repeat(1199));
  expect(reviewAbstract("a".repeat(1198) + "😀").length).toBe(1200);
});
it("requires relevance and rejects unknown fields", () => {
  expect(evidenceAssessmentSchema.safeParse({ ...assessment, relevance: "excellent" }).success).toBe(false);
  expect(evidenceAssessmentSchema.safeParse({ ...assessment, providerResponse: "private" }).success).toBe(false);
});

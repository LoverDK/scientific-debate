import { z } from "zod";
import type { OpenAlexMappedWork } from "./openalex-works.js";

// Match the existing EvidencePack abstract budget: classification must not rely
// on a passage that the subsequent debate will lose when its snapshot is built.
export const PAPER_ABSTRACT_REVIEW_CHARS = 1200;
export const evidenceAssessmentSchema = z.strictObject({
  externalId: z.string().regex(/^W\d+$/).max(64),
  relevance: z.enum(["direct", "contextual", "irrelevant", "insufficient_metadata"]),
  stance: z.enum(["supports", "opposes", "uncertain"]),
  rationale: z.string().trim().min(1).max(500),
  evidenceExcerpt: z.string().max(500),
});
export type EvidenceAssessment = z.infer<typeof evidenceAssessmentSchema>;
export type AssessedEvidence = Omit<EvidenceAssessment, "externalId" | "relevance"> & {
  relevance: EvidenceAssessment["relevance"] | "unassessed";
};

/** Preserve the exact review text so an excerpt cannot cite text the model never saw. */
export function reviewAbstract(abstract: string | null): string {
  if (!abstract) return "";
  let result = abstract.slice(0, PAPER_ABSTRACT_REVIEW_CHARS);
  const last = result.charCodeAt(result.length - 1);
  const next = abstract.charCodeAt(result.length);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) result = result.slice(0, -1);
  return result;
}

export function unassessedEvidence(): AssessedEvidence {
  return { relevance: "unassessed", stance: "uncertain", evidenceExcerpt: "",
    rationale: "This paper's relevance and stance have not been established by the model." };
}

/** Verifies provenance, not whether the model's scientific interpretation is correct. */
export function groundEvidenceAssessment(paper: OpenAlexMappedWork, assessment: EvidenceAssessment): AssessedEvidence {
  if (paper.externalId !== assessment.externalId) return unassessedEvidence();
  const abstract = reviewAbstract(paper.abstract);
  if (!abstract.trim()) {
    return { relevance: "insufficient_metadata", stance: "uncertain", evidenceExcerpt: "",
      rationale: "No abstract is available. A title alone cannot establish support or opposition." };
  }
  if (assessment.relevance === "irrelevant" || assessment.relevance === "insufficient_metadata") {
    return { relevance: assessment.relevance, stance: "uncertain", rationale: assessment.rationale, evidenceExcerpt: "" };
  }
  const excerpt = assessment.evidenceExcerpt.trim();
  const spaces = (text: string) => text.replace(/\s+/g, " ").trim();
  if (excerpt.length < 20 || !spaces(abstract).includes(spaces(excerpt))) {
    return { ...unassessedEvidence(), rationale: "The model did not provide a verifiable passage from the supplied abstract." };
  }
  return {
    relevance: assessment.relevance,
    stance: assessment.relevance === "direct" ? assessment.stance : "uncertain",
    rationale: assessment.rationale,
    evidenceExcerpt: excerpt,
  };
}

export function canAttachAssessedEvidence(paper: AssessedEvidence): boolean {
  return paper.relevance === "direct" || paper.relevance === "contextual";
}

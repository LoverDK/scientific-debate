import { extractClaimKeywords } from "./claim-keywords.js";
import type { OpenAlexMappedWork } from "./openalex-works.js";

export type EvidenceStance = "supports" | "opposes" | "uncertain";

const SUPPORT_CUES = [
  "support",
  "supports",
  "supporting",
  "confirm",
  "confirms",
  "demonstrate",
  "demonstrates",
  "improve",
  "improves",
  "enhanced",
  "enhances",
  "effective",
  "efficacy",
  "associated with",
  "consistent with",
  "validate",
  "validates",
  "beneficial",
  "significant improvement",
  "positive effect",
];

const OPPOSE_CUES = [
  "fail",
  "fails",
  "failed",
  "failure",
  "no significant",
  "not significant",
  "nonsignificant",
  "contradict",
  "contradicts",
  "contrary",
  "limitation",
  "limitations",
  "does not",
  "do not",
  "unable",
  "undermine",
  "undermines",
  "against",
  "challenge",
  "challenges",
  "refute",
  "refutes",
  "ineffective",
  "no evidence",
  "lack of evidence",
  "null result",
  "negative result",
  "spurious",
  "overstated",
  "insufficient",
];

function countCueHits(text: string, cues: string[]): number {
  let hits = 0;
  for (const cue of cues) {
    if (text.includes(cue)) hits += 1;
  }
  return hits;
}

function keywordCoverage(text: string, keywords: string[]): number {
  let hits = 0;
  for (const keyword of keywords) {
    const needle = keyword.toLowerCase().replace(/^"+|"+$/g, "");
    if (needle.length >= 3 && text.includes(needle)) hits += 1;
  }
  return hits;
}

/** Build OpenAlex queries aimed at supportive vs critical literature. */
export function buildEvidenceSearchQueries(claim: string): {
  keywords: string[];
  supportQuery: string;
  opposeQuery: string;
} {
  const { keywords } = extractClaimKeywords(claim);
  // Adjacent extracted tokens can be separated by stopwords in the claim.
  // Searching them as exact phrases excludes otherwise relevant abstracts.
  const base = keywords.join(" ") || claim.trim().slice(0, 200);
  return {
    keywords,
    supportQuery: base,
    opposeQuery: `${base} (limitation OR failure OR critique OR "does not" OR ineffective OR controversy)`,
  };
}

/**
 * Heuristic stance from title/abstract vs claim (no LLM, no API cost).
 * Prefer papers with claim keyword coverage; then compare support vs oppose cues.
 */
export function classifyPaperStance(
  claim: string,
  paper: Pick<OpenAlexMappedWork, "title" | "abstract">,
  keywords: string[],
): { stance: EvidenceStance; supportScore: number; opposeScore: number } {
  const text = `${paper.title ?? ""}\n${paper.abstract ?? ""}`.toLowerCase();
  const coverage = keywordCoverage(text, keywords);
  const supportHits = countCueHits(text, SUPPORT_CUES);
  const opposeHits = countCueHits(text, OPPOSE_CUES);

  // Coverage boosts both; cue imbalance decides polarity.
  const supportScore = coverage * 2 + supportHits * 3;
  const opposeScore = coverage * 2 + opposeHits * 3;

  if (coverage === 0 && supportHits === 0 && opposeHits === 0) {
    return { stance: "uncertain", supportScore, opposeScore };
  }

  if (supportScore >= opposeScore + 2 && supportScore > 0) {
    return { stance: "supports", supportScore, opposeScore };
  }
  if (opposeScore >= supportScore + 2 && opposeScore > 0) {
    return { stance: "opposes", supportScore, opposeScore };
  }
  // Explicit oppose cues with some claim overlap → lean oppose.
  if (opposeHits > supportHits && coverage > 0) {
    return { stance: "opposes", supportScore, opposeScore };
  }
  if (supportHits > opposeHits && coverage > 0) {
    return { stance: "supports", supportScore, opposeScore };
  }
  return { stance: "uncertain", supportScore, opposeScore };
}

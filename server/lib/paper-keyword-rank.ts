import type { OpenAlexMappedWork } from "./openalex-works.js";

/** Lightweight token forms for near-match scoring (no NLP dependency). */
export function keywordVariants(term: string): string[] {
  const base = term
    .toLowerCase()
    .replace(/^"+|"+$/g, "")
    .trim();
  if (!base) return [];
  const parts = base.split(/\s+/).filter(Boolean);
  const variants = new Set<string>([base, ...parts]);
  for (const part of parts) {
    if (part.length < 4) continue;
    if (part.endsWith("ing") && part.length > 5) variants.add(part.slice(0, -3));
    if (part.endsWith("ed") && part.length > 4) variants.add(part.slice(0, -2));
    if (part.endsWith("s") && !part.endsWith("ss") && part.length > 3) {
      variants.add(part.slice(0, -1));
    }
    if (part.endsWith("ies") && part.length > 4) {
      variants.add(`${part.slice(0, -3)}y`);
    }
  }
  return [...variants];
}

function haystackOf(paper: OpenAlexMappedWork): string {
  return [paper.title ?? "", paper.abstract ?? ""]
    .join("\n")
    .toLowerCase();
}

/**
 * Rank papers so those covering more query phrases/tokens rise first.
 * Secondary key: OpenAlex relevanceScore.
 */
export function rankPapersByKeywordCoverage(
  papers: OpenAlexMappedWork[],
  query: string,
): OpenAlexMappedWork[] {
  const phrases = query
    .match(/"[^"]+"|[^\s"]+/g)
    ?.map((part) => part.replace(/^"+|"+$/g, "").trim().toLowerCase())
    .filter((part) => part.length > 0) ?? [];

  if (phrases.length === 0) return papers;

  const phraseVariants = phrases.map((phrase) => ({
    phrase,
    variants: keywordVariants(phrase),
  }));

  const scored = papers.map((paper, index) => {
    const hay = haystackOf(paper);
    let exactPhrases = 0;
    let nearTokens = 0;
    for (const { phrase, variants } of phraseVariants) {
      if (hay.includes(phrase)) {
        exactPhrases += 1;
        continue;
      }
      let near = false;
      for (const variant of variants) {
        if (variant === phrase) continue;
        if (variant.length >= 3 && hay.includes(variant)) {
          near = true;
          break;
        }
      }
      if (near) nearTokens += 1;
    }
    const coverageRatio = exactPhrases / phraseVariants.length;
    const nearRatio = nearTokens / phraseVariants.length;
    const relevance = paper.relevanceScore ?? 0;
    const score =
      exactPhrases * 100 +
      nearTokens * 25 +
      coverageRatio * 40 +
      nearRatio * 10 +
      relevance;
    return { paper, score, index };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.index - b.index;
  });
  return scored.map((entry) => entry.paper);
}

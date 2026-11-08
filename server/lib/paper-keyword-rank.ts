import type { OpenAlexMappedWork } from "./openalex-works.js";
import { containsResearchTerm, normalizeResearchText, researchAliases } from "../../shared/research-terms.js";

/** Explicit aliases plus conservative inflections, not arbitrary substring similarity. */
export function keywordVariants(term: string): string[] {
  const variants = new Set(researchAliases(term));
  for (const base of [...variants]) {
    if (base.includes(" ")) continue;
    if (base.endsWith("ing") && base.length > 5) variants.add(base.slice(0, -3));
    if (base.endsWith("ies") && base.length > 4) variants.add(`${base.slice(0, -3)}y`);
    else if (base.endsWith("s") && !base.endsWith("ss") && base.length > 3) variants.add(base.slice(0, -1));
  }
  return [...variants];
}

/** Rank by concept coverage first, title coverage second, upstream score last. */
export function rankPapersByKeywordCoverage(papers: OpenAlexMappedWork[], query: string | readonly string[]): OpenAlexMappedWork[] {
  const terms = typeof query === "string"
    ? (query.match(/"[^"]+"|[^\s"()]+/g) ?? []).filter(term => !["AND", "OR", "NOT"].includes(term))
    : query;
  const groups = [...new Map(terms.map(term => {
    const variants = keywordVariants(normalizeResearchText(term));
    return [[...variants].sort().join("|"), variants] as const;
  })).values()].filter(group => group.some(Boolean));
  const scored = papers.map((paper, index) => {
    const title = normalizeResearchText(paper.title ?? "");
    const text = `${title} ${normalizeResearchText(paper.abstract ?? "")}`;
    const covers = (haystack: string) => groups.filter(group => group.some(term => containsResearchTerm(haystack, term))).length;
    return { paper, index, coverage: covers(text), titleCoverage: covers(title) };
  });
  scored.sort((a, b) => b.coverage - a.coverage || b.titleCoverage - a.titleCoverage ||
    (b.paper.relevanceScore ?? 0) - (a.paper.relevanceScore ?? 0) || a.index - b.index);
  return scored.map(item => item.paper);
}

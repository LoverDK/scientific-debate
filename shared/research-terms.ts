/** Small explicit vocabulary, not a learned semantic model. Unknown terms stay literal. */
const CONCEPTS: readonly (readonly string[])[] = [
  ["large language model", "large language models", "llm", "llms", "大语言模型", "大型语言模型"],
  ["chain of thought", "cot", "思维链"],
  ["retrieval augmented generation", "rag", "检索增强生成"],
  ["robustness", "robust", "鲁棒性"],
  ["reasoning", "reason", "推理能力", "推理"],
  ["adversarial training", "对抗训练"],
  ["fine tuning", "finetuning", "微调"],
  ["intermittent fasting", "间歇性禁食"],
  ["insulin sensitivity", "胰岛素敏感性"],
  ["type 2 diabetes", "t2dm", "2型糖尿病"],
  ["type 1 diabetes", "t1dm", "1型糖尿病"],
];

const STOPWORDS = new Set(`a an the and or of to in on for from with by as at is are was were be been being
can could may might will would should must this that these those it its their our my your how whether
does do did has have had than then also through using used based claim claims study studies research
improve improves improved improving enhance enhances enhanced enhancing increase increases increased
reduce reduces reduced reducing affect affects effect effects ability abilities not no without always
all some only versus vs compared comparison between among into under over within more less better
的 是 了 能 可以 提高 增强 改善 是否 对 与 和 中 不`.split(/\s+/));

export function normalizeResearchText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[’']/g, "'")
    .replace(/\b([\p{L}\p{N}]+)'s\b/gu, "$1")
    .replace(/[-–—]/g, " ").replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ").trim();
}

/** Whole-word matching for Latin terms; CJK concept names can appear without spaces. */
export function containsResearchTerm(normalizedText: string, term: string): boolean {
  const needle = normalizeResearchText(term);
  if (!needle) return false;
  if (/[\u3400-\u9fff]/u.test(needle)) return normalizedText.includes(needle);
  return (` ${normalizedText} `).includes(` ${needle} `);
}

export function researchAliases(term: string): string[] {
  const normalized = normalizeResearchText(term);
  const group = CONCEPTS.find(items => items.some(item => normalizeResearchText(item) === normalized));
  return group ? [...new Set(group.map(normalizeResearchText))] : [normalized];
}

/** Preserve known phrases, never join words made adjacent by removing stopwords. */
export function extractClaimKeywords(claim: string): { keywords: string[]; query: string } {
  let remaining = normalizeResearchText(claim);
  const found: { position: number; term: string }[] = [];
  const phrases = CONCEPTS.flatMap(group => group.map(term => ({ term, canonical: group[0]! })))
    .sort((a, b) => b.term.length - a.term.length);
  for (const { term, canonical } of phrases) {
    const normalized = normalizeResearchText(term);
    if (!containsResearchTerm(remaining, normalized)) continue;
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = /[\u3400-\u9fff]/u.test(normalized)
      ? new RegExp(escaped, "gu") : new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "gu");
    remaining = remaining.replace(pattern, (match, offset: number) => {
      found.push({ position: offset, term: canonical });
      return " ".repeat(match.length);
    });
  }
  for (const word of ["可以", "能够", "提高", "增强", "改善", "是否", "的", "对", "与", "和", "中", "不"]) {
    remaining = remaining.split(word).join(" ".repeat(word.length));
  }
  for (const match of remaining.matchAll(/[\p{L}\p{N}]+/gu)) {
    const term = match[0];
    if (STOPWORDS.has(term) || (term.length < 3 && !/^\d+$/.test(term) && !/[\u3400-\u9fff]/u.test(term))) continue;
    found.push({ position: match.index, term });
  }
  const keywords = [...new Set(found.sort((a, b) => a.position - b.position).map(item => item.term))].slice(0, 8);
  const query = buildConceptQuery(keywords, false);
  return { keywords, query: query || normalizeResearchText(claim).slice(0, 300) };
}

/** Bound whole clauses rather than cutting quotes or parentheses mid-query. */
export function buildConceptQuery(concepts: readonly string[], expanded: boolean, maxLength = 300): string {
  const clauses: string[] = [];
  for (const [index, concept] of concepts.entries()) {
    const literal = normalizeResearchText(concept);
    if (!literal || literal.length > maxLength - 2) continue;
    const quote = (term: string) => term.includes(" ") ? `"${term}"` : term;
    const aliases = researchAliases(concept).filter(term => !/[\u3400-\u9fff]/u.test(term)).slice(0, 3);
    let clause = expanded && aliases.length > 1 ? `(${aliases.map(quote).join(" OR ")})` : quote(literal);
    // Reserve the remaining canonical concepts so expansions cannot crowd them out.
    const tailLength = concepts.slice(index + 1).reduce((n, value) => n + quote(normalizeResearchText(value)).length + 5, 0);
    if ([...clauses, clause].join(" AND ").length + tailLength > maxLength) clause = quote(literal);
    if ([...clauses, clause].join(" AND ").length > maxLength) break;
    clauses.push(clause);
  }
  return clauses.join(" AND ");
}

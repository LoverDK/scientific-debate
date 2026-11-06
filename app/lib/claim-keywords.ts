/**
 * Client-safe claim → keyword helper (mirrors server/lib/claim-keywords.ts).
 * Keep behavior in sync; server gather path imports server/lib directly.
 */

const EN_STOPWORDS = new Set(
  `
a about above after again against all am an and any are as at be because been
before being below between both but by can could did do does doing down during
each few for from further had has have having he her here hers herself him
himself his how i if in into is it its itself just may me might more most my
myself no nor not of off on once only or other our ours ourselves out over own
same she should so some such than that the their theirs them themselves then
there these they this those through to too under until up very was we were what
when where which while who whom why will with would you your yours yourself
yourselves via vs versus using used based upon within without across among
into onto whether claim claims study studies effect effects improve improves
improved improving enhance enhances enhanced enhancing increase increases
increased associated associate relative relatively compared compare adults
adult people patients patient
`.trim().split(/\s+/),
);

const ZH_STOPWORDS = new Set(
  "的 了 在 是 我 有 和 就 不 人 都 一 一个 上 也 很 到 说 要 去 你 会 着 没有 看 好 自己 这 那 与 及 或 对 等 被 把 让 使 于 从 以 而 并 其 中 为 能 可 会 否 是否 研究 表明 显示 证明 影响".split(
    /\s+/,
  ),
);

const MAX_KEYWORDS = 6;
const MAX_QUERY_CHARS = 300;

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function tokenize(claim: string): string[] {
  const normalized = claim
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[“”‘’"'`]/g, " ")
    .replace(/[，。！？；：、（）【】《》〈〉—…·]/g, " ")
    .replace(/[^\p{L}\p{N}\s+-]/gu, " ");

  const parts: string[] = [];
  for (const chunk of normalized.split(/\s+/)) {
    if (!chunk) continue;
    if (/^[\u3400-\u9fff]+$/u.test(chunk) && chunk.length > 1) {
      if (chunk.length <= 4) {
        parts.push(chunk);
      } else {
        for (let i = 0; i < chunk.length - 1; i += 1) {
          parts.push(chunk.slice(i, i + 2));
        }
      }
      continue;
    }
    const cleaned = chunk.replace(/^-+|-+$/g, "");
    if (cleaned) parts.push(cleaned);
  }
  return parts;
}

function isStopword(token: string): boolean {
  if (EN_STOPWORDS.has(token)) return true;
  if (ZH_STOPWORDS.has(token)) return true;
  if (/^\d+$/.test(token)) return true;
  return false;
}

function isContentToken(token: string): boolean {
  if (isStopword(token)) return false;
  if (/^[\u3400-\u9fff]{2,}$/u.test(token)) return true;
  if (token.length >= 3 && /[a-z]/i.test(token)) return true;
  if (token.length >= 2 && /\d/.test(token) && /[a-z]/i.test(token)) return true;
  return false;
}

function formatSearchTerm(phrase: string): string {
  if (/\s/.test(phrase)) return `"${phrase}"`;
  return phrase;
}

export function extractClaimKeywords(claim: string): {
  keywords: string[];
  query: string;
} {
  const tokens = tokenize(claim).filter(isContentToken);
  const keywords: string[] = [];
  const seen = new Set<string>();

  const push = (value: string) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    if (keywords.length >= MAX_KEYWORDS) return false;
    seen.add(key);
    keywords.push(value);
    return true;
  };

  let i = 0;
  const used = new Array(tokens.length).fill(false);
  while (i < tokens.length - 1 && keywords.length < MAX_KEYWORDS) {
    const a = tokens[i]!;
    const b = tokens[i + 1]!;
    const bothLatin = /[a-z]/i.test(a) && /[a-z]/i.test(b);
    if (bothLatin && push(`${a} ${b}`)) {
      used[i] = true;
      used[i + 1] = true;
      i += 2;
      continue;
    }
    i += 1;
  }
  for (let j = 0; j < tokens.length; j += 1) {
    if (used[j]) continue;
    push(tokens[j]!);
  }

  const query = normalizeSpaces(
    keywords.map(formatSearchTerm).join(" "),
  ).slice(0, MAX_QUERY_CHARS);

  return {
    keywords,
    query: query || normalizeSpaces(claim).slice(0, MAX_QUERY_CHARS),
  };
}

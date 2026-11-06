const OPENALEX_WEB_ORIGIN = "https://openalex.org";
const OPENALEX_WORK_ID_RE = /^W\d+$/;
const OPENALEX_WORK_PATH_RE = /^\/W\d+$/;
const DOI_SHORT_RE = /^10\.\d{4,9}\/\S+$/;

/** Mapped OpenAlex work fields used by search/attach surfaces. */
export type OpenAlexMappedWork = {
  externalId: string;
  title: string | null;
  authors: string[];
  year: number | null;
  doi: string | null;
  abstract: string | null;
  citationCount: number | null;
  relevanceScore: number | null;
  url: string | null;
  providerUrl: string;
};

/**
 * Rebuild plaintext from OpenAlex `abstract_inverted_index`.
 * Returns null when the index is missing, illegal, conflicting, or non-contiguous.
 * Does not invent tokens for missing positions.
 */
export function reconstructAbstract(index: unknown): string | null {
  if (index === null || index === undefined) return null;
  if (typeof index !== "object" || Array.isArray(index)) return null;

  const positionToWord = new Map<number, string>();

  for (const [word, positions] of Object.entries(
    index as Record<string, unknown>,
  )) {
    if (typeof word !== "string" || word.length === 0) return null;
    if (!Array.isArray(positions) || positions.length === 0) return null;

    for (const pos of positions) {
      if (typeof pos !== "number" || !Number.isInteger(pos) || pos < 0) {
        return null;
      }
      const existing = positionToWord.get(pos);
      if (existing !== undefined && existing !== word) {
        // Conflicting tokens at the same index — do not invent a resolution.
        return null;
      }
      positionToWord.set(pos, word);
    }
  }

  if (positionToWord.size === 0) return null;

  const ordered = [...positionToWord.entries()].sort((a, b) => a[0] - b[0]);
  // Positions must start at 0 and be contiguous; gaps → null (no fabricated words).
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i]![0] !== i) return null;
  }

  return ordered.map(([, word]) => word).join(" ");
}

function hasUrlUserInfo(url: URL): boolean {
  return url.username !== "" || url.password !== "";
}

/** Accept short `W…` ids or strict `https://openalex.org/W…` URLs. */
export function extractOpenAlexWorkId(rawId: unknown): string | null {
  if (typeof rawId !== "string") return null;
  const trimmed = rawId.trim();
  if (OPENALEX_WORK_ID_RE.test(trimmed)) return trimmed;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") return null;
    if (url.hostname !== "openalex.org") return null;
    if (hasUrlUserInfo(url)) return null;
    // Reject non-default ports (URL.port is "" for the scheme default).
    if (url.port !== "") return null;
    if (url.search !== "" || url.hash !== "") return null;
    if (!OPENALEX_WORK_PATH_RE.test(url.pathname)) return null;
    return url.pathname.slice(1);
  } catch {
    return null;
  }
}

export function buildProviderUrl(workId: string): string | null {
  if (!OPENALEX_WORK_ID_RE.test(workId)) return null;
  return `${OPENALEX_WEB_ORIGIN}/${workId}`;
}

/** Normalize DOI to lowercase short form; reject userinfo/query/hash URL forms. */
export function normalizeDoi(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim();
  if (!value) return null;

  try {
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      if (host !== "doi.org" && host !== "dx.doi.org" && host !== "www.doi.org") {
        return null;
      }
      if (hasUrlUserInfo(url)) return null;
      if (url.search !== "" || url.hash !== "") return null;
      value = url.pathname.replace(/^\/+/, "");
    }
  } catch {
    return null;
  }

  value = value.replace(/^doi:\s*/i, "").trim().toLowerCase();
  if (!DOI_SHORT_RE.test(value)) return null;
  return value;
}

/** Allow only http(s) URLs without embedded credentials. */
export function asHttpUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (hasUrlUserInfo(url)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function mapAuthors(authorships: unknown): string[] {
  if (!Array.isArray(authorships)) return [];
  const names: string[] = [];
  for (const entry of authorships) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const author = (entry as { author?: unknown }).author;
    if (author === null || typeof author !== "object" || Array.isArray(author)) {
      continue;
    }
    const displayName = (author as { display_name?: unknown }).display_name;
    if (typeof displayName === "string" && displayName.trim()) {
      names.push(displayName.trim());
    }
  }
  return names;
}

/** Map one OpenAlex work JSON object; returns null when the work lacks a valid ID. */
export function mapWork(raw: unknown): OpenAlexMappedWork | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const work = raw as Record<string, unknown>;

  const externalId = extractOpenAlexWorkId(work.id);
  if (!externalId) return null;

  const providerUrl = buildProviderUrl(externalId);
  if (!providerUrl) return null;

  const titleRaw = work.title ?? work.display_name;
  const title =
    typeof titleRaw === "string" && titleRaw.trim() ? titleRaw.trim() : null;

  const year =
    typeof work.publication_year === "number" &&
    Number.isInteger(work.publication_year)
      ? work.publication_year
      : null;

  const citationCount =
    typeof work.cited_by_count === "number" &&
    Number.isInteger(work.cited_by_count)
      ? work.cited_by_count
      : null;

  const relevanceScore =
    typeof work.relevance_score === "number" &&
    Number.isFinite(work.relevance_score)
      ? work.relevance_score
      : null;

  const primaryLocation =
    work.primary_location !== null &&
    typeof work.primary_location === "object" &&
    !Array.isArray(work.primary_location)
      ? (work.primary_location as Record<string, unknown>)
      : null;

  return {
    externalId,
    title,
    authors: mapAuthors(work.authorships),
    year,
    doi: normalizeDoi(work.doi),
    abstract: reconstructAbstract(work.abstract_inverted_index),
    citationCount,
    relevanceScore,
    url: asHttpUrl(primaryLocation?.landing_page_url),
    providerUrl,
  };
}

import { resolveSecretDetailed } from "@agent-native/core/server";

import {
  mapWork,
  normalizeDoi,
  type OpenAlexMappedWork,
} from "./openalex-works.js";

const OPENALEX_API_ORIGIN = "https://api.openalex.org";
const CROSSREF_API_ORIGIN = "https://api.crossref.org";
const REQUEST_TIMEOUT_MS = 12_000;
const OPENALEX_SECRET_KEY = "OPENALEX_API_KEY";
/** Puts us in OpenAlex's polite pool (higher rate limits than anonymous). */
const OPENALEX_MAILTO =
  process.env.OPENALEX_MAILTO?.trim() ||
  "scientific-debate-hackathon@example.com";
const MAX_ATTEMPTS = 4;

function errorName(error: unknown): string | null {
  if (error instanceof Error) return error.name;
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name;
  }
  return null;
}

function isTimeoutFailure(error: unknown, signal: AbortSignal): boolean {
  if (errorName(error) === "TimeoutError") return true;
  if (!signal.aborted) return false;
  const reasonName = errorName(signal.reason);
  if (reasonName === "TimeoutError") {
    const thrownName = errorName(error);
    return thrownName === "TimeoutError" || thrownName === "AbortError";
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OpenAlexSearchError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "OpenAlexSearchError";
    this.statusCode = statusCode;
  }
}

/** Env first, then Agent-Native secrets vault (free OpenAlex key). */
export async function resolveOpenAlexApiKey(): Promise<string | null> {
  const fromEnv = process.env.OPENALEX_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const detail = await resolveSecretDetailed(OPENALEX_SECRET_KEY);
    if (detail.lookupFailed) return null;
    return detail.value?.trim() || null;
  } catch {
    return null;
  }
}

function isAnonymousSearchPaused(error: unknown): boolean {
  return (
    error instanceof OpenAlexSearchError &&
    error.statusCode === 503 &&
    /anonymous search is paused|search cluster is recovering/i.test(
      error.message,
    )
  );
}

async function fetchOpenAlexWorksOnce(options: {
  query: string;
  page: number;
  perPage: number;
  apiKey: string | null;
}): Promise<OpenAlexMappedWork[]> {
  const requestUrl = new URL("/works", OPENALEX_API_ORIGIN);
  const params = new URLSearchParams({
    search: options.query,
    page: String(options.page),
    per_page: String(options.perPage),
    mailto: OPENALEX_MAILTO,
  });
  if (options.apiKey) params.set("api_key", options.apiKey);
  requestUrl.search = params.toString();

  if (requestUrl.origin !== OPENALEX_API_ORIGIN) {
    throw new OpenAlexSearchError(
      "Refusing OpenAlex request with unexpected origin.",
      500,
    );
  }

  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": `ScientificDebate/0.1 (mailto:${OPENALEX_MAILTO})`,
  };
  if (options.apiKey) {
    headers.Authorization = `Bearer ${options.apiKey}`;
  }

  let response: Response;
  try {
    response = await fetch(requestUrl, {
      method: "GET",
      redirect: "manual",
      signal,
      headers,
    });
  } catch (error) {
    if (isTimeoutFailure(error, signal)) {
      throw new OpenAlexSearchError("OpenAlex request timed out.", 504);
    }
    throw new OpenAlexSearchError("OpenAlex network request failed.", 502);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new OpenAlexSearchError(
      "OpenAlex returned an unexpected redirect.",
      502,
    );
  }

  if (response.status === 429) {
    throw new OpenAlexSearchError("OpenAlex rate limit exceeded (429).", 429);
  }

  if (response.status === 503) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      body = "";
    }
    if (/Search temporarily unavailable|Anonymous search is paused/i.test(body)) {
      throw new OpenAlexSearchError(
        options.apiKey
          ? "OpenAlex search cluster is recovering. Retry in about a minute."
          : "OpenAlex anonymous search is paused.",
        503,
      );
    }
    throw new OpenAlexSearchError("OpenAlex upstream error (503).", 502);
  }

  if (response.status >= 500) {
    throw new OpenAlexSearchError(
      `OpenAlex upstream error (${response.status}).`,
      502,
    );
  }
  if (!response.ok) {
    throw new OpenAlexSearchError(
      `OpenAlex request failed (${response.status}).`,
      502,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (isTimeoutFailure(error, signal)) {
      throw new OpenAlexSearchError("OpenAlex request timed out.", 504);
    }
    throw new OpenAlexSearchError("OpenAlex returned invalid JSON.", 502);
  }

  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    throw new OpenAlexSearchError(
      "OpenAlex response has an unexpected shape.",
      502,
    );
  }

  const results = (payload as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    throw new OpenAlexSearchError(
      "OpenAlex response is missing a results array.",
      502,
    );
  }

  const papers: OpenAlexMappedWork[] = [];
  for (const item of results) {
    if (papers.length >= options.perPage) break;
    const mapped = mapWork(item);
    if (mapped) papers.push(mapped);
  }
  return papers;
}

async function listDoisFromCrossref(options: {
  query: string;
  page: number;
  perPage: number;
}): Promise<string[]> {
  const offset = Math.max(0, (options.page - 1) * options.perPage);
  const requestUrl = new URL("/works", CROSSREF_API_ORIGIN);
  requestUrl.search = new URLSearchParams({
    query: options.query,
    rows: String(options.perPage),
    offset: String(offset),
    mailto: OPENALEX_MAILTO,
  }).toString();

  if (requestUrl.origin !== CROSSREF_API_ORIGIN) {
    throw new OpenAlexSearchError(
      "Refusing Crossref request with unexpected origin.",
      500,
    );
  }

  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(requestUrl, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: {
        Accept: "application/json",
        "User-Agent": `ScientificDebate/0.1 (mailto:${OPENALEX_MAILTO})`,
      },
    });
  } catch (error) {
    if (isTimeoutFailure(error, signal)) {
      throw new OpenAlexSearchError("Crossref request timed out.", 504);
    }
    throw new OpenAlexSearchError("Crossref network request failed.", 502);
  }

  if (!response.ok) {
    throw new OpenAlexSearchError(
      `Crossref request failed (${response.status}).`,
      502,
    );
  }

  const payload = (await response.json()) as {
    message?: { items?: unknown };
  };
  const items = payload.message?.items;
  if (!Array.isArray(items)) {
    throw new OpenAlexSearchError("Crossref returned an invalid result list.", 502);
  }

  const dois: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const doi = normalizeDoi((item as { DOI?: unknown }).DOI);
    if (doi) dois.push(doi);
  }
  return dois;
}

async function fetchOpenAlexWorkByDoi(
  doi: string,
  apiKey: string | null,
): Promise<OpenAlexMappedWork | null> {
  const requestUrl = new URL(
    `/works/https://doi.org/${doi}`,
    OPENALEX_API_ORIGIN,
  );
  requestUrl.search = new URLSearchParams({
    mailto: OPENALEX_MAILTO,
    ...(apiKey ? { api_key: apiKey } : {}),
  }).toString();

  if (requestUrl.origin !== OPENALEX_API_ORIGIN) return null;

  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": `ScientificDebate/0.1 (mailto:${OPENALEX_MAILTO})`,
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let response: Response;
  try {
    response = await fetch(requestUrl, {
      method: "GET",
      redirect: "manual",
      signal,
      headers,
    });
  } catch {
    throw new OpenAlexSearchError("OpenAlex DOI lookup could not be reached.", 502);
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new OpenAlexSearchError(
      `OpenAlex DOI lookup failed (${response.status}).`,
      response.status === 429 ? 429 : 502,
    );
  }
  try {
    return mapWork(await response.json());
  } catch {
    throw new OpenAlexSearchError("OpenAlex DOI lookup returned invalid JSON.", 502);
  }
}

/**
 * When OpenAlex's search cluster is paused for anonymous traffic, Crossref
 * still finds DOIs and OpenAlex DOI lookups (non-search) still work.
 */
async function searchViaCrossrefOpenAlexBridge(options: {
  query: string;
  page: number;
  perPage: number;
  apiKey: string | null;
}): Promise<OpenAlexMappedWork[]> {
  // Cap DOI lookups so gather stays within action timeout during outages.
  const bridgeLimit = Math.min(options.perPage, 6);
  const dois = await listDoisFromCrossref({
    ...options,
    perPage: bridgeLimit,
  });
  const papers: OpenAlexMappedWork[] = [];
  const seen = new Set<string>();
  const concurrency = 3;
  let lookupFailure: OpenAlexSearchError | undefined;

  for (let i = 0; i < dois.length && papers.length < bridgeLimit; i += concurrency) {
    const chunk = dois.slice(i, i + concurrency);
    const mappedChunk = await Promise.allSettled(
      chunk.map((doi) => fetchOpenAlexWorkByDoi(doi, options.apiKey)),
    );
    for (const result of mappedChunk) {
      if (result.status === "rejected") {
        if (!(result.reason instanceof OpenAlexSearchError)) throw result.reason;
        lookupFailure = result.reason;
        continue;
      }
      const mapped = result.value;
      if (!mapped || seen.has(mapped.externalId)) continue;
      seen.add(mapped.externalId);
      papers.push(mapped);
      if (papers.length >= bridgeLimit) break;
    }
    if (lookupFailure?.statusCode === 429) break;
    await sleep(80);
  }
  if (!papers.length && lookupFailure) throw lookupFailure;
  return papers;
}

/** Fetch one page of OpenAlex works for a free-text search query. */
export async function searchOpenAlexWorks(options: {
  query: string;
  /** Plain concept text for Crossref, which does not use OpenAlex Boolean syntax. */
  bridgeQuery?: string;
  page?: number;
  perPage?: number;
  apiKey?: string | null;
}): Promise<OpenAlexMappedWork[]> {
  const page = options.page ?? 1;
  const perPage = options.perPage ?? 10;
  const apiKey =
    options.apiKey === undefined
      ? await resolveOpenAlexApiKey()
      : options.apiKey;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fetchOpenAlexWorksOnce({
        query: options.query,
        page,
        perPage,
        apiKey,
      });
    } catch (error) {
      lastError = error;
      if (isAnonymousSearchPaused(error) && !apiKey) {
        console.warn(
          "[openalex-search] Anonymous search paused; using Crossref→OpenAlex DOI bridge.",
        );
        return searchViaCrossrefOpenAlexBridge({
          query: options.bridgeQuery ?? options.query,
          page,
          perPage,
          apiKey,
        });
      }
      const retryable =
        error instanceof OpenAlexSearchError &&
        (error.statusCode === 429 ||
          error.statusCode === 502 ||
          (error.statusCode === 503 &&
            /recovering|Retry in about a minute/i.test(error.message)));
      if (retryable && attempt < MAX_ATTEMPTS) {
        await sleep(900 * attempt * attempt);
        continue;
      }
      throw error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new OpenAlexSearchError("OpenAlex request failed.", 502);
}

/** Small pause between sequential OpenAlex calls to stay under burst limits. */
export async function pauseBetweenOpenAlexCalls(): Promise<void> {
  await sleep(350);
}

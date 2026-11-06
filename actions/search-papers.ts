import { defineAction, fail } from "@agent-native/core/action";
import { z } from "zod";

import { rankPapersByKeywordCoverage } from "../server/lib/paper-keyword-rank.js";
import {
  mapWork,
  type OpenAlexMappedWork,
} from "../server/lib/openalex-works.js";

const OPENALEX_API_ORIGIN = "https://api.openalex.org";
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_PER_PAGE = 10;
const MAX_PER_PAGE = 25;

function errorName(error: unknown): string | null {
  if (error instanceof Error) return error.name;
  if (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException
  ) {
    return error.name;
  }
  return null;
}

/** True only for AbortSignal.timeout expiry (or equivalent TimeoutError). */
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

function readReportedTotal(payload: object): number | null {
  const meta = (payload as { meta?: unknown }).meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const count = (meta as { count?: unknown }).count;
  return typeof count === "number" && Number.isFinite(count) && count >= 0
    ? Math.floor(count)
    : null;
}

export default defineAction({
  description:
    "Search scholarly papers via OpenAlex works search with pagination. Prefer a keyword query extracted from the claim (content terms / short phrases), not the full prose sentence. Returns mapped bibliographic fields only; does not invent results. Then attach-paper-to-debate for chosen works.",
  schema: z.object({
    query: z
      .string()
      .transform((value) => value.trim())
      .pipe(
        z
          .string()
          .min(1, "query must be a non-empty string after trimming")
          .max(300, "query must be at most 300 characters"),
      ),
    // GET query params arrive as strings — coerce before int checks.
    page: z.coerce.number().int().min(1).max(50).default(1),
    perPage: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PER_PAGE)
      .default(DEFAULT_PER_PAGE),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ query, page, perPage }) => {
    const requestUrl = new URL("/works", OPENALEX_API_ORIGIN);
    requestUrl.search = new URLSearchParams({
      search: query,
      page: String(page),
      per_page: String(perPage),
    }).toString();

    if (requestUrl.origin !== OPENALEX_API_ORIGIN) {
      fail("Refusing OpenAlex request with unexpected origin.", {
        statusCode: 500,
      });
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
          "User-Agent": "ScientificDebate/0.1 (OpenAlex search; no API key)",
        },
      });
    } catch (error) {
      if (isTimeoutFailure(error, signal)) {
        fail("OpenAlex request timed out.", { statusCode: 504 });
      }
      fail("OpenAlex network request failed.", { statusCode: 502 });
    }

    if (response.status >= 300 && response.status < 400) {
      fail("OpenAlex returned an unexpected redirect.", { statusCode: 502 });
    }

    if (response.status === 429) {
      fail("OpenAlex rate limit exceeded (429).", { statusCode: 429 });
    }

    if (response.status >= 500) {
      fail(`OpenAlex upstream error (${response.status}).`, {
        statusCode: 502,
      });
    }

    if (!response.ok) {
      fail(`OpenAlex request failed (${response.status}).`, {
        statusCode: 502,
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (isTimeoutFailure(error, signal)) {
        fail("OpenAlex request timed out.", { statusCode: 504 });
      }
      fail("OpenAlex returned invalid JSON.", { statusCode: 502 });
    }

    if (
      payload === null ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    ) {
      fail("OpenAlex response has an unexpected shape.", { statusCode: 502 });
    }

    const results = (payload as { results?: unknown }).results;
    if (!Array.isArray(results)) {
      fail("OpenAlex response is missing a results array.", {
        statusCode: 502,
      });
    }

    const mappedPapers: OpenAlexMappedWork[] = [];
    for (const item of results) {
      if (mappedPapers.length >= perPage) break;
      const mapped = mapWork(item);
      if (mapped) mappedPapers.push(mapped);
    }

    // Prefer papers covering more query phrases / near forms; OpenAlex
    // relevance_score is a secondary signal inside that ranking.
    const papers = rankPapersByKeywordCoverage(mappedPapers, query);

    const reportedTotal = readReportedTotal(payload);
    const pageCount =
      reportedTotal === null
        ? null
        : Math.max(1, Math.ceil(reportedTotal / perPage));
    const hasMore =
      reportedTotal === null
        ? papers.length >= perPage
        : page * perPage < reportedTotal;

    return {
      source: "openalex" as const,
      query,
      papers,
      meta: {
        page,
        perPage,
        resultCount: papers.length,
        reportedTotal,
        pageCount,
        hasMore,
      },
    };
  },
});

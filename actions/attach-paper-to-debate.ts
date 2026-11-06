import { defineAction, fail } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { mapWork } from "../server/lib/openalex-works.js";

const OPENALEX_API_ORIGIN = "https://api.openalex.org";
const OPENALEX_SOURCE = "openalex" as const;
const REQUEST_TIMEOUT_MS = 10_000;
const OPENALEX_WORK_ID_RE = /^W\d+$/;

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

function parseAuthorsJson(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

async function fetchOpenAlexWork(externalId: string) {
  const requestUrl = new URL(`/works/${externalId}`, OPENALEX_API_ORIGIN);
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
        "User-Agent": "ScientificDebate/0.1 (OpenAlex work; no API key)",
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

  if (response.status === 404) {
    fail("Paper not found.", { statusCode: 404 });
  }

  if (response.status === 429) {
    fail("OpenAlex rate limit exceeded (429).", { statusCode: 429 });
  }

  if (response.status >= 500) {
    fail(`OpenAlex upstream error (${response.status}).`, { statusCode: 502 });
  }

  if (!response.ok) {
    fail(`OpenAlex request failed (${response.status}).`, { statusCode: 502 });
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

  const mapped = mapWork(payload);
  if (!mapped) {
    fail("OpenAlex returned an unusable work object.", { statusCode: 502 });
  }

  if (mapped.externalId !== externalId) {
    // Merged-ID redirects / surviving IDs are not supported in this MVP.
    fail("OpenAlex work ID did not match the requested externalId.", {
      statusCode: 502,
    });
  }

  return mapped;
}

export default defineAction({
  description:
    "Attach an OpenAlex paper to a debate the signed-in user owns. Fetches from OpenAlex only on cache miss; repeated attaches are idempotent.",
  schema: z.object({
    debateId: z
      .string()
      .trim()
      .min(1)
      .describe("Debate id returned by create-debate"),
    externalId: z
      .string()
      .trim()
      .regex(OPENALEX_WORK_ID_RE, "externalId must be an OpenAlex work id like W123")
      .describe('OpenAlex work id, e.g. "W2741809807"'),
  }),
  run: async ({ debateId, externalId }, ctx) => {
    const userEmail =
      ctx?.userEmail ??
      fail("Sign in to attach a paper to a debate.", { statusCode: 401 });

    const { debates, papers, debatePapers } = schema;
    const db = getDb();

    const [ownedDebate] = await db
      .select({ id: debates.id })
      .from(debates)
      .where(and(eq(debates.id, debateId), eq(debates.ownerEmail, userEmail)))
      .limit(1);

    if (!ownedDebate) {
      fail("Debate not found.", { statusCode: 404 });
    }

    const [cachedPaper] = await db
      .select()
      .from(papers)
      .where(
        and(
          eq(papers.source, OPENALEX_SOURCE),
          eq(papers.externalId, externalId),
        ),
      )
      .limit(1);

    const mappedWork = cachedPaper
      ? null
      : await fetchOpenAlexWork(externalId);

    const result = await db.transaction(async (tx) => {
      const [debateStillOwned] = await tx
        .select({ id: debates.id })
        .from(debates)
        .where(and(eq(debates.id, debateId), eq(debates.ownerEmail, userEmail)))
        .limit(1);

      if (!debateStillOwned) {
        fail("Debate not found.", { statusCode: 404 });
      }

      if (!cachedPaper) {
        if (!mappedWork) {
          fail("OpenAlex returned an unusable work object.", {
            statusCode: 502,
          });
        }

        const now = new Date().toISOString();
        await tx
          .insert(papers)
          .values({
            id: crypto.randomUUID(),
            source: OPENALEX_SOURCE,
            externalId: mappedWork.externalId,
            providerUrl: mappedWork.providerUrl,
            title: mappedWork.title,
            authorsJson: JSON.stringify(mappedWork.authors),
            year: mappedWork.year,
            doi: mappedWork.doi,
            abstract: mappedWork.abstract,
            citationCount: mappedWork.citationCount,
            url: mappedWork.url,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({
            target: [papers.source, papers.externalId],
          });
      }

      const [paperRow] = await tx
        .select()
        .from(papers)
        .where(
          and(
            eq(papers.source, OPENALEX_SOURCE),
            eq(papers.externalId, externalId),
          ),
        )
        .limit(1);

      if (!paperRow) {
        fail("Failed to load paper after attach.", { statusCode: 500 });
      }

      const linkId = crypto.randomUUID();
      const addedAt = new Date().toISOString();

      const insertedLinks = await tx
        .insert(debatePapers)
        .values({
          id: linkId,
          debateId,
          paperId: paperRow.id,
          addedAt,
          addedByEmail: userEmail,
        })
        .onConflictDoNothing({
          target: [debatePapers.debateId, debatePapers.paperId],
        })
        .returning({
          id: debatePapers.id,
          addedAt: debatePapers.addedAt,
        });

      let link: { id: string; addedAt: string };
      let created: boolean;

      if (insertedLinks[0]) {
        created = true;
        link = insertedLinks[0];
      } else {
        created = false;
        const [existingLink] = await tx
          .select({
            id: debatePapers.id,
            addedAt: debatePapers.addedAt,
          })
          .from(debatePapers)
          .where(
            and(
              eq(debatePapers.debateId, debateId),
              eq(debatePapers.paperId, paperRow.id),
            ),
          )
          .limit(1);

        if (!existingLink) {
          fail("Failed to load debate paper link after attach.", {
            statusCode: 500,
          });
        }
        link = existingLink;
      }

      return {
        paperRow,
        link,
        created,
      };
    });

    return {
      success: true as const,
      debateId,
      paper: {
        id: result.paperRow.id,
        source: OPENALEX_SOURCE,
        externalId: result.paperRow.externalId,
        providerUrl: result.paperRow.providerUrl,
        title: result.paperRow.title,
        authors: parseAuthorsJson(result.paperRow.authorsJson),
        year: result.paperRow.year,
        doi: result.paperRow.doi,
        citationCount: result.paperRow.citationCount,
        url: result.paperRow.url,
      },
      link: {
        id: result.link.id,
        addedAt: result.link.addedAt,
        created: result.created,
      },
    };
  },
});

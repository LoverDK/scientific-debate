import {
  ActionInputValidationError,
  isActionContractError,
} from "@agent-native/core/action";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import searchPapers from "./search-papers.js";

const QUERY = "crispr gene editing";
const OPENALEX_HOST = "api.openalex.org";

type FetchMock = Mock<typeof fetch>;

function assertNoRealOpenAlexLeak(url: string | URL | Request): void {
  const href =
    typeof url === "string"
      ? url
      : url instanceof URL
        ? url.href
        : url.url;
  // Defensive: every stubbed call must target the fixed OpenAlex API host only.
  expect(new URL(href).hostname).toBe(OPENALEX_HOST);
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function stubFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): FetchMock {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    assertNoRealOpenAlexLeak(input);
    return impl(input, init);
  }) as FetchMock;
  vi.stubGlobal("fetch", mock);
  return mock;
}

function makeWork(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "https://openalex.org/W2741809807",
    title: "Example CRISPR Paper",
    display_name: "Example CRISPR Paper",
    authorships: [
      { author: { display_name: "Ada Lovelace" } },
      { author: { display_name: "Alan Turing" } },
    ],
    publication_year: 2020,
    doi: "https://doi.org/10.1234/crispr.example",
    cited_by_count: 42,
    primary_location: {
      landing_page_url: "https://journals.example/paper/1",
    },
    abstract_inverted_index: {
      Despite: [0],
      growing: [1],
      interest: [2],
    },
    ...overrides,
  };
}

async function expectActionFailure(
  run: Promise<unknown>,
  statusCode: number,
  message: string,
): Promise<void> {
  try {
    await run;
    expect.fail("Expected the action to fail, but it succeeded.");
  } catch (error) {
    expect(isActionContractError(error)).toBe(true);
    if (!isActionContractError(error)) return;
    expect(error.statusCode).toBe(statusCode);
    expect(error.message).toBe(message);
    expect(error.errorCode).toBe("action_failed");
  }
}

async function expectInputValidationFailure(
  run: Promise<unknown>,
): Promise<void> {
  try {
    await run;
    expect.fail("Expected input validation to fail, but the action ran.");
  } catch (error) {
    expect(error).toBeInstanceOf(ActionInputValidationError);
  }
}

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe("search-papers", () => {
  beforeEach(() => {
    // Hard fail if a test forgets to stub fetch before calling the action.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(
          "fetch was called without a test-specific mock; refusing real network access",
        );
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("A: successful search mapping", () => {
    it("maps two valid OpenAlex works into the public paper shape", async () => {
      const fetchMock = stubFetch(async () =>
        jsonResponse({
          results: [
            makeWork(),
            makeWork({
              id: "https://openalex.org/W1111111111",
              title: "Second Paper",
              authorships: [{ author: { display_name: "Grace Hopper" } }],
              publication_year: 2021,
              doi: "https://doi.org/10.5678/second",
              cited_by_count: 7,
              primary_location: {
                landing_page_url: "https://journals.example/paper/2",
              },
              abstract_inverted_index: { Hello: [0], world: [1] },
            }),
          ],
        }),
      );

      const result = await searchPapers.run(
        { query: QUERY, perPage: 10 },
        { caller: "cli" },
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const calledUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect(calledUrl.origin).toBe("https://api.openalex.org");
      expect(calledUrl.pathname).toBe("/works");
      expect(calledUrl.searchParams.get("search")).toBe(QUERY);
      expect(calledUrl.searchParams.get("per_page")).toBe("10");
      expect(calledUrl.searchParams.get("page")).toBe("1");

      expect(result.source).toBe("openalex");
      expect(result.query).toBe(QUERY);
      expect(result.meta.resultCount).toBe(2);
      expect(result.papers).toHaveLength(2);

      expect(result.papers[0]).toEqual({
        externalId: "W2741809807",
        title: "Example CRISPR Paper",
        authors: ["Ada Lovelace", "Alan Turing"],
        year: 2020,
        doi: "10.1234/crispr.example",
        abstract: "Despite growing interest",
        citationCount: 42,
        relevanceScore: null,
        url: "https://journals.example/paper/1",
        providerUrl: "https://openalex.org/W2741809807",
      });

      expect(result.papers[1]).toMatchObject({
        externalId: "W1111111111",
        title: "Second Paper",
        authors: ["Grace Hopper"],
        year: 2021,
        doi: "10.5678/second",
        abstract: "Hello world",
        citationCount: 7,
        url: "https://journals.example/paper/2",
        providerUrl: "https://openalex.org/W1111111111",
      });
    });
  });

  describe("B: abstract reconstruction", () => {
    it("reconstructs a contiguous inverted index", async () => {
      stubFetch(async () =>
        jsonResponse({
          results: [
            makeWork({
              abstract_inverted_index: {
                CRISPR: [0],
                is: [1],
                powerful: [2],
              },
            }),
          ],
        }),
      );

      const result = await searchPapers.run(
        { query: QUERY, perPage: 1 },
        { caller: "cli" },
      );
      expect(result.papers[0]?.abstract).toBe("CRISPR is powerful");
    });

    it("returns null abstract when positions have a gap", async () => {
      stubFetch(async () =>
        jsonResponse({
          results: [
            makeWork({
              abstract_inverted_index: {
                CRISPR: [0],
                powerful: [2],
              },
            }),
          ],
        }),
      );

      const result = await searchPapers.run(
        { query: QUERY, perPage: 1 },
        { caller: "cli" },
      );
      expect(result.papers[0]?.abstract).toBeNull();
    });

    it("returns null abstract when two words claim the same position", async () => {
      stubFetch(async () =>
        jsonResponse({
          results: [
            makeWork({
              abstract_inverted_index: {
                CRISPR: [0],
                gene: [0],
              },
            }),
          ],
        }),
      );

      const result = await searchPapers.run(
        { query: QUERY, perPage: 1 },
        { caller: "cli" },
      );
      expect(result.papers[0]?.abstract).toBeNull();
    });

    it("returns null abstract for illegal positions", async () => {
      stubFetch(async () =>
        jsonResponse({
          results: [
            makeWork({
              abstract_inverted_index: {
                CRISPR: [-1],
              },
            }),
          ],
        }),
      );

      const result = await searchPapers.run(
        { query: QUERY, perPage: 1 },
        { caller: "cli" },
      );
      expect(result.papers[0]?.abstract).toBeNull();
    });

    it("returns null abstract when the inverted index is missing", async () => {
      stubFetch(async () =>
        jsonResponse({
          results: [
            makeWork({
              abstract_inverted_index: null,
            }),
          ],
        }),
      );

      const result = await searchPapers.run(
        { query: QUERY, perPage: 1 },
        { caller: "cli" },
      );
      expect(result.papers[0]?.abstract).toBeNull();
    });
  });

  describe("C: empty results", () => {
    it("returns papers: [] and resultCount 0 when OpenAlex results are empty", async () => {
      stubFetch(async () => jsonResponse({ results: [] }));

      const result = await searchPapers.run(
        { query: QUERY, perPage: 10 },
        { caller: "cli" },
      );

      expect(result).toEqual({
        source: "openalex",
        query: QUERY,
        papers: [],
        meta: {
          page: 1,
          perPage: 10,
          resultCount: 0,
          reportedTotal: null,
          pageCount: null,
          hasMore: false,
        },
      });
    });
  });

  describe("D: malformed result entries", () => {
    it("skips null, string, array, and invalid-id objects without failing", async () => {
      stubFetch(async () =>
        jsonResponse({
          results: [
            null,
            "not-a-work",
            ["array"],
            { title: "Missing id" },
            { id: "https://evil.example/W1", title: "Bad host" },
            { id: "https://openalex.org/works/W1", title: "Bad path" },
            makeWork({
              id: "https://openalex.org/W9999999999",
              title: "Keep me",
            }),
          ],
        }),
      );

      const result = await searchPapers.run(
        { query: QUERY, perPage: 10 },
        { caller: "cli" },
      );

      expect(result.papers).toHaveLength(1);
      expect(result.papers[0]?.externalId).toBe("W9999999999");
      expect(result.papers[0]?.title).toBe("Keep me");
      expect(result.meta.resultCount).toBe(1);
    });
  });

  describe("E: input constraints (schema runs on .run)", () => {
    // Agent-Native wrapWithValidation validates args inside .run before the
    // handler; rejected inputs throw ActionInputValidationError (not fail()).

    it("rejects an empty query via Action input validation", async () => {
      await expectInputValidationFailure(
        searchPapers.run({ query: "", perPage: 10 } as never, { caller: "cli" }),
      );
    });

    it("rejects a whitespace-only query via Action input validation", async () => {
      await expectInputValidationFailure(
        searchPapers.run({ query: "   ", perPage: 10 } as never, {
          caller: "cli",
        }),
      );
    });

    it("rejects a query longer than 300 characters via Action input validation", async () => {
      await expectInputValidationFailure(
        searchPapers.run(
          { query: "q".repeat(301), perPage: 10 } as never,
          { caller: "cli" },
        ),
      );
    });

    it("rejects perPage 0 via Action input validation", async () => {
      await expectInputValidationFailure(
        searchPapers.run({ query: QUERY, perPage: 0 } as never, {
          caller: "cli",
        }),
      );
    });

    it("rejects perPage 26 via Action input validation", async () => {
      await expectInputValidationFailure(
        searchPapers.run({ query: QUERY, perPage: 26 } as never, {
          caller: "cli",
        }),
      );
    });

    it("rejects a non-integer perPage via Action input validation", async () => {
      await expectInputValidationFailure(
        searchPapers.run({ query: QUERY, perPage: 1.5 } as never, {
          caller: "cli",
        }),
      );
    });

    it("defaults page=1 and perPage=10 when omitted", async () => {
      const fetchMock = stubFetch(async () => jsonResponse({ results: [] }));

      await searchPapers.run({ query: QUERY }, { caller: "cli" });

      const calledUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect(calledUrl.searchParams.get("per_page")).toBe("10");
      expect(calledUrl.searchParams.get("page")).toBe("1");
    });

    it("forwards page to OpenAlex", async () => {
      const fetchMock = stubFetch(async () =>
        jsonResponse({
          results: [],
          meta: { count: 40, page: 3, per_page: 10 },
        }),
      );

      const result = await searchPapers.run(
        { query: QUERY, page: 3, perPage: 10 },
        { caller: "cli" },
      );

      const calledUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect(calledUrl.searchParams.get("page")).toBe("3");
      expect(result.meta.page).toBe(3);
      expect(result.meta.reportedTotal).toBe(40);
      expect(result.meta.pageCount).toBe(4);
      expect(result.meta.hasMore).toBe(true);
    });

    it("coerces string page/perPage like GET query params", async () => {
      const fetchMock = stubFetch(async () => jsonResponse({ results: [] }));

      const result = await searchPapers.run(
        { query: QUERY, page: "2", perPage: "10" } as never,
        { caller: "cli" },
      );

      const calledUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect(calledUrl.searchParams.get("page")).toBe("2");
      expect(calledUrl.searchParams.get("per_page")).toBe("10");
      expect(result.meta.page).toBe(2);
      expect(result.meta.perPage).toBe(10);
    });
  });

  describe("F: URL and DOI hardening", () => {
    it("nulls paper urls with userinfo or non-http(s) schemes", async () => {
      stubFetch(async () =>
        jsonResponse({
          results: [
            makeWork({
              id: "https://openalex.org/W2000000001",
              primary_location: {
                landing_page_url: "https://user:pass@journals.example/p",
              },
            }),
            makeWork({
              id: "https://openalex.org/W2000000002",
              primary_location: {
                landing_page_url: "ftp://files.example/paper.pdf",
              },
            }),
          ],
        }),
      );

      const result = await searchPapers.run(
        { query: QUERY, perPage: 10 },
        { caller: "cli" },
      );

      expect(result.papers).toHaveLength(2);
      expect(result.papers[0]?.url).toBeNull();
      expect(result.papers[1]?.url).toBeNull();
    });

    it("skips works whose OpenAlex id URL is illegal", async () => {
      stubFetch(async () =>
        jsonResponse({
          results: [
            makeWork({
              id: "https://user:secret@openalex.org/W1",
              title: "userinfo",
            }),
            makeWork({
              id: "https://openalex.org:8443/W1",
              title: "port",
            }),
            makeWork({
              id: "https://openalex.org/W1?x=1",
              title: "query",
            }),
            makeWork({
              id: "https://openalex.org/W3000000003",
              title: "valid",
            }),
          ],
        }),
      );

      const result = await searchPapers.run(
        { query: QUERY, perPage: 10 },
        { caller: "cli" },
      );

      expect(result.papers).toHaveLength(1);
      expect(result.papers[0]?.externalId).toBe("W3000000003");
    });

    it("rejects DOI urls with userinfo, query, or hash; normalizes a valid DOI", async () => {
      stubFetch(async () =>
        jsonResponse({
          results: [
            makeWork({
              id: "https://openalex.org/W4000000001",
              doi: "https://user:pass@doi.org/10.1234/bad-user",
            }),
            makeWork({
              id: "https://openalex.org/W4000000002",
              doi: "https://doi.org/10.1234/bad-query?x=1",
            }),
            makeWork({
              id: "https://openalex.org/W4000000003",
              doi: "https://doi.org/10.1234/bad-hash#frag",
            }),
            makeWork({
              id: "https://openalex.org/W4000000004",
              doi: "https://doi.org/10.1234/Good.DOI",
            }),
          ],
        }),
      );

      const result = await searchPapers.run(
        { query: QUERY, perPage: 10 },
        { caller: "cli" },
      );

      expect(result.papers.map((paper) => paper.doi)).toEqual([
        null,
        null,
        null,
        "10.1234/good.doi",
      ]);
    });
  });

  describe("G: HTTP and response errors", () => {
    it("maps OpenAlex 429 to fail status 429", async () => {
      stubFetch(async () => new Response("rate limited", { status: 429 }));
      await expectActionFailure(
        searchPapers.run({ query: QUERY, perPage: 1 }, { caller: "cli" }),
        429,
        "OpenAlex rate limit exceeded (429).",
      );
    });

    it("maps OpenAlex 500 to fail status 502", async () => {
      stubFetch(async () => new Response("upstream boom", { status: 500 }));
      await expectActionFailure(
        searchPapers.run({ query: QUERY, perPage: 1 }, { caller: "cli" }),
        502,
        "OpenAlex upstream error (500).",
      );
    });

    it("maps redirect 302 to fail status 502 without following it", async () => {
      stubFetch(async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://evil.example/steal" },
        }),
      );
      await expectActionFailure(
        searchPapers.run({ query: QUERY, perPage: 1 }, { caller: "cli" }),
        502,
        "OpenAlex returned an unexpected redirect.",
      );
    });

    it("maps invalid JSON to fail status 502", async () => {
      stubFetch(
        async () =>
          new Response("not-json{", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      await expectActionFailure(
        searchPapers.run({ query: QUERY, perPage: 1 }, { caller: "cli" }),
        502,
        "OpenAlex returned invalid JSON.",
      );
    });

    it("maps a non-array results field to fail status 502", async () => {
      stubFetch(async () => jsonResponse({ results: { nope: true } }));
      await expectActionFailure(
        searchPapers.run({ query: QUERY, perPage: 1 }, { caller: "cli" }),
        502,
        "OpenAlex response is missing a results array.",
      );
    });

    it("maps a network failure to fail status 502", async () => {
      stubFetch(async () => {
        throw new TypeError("fetch failed");
      });
      await expectActionFailure(
        searchPapers.run({ query: QUERY, perPage: 1 }, { caller: "cli" }),
        502,
        "OpenAlex network request failed.",
      );
    });
  });

  describe("H: timeout classification", () => {
    it("maps TimeoutError from fetch to fail status 504", async () => {
      stubFetch(async () => {
        throw namedError("TimeoutError", "The operation was aborted due to timeout");
      });
      await expectActionFailure(
        searchPapers.run({ query: QUERY, perPage: 1 }, { caller: "cli" }),
        504,
        "OpenAlex request timed out.",
      );
    });

    it("maps a plain AbortError from fetch to fail status 502 (not timeout)", async () => {
      stubFetch(async () => {
        throw namedError("AbortError", "The operation was aborted");
      });
      await expectActionFailure(
        searchPapers.run({ query: QUERY, perPage: 1 }, { caller: "cli" }),
        502,
        "OpenAlex network request failed.",
      );
    });

    it("maps TimeoutError from response.json() to fail status 504", async () => {
      stubFetch(async () => {
        return {
          status: 200,
          ok: true,
          async json() {
            throw namedError(
              "TimeoutError",
              "The operation was aborted due to timeout",
            );
          },
        } as unknown as Response;
      });
      await expectActionFailure(
        searchPapers.run({ query: QUERY, perPage: 1 }, { caller: "cli" }),
        504,
        "OpenAlex request timed out.",
      );
    });
  });

  describe("I: relevance order", () => {
    it("orders papers by relevanceScore descending", async () => {
      stubFetch(async () =>
        jsonResponse({
          results: [
            makeWork({
              id: "https://openalex.org/W5000000001",
              title: "Low",
              relevance_score: 12.5,
            }),
            makeWork({
              id: "https://openalex.org/W5000000002",
              title: "High",
              relevance_score: 40.2,
            }),
            makeWork({
              id: "https://openalex.org/W5000000003",
              title: "Mid",
              relevance_score: 22,
            }),
          ],
        }),
      );

      const result = await searchPapers.run(
        { query: QUERY, perPage: 10 },
        { caller: "cli" },
      );

      expect(result.papers.map((paper) => paper.externalId)).toEqual([
        "W5000000002",
        "W5000000003",
        "W5000000001",
      ]);
      expect(result.papers[0]?.relevanceScore).toBe(40.2);
    });
  });

  describe("J: result perPage", () => {
    it("returns at most `perPage` papers and keeps resultCount in sync", async () => {
      stubFetch(async () =>
        jsonResponse({
          results: [
            makeWork({ id: "https://openalex.org/W5000000001", title: "1" }),
            makeWork({ id: "https://openalex.org/W5000000002", title: "2" }),
            makeWork({ id: "https://openalex.org/W5000000003", title: "3" }),
            makeWork({ id: "https://openalex.org/W5000000004", title: "4" }),
          ],
        }),
      );

      const result = await searchPapers.run(
        { query: QUERY, perPage: 2 },
        { caller: "cli" },
      );

      expect(result.papers).toHaveLength(2);
      expect(result.meta.resultCount).toBe(2);
      expect(result.papers.map((paper) => paper.externalId)).toEqual([
        "W5000000001",
        "W5000000002",
      ]);
    });
  });
});

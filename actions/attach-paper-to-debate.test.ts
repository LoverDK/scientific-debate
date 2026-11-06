import {
  ActionInputValidationError,
  isActionContractError,
} from "@agent-native/core/action";
import {
  closeDbExec,
  getDatabaseUrl,
  getDbExec,
  runMigrations,
  withMigrationRuntime,
} from "@agent-native/core/db";
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import { getDb, schema } from "../server/db/index.js";
import {
  DEBATES_APP_MIGRATIONS_TABLE,
  debatesAppMigrations,
} from "../server/db/migrations.js";
import attachPaperToDebate from "./attach-paper-to-debate.js";

const OWNER_EMAIL = "owner@example.test";
const OTHER_EMAIL = "other@example.test";
const OPENALEX_HOST = "api.openalex.org";
const DEBATE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEBATE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MISSING_DEBATE = "00000000-0000-4000-8000-000000000000";
const WORK_ID = "W2741809807";
const WORK_ID_B = "W1111111111";

type FetchMock = Mock<typeof fetch>;

function assertMemoryDatabaseUrl(): void {
  if (process.env.DATABASE_URL !== "pglite:memory") {
    throw new Error(
      `Refusing to run attach-paper-to-debate tests: DATABASE_URL must be exactly "pglite:memory" (got ${JSON.stringify(process.env.DATABASE_URL)}). This suite must not touch ./data/pglite.`,
    );
  }
  const resolved = getDatabaseUrl();
  if (!resolved.toLowerCase().startsWith("pglite:memory")) {
    throw new Error(
      `Refusing to run attach-paper-to-debate tests: resolved database URL is not memory PGlite (got ${JSON.stringify(resolved)}).`,
    );
  }
}

assertMemoryDatabaseUrl();

function assertNoRealOpenAlexLeak(url: string | URL | Request): void {
  const href =
    typeof url === "string"
      ? url
      : url instanceof URL
        ? url.href
        : url.url;
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
  externalId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `https://openalex.org/${externalId}`,
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

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

async function applyAppMigrations(): Promise<void> {
  assertMemoryDatabaseUrl();
  await withMigrationRuntime(async () => {
    await runMigrations(debatesAppMigrations, {
      table: DEBATES_APP_MIGRATIONS_TABLE,
    })(undefined);
  });
}

async function clearAppTables(): Promise<void> {
  assertMemoryDatabaseUrl();
  const db = getDb();
  await db.delete(schema.debatePapers);
  await db.delete(schema.papers);
  await db.delete(schema.debates);
}

async function insertDebate(input: {
  id: string;
  ownerEmail: string;
  claim?: string;
}): Promise<void> {
  const now = "2026-01-01T00:00:00.000Z";
  await getDb().insert(schema.debates).values({
    id: input.id,
    claim: input.claim ?? "Owner claim",
    inputType: "text",
    status: "pending",
    createdAt: now,
    updatedAt: now,
    ownerEmail: input.ownerEmail,
    orgId: null,
    visibility: "private",
  });
}

async function countPapers(): Promise<number> {
  const { rows } = await getDbExec().execute(`SELECT COUNT(*)::int AS n FROM papers`);
  return Number(rows[0]?.n ?? 0);
}

async function countLinks(): Promise<number> {
  const { rows } = await getDbExec().execute(
    `SELECT COUNT(*)::int AS n FROM debate_papers`,
  );
  return Number(rows[0]?.n ?? 0);
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

function assertPublicAttachShape(result: Record<string, unknown>): void {
  expect(result).not.toHaveProperty("ownerEmail");
  expect(result).not.toHaveProperty("orgId");
  expect(result).not.toHaveProperty("visibility");
  expect(result).not.toHaveProperty("addedByEmail");
  const paper = result.paper as Record<string, unknown>;
  expect(paper).not.toHaveProperty("abstract");
  expect(paper).not.toHaveProperty("ownerEmail");
  expect(paper).not.toHaveProperty("authorsJson");
  const link = result.link as Record<string, unknown>;
  expect(link).not.toHaveProperty("addedByEmail");
  expect(link).not.toHaveProperty("debateId");
  expect(link).not.toHaveProperty("paperId");
}

describe("attach-paper-to-debate", () => {
  beforeAll(async () => {
    assertMemoryDatabaseUrl();
    await closeDbExec();
    await applyAppMigrations();
  });

  beforeEach(async () => {
    assertMemoryDatabaseUrl();
    await clearAppTables();
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

  afterAll(async () => {
    await closeDbExec();
  });

  describe("A: auth and input", () => {
    it("1. returns 401 when unsigned in and does not fetch or write", async () => {
      await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
      const fetchMock = stubFetch(async () => jsonResponse(makeWork(WORK_ID)));

      await expectActionFailure(
        attachPaperToDebate.run(
          { debateId: DEBATE_A, externalId: WORK_ID },
          { caller: "cli" },
        ),
        401,
        "Sign in to attach a paper to a debate.",
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(await countPapers()).toBe(0);
      expect(await countLinks()).toBe(0);
    });

    it("2. returns 404 for another user's debate without fetch or writes", async () => {
      await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
      const fetchMock = stubFetch(async () => jsonResponse(makeWork(WORK_ID)));

      await expectActionFailure(
        attachPaperToDebate.run(
          { debateId: DEBATE_A, externalId: WORK_ID },
          { caller: "cli", userEmail: OTHER_EMAIL },
        ),
        404,
        "Debate not found.",
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(await countPapers()).toBe(0);
      expect(await countLinks()).toBe(0);
    });

    it("3. returns 404 for a missing debate without writes", async () => {
      const fetchMock = stubFetch(async () => jsonResponse(makeWork(WORK_ID)));

      await expectActionFailure(
        attachPaperToDebate.run(
          { debateId: MISSING_DEBATE, externalId: WORK_ID },
          { caller: "cli", userEmail: OWNER_EMAIL },
        ),
        404,
        "Debate not found.",
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(await countPapers()).toBe(0);
      expect(await countLinks()).toBe(0);
    });

    it("4. rejects illegal externalId values via Action input validation", async () => {
      await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
      const fetchMock = stubFetch(async () => jsonResponse(makeWork(WORK_ID)));

      for (const externalId of [
        "",
        "   ",
        "https://openalex.org/W1",
        "ABC",
        "w123",
      ]) {
        await expectInputValidationFailure(
          attachPaperToDebate.run(
            { debateId: DEBATE_A, externalId } as never,
            { caller: "cli", userEmail: OWNER_EMAIL },
          ),
        );
      }

      expect(fetchMock).not.toHaveBeenCalled();
      expect(await countPapers()).toBe(0);
      expect(await countLinks()).toBe(0);
    });

    it("5. rejects illegal debateId via Action input validation", async () => {
      const fetchMock = stubFetch(async () => jsonResponse(makeWork(WORK_ID)));

      for (const debateId of ["", "   "]) {
        await expectInputValidationFailure(
          attachPaperToDebate.run(
            { debateId, externalId: WORK_ID } as never,
            { caller: "cli", userEmail: OWNER_EMAIL },
          ),
        );
      }

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("B: first attach", () => {
    it("6-9. cache miss creates paper+link, maps fields, stores authors, keeps nulls", async () => {
      await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
      const fetchMock = stubFetch(async (input, init) => {
        const url = new URL(String(input));
        expect(init?.method ?? "GET").toBe("GET");
        expect(url.origin).toBe("https://api.openalex.org");
        expect(url.pathname).toBe(`/works/${WORK_ID}`);
        return jsonResponse(
          makeWork(WORK_ID, {
            title: null,
            display_name: null,
            publication_year: null,
            doi: null,
            cited_by_count: null,
            primary_location: null,
            authorships: [
              { author: { display_name: "Ada Lovelace" } },
              { author: { display_name: "Alan Turing" } },
            ],
            abstract_inverted_index: {
              Hello: [0],
              world: [1],
            },
          }),
        );
      });

      const result = await attachPaperToDebate.run(
        { debateId: DEBATE_A, externalId: WORK_ID },
        { caller: "cli", userEmail: OWNER_EMAIL },
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await countPapers()).toBe(1);
      expect(await countLinks()).toBe(1);

      expect(result.success).toBe(true);
      expect(result.debateId).toBe(DEBATE_A);
      expect(result.paper).toMatchObject({
        source: "openalex",
        externalId: WORK_ID,
        providerUrl: `https://openalex.org/${WORK_ID}`,
        title: null,
        authors: ["Ada Lovelace", "Alan Turing"],
        year: null,
        doi: null,
        citationCount: null,
        url: null,
      });
      expect(result.link.created).toBe(true);
      expect(typeof result.paper.id).toBe("string");
      expect(typeof result.link.id).toBe("string");
      expect(typeof result.link.addedAt).toBe("string");
      assertPublicAttachShape(result as unknown as Record<string, unknown>);

      const { rows } = await getDbExec().execute({
        sql: `SELECT authors_json, abstract FROM papers WHERE external_id = ?`,
        args: [WORK_ID],
      });
      expect(rows[0]?.authors_json).toBe(
        JSON.stringify(["Ada Lovelace", "Alan Turing"]),
      );
      expect(rows[0]?.abstract).toBe("Hello world");
    });
  });

  describe("C: cache and idempotency", () => {
    it("10+13. cache hit skips fetch and does not refresh updatedAt", async () => {
      await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
      const fixedUpdatedAt = "2026-02-02T00:00:00.000Z";
      await getDb().insert(schema.papers).values({
        id: "paper-cached-1",
        source: "openalex",
        externalId: WORK_ID,
        providerUrl: `https://openalex.org/${WORK_ID}`,
        title: "Cached Title",
        authorsJson: JSON.stringify(["Cached Author"]),
        year: 2019,
        doi: "10.1/cached",
        abstract: "Cached abstract",
        citationCount: 9,
        url: "https://journals.example/cached",
        createdAt: fixedUpdatedAt,
        updatedAt: fixedUpdatedAt,
      });

      const fetchMock = stubFetch(async () => jsonResponse(makeWork(WORK_ID)));

      const result = await attachPaperToDebate.run(
        { debateId: DEBATE_A, externalId: WORK_ID },
        { caller: "cli", userEmail: OWNER_EMAIL },
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.paper.id).toBe("paper-cached-1");
      expect(result.paper.title).toBe("Cached Title");
      expect(result.link.created).toBe(true);
      expect(await countPapers()).toBe(1);

      const { rows } = await getDbExec().execute({
        sql: `SELECT updated_at, title FROM papers WHERE id = ?`,
        args: ["paper-cached-1"],
      });
      expect(rows[0]?.updated_at).toBe(fixedUpdatedAt);
      expect(rows[0]?.title).toBe("Cached Title");
    });

    it("11+26. repeat attach is idempotent with created=false", async () => {
      await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
      const fetchMock = stubFetch(async () => jsonResponse(makeWork(WORK_ID)));

      const first = await attachPaperToDebate.run(
        { debateId: DEBATE_A, externalId: WORK_ID },
        { caller: "cli", userEmail: OWNER_EMAIL },
      );
      expect(first.link.created).toBe(true);

      const second = await attachPaperToDebate.run(
        { debateId: DEBATE_A, externalId: WORK_ID },
        { caller: "cli", userEmail: OWNER_EMAIL },
      );

      expect(second.link.created).toBe(false);
      expect(second.link.id).toBe(first.link.id);
      expect(second.paper.id).toBe(first.paper.id);
      expect(await countPapers()).toBe(1);
      expect(await countLinks()).toBe(1);
      // Second call is cache hit — only the first miss fetched.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("12. one paper can link to two owned debates", async () => {
      await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
      await insertDebate({ id: DEBATE_B, ownerEmail: OWNER_EMAIL });
      stubFetch(async () => jsonResponse(makeWork(WORK_ID)));

      await attachPaperToDebate.run(
        { debateId: DEBATE_A, externalId: WORK_ID },
        { caller: "cli", userEmail: OWNER_EMAIL },
      );
      await attachPaperToDebate.run(
        { debateId: DEBATE_B, externalId: WORK_ID },
        { caller: "cli", userEmail: OWNER_EMAIL },
      );

      expect(await countPapers()).toBe(1);
      expect(await countLinks()).toBe(2);
    });
  });

  describe("D: OpenAlex errors", () => {
    async function expectNoWritesAfterFailure(
      run: Promise<unknown>,
      statusCode: number,
      message: string,
    ): Promise<void> {
      await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
      await expectActionFailure(run, statusCode, message);
      expect(await countPapers()).toBe(0);
      expect(await countLinks()).toBe(0);
    }

    it("14. maps OpenAlex 404 to Paper not found without writes", async () => {
      stubFetch(async () => new Response("missing", { status: 404 }));
      await expectNoWritesAfterFailure(
        attachPaperToDebate.run(
          { debateId: DEBATE_A, externalId: WORK_ID },
          { caller: "cli", userEmail: OWNER_EMAIL },
        ),
        404,
        "Paper not found.",
      );
    });

    it("15. maps OpenAlex 429 without writes", async () => {
      stubFetch(async () => new Response("limited", { status: 429 }));
      await expectNoWritesAfterFailure(
        attachPaperToDebate.run(
          { debateId: DEBATE_A, externalId: WORK_ID },
          { caller: "cli", userEmail: OWNER_EMAIL },
        ),
        429,
        "OpenAlex rate limit exceeded (429).",
      );
    });

    it("16. maps OpenAlex 500 to 502 without writes", async () => {
      stubFetch(async () => new Response("boom", { status: 500 }));
      await expectNoWritesAfterFailure(
        attachPaperToDebate.run(
          { debateId: DEBATE_A, externalId: WORK_ID },
          { caller: "cli", userEmail: OWNER_EMAIL },
        ),
        502,
        "OpenAlex upstream error (500).",
      );
    });

    it("17. maps redirect 302 to 502 without writes", async () => {
      stubFetch(
        async () =>
          new Response(null, {
            status: 302,
            headers: { Location: "https://evil.example/x" },
          }),
      );
      await expectNoWritesAfterFailure(
        attachPaperToDebate.run(
          { debateId: DEBATE_A, externalId: WORK_ID },
          { caller: "cli", userEmail: OWNER_EMAIL },
        ),
        502,
        "OpenAlex returned an unexpected redirect.",
      );
    });

    it("18. maps invalid JSON to 502 without writes", async () => {
      stubFetch(
        async () =>
          new Response("not-json{", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      await expectNoWritesAfterFailure(
        attachPaperToDebate.run(
          { debateId: DEBATE_A, externalId: WORK_ID },
          { caller: "cli", userEmail: OWNER_EMAIL },
        ),
        502,
        "OpenAlex returned invalid JSON.",
      );
    });

    it("19. maps network failure to 502 without writes", async () => {
      stubFetch(async () => {
        throw new TypeError("fetch failed");
      });
      await expectNoWritesAfterFailure(
        attachPaperToDebate.run(
          { debateId: DEBATE_A, externalId: WORK_ID },
          { caller: "cli", userEmail: OWNER_EMAIL },
        ),
        502,
        "OpenAlex network request failed.",
      );
    });

    it("20. maps TimeoutError to 504 without writes", async () => {
      stubFetch(async () => {
        throw namedError(
          "TimeoutError",
          "The operation was aborted due to timeout",
        );
      });
      await expectNoWritesAfterFailure(
        attachPaperToDebate.run(
          { debateId: DEBATE_A, externalId: WORK_ID },
          { caller: "cli", userEmail: OWNER_EMAIL },
        ),
        504,
        "OpenAlex request timed out.",
      );
    });

    it("21. maps work without valid OpenAlex ID to 502 without writes", async () => {
      stubFetch(async () =>
        jsonResponse(
          makeWork(WORK_ID, {
            id: "https://evil.example/W1",
          }),
        ),
      );
      await expectNoWritesAfterFailure(
        attachPaperToDebate.run(
          { debateId: DEBATE_A, externalId: WORK_ID },
          { caller: "cli", userEmail: OWNER_EMAIL },
        ),
        502,
        "OpenAlex returned an unusable work object.",
      );
    });

    it("22. maps mismatched work externalId to 502 without writes", async () => {
      stubFetch(async () => jsonResponse(makeWork(WORK_ID_B)));
      await expectNoWritesAfterFailure(
        attachPaperToDebate.run(
          { debateId: DEBATE_A, externalId: WORK_ID },
          { caller: "cli", userEmail: OWNER_EMAIL },
        ),
        502,
        "OpenAlex work ID did not match the requested externalId.",
      );
    });
  });

  describe("E: transaction consistency", () => {
    it("23. inner owner check 404 after debate deleted during fetch leaves no rows", async () => {
      await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
      stubFetch(async () => {
        // Debate disappears after outer auth, before the transaction begins.
        await getDb()
          .delete(schema.debates)
          .where(eq(schema.debates.id, DEBATE_A));
        return jsonResponse(makeWork(WORK_ID));
      });

      await expectActionFailure(
        attachPaperToDebate.run(
          { debateId: DEBATE_A, externalId: WORK_ID },
          { caller: "cli", userEmail: OWNER_EMAIL },
        ),
        404,
        "Debate not found.",
      );

      expect(await countPapers()).toBe(0);
      expect(await countLinks()).toBe(0);
    });

    it("24. debate_papers insert failure rolls back a newly inserted paper", async () => {
      await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });

      // DB-level fault injection: fail link inserts for this debate only.
      await getDbExec().execute(`
        CREATE OR REPLACE FUNCTION attach_test_fail_link_insert()
        RETURNS trigger AS $$
        BEGIN
          IF NEW.debate_id = '${DEBATE_A}' THEN
            RAISE EXCEPTION 'forced debate_papers insert failure for rollback test';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);
      await getDbExec().execute(`
        DROP TRIGGER IF EXISTS attach_test_fail_link_insert_trg ON debate_papers;
      `);
      await getDbExec().execute(`
        CREATE TRIGGER attach_test_fail_link_insert_trg
        BEFORE INSERT ON debate_papers
        FOR EACH ROW
        EXECUTE FUNCTION attach_test_fail_link_insert();
      `);

      stubFetch(async () => jsonResponse(makeWork(WORK_ID)));

      try {
        try {
          await attachPaperToDebate.run(
            { debateId: DEBATE_A, externalId: WORK_ID },
            { caller: "cli", userEmail: OWNER_EMAIL },
          );
          expect.fail("Expected attach to fail due to trigger, but it succeeded.");
        } catch (error) {
          // Failure may be ActionContractError or a raw DB error depending on
          // whether the framework wraps transaction failures.
          expect(error).toBeTruthy();
        }

        expect(await countPapers()).toBe(0);
        expect(await countLinks()).toBe(0);
      } finally {
        await getDbExec().execute(
          `DROP TRIGGER IF EXISTS attach_test_fail_link_insert_trg ON debate_papers`,
        );
        await getDbExec().execute(
          `DROP FUNCTION IF EXISTS attach_test_fail_link_insert()`,
        );
      }
    });

    it("25. concurrent-style paper insert during fetch reuses existing paper", async () => {
      await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
      const existingPaperId = "paper-preinserted-conflict";
      const fixedUpdatedAt = "2026-03-03T00:00:00.000Z";

      stubFetch(async () => {
        // Simulate another request winning the papers insert after cache miss.
        await getDb().insert(schema.papers).values({
          id: existingPaperId,
          source: "openalex",
          externalId: WORK_ID,
          providerUrl: `https://openalex.org/${WORK_ID}`,
          title: "Preinserted",
          authorsJson: "[]",
          year: 2018,
          doi: null,
          abstract: null,
          citationCount: null,
          url: null,
          createdAt: fixedUpdatedAt,
          updatedAt: fixedUpdatedAt,
        });
        return jsonResponse(makeWork(WORK_ID));
      });

      const result = await attachPaperToDebate.run(
        { debateId: DEBATE_A, externalId: WORK_ID },
        { caller: "cli", userEmail: OWNER_EMAIL },
      );

      expect(result.paper.id).toBe(existingPaperId);
      expect(result.paper.title).toBe("Preinserted");
      expect(await countPapers()).toBe(1);
      expect(await countLinks()).toBe(1);
      expect(result.link.created).toBe(true);
    });

    it("26-extra. link conflict during fetch yields created=false and keeps one link", async () => {
      await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
      const existingPaperId = "paper-for-link-conflict";
      const existingLinkId = "link-preinserted-conflict";

      stubFetch(async () => {
        await getDb().insert(schema.papers).values({
          id: existingPaperId,
          source: "openalex",
          externalId: WORK_ID,
          providerUrl: `https://openalex.org/${WORK_ID}`,
          title: "Linked already",
          authorsJson: "[]",
          year: null,
          doi: null,
          abstract: null,
          citationCount: null,
          url: null,
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
        });
        await getDb().insert(schema.debatePapers).values({
          id: existingLinkId,
          debateId: DEBATE_A,
          paperId: existingPaperId,
          addedAt: "2026-04-01T00:00:00.000Z",
          addedByEmail: OWNER_EMAIL,
        });
        return jsonResponse(makeWork(WORK_ID));
      });

      const result = await attachPaperToDebate.run(
        { debateId: DEBATE_A, externalId: WORK_ID },
        { caller: "cli", userEmail: OWNER_EMAIL },
      );

      expect(result.link.created).toBe(false);
      expect(result.link.id).toBe(existingLinkId);
      expect(result.paper.id).toBe(existingPaperId);
      expect(await countPapers()).toBe(1);
      expect(await countLinks()).toBe(1);
    });

    it("27. concurrent attaches converge to one paper and one link", async () => {
      await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
      stubFetch(async () => jsonResponse(makeWork(WORK_ID)));

      const [first, second] = await Promise.all([
        attachPaperToDebate.run(
          { debateId: DEBATE_A, externalId: WORK_ID },
          { caller: "cli", userEmail: OWNER_EMAIL },
        ),
        attachPaperToDebate.run(
          { debateId: DEBATE_A, externalId: WORK_ID },
          { caller: "cli", userEmail: OWNER_EMAIL },
        ),
      ]);

      expect(first.paper.id).toBe(second.paper.id);
      expect(first.link.id).toBe(second.link.id);
      expect([first.link.created, second.link.created].filter(Boolean).length).toBeLessThanOrEqual(
        1,
      );
      expect(await countPapers()).toBe(1);
      expect(await countLinks()).toBe(1);
    });
  });
});

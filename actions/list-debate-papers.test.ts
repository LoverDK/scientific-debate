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
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { getDb, schema } from "../server/db/index.js";
import {
  DEBATES_APP_MIGRATIONS_TABLE,
  debatesAppMigrations,
} from "../server/db/migrations.js";
import listDebatePapers from "./list-debate-papers.js";

const OWNER_EMAIL = "owner@example.test";
const OTHER_EMAIL = "other@example.test";
const DEBATE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEBATE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MISSING_DEBATE = "00000000-0000-4000-8000-000000000000";
const PAPER_A = "paper-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PAPER_B = "paper-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PAPER_C = "paper-cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LINK_EARLY = "link-11111111-1111-4111-8111-111111111111";
const LINK_MID_A = "link-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LINK_MID_B = "link-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LINK_LATE = "link-zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz";
const ADDED_EARLY = "2026-01-01T00:00:00.000Z";
const ADDED_SAME = "2026-01-02T00:00:00.000Z";
const ADDED_LATE = "2026-01-03T00:00:00.000Z";
const FIXED_NOW = "2026-01-01T00:00:00.000Z";

function assertMemoryDatabaseUrl(): void {
  if (process.env.DATABASE_URL !== "pglite:memory") {
    throw new Error(
      `Refusing to run list-debate-papers tests: DATABASE_URL must be exactly "pglite:memory" (got ${JSON.stringify(process.env.DATABASE_URL)}). This suite must not touch ./data/pglite.`,
    );
  }
  const resolved = getDatabaseUrl();
  if (!resolved.toLowerCase().startsWith("pglite:memory")) {
    throw new Error(
      `Refusing to run list-debate-papers tests: resolved database URL is not memory PGlite (got ${JSON.stringify(resolved)}).`,
    );
  }
}

assertMemoryDatabaseUrl();

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
  await getDb().insert(schema.debates).values({
    id: input.id,
    claim: input.claim ?? "Owner claim",
    inputType: "text",
    status: "pending",
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ownerEmail: input.ownerEmail,
    orgId: null,
    visibility: "private",
  });
}

async function insertPaper(input: {
  id: string;
  externalId: string;
  title?: string | null;
  authorsJson?: string;
  year?: number | null;
  doi?: string | null;
  abstract?: string | null;
  citationCount?: number | null;
  url?: string | null;
  createdAt?: string;
  updatedAt?: string;
}): Promise<void> {
  await getDb().insert(schema.papers).values({
    id: input.id,
    source: "openalex",
    externalId: input.externalId,
    providerUrl: `https://openalex.org/${input.externalId}`,
    title: input.title === undefined ? `Title ${input.externalId}` : input.title,
    authorsJson: input.authorsJson ?? JSON.stringify(["Ada Lovelace"]),
    year: input.year === undefined ? 2020 : input.year,
    doi: input.doi === undefined ? "10.1234/example" : input.doi,
    abstract: input.abstract === undefined ? "Secret abstract" : input.abstract,
    citationCount: input.citationCount === undefined ? 7 : input.citationCount,
    url:
      input.url === undefined ? "https://journals.example/paper" : input.url,
    createdAt: input.createdAt ?? FIXED_NOW,
    updatedAt: input.updatedAt ?? FIXED_NOW,
  });
}

async function insertLink(input: {
  id: string;
  debateId: string;
  paperId: string;
  addedAt: string;
  addedByEmail?: string;
}): Promise<void> {
  await getDb().insert(schema.debatePapers).values({
    id: input.id,
    debateId: input.debateId,
    paperId: input.paperId,
    addedAt: input.addedAt,
    addedByEmail: input.addedByEmail ?? OWNER_EMAIL,
  });
}

async function countTable(table: "debates" | "papers" | "debate_papers"): Promise<number> {
  const { rows } = await getDbExec().execute(
    `SELECT COUNT(*)::int AS n FROM ${table}`,
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

function assertPublicListShape(result: {
  debateId: string;
  papers: Array<Record<string, unknown>>;
  meta: Record<string, unknown>;
}): void {
  expect(result).not.toHaveProperty("ownerEmail");
  expect(result).not.toHaveProperty("orgId");
  expect(result).not.toHaveProperty("visibility");
  expect(result).not.toHaveProperty("addedByEmail");
  expect(Object.keys(result).sort()).toEqual([
    "byStance",
    "debateId",
    "meta",
    "papers",
  ]);
  expect(Object.keys(result.meta).sort()).toEqual(["resultCount", "truncated"]);

  for (const paper of result.papers) {
    expect(paper).not.toHaveProperty("abstract");
    expect(paper).not.toHaveProperty("authorsJson");
    expect(paper).not.toHaveProperty("createdAt");
    expect(paper).not.toHaveProperty("updatedAt");
    expect(paper).not.toHaveProperty("ownerEmail");
    expect(paper).not.toHaveProperty("addedByEmail");
    expect(paper).not.toHaveProperty("orgId");
    expect(paper).not.toHaveProperty("visibility");
    expect(Object.keys(paper).sort()).toEqual([
      "authors",
      "citationCount",
      "doi",
      "externalId",
      "id",
      "link",
      "providerUrl",
      "source",
      "stance",
      "stanceRationale",
      "title",
      "url",
      "year",
    ]);
    const link = paper.link as Record<string, unknown>;
    expect(link).not.toHaveProperty("addedByEmail");
    expect(link).not.toHaveProperty("debateId");
    expect(link).not.toHaveProperty("paperId");
    expect(Object.keys(link).sort()).toEqual(["addedAt", "id"]);
    expect(Array.isArray(paper.authors)).toBe(true);
    for (const author of paper.authors as unknown[]) {
      expect(typeof author).toBe("string");
    }
  }
}

describe("list-debate-papers", () => {
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

  it("1. returns 401 when unsigned in and does not leak papers", async () => {
    await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
    await insertPaper({ id: PAPER_A, externalId: "W100" });
    await insertLink({
      id: LINK_EARLY,
      debateId: DEBATE_A,
      paperId: PAPER_A,
      addedAt: ADDED_EARLY,
    });

    await expectActionFailure(
      listDebatePapers.run({ debateId: DEBATE_A }, { caller: "cli" }),
      401,
      "Sign in to list debate papers.",
    );
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("2. returns 404 for a missing debate", async () => {
    await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });

    await expectActionFailure(
      listDebatePapers.run(
        { debateId: MISSING_DEBATE },
        { caller: "cli", userEmail: OWNER_EMAIL },
      ),
      404,
      "Debate not found.",
    );
  });

  it("3. returns 404 for another user's debate without leaking papers", async () => {
    await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
    await insertPaper({ id: PAPER_A, externalId: "W100", title: "Secret" });
    await insertLink({
      id: LINK_EARLY,
      debateId: DEBATE_A,
      paperId: PAPER_A,
      addedAt: ADDED_EARLY,
    });

    await expectActionFailure(
      listDebatePapers.run(
        { debateId: DEBATE_A },
        { caller: "cli", userEmail: OTHER_EMAIL },
      ),
      404,
      "Debate not found.",
    );
  });

  it("4. owner with no links returns empty papers and truncated=false", async () => {
    await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });

    const result = await listDebatePapers.run(
      { debateId: DEBATE_A },
      { caller: "cli", userEmail: OWNER_EMAIL },
    );

    expect(result).toEqual({
      debateId: DEBATE_A,
      papers: [],
      byStance: { supports: [], opposes: [], uncertain: [] },
      meta: { resultCount: 0, truncated: false },
    });
    assertPublicListShape(result);
  });

  it("5. owner with one paper returns public fields and nested link", async () => {
    await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
    await insertPaper({
      id: PAPER_A,
      externalId: "W4387322659",
      title: "Reasoning on Graphs",
      authorsJson: JSON.stringify(["Linhao Luo", "Yuan-Fang Li"]),
      year: 2023,
      doi: "10.48550/arxiv.2310.01061",
      abstract: "Must not appear in response",
      citationCount: 56,
      url: "http://arxiv.org/abs/2310.01061",
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-02T00:00:00.000Z",
    });
    await insertLink({
      id: LINK_LATE,
      debateId: DEBATE_A,
      paperId: PAPER_A,
      addedAt: ADDED_LATE,
      addedByEmail: OWNER_EMAIL,
    });

    const result = await listDebatePapers.run(
      { debateId: DEBATE_A },
      { caller: "cli", userEmail: OWNER_EMAIL },
    );

    expect(result.debateId).toBe(DEBATE_A);
    expect(result.meta).toEqual({ resultCount: 1, truncated: false });
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0]).toEqual({
      id: PAPER_A,
      source: "openalex",
      externalId: "W4387322659",
      providerUrl: "https://openalex.org/W4387322659",
      title: "Reasoning on Graphs",
      authors: ["Linhao Luo", "Yuan-Fang Li"],
      year: 2023,
      doi: "10.48550/arxiv.2310.01061",
      citationCount: 56,
      url: "http://arxiv.org/abs/2310.01061",
      stance: null,
      stanceRationale: null,
      link: {
        id: LINK_LATE,
        addedAt: ADDED_LATE,
      },
    });
    assertPublicListShape(result);
  });

  it("6. sorts by addedAt DESC then link.id ASC for ties", async () => {
    await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
    const PAPER_D = "paper-dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await insertPaper({ id: PAPER_A, externalId: "W1" });
    await insertPaper({ id: PAPER_B, externalId: "W2" });
    await insertPaper({ id: PAPER_C, externalId: "W3" });
    await insertPaper({ id: PAPER_D, externalId: "W4", title: "Late paper" });

    // Insert out of order; same timestamp: LINK_MID_A < LINK_MID_B lexicographically.
    await insertLink({
      id: LINK_MID_B,
      debateId: DEBATE_A,
      paperId: PAPER_B,
      addedAt: ADDED_SAME,
    });
    await insertLink({
      id: LINK_EARLY,
      debateId: DEBATE_A,
      paperId: PAPER_C,
      addedAt: ADDED_EARLY,
    });
    await insertLink({
      id: LINK_LATE,
      debateId: DEBATE_A,
      paperId: PAPER_D,
      addedAt: ADDED_LATE,
    });
    await insertLink({
      id: LINK_MID_A,
      debateId: DEBATE_A,
      paperId: PAPER_A,
      addedAt: ADDED_SAME,
    });

    const result = await listDebatePapers.run(
      { debateId: DEBATE_A },
      { caller: "cli", userEmail: OWNER_EMAIL },
    );

    expect(result.papers.map((paper) => paper.link.id)).toEqual([
      LINK_LATE,
      LINK_MID_A,
      LINK_MID_B,
      LINK_EARLY,
    ]);
    expect(result.papers.map((paper) => paper.link.addedAt)).toEqual([
      ADDED_LATE,
      ADDED_SAME,
      ADDED_SAME,
      ADDED_EARLY,
    ]);
  });

  it("7. isolates papers across owners", async () => {
    await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
    await insertDebate({ id: DEBATE_B, ownerEmail: OTHER_EMAIL });
    await insertPaper({ id: PAPER_A, externalId: "W100", title: "Owner paper" });
    await insertPaper({ id: PAPER_B, externalId: "W200", title: "Other paper" });
    await insertLink({
      id: LINK_EARLY,
      debateId: DEBATE_A,
      paperId: PAPER_A,
      addedAt: ADDED_EARLY,
      addedByEmail: OWNER_EMAIL,
    });
    await insertLink({
      id: LINK_LATE,
      debateId: DEBATE_B,
      paperId: PAPER_B,
      addedAt: ADDED_LATE,
      addedByEmail: OTHER_EMAIL,
    });

    const ownerList = await listDebatePapers.run(
      { debateId: DEBATE_A },
      { caller: "cli", userEmail: OWNER_EMAIL },
    );
    expect(ownerList.papers).toHaveLength(1);
    expect(ownerList.papers[0]?.id).toBe(PAPER_A);
    expect(ownerList.papers.map((p) => p.id)).not.toContain(PAPER_B);

    await expectActionFailure(
      listDebatePapers.run(
        { debateId: DEBATE_A },
        { caller: "cli", userEmail: OTHER_EMAIL },
      ),
      404,
      "Debate not found.",
    );
  });

  it("8. omits forbidden fields from the public response", async () => {
    await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
    await insertPaper({
      id: PAPER_A,
      externalId: "W100",
      abstract: "hidden",
      authorsJson: JSON.stringify(["Only Author"]),
    });
    await insertLink({
      id: LINK_EARLY,
      debateId: DEBATE_A,
      paperId: PAPER_A,
      addedAt: ADDED_EARLY,
      addedByEmail: "should-not-leak@example.test",
    });

    const result = await listDebatePapers.run(
      { debateId: DEBATE_A },
      { caller: "cli", userEmail: OWNER_EMAIL },
    );

    assertPublicListShape(result);
    expect(JSON.stringify(result)).not.toContain("hidden");
    expect(JSON.stringify(result)).not.toContain("authorsJson");
    expect(JSON.stringify(result)).not.toContain("should-not-leak@example.test");
    expect(JSON.stringify(result)).not.toContain(OWNER_EMAIL);
  });

  it("9. is read-only: row counts and key fields stay unchanged", async () => {
    await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
    await insertPaper({
      id: PAPER_A,
      externalId: "W100",
      title: "Immutable",
      abstract: "abs",
      updatedAt: "2026-03-03T00:00:00.000Z",
    });
    await insertLink({
      id: LINK_EARLY,
      debateId: DEBATE_A,
      paperId: PAPER_A,
      addedAt: ADDED_EARLY,
      addedByEmail: OWNER_EMAIL,
    });

    const before = {
      debates: await countTable("debates"),
      papers: await countTable("papers"),
      links: await countTable("debate_papers"),
    };
    const paperBefore = await getDbExec().execute({
      sql: `SELECT id, title, abstract, updated_at, authors_json FROM papers WHERE id = ?`,
      args: [PAPER_A],
    });
    const linkBefore = await getDbExec().execute({
      sql: `SELECT id, debate_id, paper_id, added_at, added_by_email FROM debate_papers WHERE id = ?`,
      args: [LINK_EARLY],
    });

    await listDebatePapers.run(
      { debateId: DEBATE_A },
      { caller: "cli", userEmail: OWNER_EMAIL },
    );

    expect(await countTable("debates")).toBe(before.debates);
    expect(await countTable("papers")).toBe(before.papers);
    expect(await countTable("debate_papers")).toBe(before.links);

    const paperAfter = await getDbExec().execute({
      sql: `SELECT id, title, abstract, updated_at, authors_json FROM papers WHERE id = ?`,
      args: [PAPER_A],
    });
    const linkAfter = await getDbExec().execute({
      sql: `SELECT id, debate_id, paper_id, added_at, added_by_email FROM debate_papers WHERE id = ?`,
      args: [LINK_EARLY],
    });
    expect(paperAfter.rows).toEqual(paperBefore.rows);
    expect(linkAfter.rows).toEqual(linkBefore.rows);
  });

  it("10. truncates at 50 when 51 links exist", async () => {
    await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });

    for (let i = 0; i < 51; i++) {
      const n = String(i).padStart(2, "0");
      const paperId = `paper-trunc-${n}`;
      const externalId = `W9000${n}`;
      await insertPaper({
        id: paperId,
        externalId,
        title: `Trunc ${n}`,
        authorsJson: "[]",
        abstract: null,
      });
      await insertLink({
        id: `link-trunc-${n}`,
        debateId: DEBATE_A,
        paperId,
        // Newer first: higher i → later timestamp.
        addedAt: `2026-04-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      });
    }

    const result = await listDebatePapers.run(
      { debateId: DEBATE_A },
      { caller: "cli", userEmail: OWNER_EMAIL },
    );

    expect(result.papers).toHaveLength(50);
    expect(result.meta).toEqual({ resultCount: 50, truncated: true });
    expect(await countTable("debate_papers")).toBe(51);
  });

  it("11. returns truncated=false for exactly 50 links", async () => {
    await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });

    for (let i = 0; i < 50; i++) {
      const n = String(i).padStart(2, "0");
      const paperId = `paper-exact-${n}`;
      await insertPaper({
        id: paperId,
        externalId: `W8000${n}`,
        title: `Exact ${n}`,
        authorsJson: "[]",
        abstract: null,
      });
      await insertLink({
        id: `link-exact-${n}`,
        debateId: DEBATE_A,
        paperId,
        addedAt: `2026-05-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      });
    }

    const result = await listDebatePapers.run(
      { debateId: DEBATE_A },
      { caller: "cli", userEmail: OWNER_EMAIL },
    );

    expect(result.papers).toHaveLength(50);
    expect(result.meta).toEqual({ resultCount: 50, truncated: false });
  });

  it("12. safely parses invalid / non-array / mixed authorsJson", async () => {
    await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });

    await insertPaper({
      id: "paper-invalid-json",
      externalId: "W701",
      authorsJson: "{not-json",
    });
    await insertPaper({
      id: "paper-non-array",
      externalId: "W702",
      authorsJson: JSON.stringify({ name: "Nope" }),
    });
    await insertPaper({
      id: "paper-mixed",
      externalId: "W703",
      authorsJson: JSON.stringify(["Ok", 1, null, { x: 1 }, "Also"]),
    });

    await insertLink({
      id: "link-invalid-json",
      debateId: DEBATE_A,
      paperId: "paper-invalid-json",
      addedAt: "2026-06-03T00:00:00.000Z",
    });
    await insertLink({
      id: "link-non-array",
      debateId: DEBATE_A,
      paperId: "paper-non-array",
      addedAt: "2026-06-02T00:00:00.000Z",
    });
    await insertLink({
      id: "link-mixed",
      debateId: DEBATE_A,
      paperId: "paper-mixed",
      addedAt: "2026-06-01T00:00:00.000Z",
    });

    const result = await listDebatePapers.run(
      { debateId: DEBATE_A },
      { caller: "cli", userEmail: OWNER_EMAIL },
    );

    expect(result.papers).toHaveLength(3);
    expect(result.papers[0]?.authors).toEqual([]);
    expect(result.papers[1]?.authors).toEqual([]);
    expect(result.papers[2]?.authors).toEqual(["Ok", "Also"]);
    expect(JSON.stringify(result)).not.toContain("{not-json");
    expect(JSON.stringify(result)).not.toContain('"name":"Nope"');
    assertPublicListShape(result);
  });

  it("13. rejects empty/whitespace debateId and accepts a normal id", async () => {
    await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });

    await expectInputValidationFailure(
      listDebatePapers.run(
        { debateId: "" },
        { caller: "cli", userEmail: OWNER_EMAIL },
      ),
    );
    await expectInputValidationFailure(
      listDebatePapers.run(
        { debateId: "   " },
        { caller: "cli", userEmail: OWNER_EMAIL },
      ),
    );

    const result = await listDebatePapers.run(
      { debateId: DEBATE_A },
      { caller: "cli", userEmail: OWNER_EMAIL },
    );
    expect(result.debateId).toBe(DEBATE_A);
    expect(result.papers).toEqual([]);
  });

  it("14. never calls fetch / OpenAlex", async () => {
    await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
    await insertPaper({ id: PAPER_A, externalId: "W100" });
    await insertLink({
      id: LINK_EARLY,
      debateId: DEBATE_A,
      paperId: PAPER_A,
      addedAt: ADDED_EARLY,
    });

    await listDebatePapers.run(
      { debateId: DEBATE_A },
      { caller: "cli", userEmail: OWNER_EMAIL },
    );
    await expectActionFailure(
      listDebatePapers.run(
        { debateId: DEBATE_A },
        { caller: "cli", userEmail: OTHER_EMAIL },
      ),
      404,
      "Debate not found.",
    );

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

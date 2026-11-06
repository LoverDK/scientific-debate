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

import { getDb, schema } from "../db/index.js";
import {
  DEBATES_APP_MIGRATIONS_TABLE,
  debatesAppMigrations,
} from "../db/migrations.js";
import {
  DebateEvidenceInvalidCitationError,
  DebateEvidenceInvalidPaperError,
  DebateEvidenceNoPapersError,
  DebateEvidenceNotFoundError,
  EVIDENCE_PACK_ABSTRACT_MAX_CHARS,
  EVIDENCE_PACK_MAX_PAPERS,
  buildDebateEvidencePack,
  validateCitedExternalIds,
  type EvidencePack,
} from "./debate-evidence.js";

const OWNER_EMAIL = "owner@example.test";
const OTHER_EMAIL = "other@example.test";
const DEBATE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEBATE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MISSING_DEBATE = "00000000-0000-4000-8000-000000000000";
const FIXED_NOW = "2026-01-01T00:00:00.000Z";
const ADDED_EARLY = "2026-01-01T00:00:00.000Z";
const ADDED_SAME = "2026-01-02T00:00:00.000Z";
const ADDED_LATE = "2026-01-03T00:00:00.000Z";

const PAPER_KEYS = [
  "abstract",
  "abstractTruncated",
  "authors",
  "doi",
  "externalId",
  "id",
  "providerUrl",
  "stance",
  "title",
  "url",
  "year",
] as const;

function assertMemoryDatabaseUrl(): void {
  if (process.env.DATABASE_URL !== "pglite:memory") {
    throw new Error(
      `Refusing to run debate-evidence tests: DATABASE_URL must be exactly "pglite:memory" (got ${JSON.stringify(process.env.DATABASE_URL)}). This suite must not touch ./data/pglite.`,
    );
  }
  const resolved = getDatabaseUrl();
  if (!resolved.toLowerCase().startsWith("pglite:memory")) {
    throw new Error(
      `Refusing to run debate-evidence tests: resolved database URL is not memory PGlite (got ${JSON.stringify(resolved)}).`,
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
  orgId?: string | null;
  visibility?: "private" | "org";
}): Promise<void> {
  await getDb().insert(schema.debates).values({
    id: input.id,
    claim: input.claim ?? "Owner claim",
    inputType: "text",
    status: "pending",
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ownerEmail: input.ownerEmail,
    orgId: input.orgId === undefined ? null : input.orgId,
    visibility: input.visibility ?? "private",
  });
}

async function insertPaper(input: {
  id: string;
  externalId: string;
  source?: string;
  providerUrl?: string;
  title?: string | null;
  authorsJson?: string;
  year?: number | null;
  doi?: string | null;
  abstract?: string | null;
  url?: string | null;
}): Promise<void> {
  const externalId = input.externalId;
  await getDb().insert(schema.papers).values({
    id: input.id,
    source: input.source ?? "openalex",
    externalId,
    providerUrl:
      input.providerUrl === undefined
        ? `https://openalex.org/${externalId}`
        : input.providerUrl,
    title: input.title === undefined ? `Title ${externalId}` : input.title,
    authorsJson: input.authorsJson ?? JSON.stringify(["Ada Lovelace"]),
    year: input.year === undefined ? 2020 : input.year,
    doi: input.doi === undefined ? "10.1234/example" : input.doi,
    abstract: input.abstract === undefined ? "Plain abstract" : input.abstract,
    citationCount: 7,
    url:
      input.url === undefined ? "https://journals.example/paper" : input.url,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
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

async function countTable(
  table: "debates" | "papers" | "debate_papers",
): Promise<number> {
  const { rows } = await getDbExec().execute(
    `SELECT COUNT(*)::int AS n FROM ${table}`,
  );
  return Number(rows[0]?.n ?? 0);
}

async function snapshotDebateRow(id: string): Promise<unknown> {
  const { rows } = await getDbExec().execute({
    sql: `SELECT id, claim, input_type, status, created_at, updated_at, owner_email, org_id, visibility
          FROM debates WHERE id = ?`,
    args: [id],
  });
  return rows[0] ?? null;
}

async function snapshotPaperRow(id: string): Promise<unknown> {
  const { rows } = await getDbExec().execute({
    sql: `SELECT id, source, external_id, provider_url, title, authors_json, year, doi, abstract, citation_count, url, created_at, updated_at
          FROM papers WHERE id = ?`,
    args: [id],
  });
  return rows[0] ?? null;
}

async function snapshotLinkRow(id: string): Promise<unknown> {
  const { rows } = await getDbExec().execute({
    sql: `SELECT id, debate_id, paper_id, added_at, added_by_email
          FROM debate_papers WHERE id = ?`,
    args: [id],
  });
  return rows[0] ?? null;
}

function assertPackShape(pack: EvidencePack): void {
  expect(Object.keys(pack).sort()).toEqual(["claim", "debateId", "papers"]);
  expect(pack).not.toHaveProperty("ownerEmail");
  expect(pack).not.toHaveProperty("orgId");
  expect(pack).not.toHaveProperty("visibility");
  expect(pack).not.toHaveProperty("addedByEmail");
  expect(pack).not.toHaveProperty("createdAt");
  expect(pack).not.toHaveProperty("updatedAt");

  for (const paper of pack.papers) {
    expect(Object.keys(paper).sort()).toEqual([...PAPER_KEYS]);
    expect(paper).not.toHaveProperty("authorsJson");
    expect(paper).not.toHaveProperty("addedByEmail");
    expect(paper).not.toHaveProperty("ownerEmail");
    expect(paper).not.toHaveProperty("orgId");
    expect(paper).not.toHaveProperty("visibility");
    expect(paper).not.toHaveProperty("createdAt");
    expect(paper).not.toHaveProperty("updatedAt");
    expect(paper).not.toHaveProperty("addedAt");
    expect(paper).not.toHaveProperty("source");
    expect(paper).not.toHaveProperty("citationCount");
    expect(Array.isArray(paper.authors)).toBe(true);
    for (const author of paper.authors) {
      expect(typeof author).toBe("string");
    }
  }
}

async function expectEvidenceError(
  run: Promise<unknown>,
  ErrorClass: new (...args: never[]) => Error,
  statusCode: number,
  code: string,
): Promise<Error> {
  try {
    await run;
    expect.fail("Expected buildDebateEvidencePack to throw, but it succeeded.");
  } catch (error) {
    expect(error).toBeInstanceOf(ErrorClass);
    expect(error).toMatchObject({ statusCode, code });
    return error as Error;
  }
  throw new Error("unreachable");
}

describe("debate-evidence", () => {
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

  it("1. missing debate → DebateEvidenceNotFoundError / 404", async () => {
    await expectEvidenceError(
      buildDebateEvidencePack(getDb(), MISSING_DEBATE, OWNER_EMAIL),
      DebateEvidenceNotFoundError,
      404,
      "debate_evidence_not_found",
    );
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("2. non-owner → same 404 as missing (no existence leak)", async () => {
    await insertDebate({
      id: DEBATE_A,
      ownerEmail: OWNER_EMAIL,
      claim: "Secret claim",
    });
    await insertPaper({ id: "paper-secret", externalId: "WSECRET" });
    await insertLink({
      id: "link-secret",
      debateId: DEBATE_A,
      paperId: "paper-secret",
      addedAt: ADDED_EARLY,
    });

    const missing = await expectEvidenceError(
      buildDebateEvidencePack(getDb(), MISSING_DEBATE, OWNER_EMAIL),
      DebateEvidenceNotFoundError,
      404,
      "debate_evidence_not_found",
    );
    const nonOwner = await expectEvidenceError(
      buildDebateEvidencePack(getDb(), DEBATE_A, OTHER_EMAIL),
      DebateEvidenceNotFoundError,
      404,
      "debate_evidence_not_found",
    );
    expect(nonOwner.message).toBe(missing.message);
    expect(nonOwner.message).toBe("Debate not found.");
  });

  it("3. owner with no papers → DebateEvidenceNoPapersError / 400", async () => {
    await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
    await expectEvidenceError(
      buildDebateEvidencePack(getDb(), DEBATE_A, OWNER_EMAIL),
      DebateEvidenceNoPapersError,
      400,
      "debate_evidence_no_papers",
    );
  });

  it("4. single valid paper → EvidencePack shape and values", async () => {
    await insertDebate({
      id: DEBATE_A,
      ownerEmail: OWNER_EMAIL,
      claim: "Scaling improves reasoning.",
    });
    await insertPaper({
      id: "paper-one",
      externalId: "W100",
      title: "Paper One",
      authorsJson: JSON.stringify(["Ada Lovelace", "Grace Hopper"]),
      year: 2021,
      doi: "10.1234/one",
      url: "https://journals.example/one",
      abstract: "Short abstract",
    });
    await insertLink({
      id: "link-one",
      debateId: DEBATE_A,
      paperId: "paper-one",
      addedAt: ADDED_EARLY,
      addedByEmail: OWNER_EMAIL,
    });

    const pack = await buildDebateEvidencePack(
      getDb(),
      DEBATE_A,
      OWNER_EMAIL,
    );
    assertPackShape(pack);
    expect(pack.debateId).toBe(DEBATE_A);
    expect(pack.claim).toBe("Scaling improves reasoning.");
    expect(pack.papers).toHaveLength(1);
    expect(pack.papers[0]).toEqual({
      id: "paper-one",
      externalId: "W100",
      title: "Paper One",
      authors: ["Ada Lovelace", "Grace Hopper"],
      year: 2021,
      doi: "10.1234/one",
      url: "https://journals.example/one",
      providerUrl: "https://openalex.org/W100",
      abstract: "Short abstract",
      abstractTruncated: false,
      stance: null,
    });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("5. multiple papers ordered by addedAt DESC, link.id ASC", async () => {
    await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
    await insertPaper({ id: "paper-early", externalId: "W1", title: "Early" });
    await insertPaper({ id: "paper-mid-b", externalId: "W2", title: "Mid B" });
    await insertPaper({ id: "paper-mid-a", externalId: "W3", title: "Mid A" });
    await insertPaper({ id: "paper-late", externalId: "W4", title: "Late" });
    await insertLink({
      id: "link-early",
      debateId: DEBATE_A,
      paperId: "paper-early",
      addedAt: ADDED_EARLY,
    });
    await insertLink({
      id: "link-bbbb",
      debateId: DEBATE_A,
      paperId: "paper-mid-b",
      addedAt: ADDED_SAME,
    });
    await insertLink({
      id: "link-aaaa",
      debateId: DEBATE_A,
      paperId: "paper-mid-a",
      addedAt: ADDED_SAME,
    });
    await insertLink({
      id: "link-late",
      debateId: DEBATE_A,
      paperId: "paper-late",
      addedAt: ADDED_LATE,
    });

    const pack = await buildDebateEvidencePack(
      getDb(),
      DEBATE_A,
      OWNER_EMAIL,
    );
    expect(pack.papers.map((p) => p.externalId)).toEqual([
      "W4",
      "W3",
      "W2",
      "W1",
    ]);
    expect(pack.papers.map((p) => p.id)).toEqual([
      "paper-late",
      "paper-mid-a",
      "paper-mid-b",
      "paper-early",
    ]);
  });

  it("6. more than 10 attached papers → at most 10 returned", async () => {
    await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
    for (let i = 1; i <= 12; i++) {
      const n = String(i).padStart(2, "0");
      await insertPaper({
        id: `paper-${n}`,
        externalId: `W${100 + i}`,
        title: `Title ${n}`,
      });
      await insertLink({
        id: `link-${n}`,
        debateId: DEBATE_A,
        paperId: `paper-${n}`,
        // Newer i → later addedAt
        addedAt: `2026-01-${String(i).padStart(2, "0")}T00:00:00.000Z`,
      });
    }

    const pack = await buildDebateEvidencePack(
      getDb(),
      DEBATE_A,
      OWNER_EMAIL,
    );
    expect(EVIDENCE_PACK_MAX_PAPERS).toBe(10);
    expect(pack.papers).toHaveLength(10);
    expect(pack.papers.map((p) => p.externalId)).toEqual([
      "W112",
      "W111",
      "W110",
      "W109",
      "W108",
      "W107",
      "W106",
      "W105",
      "W104",
      "W103",
    ]);
  });

  it("7. exactly 10 attached papers → all 10 returned", async () => {
    await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
    for (let i = 1; i <= 10; i++) {
      const n = String(i).padStart(2, "0");
      await insertPaper({
        id: `paper-${n}`,
        externalId: `W${200 + i}`,
        title: `Exact ${n}`,
      });
      await insertLink({
        id: `link-${n}`,
        debateId: DEBATE_A,
        paperId: `paper-${n}`,
        addedAt: `2026-02-${String(i).padStart(2, "0")}T00:00:00.000Z`,
      });
    }

    const pack = await buildDebateEvidencePack(
      getDb(),
      DEBATE_A,
      OWNER_EMAIL,
    );
    expect(pack.papers).toHaveLength(10);
  });

  it("8. abstract length 1200 → not truncated", async () => {
    const abstract = "a".repeat(EVIDENCE_PACK_ABSTRACT_MAX_CHARS);
    expect(abstract.length).toBe(1200);
    await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
    await insertPaper({
      id: "paper-abs-1200",
      externalId: "W1200",
      abstract,
    });
    await insertLink({
      id: "link-abs-1200",
      debateId: DEBATE_A,
      paperId: "paper-abs-1200",
      addedAt: ADDED_EARLY,
    });

    const pack = await buildDebateEvidencePack(
      getDb(),
      DEBATE_A,
      OWNER_EMAIL,
    );
    expect(pack.papers[0]!.abstract).toBe(abstract);
    expect(pack.papers[0]!.abstractTruncated).toBe(false);
  });

  it("9. abstract length 1201 → truncated to 1200, abstractTruncated=true", async () => {
    const abstract = "b".repeat(EVIDENCE_PACK_ABSTRACT_MAX_CHARS + 1);
    expect(abstract.length).toBe(1201);
    await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
    await insertPaper({
      id: "paper-abs-1201",
      externalId: "W1201",
      abstract,
    });
    await insertLink({
      id: "link-abs-1201",
      debateId: DEBATE_A,
      paperId: "paper-abs-1201",
      addedAt: ADDED_EARLY,
    });

    const pack = await buildDebateEvidencePack(
      getDb(),
      DEBATE_A,
      OWNER_EMAIL,
    );
    expect(pack.papers[0]!.abstract).toBe("b".repeat(1200));
    expect(pack.papers[0]!.abstract!.length).toBe(1200);
    expect(pack.papers[0]!.abstractTruncated).toBe(true);
  });

  it("10. abstract null → null, abstractTruncated=false", async () => {
    await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
    await insertPaper({
      id: "paper-abs-null",
      externalId: "WNULL",
      abstract: null,
    });
    await insertLink({
      id: "link-abs-null",
      debateId: DEBATE_A,
      paperId: "paper-abs-null",
      addedAt: ADDED_EARLY,
    });

    const pack = await buildDebateEvidencePack(
      getDb(),
      DEBATE_A,
      OWNER_EMAIL,
    );
    expect(pack.papers[0]!.abstract).toBeNull();
    expect(pack.papers[0]!.abstractTruncated).toBe(false);
  });

  it("11. valid authorsJson string array → parsed", async () => {
    await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
    await insertPaper({
      id: "paper-authors-ok",
      externalId: "WAUTH",
      authorsJson: JSON.stringify(["A", "B"]),
    });
    await insertLink({
      id: "link-authors-ok",
      debateId: DEBATE_A,
      paperId: "paper-authors-ok",
      addedAt: ADDED_EARLY,
    });

    const pack = await buildDebateEvidencePack(
      getDb(),
      DEBATE_A,
      OWNER_EMAIL,
    );
    expect(pack.papers[0]!.authors).toEqual(["A", "B"]);
  });

  it("12. bad authorsJson → safe empty array, no crash", async () => {
    await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });

    const cases: Array<{ id: string; externalId: string; authorsJson: string }> =
      [
        {
          id: "paper-bad-json",
          externalId: "WBAD1",
          authorsJson: "{not-json",
        },
        {
          id: "paper-not-array",
          externalId: "WBAD2",
          authorsJson: JSON.stringify({ name: "Ada" }),
        },
        {
          id: "paper-mixed",
          externalId: "WBAD3",
          authorsJson: JSON.stringify(["Ok", 1, null, "Also"]),
        },
      ];

    for (const [index, row] of cases.entries()) {
      await insertPaper(row);
      await insertLink({
        id: `link-bad-${index}`,
        debateId: DEBATE_A,
        paperId: row.id,
        addedAt: `2026-03-0${index + 1}T00:00:00.000Z`,
      });
    }

    const pack = await buildDebateEvidencePack(
      getDb(),
      DEBATE_A,
      OWNER_EMAIL,
    );
    const byExternal = Object.fromEntries(
      pack.papers.map((p) => [p.externalId, p.authors]),
    );
    expect(byExternal.WBAD1).toEqual([]);
    expect(byExternal.WBAD2).toEqual([]);
    expect(byExternal.WBAD3).toEqual(["Ok", "Also"]);
  });

  it("13. missing title / externalId / providerUrl → invalid_paper", async () => {
    await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });

    await insertPaper({
      id: "paper-no-title",
      externalId: "WNOTITLE",
      title: null,
    });
    await insertLink({
      id: "link-no-title",
      debateId: DEBATE_A,
      paperId: "paper-no-title",
      addedAt: ADDED_EARLY,
    });
    await expectEvidenceError(
      buildDebateEvidencePack(getDb(), DEBATE_A, OWNER_EMAIL),
      DebateEvidenceInvalidPaperError,
      500,
      "debate_evidence_invalid_paper",
    );

    await clearAppTables();
    await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
    await insertPaper({
      id: "paper-empty-ext",
      externalId: "   ",
      title: "Has title",
    });
    await insertLink({
      id: "link-empty-ext",
      debateId: DEBATE_A,
      paperId: "paper-empty-ext",
      addedAt: ADDED_EARLY,
    });
    await expectEvidenceError(
      buildDebateEvidencePack(getDb(), DEBATE_A, OWNER_EMAIL),
      DebateEvidenceInvalidPaperError,
      500,
      "debate_evidence_invalid_paper",
    );

    await clearAppTables();
    await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
    await insertPaper({
      id: "paper-empty-provider",
      externalId: "WNOPROV",
      providerUrl: "  ",
      title: "Has title",
    });
    await insertLink({
      id: "link-empty-provider",
      debateId: DEBATE_A,
      paperId: "paper-empty-provider",
      addedAt: ADDED_EARLY,
    });
    await expectEvidenceError(
      buildDebateEvidencePack(getDb(), DEBATE_A, OWNER_EMAIL),
      DebateEvidenceInvalidPaperError,
      500,
      "debate_evidence_invalid_paper",
    );
  });

  it("14. duplicate externalId → keep first after sort order", async () => {
    await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
    // Unique is (source, external_id); same externalId via different sources.
    await insertPaper({
      id: "paper-dup-newer",
      externalId: "WDUP",
      source: "openalex",
      title: "Newer Dup",
    });
    await insertPaper({
      id: "paper-dup-older",
      externalId: "WDUP",
      source: "crossref",
      title: "Older Dup",
      providerUrl: "https://openalex.org/WDUP-older",
    });
    await insertPaper({
      id: "paper-unique",
      externalId: "WUNIQ",
      title: "Unique",
    });
    await insertLink({
      id: "link-dup-older",
      debateId: DEBATE_A,
      paperId: "paper-dup-older",
      addedAt: ADDED_EARLY,
    });
    await insertLink({
      id: "link-dup-newer",
      debateId: DEBATE_A,
      paperId: "paper-dup-newer",
      addedAt: ADDED_LATE,
    });
    await insertLink({
      id: "link-unique",
      debateId: DEBATE_A,
      paperId: "paper-unique",
      addedAt: ADDED_SAME,
    });

    const pack = await buildDebateEvidencePack(
      getDb(),
      DEBATE_A,
      OWNER_EMAIL,
    );
    expect(pack.papers.map((p) => p.externalId)).toEqual(["WDUP", "WUNIQ"]);
    expect(pack.papers[0]!.id).toBe("paper-dup-newer");
    expect(pack.papers[0]!.title).toBe("Newer Dup");
  });

  it("15–18. validateCitedExternalIds whitelist rules", async () => {
    const pack: EvidencePack = {
      debateId: DEBATE_A,
      claim: "Claim",
      papers: [
        {
          id: "p1",
          externalId: "W1",
          title: "T1",
          authors: [],
          year: null,
          doi: null,
          url: null,
          providerUrl: "https://openalex.org/W1",
          abstract: null,
          abstractTruncated: false,
          stance: null,
        },
        {
          id: "p2",
          externalId: "W2",
          title: "T2",
          authors: [],
          year: null,
          doi: null,
          url: null,
          providerUrl: "https://openalex.org/W2",
          abstract: null,
          abstractTruncated: false,
          stance: null,
        },
      ],
    };

    expect(validateCitedExternalIds(["W1", "W2"], pack)).toEqual(["W1", "W2"]);
    expect(validateCitedExternalIds([], pack)).toEqual([]);

    try {
      validateCitedExternalIds(["W1", "W999"], pack);
      expect.fail("Expected invalid citation to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DebateEvidenceInvalidCitationError);
      expect(error).toMatchObject({
        statusCode: 400,
        code: "debate_evidence_invalid_citation",
      });
    }

    try {
      validateCitedExternalIds("W1" as unknown as string[], pack);
      expect.fail("Expected non-array citation to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DebateEvidenceInvalidCitationError);
      expect(error).toMatchObject({
        code: "debate_evidence_invalid_citation",
      });
    }

    try {
      validateCitedExternalIds(["W1", 2] as unknown as string[], pack);
      expect.fail("Expected non-string citation element to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DebateEvidenceInvalidCitationError);
      expect(error).toMatchObject({
        code: "debate_evidence_invalid_citation",
      });
    }
  });

  it("19. EvidencePack JSON.stringify / JSON.parse round-trip", async () => {
    await insertDebate({
      id: DEBATE_A,
      ownerEmail: OWNER_EMAIL,
      claim: "Round trip claim",
    });
    await insertPaper({
      id: "paper-json",
      externalId: "WJSON",
      title: "JSON Paper",
      abstract: "x".repeat(1201),
    });
    await insertLink({
      id: "link-json",
      debateId: DEBATE_A,
      paperId: "paper-json",
      addedAt: ADDED_EARLY,
    });

    const pack = await buildDebateEvidencePack(
      getDb(),
      DEBATE_A,
      OWNER_EMAIL,
    );
    const encoded = JSON.stringify(pack);
    const decoded = JSON.parse(encoded) as EvidencePack;
    expect(decoded).toEqual(pack);
  });

  it("20. field allowlist excludes owner/org/visibility/timestamps/authorsJson", async () => {
    await insertDebate({
      id: DEBATE_A,
      ownerEmail: OWNER_EMAIL,
      claim: "Allowlist claim",
      orgId: "org-secret",
      visibility: "org",
    });
    await insertPaper({ id: "paper-allow", externalId: "WALLOW" });
    await insertLink({
      id: "link-allow",
      debateId: DEBATE_A,
      paperId: "paper-allow",
      addedAt: ADDED_EARLY,
      addedByEmail: "adder@example.test",
    });

    const pack = await buildDebateEvidencePack(
      getDb(),
      DEBATE_A,
      OWNER_EMAIL,
    );
    assertPackShape(pack);
    const encoded = JSON.stringify(pack);
    expect(encoded).not.toContain("ownerEmail");
    expect(encoded).not.toContain("addedByEmail");
    expect(encoded).not.toContain("orgId");
    expect(encoded).not.toContain("visibility");
    expect(encoded).not.toContain("authorsJson");
    expect(encoded).not.toContain("adder@example.test");
    expect(encoded).not.toContain("org-secret");
  });

  it("21. does not call fetch / OpenAlex", async () => {
    await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
    await insertPaper({ id: "paper-fetch", externalId: "WFETCH" });
    await insertLink({
      id: "link-fetch",
      debateId: DEBATE_A,
      paperId: "paper-fetch",
      addedAt: ADDED_EARLY,
    });

    await buildDebateEvidencePack(getDb(), DEBATE_A, OWNER_EMAIL);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("22. build is read-only: counts and row snapshots unchanged", async () => {
    await insertDebate({
      id: DEBATE_A,
      ownerEmail: OWNER_EMAIL,
      claim: "Readonly claim",
    });
    await insertPaper({
      id: "paper-ro",
      externalId: "WRO",
      title: "Readonly",
      abstract: "keep me",
    });
    await insertLink({
      id: "link-ro",
      debateId: DEBATE_A,
      paperId: "paper-ro",
      addedAt: ADDED_EARLY,
    });

    const before = {
      debates: await countTable("debates"),
      papers: await countTable("papers"),
      links: await countTable("debate_papers"),
      debate: await snapshotDebateRow(DEBATE_A),
      paper: await snapshotPaperRow("paper-ro"),
      link: await snapshotLinkRow("link-ro"),
    };

    await buildDebateEvidencePack(getDb(), DEBATE_A, OWNER_EMAIL);

    expect(await countTable("debates")).toBe(before.debates);
    expect(await countTable("papers")).toBe(before.papers);
    expect(await countTable("debate_papers")).toBe(before.links);
    expect(await snapshotDebateRow(DEBATE_A)).toEqual(before.debate);
    expect(await snapshotPaperRow("paper-ro")).toEqual(before.paper);
    expect(await snapshotLinkRow("link-ro")).toEqual(before.link);
  });

  it("23. multi-user isolation: cannot read another owner's evidence", async () => {
    await insertDebate({
      id: DEBATE_A,
      ownerEmail: OWNER_EMAIL,
      claim: "Owner A claim",
    });
    await insertDebate({
      id: DEBATE_B,
      ownerEmail: OTHER_EMAIL,
      claim: "Owner B claim",
    });
    await insertPaper({ id: "paper-a", externalId: "WA", title: "A only" });
    await insertPaper({ id: "paper-b", externalId: "WB", title: "B only" });
    await insertLink({
      id: "link-a",
      debateId: DEBATE_A,
      paperId: "paper-a",
      addedAt: ADDED_EARLY,
    });
    await insertLink({
      id: "link-b",
      debateId: DEBATE_B,
      paperId: "paper-b",
      addedAt: ADDED_EARLY,
    });

    await expectEvidenceError(
      buildDebateEvidencePack(getDb(), DEBATE_A, OTHER_EMAIL),
      DebateEvidenceNotFoundError,
      404,
      "debate_evidence_not_found",
    );

    const packB = await buildDebateEvidencePack(
      getDb(),
      DEBATE_B,
      OTHER_EMAIL,
    );
    expect(packB.papers.map((p) => p.externalId)).toEqual(["WB"]);
    expect(packB.claim).toBe("Owner B claim");
  });

  it("24. LIMIT 10 applies before externalId dedupe (document order)", async () => {
    await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });

    // Newest 10 links: one duplicate WDUP pair + 8 unique → after LIMIT then
    // dedupe → 9 papers. An 11th older unique paper is excluded by LIMIT and
    // never considered for dedupe.
    await insertPaper({
      id: "paper-oldest-unique",
      externalId: "WOLD",
      title: "Oldest unique (should be cut by LIMIT)",
    });
    await insertLink({
      id: "link-00-oldest",
      debateId: DEBATE_A,
      paperId: "paper-oldest-unique",
      addedAt: "2026-01-01T00:00:00.000Z",
    });

    for (let i = 1; i <= 8; i++) {
      const n = String(i).padStart(2, "0");
      await insertPaper({
        id: `paper-u-${n}`,
        externalId: `WU${i}`,
        title: `Unique ${n}`,
      });
      await insertLink({
        id: `link-u-${n}`,
        debateId: DEBATE_A,
        paperId: `paper-u-${n}`,
        addedAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      });
    }

    await insertPaper({
      id: "paper-dup-old",
      externalId: "WDUP",
      source: "crossref",
      title: "Dup older in window",
      providerUrl: "https://example.test/WDUP-old",
    });
    await insertPaper({
      id: "paper-dup-new",
      externalId: "WDUP",
      source: "openalex",
      title: "Dup newer in window",
    });
    await insertLink({
      id: "link-dup-old",
      debateId: DEBATE_A,
      paperId: "paper-dup-old",
      addedAt: "2026-01-10T00:00:00.000Z",
    });
    await insertLink({
      id: "link-dup-new",
      debateId: DEBATE_A,
      paperId: "paper-dup-new",
      addedAt: "2026-01-11T00:00:00.000Z",
    });

    // Total links = 11. Newest 10 exclude WOLD.
    const pack = await buildDebateEvidencePack(
      getDb(),
      DEBATE_A,
      OWNER_EMAIL,
    );
    const ids = pack.papers.map((p) => p.externalId);
    expect(ids).not.toContain("WOLD");
    expect(ids.filter((id) => id === "WDUP")).toHaveLength(1);
    expect(pack.papers.find((p) => p.externalId === "WDUP")!.title).toBe(
      "Dup newer in window",
    );
    // 8 unique + 1 deduped WDUP = 9 (LIMIT then dedupe, not dedupe then LIMIT)
    expect(pack.papers).toHaveLength(9);
    expect(ids).toEqual([
      "WDUP",
      "WU8",
      "WU7",
      "WU6",
      "WU5",
      "WU4",
      "WU3",
      "WU2",
      "WU1",
    ]);
  });

  function endsWithLoneSurrogate(value: string): boolean {
    if (value.length === 0) return false;
    const last = value.charCodeAt(value.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) return true;
    if (last >= 0xdc00 && last <= 0xdfff) {
      if (value.length === 1) return true;
      const prev = value.charCodeAt(value.length - 2);
      return !(prev >= 0xd800 && prev <= 0xdbff);
    }
    return false;
  }

  async function buildPackForAbstract(abstract: string | null): Promise<{
    abstract: string | null;
    abstractTruncated: boolean;
  }> {
    await clearAppTables();
    await insertDebate({ id: DEBATE_A, ownerEmail: OWNER_EMAIL });
    await insertPaper({
      id: "paper-unicode",
      externalId: "WUNI",
      abstract,
    });
    await insertLink({
      id: "link-unicode",
      debateId: DEBATE_A,
      paperId: "paper-unicode",
      addedAt: ADDED_EARLY,
    });
    const pack = await buildDebateEvidencePack(
      getDb(),
      DEBATE_A,
      OWNER_EMAIL,
    );
    return {
      abstract: pack.papers[0]!.abstract,
      abstractTruncated: pack.papers[0]!.abstractTruncated,
    };
  }

  it("25a. 1199 a + emoji → no lone surrogate, length<=1200, truncated", async () => {
    const emoji = "😀";
    expect(emoji.length).toBe(2);
    const source = `${"a".repeat(1199)}${emoji}`;
    expect(source.length).toBe(1201);

    const result = await buildPackForAbstract(source);
    expect(result.abstractTruncated).toBe(true);
    expect(result.abstract).not.toBeNull();
    expect(result.abstract!.length).toBeLessThanOrEqual(
      EVIDENCE_PACK_ABSTRACT_MAX_CHARS,
    );
    expect(result.abstract!.length).toBe(1199);
    expect(result.abstract).toBe("a".repeat(1199));
    expect(endsWithLoneSurrogate(result.abstract!)).toBe(false);
    expect(result.abstract!.endsWith(emoji)).toBe(false);

    const roundTrip = JSON.parse(
      JSON.stringify({ abstract: result.abstract }),
    ) as { abstract: string };
    expect(roundTrip.abstract).toBe(result.abstract);
    expect(roundTrip.abstract.includes("\uFFFD")).toBe(false);
  });

  it("25b. 1198 a + emoji → emoji kept whole, length=1200, not truncated", async () => {
    const emoji = "😀";
    const source = `${"a".repeat(1198)}${emoji}`;
    expect(source.length).toBe(1200);

    const result = await buildPackForAbstract(source);
    expect(result.abstractTruncated).toBe(false);
    expect(result.abstract).toBe(source);
    expect(result.abstract!.length).toBe(1200);
    expect(result.abstract!.endsWith(emoji)).toBe(true);
    expect(endsWithLoneSurrogate(result.abstract!)).toBe(false);
  });

  it("25c. 1200 ASCII → not truncated", async () => {
    const source = "c".repeat(1200);
    const result = await buildPackForAbstract(source);
    expect(result.abstractTruncated).toBe(false);
    expect(result.abstract).toBe(source);
    expect(result.abstract!.length).toBe(1200);
  });

  it("25d. 1201 ASCII → truncated to 1200", async () => {
    const source = "d".repeat(1201);
    const result = await buildPackForAbstract(source);
    expect(result.abstractTruncated).toBe(true);
    expect(result.abstract).toBe("d".repeat(1200));
    expect(result.abstract!.length).toBe(1200);
  });

  it("25e. Chinese boundary → no unexpected character loss", async () => {
    const exact = "中".repeat(1200);
    expect(exact.length).toBe(1200);
    const exactResult = await buildPackForAbstract(exact);
    expect(exactResult.abstractTruncated).toBe(false);
    expect(exactResult.abstract).toBe(exact);

    const over = "文".repeat(1201);
    const overResult = await buildPackForAbstract(over);
    expect(overResult.abstractTruncated).toBe(true);
    expect(overResult.abstract).toBe("文".repeat(1200));
    expect(overResult.abstract!.length).toBe(1200);
    expect(endsWithLoneSurrogate(overResult.abstract!)).toBe(false);
  });

  it("25f. null abstract → null / abstractTruncated=false", async () => {
    const result = await buildPackForAbstract(null);
    expect(result.abstract).toBeNull();
    expect(result.abstractTruncated).toBe(false);
  });
});

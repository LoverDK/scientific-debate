import {
  closeDbExec,
  getDatabaseUrl,
  getDbExec,
  isUniqueViolation,
  runMigrations,
  withMigrationRuntime,
  type MigrationEntry,
} from "@agent-native/core/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEBATES_APP_MIGRATIONS_TABLE,
  debatesAppMigrations,
} from "./migrations.js";

function assertMemoryDatabaseUrl(): void {
  if (process.env.DATABASE_URL !== "pglite:memory") {
    throw new Error(
      `Refusing to run migration tests: DATABASE_URL must be exactly "pglite:memory" (got ${JSON.stringify(process.env.DATABASE_URL)}). This suite must not touch ./data/pglite.`,
    );
  }
  const resolved = getDatabaseUrl();
  if (!resolved.toLowerCase().startsWith("pglite:memory")) {
    throw new Error(
      `Refusing to run migration tests: resolved database URL is not memory PGlite (got ${JSON.stringify(resolved)}).`,
    );
  }
}

// Fail fast at module load before any getDbExec() call connects.
assertMemoryDatabaseUrl();

const v1 = debatesAppMigrations.filter((entry) => entry.version === 1);
const v1v2 = debatesAppMigrations.filter((entry) => entry.version <= 2);
const v1v2v3 = debatesAppMigrations.filter((entry) => entry.version <= 3);
const v1v2v3v4 = debatesAppMigrations.filter((entry) => entry.version <= 4);

async function applyMigrations(entries: MigrationEntry[]): Promise<void> {
  assertMemoryDatabaseUrl();
  await withMigrationRuntime(async () => {
    await runMigrations(entries, { table: DEBATES_APP_MIGRATIONS_TABLE })(
      undefined,
    );
  });
}

async function resetMemoryDatabase(): Promise<void> {
  assertMemoryDatabaseUrl();
  await closeDbExec();
}

async function insertDebate(id: string, claim = "Test claim"): Promise<void> {
  await getDbExec().execute({
    sql: `INSERT INTO debates (id, claim, owner_email)
          VALUES (?, ?, 'owner@example.test')`,
    args: [id, claim],
  });
}

async function insertRun(input: {
  id: string;
  debateId: string;
  status: string;
  modelId?: string;
}): Promise<void> {
  await getDbExec().execute({
    sql: `INSERT INTO debate_runs (
            id, debate_id, status, model_id, evidence_snapshot_json, created_by_email
          ) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      input.id,
      input.debateId,
      input.status,
      input.modelId ?? "openrouter/test-model",
      JSON.stringify([{ externalId: "W1", title: "Snap" }]),
      "owner@example.test",
    ],
  });
}

async function insertMessage(input: {
  id: string;
  runId: string;
  role: string;
}): Promise<void> {
  await getDbExec().execute({
    sql: `INSERT INTO debate_messages (
            id, run_id, role, payload_json, cited_external_ids_json
          ) VALUES (?, ?, ?, ?, ?)`,
    args: [
      input.id,
      input.runId,
      input.role,
      JSON.stringify({ ok: true }),
      JSON.stringify(["W1"]),
    ],
  });
}

async function listCheckConstraints(
  table: string,
): Promise<Array<{ constraint_name: string; check_clause: string | null }>> {
  const { rows } = await getDbExec().execute({
    sql: `SELECT tc.constraint_name, cc.check_clause
          FROM information_schema.table_constraints AS tc
          LEFT JOIN information_schema.check_constraints AS cc
            ON tc.constraint_name = cc.constraint_name
           AND tc.constraint_schema = cc.constraint_schema
          WHERE tc.table_schema = 'public'
            AND tc.table_name = ?
            AND tc.constraint_type = 'CHECK'
          ORDER BY tc.constraint_name`,
    args: [table],
  });
  return rows as Array<{ constraint_name: string; check_clause: string | null }>;
}

async function listForeignKeys(table: string): Promise<
  Array<{
    constraint_name: string;
    column_name: string;
    foreign_table: string;
    foreign_column: string;
    delete_rule: string;
  }>
> {
  const { rows } = await getDbExec().execute({
    sql: `SELECT tc.constraint_name, kcu.column_name, ccu.table_name AS foreign_table,
                 ccu.column_name AS foreign_column, rc.delete_rule
          FROM information_schema.table_constraints AS tc
          JOIN information_schema.key_column_usage AS kcu
            ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
          JOIN information_schema.constraint_column_usage AS ccu
            ON ccu.constraint_name = tc.constraint_name
           AND ccu.table_schema = tc.table_schema
          JOIN information_schema.referential_constraints AS rc
            ON rc.constraint_name = tc.constraint_name
           AND rc.constraint_schema = tc.table_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = 'public'
            AND tc.table_name = ?
          ORDER BY kcu.column_name`,
    args: [table],
  });
  return rows as Array<{
    constraint_name: string;
    column_name: string;
    foreign_table: string;
    foreign_column: string;
    delete_rule: string;
  }>;
}

async function tableColumns(table: string): Promise<
  Array<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>
> {
  const { rows } = await getDbExec().execute({
    sql: `SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = ?
          ORDER BY ordinal_position`,
    args: [table],
  });
  return rows as Array<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>;
}

async function expectExecuteFailure(sql: string, args: unknown[] = []) {
  try {
    await getDbExec().execute({ sql, args });
    expect.fail("Expected SQL to fail, but it succeeded.");
  } catch (error) {
    expect(error).toBeTruthy();
    return error;
  }
}

describe("debates app migrations v1/v2 (memory PGlite)", () => {
  beforeAll(() => {
    assertMemoryDatabaseUrl();
    expect(v1v2.map((entry) => entry.version)).toEqual([1, 2]);
    expect(v1v2.map((entry) => entry.name)).toEqual([
      "debates",
      "papers_and_debate_papers",
    ]);
    expect(debatesAppMigrations.map((entry) => entry.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(debatesAppMigrations.map((entry) => entry.name)).toEqual([
      "debates",
      "papers_and_debate_papers",
      "debate_runs_and_messages",
      "debates_current_run_id",
      "debate_archive_and_paper_venue",
      "research_projects",
      "debate_papers_stance",
      "debate_run_discussion",
      "role_usage",
    ]);
  });

  afterAll(async () => {
    await closeDbExec();
  });

  it("1. applies v1 then v2 successfully on an empty database", async () => {
    await resetMemoryDatabase();
    await applyMigrations(v1);

    const afterV1 = await getDbExec().execute(
      `SELECT version FROM ${DEBATES_APP_MIGRATIONS_TABLE} ORDER BY version`,
    );
    expect(afterV1.rows.map((row) => Number(row.version))).toEqual([1]);

    const debates = await getDbExec().execute(
      `SELECT to_regclass('public.debates') AS rel`,
    );
    expect(debates.rows[0]?.rel).toBeTruthy();

    await applyMigrations(v1v2);

    const afterV2 = await getDbExec().execute(
      `SELECT version FROM ${DEBATES_APP_MIGRATIONS_TABLE} ORDER BY version`,
    );
    expect(afterV2.rows.map((row) => Number(row.version))).toEqual([1, 2]);

    const named = await getDbExec().execute(
      `SELECT name FROM ${DEBATES_APP_MIGRATIONS_TABLE}_named ORDER BY version`,
    );
    expect(named.rows.map((row) => String(row.name))).toEqual([
      "debates",
      "papers_and_debate_papers",
    ]);

    const papers = await getDbExec().execute(
      `SELECT to_regclass('public.papers') AS rel`,
    );
    const links = await getDbExec().execute(
      `SELECT to_regclass('public.debate_papers') AS rel`,
    );
    expect(papers.rows[0]?.rel).toBeTruthy();
    expect(links.rows[0]?.rel).toBeTruthy();
  });

  it("2. preserves existing v1 debate rows across the v2 upgrade", async () => {
    await resetMemoryDatabase();
    await applyMigrations(v1);

    await getDbExec().execute({
      sql: `INSERT INTO debates (id, claim, input_type, status, created_at, updated_at, owner_email, org_id, visibility)
            VALUES (?, ?, 'text', 'pending', ?, ?, ?, NULL, 'private')`,
      args: [
        "debate-keep-1",
        "Claim that must survive v2",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        "owner@example.test",
      ],
    });

    await applyMigrations(v1v2);

    const { rows } = await getDbExec().execute(
      `SELECT id, claim, owner_email FROM debates WHERE id = 'debate-keep-1'`,
    );
    expect(rows).toEqual([
      {
        id: "debate-keep-1",
        claim: "Claim that must survive v2",
        owner_email: "owner@example.test",
      },
    ]);
  });

  it("3. creates papers with the expected columns, nullability, and INTEGER types", async () => {
    await resetMemoryDatabase();
    await applyMigrations(v1v2);

    const columns = await tableColumns("papers");
    const byName = Object.fromEntries(
      columns.map((column) => [column.column_name, column]),
    );

    for (const required of [
      "id",
      "source",
      "external_id",
      "provider_url",
      "title",
      "authors_json",
      "year",
      "doi",
      "abstract",
      "citation_count",
      "url",
      "created_at",
      "updated_at",
    ]) {
      expect(byName[required], required).toBeTruthy();
    }

    expect(byName.year?.data_type).toBe("integer");
    expect(byName.citation_count?.data_type).toBe("integer");
    expect(byName.title?.is_nullable).toBe("YES");
    expect(byName.doi?.is_nullable).toBe("YES");
    expect(byName.abstract?.is_nullable).toBe("YES");
    expect(byName.url?.is_nullable).toBe("YES");
    expect(byName.year?.is_nullable).toBe("YES");
    expect(byName.citation_count?.is_nullable).toBe("YES");
    expect(byName.source?.is_nullable).toBe("NO");
    expect(byName.external_id?.is_nullable).toBe("NO");
    expect(byName.provider_url?.is_nullable).toBe("NO");
    expect(byName.authors_json?.is_nullable).toBe("NO");

    await getDbExec().execute({
      sql: `INSERT INTO papers (id, source, external_id, provider_url, title, year, doi, abstract, citation_count, url)
            VALUES (?, 'openalex', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)`,
      args: ["paper-nulls", "W100", "https://openalex.org/W100"],
    });

    const { rows } = await getDbExec().execute(
      `SELECT title, year, doi, abstract, citation_count, url, authors_json
       FROM papers WHERE id = 'paper-nulls'`,
    );
    expect(rows[0]).toMatchObject({
      title: null,
      year: null,
      doi: null,
      abstract: null,
      citation_count: null,
      url: null,
      authors_json: "[]",
    });
  });

  it("4. creates debate_papers with the expected columns", async () => {
    await resetMemoryDatabase();
    await applyMigrations(v1v2);

    const columns = await tableColumns("debate_papers");
    const names = columns.map((column) => column.column_name);
    expect(names).toEqual([
      "id",
      "debate_id",
      "paper_id",
      "added_at",
      "added_by_email",
    ]);

    for (const column of columns) {
      expect(column.is_nullable).toBe("NO");
    }
  });

  it("5. enforces UNIQUE(source, external_id) on papers", async () => {
    await resetMemoryDatabase();
    await applyMigrations(v1v2);

    await getDbExec().execute({
      sql: `INSERT INTO papers (id, source, external_id, provider_url)
            VALUES ('p1', 'openalex', 'W200', 'https://openalex.org/W200')`,
    });

    const error = await expectExecuteFailure(
      `INSERT INTO papers (id, source, external_id, provider_url)
       VALUES ('p2', 'openalex', 'W200', 'https://openalex.org/W200')`,
    );
    expect(isUniqueViolation(error)).toBe(true);
  });

  it("6. enforces UNIQUE(debate_id, paper_id) on debate_papers", async () => {
    await resetMemoryDatabase();
    await applyMigrations(v1v2);

    await getDbExec().execute({
      sql: `INSERT INTO debates (id, claim, owner_email)
            VALUES ('d-unique', 'Unique link claim', 'owner@example.test')`,
    });
    await getDbExec().execute({
      sql: `INSERT INTO papers (id, source, external_id, provider_url)
            VALUES ('p-unique', 'openalex', 'W300', 'https://openalex.org/W300')`,
    });
    await getDbExec().execute({
      sql: `INSERT INTO debate_papers (id, debate_id, paper_id, added_by_email)
            VALUES ('link-1', 'd-unique', 'p-unique', 'owner@example.test')`,
    });

    const error = await expectExecuteFailure(
      `INSERT INTO debate_papers (id, debate_id, paper_id, added_by_email)
       VALUES ('link-2', 'd-unique', 'p-unique', 'owner@example.test')`,
    );
    expect(isUniqueViolation(error)).toBe(true);
  });

  it("7. rejects debate_papers rows that reference a missing debate_id", async () => {
    await resetMemoryDatabase();
    await applyMigrations(v1v2);

    await getDbExec().execute({
      sql: `INSERT INTO papers (id, source, external_id, provider_url)
            VALUES ('p-fk-debate', 'openalex', 'W400', 'https://openalex.org/W400')`,
    });

    await expectExecuteFailure(
      `INSERT INTO debate_papers (id, debate_id, paper_id, added_by_email)
       VALUES ('link-missing-debate', 'no-such-debate', 'p-fk-debate', 'owner@example.test')`,
    );
  });

  it("8. rejects debate_papers rows that reference a missing paper_id", async () => {
    await resetMemoryDatabase();
    await applyMigrations(v1v2);

    await getDbExec().execute({
      sql: `INSERT INTO debates (id, claim, owner_email)
            VALUES ('d-fk-paper', 'FK paper claim', 'owner@example.test')`,
    });

    await expectExecuteFailure(
      `INSERT INTO debate_papers (id, debate_id, paper_id, added_by_email)
       VALUES ('link-missing-paper', 'd-fk-paper', 'no-such-paper', 'owner@example.test')`,
    );
  });

  it("9-10. CASCADE deletes debate_papers on debate delete, but keeps papers", async () => {
    await resetMemoryDatabase();
    await applyMigrations(v1v2);

    await getDbExec().execute({
      sql: `INSERT INTO debates (id, claim, owner_email)
            VALUES ('d-cascade', 'Cascade claim', 'owner@example.test')`,
    });
    await getDbExec().execute({
      sql: `INSERT INTO papers (id, source, external_id, provider_url)
            VALUES ('p-cascade', 'openalex', 'W500', 'https://openalex.org/W500')`,
    });
    await getDbExec().execute({
      sql: `INSERT INTO debate_papers (id, debate_id, paper_id, added_by_email)
            VALUES ('link-cascade', 'd-cascade', 'p-cascade', 'owner@example.test')`,
    });

    await getDbExec().execute(`DELETE FROM debates WHERE id = 'd-cascade'`);

    const links = await getDbExec().execute(
      `SELECT id FROM debate_papers WHERE debate_id = 'd-cascade'`,
    );
    expect(links.rows).toEqual([]);

    const papers = await getDbExec().execute(
      `SELECT id FROM papers WHERE id = 'p-cascade'`,
    );
    expect(papers.rows).toEqual([{ id: "p-cascade" }]);
  });

  it("11. RESTRICT prevents deleting a paper that is still referenced", async () => {
    await resetMemoryDatabase();
    await applyMigrations(v1v2);

    await getDbExec().execute({
      sql: `INSERT INTO debates (id, claim, owner_email)
            VALUES ('d-restrict', 'Restrict claim', 'owner@example.test')`,
    });
    await getDbExec().execute({
      sql: `INSERT INTO papers (id, source, external_id, provider_url)
            VALUES ('p-restrict', 'openalex', 'W600', 'https://openalex.org/W600')`,
    });
    await getDbExec().execute({
      sql: `INSERT INTO debate_papers (id, debate_id, paper_id, added_by_email)
            VALUES ('link-restrict', 'd-restrict', 'p-restrict', 'owner@example.test')`,
    });

    await expectExecuteFailure(`DELETE FROM papers WHERE id = 'p-restrict'`);

    const papers = await getDbExec().execute(
      `SELECT id FROM papers WHERE id = 'p-restrict'`,
    );
    expect(papers.rows).toEqual([{ id: "p-restrict" }]);
  });

  it("12. re-running migrations is a no-op and does not destroy existing data", async () => {
    await resetMemoryDatabase();
    await applyMigrations(v1v2);

    await getDbExec().execute({
      sql: `INSERT INTO debates (id, claim, owner_email)
            VALUES ('d-idempotent', 'Idempotent claim', 'owner@example.test')`,
    });
    await getDbExec().execute({
      sql: `INSERT INTO papers (id, source, external_id, provider_url, title)
            VALUES ('p-idempotent', 'openalex', 'W700', 'https://openalex.org/W700', 'Keep me')`,
    });
    await getDbExec().execute({
      sql: `INSERT INTO debate_papers (id, debate_id, paper_id, added_by_email)
            VALUES ('link-idempotent', 'd-idempotent', 'p-idempotent', 'owner@example.test')`,
    });

    await applyMigrations(v1v2);
    await applyMigrations(v1v2);

    const versions = await getDbExec().execute(
      `SELECT version FROM ${DEBATES_APP_MIGRATIONS_TABLE} ORDER BY version`,
    );
    expect(versions.rows.map((row) => Number(row.version))).toEqual([1, 2]);

    const named = await getDbExec().execute(
      `SELECT name FROM ${DEBATES_APP_MIGRATIONS_TABLE}_named ORDER BY version`,
    );
    expect(named.rows.map((row) => String(row.name))).toEqual([
      "debates",
      "papers_and_debate_papers",
    ]);

    const debate = await getDbExec().execute(
      `SELECT claim FROM debates WHERE id = 'd-idempotent'`,
    );
    const paper = await getDbExec().execute(
      `SELECT title FROM papers WHERE id = 'p-idempotent'`,
    );
    const link = await getDbExec().execute(
      `SELECT id FROM debate_papers WHERE id = 'link-idempotent'`,
    );
    expect(debate.rows).toEqual([{ claim: "Idempotent claim" }]);
    expect(paper.rows).toEqual([{ title: "Keep me" }]);
    expect(link.rows).toEqual([{ id: "link-idempotent" }]);
  });
});

describe("debates app migrations v3 debate_runs_and_messages (memory PGlite)", () => {
  afterAll(async () => {
    await closeDbExec();
  });

  it("1-2. applies v1→v2→v3 and records named versions", async () => {
    await resetMemoryDatabase();
    await applyMigrations(v1);
    await applyMigrations(v1v2);
    await applyMigrations(v1v2v3);

    const versions = await getDbExec().execute(
      `SELECT version FROM ${DEBATES_APP_MIGRATIONS_TABLE} ORDER BY version`,
    );
    expect(versions.rows.map((row) => Number(row.version))).toEqual([1, 2, 3]);

    const named = await getDbExec().execute(
      `SELECT name FROM ${DEBATES_APP_MIGRATIONS_TABLE}_named ORDER BY version`,
    );
    expect(named.rows.map((row) => String(row.name))).toEqual([
      "debates",
      "papers_and_debate_papers",
      "debate_runs_and_messages",
    ]);

    const runs = await getDbExec().execute(
      `SELECT to_regclass('public.debate_runs') AS rel`,
    );
    const messages = await getDbExec().execute(
      `SELECT to_regclass('public.debate_messages') AS rel`,
    );
    expect(runs.rows[0]?.rel).toBeTruthy();
    expect(messages.rows[0]?.rel).toBeTruthy();
  });

  it("3. re-running v1–v3 is a no-op and preserves data", async () => {
    await resetMemoryDatabase();
    await applyMigrations(v1v2v3);

    await insertDebate("d-v3-idem", "Survive re-run");
    await insertRun({
      id: "run-v3-idem",
      debateId: "d-v3-idem",
      status: "completed",
    });
    await insertMessage({
      id: "msg-v3-idem",
      runId: "run-v3-idem",
      role: "judge",
    });

    await applyMigrations(v1v2v3);
    await applyMigrations(v1v2v3);

    const versions = await getDbExec().execute(
      `SELECT version FROM ${DEBATES_APP_MIGRATIONS_TABLE} ORDER BY version`,
    );
    expect(versions.rows.map((row) => Number(row.version))).toEqual([1, 2, 3]);

    const debate = await getDbExec().execute(
      `SELECT claim FROM debates WHERE id = 'd-v3-idem'`,
    );
    const run = await getDbExec().execute(
      `SELECT status FROM debate_runs WHERE id = 'run-v3-idem'`,
    );
    const message = await getDbExec().execute(
      `SELECT role FROM debate_messages WHERE id = 'msg-v3-idem'`,
    );
    expect(debate.rows).toEqual([{ claim: "Survive re-run" }]);
    expect(run.rows).toEqual([{ status: "completed" }]);
    expect(message.rows).toEqual([{ role: "judge" }]);
  });

  it("4. debate_runs columns, nullability, defaults, and FK", async () => {
    await resetMemoryDatabase();
    await applyMigrations(v1v2v3);

    const columns = await tableColumns("debate_runs");
    const byName = Object.fromEntries(
      columns.map((column) => [column.column_name, column]),
    );
    expect(columns.map((column) => column.column_name)).toEqual([
      "id",
      "debate_id",
      "status",
      "model_id",
      "evidence_snapshot_json",
      "created_by_email",
      "created_at",
      "started_at",
      "finished_at",
      "updated_at",
      "heartbeat_at",
      "error_message",
    ]);

    for (const required of [
      "id",
      "debate_id",
      "status",
      "model_id",
      "evidence_snapshot_json",
      "created_by_email",
      "created_at",
      "updated_at",
    ]) {
      expect(byName[required]?.is_nullable).toBe("NO");
    }
    for (const optional of [
      "started_at",
      "finished_at",
      "heartbeat_at",
      "error_message",
    ]) {
      expect(byName[optional]?.is_nullable).toBe("YES");
    }

    expect(byName.created_at?.column_default).toBeTruthy();
    expect(byName.updated_at?.column_default).toBeTruthy();

    const fks = await listForeignKeys("debate_runs");
    expect(fks).toEqual([
      expect.objectContaining({
        column_name: "debate_id",
        foreign_table: "debates",
        foreign_column: "id",
        delete_rule: "CASCADE",
      }),
    ]);
  });

  it("5. debate_messages columns, nullability, defaults, and FK", async () => {
    await resetMemoryDatabase();
    await applyMigrations(v1v2v3);

    const columns = await tableColumns("debate_messages");
    expect(columns.map((column) => column.column_name)).toEqual([
      "id",
      "run_id",
      "role",
      "payload_json",
      "cited_external_ids_json",
      "created_at",
    ]);
    for (const column of columns) {
      expect(column.is_nullable).toBe("NO");
    }
    expect(
      columns.find((column) => column.column_name === "created_at")
        ?.column_default,
    ).toBeTruthy();

    const fks = await listForeignKeys("debate_messages");
    expect(fks).toEqual([
      expect.objectContaining({
        column_name: "run_id",
        foreign_table: "debate_runs",
        foreign_column: "id",
        delete_rule: "CASCADE",
      }),
    ]);
  });

  it("6. deleting a debate cascades runs and messages", async () => {
    await resetMemoryDatabase();
    await applyMigrations(v1v2v3);

    await insertDebate("d-cascade-run");
    await insertRun({
      id: "run-cascade",
      debateId: "d-cascade-run",
      status: "completed",
    });
    await insertMessage({
      id: "msg-cascade",
      runId: "run-cascade",
      role: "proponent",
    });

    await getDbExec().execute(`DELETE FROM debates WHERE id = 'd-cascade-run'`);

    const runs = await getDbExec().execute(
      `SELECT id FROM debate_runs WHERE id = 'run-cascade'`,
    );
    const messages = await getDbExec().execute(
      `SELECT id FROM debate_messages WHERE id = 'msg-cascade'`,
    );
    expect(runs.rows).toEqual([]);
    expect(messages.rows).toEqual([]);
  });

  it("7. deleting a run cascades its messages", async () => {
    await resetMemoryDatabase();
    await applyMigrations(v1v2v3);

    await insertDebate("d-del-run");
    await insertRun({
      id: "run-del",
      debateId: "d-del-run",
      status: "failed",
    });
    await insertMessage({
      id: "msg-del",
      runId: "run-del",
      role: "opponent",
    });

    await getDbExec().execute(`DELETE FROM debate_runs WHERE id = 'run-del'`);

    const messages = await getDbExec().execute(
      `SELECT id FROM debate_messages WHERE id = 'msg-del'`,
    );
    expect(messages.rows).toEqual([]);
    const debate = await getDbExec().execute(
      `SELECT id FROM debates WHERE id = 'd-del-run'`,
    );
    expect(debate.rows).toEqual([{ id: "d-del-run" }]);
  });

  it("8. rejects a second active run on the same debate", async () => {
    await resetMemoryDatabase();
    await applyMigrations(v1v2v3);

    await insertDebate("d-active");
    await insertRun({
      id: "run-active-1",
      debateId: "d-active",
      status: "running",
    });

    const queuedError = await expectExecuteFailure(
      `INSERT INTO debate_runs (
         id, debate_id, status, model_id, evidence_snapshot_json, created_by_email
       ) VALUES (
         'run-active-2', 'd-active', 'queued', 'm', '[]', 'owner@example.test'
       )`,
    );
    expect(isUniqueViolation(queuedError)).toBe(true);

    const runningError = await expectExecuteFailure(
      `INSERT INTO debate_runs (
         id, debate_id, status, model_id, evidence_snapshot_json, created_by_email
       ) VALUES (
         'run-active-3', 'd-active', 'running', 'm', '[]', 'owner@example.test'
       )`,
    );
    expect(isUniqueViolation(runningError)).toBe(true);
  });

  it("9. allows active runs on different debates", async () => {
    await resetMemoryDatabase();
    await applyMigrations(v1v2v3);

    await insertDebate("d-a1");
    await insertDebate("d-a2");
    await insertRun({ id: "run-a1", debateId: "d-a1", status: "running" });
    await insertRun({ id: "run-a2", debateId: "d-a2", status: "queued" });

    const { rows } = await getDbExec().execute(
      `SELECT id FROM debate_runs WHERE status IN ('queued', 'running') ORDER BY id`,
    );
    expect(rows).toEqual([{ id: "run-a1" }, { id: "run-a2" }]);
  });

  it("10. allows multiple completed/failed historical runs", async () => {
    await resetMemoryDatabase();
    await applyMigrations(v1v2v3);

    await insertDebate("d-hist");
    await insertRun({ id: "run-h1", debateId: "d-hist", status: "completed" });
    await insertRun({ id: "run-h2", debateId: "d-hist", status: "failed" });
    await insertRun({ id: "run-h3", debateId: "d-hist", status: "completed" });

    const { rows } = await getDbExec().execute(
      `SELECT id, status FROM debate_runs WHERE debate_id = 'd-hist' ORDER BY id`,
    );
    expect(rows).toEqual([
      { id: "run-h1", status: "completed" },
      { id: "run-h2", status: "failed" },
      { id: "run-h3", status: "completed" },
    ]);
  });

  it("11. after active run finishes, a new active run can start", async () => {
    await resetMemoryDatabase();
    await applyMigrations(v1v2v3);

    await insertDebate("d-reuse");
    await insertRun({ id: "run-old", debateId: "d-reuse", status: "running" });
    await getDbExec().execute(
      `UPDATE debate_runs SET status = 'completed' WHERE id = 'run-old'`,
    );
    await insertRun({ id: "run-new", debateId: "d-reuse", status: "running" });

    const { rows } = await getDbExec().execute(
      `SELECT id, status FROM debate_runs WHERE debate_id = 'd-reuse' ORDER BY id`,
    );
    expect(rows).toEqual([
      { id: "run-new", status: "running" },
      { id: "run-old", status: "completed" },
    ]);
  });

  it("12-13. UNIQUE(run_id, role) and distinct roles allowed", async () => {
    await resetMemoryDatabase();
    await applyMigrations(v1v2v3);

    await insertDebate("d-roles");
    await insertRun({ id: "run-roles", debateId: "d-roles", status: "running" });
    await insertMessage({
      id: "msg-pro",
      runId: "run-roles",
      role: "proponent",
    });
    await insertMessage({
      id: "msg-opp",
      runId: "run-roles",
      role: "opponent",
    });
    await insertMessage({
      id: "msg-judge",
      runId: "run-roles",
      role: "judge",
    });

    const dup = await expectExecuteFailure(
      `INSERT INTO debate_messages (
         id, run_id, role, payload_json, cited_external_ids_json
       ) VALUES (
         'msg-pro-dup', 'run-roles', 'proponent', '{}', '[]'
       )`,
    );
    expect(isUniqueViolation(dup)).toBe(true);

    const { rows } = await getDbExec().execute(
      `SELECT role FROM debate_messages WHERE run_id = 'run-roles' ORDER BY role`,
    );
    expect(rows).toEqual([
      { role: "judge" },
      { role: "opponent" },
      { role: "proponent" },
    ]);
  });

  it("14. invalid debateId / runId violate foreign keys", async () => {
    await resetMemoryDatabase();
    await applyMigrations(v1v2v3);

    await expectExecuteFailure(
      `INSERT INTO debate_runs (
         id, debate_id, status, model_id, evidence_snapshot_json, created_by_email
       ) VALUES (
         'run-bad-debate', 'no-such-debate', 'running', 'm', '[]', 'owner@example.test'
       )`,
    );

    await insertDebate("d-fk-msg");
    await insertRun({
      id: "run-fk-ok",
      debateId: "d-fk-msg",
      status: "running",
    });
    await expectExecuteFailure(
      `INSERT INTO debate_messages (
         id, run_id, role, payload_json, cited_external_ids_json
       ) VALUES (
         'msg-bad-run', 'no-such-run', 'judge', '{}', '[]'
       )`,
    );
  });

  it("15. reports whether status/role CHECK constraints exist", async () => {
    await resetMemoryDatabase();
    await applyMigrations(v1v2v3);

    const runChecks = await listCheckConstraints("debate_runs");
    const messageChecks = await listCheckConstraints("debate_messages");

    // PGlite may surface NOT NULL as CHECK (... IS NOT NULL). Filter those out
    // and look only for enum-style value constraints on status/role.
    const isNotNullOnly = (clause: string | null) =>
      !!clause && /^\w+\s+IS\s+NOT\s+NULL$/i.test(clause.trim());
    const enumLike = (clause: string | null, column: string) =>
      !!clause &&
      !isNotNullOnly(clause) &&
      new RegExp(column, "i").test(clause) &&
      /(IN\s*\(|=~|ANY\s*\()/i.test(clause);

    const statusEnums = runChecks.filter((row) =>
      enumLike(row.check_clause, "status"),
    );
    const roleEnums = messageChecks.filter((row) =>
      enumLike(row.check_clause, "role"),
    );

    // v3 intentionally has no DB enum CHECK; application validates values.
    expect(statusEnums).toEqual([]);
    expect(roleEnums).toEqual([]);

    // Document observed NOT NULL CHECK surrogates for the report (not a failure).
    expect(
      runChecks.some(
        (row) =>
          row.constraint_name === "debate_runs_status_not_null" &&
          isNotNullOnly(row.check_clause),
      ),
    ).toBe(true);
  });

  it("16. schema.ts field names match migrated SQL columns", async () => {
    await resetMemoryDatabase();
    await applyMigrations(v1v2v3);

    const runCols = (await tableColumns("debate_runs")).map(
      (column) => column.column_name,
    );
    const messageCols = (await tableColumns("debate_messages")).map(
      (column) => column.column_name,
    );

    expect(runCols).toEqual([
      "id",
      "debate_id",
      "status",
      "model_id",
      "evidence_snapshot_json",
      "created_by_email",
      "created_at",
      "started_at",
      "finished_at",
      "updated_at",
      "heartbeat_at",
      "error_message",
    ]);
    expect(messageCols).toEqual([
      "id",
      "run_id",
      "role",
      "payload_json",
      "cited_external_ids_json",
      "created_at",
    ]);

    const indexes = await getDbExec().execute(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN (
           'debate_runs_one_active_uidx',
           'debate_messages_run_id_role_uidx'
         )
       ORDER BY indexname`,
    );
    expect(indexes.rows.map((row) => String(row.indexname))).toEqual([
      "debate_messages_run_id_role_uidx",
      "debate_runs_one_active_uidx",
    ]);
  });

  it("17. v3 does not disturb v1/v2 tables or existing debate data", async () => {
    await resetMemoryDatabase();
    await applyMigrations(v1v2);

    await insertDebate("d-pre-v3", "Pre-v3 claim");
    await getDbExec().execute({
      sql: `INSERT INTO papers (id, source, external_id, provider_url, title)
            VALUES ('p-pre-v3', 'openalex', 'W900', 'https://openalex.org/W900', 'Keep')`,
    });
    await getDbExec().execute({
      sql: `INSERT INTO debate_papers (id, debate_id, paper_id, added_by_email)
            VALUES ('link-pre-v3', 'd-pre-v3', 'p-pre-v3', 'owner@example.test')`,
    });

    await applyMigrations(v1v2v3);

    const debate = await getDbExec().execute(
      `SELECT claim FROM debates WHERE id = 'd-pre-v3'`,
    );
    const paper = await getDbExec().execute(
      `SELECT title FROM papers WHERE id = 'p-pre-v3'`,
    );
    const link = await getDbExec().execute(
      `SELECT id FROM debate_papers WHERE id = 'link-pre-v3'`,
    );
    expect(debate.rows).toEqual([{ claim: "Pre-v3 claim" }]);
    expect(paper.rows).toEqual([{ title: "Keep" }]);
    expect(link.rows).toEqual([{ id: "link-pre-v3" }]);

    // Prior v2 unique behavior still holds after v3.
    const paperDup = await expectExecuteFailure(
      `INSERT INTO papers (id, source, external_id, provider_url)
       VALUES ('p-pre-v3-dup', 'openalex', 'W900', 'https://openalex.org/W900')`,
    );
    expect(isUniqueViolation(paperDup)).toBe(true);
  });
});

describe("debates app migrations v4 debates_current_run_id (memory PGlite)", () => {
  afterAll(async () => {
    await closeDbExec();
  });

  it("1. empty DB applies v1→v4 and records named versions", async () => {
    await resetMemoryDatabase();
    await applyMigrations(v1v2v3v4);

    const versions = await getDbExec().execute(
      `SELECT version FROM ${DEBATES_APP_MIGRATIONS_TABLE} ORDER BY version`,
    );
    expect(versions.rows.map((row) => Number(row.version))).toEqual([
      1, 2, 3, 4,
    ]);

    const named = await getDbExec().execute(
      `SELECT name FROM ${DEBATES_APP_MIGRATIONS_TABLE}_named ORDER BY version`,
    );
    expect(named.rows.map((row) => String(row.name))).toEqual([
      "debates",
      "papers_and_debate_papers",
      "debate_runs_and_messages",
      "debates_current_run_id",
    ]);
  });

  it("2. v3→v4 adds nullable current_run_id without DEFAULT/FK/index", async () => {
    await resetMemoryDatabase();
    await applyMigrations(v1v2v3);
    await applyMigrations(v1v2v3v4);

    const columns = await tableColumns("debates");
    const currentRunId = columns.find(
      (column) => column.column_name === "current_run_id",
    );
    expect(currentRunId).toBeTruthy();
    expect(currentRunId?.is_nullable).toBe("YES");
    expect(currentRunId?.column_default).toBeNull();

    const fk = await getDbExec().execute(
      `SELECT tc.constraint_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       WHERE tc.table_schema = 'public'
         AND tc.table_name = 'debates'
         AND tc.constraint_type = 'FOREIGN KEY'
         AND kcu.column_name = 'current_run_id'`,
    );
    expect(fk.rows).toEqual([]);

    const indexes = await getDbExec().execute(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'debates'
         AND indexdef ILIKE '%current_run_id%'`,
    );
    expect(indexes.rows).toEqual([]);
  });

  it("3. historical debates keep data and current_run_id NULL after v4", async () => {
    await resetMemoryDatabase();
    await applyMigrations(v1v2v3);

    await insertDebate("d-pre-v4", "Pre-v4 claim");
    await insertRun({
      id: "run-pre-v4",
      debateId: "d-pre-v4",
      status: "completed",
    });

    await applyMigrations(v1v2v3v4);

    const debate = await getDbExec().execute(
      `SELECT claim, current_run_id FROM debates WHERE id = 'd-pre-v4'`,
    );
    expect(debate.rows).toEqual([
      { claim: "Pre-v4 claim", current_run_id: null },
    ]);

    const run = await getDbExec().execute(
      `SELECT status FROM debate_runs WHERE id = 'run-pre-v4'`,
    );
    expect(run.rows).toEqual([{ status: "completed" }]);
  });

  it("4. re-running v1–v4 is a no-op and does not re-execute v4", async () => {
    await resetMemoryDatabase();
    await applyMigrations(v1v2v3v4);

    await insertDebate("d-v4-idem", "Survive re-run");
    await getDbExec().execute({
      sql: `UPDATE debates SET current_run_id = 'run-keep' WHERE id = 'd-v4-idem'`,
    });

    await applyMigrations(v1v2v3v4);
    await applyMigrations(v1v2v3v4);

    const versions = await getDbExec().execute(
      `SELECT version FROM ${DEBATES_APP_MIGRATIONS_TABLE} ORDER BY version`,
    );
    expect(versions.rows.map((row) => Number(row.version))).toEqual([
      1, 2, 3, 4,
    ]);

    const named = await getDbExec().execute(
      `SELECT COUNT(*)::int AS n FROM ${DEBATES_APP_MIGRATIONS_TABLE}_named
       WHERE name = 'debates_current_run_id'`,
    );
    expect(Number(named.rows[0]?.n)).toBe(1);

    const debate = await getDbExec().execute(
      `SELECT claim, current_run_id FROM debates WHERE id = 'd-v4-idem'`,
    );
    expect(debate.rows).toEqual([
      { claim: "Survive re-run", current_run_id: "run-keep" },
    ]);
  });

  it("5. runner is not atomic: DDL can stick while ledger insert is skipped on later failure", async () => {
    // Documented risk: runMigrations executes SQL statements then ledger inserts
    // without a wrapping transaction. If a multi-statement migration partially
    // applies, retry can fail because the column already exists.
    await resetMemoryDatabase();
    await applyMigrations(v1v2v3);

    const partial = [
      ...v1v2v3,
      {
        version: 4,
        name: "debates_current_run_id",
        sql: `ALTER TABLE debates ADD COLUMN current_run_id TEXT;
ALTER TABLE __migration_force_fail__ ADD COLUMN x TEXT`,
      },
    ] satisfies MigrationEntry[];

    await expect(applyMigrations(partial)).rejects.toThrow();

    const column = (await tableColumns("debates")).find(
      (row) => row.column_name === "current_run_id",
    );
    expect(column).toBeTruthy();

    const versions = await getDbExec().execute(
      `SELECT version FROM ${DEBATES_APP_MIGRATIONS_TABLE} ORDER BY version`,
    );
    expect(versions.rows.map((row) => Number(row.version))).toEqual([1, 2, 3]);

    const named = await getDbExec().execute(
      `SELECT name FROM ${DEBATES_APP_MIGRATIONS_TABLE}_named
       WHERE name = 'debates_current_run_id'`,
    );
    expect(named.rows).toEqual([]);

    // Retry of the real single-statement v4 now fails: column already present.
    await expect(applyMigrations(v1v2v3v4)).rejects.toThrow(/current_run_id/i);
  });
});

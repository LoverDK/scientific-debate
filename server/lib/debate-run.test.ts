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
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { getDb, schema } from "../db/index.js";
import {
  DEBATES_APP_MIGRATIONS_TABLE,
  debatesAppMigrations,
} from "../db/migrations.js";
import type { EvidencePack } from "./debate-evidence.js";
import type { DebateRoleOutput, ProponentOutput } from "./debate-llm.js";
import {
  DebateRunActiveConflictError,
  DebateRunMessageConflictError,
  DebateRunNotEligibleError,
  DebateRunValidationError,
  claimRun,
  completeRun,
  createQueuedRun,
  failRun,
  getDebateRunById,
  parseEvidenceSnapshot,
  persistRoleMessage,
} from "./debate-run.js";

const OWNER = "owner@example.test";
const DEBATE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FIXED_NOW = "2026-01-01T00:00:00.000Z";

function assertMemoryDatabaseUrl(): void {
  if (process.env.DATABASE_URL !== "pglite:memory") {
    throw new Error(
      `Refusing to run debate-run tests: DATABASE_URL must be exactly "pglite:memory" (got ${JSON.stringify(process.env.DATABASE_URL)}). This suite must not touch ./data/pglite.`,
    );
  }
  const resolved = getDatabaseUrl();
  if (!resolved.toLowerCase().startsWith("pglite:memory")) {
    throw new Error(
      `Refusing to run debate-run tests: resolved database URL is not memory PGlite (got ${JSON.stringify(resolved)}).`,
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
  await db.delete(schema.debateMessages);
  await db.delete(schema.debateRuns);
  await db.delete(schema.debatePapers);
  await db.delete(schema.papers);
  await db.delete(schema.debates);
}

async function seedDebate(id = DEBATE_A): Promise<void> {
  await getDb().insert(schema.debates).values({
    id,
    claim: "Scaling improves reasoning.",
    inputType: "text",
    status: "pending",
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ownerEmail: OWNER,
    orgId: null,
    visibility: "private",
  });
}

function makePack(debateId = DEBATE_A): EvidencePack {
  return {
    debateId,
    claim: "Scaling improves reasoning.",
    papers: [
      {
        id: "paper-1",
        externalId: "W100",
        title: "Paper One",
        authors: ["Ada"],
        year: 2020,
        doi: null,
        url: null,
        providerUrl: "https://openalex.org/W100",
        abstract: "Abs",
        abstractTruncated: false,
        stance: null,
      },
    ],
  };
}

function proponentOutput(): ProponentOutput {
  return {
    role: "proponent",
    summary: "Proponent summary",
    arguments: [
      {
        claim: "Supports",
        support: "Because W100",
        citedExternalIds: ["W100"],
      },
    ],
    citedExternalIds: ["W100"],
  };
}

async function getDebateStatus(id = DEBATE_A): Promise<string> {
  const [row] = await getDb()
    .select({ status: schema.debates.status })
    .from(schema.debates)
    .where(eq(schema.debates.id, id))
    .limit(1);
  return row?.status ?? "";
}

async function getDebateMirror(
  id = DEBATE_A,
): Promise<{ status: string; currentRunId: string | null }> {
  const [row] = await getDb()
    .select({
      status: schema.debates.status,
      currentRunId: schema.debates.currentRunId,
    })
    .from(schema.debates)
    .where(eq(schema.debates.id, id))
    .limit(1);
  return {
    status: row?.status ?? "",
    currentRunId: row?.currentRunId ?? null,
  };
}

async function countMessages(runId: string): Promise<number> {
  const { rows } = await getDbExec().execute({
    sql: `SELECT COUNT(*)::int AS n FROM debate_messages WHERE run_id = ?`,
    args: [runId],
  });
  return Number(rows[0]?.n ?? 0);
}

async function expectError(
  run: Promise<unknown>,
  ErrorClass: new (...args: never[]) => Error,
  code: string,
): Promise<Error> {
  try {
    await run;
    expect.fail(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ErrorClass);
    expect(error).toMatchObject({ code });
    const message = String((error as Error).message);
    expect(message).not.toMatch(/password|secret|api[_-]?key|postgres:\/\//i);
    return error as Error;
  }
  throw new Error("unreachable");
}

describe("debate-run state machine", () => {
  beforeAll(async () => {
    assertMemoryDatabaseUrl();
    await closeDbExec();
    await applyAppMigrations();
  });

  beforeEach(async () => {
    assertMemoryDatabaseUrl();
    await clearAppTables();
    await seedDebate();
  });

  afterAll(async () => {
    await closeDbExec();
  });

  it("queued �?running �?completed happy path", async () => {
    const db = getDb();
    const pack = makePack();
    const queued = await createQueuedRun({
      db,
      debateId: DEBATE_A,
      modelId: "openai/gpt-4o-mini",
      evidencePack: pack,
      createdByEmail: OWNER,
    });
    expect(queued.status).toBe("queued");
    expect(await getDebateMirror()).toEqual({
      status: "debating",
      currentRunId: queued.id,
    });

    const running = await claimRun({ db, runId: queued.id });
    expect(running.status).toBe("running");
    expect(running.startedAt).toBeTruthy();
    expect(running.heartbeatAt).toBeTruthy();

    await persistRoleMessage({
      db,
      runId: queued.id,
      role: "proponent",
      output: proponentOutput(),
    });
    expect(await countMessages(queued.id)).toBe(1);

    const completed = await completeRun({ db, runId: queued.id });
    expect(completed.status).toBe("completed");
    expect(completed.finishedAt).toBeTruthy();
    expect(await getDebateMirror()).toEqual({
      status: "completed",
      currentRunId: queued.id,
    });
    expect(await countMessages(queued.id)).toBe(1);
  });

  it("createQueuedRun sets current_run_id ownership", async () => {
    const db = getDb();
    const queued = await createQueuedRun({
      db,
      debateId: DEBATE_A,
      modelId: "m",
      evidencePack: makePack(),
      createdByEmail: OWNER,
    });
    expect(await getDebateMirror()).toEqual({
      status: "debating",
      currentRunId: queued.id,
    });
  });

  it("queued �?failed preserves no messages requirement and sets mirror", async () => {
    const db = getDb();
    const queued = await createQueuedRun({
      db,
      debateId: DEBATE_A,
      modelId: "openai/gpt-4o-mini",
      evidencePack: makePack(),
      createdByEmail: OWNER,
    });
    const failed = await failRun({
      db,
      runId: queued.id,
      errorMessage: "aborted before start",
    });
    expect(failed.status).toBe("failed");
    expect(failed.errorMessage).toBe("aborted before start");
    expect(await getDebateStatus()).toBe("failed");
  });

  it("running �?failed keeps existing messages", async () => {
    const db = getDb();
    const queued = await createQueuedRun({
      db,
      debateId: DEBATE_A,
      modelId: "m",
      evidencePack: makePack(),
      createdByEmail: OWNER,
    });
    await claimRun({ db, runId: queued.id });
    await persistRoleMessage({
      db,
      runId: queued.id,
      role: "proponent",
      output: proponentOutput(),
    });
    const failed = await failRun({
      db,
      runId: queued.id,
      errorMessage: "opponent failed",
    });
    expect(failed.status).toBe("failed");
    expect(await countMessages(queued.id)).toBe(1);
    expect(await getDebateStatus()).toBe("failed");
  });

  it("completed cannot be failed again", async () => {
    const db = getDb();
    const queued = await createQueuedRun({
      db,
      debateId: DEBATE_A,
      modelId: "m",
      evidencePack: makePack(),
      createdByEmail: OWNER,
    });
    await claimRun({ db, runId: queued.id });
    await completeRun({ db, runId: queued.id });
    await expectError(
      failRun({ db, runId: queued.id, errorMessage: "nope" }),
      DebateRunNotEligibleError,
      "debate_run_not_eligible",
    );
    expect((await getDebateRunById(db, queued.id))?.status).toBe("completed");
  });

  it("failed cannot be claimed running again", async () => {
    const db = getDb();
    const queued = await createQueuedRun({
      db,
      debateId: DEBATE_A,
      modelId: "m",
      evidencePack: makePack(),
      createdByEmail: OWNER,
    });
    await failRun({ db, runId: queued.id, errorMessage: "stop" });
    await expectError(
      claimRun({ db, runId: queued.id }),
      DebateRunNotEligibleError,
      "debate_run_not_eligible",
    );
  });

  it("active run uniqueness via partial unique index", async () => {
    const db = getDb();
    await createQueuedRun({
      db,
      debateId: DEBATE_A,
      modelId: "m",
      evidencePack: makePack(),
      createdByEmail: OWNER,
    });
    await expectError(
      createQueuedRun({
        db,
        debateId: DEBATE_A,
        modelId: "m2",
        evidencePack: makePack(),
        createdByEmail: OWNER,
      }),
      DebateRunActiveConflictError,
      "debate_run_active_conflict",
    );
  });

  it("after completed, a new queued run can be created and takes over mirror", async () => {
    const db = getDb();
    const first = await createQueuedRun({
      db,
      debateId: DEBATE_A,
      modelId: "m",
      evidencePack: makePack(),
      createdByEmail: OWNER,
    });
    await claimRun({ db, runId: first.id });
    await completeRun({ db, runId: first.id });
    expect(await getDebateMirror()).toEqual({
      status: "completed",
      currentRunId: first.id,
    });

    const second = await createQueuedRun({
      db,
      debateId: DEBATE_A,
      modelId: "m2",
      evidencePack: makePack(),
      createdByEmail: OWNER,
    });
    expect(second.status).toBe("queued");
    expect(second.id).not.toBe(first.id);
    expect(await getDebateMirror()).toEqual({
      status: "debating",
      currentRunId: second.id,
    });
  });

  it("role message persists and duplicate role conflicts", async () => {
    const db = getDb();
    const queued = await createQueuedRun({
      db,
      debateId: DEBATE_A,
      modelId: "m",
      evidencePack: makePack(),
      createdByEmail: OWNER,
    });
    await claimRun({ db, runId: queued.id });
    const msg = await persistRoleMessage({
      db,
      runId: queued.id,
      role: "proponent",
      usage: { inputTokens: 103, outputTokens: 24, costUsd: 0 },
      output: proponentOutput(),
    });
    const [saved] = await db.select().from(schema.debateMessages).where(eq(schema.debateMessages.id, msg.id));
    expect(JSON.parse(saved!.usageJson!)).toEqual({inputTokens: 103, outputTokens: 24, costUsd: 0});
    expect(msg.role).toBe("proponent");
    const payload = JSON.parse(msg.payloadJson) as DebateRoleOutput;
    expect(payload.role).toBe("proponent");

    const beforeHeartbeat = (await getDebateRunById(db, queued.id))!
      .heartbeatAt;

    await expectError(
      persistRoleMessage({
        db,
        runId: queued.id,
        role: "proponent",
        output: proponentOutput(),
      }),
      DebateRunMessageConflictError,
      "debate_run_message_conflict",
    );

    // Conflict rolls back the second heartbeat attempt; first message remains.
    expect(await countMessages(queued.id)).toBe(1);
    const after = await getDebateRunById(db, queued.id);
    expect(after?.heartbeatAt).toBe(beforeHeartbeat);
  });

  it("non-running run rejects message writes", async () => {
    const db = getDb();
    const queued = await createQueuedRun({
      db,
      debateId: DEBATE_A,
      modelId: "m",
      evidencePack: makePack(),
      createdByEmail: OWNER,
    });
    await expectError(
      persistRoleMessage({
        db,
        runId: queued.id,
        role: "proponent",
        output: proponentOutput(),
      }),
      DebateRunNotEligibleError,
      "debate_run_not_eligible",
    );
    expect(await countMessages(queued.id)).toBe(0);
  });

  it("lost eligibility: old run finalize does not overwrite newer mirror", async () => {
    const db = getDb();
    const older = await createQueuedRun({
      db,
      debateId: DEBATE_A,
      modelId: "old",
      evidencePack: makePack(),
      createdByEmail: OWNER,
    });
    await claimRun({ db, runId: older.id });
    await persistRoleMessage({
      db,
      runId: older.id,
      role: "proponent",
      output: proponentOutput(),
    });

    // Terminalize older, then create and complete a newer run.
    await failRun({
      db,
      runId: older.id,
      errorMessage: "simulated reclaim",
    });
    expect(await getDebateMirror()).toEqual({
      status: "failed",
      currentRunId: older.id,
    });

    const newer = await createQueuedRun({
      db,
      debateId: DEBATE_A,
      modelId: "new",
      evidencePack: makePack(),
      createdByEmail: OWNER,
    });
    await claimRun({ db, runId: newer.id });
    await completeRun({ db, runId: newer.id });
    expect(await getDebateMirror()).toEqual({
      status: "completed",
      currentRunId: newer.id,
    });

    // Old run cannot complete/fail again; mirror stays completed.
    await expectError(
      completeRun({ db, runId: older.id }),
      DebateRunNotEligibleError,
      "debate_run_not_eligible",
    );
    await expectError(
      failRun({ db, runId: older.id, errorMessage: "late fail" }),
      DebateRunNotEligibleError,
      "debate_run_not_eligible",
    );
    expect(await getDebateMirror()).toEqual({
      status: "completed",
      currentRunId: newer.id,
    });
    expect(await countMessages(older.id)).toBe(1);
  });

  it("completeRun only updates mirror owned by current_run_id", async () => {
    const db = getDb();
    const older = await createQueuedRun({
      db,
      debateId: DEBATE_A,
      modelId: "old",
      evidencePack: makePack(),
      createdByEmail: OWNER,
    });
    await claimRun({ db, runId: older.id });
    await failRun({
      db,
      runId: older.id,
      errorMessage: "first fail",
    });

    const newer = await createQueuedRun({
      db,
      debateId: DEBATE_A,
      modelId: "new",
      evidencePack: makePack(),
      createdByEmail: OWNER,
    });
    await claimRun({ db, runId: newer.id });
    await completeRun({ db, runId: newer.id });
    expect(await getDebateMirror()).toEqual({
      status: "completed",
      currentRunId: newer.id,
    });

    // Resurrect older as running (newer is terminal, so unique allows it).
    await getDbExec().execute({
      sql: `UPDATE debate_runs SET status = 'running', finished_at = NULL, error_message = NULL WHERE id = ?`,
      args: [older.id],
    });

    const completedOlder = await completeRun({ db, runId: older.id });
    expect(completedOlder.status).toBe("completed");
    expect(await getDebateMirror()).toEqual({
      status: "completed",
      currentRunId: newer.id,
    });
  });

  it("failRun only updates mirror owned by current_run_id", async () => {
    const db = getDb();
    const older = await createQueuedRun({
      db,
      debateId: DEBATE_A,
      modelId: "old",
      evidencePack: makePack(),
      createdByEmail: OWNER,
    });
    await claimRun({ db, runId: older.id });
    await failRun({
      db,
      runId: older.id,
      errorMessage: "first fail",
    });

    const newer = await createQueuedRun({
      db,
      debateId: DEBATE_A,
      modelId: "new",
      evidencePack: makePack(),
      createdByEmail: OWNER,
    });
    await claimRun({ db, runId: newer.id });
    await completeRun({ db, runId: newer.id });
    expect(await getDebateMirror()).toEqual({
      status: "completed",
      currentRunId: newer.id,
    });

    // Resurrect older; failRun terminalizes it but must not clobber newer mirror.
    await getDbExec().execute({
      sql: `UPDATE debate_runs SET status = 'running', finished_at = NULL, error_message = NULL WHERE id = ?`,
      args: [older.id],
    });

    const failedAgain = await failRun({
      db,
      runId: older.id,
      errorMessage: "late fail after newer completed",
    });
    expect(failedAgain.status).toBe("failed");
    expect(await getDebateMirror()).toEqual({
      status: "completed",
      currentRunId: newer.id,
    });
  });

  it("same created_at does not matter: current_run_id fence still holds", async () => {
    const db = getDb();
    const older = await createQueuedRun({
      db,
      debateId: DEBATE_A,
      modelId: "old",
      evidencePack: makePack(),
      createdByEmail: OWNER,
    });
    await claimRun({ db, runId: older.id });
    await failRun({
      db,
      runId: older.id,
      errorMessage: "first fail",
    });

    const newer = await createQueuedRun({
      db,
      debateId: DEBATE_A,
      modelId: "new",
      evidencePack: makePack(),
      createdByEmail: OWNER,
    });
    await claimRun({ db, runId: newer.id });
    await completeRun({ db, runId: newer.id });

    // Force identical created_at �?the old created_at fence would be ambiguous.
    await getDbExec().execute({
      sql: `UPDATE debate_runs SET created_at = ? WHERE id IN (?, ?)`,
      args: [FIXED_NOW, older.id, newer.id],
    });
    const createdAts = await getDbExec().execute({
      sql: `SELECT id, created_at FROM debate_runs WHERE id IN (?, ?) ORDER BY id`,
      args: [older.id, newer.id],
    });
    expect(createdAts.rows.map((row) => String(row.created_at))).toEqual([
      FIXED_NOW,
      FIXED_NOW,
    ]);

    await getDbExec().execute({
      sql: `UPDATE debate_runs SET status = 'running', finished_at = NULL, error_message = NULL WHERE id = ?`,
      args: [older.id],
    });
    await failRun({
      db,
      runId: older.id,
      errorMessage: "late fail same created_at",
    });
    expect(await getDebateMirror()).toEqual({
      status: "completed",
      currentRunId: newer.id,
    });
  });

  it("old run cannot overwrite new run mirror while new still owns debating", async () => {
    const db = getDb();
    const older = await createQueuedRun({
      db,
      debateId: DEBATE_A,
      modelId: "old",
      evidencePack: makePack(),
      createdByEmail: OWNER,
    });
    await failRun({
      db,
      runId: older.id,
      errorMessage: "stop older",
    });
    const newer = await createQueuedRun({
      db,
      debateId: DEBATE_A,
      modelId: "new",
      evidencePack: makePack(),
      createdByEmail: OWNER,
    });
    expect(await getDebateMirror()).toEqual({
      status: "debating",
      currentRunId: newer.id,
    });

    // Keep mirror ownership on newer, but terminalize newer at the run row so
    // the partial unique index allows resurrecting older as running.
    await getDbExec().execute({
      sql: `UPDATE debate_runs SET status = 'completed', finished_at = ?, updated_at = ? WHERE id = ?`,
      args: [FIXED_NOW, FIXED_NOW, newer.id],
    });
    await getDbExec().execute({
      sql: `UPDATE debate_runs SET status = 'running', finished_at = NULL, error_message = NULL WHERE id = ?`,
      args: [older.id],
    });

    await completeRun({ db, runId: older.id });
    expect(await getDebateMirror()).toEqual({
      status: "debating",
      currentRunId: newer.id,
    });
  });

  it("repeat terminal calls do not change mirror", async () => {
    const db = getDb();
    const queued = await createQueuedRun({
      db,
      debateId: DEBATE_A,
      modelId: "m",
      evidencePack: makePack(),
      createdByEmail: OWNER,
    });
    await claimRun({ db, runId: queued.id });
    await completeRun({ db, runId: queued.id });
    const mirrorAfter = await getDebateMirror();
    expect(mirrorAfter).toEqual({
      status: "completed",
      currentRunId: queued.id,
    });

    await expectError(
      completeRun({ db, runId: queued.id }),
      DebateRunNotEligibleError,
      "debate_run_not_eligible",
    );
    await expectError(
      failRun({ db, runId: queued.id, errorMessage: "again" }),
      DebateRunNotEligibleError,
      "debate_run_not_eligible",
    );
    expect(await getDebateMirror()).toEqual(mirrorAfter);
  });

  it("createQueuedRun conflict rolls back without changing mirror ownership", async () => {
    const db = getDb();
    const first = await createQueuedRun({
      db,
      debateId: DEBATE_A,
      modelId: "m",
      evidencePack: makePack(),
      createdByEmail: OWNER,
    });
    const before = await getDebateMirror();
    expect(before.currentRunId).toBe(first.id);

    await expectError(
      createQueuedRun({
        db,
        debateId: DEBATE_A,
        modelId: "m2",
        evidencePack: makePack(),
        createdByEmail: OWNER,
      }),
      DebateRunActiveConflictError,
      "debate_run_active_conflict",
    );

    const { rows } = await getDbExec().execute(
      `SELECT COUNT(*)::int AS n FROM debate_runs WHERE debate_id = '${DEBATE_A}'`,
    );
    expect(Number(rows[0]?.n)).toBe(1);
    expect(await getDebateMirror()).toEqual(before);
  });

  it("EvidencePack snapshot round-trips and rejects mismatched debateId", async () => {
    const db = getDb();
    const pack = makePack();
    const queued = await createQueuedRun({
      db,
      debateId: DEBATE_A,
      modelId: "m",
      evidencePack: pack,
      createdByEmail: OWNER,
    });
    const snap = parseEvidenceSnapshot(queued.evidenceSnapshotJson);
    expect(snap).toEqual(pack);
    expect(snap).not.toBe(pack);

    await expectError(
      createQueuedRun({
        db,
        debateId: DEBATE_A,
        modelId: "m",
        evidencePack: makePack("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
        createdByEmail: OWNER,
      }),
      DebateRunValidationError,
      "debate_run_validation_error",
    );
  });

  it("claim is not repeatable", async () => {
    const db = getDb();
    const queued = await createQueuedRun({
      db,
      debateId: DEBATE_A,
      modelId: "m",
      evidencePack: makePack(),
      createdByEmail: OWNER,
    });
    await claimRun({ db, runId: queued.id });
    await expectError(
      claimRun({ db, runId: queued.id }),
      DebateRunNotEligibleError,
      "debate_run_not_eligible",
    );
  });

  it("message write rolls back when run loses eligibility mid-flight is covered by non-running guard", async () => {
    const db = getDb();
    const queued = await createQueuedRun({
      db,
      debateId: DEBATE_A,
      modelId: "m",
      evidencePack: makePack(),
      createdByEmail: OWNER,
    });
    await claimRun({ db, runId: queued.id });
    await failRun({ db, runId: queued.id, errorMessage: "killed" });
    await expectError(
      persistRoleMessage({
        db,
        runId: queued.id,
        role: "proponent",
        output: proponentOutput(),
      }),
      DebateRunNotEligibleError,
      "debate_run_not_eligible",
    );
    expect(await countMessages(queued.id)).toBe(0);
  });

  it("concurrent-ish: two createQueuedRun against same debate �?one wins", async () => {
    // Limitation: memory PGlite is a single embedded engine; Promise.all still
    // serializes through one connection pool. This checks conflict mapping under
    // overlapping awaits, not true multi-process / multi-connection concurrency.
    const db = getDb();
    const results = await Promise.allSettled([
      createQueuedRun({
        db,
        debateId: DEBATE_A,
        modelId: "a",
        evidencePack: makePack(),
        createdByEmail: OWNER,
      }),
      createQueuedRun({
        db,
        debateId: DEBATE_A,
        modelId: "b",
        evidencePack: makePack(),
        createdByEmail: OWNER,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.status).toBe("rejected");
    if (rejected[0]?.status === "rejected") {
      expect(rejected[0].reason).toBeInstanceOf(DebateRunActiveConflictError);
    }

    const winner = fulfilled[0];
    expect(winner?.status).toBe("fulfilled");
    if (winner?.status === "fulfilled") {
      expect(await getDebateMirror()).toEqual({
        status: "debating",
        currentRunId: winner.value.id,
      });
    }

    const { rows } = await getDbExec().execute(
      `SELECT COUNT(*)::int AS n FROM debate_runs WHERE debate_id = '${DEBATE_A}'`,
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it("create vs terminal race: finishing then creating transfers ownership", async () => {
    const db = getDb();
    const first = await createQueuedRun({
      db,
      debateId: DEBATE_A,
      modelId: "first",
      evidencePack: makePack(),
      createdByEmail: OWNER,
    });
    await claimRun({ db, runId: first.id });

    const [completed, second] = await Promise.all([
      completeRun({ db, runId: first.id }),
      createQueuedRun({
        db,
        debateId: DEBATE_A,
        modelId: "second",
        evidencePack: makePack(),
        createdByEmail: OWNER,
      }).catch((error: unknown) => error),
    ]);

    expect(completed.status).toBe("completed");

    // Depending on interleaving, second create may succeed after terminalization
    // or hit active conflict if it raced before complete committed.
    if (second instanceof DebateRunActiveConflictError) {
      // Retry after first is definitely terminal.
      const retry = await createQueuedRun({
        db,
        debateId: DEBATE_A,
        modelId: "second-retry",
        evidencePack: makePack(),
        createdByEmail: OWNER,
      });
      expect(await getDebateMirror()).toEqual({
        status: "debating",
        currentRunId: retry.id,
      });
    } else {
      expect(second).toMatchObject({ status: "queued" });
      const created = second as { id: string };
      expect(await getDebateMirror()).toEqual({
        status: "debating",
        currentRunId: created.id,
      });
    }
  });

  it("old run terminal write after new run created does not steal mirror", async () => {
    const db = getDb();
    const older = await createQueuedRun({
      db,
      debateId: DEBATE_A,
      modelId: "old",
      evidencePack: makePack(),
      createdByEmail: OWNER,
    });
    await claimRun({ db, runId: older.id });
    await failRun({
      db,
      runId: older.id,
      errorMessage: "park older",
    });

    const newer = await createQueuedRun({
      db,
      debateId: DEBATE_A,
      modelId: "new",
      evidencePack: makePack(),
      createdByEmail: OWNER,
    });

    await getDbExec().execute({
      sql: `UPDATE debate_runs SET status = 'completed', finished_at = ?, updated_at = ? WHERE id = ?`,
      args: [FIXED_NOW, FIXED_NOW, newer.id],
    });
    await getDbExec().execute({
      sql: `UPDATE debate_runs SET status = 'running', finished_at = NULL, error_message = NULL WHERE id = ?`,
      args: [older.id],
    });

    await Promise.all([
      completeRun({ db, runId: older.id }),
      failRun({
        db,
        runId: older.id,
        errorMessage: "should lose the race or be ineligible",
      }).catch(() => undefined),
    ]);

    expect(await getDebateMirror()).toEqual({
      status: "debating",
      currentRunId: newer.id,
    });
  });
});

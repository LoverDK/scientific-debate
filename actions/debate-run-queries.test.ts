import { closeDbExec, getDatabaseUrl, getMigrationDatabaseUrl, runMigrations, withMigrationRuntime } from "@agent-native/core/db";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { getDb, schema } from "../server/db/index.js";
import { DEBATES_APP_MIGRATIONS_TABLE, debatesAppMigrations } from "../server/db/migrations.js";
import getRun from "./get-debate-run.js";
import listRuns from "./list-debate-runs.js";
import getResult from "./get-debate-result.js";
import exportRun from "./export-debate-run.js";

const owner = { caller: "cli" as const, userEmail: "owner@example.test" };
const other = { ...owner, userEmail: "other@example.test" };
const pack = { debateId: "mine", claim: "A", papers: [] };
const output = { role: "proponent", summary: "A", arguments: [{ claim: "A", support: "B", citedExternalIds: [] }], citedExternalIds: [] };

beforeAll(async () => {
  if ([process.env.DATABASE_URL, getDatabaseUrl(), getMigrationDatabaseUrl()].some(url => url !== "pglite:memory")) {
    throw new Error("Run query tests require memory PGlite.");
  }
  await withMigrationRuntime(async () => {
    await runMigrations(debatesAppMigrations, { table: DEBATES_APP_MIGRATIONS_TABLE })(undefined);
  });
  const db = getDb();
  await db.insert(schema.debates).values(["mine", "empty"].map(id => ({ id, ownerEmail: owner.userEmail, claim: "A" })));
  const base = { debateId: "mine", modelId: "test", evidenceSnapshotJson: JSON.stringify(pack), createdByEmail: owner.userEmail };
  await db.insert(schema.debateRuns).values([
    { ...base, id: "first", status: "failed", errorMessage: "historical sensitive details", createdAt: "2026-01-01" },
    { ...base, id: "second", status: "running", createdAt: "2026-01-02" },
  ]);
  await db.insert(schema.debateMessages).values({ id: "partial", runId: "first", role: output.role, payloadJson: JSON.stringify(output), citedExternalIdsJson: "[]" });
});
afterAll(async () => { await closeDbExec(); });
beforeEach(() => vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden"); })));
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

it("returns newest first and distinguishes an owned empty debate", async () => {
  const result = await listRuns.run({ debateId: "mine" }, owner);
  expect(result.runs.map(r => r.id)).toEqual(["second", "first"]);
  expect(result.runs[1]).not.toHaveProperty("errorMessage");
  expect(result.runs[1]?.errorSummary).toBe(
    "This debate run failed. Start a new run after fixing evidence or credentials.",
  );
  expect(result.activeRunId).toBe("second");
  expect(result.runs[0].isActive).toBe(true);
  expect(await listRuns.run({ debateId: "empty" }, owner)).toEqual({
    runs: [],
    nextCursor: null,
    activeRunId: null,
  });
});

it("reports an active run across cursor pages and returns null once it is terminal", async () => {
  const db = getDb();
  await db.insert(schema.debates).values({ id: "active-pages", claim: "A", ownerEmail: owner.userEmail, currentRunId: "active-current" });
  await db.insert(schema.debateRuns).values(Array.from({ length: 22 }, (_, i) => ({
    id: i === 0 ? "active-current" : `active-history-${i}`, debateId: "active-pages",
    status: i === 0 ? "running" : "completed", modelId: "test", createdByEmail: owner.userEmail,
    createdAt: i === 0 ? "2026-02-01" : "2026-01-01",
    evidenceSnapshotJson: JSON.stringify({ ...pack, debateId: "active-pages" }),
  })));
  const first = await listRuns.run({ debateId: "active-pages" }, owner);
  const next = await listRuns.run({ debateId: "active-pages", cursor: first.nextCursor! }, owner);
  expect(next.activeRunId).toBe("active-current");
  expect(next.runs.every(r => !r.isActive)).toBe(true);
  await db.update(schema.debateRuns).set({ status: "completed" }).where(eq(schema.debateRuns.id, "active-current"));
  expect((await listRuns.run({ debateId: "active-pages" }, owner)).activeRunId).toBeNull();
  expect((await getRun.run({ runId: "active-current" }, owner)).isActive).toBe(false);
});

it("strips snapshot private fields and returns roles in debate order even if timestamps tie", async () => {
  const db = getDb();
  await db.insert(schema.debateRuns).values({ id: "safe-snapshot", debateId: "mine", status: "completed",
    modelId: "test", createdByEmail: owner.userEmail,
    evidenceSnapshotJson: JSON.stringify({ ...pack, ownerEmail: "PRIVATE", papers: [{
      id: "p", externalId: "W1", title: "Study", authors: [], year: null, doi: null, url: null,
      providerUrl: "https://openalex.org/W1", abstract: null, abstractTruncated: false, addedByEmail: "PRIVATE",
    }] }),
  });
  await db.insert(schema.debateMessages).values([
    { ...output, role: "judge", verdict: "insufficient_evidence", confidence: 0, limitations: [] },
    { ...output, role: "opponent" }, output,
  ].map((payload, i) => ({ id: `safe-${i}`, runId: "safe-snapshot", role: payload.role,
    payloadJson: JSON.stringify(payload), citedExternalIdsJson: "[]", createdAt: "2026-01-01" })));
  const result = await getRun.run({ runId: "safe-snapshot" }, owner);
  expect(result.messages.map(m => m.role)).toEqual(["proponent", "opponent", "judge"]);
  expect(result.evidencePack.papers[0].stance).toBeNull();
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
});

it.each(["bad-json", "wrong-scope", "invalid-paper", "bad-message", "outside-citation", "citation-mismatch"])(
  "rejects %s consistently in the inspector and compact result", async kind => {
    const db = getDb();
    const id = "corrupt-" + kind;
    let snapshot = JSON.stringify(pack);
    if (kind === "bad-json") snapshot = "PRIVATE_SECRET{broken";
    if (kind === "wrong-scope") snapshot = JSON.stringify({ ...pack, debateId: "other" });
    if (kind === "invalid-paper") snapshot = JSON.stringify({ ...pack, papers: [null] });
    if (kind === "citation-mismatch") snapshot = JSON.stringify({ ...pack, papers: [{
      id: "p", externalId: "W1", title: "Study", authors: [], year: null, doi: null,
      url: null, providerUrl: "https://openalex.org/W1", abstract: null, abstractTruncated: false,
    }] });
    await db.insert(schema.debateRuns).values({ id, debateId: "mine", status: "completed", modelId: "test",
      createdByEmail: owner.userEmail, evidenceSnapshotJson: snapshot });
    if (["bad-message", "outside-citation", "citation-mismatch"].includes(kind)) {
      await db.insert(schema.debateMessages).values({ id, runId: id, role: "proponent", citedExternalIdsJson: "[]",
        payloadJson: kind === "bad-message" ? "PRIVATE_SECRET" : JSON.stringify({ ...output, citedExternalIds: ["W1"] }) });
    }
    for (const request of [
      () => getRun.run({ runId: id }, owner),
      () => getResult.run({ debateId: "mine", runId: id }, owner),
      () => exportRun.run({ runId: id, format: "json" }, owner),
    ]) {
      await expect(request()).rejects.toMatchObject({ statusCode: 500, message: "Stored debate run data could not be read." });
    }
  },
);

it("returns partial messages on failure and an empty message list before a role completes", async () => {
  const result = await getRun.run({ runId: "first" }, owner);
  expect(result).toMatchObject({ status: "failed", evidencePack: pack, messages: [{ id: "partial", role: "proponent", output }] });
  expect(JSON.stringify(result)).not.toContain("historical sensitive details");
  expect(result).not.toHaveProperty("errorMessage");
  expect(result.errorSummary).toBe(
    "This debate run failed. Start a new run after fixing evidence or credentials.",
  );
  expect((await getRun.run({ runId: "second" }, owner)).messages).toEqual([]);
});

it("uses the same 404 for another owner's rows and missing rows", async () => {
  for (const debateId of ["mine", "missing"]) {
    await expect(listRuns.run({ debateId }, other)).rejects.toMatchObject({ statusCode: 404, message: "Debate not found." });
  }
  for (const runId of ["first", "missing"]) {
    await expect(getRun.run({ runId }, other)).rejects.toMatchObject({ statusCode: 404, message: "Debate run not found." });
  }
});

it("requires authentication for both reads", async () => {
  const guest = { caller: "cli" as const };
  await expect(getRun.run({ runId: "first" }, guest)).rejects.toMatchObject({ statusCode: 401 });
  await expect(listRuns.run({ debateId: "mine" }, guest)).rejects.toMatchObject({ statusCode: 401 });
});

it("paginates ties by id without duplicates and scopes cursors to the owned debate", async () => {
  const db = getDb();
  await db.insert(schema.debates).values({ id: "paged", ownerEmail: owner.userEmail, claim: "A" });
  const ids = Array.from({ length: 22 }, (_, i) => "page-" + String(i).padStart(2, "0"));
  await db.insert(schema.debateRuns).values(ids.map(id => ({
    id, debateId: "paged", modelId: "test", createdByEmail: owner.userEmail,
    createdAt: "2026-01-01", status: "completed", evidenceSnapshotJson: JSON.stringify(pack),
  })));
  const first = await listRuns.run({ debateId: "paged" }, owner);
  expect(first.runs).toHaveLength(20);
  expect(typeof first.nextCursor).toBe("string");
  const cursor = first.nextCursor!;
  const last = await listRuns.run({ debateId: "paged", cursor }, owner);
  expect([...first.runs, ...last.runs].map(row => row.id)).toEqual(ids.reverse());
  expect(last.nextCursor).toBeNull();
  await expect(listRuns.run({ debateId: "paged", cursor }, other)).rejects.toMatchObject({ statusCode: 404 });
  await expect(listRuns.run({ debateId: "mine", cursor }, owner)).rejects.toMatchObject({ statusCode: 400 });
  await expect(listRuns.run({ debateId: "paged", cursor: "!invalid" }, owner)).rejects.toMatchObject({ statusCode: 400 });
});

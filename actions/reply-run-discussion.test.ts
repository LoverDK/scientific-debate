import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { closeDbExec, getDatabaseUrl, getMigrationDatabaseUrl, runMigrations, withMigrationRuntime } from "@agent-native/core/db";
import { getDb, schema } from "../server/db/index.js";
import { debatesAppMigrations, DEBATES_APP_MIGRATIONS_TABLE } from "../server/db/migrations.js";
import { DEFAULT_DEBATE_RUN_MODEL_ID, FREE_MODEL_ROUTING } from "../shared/debate-model.js";
import add from "./add-run-discussion.js";
import list from "./list-run-discussion.js";
import reply from "./reply-run-discussion.js";

const mocks = vi.hoisted(() => ({ secret: vi.fn(), generate: vi.fn(), provider: vi.fn() }));
vi.mock("@agent-native/core/server", () => ({ resolveSecretDetailed: mocks.secret }));
vi.mock("@openrouter/ai-sdk-provider", () => ({ createOpenRouter: () => mocks.provider }));
vi.mock("ai", async original => ({ ...await original<typeof import("ai")>(), generateText: mocks.generate }));
const owner = { caller: "cli" as const, userEmail: "reply@example.test" };
const args = { runId: "r", contributionId: "n" };
const answer = { answer: "The saved abstract reports association, not a causal intervention.", citedExternalIds: ["W1"] };
const snapshot = { debateId: "d", claim: "Saved claim", papers: [{ id: "p", externalId: "W1", title: "Saved paper", authors: [], year: null,
  doi: null, url: null, providerUrl: "https://openalex.org/W1", abstract: "Synthetic abstract: association does not establish causation.", abstractTruncated: false, stance: null }] };
beforeAll(async () => {
  if ([process.env.DATABASE_URL, getDatabaseUrl(), getMigrationDatabaseUrl()].some(url => url !== "pglite:memory")) throw Error("Memory database required");
  await withMigrationRuntime(async () => { await runMigrations(debatesAppMigrations, { table: DEBATES_APP_MIGRATIONS_TABLE })(undefined); });
});
beforeEach(async () => {
  vi.clearAllMocks(); mocks.generate.mockReset(); mocks.secret.mockReset();
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("Real network forbidden"); }));
  mocks.secret.mockResolvedValue({ value: "MOCK_SECRET", lookupFailed: false });
  mocks.generate.mockResolvedValue({ output: answer });
  const db = getDb();
  await db.delete(schema.debates);
  await db.insert(schema.debates).values({ id: "d", claim: "Edited claim must not replace snapshot", ownerEmail: owner.userEmail });
  await db.insert(schema.debateRuns).values({ id: "r", debateId: "d", status: "completed", modelId: "fixture", createdByEmail: owner.userEmail, evidenceSnapshotJson: JSON.stringify(snapshot) });
  const output = { role: "judge", summary: "Insufficient causal evidence", arguments: [{ claim: "Association", support: "Saved argument", citedExternalIds: ["W1"] }],
    citedExternalIds: ["W1"], verdict: "insufficient_evidence", confidence: 0.5, limitations: ["Abstract only"] };
  await db.insert(schema.debateMessages).values({ id: "m", runId: "r", role: "judge", payloadJson: JSON.stringify(output), citedExternalIdsJson: '["W1"]' });
  await db.insert(schema.debateRunDiscussion).values({ id: "n", runId: "r", authorEmail: owner.userEmail, kind: "challenge", role: "judge", body: "Does this establish causality?", createdAt: new Date().toISOString() });
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });
afterAll(closeDbExec);

it("persists a separate AI reply using the saved snapshot and leaves the verdict unchanged", async () => {
  const db = getDb();
  const before = await db.select().from(schema.debateMessages);
  const result = await reply.run(args, owner);
  expect(result).toMatchObject({ status: "completed", parentId: "n", ...answer });
  const request = mocks.generate.mock.calls[0]![0];
  expect(JSON.parse(request.prompt).evidenceSnapshot.claim).toBe("Saved claim");
  expect(request.prompt).not.toContain("Edited claim");
  expect(request.prompt).not.toContain("MOCK_SECRET");
  expect(request).toMatchObject({ maxRetries: 0, timeout: 60_000 });
  expect(mocks.provider).toHaveBeenCalledWith(DEFAULT_DEBATE_RUN_MODEL_ID, { provider: FREE_MODEL_ROUTING });
  const saved = await list.run({ runId: "r" }, owner);
  expect(saved.notes).toHaveLength(2);
  expect(saved.notes.find(n => n.kind === "ai_reply")?.aiReply).toMatchObject({ status: "completed", ...answer });
  expect(await db.select().from(schema.debateMessages)).toEqual(before);
  expect((await db.select().from(schema.debateRuns))[0]?.status).toBe("completed");
});
it.each([[undefined, 401], ["foreign@example.test", 404]] as const)("blocks unauthorized caller %s before model or Secret access", async (userEmail, statusCode) => {
  await expect(reply.run(args, { caller: "cli", ...(userEmail ? { userEmail } : {}) })).rejects.toMatchObject({ statusCode });
  expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.secret).not.toHaveBeenCalled();
});
it("rejects missing notes and prevents human clients from forging AI messages", async () => {
  await expect(reply.run({ ...args, contributionId: "missing" }, owner)).rejects.toMatchObject({ statusCode: 404 });
  expect(add.schema.safeParse({ runId: "r", kind: "ai_reply", body: "Fake" }).success).toBe(false);
  expect(mocks.generate).not.toHaveBeenCalled();
});
it("does not call the model for archived debates", async () => {
  await getDb().update(schema.debates).set({ archivedAt: new Date().toISOString() });
  await expect(reply.run(args, owner)).rejects.toMatchObject({ statusCode: 409 });
  expect(mocks.generate).not.toHaveBeenCalled();
  expect((await list.run({ runId: "r" }, owner)).notes).toHaveLength(1);
});
it.each([[false, 400], [true, 503]] as const)("handles unavailable credentials without creating a reply claim (%s)", async (lookupFailed, statusCode) => {
  mocks.secret.mockResolvedValue({ value: undefined, lookupFailed });
  await expect(reply.run(args, owner)).rejects.toMatchObject({ statusCode });
  expect(mocks.generate).not.toHaveBeenCalled();
  expect((await list.run({ runId: "r" }, owner)).notes).toHaveLength(1);
});
it("returns a completed saved reply without repeating the model call", async () => {
  const first = await reply.run(args, owner);
  expect(await reply.run(args, owner)).toEqual(first);
  expect(mocks.generate).toHaveBeenCalledTimes(1);
  expect(mocks.secret).toHaveBeenCalledTimes(1);
});
it("claims a contribution once across concurrent calls in one memory instance", async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const finish = new Promise<void>(resolve => { release = resolve; });
  mocks.generate.mockImplementation(async () => { entered(); await finish; return { output: answer }; });
  const first = reply.run(args, owner);
  await started;
  const second = await reply.run(args, owner);
  expect(second.status).toBe("pending");
  release();
  expect((await first).status).toBe("completed");
  expect(mocks.generate).toHaveBeenCalledTimes(1);
});
it.each(["provider", "citation", "schema"])("persists a safe failure for %s and never retries it", async kind => {
  if (kind === "provider") mocks.generate.mockRejectedValue(new Error("MOCK_SECRET private prompt raw response"));
  else mocks.generate.mockResolvedValue({ output: kind === "citation" ? { ...answer, citedExternalIds: ["W999"] } : {} });
  expect((await reply.run(args, owner)).status).toBe("failed");
  expect((await reply.run(args, owner)).status).toBe("failed");
  expect(mocks.generate).toHaveBeenCalledTimes(1);
  const saved = await list.run({ runId: "r" }, owner);
  expect(JSON.stringify(saved)).not.toMatch(/MOCK_SECRET|private prompt|raw response|W999/);
  expect(saved.notes).toHaveLength(2);
});

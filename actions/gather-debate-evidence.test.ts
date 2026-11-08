import { closeDbExec, getDatabaseUrl, getMigrationDatabaseUrl, runMigrations, withMigrationRuntime } from "@agent-native/core/db";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { getDb, schema } from "../server/db/index.js";
import { debatesAppMigrations, DEBATES_APP_MIGRATIONS_TABLE } from "../server/db/migrations.js";
import { searchOpenAlexWorks } from "../server/lib/openalex-search.js";
import { classifyPapersWithFreeOpenRouter } from "../server/lib/evidence-stance-llm.js";
import type { OpenAlexMappedWork } from "../server/lib/openalex-works.js";
import gather from "./gather-debate-evidence.js";

vi.mock("../server/lib/openalex-search.js", async importOriginal => ({
  ...await importOriginal<typeof import("../server/lib/openalex-search.js")>(),
  searchOpenAlexWorks: vi.fn(), pauseBetweenOpenAlexCalls: vi.fn(),
}));
vi.mock("../server/lib/evidence-stance-llm.js", () => ({
  FREE_EVIDENCE_CLASSIFIER_MODEL_ID: "offline-fixture",
  classifyPapersWithFreeOpenRouter: vi.fn(),
}));

const owner = { caller: "cli" as const, userEmail: "gather@example.test" };
const args = { debateId: "d", maxPerStance: 5 };
const paper = (id: number): OpenAlexMappedWork => ({
  externalId: `W${id}`, title: `Paper ${id}`, authors: [], year: 2025,
  abstract: "This synthetic abstract describes the reasoning task under study.", doi: null, url: null, providerUrl: `https://openalex.org/W${id}`,
  citationCount: null, relevanceScore: null,
});
let network: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  if ([process.env.DATABASE_URL, getDatabaseUrl(), getMigrationDatabaseUrl()].some(url => url !== "pglite:memory")) {
    throw new Error("Gather tests require memory PGlite.");
  }
  await withMigrationRuntime(async () => {
    await runMigrations(debatesAppMigrations, { table: DEBATES_APP_MIGRATIONS_TABLE })(undefined);
  });
});
beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(searchOpenAlexWorks).mockReset();
  vi.mocked(classifyPapersWithFreeOpenRouter).mockReset();
  network = vi.fn(() => { throw new Error("Real network forbidden"); });
  vi.stubGlobal("fetch", network);
  const db = getDb();
  await db.delete(schema.debates);
  await db.delete(schema.papers);
  await db.insert(schema.debates).values({ id: "d", claim: "Robustness improves reasoning", ownerEmail: owner.userEmail });
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
afterAll(closeDbExec);

it("sends critical search hits to the classifier even when support hits fill the budget", async () => {
  vi.mocked(searchOpenAlexWorks)
    .mockResolvedValueOnce(Array.from({ length: 10 }, (_, i) => paper(i + 1)))
    .mockResolvedValueOnce(Array.from({ length: 10 }, (_, i) => paper(i + 101)))
    .mockResolvedValueOnce(Array.from({ length: 10 }, (_, i) => paper(i + 11)));
  vi.mocked(classifyPapersWithFreeOpenRouter).mockImplementation(async ({ papers }) => ({
    // Search direction must never override the model's uncertain verdict.
    classified: papers.map(p => ({ ...p, stance: "uncertain", rationale: "Related background only", classifier: "openrouter-free" })),
    usedFallback: false, modelId: "offline-fixture",
  }));
  const result = await gather.run(args, owner);
  const candidates = vi.mocked(classifyPapersWithFreeOpenRouter).mock.calls[0][0].papers;
  expect(candidates).toHaveLength(15);
  expect(candidates.filter(p => Number(p.externalId.slice(1)) >= 101)).toHaveLength(7);
  expect(searchOpenAlexWorks).toHaveBeenCalledTimes(3);
  expect(vi.mocked(searchOpenAlexWorks).mock.calls.map(([q]) => q.page)).toEqual([1, 1, 2]);
  expect(vi.mocked(searchOpenAlexWorks).mock.calls[0][0].query).toBe(vi.mocked(searchOpenAlexWorks).mock.calls[2][0].query);
  expect(result.attached.supports).toEqual([]);
  expect(result.attached.opposes).toEqual([]);
  expect(result.attached.uncertain).toHaveLength(2);
  const links = await getDb().select().from(schema.debatePapers);
  expect(links).toHaveLength(2);
  expect(links.every(link => link.stance === "uncertain")).toBe(true);
  expect(links[0]?.stanceRationale).toBe("Related background only");
});

it("rejects unauthenticated and foreign callers before search or classification", async () => {
  await expect(gather.run(args, { caller: "cli" })).rejects.toMatchObject({ statusCode: 401 });
  await expect(gather.run(args, { ...owner, userEmail: "other@example.test" })).rejects.toMatchObject({ statusCode: 404 });
  expect(searchOpenAlexWorks).not.toHaveBeenCalled();
  expect(classifyPapersWithFreeOpenRouter).not.toHaveBeenCalled();
  expect(await getDb().select().from(schema.papers)).toEqual([]);
});

it("returns an empty-search error without classification or writes", async () => {
  vi.mocked(searchOpenAlexWorks).mockResolvedValue([]);
  await expect(gather.run(args, owner)).rejects.toMatchObject({ statusCode: 404 });
  expect(classifyPapersWithFreeOpenRouter).not.toHaveBeenCalled();
  expect(await getDb().select().from(schema.papers)).toEqual([]);
});

it("does not write or leak raw model failures", async () => {
  vi.mocked(searchOpenAlexWorks).mockResolvedValue([paper(1)]);
  vi.mocked(classifyPapersWithFreeOpenRouter).mockRejectedValue(new Error("PRIVATE_PROVIDER_RESPONSE"));
  await expect(gather.run(args, owner)).rejects.toMatchObject({ statusCode: 502, message: "Free OpenRouter stance classification failed." });
  expect(await getDb().select().from(schema.papers)).toEqual([]);
  expect(await getDb().select().from(schema.debatePapers)).toEqual([]);
});

it("restores attachment of classified papers without relevance or excerpt fields", async () => {
  const candidates = [{ ...paper(1), abstract: null }, paper(2)];
  vi.mocked(searchOpenAlexWorks).mockResolvedValue(candidates);
  vi.mocked(classifyPapersWithFreeOpenRouter).mockResolvedValue({
    modelId: "offline-fixture", usedFallback: false,
    classified: candidates.map((p, i) => ({ ...p, stance: i === 0 ? "uncertain" : "supports",
      rationale: "Synthetic model assessment", classifier: "openrouter-free" })),
  });
  const result = await gather.run(args, owner);
  expect(result.attached.supports.map(p => p.externalId)).toEqual(["W2"]);
  expect(result.attached.uncertain.map(p => p.externalId)).toEqual(["W1"]);
  expect(await getDb().select().from(schema.papers)).toHaveLength(2);
  expect(await getDb().select().from(schema.debatePapers)).toHaveLength(2);
});

it("keeps unclassified candidates visible as uncertain instead of discarding all results", async () => {
  vi.mocked(searchOpenAlexWorks).mockResolvedValue([paper(1)]);
  vi.mocked(classifyPapersWithFreeOpenRouter).mockResolvedValue({
    modelId: "offline-fixture", usedFallback: true,
    classified: [{ ...paper(1), stance: "uncertain", rationale: "Model assessment unavailable", classifier: "unclassified" }],
  });
  const result = await gather.run(args, owner);
  expect(result.hasUnclassifiedPapers).toBe(true);
  expect(result.usedHeuristicFallback).toBe(false);
  expect(result.attached.uncertain).toHaveLength(1);
  expect((await getDb().select().from(schema.debatePapers))[0]?.stance).toBe("uncertain");
});

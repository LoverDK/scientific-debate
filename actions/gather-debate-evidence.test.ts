import { closeDbExec, getDatabaseUrl, getMigrationDatabaseUrl, runMigrations, withMigrationRuntime } from "@agent-native/core/db";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { getDb, schema } from "../server/db/index.js";
import { debatesAppMigrations, DEBATES_APP_MIGRATIONS_TABLE } from "../server/db/migrations.js";
import { searchOpenAlexWorks, OpenAlexSearchError } from "../server/lib/openalex-search.js";
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
    classified: papers.map(p => ({ ...p, relevance: "contextual", evidenceExcerpt: p.abstract!, stance: "uncertain", rationale: "Related background only", classifier: "openrouter-free" })),
    usedFallback: false, modelId: "offline-fixture",
  }));
  const result = await gather.run(args, owner);
  const candidates = vi.mocked(classifyPapersWithFreeOpenRouter).mock.calls[0][0].papers;
  expect(candidates).toHaveLength(15);
  expect(candidates.filter(p => Number(p.externalId.slice(1)) >= 101)).toHaveLength(7);
  expect(searchOpenAlexWorks).toHaveBeenCalledTimes(3);
  expect(result.queries.executed.map(q => q.kind)).toEqual(["focused", "challenging", "expanded"]);
  expect(result.attached.supports).toEqual([]);
  expect(result.attached.opposes).toEqual([]);
  expect(result.attached.uncertain).toHaveLength(2);
  const links = await getDb().select().from(schema.debatePapers);
  expect(links).toHaveLength(2);
  expect(links.every(link => link.stance === "uncertain")).toBe(true);
  expect(links[0]?.stanceRationale).toContain("Abstract excerpt:");
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

it("excludes unrelated and unverified candidates and exposes the exclusion count", async () => {
  vi.mocked(searchOpenAlexWorks).mockResolvedValue([paper(1), paper(2), paper(3)]);
  vi.mocked(classifyPapersWithFreeOpenRouter).mockResolvedValue({ modelId: "offline-fixture", usedFallback: true, classified: [
    { ...paper(1), relevance: "direct", stance: "opposes", rationale: "Direct test contradicts the claim", evidenceExcerpt: paper(1).abstract!, classifier: "openrouter-free" },
    { ...paper(2), relevance: "irrelevant", stance: "uncertain", rationale: "Different research question", evidenceExcerpt: "", classifier: "openrouter-free" },
    { ...paper(3), relevance: "unassessed", stance: "uncertain", rationale: "No verified assessment", evidenceExcerpt: "", classifier: "unclassified" },
  ] });
  const result = await gather.run(args, owner);
  expect(result.review).toMatchObject({ candidateCount: 3, eligibleCount: 1, excludedCount: 2 });
  expect(result.attached.opposes.map(p => p.externalId)).toEqual(["W1"]);
  expect((await getDb().select().from(schema.papers)).map(p => p.externalId)).toEqual(["W1"]);
});

it.each(["irrelevant", "unassessed"] as const)("does not attach anything when all candidates are %s", async relevance => {
  vi.mocked(searchOpenAlexWorks).mockResolvedValue([paper(1)]);
  vi.mocked(classifyPapersWithFreeOpenRouter).mockResolvedValue({ modelId: "offline-fixture", usedFallback: relevance === "unassessed", classified: [
    { ...paper(1), relevance, stance: "uncertain", rationale: "Excluded", evidenceExcerpt: "", classifier: "unclassified" },
  ] });
  await expect(gather.run(args, owner)).rejects.toMatchObject({ statusCode: relevance === "unassessed" ? 502 : 422 });
  expect(await getDb().select().from(schema.papers)).toEqual([]);
  expect(await getDb().select().from(schema.debatePapers)).toEqual([]);
});

it("assesses the cached abstract that will actually be used by the EvidencePack", async () => {
  const db = getDb();
  await db.insert(schema.papers).values({ id: "cached", source: "openalex", externalId: "W1", providerUrl: paper(1).providerUrl,
    title: "Saved title", abstract: "Saved abstract, not the fresh search result." });
  vi.mocked(searchOpenAlexWorks).mockResolvedValue([paper(1)]);
  vi.mocked(classifyPapersWithFreeOpenRouter).mockImplementation(async ({ papers }) => ({ modelId: "offline-fixture", usedFallback: false,
    classified: papers.map(p => ({ ...p, relevance: "contextual", stance: "uncertain", rationale: "Background", evidenceExcerpt: p.abstract!, classifier: "openrouter-free" })) }));
  await gather.run(args, owner);
  expect(vi.mocked(classifyPapersWithFreeOpenRouter).mock.calls[0][0].papers[0]).toMatchObject({ title: "Saved title", abstract: "Saved abstract, not the fresh search result." });
  expect((await db.select().from(schema.debatePapers))[0]?.stanceRationale).toContain("Saved abstract, not the fresh search result.");
});

it("rejects metadata changed during classification before linking the paper", async () => {
  vi.mocked(searchOpenAlexWorks).mockResolvedValue([paper(1)]);
  vi.mocked(classifyPapersWithFreeOpenRouter).mockImplementation(async ({ papers }) => {
    // Another request populated the shared paper cache while model work was pending.
    await getDb().insert(schema.papers).values({ id: "concurrent", source: "openalex", externalId: "W1",
      providerUrl: paper(1).providerUrl, title: paper(1).title, abstract: "Different cached text." });
    return { modelId: "offline-fixture", usedFallback: false, classified: papers.map(p => ({ ...p,
      relevance: "direct", stance: "supports", rationale: "Synthetic assessment", evidenceExcerpt: p.abstract!, classifier: "openrouter-free" })) };
  });
  await expect(gather.run(args, owner)).rejects.toMatchObject({ statusCode: 409 });
  expect(await getDb().select().from(schema.debatePapers)).toEqual([]);
  expect((await getDb().select().from(schema.papers))[0]?.abstract).toBe("Different cached text.");
});

it("discloses incomplete retrieval when only the optional expansion is rate limited", async () => {
  vi.mocked(searchOpenAlexWorks).mockResolvedValueOnce([paper(1)]).mockResolvedValueOnce([])
    .mockRejectedValueOnce(new OpenAlexSearchError("rate limited", 429));
  vi.mocked(classifyPapersWithFreeOpenRouter).mockImplementation(async ({ papers }) => ({ modelId: "offline-fixture", usedFallback: false,
    classified: papers.map(p => ({ ...p, relevance: "direct", stance: "supports", rationale: "Synthetic assessment", evidenceExcerpt: p.abstract!, classifier: "openrouter-free" })) }));
  const result = await gather.run(args, owner);
  expect(result.queries.executed.map(q => q.kind)).toEqual(["focused", "challenging"]);
  expect(result.review.warnings).toHaveLength(1);
  expect(result.attached.supports).toHaveLength(1);
  expect(searchOpenAlexWorks).toHaveBeenCalledTimes(3);
});

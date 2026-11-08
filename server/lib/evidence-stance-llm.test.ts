import { afterEach, expect, it, vi } from "vitest";
import { APICallError } from "ai";
import { classifyPapersWithFreeOpenRouter } from "./evidence-stance-llm.js";
import { DEFAULT_DEBATE_RUN_MODEL_ID } from "../../shared/debate-model.js";

vi.mock("@agent-native/core/server", () => ({
  resolveSecretDetailed: async () => ({ value: "offline-fixture", lookupFailed: false }),
}));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("stops before the second batch on 429 and sends only zero-priced routing", async () => {
  const wire = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe(DEFAULT_DEBATE_RUN_MODEL_ID);
    expect(body.provider).toMatchObject({
      allow_fallbacks: false, max_price: { prompt: 0, completion: 0, request: 0, image: 0, audio: 0 },
    });
    return Response.json({ error: { message: "rate limited", code: 429 } }, { status: 429 });
  });
  vi.stubGlobal("fetch", wire);
  const papers = Array.from({ length: 6 }, (_, i) => ({
    externalId: "W" + i, title: "Study", authors: [], abstract: null, year: null,
    doi: null, url: null, providerUrl: "", citationCount: null, relevanceScore: null,
  }));
  const result = classifyPapersWithFreeOpenRouter({ papers, claim: "Study claim", keywords: [] });
  await expect(result).rejects.toSatisfy(APICallError.isInstance);
  await expect(result).rejects.toMatchObject({ statusCode: 429 });
  expect(wire).toHaveBeenCalledTimes(1);
});

it("keeps papers uncertain on model failure instead of inferring stance from positive or negative words", async () => {
  const wire = vi.fn(async () => { throw new Error("offline network fixture"); });
  vi.stubGlobal("fetch", wire);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const base = { authors: [], year: null, doi: null, url: null, providerUrl: "", citationCount: null, relevanceScore: null };
  const result = await classifyPapersWithFreeOpenRouter({
    claim: "Robustness improves reasoning", keywords: ["robustness", "reasoning"],
    papers: [
      { ...base, externalId: "W1", title: "Robustness improves reasoning", abstract: "Significant improvement confirms a positive effect." },
      { ...base, externalId: "W2", title: "Limitations of robustness reasoning", abstract: "Failure contradicts prior claims; no significant benefit." },
    ],
  });
  expect(result.usedFallback).toBe(true);
  expect(result.classified.map(p => p.stance)).toEqual(["uncertain", "uncertain"]);
  expect(result.classified.every(p => p.classifier === "unclassified")).toBe(true);
  expect(wire).toHaveBeenCalledTimes(1);
});

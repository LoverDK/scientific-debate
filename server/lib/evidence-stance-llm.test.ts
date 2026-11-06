import { afterEach, expect, it, vi } from "vitest";
import { APICallError } from "ai";
import { classifyPapersWithFreeOpenRouter } from "./evidence-stance-llm.js";
import { DEFAULT_DEBATE_RUN_MODEL_ID } from "../../shared/debate-model.js";

vi.mock("@agent-native/core/server", () => ({
  resolveSecretDetailed: async () => ({ value: "offline-fixture", lookupFailed: false }),
}));
afterEach(() => vi.unstubAllGlobals());

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

import { afterEach, expect, it, vi } from "vitest";
import { searchOpenAlexWorks } from "./openalex-search";
import { buildEvidenceSearchQueries } from "./evidence-stance";

afterEach(() => vi.unstubAllGlobals());

it("uses plain concepts for the Crossref bridge without changing the OpenAlex Boolean query", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response("Anonymous search is paused", { status: 503 }))
    .mockResolvedValueOnce(Response.json({ message: { items: [] } }));
  vi.stubGlobal("fetch", fetch);
  const query = '(robustness OR robust) AND "large language model"';
  await expect(searchOpenAlexWorks({ query, bridgeQuery: "robustness large language model", apiKey: null })).resolves.toEqual([]);
  expect(new URL(String(fetch.mock.calls[0]?.[0])).searchParams.get("search")).toBe(query);
  const bridgeUrl = new URL(String(fetch.mock.calls[1]?.[0]));
  expect(bridgeUrl.hostname).toBe("api.crossref.org");
  expect(bridgeUrl.searchParams.get("query")).toBe("robustness large language model");
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("reports a blocked DOI lookup separately from a search with no matching papers", async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response("Anonymous search is paused", {status: 503}))
    .mockResolvedValueOnce(Response.json({message: {items: [{DOI: "10.1093/mind/lix.236.433"}]}}))
    .mockResolvedValueOnce(new Response(null, {status: 429}));
  vi.stubGlobal("fetch", fetch);
  const {supportQuery} = buildEvidenceSearchQueries("Performance in an imitation game is sufficient evidence for machine intelligence.");
  expect(supportQuery).toContain("imitation");
  expect(supportQuery).not.toContain('"');
  await expect(searchOpenAlexWorks({query: supportQuery, apiKey: null}))
    .rejects.toMatchObject({statusCode: 429, message: "OpenAlex DOI lookup failed (429)."});
  expect(fetch).toHaveBeenCalledTimes(3);
});

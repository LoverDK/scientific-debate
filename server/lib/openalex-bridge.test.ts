import { afterEach, expect, it, vi } from "vitest";
import { searchOpenAlexWorks } from "./openalex-search";
import { buildEvidenceSearchQueries } from "./evidence-stance";

afterEach(() => vi.unstubAllGlobals());

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

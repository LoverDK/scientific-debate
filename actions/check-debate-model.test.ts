import { describe, expect, it, vi } from "vitest";
import { checkModelCatalog } from "./check-debate-model.js";
import { DEFAULT_DEBATE_RUN_MODEL_ID as id } from "./start-debate-run.js";

describe("public catalog check", () => {
  it.each([
    [[], "unlisted"],
    [[{ id, pricing: { prompt: "0", completion: "0.000" } }], "listed_free"],
    [[{ id, pricing: { prompt: "0", completion: 0, request: "0.01" } }], "price_changed"],
    [[{ id, pricing: { prompt: "0" } }], "unknown"],
    [[{ id, pricing: { prompt: "-1", completion: "0" } }], "unknown"],
  ] as const)("classifies catalog %j", async (data, status) => {
    const request = vi.fn(async () => Response.json({ data }));
    expect(await checkModelCatalog(request)).toBe(status);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("handles an unreachable catalog", async () => {
    expect(await checkModelCatalog(async () => { throw new Error("offline"); })).toBe("unknown");
  });
});

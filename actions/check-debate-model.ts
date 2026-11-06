import { defineAction, fail } from "@agent-native/core/action";
import { z } from "zod";
import { DEFAULT_DEBATE_RUN_MODEL_ID } from "./start-debate-run.js";

const catalogSchema = z.object({
  data: z.array(z.object({ id: z.string(), pricing: z.unknown().optional() })),
});

export async function checkModelCatalog(request = fetch): Promise<"unknown" | "unlisted" | "listed_free" | "price_changed"> {
  try {
    const response = await request("https://openrouter.ai/api/v1/models", {
      method: "GET", credentials: "omit", redirect: "error", cache: "no-store",
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) return "unknown";
    const catalog = catalogSchema.parse(await response.json());
    const model = catalog.data.find(item => item.id === DEFAULT_DEBATE_RUN_MODEL_ID);
    if (!model) return "unlisted";
    const prices = z.record(z.string(), z.union([z.string(), z.number()])).safeParse(model.pricing);
    if (!prices.success) return "unknown";
    const pricing = prices.data;
    if (pricing.prompt === undefined || pricing.completion === undefined) return "unknown";
    const values = Object.values(pricing).map(String);
    if (values.some(value => !/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value))) return "unknown";
    return values.every(value => /^0+(?:\.0+)?(?:e[+-]?\d+)?$/i.test(value)) ? "listed_free" : "price_changed";
  } catch {
    return "unknown";
  }
}

export default defineAction({
  description: "Manually check the configured model's listing and published prices in the public OpenRouter catalog.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async (_, ctx) => {
    if (!ctx?.userEmail) fail("Sign in to check the model.", { statusCode: 401 });
    return { modelId: DEFAULT_DEBATE_RUN_MODEL_ID, status: await checkModelCatalog(), checkedAt: new Date().toISOString() };
  },
});

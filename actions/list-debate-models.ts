import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { DEFAULT_DEBATE_RUN_MODEL_ID } from "./start-debate-run.js";

/** Contestable allowlist — expand only with explicit product approval. */
export const DEBATE_MODEL_ALLOWLIST = [
  {
    id: DEFAULT_DEBATE_RUN_MODEL_ID,
    label: "NVIDIA Nemotron 3.5 Super VL (free)",
    provider: "openrouter",
    pricing: "free" as const,
    enabled: true,
    runBudgetUsd: 0,
    maxRoleCalls: 3,
    automaticRetries: 0,
    notes:
      "Availability depends on OpenRouter. Requests require zero-priced routing and disable provider fallbacks.",
  },
] as const;

export default defineAction({
  description:
    "List Scientific Debate models that start-debate-run may use. Only allowlisted models are enabled; do not invent other model ids.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => ({
    defaultModelId: DEFAULT_DEBATE_RUN_MODEL_ID,
    models: DEBATE_MODEL_ALLOWLIST.map((model) => ({ ...model })),
  }),
});

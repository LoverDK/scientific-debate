/**
 * Map stored debate_runs.error_message → client-safe errorSummary.
 * Only allowlisted texts (written by start-debate-run / cancel) are returned.
 * Unknown/legacy strings become a generic failed message so internals never leak.
 */

import { FREE_MODEL_RATE_LIMIT } from "../../shared/debate-model.js";
const SAFE_RUN_ERROR_SUMMARIES = new Set([
  FREE_MODEL_RATE_LIMIT,
  "Debate not found.",
  "Debate has no attached papers.",
  "Debate evidence paper is invalid.",
  "Debate evidence citation is invalid.",
  "Debate evidence error.",
  "OpenRouter API key is not configured.",
  "Credential store lookup failed.",
  "Debate model call failed or timed out.",
  "Debate model output was invalid.",
  "Debate model cited an id outside the evidence snapshot.",
  "Debate model citation fields were inconsistent.",
  "Debate model prerequisites were missing.",
  "modelId is invalid.",
  "Debate model error.",
  "A debate run is already in progress.",
  "Debate run is not eligible for this transition.",
  "Debate role message already exists.",
  "Debate run validation failed.",
  "Debate run serialization failed.",
  "Debate run persistence error.",
  "Debate run failed.",
  "Cancelled by the owner.",
  "Marked failed after client abandon.",
]);

const GENERIC_FAILED = "This debate run failed. Start a new run after fixing evidence or credentials.";

/** Client-facing summary; never returns unknown raw DB text. */
export function toSafeRunErrorSummary(
  stored: string | null | undefined,
): string | null {
  if (stored == null) return null;
  const trimmed = stored.trim();
  if (!trimmed) return null;
  if (SAFE_RUN_ERROR_SUMMARIES.has(trimmed)) return trimmed;
  // Truncated allowlisted messages still match by prefix when we sliced at write.
  for (const safe of SAFE_RUN_ERROR_SUMMARIES) {
    if (trimmed === safe.slice(0, trimmed.length) && trimmed.length >= 12) {
      return safe;
    }
  }
  return GENERIC_FAILED;
}

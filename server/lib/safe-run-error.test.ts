import { expect, it } from "vitest";

import { toSafeRunErrorSummary } from "./safe-run-error.js";

it("returns allowlisted messages and redacts unknown text", () => {
  expect(toSafeRunErrorSummary(null)).toBeNull();
  expect(toSafeRunErrorSummary("")).toBeNull();
  expect(toSafeRunErrorSummary("Cancelled by the owner.")).toBe(
    "Cancelled by the owner.",
  );
  expect(toSafeRunErrorSummary("OpenRouter API key is not configured.")).toBe(
    "OpenRouter API key is not configured.",
  );
  expect(toSafeRunErrorSummary("historical sensitive details")).toBe(
    "This debate run failed. Start a new run after fixing evidence or credentials.",
  );
});

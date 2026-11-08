import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { callAction } from "@agent-native/core/client/use-action";
import { requestSavedDiscussionReply, submitDiscussionWithReply } from "./discussion-submit";
import { discussionReplyErrors } from "../../shared/discussion-reply";
vi.mock("@agent-native/core/client/use-action", () => ({ callAction: vi.fn() }));
const wire = vi.mocked(callAction);
const input = { runId: "r", kind: "challenge" as const, role: "judge" as const, body: "Is this causal?" };
beforeEach(() => { wire.mockReset(); vi.stubGlobal("fetch", vi.fn(() => { throw Error("Network forbidden"); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });
it("saves the contribution before requesting exactly one reply to its actual saved ID", async () => {
  wire.mockResolvedValueOnce({ id: "saved-note", runId: "r" }).mockResolvedValueOnce({ status: "completed", error: null });
  const saved = vi.fn(() => expect(wire).toHaveBeenCalledTimes(1));
  expect(await submitDiscussionWithReply(input, saved)).toEqual({ savedId: "saved-note", status: "completed", error: null });
  expect(wire.mock.calls[0]).toEqual(["add-run-discussion", input]);
  expect(wire.mock.calls[1]).toEqual(["reply-run-discussion", { runId: "r", contributionId: "saved-note" }, { timeoutMs: 90_000, onResponse: expect.any(Function) }]);
  expect(wire).toHaveBeenCalledTimes(2);
});
it("does not request a reply when saving fails", async () => {
  wire.mockRejectedValueOnce(new Error("Save failed"));
  await expect(submitDiscussionWithReply(input, vi.fn())).rejects.toThrow("Save failed");
  expect(wire).toHaveBeenCalledTimes(1);
});
it("reports unconfirmed response without resaving, retrying or leaking raw errors", async () => {
  wire.mockResolvedValueOnce({ id: "n", runId: "r" }).mockRejectedValueOnce(new Error("private provider response"));
  const result = await submitDiscussionWithReply(input, vi.fn());
  expect(result).toMatchObject({ savedId: "n", status: "unconfirmed" });
  expect(result.error).not.toContain("private provider response");
  expect(wire).toHaveBeenCalledTimes(2);
});
it.each(Object.entries(discussionReplyErrors))("uses the fixed safe message for %s, not the raw error", async (errorCode, message) => {
  wire.mockRejectedValueOnce(Object.assign(new Error("SECRET private SQL prompt"), { errorCode }));
  expect((await requestSavedDiscussionReply("r", "n")).error).toBe(message);
  expect(wire).toHaveBeenCalledTimes(1);
});
it("does not misreport an unknown HTTP 500 as a confirmed persistence failure", async () => {
  wire.mockImplementationOnce(async (_name, _input, options) => {
    options?.onResponse?.(new Response(null, { status: 500 }));
    throw new Error("SECRET private SQL prompt");
  });
  const result = await requestSavedDiscussionReply("r", "n");
  expect(result.error).toContain("state is unknown");
  expect(result.error).not.toMatch(/SECRET|SQL|prompt|confirm reply persistence/);
  expect(wire).toHaveBeenCalledTimes(1);
});

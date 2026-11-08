// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { HumanDiscussion } from "../components/debate/HumanDiscussion";
const mocks = vi.hoisted(() => ({ query: vi.fn(), request: vi.fn(), submit: vi.fn() }));
vi.mock("@agent-native/core/client/use-action", () => ({ useActionQuery: mocks.query }));
vi.mock("./discussion-submit", () => ({ requestSavedDiscussionReply: mocks.request, submitDiscussionWithReply: mocks.submit }));

it("renders saved AI replies distinctly and can answer an existing question without saving it again", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("Network forbidden"); }));
  const refetch = vi.fn();
  mocks.query.mockReturnValue({ data: { archived: false, notes: [
    { id: "human", kind: "challenge", body: "Is it causal?", role: "judge", createdAt: "2026-11-09T00:00:00Z", aiReply: null },
    { id: "ai-reply:human", kind: "ai_reply", body: "Saved AI answer", createdAt: "2026-11-09T00:00:01Z",
      aiReply: { parentId: "human", status: "completed", answer: "Saved AI answer", citedExternalIds: ["W1"], modelId: "free-fixture", error: null } },
    { id: "unanswered", kind: "question", body: "What is missing?", createdAt: "2026-11-09T00:00:02Z", aiReply: null },
  ] }, refetch });
  mocks.request.mockResolvedValue({ savedId: "unanswered", status: "completed", error: null });
  const host = document.createElement("div");
  const root = createRoot(host);
  const client = new QueryClient();
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><HumanDiscussion runId="r" messages={[]} papers={[{ externalId: "W1", title: "Snapshot paper" }]} /></QueryClientProvider>));
    expect(host.textContent).toContain("Save & get AI reply");
    expect(host.textContent).toContain("AI reply · completed");
    expect(host.textContent).toContain("Saved AI answer");
    expect(host.querySelector('a[href="https://openalex.org/W1"]')?.textContent).toContain("Snapshot paper");
    const buttons = [...host.querySelectorAll("button")].filter(b => b.textContent === "Get AI reply");
    expect(buttons).toHaveLength(1);
    await act(async () => buttons[0]!.click());
    await vi.waitFor(() => expect(refetch).toHaveBeenCalled());
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith("r", "unanswered");
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount()); client.clear(); vi.unstubAllGlobals();
  }
});

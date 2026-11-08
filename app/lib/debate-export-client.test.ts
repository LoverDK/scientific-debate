// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { callAction } from "@agent-native/core/client/hooks";
import { copyDebateSummary, downloadExportedDebate, exportDebateRun } from "./debate-export-client";

vi.mock("@agent-native/core/client/hooks", () => ({ callAction: vi.fn() }));
const createUrl = vi.fn(() => "blob:fixture");
const revokeUrl = vi.fn();
const base = { runId: "run-1", summaryText: "Saved summary", markdown: "# Saved claim", json: { claim: "Saved claim" }, html: "<!doctype html><p>Saved claim</p>" };
let clicked: { href: string; name: string }[];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  clicked = [];
  const NativeURL = URL;
  vi.stubGlobal("URL", class extends NativeURL {
    static override createObjectURL = createUrl;
    static override revokeObjectURL = revokeUrl;
  });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden"); }));
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ href: this.href, name: this.download });
  });
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["markdown", "json"] as const)("downloads %s without revoking the URL before the browser can consume it", format => {
  expect(downloadExportedDebate({ ...base, format })).toBe("downloaded");
  expect(clicked).toEqual([{ href: "blob:fixture", name: `scientific-debate-run-1.${format === "json" ? "json" : "md"}` }]);
  expect(revokeUrl).not.toHaveBeenCalled();
  vi.advanceTimersByTime(60_000);
  expect(revokeUrl).toHaveBeenCalledWith("blob:fixture");
});

it("opens printable HTML with no opener and reports its actual delivery", () => {
  const popup = { opener: window, location: { replace: vi.fn() } };
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  expect(downloadExportedDebate({ ...base, format: "html" })).toBe("opened");
  expect(popup.opener).toBeNull();
  expect(popup.location.replace).toHaveBeenCalledWith("blob:fixture");
  expect(clicked).toEqual([]);
});

it("downloads printable HTML when the popup is blocked", () => {
  vi.spyOn(window, "open").mockReturnValue(null);
  expect(downloadExportedDebate({ ...base, format: "html" })).toBe("downloaded");
  expect(clicked[0]?.name).toBe("scientific-debate-run-1.html");
});

it("uses the shared read Action and copies only the returned summary", async () => {
  vi.mocked(callAction).mockResolvedValue({ ...base, format: "markdown" });
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(navigator.clipboard, "writeText").mockImplementation(writeText);
  expect(await exportDebateRun("run-1", "markdown")).toMatchObject(base);
  expect(callAction).toHaveBeenCalledWith("export-debate-run", { runId: "run-1", format: "markdown" }, { method: "GET" });
  expect(await copyDebateSummary("run-1")).toBe(base.summaryText);
  expect(writeText).toHaveBeenCalledWith(base.summaryText);
});

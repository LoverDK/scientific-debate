import { callAction } from "@agent-native/core/client/hooks";

type ExportFormat = "markdown" | "json" | "html";

type ExportResult = {
  format: ExportFormat;
  runId: string;
  summaryText: string;
  markdown: string;
  json: unknown;
  html: string | null;
};

export async function exportDebateRun(
  runId: string,
  format: ExportFormat,
): Promise<ExportResult> {
  return callAction(
    "export-debate-run",
    { runId, format },
    { method: "GET" },
  ) as Promise<ExportResult>;
}

export function downloadExportedDebate(result: ExportResult): "opened" | "downloaded" {
  if (result.format === "html" && result.html) {
    const blob = new Blob([result.html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const popup = window.open("about:blank", "_blank");
    if (popup) {
      popup.opener = null;
      popup.location.replace(url);
    } else {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `scientific-debate-${result.runId}.html`;
      anchor.click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return popup ? "opened" : "downloaded";
  }

  if (result.format === "json") {
    const blob = new Blob([JSON.stringify(result.json, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `scientific-debate-${result.runId}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return "downloaded";
  }

  const blob = new Blob([result.markdown], {
    type: "text/markdown;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `scientific-debate-${result.runId}.md`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "downloaded";
}

export async function copyDebateSummary(runId: string): Promise<string> {
  const result = await exportDebateRun(runId, "markdown");
  await navigator.clipboard.writeText(result.summaryText);
  return result.summaryText;
}

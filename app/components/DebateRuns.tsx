import { useRef, useState } from "react";
import { Link } from "react-router";
import { callAction, useActionQuery } from "@agent-native/core/client/hooks";

import { Button } from "@/components/ui/button";
import { FREE_MODEL_RATE_LIMIT } from "../../shared/debate-model";

import {
  copyDebateSummary,
  downloadExportedDebate,
  exportDebateRun,
} from "../lib/debate-export-client";
import {
  debateComparePath,
  debateConclusionPath,
  debateEvidencePath,
} from "../lib/debate-paths";

const roleNames = {
  proponent: "Proponent",
  opponent: "Opponent",
  judge: "Judge",
} as const;

const roleAccent = {
  proponent: "border-emerald-400/70 bg-emerald-50/50 dark:bg-emerald-950/30",
  opponent: "border-rose-400/70 bg-rose-50/50 dark:bg-rose-950/30",
  judge: "border-amber-400/70 bg-amber-50/50 dark:bg-amber-950/30",
} as const;

const verdicts = {
  supports: "Supports the claim",
  opposes: "Opposes the claim",
  insufficient_evidence: "Insufficient evidence",
} as const;

const statuses: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
};

const isActive = (status?: string) =>
  status === "queued" || status === "running";

type RoleKey = keyof typeof roleNames;

type RoleMessage = {
  summary: string;
  arguments: Array<{
    claim: string;
    support: string;
    citedExternalIds: string[];
  }>;
  verdictLabel: string | null;
  limitations: string[];
};

function RoleColumn({
  role,
  message,
  status,
}: {
  role: RoleKey;
  message: RoleMessage | null;
  status: string;
}) {
  return (
    <section
      className={`flex min-h-[18rem] flex-col rounded-xl border p-4 ${roleAccent[role]}`}
    >
      <h4 className="text-lg font-semibold">{roleNames[role]}</h4>
      {!message && (
        <p className="mt-3 text-sm text-muted-foreground">
          {isActive(status)
            ? "Waiting for this role…"
            : status === "failed"
              ? "No message saved for this role."
              : "Not started yet."}
        </p>
      )}
      {message && (
        <div className="mt-3 space-y-3 overflow-y-auto">
          <p className="text-sm leading-relaxed">{message.summary}</p>
          {message.arguments.map((arg, i) => (
            <div
              key={i}
              className="rounded-md border border-black/5 bg-background/60 p-3 dark:border-white/10"
            >
              <strong className="text-sm">{arg.claim}</strong>
              <p className="mt-1 text-sm text-muted-foreground">{arg.support}</p>
              {arg.citedExternalIds.length > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Citations: {arg.citedExternalIds.join(", ")}
                </p>
              )}
            </div>
          ))}
          {message.verdictLabel && (
            <div className="rounded-md border border-amber-500/30 bg-background/70 p-3">
              <p className="font-semibold">{message.verdictLabel}</p>
              {message.limitations.map((item, i) => (
                <p key={i} className="mt-1 text-sm text-muted-foreground">
                  {item}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function RunArena({ runId }: { runId: string }) {
  const detail = useActionQuery(
    "get-debate-run",
    { runId },
    {
      retry: false,
      refetchInterval: (query) =>
        isActive(query.state.data?.status) ? 4000 : false,
    },
  );
  if (detail.isError)
    return (
      <p role="alert">
        Could not load this run.{" "}
        <Button variant="outline" onClick={() => detail.refetch()}>
          Retry
        </Button>
      </p>
    );
  if (!detail.data) return <p>Loading role messages…</p>;

  const { evidencePack, messages, modelId, status } = detail.data;
  const proponent = messages.find((m) => m.output.role === "proponent");
  const opponent = messages.find((m) => m.output.role === "opponent");
  const judge = messages.find((m) => m.output.role === "judge");

  const asColumn = (
    entry: (typeof messages)[number] | undefined,
  ): RoleMessage | null => {
    if (!entry) return null;
    const { output } = entry;
    return {
      summary: output.summary,
      arguments: output.arguments,
      verdictLabel:
        output.role === "judge"
          ? `${verdicts[output.verdict]} · ${Math.round(output.confidence * 100)}%`
          : null,
      limitations: output.role === "judge" ? output.limitations : [],
    };
  };

  const createdLabel = detail.data.createdAt
    ? new Date(detail.data.createdAt).toLocaleString()
    : null;
  const finishedLabel = detail.data.finishedAt
    ? new Date(detail.data.finishedAt).toLocaleString()
    : null;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {statuses[status] ?? status} · {modelId}
        {createdLabel ? ` · started ${createdLabel}` : ""}
        {finishedLabel ? ` · finished ${finishedLabel}` : ""}
        {detail.data.isActive ? " · active" : ""}
      </p>
      {status === "failed" && detail.data.errorSummary && (
        <p role="alert" className="rounded-md border border-rose-400/40 bg-rose-50/60 p-3 text-sm dark:bg-rose-950/30">
          {detail.data.errorSummary}
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <RoleColumn
          role="proponent"
          message={asColumn(proponent)}
          status={status}
        />
        <RoleColumn
          role="opponent"
          message={asColumn(opponent)}
          status={status}
        />
        <RoleColumn role="judge" message={asColumn(judge)} status={status} />
      </div>
      {messages.some(message => message.usage) && (
        <details className="rounded-xl border bg-card/80 p-4">
          <summary className="cursor-pointer font-medium">Reported model usage</summary>
          {messages.map(({ id, role, usage }) => <p key={id} className="mt-2 text-sm">
            {role} · input tokens {usage?.inputTokens ?? "unknown"} · output tokens {usage?.outputTokens ?? "unknown"} · USD {usage?.costUsd ?? "unknown"}
          </p>)}
        </details>
      )}
      <details className="rounded-xl border bg-card/80 p-4">
        <summary className="cursor-pointer font-medium">
          EvidencePack used by this run ({evidencePack.papers.length})
        </summary>
        <div className="mt-3 space-y-3">
          {evidencePack.papers.map((p) => (
            <article key={p.externalId}>
              {/^https?:\/\//i.test(p.providerUrl) ? (
                <a
                  href={p.providerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold underline"
                >
                  {p.title}
                </a>
              ) : (
                <strong>{p.title}</strong>
              )}
              <p className="text-sm text-muted-foreground">{p.externalId}</p>
              <p className="text-sm">
                {p.abstract || "No abstract"}
                {p.abstractTruncated && " (truncated)"}
              </p>
            </article>
          ))}
        </div>
      </details>
    </div>
  );
}

export function DebateRuns({
  debateId,
  hasEvidence,
}: {
  debateId: string;
  hasEvidence: boolean;
}) {
  const [selected, setSelected] = useState<string>();
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState("");
  const [modelId, setModelId] = useState<string>("");
  const models = useActionQuery("list-debate-models", {}, { retry: false });
  const [checkingModel, setCheckingModel] = useState(false);
  const [modelNotice, setModelNotice] = useState("");
  async function checkModel() {
    setCheckingModel(true);
    try {
      const result = await callAction("check-debate-model", {}, { method: "GET" });
      const descriptions = {
        listed_free: "Listed with zero published prices. Free capacity may vary.",
        price_changed: "The catalog lists a charge. This workspace requires zero-priced routing.",
        unlisted: "The configured model is absent from the public catalog.",
        unknown: "The model listing or pricing could not be verified.",
      };
      setModelNotice(descriptions[result.status] + " Checked " + new Date(result.checkedAt).toLocaleTimeString());
    } catch {
      setModelNotice("Could not check the public catalog.");
    } finally {
      setCheckingModel(false);
    }
  }
  const inFlight = useRef(false);
  const [pages, setPages] = useState<string[]>([]);
  const cursor = pages[pages.length - 1];
  const history = useActionQuery(
    "list-debate-runs",
    { debateId },
    {
      retry: false,
      refetchInterval: (query) =>
        sending ||
        cancelling ||
        Boolean(query.state.data?.activeRunId)
          ? 4000
          : false,
    },
  );
  const older = useActionQuery(
    "list-debate-runs",
    { debateId, cursor },
    { enabled: !!cursor, retry: false },
  );
  const page = cursor ? older : history;
  const runs = page.data?.runs ?? [];
  const activeRunId = history.data?.activeRunId ?? null;
  const active = Boolean(activeRunId);
  const current = selected ?? activeRunId ?? runs[0]?.id;

  async function start() {
    if (
      inFlight.current ||
      active ||
      uncertain ||
      !hasEvidence ||
      !history.isSuccess
    )
      return;
    inFlight.current = true;
    setSending(true);
    setNotice("");
    try {
      const chosen =
        modelId || models.data?.defaultModelId || undefined;
      const result = await callAction(
        "start-debate-run",
        chosen ? { debateId, modelId: chosen } : { debateId },
        { timeoutMs: 360_000 },
      );
      setPages([]);
      setSelected(result.runId);
    } catch (error) {
      const rateLimited = error instanceof Error && error.message.includes(FREE_MODEL_RATE_LIMIT);
      setUncertain(!rateLimited);
      setNotice(
        rateLimited ? FREE_MODEL_RATE_LIMIT : "Start request did not return success. Refresh history to confirm server state — do not assume the run finished.",
      );
    } finally {
      await history.refetch();
      inFlight.current = false;
      setSending(false);
    }
  }

  async function refresh() {
    const result = await history.refetch();
    if (result.isSuccess) {
      setPages([]);
      setUncertain(false);
      setSelected(result.data.activeRunId ?? result.data.runs[0]?.id);
      setNotice("Loaded the latest run history from the database.");
    }
  }

  async function cancelActive() {
    const target =
      activeRunId ?? runs.find((r) => isActive(r.status))?.id ?? null;
    if (!target || cancelling) return;
    setCancelling(true);
    setNotice("");
    try {
      await callAction("cancel-debate-run", { runId: target });
      setNotice(
        "Cancellation recorded. Saved messages remain in history. A model request already sent may still finish.",
      );
      setUncertain(false);
      await history.refetch();
    } catch {
      setNotice("Cancel failed. Refresh history to confirm server state.");
    } finally {
      setCancelling(false);
    }
  }

  async function exportCurrent(
    format: "markdown" | "json" | "html" | "copy",
  ) {
    if (!current || exporting) return;
    setExporting(true);
    setNotice("");
    try {
      if (format === "copy") {
        await copyDebateSummary(current);
        setNotice("Copied the run summary to the clipboard.");
      } else {
        const result = await exportDebateRun(current, format);
        const delivery = downloadExportedDebate(result);
        setNotice(
          format === "html"
            ? delivery === "opened"
              ? "Opened a print-ready report — use your browser's Print → Save as PDF."
              : "Downloaded the HTML report because a new tab could not open. Open the file, then Print → Save as PDF."
            : `Downloaded ${format} export.`,
        );
      }
    } catch {
      setNotice("Export failed. Confirm the run loaded, then retry.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Debate</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Proponent, Opponent, and Judge appear side by side as messages
            arrive. Each Start creates a new run; cancel a stuck active run
            before starting again.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link to={debateEvidencePath(debateId)}>Back to Evidence</Link>
          </Button>
          <Button
            disabled={
              sending ||
              cancelling ||
              uncertain ||
              active ||
              !hasEvidence ||
              !history.isSuccess
            }
            onClick={start}
          >
            {active || sending ? "Debate in progress…" : "Start debate"}
          </Button>
          <Button
            variant="outline"
            disabled={!active || cancelling || sending}
            onClick={cancelActive}
          >
            {cancelling ? "Cancelling…" : "Cancel active run"}
          </Button>
          <Button variant="outline" onClick={refresh}>
            Refresh
          </Button>
          {current && (
            <Button asChild variant="outline">
              <Link to={debateConclusionPath(debateId, current)}>
                Conclusion
              </Link>
            </Button>
          )}
          <Button asChild variant="outline">
            <Link to={debateComparePath(debateId)}>Compare runs</Link>
          </Button>
        </div>
      </div>

      {active && activeRunId && (
        <p role="status" className="rounded-md border border-sky-400/40 bg-sky-50/50 p-3 text-sm dark:bg-sky-950/30">
          Active run: <code>{activeRunId}</code>. Wait for completion, or
          cancel it to unlock Start.
        </p>
      )}

      {models.data && (
        <label className="block max-w-xl space-y-1 text-sm">
          <span>Model (allowlist)</span>
          <select
            className="w-full rounded border bg-background p-2"
            value={modelId || models.data.defaultModelId}
            onChange={(e) => setModelId(e.target.value)}
            disabled={sending || active}
          >
            {models.data.models.map((model) => (
              <option key={model.id} value={model.id} disabled={!model.enabled}>
                {model.label} · {model.pricing}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground">
            Budget: $0 per run. Up to three role requests. If a free endpoint is unavailable, the run stops.
          </span>
        </label>
      )}
      <div className="space-y-1">
        <Button variant="outline" disabled={checkingModel} onClick={checkModel}>
          {checkingModel ? "Checking…" : "Check model availability and pricing"}
        </Button>
        <p role="status" className="text-xs text-muted-foreground">{modelNotice}</p>
      </div>
      {!hasEvidence && (
        <p role="status">
          Attach at least one paper on the Evidence page before starting.
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {page.isError && (
        <p role="alert">Could not load run history. Refresh and try again.</p>
      )}
      {page.isSuccess && !runs.length && (
        <p className="text-muted-foreground">
          No runs yet. Start a debate to fill the three columns.
        </p>
      )}
      {!!runs.length && (
        <div className="space-y-3">
          <label className="block space-y-1 text-sm">
            <span>Select a run</span>
            <select
              value={current}
              onChange={(e) => setSelected(e.target.value)}
              className="max-w-full rounded border bg-background p-2"
            >
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {new Date(r.createdAt).toLocaleString()} ·{" "}
                  {statuses[r.status] ?? r.status}
                  {r.finishedAt
                    ? ` · done ${new Date(r.finishedAt).toLocaleString()}`
                    : ""}
                  {r.errorSummary ? ` · ${r.errorSummary.slice(0, 40)}` : ""}
                </option>
              ))}
            </select>
          </label>
          {current && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={exporting}
                onClick={() => exportCurrent("markdown")}
              >
                Export Markdown
              </Button>
              <Button
                variant="outline"
                disabled={exporting}
                onClick={() => exportCurrent("json")}
              >
                Export JSON
              </Button>
              <Button
                variant="outline"
                disabled={exporting}
                onClick={() => exportCurrent("html")}
              >
                Print / PDF
              </Button>
              <Button
                variant="outline"
                disabled={exporting}
                onClick={() => exportCurrent("copy")}
              >
                Copy summary
              </Button>
            </div>
          )}
        </div>
      )}
      {(cursor || page.data?.nextCursor) && (
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={!cursor}
            onClick={() => {
              setSelected(undefined);
              setPages((p) => p.slice(0, -1));
            }}
          >
            Newer
          </Button>
          <Button
            variant="outline"
            disabled={!page.data?.nextCursor}
            onClick={() => {
              const next = page.data?.nextCursor;
              if (next) {
                setSelected(undefined);
                setPages((p) => [...p, next]);
              }
            }}
          >
            Older
          </Button>
        </div>
      )}
      {current && <RunArena key={current} runId={current} />}
    </section>
  );
}

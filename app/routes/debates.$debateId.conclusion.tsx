import { useActionQuery } from "@agent-native/core/client/use-action";
import { useMutation } from "@tanstack/react-query";
import { Link, useOutletContext, useSearchParams } from "react-router";

import { Button } from "@/components/ui/button";

import { DebateStepNav } from "../components/debate/DebateStepNav";
import { HumanDiscussion } from "../components/debate/HumanDiscussion";
import {
  copyDebateSummary,
  downloadExportedDebate,
  exportDebateRun,
} from "../lib/debate-export-client";
import {
  debateArenaPath,
  debateComparePath,
} from "../lib/debate-paths";
import type { DebateOutletContext } from "./debates.$debateId";

const verdicts = {
  supports: "Supports the claim",
  opposes: "Opposes the claim",
  insufficient_evidence: "Insufficient evidence",
} as const;

export function meta() {
  return [{ title: "Conclusion · Scientific Debate" }];
}

export default function DebateConclusionRoute() {
  const { debateId } = useOutletContext<DebateOutletContext>();
  const [params] = useSearchParams();
  const history = useActionQuery(
    "list-debate-runs",
    { debateId },
    { retry: false },
  );
  const preferredRunId = params.get("runId");
  const completed =
    history.data?.runs.find((run) => run.id === preferredRunId) ??
    history.data?.runs.find((run) => run.status === "completed") ??
    history.data?.runs[0];
  const requestedId = preferredRunId || completed?.id;
  const detail = useActionQuery(
    "get-debate-run",
    { runId: requestedId ?? "" },
    { enabled: Boolean(requestedId), retry: false },
  );
  const run = detail.data?.debateId === debateId ? detail.data : undefined;
  const runId = run?.id;

  const exportMutation = useMutation({
    mutationFn: async (format: "markdown" | "json" | "html" | "copy") => {
      if (!runId) throw new Error("No run selected.");
      if (format === "copy") {
        await copyDebateSummary(runId);
        return { kind: "copy" as const };
      }
      const result = await exportDebateRun(runId, format);
      const delivery = downloadExportedDebate(result);
      return { kind: format, delivery };
    },
  });

  const judge = run?.messages.find((m) => m.output.role === "judge");
  const proponent = run?.messages.find(
    (m) => m.output.role === "proponent",
  );
  const opponent = run?.messages.find(
    (m) => m.output.role === "opponent",
  );

  return (
    <div className="space-y-6">
      <DebateStepNav
        debateId={debateId}
        active="conclusion"
        {...(runId ? { runId } : {})}
      />

      <section className="space-y-4 rounded-xl border bg-card/90 p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">Conclusion</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Structured judge report for this claim. Exports stay private —
              Markdown, JSON, or print-to-PDF. No public share link is created.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link to="/home">Back to Claims</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to={debateArenaPath(debateId)}>Debate arena</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to={debateComparePath(debateId)}>Compare runs</Link>
            </Button>
            <Button
              variant="outline"
              disabled={!runId || exportMutation.isPending}
              onClick={() => exportMutation.mutate("markdown")}
            >
              Export Markdown
            </Button>
            <Button
              variant="outline"
              disabled={!runId || exportMutation.isPending}
              onClick={() => exportMutation.mutate("json")}
            >
              Export JSON
            </Button>
            <Button
              variant="outline"
              disabled={!runId || exportMutation.isPending}
              onClick={() => exportMutation.mutate("html")}
            >
              Print / PDF
            </Button>
            <Button
              variant="outline"
              disabled={!runId || exportMutation.isPending}
              onClick={() => exportMutation.mutate("copy")}
            >
              Copy summary
            </Button>
          </div>
        </div>

        {((!requestedId && history.isPending) || (requestedId && detail.isPending)) && (
          <p role="status">Loading report…</p>
        )}
        {!requestedId && history.isError && <p role="alert">Could not load run history. <button className="underline" onClick={() => history.refetch()}>Try again</button></p>}
        {history.isSuccess && !requestedId && (
          <p role="status">
            No runs yet.{" "}
            <Link className="underline" to={debateArenaPath(debateId)}>
              Start a debate
            </Link>{" "}
            first.
          </p>
        )}
        {(detail.isError || (detail.data && !run)) && (
          <p role="alert">Could not load the selected run.</p>
        )}
        {run && (
          <div className="space-y-5">
            <p className="text-sm text-muted-foreground">
              {run.status} · {run.modelId}
              {runId ? ` · ${runId}` : ""}
              {run.finishedAt
                ? ` · finished ${new Date(run.finishedAt).toLocaleString()}`
                : ""}
            </p>
            {run.status === "failed" && run.errorSummary && (
              <p
                role="alert"
                className="rounded-md border border-rose-400/40 bg-rose-50/60 p-3 text-sm dark:bg-rose-950/30"
              >
                {run.errorSummary}
              </p>
            )}

            <article className="space-y-2 rounded-lg border border-amber-400/40 bg-amber-50/50 p-4 dark:bg-amber-950/30">
              <h3 className="font-semibold">Judge verdict</h3>
              {judge?.output.role === "judge" ? (
                <>
                  <p className="text-lg font-medium">
                    {verdicts[judge.output.verdict]} ·{" "}
                    {Math.round(judge.output.confidence * 100)}% confidence
                  </p>
                  <p>{judge.output.summary}</p>
                  <h4 className="font-medium">Reasons and supporting evidence</h4>
                  {judge.output.arguments.map((arg, index) => <div key={index} className="border-l pl-3">
                    <strong>{arg.claim}</strong><p>{arg.support}</p>
                    {arg.citedExternalIds.length === 0 && <small>No paper cited for this argument.</small>}
                    {arg.citedExternalIds.map(id => {
                      const paper = run.evidencePack.papers.find(p => p.externalId === id);
                      return paper && /^https?:\/\//i.test(paper.providerUrl)
                        ? <a key={id} className="block text-sm underline" href={paper.providerUrl} target="_blank" rel="noopener noreferrer">{paper.title} · {id}</a>
                        : <small key={id}>{id}</small>;
                    })}
                  </div>)}
                  <p className="text-sm text-muted-foreground">Confidence is the judge model’s assessment of this snapshot.</p>
                  {judge.output.researchNotes && <section className="space-y-2">
                    <h4 className="font-medium">Evidence conflicts</h4><p>{judge.output.researchNotes.evidenceConflict}</p>
                    <h4 className="font-medium">Reasoning gap</h4><p>{judge.output.researchNotes.reasoningGap}</p>
                    <h4 className="font-medium">Questions for further research</h4>
                    <ul className="list-disc pl-5">{judge.output.researchNotes.nextQuestions.map((q,i) => <li key={i}>{q}</li>)}</ul>
                  </section>}
                  {judge.output.limitations.length > 0 && (
                    <div>
                      <p className="text-sm font-medium">Limitations</p>
                      <ul className="list-disc pl-5 text-sm">
                        {judge.output.limitations.map((item, i) => (
                          <li key={i}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              ) : (
                <p>No judge message on this run yet.</p>
              )}
            </article>

            <div className="grid gap-4 md:grid-cols-2">
              <article className="rounded-lg border p-4">
                <h3 className="font-semibold">Proponent highlights</h3>
                <p className="mt-2 text-sm">
                  {proponent?.output.summary ?? "Not available."}
                </p>
              </article>
              <article className="rounded-lg border p-4">
                <h3 className="font-semibold">Opponent highlights</h3>
                <p className="mt-2 text-sm">
                  {opponent?.output.summary ?? "Not available."}
                </p>
              </article>
            </div>

            <article className="rounded-lg border p-4">
              <h3 className="font-semibold">Claim under review</h3>
              <p className="mt-2">{run.evidencePack.claim}</p>
            </article>

            <details className="rounded-lg border p-4">
              <summary className="cursor-pointer font-medium">
                EvidencePack (
                {run.evidencePack.papers.length})
              </summary>
              <ul className="mt-3 space-y-3">
                {run.evidencePack.papers.map((paper) => (
                  <li key={paper.externalId}>
                    <p className="font-medium">{paper.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {paper.externalId}
                    </p>
                  </li>
                ))}
              </ul>
            </details>
            <HumanDiscussion key={run.id} runId={run.id} messages={run.messages} papers={run.evidencePack.papers} />
          </div>
        )}
        {exportMutation.isSuccess && exportMutation.data.kind === "copy" && (
          <p role="status">Copied the run summary to the clipboard.</p>
        )}
        {exportMutation.isSuccess && exportMutation.data.kind === "html" && (
          <p role="status">
            {exportMutation.data.delivery === "opened"
              ? "Opened a print-ready report. Use your browser's Print → Save as PDF."
              : "Downloaded the HTML report because a new tab could not open. Open the file, then Print → Save as PDF."}
          </p>
        )}
        {exportMutation.isError && (
          <p role="alert">Export failed. Try again after confirming the run.</p>
        )}
      </section>
    </div>
  );
}

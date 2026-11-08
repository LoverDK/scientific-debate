import {
  callAction,
  useActionQuery,
} from "@agent-native/core/client/use-action";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";

import { debateArenaPath } from "../lib/debate-paths";

function PaperInfo({
  paper,
}: {
  paper: {
    title: string | null;
    authors: string[];
    year: number | null;
    externalId: string;
    stance?: string | null;
    stanceRationale?: string | null;
  };
}) {
  return (
    <div className="min-w-0">
      <p className="break-words font-medium">
        {paper.title || paper.externalId}
      </p>
      <p className="text-sm text-muted-foreground">
        {[paper.authors.slice(0, 3).join(", "), paper.year, paper.externalId]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {paper.stanceRationale && (
        <p className="mt-1 text-xs text-muted-foreground">
          {paper.stanceRationale}
        </p>
      )}
    </div>
  );
}

function StanceGroup({
  title,
  tone,
  papers,
}: {
  title: string;
  tone: string;
  papers: Array<{
    id: string;
    title: string | null;
    authors: string[];
    year: number | null;
    externalId: string;
    stance?: string | null;
    stanceRationale?: string | null;
  }>;
}) {
  return (
    <div className={`rounded-lg border p-4 ${tone}`}>
      <h3 className="font-semibold">
        {title} ({papers.length})
      </h3>
      {papers.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">None yet.</p>
      ) : (
        <ul className="mt-2 divide-y">
          {papers.map((paper) => (
            <li key={paper.id} className="py-3">
              <PaperInfo paper={paper} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DebateEvidence({
  debateId,
  claim,
}: {
  debateId: string;
  claim: string;
}) {
  const autoGatheredFor = useRef<string | null>(null);
  const [searchTerms, setSearchTerms] = useState("");
  const attached = useActionQuery(
    "list-debate-papers",
    { debateId },
    { retry: false },
  );

  const gather = useMutation({
    mutationFn: () =>
      callAction(
        "gather-debate-evidence",
        { debateId, maxPerStance: 5, ...(searchTerms.trim() ? { searchTerms: searchTerms.trim() } : {}) },
        { timeoutMs: 300_000 },
      ),
    onSuccess: async () => {
      await attached.refetch();
    },
    retry: false,
  });

  // Agent-first path: when the claim has no papers, gather automatically.
  useEffect(() => {
    if (!claim.trim()) return;
    if (attached.isPending || attached.isError) return;
    if (attached.data && attached.data.papers.length > 0) return;
    if (autoGatheredFor.current === debateId) return;
    if (gather.isPending) return;
    autoGatheredFor.current = debateId;
    gather.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debateId, claim, attached.isPending, attached.isError, attached.data]);

  const hasEvidence = Boolean(attached.data?.papers.length);
  const byStance = attached.data?.byStance ?? {
    supports: [],
    opposes: [],
    uncertain: [],
  };

  return (
    <section className="space-y-4 rounded-xl border bg-card/90 p-5 shadow-sm backdrop-blur">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Evidence</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The Agent searches OpenAlex for supportive and critical papers, then
            labels stance with the free OpenRouter model (title/abstract only).
            You review the pack — you do not need to search and pick papers.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={gather.isPending}
            onClick={() => {
              autoGatheredFor.current = debateId;
              gather.mutate();
            }}
          >
            {gather.isPending
              ? "Gathering evidence…"
              : hasEvidence
                ? "Re-gather evidence"
                : "Gather evidence"}
          </Button>
          {hasEvidence ? (
            <Button asChild>
              <Link to={debateArenaPath(debateId)}>Continue to Debate</Link>
            </Button>
          ) : (
            <Button disabled>Continue to Debate</Button>
          )}
        </div>
      </div>

      {gather.isPending && !hasEvidence && (
        <p role="status">
          Searching OpenAlex, then classifying stance with the free OpenRouter
          model (may take up to a few minutes)…
        </p>
      )}
      {gather.isError && (
        <div className="space-y-2">
        <p role="alert">
          Evidence gathering failed
          {gather.error instanceof Error && gather.error.message
            ? `: ${gather.error.message.replace(/^Action gather-debate-evidence failed:\s*/i, "")}`
            : ". Try again."}
        </p>
        <label className="block text-sm">Paper title or search terms (optional)
          <input className="mt-1 block w-full rounded border bg-background p-2" maxLength={180}
            value={searchTerms} onChange={e => setSearchTerms(e.target.value)} />
        </label>
        <Button variant="outline" onClick={() => gather.mutate()}>Gather evidence again</Button>
        </div>
      )}
      {gather.isSuccess && (
        <p role="status">
          Attached {gather.data.attached.supports.length} supporting,{" "}
          {gather.data.attached.opposes.length} opposing,{" "}
          {gather.data.attached.uncertain.length} uncertain via{" "}
          {gather.data.classifierModelId}. {gather.data.note}
        </p>
      )}

      {attached.isPending && <p role="status">Loading attached papers…</p>}
      {attached.isError && (
        <p role="alert">
          Could not load attached papers.
          <Button variant="link" onClick={() => void attached.refetch()}>
            Retry
          </Button>
        </p>
      )}

      {attached.data && (
        <div className="grid gap-4 lg:grid-cols-3">
          <StanceGroup
            title="Supports claim"
            tone="border-emerald-400/60 bg-emerald-50/40 dark:bg-emerald-950/20"
            papers={byStance.supports}
          />
          <StanceGroup
            title="Opposes claim"
            tone="border-rose-400/60 bg-rose-50/40 dark:bg-rose-950/20"
            papers={byStance.opposes}
          />
          <StanceGroup
            title="Uncertain / mixed"
            tone="border-amber-400/60 bg-amber-50/40 dark:bg-amber-950/20"
            papers={byStance.uncertain}
          />
        </div>
      )}

      <details className="rounded-lg border p-3 text-sm text-muted-foreground">
        <summary className="cursor-pointer font-medium text-foreground">
          Advanced: manual override
        </summary>
        <p className="mt-2">
          Manual OpenAlex search remains available to Agents via{" "}
          <code>search-papers</code> / <code>attach-paper-to-debate</code> when
          you need to override the automatic pack. The default product path is{" "}
          <code>gather-debate-evidence</code>.
        </p>
      </details>

      <div className="flex justify-end border-t pt-4">
        {hasEvidence ? (
          <Button asChild>
            <Link to={debateArenaPath(debateId)}>Continue to Debate</Link>
          </Button>
        ) : (
          <Button disabled>Continue to Debate</Button>
        )}
      </div>
    </section>
  );
}

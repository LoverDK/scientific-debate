import {
  callAction,
  useActionQuery,
} from "@agent-native/core/client/use-action";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { DebateStepNav } from "../components/debate/DebateStepNav";
import { debateEvidencePath } from "../lib/debate-paths";

export function meta() {
  return [
    { title: "Scientific Debate" },
    {
      name: "description",
      content:
        "Evidence-grounded scientific claim debates. Agent and UI share the same Actions.",
    },
  ];
}

export default function HomeRoute() {
  const navigate = useNavigate();
  const debates = useActionQuery("list-debates", {}, { retry: false });
  const [claim, setClaim] = useState("");
  const create = useMutation({
    mutationFn: (text: string) =>
      callAction("create-debate", { claim: text, inputType: "text" }),
    onSuccess: async (result) => {
      setClaim("");
      await debates.refetch();
      void navigate(debateEvidencePath(result.debateId));
    },
    retry: false,
  });

  return (
    <main className="h-full overflow-y-auto bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-sky-50 via-background to-background dark:from-sky-950/40">
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-8">
        <DebateStepNav active="claims" />

        <header className="space-y-3">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-sky-700 dark:text-sky-300">
            Agent-Native · OpenAlex · Three-role debate
          </p>
          <h1 className="text-4xl font-semibold tracking-tight">
            Scientific Debate
          </h1>
          <p className="max-w-2xl text-lg text-muted-foreground">
            Create a claim. The Agent gathers supporting and opposing papers
            automatically — you review stance labels, then run the debate.
          </p>
        </header>

        <aside className="rounded-xl border border-sky-200/80 bg-sky-50/80 p-4 text-sm leading-relaxed text-sky-950 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-50">
          <p className="font-semibold">Flow</p>
          <p className="mt-1 text-sky-900/90 dark:text-sky-100/90">
            1 Claims → 2 Evidence (Agent gathers support/oppose papers) → 3
            Debate → 4 Conclusion. Prefer gather-debate-evidence over manual
            search.
          </p>
        </aside>

        <section className="space-y-4 rounded-xl border bg-card/90 p-5 shadow-sm backdrop-blur">
          <h2 className="text-xl font-semibold">New claim</h2>
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (claim.trim() && !create.isPending)
                create.mutate(claim.trim());
            }}
          >
            <label htmlFor="new-claim" className="text-sm font-medium">
              Scientific claim
            </label>
            <div className="flex gap-2">
              <Input
                id="new-claim"
                value={claim}
                disabled={create.isPending}
                onChange={(event) => setClaim(event.target.value)}
                placeholder="e.g. Intermittent fasting improves insulin sensitivity…"
              />
              <Button type="submit" disabled={!claim.trim() || create.isPending}>
                {create.isPending ? "Creating…" : "Create"}
              </Button>
            </div>
          </form>
          {create.isError && (
            <p role="alert">
              Create request failed. Refresh the list to confirm whether it was
              saved.
            </p>
          )}
        </section>

        <section className="space-y-4 rounded-xl border bg-card/90 p-5 shadow-sm backdrop-blur">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-xl font-semibold">Your claims</h2>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void debates.refetch()}
            >
              Refresh
            </Button>
          </div>
          {debates.isError && (
            <p role="alert">Could not load claims.</p>
          )}
          {debates.isPending && <p role="status">Loading claims…</p>}
          {debates.data?.debates.length === 0 && (
            <p className="text-muted-foreground">
              No claims yet. Create one above to open Evidence.
            </p>
          )}
          {!!debates.data?.debates.length && (
            <ul className="divide-y">
              {debates.data.debates.map((item) => (
                <li key={item.id}>
                  <Link
                    to={debateEvidencePath(item.id)}
                    className="flex flex-col gap-1 py-3 transition-colors hover:text-sky-800 dark:hover:text-sky-300"
                  >
                    <span className="font-medium">{item.claim}</span>
                    <span className="text-xs text-muted-foreground">
                      {item.status} ·{" "}
                      {new Date(item.createdAt).toLocaleString()}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

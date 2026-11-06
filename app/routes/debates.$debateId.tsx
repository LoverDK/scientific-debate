import { useActionQuery } from "@agent-native/core/client/use-action";
import { Link, Outlet, useParams } from "react-router";

import { Button } from "@/components/ui/button";

export type DebateOutletContext = {
  debateId: string;
  claim: string;
};

export function meta() {
  return [{ title: "Scientific Debate" }];
}

export default function DebateLayoutRoute() {
  const { debateId = "" } = useParams();
  const debate = useActionQuery(
    "get-debate",
    { debateId },
    { enabled: Boolean(debateId), retry: false },
  );

  if (!debateId) {
    return (
      <main className="p-8">
        <p role="alert">Missing debate id.</p>
        <Button asChild variant="outline" className="mt-3">
          <Link to="/home">Back to claims</Link>
        </Button>
      </main>
    );
  }

  if (debate.isError) {
    return (
      <main className="mx-auto max-w-3xl space-y-4 p-8">
        <p role="alert">Could not load this claim.</p>
        <Button asChild variant="outline">
          <Link to="/home">Back to claims</Link>
        </Button>
      </main>
    );
  }

  return (
    <main className="h-full overflow-y-auto bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-sky-50 via-background to-background dark:from-sky-950/40">
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-8">
        <header className="space-y-2">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-sky-700 dark:text-sky-300">
            Claim
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-balance">
            {debate.isPending ? "Loading claim…" : debate.data?.claim}
          </h1>
        </header>
        <Outlet
          context={
            {
              debateId,
              claim: debate.data?.claim ?? "",
            } satisfies DebateOutletContext
          }
        />
      </div>
    </main>
  );
}

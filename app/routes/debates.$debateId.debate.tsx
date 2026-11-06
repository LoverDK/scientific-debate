import { useActionQuery } from "@agent-native/core/client/use-action";
import { useOutletContext } from "react-router";

import { DebateRuns } from "../components/DebateRuns";
import { DebateStepNav } from "../components/debate/DebateStepNav";
import type { DebateOutletContext } from "./debates.$debateId";

export function meta() {
  return [{ title: "Debate · Scientific Debate" }];
}

export default function DebateArenaRoute() {
  const { debateId } = useOutletContext<DebateOutletContext>();
  const attached = useActionQuery(
    "list-debate-papers",
    { debateId },
    { retry: false },
  );

  return (
    <div className="space-y-6">
      <DebateStepNav debateId={debateId} active="debate" />
      {attached.isError && (
        <p role="alert">Could not verify attached papers for this claim.</p>
      )}
      <DebateRuns
        debateId={debateId}
        hasEvidence={Boolean(attached.data?.papers.length)}
      />
    </div>
  );
}

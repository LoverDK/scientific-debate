import { useOutletContext } from "react-router";

import { DebateEvidence } from "../components/DebateEvidence";
import { DebateStepNav } from "../components/debate/DebateStepNav";
import type { DebateOutletContext } from "./debates.$debateId";

export function meta() {
  return [{ title: "Evidence · Scientific Debate" }];
}

export default function DebateEvidenceRoute() {
  const { debateId, claim } = useOutletContext<DebateOutletContext>();

  return (
    <div className="space-y-6">
      <DebateStepNav debateId={debateId} active="evidence" />
      <DebateEvidence key={debateId} debateId={debateId} claim={claim} />
    </div>
  );
}

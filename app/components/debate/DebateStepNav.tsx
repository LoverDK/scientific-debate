import { Link } from "react-router";

import { cn } from "@/lib/utils";

import {
  debateArenaPath,
  debateConclusionPath,
  debateEvidencePath,
} from "../../lib/debate-paths";

const steps = [
  { id: "claims", label: "1 · Claims" },
  { id: "evidence", label: "2 · Evidence" },
  { id: "debate", label: "3 · Debate" },
  { id: "conclusion", label: "4 · Conclusion" },
] as const;

export function DebateStepNav({
  debateId,
  active,
  runId,
}: {
  debateId?: string;
  active: "claims" | "evidence" | "debate" | "conclusion";
  runId?: string;
}) {
  return (
    <nav aria-label="Debate steps" className="flex flex-wrap gap-2 text-sm">
      {steps.map((step) => {
        const href =
          step.id === "claims"
            ? "/home"
            : !debateId
              ? undefined
              : step.id === "evidence"
                ? debateEvidencePath(debateId)
                : step.id === "debate"
                  ? debateArenaPath(debateId)
                  : debateConclusionPath(debateId, runId);
        const isActive = step.id === active;
        const className = cn(
          "rounded-full px-3 py-1.5 transition-colors",
          isActive
            ? "bg-sky-700 text-white dark:bg-sky-400 dark:text-sky-950"
            : href
              ? "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
              : "bg-muted/50 text-muted-foreground/60",
        );
        if (!href) {
          return (
            <span key={step.id} className={className}>
              {step.label}
            </span>
          );
        }
        return (
          <Link
            key={step.id}
            to={href}
            aria-current={isActive ? "step" : undefined}
            className={className}
          >
            {step.label}
          </Link>
        );
      })}
    </nav>
  );
}

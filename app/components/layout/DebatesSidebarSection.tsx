import { useActionQuery } from "@agent-native/core/client/use-action";
import { IconScale } from "@tabler/icons-react";
import { Link, useLocation } from "react-router";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { debateEvidencePath } from "../../lib/debate-paths";

export function DebatesSidebarSection({ collapsed }: { collapsed: boolean }) {
  const location = useLocation();
  const debates = useActionQuery("list-debates", {}, { retry: false });

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to="/home"
            aria-label="Debates"
            className="flex size-8 items-center justify-center rounded-md text-sidebar-accent-foreground transition-colors hover:bg-sidebar-accent"
          >
            <IconScale className="size-4" strokeWidth={1.8} />
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">Debates</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col px-2 pb-3">
      <div className="mb-2 flex items-center justify-between px-1 pt-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          My debates
        </p>
        <Link
          to="/home"
          className="text-xs text-sky-700 hover:underline dark:text-sky-300"
        >
          All
        </Link>
      </div>
      {debates.isPending && (
        <p className="px-1 text-xs text-muted-foreground">Loading…</p>
      )}
      {debates.isError && (
        <p className="px-1 text-xs text-muted-foreground">
          Could not load debates.
        </p>
      )}
      {debates.data?.debates.length === 0 && (
        <p className="px-1 text-xs text-muted-foreground">
          No debates yet. Create one on Home.
        </p>
      )}
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        {debates.data?.debates.map((item) => {
          const href = debateEvidencePath(item.id);
          const active = location.pathname.startsWith(
            `/debates/${encodeURIComponent(item.id)}`,
          );
          return (
            <li key={item.id}>
              <Link
                to={href}
                className={cn(
                  "block rounded-lg px-2 py-2 text-sm transition-colors hover:bg-sidebar-accent",
                  active && "bg-sidebar-accent",
                )}
                title={item.claim}
              >
                <span className="line-clamp-2 text-sidebar-accent-foreground">
                  {item.claim}
                </span>
                <span className="mt-0.5 block text-[0.65rem] text-muted-foreground">
                  {item.status}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

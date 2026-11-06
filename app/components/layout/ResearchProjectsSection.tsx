import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { useActionQuery } from "@agent-native/core/client/use-action";
import { IconChevronRight, IconFolder, IconPlus } from "@tabler/icons-react";
import { debateEvidencePath } from "@/lib/debate-paths";

function ProjectRow({ id, title, selected }: { id: string; title: string; selected: boolean }) {
  const [open, setOpen] = useState(selected);
  useEffect(() => { if (selected) setOpen(true); }, [selected]);
  const linked = useActionQuery("list-project-debates", { projectId: id }, { enabled: open, retry: false });
  return <li>
    <div className={`flex items-center rounded-md hover:bg-sidebar-accent ${selected ? "bg-sidebar-accent" : ""}`}>
      <button type="button" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${title}`}
        className="p-1" onClick={() => setOpen(!open)}>
        <IconChevronRight className={`size-3.5 ${open ? "rotate-90" : ""}`}/>
      </button>
      <Link to={`/workspace?project=${encodeURIComponent(id)}`} aria-current={selected ? "page" : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 text-sm" onClick={() => setOpen(true)}>
        <IconFolder className="size-4 shrink-0"/><span className="truncate" title={title}>{title}</span>
      </Link>
    </div>
    {open && <div className="ml-4 border-l pl-3 text-xs">
      {linked.isPending && <p>Loading debates…</p>}
      {linked.isError && <button onClick={() => linked.refetch()}>Retry loading debates</button>}
      {linked.data?.debates.length === 0 && <p className="py-1 text-muted-foreground">No debates yet</p>}
      {linked.data?.debates.map(d => <Link key={d.debateId} to={debateEvidencePath(d.debateId)}
        className="block truncate rounded px-1 py-1.5 hover:bg-sidebar-accent" title={d.claim}>{d.claim}</Link>)}
    </div>}
  </li>;
}

export function ResearchProjectsSection({ collapsed }: { collapsed: boolean }) {
  const location = useLocation();
  const projects = useActionQuery("list-research-projects", {}, { enabled: !collapsed, retry: false });
  const selected = location.pathname === "/workspace" && new URLSearchParams(location.search).get("project");
  if (collapsed) return <Link className="flex size-8 items-center justify-center" to="/workspace" title="Research projects" aria-label="Research projects"><IconFolder className="size-4"/></Link>;
  return <nav aria-label="Research projects" className="max-h-[38vh] shrink-0 overflow-y-auto px-2 pb-2">
    <div className="flex items-center justify-between px-1 py-2 text-xs font-medium">
      <Link to="/workspace">Research projects</Link>
      <Link to="/workspace?new=1" aria-label="Create research project" title="Create research project"><IconPlus className="size-4"/></Link>
    </div>
    {projects.isError && <button className="text-xs" onClick={() => projects.refetch()}>Retry loading projects</button>}
    {projects.data?.projects.length === 0 && <Link className="px-2 text-xs text-muted-foreground" to="/workspace?new=1">Create your first project</Link>}
    <ul>{projects.data?.projects.map(p => <ProjectRow key={p.id} id={p.id} title={p.title} selected={p.id === selected}/>)}</ul>
  </nav>;
}

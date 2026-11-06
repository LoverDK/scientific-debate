import {
  callAction,
  useActionQuery,
} from "@agent-native/core/client/use-action";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  debateConclusionPath,
  debateEvidencePath,
  debateArenaPath,
} from "../lib/debate-paths";

export function meta() {
  return [{ title: "Research workspace · Scientific Debate" }];
}

function CreateProject({ onCreated }: { onCreated: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const create = useMutation({
    mutationFn: () =>
      callAction("create-research-project", {
        title: title.trim(),
        description: description.trim(),
      }),
    onSuccess: (result) => onCreated(result.projectId),
    retry: false,
  });
  return (
    <form
      className="grid gap-3 rounded-xl border bg-card p-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (title.trim() && !create.isPending) create.mutate();
      }}
    >
      <h2 className="text-lg font-semibold">New project</h2>
      <label>
        Project title
        <Input
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={200}
          required
        />
      </label>
      <label>
        Description (optional)
        <Input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={2000}
        />
      </label>
      <Button
        className="justify-self-start"
        type="submit"
        disabled={!title.trim() || create.isPending}
      >
        Create project
      </Button>
      {create.isError && <p role="alert">Could not create the project.</p>}
    </form>
  );
}

function ProjectDetail({
  projectId,
  onArchived,
}: {
  projectId: string;
  onArchived: () => void;
}) {
  const linked = useActionQuery(
    "list-project-debates",
    { projectId },
    { retry: false },
  );
  const debates = useActionQuery(
    "list-debates",
    {},
    { retry: false, enabled: !!linked.data && !linked.data.project.archivedAt },
  );
  const [debateId, setDebateId] = useState("");
  const [filter, setFilter] = useState("");
  const add = useMutation({
    mutationFn: () =>
      callAction("add-debate-to-project", { projectId, debateId }),
    onSuccess: async () => {
      setDebateId("");
      await linked.refetch();
    },
    retry: false,
  });
  const archive = useMutation({
    mutationFn: () => callAction("archive-research-project", { projectId }),
    onSuccess: async () => {
      await linked.refetch();
      onArchived();
    },
    retry: false,
  });
  if (linked.isError)
    return (
      <p role="alert">
        Could not load this project.{" "}
        <Button variant="link" onClick={() => void linked.refetch()}>
          Try again
        </Button>
      </p>
    );
  if (!linked.data) return <p role="status">Loading project…</p>;
  const { project, debates: claims, papers } = linked.data;
  const completed = claims.filter(
    (claim) => claim.runStatus === "completed",
  ).length;
  const term = filter.trim().toLowerCase();
  const matches = (...values: (string | null)[]) => values.some(value => value?.toLowerCase().includes(term));
  const visibleClaims = claims.filter(item => matches(item.claim, item.debateId));
  const visiblePapers = papers.filter(paper => matches(paper.title, paper.id, paper.externalId));
  const byId = new Map(claims.map((claim) => [claim.debateId, claim]));
  return (
    <article className="space-y-6 rounded-xl border bg-card p-5">
      <header>
        <h2 className="text-xl font-semibold">{project.title}</h2>
        {project.description && <p>{project.description}</p>}
        {project.archivedAt && <p>Archived project</p>}
      </header>
      <label className="block">Search this project<Input value={filter} onChange={event => setFilter(event.target.value)} placeholder="Claim, paper title, or ID" /></label>
      <section className="space-y-3">
        <h3 className="font-semibold">Claims and results</h3>
        {term && !visibleClaims.length && <p>No matching claims.</p>}
        <p className="text-sm text-muted-foreground">
          {completed} of {claims.length} claims have a completed current run.
        </p>
        <ul className="divide-y">
          {visibleClaims.map((item) => (
            <li key={item.debateId} className="space-y-1 py-2">
              <Link
                className="font-medium underline"
                to={debateEvidencePath(item.debateId)}
              >
                {item.claim}
              </Link>
              <div className="flex flex-wrap gap-3 text-sm">
                <span>{item.runStatus ?? item.status}</span>
                {item.currentRunId && (
                  <Link
                    className="underline"
                    to={
                      item.runStatus === "completed"
                        ? debateConclusionPath(item.debateId, item.currentRunId)
                        : debateArenaPath(item.debateId)
                    }
                  >
                    {item.runStatus === "completed"
                      ? "View conclusion"
                      : "View run"}
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
        {!project.archivedAt && (
          <div className="flex flex-wrap gap-2">
            <select
              aria-label="Claim to add"
              className="min-w-0 flex-1 rounded border bg-background p-2"
              value={debateId}
              onChange={(e) => setDebateId(e.target.value)}
            >
              <option value="">Select a claim</option>
              {debates.data?.debates
                .filter((item) => !byId.has(item.id))
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.claim}
                  </option>
                ))}
            </select>
            <Button
              disabled={!debateId || add.isPending || archive.isPending}
              onClick={() => add.mutate()}
            >
              Add claim
            </Button>
          </div>
        )}
        {debates.isError && (
          <p role="alert">Could not load available claims.</p>
        )}
        {add.isError && (
          <p role="alert">
            Could not add the claim. Refresh the project to check its status.
          </p>
        )}
      </section>
      <section className="space-y-2">
        <h3 className="font-semibold">Papers ({visiblePapers.length})</h3>
        {term && papers.length > 0 && !visiblePapers.length && <p>No matching papers.</p>}
        {!papers.length && <p>No papers attached to the project's claims.</p>}
        <ul className="divide-y">
          {visiblePapers.map((paper) => (
            <li key={paper.id} className="py-2">
              <p>
                {paper.title || paper.externalId}
                {paper.year && " · " + paper.year}
              </p>
              {paper.debateIds.map((id) => (
                <Link
                  key={id}
                  className="mr-3 block text-sm underline"
                  to={debateEvidencePath(id)}
                >
                  Manage evidence · {byId.get(id)?.claim ?? id}
                </Link>
              ))}
            </li>
          ))}
        </ul>
      </section>
      {!project.archivedAt && (
        <Button
          variant="outline"
          disabled={archive.isPending || add.isPending}
          onClick={() => {
            if (
              window.confirm(
                "Archive this project? Its claims, papers, and results will remain available.",
              )
            )
              archive.mutate();
          }}
        >
          Archive project
        </Button>
      )}
      {archive.isError && <p role="alert">Could not archive this project.</p>}
    </article>
  );
}

export default function WorkspaceRoute() {
  const [params, setParams] = useSearchParams();
  const selectedProject = params.get("project") ?? "";
  const creating = params.get("new") === "1";
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const projects = useActionQuery(
    "list-research-projects",
    { query, scope: archived ? "archived" : "active" },
    { retry: false },
  );
  const qc = useQueryClient();
  const refreshProjects = () =>
    qc.invalidateQueries({ queryKey: ["action", "list-research-projects"] });
  useEffect(() => {
    if (!creating && !selectedProject && projects.data?.projects[0])
      setParams({ project: projects.data.projects[0].id }, { replace: true });
  }, [creating, selectedProject, projects.data, setParams]);
  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-5 px-4 py-8">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-3xl font-semibold">Research workspace</h1>
          <Button asChild>
            <Link to="?new=1">New project</Link>
          </Button>
        </header>

        {creating && (
          <CreateProject
            onCreated={(id) => {
              setArchived(false);
              setQuery("");
              setParams({ project: id });
              void refreshProjects();
            }}
          />
        )}
        <section className="space-y-3 rounded-xl border p-5">
          <h2 className="text-lg font-semibold">Projects</h2>
          <div className="flex gap-2">
            <Input
              aria-label="Search projects"
              placeholder="Search titles and descriptions"
              value={query}
              maxLength={200}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              aria-label="Project archive filter"
              className="rounded border bg-background px-2"
              value={archived ? "archived" : "active"}
              onChange={(e) => {
                setArchived(e.target.value === "archived");
                setParams({});
              }}
            >
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </select>
          </div>
          {projects.isPending && <p role="status">Searching projects…</p>}
          {projects.isError && <p role="alert">Could not list projects.</p>}
          {projects.data?.projects.length === 0 && <p>No matching projects.</p>}
          {projects.data?.truncated && (
            <p>Showing the first 50 matches. Refine your search for more.</p>
          )}
          <ul className="divide-y">
            {projects.data?.projects.map((project) => (
              <li className="py-2" key={project.id}>
                <Link
                  aria-current={
                    project.id === selectedProject ? "page" : undefined
                  }
                  className="hover:underline aria-[current=page]:font-semibold"
                  to={"?project=" + encodeURIComponent(project.id)}
                >
                  {project.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
        {!creating && selectedProject && (
          <ProjectDetail
            key={selectedProject}
            projectId={selectedProject}
            onArchived={() => {
              setArchived(true);
              setQuery("");
              void refreshProjects();
            }}
          />
        )}
      </div>
    </main>
  );
}

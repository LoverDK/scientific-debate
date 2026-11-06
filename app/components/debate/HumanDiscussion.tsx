import { callAction, useActionQuery } from "@agent-native/core/client/use-action";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";

import type { DebateRoleOutput } from "../../../server/lib/debate-llm";

const kinds = {
  viewpoint: "Viewpoint", question: "Question", challenge: "Challenge",
  citation_explanation: "Citation explanation request", follow_up: "Follow-up research request",
} as const;
type Kind = keyof typeof kinds;
type Role = "proponent" | "opponent" | "judge";
type Props = { runId: string; messages: {role: Role; output: DebateRoleOutput}[]; papers: {externalId:string; title:string}[]; archived?: boolean };

function SavedContext({ kind, role, citation, messages }: {
  kind: string; role?: string | null; citation?: string | null; messages: Props["messages"];
}) {
  if (kind === "viewpoint") return null;
  const selected = messages.filter(m => !role || m.role === role);
  const excerpts = selected.flatMap(({ output }) => {
    if (kind === "follow_up" && !citation && output.role === "judge") {
      return (output.researchNotes?.nextQuestions ?? output.limitations).map(text => ({ role: output.role, text }));
    }
    return output.arguments.filter(arg => !citation || arg.citedExternalIds.includes(citation))
      .map(arg => ({ role: output.role, text: arg.claim + " - " + arg.support }));
  });
  return <details className="mt-2 text-sm">
    <summary className="cursor-pointer">Read related passages from this run ({excerpts.length})</summary>
    {excerpts.length ? <ul className="list-disc pl-5">{excerpts.map((e, i) =>
      <li key={i}><strong>{e.role}</strong> {e.text}</li>
    )}</ul> : <p>No matching passage was recorded.</p>}
  </details>;
}

export function HumanDiscussion({ runId, messages, papers, archived }: Props) {
  const discussion = useActionQuery("list-run-discussion", { runId }, { retry: false });
  const [kind,setKind] = useState<Kind>("viewpoint");
  const [role,setRole] = useState<Role | "">("");
  const [citation,setCitation] = useState("");
  const [body,setBody] = useState("");
  const save = useMutation({
    mutationFn: () => callAction("add-run-discussion", { runId, kind, role:role || undefined, citedExternalId:citation || undefined, body:body.trim() }),
    onSuccess: async () => { setBody(""); await discussion.refetch(); },
    retry:false,
  });
  return <section className="space-y-4 rounded-xl border bg-card p-5">
    <h3 className="text-lg font-semibold">Human discussion</h3>
    <p className="text-sm text-muted-foreground">Record your response or a request for later investigation alongside this run.</p>
    {discussion.isPending && <p role="status">Loading contributions…</p>}
    {discussion.isError && <p role="alert">Could not read the discussion. <Button variant="link" onClick={()=>void discussion.refetch()}>Refresh</Button></p>}
    {discussion.data && <>
      {!discussion.data.notes.length && <p>No contributions yet.</p>}
      <ol className="space-y-3">{discussion.data.notes.map(note=><li key={note.id} className="border-l-2 pl-3">
        <p className="font-medium">{kinds[note.kind as Kind] ?? "Contribution"}{note.role && " · "+note.role}</p>
        <p className="text-xs text-muted-foreground">You · <time dateTime={note.createdAt}>{new Date(note.createdAt).toLocaleString()}</time></p>
        <p className="whitespace-pre-wrap break-words">{note.body}</p>
        {note.citedExternalId && <p className="text-sm">Paper · {papers.find(p=>p.externalId===note.citedExternalId)?.title} ({note.citedExternalId})</p>}
        <SavedContext messages={messages} kind={note.kind} role={note.role} citation={note.citedExternalId} />
      </li>)}</ol>
      {archived || discussion.data.archived ? <p>This archived discussion is read-only.</p> :
        <form onSubmit={e=>{e.preventDefault(); if(body.trim() && !save.isPending) save.mutate();}}>
        <fieldset disabled={save.isPending} className="grid gap-3">
          <label>Contribution type <select value={kind} onChange={e=>setKind(e.target.value as Kind)}>{Object.entries(kinds).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
          <label>Respond to <select value={role} onChange={e=>setRole(e.target.value as Role | "")}><option value="">Entire run</option>{messages.map(({role:r})=><option key={r} value={r}>{r}</option>)}</select></label>
          <label>Paper from this run <select value={citation} required={kind==="citation_explanation"} onChange={e=>setCitation(e.target.value)}><option value="">Choose a paper{kind!=="citation_explanation" && " (optional)"}</option>
            {papers.map(p=><option key={p.externalId} value={p.externalId}>{p.title} · {p.externalId}</option>)}</select></label>
          <label>Your contribution<textarea required maxLength={4000} rows={3} value={body} onChange={e=>setBody(e.target.value)} className="block w-full rounded border bg-background p-2"/></label>
          <Button className="justify-self-start" type="submit" disabled={!body.trim() || (kind==="citation_explanation" && !citation)}>Save contribution</Button>
        </fieldset></form>}
    </>}
    {save.isSuccess && <p role="status">Contribution saved.</p>}
    {save.isError && <p role="alert">Could not confirm the save. <Button variant="link" onClick={()=>void discussion.refetch()}>Check contributions</Button></p>}
  </section>;
}

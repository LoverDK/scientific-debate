import { useActionQuery } from "@agent-native/core/client/use-action";
import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";

import type { DebateRoleOutput } from "../../../server/lib/debate-llm";
import { requestSavedDiscussionReply, submitDiscussionWithReply } from "../../lib/discussion-submit";

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
  const submitting = useRef(false);
  const [noteSaved, setNoteSaved] = useState(false);
  const save = useMutation({
    mutationFn: () => submitDiscussionWithReply({ runId, kind, role:role || undefined, citedExternalId:citation || undefined, body:body.trim() }, () => {
      setBody(""); setNoteSaved(true);
    }),
    onSettled: async () => { submitting.current = false; await discussion.refetch(); },
    retry:false,
  });
  const respond = useMutation({
    mutationFn: (contributionId: string) => requestSavedDiscussionReply(runId, contributionId),
    onSettled: async () => { await discussion.refetch(); }, retry: false,
  });
  return <section className="space-y-4 rounded-xl border bg-card p-5">
    <h3 className="text-lg font-semibold">Human discussion</h3>
    <p className="text-sm text-muted-foreground">Ask a question or challenge an argument. Saving automatically requests one AI reply using this run's saved evidence and arguments. Uses the project's fixed free model; no new search or debate run.</p>
    {discussion.isPending && <p role="status">Loading contributions…</p>}
    {discussion.isError && <p role="alert">Could not read the discussion. <Button variant="link" onClick={()=>void discussion.refetch()}>Refresh</Button></p>}
    {discussion.data && <>
      {!discussion.data.notes.length && <p>No contributions yet.</p>}
      <ol className="space-y-3">{discussion.data.notes.map(note=><li key={note.id} className="border-l-2 pl-3">
        {note.aiReply ? <div className="space-y-2 rounded-lg bg-muted/50 p-3">
          <p className="font-medium">AI reply · {note.aiReply.status}</p>
          <p className="text-xs text-muted-foreground">{note.aiReply.modelId} · Reply to: {discussion.data.notes.find(n => n.id === note.aiReply?.parentId)?.body.slice(0, 160) ?? "saved contribution"}</p>
          {note.aiReply.status === "completed" && <>
            <p className="whitespace-pre-wrap break-words">{note.aiReply.answer}</p>
            <ul className="text-sm">{note.aiReply.citedExternalIds.map(id => <li key={id}><a className="underline" href={`https://openalex.org/${encodeURIComponent(id)}`} target="_blank" rel="noopener noreferrer">{papers.find(p => p.externalId === id)?.title ?? id} · {id}</a></li>)}</ul>
            <p className="text-xs text-muted-foreground">AI interpretation of the saved metadata/abstracts; the original verdict is unchanged.</p>
          </>}
          {note.aiReply.status === "failed" && <p role="alert">{note.aiReply.error}</p>}
          {note.aiReply.status === "pending" && <p role="status">Reply not yet confirmed. Refresh discussion to check; do not submit the same question again.</p>}
        </div> : <>
        <p className="font-medium">{kinds[note.kind as Kind] ?? "Contribution"}{note.role && " · "+note.role}</p>
        <p className="text-xs text-muted-foreground">You · <time dateTime={note.createdAt}>{new Date(note.createdAt).toLocaleString()}</time></p>
        <p className="whitespace-pre-wrap break-words">{note.body}</p>
        {note.citedExternalId && <p className="text-sm">Paper · {papers.find(p=>p.externalId===note.citedExternalId)?.title} ({note.citedExternalId})</p>}
        <SavedContext messages={messages} kind={note.kind} role={note.role} citation={note.citedExternalId} />
        {!discussion.data.archived && !archived && !discussion.data.notes.some(n => n.aiReply?.parentId === note.id) &&
          <Button variant="outline" className="mt-2" disabled={respond.isPending || save.isPending} onClick={() => respond.mutate(note.id)}>Get AI reply</Button>}
        </>}
      </li>)}</ol>
      {archived || discussion.data.archived ? <p>This archived discussion is read-only.</p> :
        <form onSubmit={e=>{e.preventDefault(); if(body.trim() && !submitting.current) { submitting.current = true; setNoteSaved(false); save.mutate(); }}}>
        <fieldset disabled={save.isPending || respond.isPending} className="grid gap-3">
          <label>Contribution type <select value={kind} onChange={e=>setKind(e.target.value as Kind)}>{Object.entries(kinds).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
          <label>Respond to <select value={role} onChange={e=>setRole(e.target.value as Role | "")}><option value="">Entire run</option>{messages.map(({role:r})=><option key={r} value={r}>{r}</option>)}</select></label>
          <label>Paper from this run <select value={citation} required={kind==="citation_explanation"} onChange={e=>setCitation(e.target.value)}><option value="">Choose a paper{kind!=="citation_explanation" && " (optional)"}</option>
            {papers.map(p=><option key={p.externalId} value={p.externalId}>{p.title} · {p.externalId}</option>)}</select></label>
          <label>Your contribution<textarea required maxLength={4000} rows={3} value={body} onChange={e=>setBody(e.target.value)} className="block w-full rounded border bg-background p-2"/></label>
          <Button className="justify-self-start" type="submit" disabled={!body.trim() || (kind==="citation_explanation" && !citation)}>{save.isPending ? "Waiting for AI reply…" : "Save & get AI reply"}</Button>
        </fieldset></form>}
    </>}
    {save.isPending && <p role="status">{noteSaved ? "Contribution saved. AI is reading this run's snapshot…" : "Saving contribution…"}</p>}
    {save.isSuccess && <p role="status">{save.data.status === "completed" ? "Contribution and AI reply saved." : save.data.error ?? "Contribution saved. AI reply is still pending. Refresh discussion to check."}</p>}
    {respond.isPending && <p role="status">AI is reading the saved contribution and evidence…</p>}
    {respond.isSuccess && <p role="status">{respond.data.status === "completed" ? "AI reply saved." : respond.data.error ?? "AI reply is still pending. Refresh discussion to check."}</p>}
    {save.isError && <p role="alert">Could not confirm the save. <Button variant="link" onClick={()=>void discussion.refetch()}>Check contributions</Button></p>}
    <Button variant="outline" onClick={() => void discussion.refetch()}>Refresh discussion</Button>
  </section>;
}

import { callAction, useActionQuery } from "@agent-native/core/client/use-action";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useOutletContext } from "react-router";

import { Button } from "@/components/ui/button";
import { DebateStepNav } from "../components/debate/DebateStepNav";
import { debateArenaPath } from "../lib/debate-paths";
import { compareEvidence, elapsed } from "../lib/debate-compare";
import type { DebateOutletContext } from "./debates.$debateId";
import type getRun from "../../actions/get-debate-run";

type Run = Awaited<ReturnType<typeof getRun.run>>;
const roles = ["proponent", "opponent", "judge"] as const;
const labels = { proponent: "正方", opponent: "反方", judge: "裁判" };
const verdicts = { supports: "支持", opposes: "反对", insufficient_evidence: "证据不足" };
export function meta() { return [{ title: "运行对比 · Scientific Debate" }]; }

function RunColumn({ run, label }: { run: Run; label: string }) {
  const seconds = elapsed(run.startedAt, run.finishedAt);
  const costs = run.messages.map(m => m.usage?.costUsd);
  const knownTotal = run.status === "completed" && costs.length === 3 && costs.every(c => typeof c === "number")
    ? costs.reduce((a, b) => a + b, 0) : null;
  return <section className="min-w-0 space-y-4 rounded-xl border bg-card p-4">
    <h3 className="text-lg font-semibold">{label}</h3>
    <p className="break-words">{run.evidencePack.claim}</p>
    <p className="text-sm">{run.modelId} · {run.status} · {seconds === null ? "暂无完整耗时" : seconds + " 秒"}</p>
    <p className="text-sm">费用：{knownTotal === null ? "未记录完整费用" : "$" + knownTotal}</p>
    {run.errorSummary && <p>{run.errorSummary}</p>}
    {roles.map(role => {
      const message = run.messages.find(m => m.role === role);
      const output = message?.output;
      return <article key={role} className="space-y-2 border-t pt-3">
        <h4 className="font-semibold">{labels[role]}</h4>
        {!output ? <p>暂无已保存的发言。</p> : <>
          {message?.usage && <p className="text-xs">输入 / 输出 tokens：{message.usage.inputTokens ?? "未知"} / {message.usage.outputTokens ?? "未知"} · USD {message.usage.costUsd ?? "未知"}</p>}
          <p>{output.summary}</p>
          <ol className="ml-5 list-decimal space-y-2">{output.arguments.map((arg, index) =>
            <li key={index}><strong>{arg.claim}</strong><p>{arg.support}</p>
              <p className="text-sm">引用：{arg.citedExternalIds.join("、") || "无"}</p></li>)}</ol>
          {output.role === "judge" && <>
            <p>{verdicts[output.verdict]} · 模型置信度 {Math.round(output.confidence * 100)}%</p>
            {output.limitations.map((text, index) => <p key={index}>局限：{text}</p>)}
          </>}
        </>}
      </article>;
    })}
    <details><summary>论文快照（{run.evidencePack.papers.length}）</summary>
      {run.evidencePack.papers.map(p => <div className="mt-2 text-sm" key={p.externalId}>
        <strong>{p.title}</strong><p>{p.externalId} · {p.authors.join(", ")} {p.year}</p>
        <p>{p.abstract || "无摘要"}{p.abstractTruncated && "（已截断）"}</p>
        {p.stance && <p>立场：{p.stance}</p>}
      </div>)}</details>
  </section>;
}

function Comparison({ debateId }: { debateId: string }) {
  const history = useInfiniteQuery({
    queryKey: ["compare-run-history", debateId], initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => callAction("list-debate-runs", { debateId, ...(pageParam ? { cursor: pageParam } : {}) }, {method: "GET"}),
    getNextPageParam: last => last.nextCursor ?? undefined, retry: false,
  });
  const runs = history.data?.pages.flatMap(page => page.runs) ?? [];
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const leftId = left || runs[0]?.id || "";
  const rightId = right || runs.find(r => r.id !== leftId)?.id || "";
  const a = useActionQuery("get-debate-run", {runId:leftId}, {enabled:!!leftId, retry:false});
  const b = useActionQuery("get-debate-run", {runId:rightId}, {enabled:!!rightId, retry:false});
  const runA = a.data?.debateId === debateId ? a.data : undefined;
  const runB = b.data?.debateId === debateId ? b.data : undefined;
  const diff = runA && runB ? compareEvidence(runA.evidencePack, runB.evidencePack) : null;
  const citedBy = (run: Run) => new Set(run.messages.flatMap(message => message.output.citedExternalIds));
  const citationsA = runA && citedBy(runA);
  const citationsB = runB && citedBy(runB);
  return <div className="space-y-4">
    <DebateStepNav debateId={debateId} active="debate" />
    <div className="flex justify-between"><h2 className="text-xl font-semibold">对比两次运行</h2>
      <Button asChild variant="outline"><Link to={debateArenaPath(debateId)}>返回辩论</Link></Button></div>
    {history.isPending && <p role="status">正在读取历史…</p>}
    {history.isError && <p role="alert">历史读取失败。 <Button variant="outline" onClick={() => history.isFetchNextPageError ? history.fetchNextPage() : history.refetch()}>重新读取</Button></p>}
    {history.isSuccess && runs.length < 2 && <p>需要至少两次已保存的运行才能对比。</p>}
    <div className="grid gap-4 sm:grid-cols-2">{[
      {label:"运行 A", id:leftId, other:rightId, select:setLeft},
      {label:"运行 B", id:rightId, other:leftId, select:setRight},
    ].map(side => <label key={side.label}>{side.label}
      <select disabled={runs.length < 2} className="block w-full rounded border bg-background p-2" value={side.id} onChange={e => {
        const id = e.target.value;
        if (id === side.other) (side.select === setLeft ? setRight : setLeft)(side.id);
        side.select(id);
      }}>
        {!side.id && <option value="">暂无记录</option>}
        {runs.map(run => <option key={run.id} value={run.id}>
          {new Date(run.createdAt).toLocaleString()} · {run.modelId} · {run.status} · {run.id.slice(0,8)}
        </option>)}</select></label>)}</div>
    {history.hasNextPage && <Button variant="outline" disabled={history.isFetchingNextPage} onClick={()=>history.fetchNextPage()}>加载更早的运行</Button>}
    {((leftId && a.isPending) || (rightId && b.isPending)) && <p role="status">正在读取运行记录…</p>}
    {(a.isError || b.isError) && <p role="alert">运行详情读取失败。 <Button variant="outline" onClick={()=>{if(a.isError) void a.refetch(); if(b.isError) void b.refetch();}}>重新读取</Button></p>}
    {diff && <section className="rounded border p-3"><h3 className="font-semibold">运行输入差异</h3>
      <p>命题文本{diff.claimChanged ? "有变更" : "相同"}。</p>
      <p>仅 A 包含：{diff.onlyA.join("、") || "无"}。仅 B 包含：{diff.onlyB.join("、") || "无"}。</p>
      <p>同篇论文的快照字段有变更：{diff.changed.join("、") || "无"}。</p>
      {diff.orderChanged && <p>共同论文的输入顺序不同。</p>}
      {(diff.claimChanged || diff.changed.length > 0 || diff.onlyA.length > 0 || diff.onlyB.length > 0 || diff.orderChanged) &&
        <p>两次运行的输入不同，判断差异也可能来自命题或证据的变化。</p>}
      {citationsA && citationsB && <div className="mt-3">
        <h4 className="font-medium">已保存发言的引用差异</h4>
        <p>仅 A 引用：{[...citationsA].filter(id => !citationsB.has(id)).join("、") || "无"}。</p>
        <p>仅 B 引用：{[...citationsB].filter(id => !citationsA.has(id)).join("、") || "无"}。</p>
      </div>}
    </section>}
    <div className="grid items-start gap-4 lg:grid-cols-2">{runA && <RunColumn label="运行 A" run={runA}/>}
      {runB && <RunColumn label="运行 B" run={runB}/>}</div>
  </div>;
}
export default function DebateCompareRoute() {
  const { debateId } = useOutletContext<DebateOutletContext>();
  return <Comparison key={debateId} debateId={debateId}/>;
}

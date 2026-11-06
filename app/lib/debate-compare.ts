import type { EvidencePack } from "../../server/lib/debate-evidence";

export function compareEvidence(a: EvidencePack, b: EvidencePack) {
  const left = new Map(a.papers.map(p => [p.externalId, p]));
  const right = new Map(b.papers.map(p => [p.externalId, p]));
  const onlyA = [...left.keys()].filter(id => !right.has(id));
  const onlyB = [...right.keys()].filter(id => !left.has(id));
  const changed = [...left.values()].filter(paper => {
    const other = right.get(paper.externalId);
    if (!other) return false;
    const keys = new Set([...Object.keys(paper), ...Object.keys(other)] as (keyof typeof paper)[]);
    return [...keys].some(key => JSON.stringify(paper[key]) !== JSON.stringify(other[key]));
  }).map(paper => paper.externalId);
  const orderChanged = [...left.keys()].filter(id => right.has(id)).join("\n")
    !== [...right.keys()].filter(id => left.has(id)).join("\n");
  return { onlyA, onlyB, changed, orderChanged, claimChanged: a.claim !== b.claim };
}

export function elapsed(started: string | null, finished: string | null) {
  if (!started || !finished) return null;
  const ms = Date.parse(finished) - Date.parse(started);
  return Number.isFinite(ms) && ms >= 0 ? ms / 1000 : null;
}

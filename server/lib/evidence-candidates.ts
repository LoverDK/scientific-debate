/**
 * Alternate independently ranked search directions before imposing the budget.
 * Query direction is not a stance label: only the classifier assigns stance.
 * Deduplicate by OpenAlex ID and fill unused capacity from the other direction.
 */
export function selectEvidenceCandidates<T extends { externalId: string }>(
  supporting: readonly T[],
  challenging: readonly T[],
  limit: number,
): T[] {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new RangeError("Candidate limit must be a nonnegative integer.");
  }
  const selected: T[] = [];
  const seen = new Set<string>();
  const queues = [supporting.values(), challenging.values()];
  while (selected.length < limit) {
    let added = false;
    for (const queue of queues) {
      for (let next = queue.next(); !next.done; next = queue.next()) {
        const paper = next.value;
        if (seen.has(paper.externalId)) continue;
        seen.add(paper.externalId);
        selected.push(paper);
        added = true;
        break;
      }
      if (selected.length === limit) break;
    }
    if (!added) break;
  }
  return selected;
}

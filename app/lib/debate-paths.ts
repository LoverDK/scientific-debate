export function debateEvidencePath(debateId: string): string {
  return `/debates/${encodeURIComponent(debateId)}/evidence`;
}

export function debateArenaPath(debateId: string): string {
  return `/debates/${encodeURIComponent(debateId)}/debate`;
}

export function debateConclusionPath(
  debateId: string,
  runId?: string,
): string {
  const base = `/debates/${encodeURIComponent(debateId)}/conclusion`;
  if (!runId) return base;
  return `${base}?runId=${encodeURIComponent(runId)}`;
}

export function debateComparePath(debateId: string): string {
  return `/debates/${encodeURIComponent(debateId)}/compare`;
}

export function debateRootPath(debateId: string): string {
  return `/debates/${encodeURIComponent(debateId)}`;
}

export function workspacePath(): string {
  return "/workspace";
}

/** Activity comes from the current source snapshot, never the marker type. */
export function kalkiStatus(project?: {
  paused: boolean;
  milestone: { status: string } | null;
}): string {
  if (!project) return 'Status unavailable';
  if (project.paused) return 'Paused';
  return project.milestone ? 'Running now' : 'Between steps';
}

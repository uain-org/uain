/** The pilot source is immutable after native authority takes over. Native
 * projections, access logs, rate limits and notification outboxes are separate
 * operational records and retain their own writers. No source repair runs as
 * a side effect of serving a native request or importing a pilot module. */
export function pilotSourceWritable(): boolean {
  const authority = process.env.UAIN_AUTHORITY;
  if (authority && authority !== 'pilot' && authority !== 'native')
    throw new Error('explicit pilot or native authority required');
  return authority !== 'native';
}

export function assertPilotSourceWritable(): void {
  if (!pilotSourceWritable()) throw new Error('native authority: pilot source is frozen');
}

/** Check both registration and execution, so even an already queued callback
 * cannot write if this process switches authority before it runs. */
export function schedulePilotMaintenance(run: () => unknown, interval: number, first?: number): void {
  if (!pilotSourceWritable()) return;
  const guarded = () => { if (pilotSourceWritable()) run(); };
  if (first !== undefined) setTimeout(guarded, first).unref();
  setInterval(guarded, interval).unref();
}

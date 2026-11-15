export type ReadinessProbe = () => boolean | Promise<boolean>;
export interface ReadinessOptions { timeoutMs?: number }

// Share timed-out probes until the underlying query ends, so outage checks
// cannot exhaust the pool by creating a query on every readiness request.
export function createReadiness(probe: ReadinessProbe, { timeoutMs = 1000 }: ReadinessOptions = {}): () => Promise<boolean> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error('Invalid readiness timeout');
  let pending: Promise<boolean> | undefined;
  return async () => {
    pending ??= Promise.resolve().then(probe).then(Boolean, () => false).finally(() => { pending = undefined; });
    const query = pending;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([query, new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
    } finally { clearTimeout(timer); }
  };
}

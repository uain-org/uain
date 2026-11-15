/**
 * Graceful shutdown on SIGTERM and SIGINT.
 *
 * The server runs as the container's first process, and a first process gets
 * no default action for SIGTERM: without a handler it ignored the signal and
 * Kubernetes killed it after the 30 s grace period. Every rollout and
 * scale-down therefore kept old pods Terminating for 30 s and dropped the
 * requests in flight, the open event streams, and the batched writes not yet
 * sent (access log, last seen, rate counts).
 *
 * In order:
 * 1. `/api/ready` answers 503 (`draining`), so no new traffic is routed here.
 * 2. Wait `drainMs` while the endpoint removal reaches every proxy; requests
 *    arriving meanwhile are still answered.
 * 3. Stop accepting, end the event streams, close idle keep-alive connections.
 * 4. Let requests in flight finish, until `deadlineMs` after the signal; past
 *    it the remaining connections are cut.
 * 5. Flush the batches and close the writer thread and the database pools.
 * 6. Exit 0 (1 if a step threw).
 */
import type { Server } from 'node:http';

export const lifecycle = { draining: false };

export interface ShutdownSteps {
  server: Server;
  /** Ends every open event stream. */
  endStreams: () => void;
  /** Sends what is batched and closes the store; awaited before exit. */
  flush: () => Promise<void>;
  drainMs?: number;
  deadlineMs?: number;
  exit?: (code: number) => void;
  say?: (line: string) => void;
}

const envMs = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Returns the shutdown routine; calling it again returns the same run. */
export function createShutdown({
  server,
  endStreams,
  flush,
  drainMs = envMs('UAIN_SHUTDOWN_DRAIN_MS', 5_000),
  deadlineMs = envMs('UAIN_SHUTDOWN_DEADLINE_MS', 20_000),
  exit = (code) => process.exit(code),
  say = (line) => console.log(line),
}: ShutdownSteps): (signal?: string) => Promise<void> {
  let running: Promise<void> | null = null;
  const run = async (signal: string) => {
    const started = Date.now();
    lifecycle.draining = true;
    say(`shutdown: ${signal}; not ready, draining for ${drainMs} ms`);
    if (drainMs > 0) await new Promise((r) => setTimeout(r, drainMs));
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    endStreams();
    // A kept-alive connection becomes idle once its request is answered; it
    // must then be closed too, or close() waits for the proxy to drop it.
    server.closeIdleConnections();
    const idle = setInterval(() => server.closeIdleConnections(), 100);
    const left = Math.max(0, deadlineMs - (Date.now() - started));
    let cut = false;
    const timer = setTimeout(() => {
      cut = true;
      server.closeAllConnections();
    }, left);
    await closed;
    clearTimeout(timer);
    clearInterval(idle);
    say(`shutdown: requests ${cut ? 'cut at the deadline' : 'finished'} after ${Date.now() - started} ms; flushing`);
    let code = 0;
    try {
      await flush();
    } catch (e) {
      code = 1;
      console.error('shutdown: flush failed:', (e as Error)?.message ?? e);
    }
    say(`shutdown: done after ${Date.now() - started} ms`);
    exit(code);
  };
  return (signal = 'SIGTERM') => (running ??= run(signal));
}

/** Runs `shutdown` on the first SIGTERM or SIGINT. */
export function onSignals(shutdown: (signal: string) => Promise<void>) {
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => void shutdown(signal));
}

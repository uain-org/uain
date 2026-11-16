/** Runs registered writes on the dedicated thread using the same transactions. */
import { parentPort } from 'node:worker_threads';
import { writes, flushLog, flushSeen } from '../application/db.ts';
import { syncCounts } from '../storage/ratelimit.ts';
import { close, pool, writeQueue } from '../storage/store.ts';
// Writes kept in modules of their own register themselves when loaded.
import '../application/kpi.ts';
import { CLOSE_WRITER, type WriteRequest, type WriteReply } from './writer.ts';

if (!parentPort) throw new Error('writer-thread must run inside a worker');
const port = parentPort;
let inFlight = 0;
let drained: (() => void) | null = null;
port.on('message', async ({ id, name, args }: WriteRequest) => {
  if (name === CLOSE_WRITER) {
    // Shutdown (operations/shutdown.ts): finish the writes already taken,
    // send what this thread batched, close its pool, then answer.
    if (inFlight) await new Promise<void>((resolve) => (drained = resolve));
    try {
      await Promise.all([flushLog(), flushSeen(), syncCounts()]);
      await close();
      port.postMessage({ id, result: true });
    } catch (e) {
      port.postMessage({ id, error: { message: e?.message ?? String(e) } });
    }
    return;
  }
  inFlight += 1;
  try {
    await answer(id, name, args);
  } finally {
    inFlight -= 1;
    if (!inFlight && drained) {
      drained();
      drained = null;
    }
  }
});

async function answer(id: number, name: string, args: unknown[]) {
  const reply = (m: Omit<WriteReply, 'id'>) => {
    try {
      port.postMessage({ id, ...m });
    } catch (e) {
      // The write has committed; only its reply could not be copied.
      port.postMessage({ id, error: { message: `writer: reply to ${name}: ${e.message}` } });
    }
  };
  const run = writes.get(name);
  if (!run) return reply({ error: { message: `writer: no write named ${name}` } });
  try {
    reply({ result: await run(...args) });
  } catch (e) {
    reply({ error: { message: e?.message ?? String(e), stack: e?.stack } });
  }
}
port.postMessage({ ready: true });

// The pool and queue live on this thread; the metrics are served from the
// main one (operations/metrics.ts), so they are reported to it.
const STATS_MS = 5_000;
setInterval(() => {
  const { totalCount, idleCount, waitingCount } = pool;
  port.postMessage({ stats: { pool: { totalCount, idleCount, waitingCount }, queue: { ...writeQueue } } });
}, STATS_MS).unref();

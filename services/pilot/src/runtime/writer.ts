/**
 * Writes on a thread of their own.
 *
 * Every write holds the one write lock (storage/store.ts) from its first query
 * to COMMIT, and between queries it waits for this process to read the answer.
 * Under load, serving reads on that event loop delays the whole network's
 * writes. The server therefore hands writes to a worker thread, using the same
 * function, transaction and advisory lock; only arguments and replies cross
 * between threads as structured-clone copies.
 *
 * Scripts that import application/db.ts without starting the thread still
 * write locally. Writes inside a transaction join that transaction locally.
 */
import { isMainThread, Worker } from 'node:worker_threads';
import { pilotSourceWritable } from '../operations/background-policy.ts';

export interface WriteRequest { id: number; name: string; args: unknown[] }
/** The request that closes the thread: not a write any module can register. */
export const CLOSE_WRITER = '\u0000close';
/** What the thread reports every few seconds, for the metrics. */
export interface WriterStats {
  pool: { totalCount: number; idleCount: number; waitingCount: number };
  queue: { waiting: number; running: number; started: number; waitMs: number; held: number; holdMs: number };
}
export interface WriteReply {
  id: number;
  result?: unknown;
  error?: { message: string; stack?: string };
}

// Connections for writes in flight. Writes in different projects run at the
// same time (storage/store.ts), each holding one until it commits; a few more
// cover the reply each reads back after. UAIN_WRITER_POOL changes it; mind the
// database's max_connections across every copy (pool plus this, per copy).
const WRITER_POOL = process.env.UAIN_WRITER_POOL ?? '12';

let worker: Worker | null = null;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
let nextId = 0;

/** Writes sent to the thread, for tests. */
export const sent = { writes: 0 };

let lastStats: WriterStats | null = null;
/** Writes sent to the thread and not yet answered. */
export const pendingWrites = () => pending.size;
/** The thread's pool and write queue, as last reported; null without a thread. */
export const writerStats = () => (worker ? lastStats : null);

/** Start the thread and wait until it can take writes. */
export function startWriter(): Promise<void> {
  if (!pilotSourceWritable() || !isMainThread || worker) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./writer-thread.js', import.meta.url), {
      env: { ...process.env, UAIN_PG_POOL: WRITER_POOL },
    });
    w.once('message', (m: { ready?: boolean }) => {
      if (!m?.ready) return reject(new Error('writer: unexpected first message'));
      w.on('message', settle);
      worker = w;
      resolve();
    });
    w.on('error', (e) => {
      console.error('writer thread:', e);
      if (!worker) reject(e);
    });
    w.on('exit', (code) => {
      if (worker !== w) return reject(new Error(`writer thread exited (${code}) before it was ready`));
      console.error(`writer thread exited (${code}); writing on the main thread`);
      worker = null;
      for (const p of pending.values())
        p.reject(new Error('writer thread exited before the write answered'));
      pending.clear();
    });
  });
}

export const writerRunning = () => worker !== null;

export function stopWriter(): Promise<number | void> {
  const w = worker;
  worker = null;
  return w ? w.terminate() : Promise.resolve();
}

/**
 * Close the thread at shutdown: it finishes the writes it has, sends what it
 * batched and closes its pool, then stops. Waits at most `timeoutMs` for that.
 */
export async function closeWriter(timeoutMs = 5_000): Promise<void> {
  if (!worker) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sendWrite(CLOSE_WRITER, []),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('writer: close timed out')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await stopWriter();
  }
}

/** Run the registered write on the thread, returning its structured-clone reply. */
export function sendWrite(name: string, args: unknown[]): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!worker) return reject(new Error('writer thread is not running'));
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    sent.writes += 1;
    try {
      worker.postMessage({ id, name, args } satisfies WriteRequest);
    } catch (e) {
      pending.delete(id);
      reject(e);
    }
  });
}

function settle(message: WriteReply | { stats: WriterStats }): void {
  if ('stats' in message) {
    lastStats = message.stats;
    return;
  }
  const { id, result, error } = message;
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (error) p.reject(Object.assign(new Error(error.message), { stack: error.stack }));
  else p.resolve(result);
}

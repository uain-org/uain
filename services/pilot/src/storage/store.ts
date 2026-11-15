/**
 * The connection to PostgreSQL: statements, transactions, and the locks
 * writes take.
 *
 * The store began as SQLite inside one process, where no two writes could ever
 * interleave, and the rules lean on that: a contribution settles when its
 * second check lands, claim and task numbers go up by one, a transfer checks
 * the balance it then spends. Every write therefore runs as one transaction
 * under advisory locks, which hold across processes too:
 *
 * - A write that stays inside one project takes that project's lock, and the
 *   network lock shared. Writes in different projects run at the same time.
 * - Any other write takes the network lock exclusively: nothing else writes
 *   while it runs, exactly as when there was one lock for everything. This is
 *   the default; a write is narrowed to a project only when every table it
 *   touches outside the project is changed in ways that cannot collide
 *   (see docs/store.md, "Writes: a lock per project").
 * - The ledger is one chain for the whole network, so its entries are
 *   appended at the end of each write, under a ledger lock held only for the
 *   append and the COMMIT.
 *
 * Reads take no lock and run in parallel.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { hostname } from 'node:os';
import { isMainThread } from 'node:worker_threads';
import pg from 'pg';
import { SCHEMA } from './schema.ts';
import { readyResearchSchema } from '../research/schema.ts';
import { readyNativeSchema } from '../native/schema.ts';

// bigint and numeric come back as strings by default. Every number the store
// holds fits a JavaScript number, and the code compares them as numbers.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/uain';

const msFrom = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};

/**
 * Bounds, so one stuck query or a full pool cannot hold a request for ever:
 * - a request waits at most UAIN_PG_CONNECT_TIMEOUT_MS (10 s) for a
 *   connection, then fails (503 `database_busy`, api/server.ts);
 * - in the server, a statement runs at most UAIN_PG_STATEMENT_TIMEOUT_MS
 *   (120 s). Scripts run in the same container with the same environment
 *   (backups, maintenance, the ledger verifier) and may run long statements,
 *   so for them it is off unless that variable is set;
 * - a transaction left open and idle is ended after
 *   UAIN_PG_IDLE_TX_TIMEOUT_MS (60 s), releasing the locks it held.
 * 0 switches one off. `application_name` names the copy and the thread in
 * pg_stat_activity.
 */
const thread = isMainThread ? 'main' : 'writer';
/** Whether this process is the server (api/server.js), not a script. */
const serving = /api[\\/]server\.[jt]s$/.test(process.argv[1] ?? '');
export const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.UAIN_PG_POOL ?? 20),
  connectionTimeoutMillis: msFrom('UAIN_PG_CONNECT_TIMEOUT_MS', 10_000),
  statement_timeout: msFrom('UAIN_PG_STATEMENT_TIMEOUT_MS', serving ? 120_000 : 0),
  idle_in_transaction_session_timeout: msFrom('UAIN_PG_IDLE_TX_TIMEOUT_MS', 60_000),
  application_name: `uain-pilot ${hostname()} ${thread}`.slice(0, 63),
});
// An idle client that loses its connection must not take the process down.
pool.on('error', (e) => console.error('postgres pool:', e.message));

/** Counts every query sent, for the query budget test and scripts. */
export const counter = { queries: 0 };

/** Where a write may reach: the whole network, one project, or only the ledger. */
export type Scope = 'network' | 'ledger' | { project: string };

/** A ledger entry waiting for the end of its write. See record() in db.ts. */
export interface PendingEntry {
  kind: string;
  actor: string | null;
  summary: string;
  peer: string | null;
  /** Hash version 2's content commitment (ledger/chain.ts), made by record(). */
  salt: string;
  commits: string | null;
  digest: string;
  /** A row to point at the entry: filled in by append_ledger. */
  link?: { table: 'tasks' | 'claim_revisions' | 'claim_reviews' | 'karma_events' | 'test_attempts'; id: string | number };
  /** Runs once the entry has its id, still inside the write (the slow path). */
  then?: (id: number) => unknown;
}

interface TransactionContext {
  client: pg.PoolClient;
  queries: number;
  dbMs: number;
  scope: Scope;
  entries: PendingEntry[];
  /** Projects whose version the write moves: its own, or every one. */
  changes: Set<string> | 'all';
  /** Whether it sent anything but a SELECT: a write refused, or with nothing to do, moves no version. */
  wrote: boolean;
}

const changesOf = (scope: Scope): Set<string> | 'all' =>
  scope === 'network' ? 'all' : scope === 'ledger' ? new Set() : new Set([scope.project]);

/**
 * A whole-network write that changes the rows of only one project, among
 * those servers keep in memory (docs/store.md): its other changes are to
 * members, karma and credits, which are always read fresh. Moves only that
 * project's version, not every one.
 */
export function changesOnlyProject(projectId: string) {
  const tx = inTransaction.getStore();
  if (tx && tx.changes === 'all') tx.changes = new Set([projectId]);
}
const inTransaction = new AsyncLocalStorage<TransactionContext>();

/** The transaction's connection inside one, the pool anywhere else. */
const connection = () => inTransaction.getStore()?.client ?? pool;

/** `?` placeholders, as the statements were written for SQLite, to `$n`. */
function numbered(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

const READ_ONLY = /^\s*select\b/i;

/** Inside a write, adds the query's round trip to the time spent on the database. */
async function timed<T>(tx: TransactionContext | null | undefined, sending: Promise<T>, sql = 'SELECT'): Promise<T> {
  if (!tx) return sending;
  if (!READ_ONLY.test(sql)) tx.wrote = true;
  tx.queries += 1;
  const start = performance.now();
  try {
    return await sending;
  } finally {
    tx.dbMs += performance.now() - start;
  }
}

export async function query<Row extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<pg.QueryResult<Row>> {
  counter.queries += 1;
  const tx = inTransaction.getStore();
  return timed(tx, connection().query<Row>(numbered(sql), params), sql);
}

/**
 * A statement in the shape db.mjs used under SQLite, now asynchronous.
 * `run` reports `changes`, and the new row's id as `lastInsertRowid` when the
 * statement ends in RETURNING id. `pooled` sends it outside any transaction.
 */
export function prepare<Row extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, { pooled = false }: { pooled?: boolean } = {}) {
  const text = numbered(sql);
  const send = (params: unknown[]): Promise<pg.QueryResult<Row>> => {
    counter.queries += 1;
    const tx = pooled ? null : inTransaction.getStore();
    return timed(tx, (pooled ? pool : connection()).query<Row>(text, params), text);
  };
  return {
    sql: text,
    get: async (...params: unknown[]) => (await send(params)).rows[0],
    all: async (...params: unknown[]) => (await send(params)).rows,
    run: async (...params: unknown[]) => {
      const r = await send(params);
      return { changes: r.rowCount, lastInsertRowid: r.rows[0]?.id };
    },
  };
}

/* ------------------------------------------------------------------ writes */

// Any fixed numbers. The network lock keeps the number the one write lock
// had, so a server still on the old code and one on the new exclude each other
// during a rolling deploy. Project locks are the two-key form, keyed by the
// hash of the project id: two projects sharing a hash only wait for each other.
const WRITE_LOCK = 4_202_609;
const PROJECT_LOCKS = 4_202_611;
const LEDGER_LOCK = 4_202_612;

const keyOf = (scope: Scope) =>
  typeof scope === 'string' ? scope : `project:${scope.project}`;

/**
 * Writes queue in this process by what they lock, so at most one connection
 * per lock waits on it, and reads never starve for connections.
 */
const queues = new Map<string, Promise<unknown>>();
/**
 * The write queue, for the metrics (operations/metrics.ts): writes waiting
 * for their turn and running now, and since start how many began and how
 * long they waited for their turn and then held their locks, in total.
 */
export const writeQueue = { waiting: 0, running: 0, started: 0, waitMs: 0, held: 0, holdMs: 0 };
function inQueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const queued = performance.now();
  writeQueue.waiting += 1;
  const turn = async () => {
    writeQueue.waiting -= 1;
    writeQueue.running += 1;
    writeQueue.started += 1;
    writeQueue.waitMs += performance.now() - queued;
    try {
      return await task();
    } finally {
      writeQueue.running -= 1;
    }
  };
  const run = (queues.get(key) ?? Promise.resolve()).then(turn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

async function takeLocks(client: pg.PoolClient, scope: Scope) {
  if (scope === 'ledger') return;
  if (scope === 'network') {
    await client.query('SELECT pg_advisory_xact_lock($1)', [WRITE_LOCK]);
    return;
  }
  // The shared network lock first, so a whole-network write waiting for it
  // holds back new project writes and is never starved.
  await client.query(
    'SELECT pg_advisory_xact_lock($2, hashtext($3)) FROM (SELECT pg_advisory_xact_lock_shared($1)) AS network',
    [WRITE_LOCK, PROJECT_LOCKS, scope.project],
  );
}

/**
 * A write already open reaching further. Within a whole-network write
 * anything goes. A project write may take another project's lock too, which
 * can deadlock against a write taking the two the other way round; PostgreSQL
 * then aborts one, and it runs again from the start. It may never widen to the
 * whole network: holding the network lock shared, it would wait on itself.
 */
async function widen(tx: TransactionContext, scope: Scope) {
  if (tx.scope === 'network' || scope === 'ledger') return;
  if (scope === 'network')
    throw new Error('a write inside one project cannot reach the whole network; mark the outer write network-wide');
  if (tx.changes !== 'all') tx.changes.add(scope.project);
  if (tx.scope === 'ledger') {
    await takeLocks(tx.client, scope);
    tx.scope = scope;
    return;
  }
  if (tx.scope.project === scope.project) return;
  await tx.client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [PROJECT_LOCKS, scope.project]);
}

const DEADLOCK = '40P01';

/**
 * Run `fn` as one transaction, holding the locks `scope` needs (the whole
 * network unless named). Nested calls join the transaction already open,
 * taking any further project lock a scope they name needs. A transaction PostgreSQL aborts for a deadlock wrote nothing, so it is
 * run again.
 *
 * Ledger entries written inside are announced only after COMMIT, and not at
 * all on ROLLBACK: a follower must never hear of an entry the table does not
 * hold. PostgreSQL delivers NOTIFY on commit, to every process listening.
 */
const LATER = Symbol('later');

/**
 * A write's reply, built after it commits instead of while it holds the lock.
 * Reading a task or a contribution back in full is a handful of queries, and
 * every one of them made the next write wait. The reply reads what the write
 * committed, as it did before.
 */
export const later = <T>(build: () => T | Promise<T>) => ({ [LATER]: build });

export function atomically<T>(
  fn: () => T | Promise<T>,
  label = 'write',
  scope?: Scope,
): T | Promise<T> {
  const open = inTransaction.getStore();
  // A block with no scope of its own inside a write is part of that write.
  if (open) return scope ? widen(open, scope).then(fn) : fn();
  scope ??= 'network';
  const once = async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await takeLocks(client, scope);
      counter.queries += 2;
      const held: TransactionContext = { client, queries: 0, dbMs: 0, scope, entries: [], changes: changesOf(scope), wrote: false };
      const start = performance.now();
      const result = await inTransaction.run(held, async () => {
        const r = await fn();
        await appendAndCommit(held);
        return r;
      });
      noteHold(label, performance.now() - start, held.queries, held.dbMs);
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  };
  const run = inQueue(keyOf(scope), async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await once();
      } catch (e) {
        if ((e as {code?: string})?.code !== DEADLOCK || attempt >= 3) throw e;
      }
    }
  });
  // The locks are released by now; the next write need not wait for the reply.
  return run.then((result) => {
    const deferred = result as { [LATER]?: () => T | Promise<T> } | null;
    return deferred?.[LATER] ? deferred[LATER]() : result;
  });
}

/** The open write's context, for record() in db.ts. */
export const openWrite = () => inTransaction.getStore() ?? null;

/**
 * Append the write's ledger entries and COMMIT. The ledger is one chain, each
 * entry hashing the one before, so append_ledger (schema.ts) takes the ledger
 * lock and holds it to the COMMIT. Nothing may make it wait on this process
 * meanwhile: every write in the network queues for that lock. So the entries
 * go over first, as a parameter (never inside the statement's text), and the
 * append and the COMMIT then leave as one message. An entry whose write needs
 * its id back (`then`) is appended before, one round trip earlier.
 */
const toWire = ({ kind, actor, summary, peer, salt, commits, digest, link }: PendingEntry) =>
  ({ kind, actor, summary, peer, salt, commits, digest, ...(link ? { link } : {}) });

async function appendAndCommit(tx: TransactionContext) {
  while (tx.entries.some((e) => e.then)) {
    const entries = tx.entries;
    tx.entries = [];
    const { rows: [row] } = await query('SELECT append_ledger(?::jsonb) AS ids', [JSON.stringify(entries.map(toWire))]);
    // A `then` may record more; the loop appends those after these.
    for (const [i, e] of entries.entries()) await e.then?.(Number(row.ids[i]));
  }
  // The versions move before the append, outside the ledger lock but in the
  // same message and transaction as everything the write changed.
  const changed = !tx.wrote ? [] : tx.changes === 'all' ? ['*'] : [...tx.changes];
  const last = [
    changed.length ? "SELECT bump_versions(current_setting('uain.changed')::jsonb)" : null,
    tx.entries.length ? "SELECT append_ledger(current_setting('uain.entries')::jsonb)" : null,
    'COMMIT',
  ].filter(Boolean);
  if (last.length > 1)
    await query("SELECT set_config('uain.entries', ?, true), set_config('uain.changed', ?, true)", [
      JSON.stringify(tx.entries.map(toWire)),
      JSON.stringify(changed),
    ]);
  tx.entries = [];
  await timed(tx, tx.client.query(last.join('; ')));
  counter.queries += 1;
}

export const inWrite = () => Boolean(inTransaction.getStore());

/**
 * How long each kind of write holds the lock, how many queries it sends
 * while it does, and how much of the hold was spent waiting on those queries
 * (`db_ms`); the rest is this process computing, or waiting for its turn on
 * the event loop. Every write waits for the one before it, so this is what
 * sets how many writes a second the network can take. With
 * UAIN_LOCK_STATS=1 the process logs it once a minute.
 */
const holds = new Map<string, {count:number;ms:number;queries:number;dbMs:number;max:number}>();
function noteHold(label: string, ms: number, queries: number, dbMs: number) {
  writeQueue.held += 1;
  writeQueue.holdMs += ms;
  const h = holds.get(label) ?? { count: 0, ms: 0, queries: 0, dbMs: 0, max: 0 };
  h.count += 1;
  h.ms += ms;
  h.queries += queries;
  h.dbMs += dbMs;
  h.max = Math.max(h.max, ms);
  holds.set(label, h);
}

export function lockStats() {
  return [...holds]
    .map(([label, h]) => ({
      label,
      count: h.count,
      mean_ms: +(h.ms / h.count).toFixed(2),
      db_ms: +(h.dbMs / h.count).toFixed(2),
      max_ms: +h.max.toFixed(1),
      queries: +(h.queries / h.count).toFixed(1),
      total_ms: Math.round(h.ms),
    }))
    .sort((a, b) => b.total_ms - a.total_ms);
}

// A write waiting for its turn on the event loop keeps the lock the whole
// time, so the lock statistics come with how late the loop was running.
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
if (process.env.UAIN_LOCK_STATS === '1') {
  loopDelay.enable();
  setInterval(() => {
    const ms = (ns: number) => +(ns / 1e6).toFixed(1);
    const loop = { mean_ms: ms(loopDelay.mean), p99_ms: ms(loopDelay.percentile(99)) };
    if (holds.size) console.log(`lock holds: ${JSON.stringify(lockStats())} loop: ${JSON.stringify(loop)}`);
    holds.clear();
    loopDelay.reset();
  }, 60_000).unref();
}

/* ---------------------------------------------------------------- the ledger */

/**
 * Every committed ledger entry, in this process, whichever process wrote it.
 * record() in db.mjs sends NOTIFY with the entry's id inside its transaction;
 * this listens on its own connection and emits the row once it can be read.
 */
export const committed = new EventEmitter();
committed.setMaxListeners(0);

const CHANNEL = 'uain_ledger';
let listener: pg.Client | null = null;

async function listen() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  client.on('notification', (n) => {
    if (n.channel === CHANNEL) committed.emit('id', Number(n.payload));
  });
  client.on('error', (e) => {
    console.error('postgres listener:', e.message);
    listener = null;
    setTimeout(() => listen().catch(() => {}), 1000).unref();
  });
  await client.connect();
  await client.query(`LISTEN ${CHANNEL}`);
  listener = client;
}

export const notifyEntry = (id: number) =>
  query(`SELECT pg_notify('${CHANNEL}', ?)`, [String(id)]);

/* ---------------------------------------------------------------- lifecycle */

const SCHEMA_HASH = createHash('sha256').update(SCHEMA).digest('hex');
const LOCK_TIMEOUT = '55P03';

/**
 * True when this version of the schema is already in place. The funding index
 * is built only once no two live filings share a transfer (schema.ts), so
 * while it is missing every start tries again, as before.
 */
async function schemaApplied(client: pg.PoolClient) {
  const found = await client.query(
    "SELECT to_regclass('schema_applied') IS NOT NULL AND to_regclass('contributions_funding_transfer') IS NOT NULL AS found",
  );
  if (!found.rows[0]?.found) return false;
  const { rowCount } = await client.query('SELECT 1 FROM schema_applied WHERE hash = $1', [SCHEMA_HASH]);
  return rowCount === 1;
}

/**
 * Create what is missing, once per version of the schema. Running it on every
 * start is not harmless: `ADD COLUMN IF NOT EXISTS` locks its whole table
 * even when the column is already there, so a copy starting under load
 * deadlocked with the requests already running and exited (the k3s
 * rehearsal of 2026-09-30, docs/store.md). So a start that finds this
 * version applied touches no table, and one that applies it waits at most a
 * few seconds for each table before giving up and trying again, instead of
 * holding every request to that table behind it. Two processes starting at
 * once must not race to create the same table, so it holds a lock of its own.
 */
export async function ready() {
  if(process.env.UAIN_AUTHORITY && !['pilot','native'].includes(process.env.UAIN_AUTHORITY))throw Error('explicit pilot or native authority required');
  if(process.env.UAIN_AUTHORITY==='native'&&process.env.UAIN_NATIVE_PROJECTION!=='1')throw Error('native authority requires its native projection');
  const client = await pool.connect();
  try {
    // Building a schema may take long, and so may waiting for another copy
    // building it: no statement limit while it does.
    await client.query('SET statement_timeout = 0');
    if (!(await schemaApplied(client))) await applySchema(client);
    await readyResearchSchema(client);
    await readyNativeSchema(client);
    await client.query('RESET statement_timeout');
  } finally {
    client.release();
  }
  // The writer thread only writes: the ledger stream is the main thread's.
  if (!listener && isMainThread) await listen();
}

async function applySchema(client: pg.PoolClient) {
  await client.query('SELECT pg_advisory_lock($1)', [WRITE_LOCK + 1]);
  try {
    // Another process may have applied it while this one waited.
    if (await schemaApplied(client)) return;
    await client.query("SET lock_timeout = '5s'");
    for (let attempt = 1; ; attempt++) {
      try {
        // One statement list is one transaction: a failed attempt left nothing.
        await client.query(SCHEMA);
        break;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if ((code !== DEADLOCK && code !== LOCK_TIMEOUT) || attempt === 10) throw err;
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt + Math.random() * 500));
      }
    }
    await client.query(
      'INSERT INTO schema_applied (hash, at) VALUES ($1, $2) ON CONFLICT (hash) DO NOTHING',
      [SCHEMA_HASH, new Date().toISOString()],
    );
  } finally {
    await client.query('RESET lock_timeout');
    await client.query('SELECT pg_advisory_unlock($1)', [WRITE_LOCK + 1]);
  }
}

const closeHooks=new Set<()=>Promise<void>>();
export function registerStoreClose(hook:()=>Promise<void>){closeHooks.add(hook)}
export async function close() {
  try{await Promise.allSettled([...closeHooks].map(hook=>Promise.resolve().then(hook)));closeHooks.clear()}
  finally{await listener?.end().catch(() => {});listener=null;await pool.end()}
}

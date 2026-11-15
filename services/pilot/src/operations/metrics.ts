/**
 * Prometheus metrics for one copy of the server. Served on a port of their
 * own (UAIN_METRICS_PORT), never through the public front door: the public
 * nginx forwards only /mcp and /api/, and this port is not published. Each
 * copy reports only itself; Prometheus finds every copy by the service name
 * (ops/monitoring/prometheus/prometheus.yml).
 *
 * Labels stay few and fixed: a route is the method and the first segment
 * under /api, never an id, so the number of series does not grow with use.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'uain_' });

const requests = new client.Histogram({
  name: 'uain_http_request_duration_seconds',
  help: 'Time to answer a request, by route and status class.',
  labelNames: ['route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

const waitlist = new client.Counter({
  name: 'uain_waitlist_registrations_total',
  help: 'New waitlist registrations taken by this copy (repeats not counted).',
  registers: [registry],
});

const slack = new client.Counter({
  name: 'uain_slack_notifications_total',
  help: 'Slack notifications sent, by outcome.',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

const balanceReads = new client.Counter({
  name: 'uain_chain_balance_reads_total',
  help: 'Public wallet balance reads from a JSON-RPC node (cache hits not counted), by chain and outcome.',
  labelNames: ['chain', 'outcome'] as const,
  registers: [registry],
});

interface PoolCounts { totalCount: number; idleCount: number; waitingCount: number }
let watched: PoolCounts | null = null;
new client.Gauge({
  name: 'uain_pg_pool_connections',
  help: 'PostgreSQL pool connections, by state. Waiting is requests queued for one.',
  labelNames: ['state'] as const,
  registers: [registry],
  collect() {
    if (!watched) return;
    this.set({ state: 'total' }, watched.totalCount);
    this.set({ state: 'idle' }, watched.idleCount);
    this.set({ state: 'waiting' }, watched.waitingCount);
  },
});

/*
 * The write path, the network's bottleneck (storage/store.ts). Writes run on
 * the writer thread when it is up and on the main thread otherwise, so each
 * is reported by `thread`. Waiting and running are the queue now; the
 * `_total` series only grow, for rate(): mean wait for a turn is
 * rate(uain_write_wait_seconds_total) / rate(uain_writes_started_total), and
 * mean lock hold likewise over uain_write_holds_total.
 */
type QueueCounts = { waiting: number; running: number; started: number; waitMs: number; held: number; holdMs: number };
type WriterView = { pool: PoolCounts; queue: QueueCounts } | null;
let mainQueue: QueueCounts | null = null;
let writerView: () => WriterView = () => null;
let pendingCalls: () => number = () => 0;
const queues = (): [string, QueueCounts][] => {
  const w = writerView();
  return [
    ...(mainQueue ? [['main', mainQueue] as [string, QueueCounts]] : []),
    ...(w ? [['writer', w.queue] as [string, QueueCounts]] : []),
  ];
};
const queueGauge = (name: string, help: string, read: (q: QueueCounts) => number) =>
  new client.Gauge({
    name,
    help,
    labelNames: ['thread'] as const,
    registers: [registry],
    collect() {
      for (const [thread, q] of queues()) this.set({ thread }, read(q));
    },
  });
queueGauge('uain_write_queue_waiting', 'Writes queued for their turn on a lock, now.', (q) => q.waiting);
queueGauge('uain_write_queue_running', 'Writes holding their connection and locks, now.', (q) => q.running);
queueGauge('uain_writes_started_total', 'Writes that got their turn, since start.', (q) => q.started);
queueGauge('uain_write_wait_seconds_total', 'Time writes waited in the queue for their turn, since start.', (q) => q.waitMs / 1000);
queueGauge('uain_write_holds_total', 'Write transactions that committed, since start.', (q) => q.held);
queueGauge('uain_write_hold_seconds_total', 'Time write transactions held their locks, since start.', (q) => q.holdMs / 1000);
new client.Gauge({
  name: 'uain_writer_pending_calls',
  help: 'Writes sent to the writer thread and not yet answered.',
  registers: [registry],
  collect() {
    this.set(pendingCalls());
  },
});
new client.Gauge({
  name: 'uain_pg_writer_pool_connections',
  help: "The writer thread's PostgreSQL pool, by state, as it last reported (every 5 s).",
  labelNames: ['state'] as const,
  registers: [registry],
  collect() {
    const p = writerView()?.pool;
    if (!p) return;
    this.set({ state: 'total' }, p.totalCount);
    this.set({ state: 'idle' }, p.idleCount);
    this.set({ state: 'waiting' }, p.waitingCount);
  },
});

/** Where the write metrics read from: this thread's queue and the writer thread's report. */
export function watchWrites(sources: { main: QueueCounts; writer: () => WriterView; pending: () => number }) {
  mainQueue = sources.main;
  writerView = sources.writer;
  pendingCalls = sources.pending;
}

/** `GET /api/projects/abc/tasks` -> `GET /api/projects`. */
export function routeOf(method: string | undefined, pathname: string): string {
  if (pathname === '/mcp') return `${method} /mcp`;
  const m = /^\/api\/([a-z_-]+)/.exec(pathname);
  return m ? `${method} /api/${m[1]}` : `${method} other`;
}

/** Times a request from now until its response is finished. */
export function observe(req: IncomingMessage, res: ServerResponse, pathname: string) {
  // The event stream stays open for hours; its duration says nothing.
  if (pathname === '/api/stream') return;
  const end = requests.startTimer({ route: routeOf(req.method, pathname) });
  res.once('finish', () => end({ status: `${Math.floor(res.statusCode / 100)}xx` }));
}

export const countRegistration = () => waitlist.inc();
export const countSlack = (outcome: 'sent' | 'failed') => slack.inc({ outcome });
export const countBalanceRead = (chain: 'ethereum' | 'solana', outcome: 'ok' | 'failed') =>
  balanceReads.inc({ chain, outcome });

/** Starts the metrics listener when UAIN_METRICS_PORT is set. */
export function startMetrics(pool: PoolCounts, port = Number(process.env.UAIN_METRICS_PORT ?? 0)) {
  watched = pool;
  if (!port) return null;
  const server = createServer(async (req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await registry.metrics();
      res.writeHead(200, { 'content-type': registry.contentType }).end(body);
    } catch {
      res.writeHead(500).end();
    }
  });
  server.listen(port, process.env.HOST ?? '0.0.0.0');
  return server;
}

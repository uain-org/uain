// Read-only profile of one browse view inside a pilot pod (10 November 2026).
//
//   node profile-view.mjs /app/dist            the deployed code
//   node profile-view.mjs /tmp/<copy>/dist     a compiled branch
//
// It builds the pages the warm pass builds (six core pages, then four per project) through the
// given code, counting PostgreSQL queries and proof reads. It sends no command and writes nothing
// to the chain; it reads through the pod's own pins, database and native RPC sidecar. Like any
// replica, it lets the event projection catch up first if that is behind. One run costs what one
// view costs a replica (about 170 proof reads at 69 projects), so run it on one pod, not all.
//
// Copy it into a pod's /tmp, run it from /app, and remove it afterwards. For a compiled branch,
// unpack its dist beside a copy of /app/package.json and a link to /app/node_modules. It is not
// part of the image. Results: docs/testing/public-read-speed-2026-11-10.md, section 5.
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const dist = path.resolve(process.argv[2] ?? '/app/dist');
const proofs = [];
const spawn = cp.spawn;
cp.spawn = function (cmd, args, opts) {
  const child = spawn.call(this, cmd, args, opts);
  if (Array.isArray(args) && args.includes('--genesis-sha256')) {
    const entry = { at: Date.now(), keys: null, ms: null, code: null };
    proofs.push(entry);
    const end = child.stdin.end.bind(child.stdin);
    child.stdin.end = (input, ...rest) => {
      try { const s = JSON.parse(String(input)); entry.keys = Array.isArray(s.keys) ? s.keys : []; } catch { /* not a selection */ }
      return end(input, ...rest);
    };
    child.once('close', (code) => { entry.ms = Date.now() - entry.at; entry.code = code; });
  }
  return child;
};
syncBuiltinESMExports();

const pg = (await import(pathToFileURL(path.join(dist, '..', 'node_modules/pg/lib/index.js')).href).catch(() => import('/app/node_modules/pg/lib/index.js'))).default;
let queries = 0;
const query = pg.Pool.prototype.query;
pg.Pool.prototype.query = function (...a) { queries++; return query.apply(this, a); };

const routes = await import(pathToFileURL(path.join(dist, 'src/api/native-public-read-routes.js')).href);
const read = async (p) => {
  const t = Date.now(), n = proofs.length, q = queries, cpu = process.cpuUsage();
  let status, body, error;
  try { const r = await routes.nativePublicData(new URL(p, 'https://uain.invalid')); status = r.status; body = r.body; } catch (e) { error = String(e?.message ?? e).slice(0, 120); }
  const used = process.cpuUsage(cpu);
  return { path: p, status, error, ms: Date.now() - t, proofs: proofs.length - n, sql: queries - q, cpu_ms: Math.round((used.user + used.system) / 1000), body };
};
const family = (k) => k.startsWith('legacy/row/') ? k.split('/').slice(0, 3).join('/') : k.startsWith('legacy/') ? k.split('/').slice(0, 2).join('/') : k.split('/')[0];

const started = Date.now(), phases = [];
const core = ['/api/stats', '/api/projects?page_size=200', '/api/tasks?page_size=200', '/api/directory?page_size=200', '/api/contributions?page_size=200', '/api/directory/map'];
let ids = [];
for (const p of core) {
  const r = await read(p);
  if (p.startsWith('/api/projects') && r.body?.projects) ids = r.body.projects.map((x) => x.id);
  phases.push({ path: r.path, status: r.status, error: r.error, ms: r.ms, proofs: r.proofs, sql: r.sql, cpu_ms: r.cpu_ms, consistent: r.body?.proved?.consistent_snapshot });
}
const coreProofs = proofs.length, coreMs = Date.now() - started;
let pageProofs = 0, pageSql = 0, pageMs = 0, pageCpu = 0, pages = 0, failed = 0; const worst = [];
for (const id of ids) for (const s of ['', '/tasks', '/claims', '/members']) {
  const r = await read('/api/projects/' + encodeURIComponent(id) + s);
  pages++; pageProofs += r.proofs; pageSql += r.sql; pageMs += r.ms; pageCpu += r.cpu_ms; if (r.status !== 200) failed++;
  if (r.proofs) worst.push({ path: r.path, proofs: r.proofs, ms: r.ms });
}
worst.sort((a, b) => b.proofs - a.proofs);
const sizes = proofs.map((p) => p.keys?.length ?? -1);
const hist = { '0-1': 0, '2-4': 0, '5-15': 0, '16-31': 0, '32': 0 };
for (const n of sizes) hist[n <= 1 ? '0-1' : n <= 4 ? '2-4' : n <= 15 ? '5-15' : n <= 31 ? '16-31' : '32']++;
const small = {};
for (const p of proofs) if ((p.keys?.length ?? 0) < 16) { const f = [...new Set((p.keys ?? []).map(family))].sort().join('+') || '(checkpoint)'; small[f] = (small[f] ?? 0) + 1; }
const done = proofs.filter((p) => p.ms !== null);
console.log(JSON.stringify({
  dist, started: new Date(started).toISOString(), total_ms: Date.now() - started, projects: ids.length,
  core: { ms: coreMs, proofs: coreProofs, phases },
  project_pages: { pages, failed, ms: pageMs, cpu_ms: pageCpu, proofs: pageProofs, sql: pageSql, with_proofs: worst.length, worst: worst.slice(0, 8) },
  proofs: { total: proofs.length, keys: sizes.reduce((a, n) => a + Math.max(0, n), 0), refused: proofs.filter((p) => p.code !== 0 && p.code !== null).length, hist, avg_ms: done.length ? Math.round(done.reduce((a, p) => a + p.ms, 0) / done.length) : null, small_by_family: Object.fromEntries(Object.entries(small).sort((a, b) => b[1] - a[1]).slice(0, 25)) },
  sql: queries,
}, null, 1));
process.exit(0);

/**
 * How many database queries each read request makes, against a copy of a real
 * store. Every query is a round trip once the store is a database server, so
 * this number, not the milliseconds on a laptop, is what decides whether a
 * request stays fast as the network grows.
 *
 *   DATABASE_URL=<an empty database> \
 *     node scripts/query-count.mjs <dir holding pilot.sqlite and log.salt>
 *
 * Works on a copy of the directory; the server copies pilot.sqlite into the
 * empty database as it starts.
 */
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = process.argv[2];
if (!source) {
  console.error('usage: node scripts/query-count.mjs <store dir>');
  process.exit(2);
}
const dir = mkdtempSync(join(tmpdir(), 'uain-qc-'));
cpSync(source, dir, { recursive: true });
process.env.UAIN_DATA_DIR = dir;
process.env.UAIN_RATE_REQUESTS_PER_MIN = '1000000';

const db = await import('../dist/src/application/db.js');
const { counter } = await import('../dist/src/storage/store.js');
const { createPilotServer } = await import('../dist/src/api/server.js');
const server = createPilotServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// The busiest member: the one whose menu is largest is the worst case.
const members = await db.listParticipants();
const sizes = [];
for (const p of members)
  sizes.push({ id: p.id, n: (await db.nextFor(p.id, { limit: 50 })).count });
const busiest = sizes.sort((a, b) => b.n - a.n)[0].id;
const token = await db.issueToken(busiest);
const project = (await db.listProjects())[0];
const task = (await db.listAllTasks())[0];
const contribution = (await db.listContributions())[0];

const requests = [
  ['/api/descriptor'],
  ['/api/directory'],
  [`/api/directory/${busiest}`],
  ['/api/projects'],
  [`/api/projects/${project.id}`],
  [`/api/projects/${project.id}/tasks`],
  [`/api/projects/${project.id}/claims`],
  ['/api/tasks'],
  task && [`/api/tasks/${task.id}`],
  ['/api/contributions'],
  contribution && [`/api/contributions/${contribution.id}`],
  ['/api/events?limit=50'],
  ['/api/next?limit=50', token],
].filter(Boolean);

console.log(`busiest member: ${busiest}\n`);
let total = 0;
for (const [path, bearer] of requests) {
  const before = counter.queries;
  const t = performance.now();
  const res = await fetch(base + path, {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
  await res.arrayBuffer();
  const ms = performance.now() - t;
  const queries = counter.queries - before;
  total += queries;
  console.log(
    `${String(res.status)}  ${path.padEnd(48)} ${String(queries).padStart(6)} queries  ${ms.toFixed(1).padStart(7)} ms`,
  );
}
console.log(`\n${total} queries across ${requests.length} requests`);
server.close();
process.exit(0);

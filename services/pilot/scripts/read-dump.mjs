/**
 * Every read the pilot can answer, from a copy of a real store, as one JSON
 * document on stdout. Run it before and after a change to how data is fetched
 * and diff the two: the answers must be identical.
 *
 *   DATABASE_URL=<an empty database> \
 *     node scripts/read-dump.mjs <dir holding pilot.sqlite and log.salt> > after.json
 *
 * The server copies pilot.sqlite into the empty database as it starts, the
 * way production moved, so this also checks that copy. The clock is frozen at
 * the store's last ledger entry, so windows such as "working in the last six
 * hours" come out the same on every run.
 */
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const source = process.argv[2];
if (!source) {
  console.error('usage: node scripts/read-dump.mjs <store dir>');
  process.exit(2);
}
const dir = mkdtempSync(join(tmpdir(), 'uain-dump-'));
cpSync(source, dir, { recursive: true });

const last = new DatabaseSync(join(dir, 'pilot.sqlite'))
  .prepare('SELECT MAX(at) AS at FROM events')
  .get().at;
const frozen = Date.parse(last);
Date.now = () => frozen;

process.env.UAIN_DATA_DIR = dir;
const db = await import('../dist/src/application/db.js');

const participants = await db.listParticipants();
const projects = await db.listProjects();
const tasks = await db.listAllTasks();
const contributions = await db.listContributions();

// Each read awaited in turn, keyed as the SQLite version of this script keyed it.
const each = async (xs, f) => {
  const o = {};
  for (const x of xs) o[x[0]] = await f(x[1]);
  return o;
};
const claimIds = [];
for (const p of projects)
  for (const c of await db.listClaims(p.id)) claimIds.push(c.id);

const out = {
  frozen_at: last,
  participants,
  projects,
  tasks,
  contributions,
  project: await each(
    projects.map((p) => [p.id, p]),
    async (p) => ({
      get: await db.getProject(p.id),
      tasks: await db.listTasks(p.id),
      claims: await db.listClaims(p.id),
      claim_counts: await db.claimCounts(p.id),
      task_counts: await db.taskCounts(p.id),
      open_tasks: await db.listAllTasks({ projectId: p.id, status: 'open' }),
    }),
  ),
  task: await each(tasks.map((t) => [t.id, t.id]), (id) => db.getTask(id)),
  contribution: await each(
    contributions.map((c) => [c.id, c.id]),
    (id) => db.getContribution(id),
  ),
  claim: await each(claimIds.map((id) => [id, id]), (id) => db.getClaim(id)),
  member: await each(
    participants.map((p) => [p.id, p.id]),
    async (id) => ({
      get: await db.getParticipant(id),
      work: await db.participantWork(id),
      balance: await db.balance(id),
      next: await db.nextFor(id, { limit: 50 }),
      next_by_project: await each(
        projects.map((x) => [x.id, x.id]),
        (pid) => db.nextFor(id, { projectId: pid, limit: 50 }),
      ),
    }),
  ),
  arbiters: await db.listTrustedArbiters(),
  events: await db.listEvents(200),
};

process.stdout.write(JSON.stringify(out, null, 1));
process.exit(0);

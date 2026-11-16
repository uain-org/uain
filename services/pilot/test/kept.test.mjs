/**
 * Projects kept in memory (application/db.ts): a repeat read comes from
 * memory and answers the same; a write, on this server or any other, is seen
 * by the next read, because it moves the project's version in its own
 * transaction.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { boot } from './helpers.mjs';

let t;
let store;
before(async () => {
  t = await boot();
  store = await import('../dist/src/storage/store.js');
});
after(async () => {
  await t.close();
});

const STOP = ['Halt if the work would require restricted data.'];

/** Another connection, as another server would write. */
async function elsewhere(sql, params) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(sql, params);
  } finally {
    await client.end();
  }
}

async function projectWithTask(title) {
  const lead = await t.enrol({ name: `${title} Lead`, operator: `${title} Labs` });
  await t.makeUain(lead.id);
  const p = await t.db.propose({ lead: lead.id, title, summary: 'Kept.', stopConditions: STOP });
  const { task } = await t.db.openTask({ author: lead.id, projectId: p.id, title: 'First', question: 'q', doneWhen: 'd', howToCheck: 'c' });
  return { lead, p, task };
}

/** A read, with how many queries it sent and whether memory served it. */
async function read(id) {
  const queries = store.counter.queries;
  const hits = t.db.keptStats.hits;
  const project = await t.db.getProject(id);
  return { project, queries: store.counter.queries - queries, fromMemory: t.db.keptStats.hits > hits };
}

describe('projects kept in memory', () => {
  test('a repeat read comes from memory, with fewer queries and the same answer', async () => {
    const { p } = await projectWithTask('Kept A');
    const first = await read(p.id);
    const second = await read(p.id);
    assert.equal(second.fromMemory, true);
    assert.ok(second.queries < first.queries, `${second.queries} queries, then ${first.queries}`);
    assert.deepEqual(second.project, first.project);
  });

  test('a change from another server is seen once it moves the version, and only then', async () => {
    const { p } = await projectWithTask('Kept B');
    const joiner = await t.enrol({ name: 'Joiner', operator: 'Join Labs' });
    const count = (r) => r.project.members.count;
    const before = count(await read(p.id));
    // The row changes without the version: memory still answers, which is
    // how this test knows the read really came from memory.
    await elsewhere('INSERT INTO project_members (project_id, member_id, joined_at) VALUES ($1, $2, $3)', [p.id, joiner.id, new Date().toISOString()]);
    const stale = await read(p.id);
    assert.equal(stale.fromMemory, true);
    assert.equal(count(stale), before);
    // As a write on another server does: the version moves with the change.
    await elsewhere('SELECT bump_versions($1::jsonb)', [JSON.stringify([p.id])]);
    const fresh = await read(p.id);
    assert.equal(fresh.fromMemory, false);
    assert.equal(count(fresh), before + 1);
  });

  test('a write in the project is seen by the very next read', async () => {
    const { lead, p } = await projectWithTask('Kept C');
    await read(p.id);
    const before = (await read(p.id)).project.tasks.total;
    await t.db.openTask({ author: lead.id, projectId: p.id, title: 'Second', question: 'q', doneWhen: 'd', howToCheck: 'c' });
    const after = await read(p.id);
    assert.equal(after.fromMemory, false);
    assert.equal(after.project.tasks.total, before + 1);
  });

  test('a whole-network write outdates every project kept', async () => {
    const { p } = await projectWithTask('Kept D');
    await read(p.id);
    assert.equal((await read(p.id)).fromMemory, true);
    const someone = await t.enrol({ name: 'Newcomer', operator: 'Elsewhere Labs' });
    await t.db.setUainRole({ participant: someone.id, role: 'project-creator', on: true, by: 'operator:test' });
    assert.equal((await read(p.id)).fromMemory, false);
  });

  test('a check moves only its own project', async () => {
    const a = await projectWithTask('Kept E');
    const b = await projectWithTask('Kept F');
    const checker = await t.enrol({ name: 'Checker', operator: 'Check Labs' });
    await t.makeUain(checker.id);
    await t.db.joinProject(a.p.id, checker.id);
    const work = await t.db.contribute({ contributor: a.lead.id, projectId: a.p.id, title: 'Work', detail: 'd', artifacts: [], karmaClaimed: 1 });
    assert.ok(work.id, JSON.stringify(work));
    await read(a.p.id);
    await read(b.p.id);
    const checked = await t.db.verify({ verifier: checker.id, contributionId: work.id, verdict: 'confirmed', note: 'Reproduced.' });
    assert.equal(checked.error, undefined, JSON.stringify(checked));
    assert.equal((await read(b.p.id)).fromMemory, true);
    assert.equal((await read(a.p.id)).fromMemory, false);
  });

  test('a write refused, or with nothing to do, outdates nothing', async () => {
    const { p } = await projectWithTask('Kept G');
    await read(p.id);
    const refused = await t.db.verify({ verifier: 'nobody', contributionId: 'RC-0', verdict: 'confirmed', note: 'x' });
    assert.equal(refused.error, 'contribution_not_found');
    assert.equal((await read(p.id)).fromMemory, true);
  });
});

describe('board statistics worked out once for every server', () => {
  test('one server works them out; the others read its answer while it is at it again', async () => {
    t.db.forgetStats();
    const first = await t.db.stats();
    const shared = await t.db.prepare("SELECT at, value FROM shared_results WHERE key = 'stats'").get();
    assert.deepEqual(shared.value, first);

    // Stale, with a marker, and another server holding the lock: this server
    // must answer with the stored numbers, not count again.
    await elsewhere(
      "UPDATE shared_results SET at = $1, value = jsonb_set(value, '{participants}', '-1') WHERE key = 'stats'",
      [new Date(Date.now() - 60_000).toISOString()],
    );
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query('SELECT pg_advisory_lock(4202613)');
      t.db.forgetStats();
      assert.equal((await t.db.stats()).participants, -1);
    } finally {
      await client.end();
    }
    // Lock free again: it counts afresh.
    t.db.forgetStats();
    assert.equal((await t.db.stats()).participants, first.participants);
  });
});

describe('project summaries built once for every server', () => {
  test('a rebuild is stored for the others, stamped with the ledger head it was built at', async () => {
    const page = await t.db.listProjectSummaries({});
    const stamp = await t.db
      .prepare("SELECT (value->>'head')::bigint AS head, jsonb_array_length(value->'rows') AS n FROM shared_results WHERE key = 'project-summaries'")
      .get();
    const head = (await t.db.prepare('SELECT MAX(id) AS id FROM events').get()).id;
    const projects = (await t.db.prepare('SELECT COUNT(*) AS n FROM projects').get()).n;
    assert.equal(Number(stamp.n), projects);
    assert.equal(Number(stamp.head), head);
    assert.equal(page.count, projects);
  });
});

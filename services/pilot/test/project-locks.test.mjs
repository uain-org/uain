/**
 * A lock per project (storage/store.ts): writes in different projects run at
 * the same time, writes in one project and whole-network writes still take
 * turns, across processes too, and what every write shares (the ledger, the
 * claim and task numbers) stays whole.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { boot } from './helpers.mjs';

let t;
let ledger;
before(async () => {
  t = await boot();
  ledger = await import('../dist/src/ledger/ledger.js');
});
after(async () => {
  await t.close();
});

const STOP = ['Halt if the work would require restricted data.'];
const NETWORK_LOCK = 4_202_609;
const PROJECT_LOCKS = 4_202_611;

const within = (ms, promise, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: still waiting after ${ms} ms`)), ms)),
  ]);
/** Whether `promise` is still pending after `ms`. */
const stillWaiting = (promise, ms) =>
  Promise.race([promise.then(() => false), new Promise((r) => setTimeout(() => r(true), ms))]);

/** Another connection, as another server process would hold the locks. */
async function holding(sql, params) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query('BEGIN');
  await client.query(sql, params);
  return async () => {
    await client.query('COMMIT');
    await client.end();
  };
}

async function projectWithLead(title) {
  const lead = await t.enrol({ name: `${title} Lead`, operator: `${title} Labs` });
  await t.makeUain(lead.id);
  const p = await t.db.propose({ lead: lead.id, title, summary: 'Locks.', stopConditions: STOP });
  return { lead, p };
}

describe('a lock per project', () => {
  test('writes in two projects run at the same time', async () => {
    let bInside;
    const bStarted = new Promise((resolve) => (bInside = resolve));
    // A waits, holding its lock, until B is inside its own. Under one lock for
    // everything B could never get in, and this would time out.
    const a = t.db.atomically(() => within(3000, bStarted, 'the other project'), 'a', { project: 'lock-a' });
    const b = t.db.atomically(async () => bInside(), 'b', { project: 'lock-b' });
    await Promise.all([a, b]);
  });

  test("a project's writes wait for another process holding that project", async () => {
    const release = await holding('SELECT pg_advisory_xact_lock($1, hashtext($2))', [PROJECT_LOCKS, 'lock-held']);
    const write = t.db.atomically(async () => 'done', 'held', { project: 'lock-held' });
    try {
      const other = t.db.atomically(async () => 'done', 'free', { project: 'lock-free' });
      assert.equal(await within(3000, other, 'a different project'), 'done');
      assert.equal(await stillWaiting(write, 300), true);
    } finally {
      await release();
    }
    assert.equal(await within(3000, write, 'after release'), 'done');
  });

  test('a whole-network write in another process holds back project writes', async () => {
    const release = await holding('SELECT pg_advisory_xact_lock($1)', [NETWORK_LOCK]);
    const write = t.db.atomically(async () => 'done', 'project', { project: 'lock-any' });
    try {
      assert.equal(await stillWaiting(write, 300), true);
    } finally {
      await release();
    }
    assert.equal(await within(3000, write, 'after release'), 'done');
  });

  test('a project write in another process holds back whole-network writes', async () => {
    const release = await holding('SELECT pg_advisory_xact_lock_shared($1)', [NETWORK_LOCK]);
    const write = t.db.atomically(async () => 'done', 'network');
    try {
      assert.equal(await stillWaiting(write, 300), true);
    } finally {
      await release();
    }
    assert.equal(await within(3000, write, 'after release'), 'done');
  });

  test('a write inside one project cannot reach the whole network', async () => {
    await assert.rejects(
      t.db.atomically(() => t.db.atomically(async () => {}, 'inner', 'network'), 'outer', { project: 'lock-x' }),
      /cannot reach the whole network/,
    );
  });

  test('task numbers stay distinct across projects opening tasks at once, and skip one taken', async () => {
    const projects = await Promise.all(['Nums A', 'Nums B', 'Nums C'].map(projectWithLead));
    const opened = await Promise.all(
      projects.flatMap(({ lead, p }) =>
        Array.from({ length: 5 }, (_, i) =>
          t.db.openTask({ author: lead.id, projectId: p.id, title: `Task ${i}`, question: 'q', doneWhen: 'd', howToCheck: 'c' }),
        ),
      ),
    );
    const ids = opened.map((r) => r.task.id);
    assert.equal(new Set(ids).size, 15, JSON.stringify(ids));

    // A number a server on the older code took by "highest plus one".
    const { lead, p } = projects[0];
    const next = (await t.db.prepare("SELECT last_value + 1 AS n FROM task_number").get()).n;
    await t.db
      .prepare("INSERT INTO tasks (id, project_id, created_by, title, question, done_when, how_to_check, created_at) VALUES (?, ?, ?, 'x', 'q', 'd', 'c', ?)")
      .run(`T-${next}`, p.id, lead.id, new Date().toISOString());
    const after = await t.db.openTask({ author: lead.id, projectId: p.id, title: 'After', question: 'q', doneWhen: 'd', howToCheck: 'c' });
    assert.equal(after.task.id, `T-${next + 1}`);
  });

  test("each task names the ledger entry that announced it", async () => {
    const tasks = await t.db.prepare("SELECT id, event_id FROM tasks WHERE title LIKE 'Task %'").all();
    assert.ok(tasks.length >= 15);
    for (const task of tasks) {
      const entry = await t.db.getEvent(task.event_id);
      assert.ok(entry, `${task.id} has no entry`);
      assert.match(entry.summary, new RegExp(`^Opened ${task.id} `));
      assert.equal(entry.peer, null);
    }
  });

  test('the ledger stays one chain while projects write at once', async () => {
    const projects = await Promise.all(['Chain A', 'Chain B', 'Chain C', 'Chain D'].map(projectWithLead));
    await Promise.all(
      projects.flatMap(({ lead, p }) =>
        Array.from({ length: 10 }, (_, i) =>
          t.db.contribute({ contributor: lead.id, projectId: p.id, title: `Work ${i}`, detail: 'd', artifacts: [], karmaClaimed: 1 }),
        ),
      ),
    );
    const events = await t.db.prepare('SELECT * FROM events ORDER BY id').all();
    const chain = ledger.verifyChain(events);
    assert.equal(chain.ok, true, JSON.stringify(chain.errors.slice(0, 3)));
    const prevs = events.map((e) => e.prev_hash);
    assert.equal(new Set(prevs).size, prevs.length, 'two entries claim one predecessor');
    // Entries become visible in id order, which the live stream relies on.
    const ats = events.map((e) => e.at);
    assert.deepEqual([...ats].sort(), ats);
  });
});

describe('the ledger hashed in the database', () => {
  test('matches the chain hash byte for byte, whatever the text', async () => {
    const nasty = [
      'plain', '', 'quote " and \' apostrophe', 'back\\slash', 'slash / here',
      'new\nline', 'tab\there', 'return\r', 'form\ffeed', 'back\bspace',
      Array.from({ length: 31 }, (_, i) => String.fromCharCode(i + 1)).join(''),
      'del \u007f', 'line sep   para  ', 'bom ﻿', 'nbsp  ',
      'κ karma', 'emoji 🧪🔬', 'combining é', 'cjk 中文', 'rtl עברית',
      '{"json":["looking",1]}', "'); DROP TABLE events; --", 'x'.repeat(5000),
    ];
    const before = (await t.db.prepare('SELECT MAX(id) AS id FROM events').get()).id;
    // Several entries in one write, and single ones, with and without a peer.
    await t.db.atomically(async () => {
      for (const text of nasty) await t.db.record('test', 'fuzz-actor', text, 'fuzz peer "\n"');
    }, 'fuzz', 'ledger');
    for (const text of nasty.slice(0, 5)) await t.db.record('test', 'fuzz-actor', text);
    const events = await t.db.prepare('SELECT * FROM events ORDER BY id').all();
    const chain = ledger.verifyChain(events);
    assert.equal(chain.ok, true, JSON.stringify(chain.errors.slice(0, 3)));
    const added = events.filter((e) => e.id > before);
    assert.equal(added.length, nasty.length + 5);
    assert.deepEqual(added.slice(0, nasty.length).map((e) => e.summary), nasty);
  });
});

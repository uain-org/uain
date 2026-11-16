/**
 * Reads must cost a fixed number of queries however much the network holds.
 * They used to fetch one row at a time inside loops, so one agent's menu over
 * five projects took 890 queries, and every new project, task or check added
 * more. Each query becomes a round trip once the store is a database server.
 *
 * This grows the network fourfold and requires every read to make exactly as
 * many queries as before. A read that starts looping over the database again
 * fails here, not in production.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { boot } from './helpers.mjs';

let t;
let counter;
let trackRecord;
before(async () => {
  t = await boot();
  ({ counter } = await import('../dist/src/storage/store.js'));
  ({ trackRecord } = await import('../dist/src/application/track-record.js'));
});
after(async () => {
  await t.close();
});

const STOP = ['Halt if the work would require restricted data.'];
let round = 0;
let watcher;

/**
 * One more project with every kind of thing a read shows: settled, held and
 * contested work, a believed claim and an open draft, a task someone is on
 * and one passed on. The watcher is a member of every project.
 */
async function grow() {
  const db = t.db;
  const n = ++round;
  const enrol = async (name, model) => {
    const m = await t.enrol({ name: `${name} ${n}`, operator: `${name} Labs ${n}`, model });
    await t.makeUain(m.id);
    return m;
  };
  const [lead, ann, bo, cy, di] = [
    await enrol('Lead', 'claude-opus'),
    await enrol('Ann', 'claude-sonnet'),
    await enrol('Bo', 'gpt-5'),
    await enrol('Cy', 'gemini'),
    await enrol('Di', 'llama'),
  ];
  const p = await db.propose({
    lead: lead.id,
    title: `Growth ${n}`,
    summary: 'A project that exists to be read.',
    stopConditions: STOP,
  });
  for (const m of [ann, bo, cy, di, watcher]) await db.joinProject(p.id, m.id);
  const open = async (title) =>
    (await db.openTask({
      author: lead.id,
      projectId: p.id,
      title,
      question: 'What is the digest?',
      doneWhen: 'A digest is reported',
      howToCheck: 'Recompute it',
    })).task;
  const [settled, held, contested, idle, passed, watched] = [
    await open('Settled'),
    await open('Held'),
    await open('Contested'),
    await open('Idle'),
    await open('Passed'),
    await open('Watched'),
  ];
  const answer = async (who, task, claim) =>
    await db.contribute({
      contributor: who.id,
      projectId: p.id,
      title: `Answer to ${task.id}`,
      detail: 'Recomputed.',
      artifacts: [{ label: 'digest' }],
      karmaClaimed: 5,
      taskId: task.id,
      claim,
    });
  const check = async (who, c, verdict = 'confirmed') =>
    await db.verify({
      verifier: who.id,
      contributionId: c.id,
      verdict,
      note: 'Re-ran it.',
    });

  const one = await answer(ann, settled, `Digest ${n} is stable.`);
  await check(bo, one);
  await check(cy, one);
  const two = await answer(bo, held);
  await check(ann, two);
  const three = await answer(cy, contested);
  await check(di, three, 'disputed');
  await db.createClaim({
    author: di.id,
    projectId: p.id,
    statement: `Digest ${n} is reproducible.`,
    sources: [one.id],
    reason: 'It settled.',
  });
  await db.startTask({ participant: ann.id, taskId: idle.id });
  // Two passes ask the lead to rethink the task.
  await db.passTask({ participant: bo.id, taskId: passed.id, reason: 'No GPU.' });
  await db.passTask({ participant: cy.id, taskId: passed.id, reason: 'No GPU.' });
  // The watcher's own history grows with the network.
  await check(ann, await answer(watcher, watched));
  await db.startItem({ participant: di.id, kind: 'verify', id: two.id });
  return { lead, project: p, contribution: one };
}

/** Queries each read makes against the network as it stands now. */
async function costs(latest) {
  const db = t.db;
  const reads = {
    listProjects: () => db.listProjects(),
    getProject: () => db.getProject(latest.project.id),
    listTasks: () => db.listTasks(latest.project.id),
    listAllTasks: () => db.listAllTasks(),
    listClaims: () => db.listClaims(latest.project.id),
    listContributions: () => db.listContributions(),
    getContribution: () => db.getContribution(latest.contribution.id),
    participantWork: () => db.participantWork(watcher.id),
    nextForWatcher: () => db.nextFor(watcher.id, { limit: 50 }),
    nextForLead: () => db.nextFor(latest.lead.id, { limit: 50 }),
    // The track record of an agent and of a member (GET /api/directory/{id}/track-record,
    // GET /api/members/{address}/track-record, uain_track_record).
    trackRecordOfAgent: () => trackRecord({ participant: watcher.id }),
    trackRecordOfMember: () => trackRecord({ member: watcher.member_id }),
  };
  const out = {};
  for (const [name, read] of Object.entries(reads)) {
    // Writes are announced in the background after they commit; a late one
    // landing inside a read would be counted as that read's.
    await db.announcedAll();
    const before = counter.queries;
    await read();
    out[name] = counter.queries - before;
  }
  return out;
}

describe('query budget', () => {
  test('reads make as many queries at four projects as at one', async () => {
    watcher = await t.enrol({
      name: 'Watcher',
      operator: 'Watcher Labs',
      model: 'mistral',
    });
    const small = await costs(await grow());
    let latest;
    for (let i = 0; i < 3; i++) latest = await grow();
    const large = await costs(latest);
    assert.deepEqual(large, small);
    // And the numbers stay small: a read is a handful of batched queries.
    for (const [name, n] of Object.entries(large))
      assert.ok(n <= 40, `${name} made ${n} queries`);
  });
});

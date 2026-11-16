/**
 * Writes that arrive together, in one process and across two.
 *
 * Under SQLite in one process no two writes could ever interleave, and the
 * rules lean on that: a contribution settles when its second check lands,
 * ids come from the highest one taken, each ledger entry chains to the one
 * before it. With PostgreSQL every write takes one lock instead (store.mjs).
 * These tests fire writes at once and require the outcomes the lock exists
 * for: one settlement, distinct ids, an unbroken chain.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
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
const allEvents = () => t.db.prepare('SELECT * FROM events ORDER BY id').all();

describe('writes at the same time', () => {
  test('three checks landing together settle a contribution once', async () => {
    const enrol = async (name, model) => {
      const m = await t.enrol({ name, operator: `${name} Labs`, model });
      await t.makeUain(m.id);
      return m;
    };
    const [lead, v1, v2, v3] = await Promise.all([
      enrol('Race Lead', 'claude'),
      enrol('Race V1', 'gpt-5'),
      enrol('Race V2', 'gemini'),
      enrol('Race V3', 'llama'),
    ]);
    const p = await t.db.propose({
      lead: lead.id,
      title: 'Race',
      summary: 'Checks arriving together.',
      stopConditions: STOP,
    });
    for (const m of [v1, v2, v3]) await t.db.joinProject(p.id, m.id);
    const work = await t.db.contribute({
      contributor: lead.id,
      projectId: p.id,
      title: 'Work',
      detail: 'Checked by three at once.',
      artifacts: [],
      karmaClaimed: 10,
    });

    const results = await Promise.all(
      [v1, v2, v3].map((v) =>
        t.db.verify({
          verifier: v.id,
          contributionId: work.id,
          verdict: 'confirmed',
          note: 'Reproduced.',
        }),
      ),
    );
    assert.equal(results.filter((r) => r.settled === true).length, 1);
    assert.equal(results.filter((r) => r.error === 'already_settled').length, 1);
    const paid = await t.db
      .prepare(
        "SELECT COUNT(*) AS n FROM credit_ledger WHERE ref = ? AND kind = 'bounty'",
      )
      .get(work.id);
    assert.equal(paid.n, 1);
    assert.equal((await t.db.getParticipant(lead.id)).karma, 10);
  });

  test('ids stay distinct when many writes open things at once', async () => {
    const lead = await t.enrol({ name: 'Id Lead', operator: 'Id Labs' });
    await t.makeUain(lead.id);
    const p = await t.db.propose({
      lead: lead.id,
      title: 'Ids',
      summary: 'Numbers handed out together.',
      stopConditions: STOP,
    });
    const tasks = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        t.db.openTask({
          author: lead.id,
          projectId: p.id,
          title: `Task ${i}`,
          question: 'q',
          doneWhen: 'd',
          howToCheck: 'c',
        }),
      ),
    );
    const ids = tasks.map((r) => r.task.id);
    assert.equal(new Set(ids).size, 10);
    const answers = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        t.db.contribute({
          contributor: lead.id,
          projectId: p.id,
          title: `Answer ${i}`,
          detail: 'x',
          artifacts: [],
          karmaClaimed: 1,
        }),
      ),
    );
    assert.equal(new Set(answers.map((a) => a.id)).size, 10);
  });

  test('two server processes writing at once keep one unbroken ledger', async () => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./fixtures/writer.mjs', import.meta.url)), '100'],
      { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const exited = new Promise((resolve) => child.on('exit', resolve));
    await new Promise((resolve) => child.stdout.once('data', resolve));
    // Both processes write from the same moment.
    child.stdin.write('go\n');
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        Promise.all([
          t.enrol({ name: 'Crowd', operator: `Parent ${i}` }),
          t.db.record('test', 'parent', `parent entry ${i}`),
        ]),
      ),
    );
    assert.equal(await exited, 0, stderr);

    const events = await allEvents();
    const chain = ledger.verifyChain(events);
    assert.equal(chain.ok, true, JSON.stringify(chain.errors.slice(0, 3)));
    const prevs = events.map((e) => e.prev_hash);
    assert.equal(new Set(prevs).size, prevs.length, 'two entries claim one predecessor');
    const crowd = await t.db
      .prepare("SELECT COUNT(*) AS n FROM participants WHERE name = 'Crowd'")
      .get();
    assert.equal(crowd.n, 200);
  });
});

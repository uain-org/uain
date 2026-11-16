/**
 * Karma gates from the white paper (5.8): opening a project needs 1,000 karma
 * and caps how many a member runs; checking work needs 100; and work checked
 * by karma-qualified members settles only once one of UAIN's default
 * verifiers confirms it. UAIN's own agents, named by the operator, are exempt.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { boot } from './helpers.mjs';

let t;
before(async () => {
  t = await boot();
});
after(async () => {
  await t.close();
});

const STOP = ['Halt if the work would require restricted data.'];
const setKarma = (id, karma) =>
  t.db.prepare('UPDATE participants SET karma = ? WHERE id = ?').run(karma, id);
const propose = (who, title = `P ${Math.random().toString(36).slice(2, 8)}`) =>
  who.call('uain_propose', { title, summary: 's', stop_conditions: STOP });
const confirm = (who, id) =>
  who.call('uain_verify', { contribution_id: id, verdict: 'confirmed', note: 'Checked.' });

describe('opening projects', () => {
  test('the allowance is one at 1,000 and one more per 10 above it', () => {
    assert.equal(t.db.projectAllowance(999), 0);
    assert.equal(t.db.projectAllowance(1000), 1);
    assert.equal(t.db.projectAllowance(1009), 1);
    assert.equal(t.db.projectAllowance(1050), 6);
  });

  test('below 1,000 karma a member cannot open a project', async () => {
    const m = await t.member('Gate Low Co', 'gate-low', { uain: false });
    await setKarma(m.id, 999);
    const r = await propose(m);
    assert.equal(r.opened, false);
    assert.equal(r.error, 'karma_too_low_to_propose');
    assert.equal(r.needed, 1000);
  });

  test('at 1,000 a member runs one project; a finished one frees its place', async () => {
    const m = await t.member('Gate One Co', 'gate-one', { uain: false });
    const other = await t.member('Gate Other Co', 'gate-other');
    await setKarma(m.id, 1000);
    const first = await propose(m);
    assert.equal(first.opened, true, JSON.stringify(first));
    const second = await propose(m);
    assert.equal(second.error, 'project_limit_reached');
    assert.deepEqual(second.running, [first.project.id]);

    // Work done and checked: nothing open, so the project no longer counts.
    await other.call('uain_join_project', { project_id: first.project.id });
    const sub = await m.call('uain_contribute', {
      project_id: first.project.id,
      title: 'w',
      detail: 'x',
      karma_claimed: 1,
      verifiers_required: 1,
    });
    await confirm(other, sub.contribution.id);
    const third = await propose(m);
    assert.equal(third.opened, true, JSON.stringify(third));
  });

  test('1,050 karma runs six at once', async () => {
    const m = await t.member('Gate Six Co', 'gate-six', { uain: false });
    await setKarma(m.id, 1050);
    for (let i = 0; i < 6; i++) assert.equal((await propose(m)).opened, true);
    assert.equal((await propose(m)).error, 'project_limit_reached');
  });

  test("UAIN's project creators need no karma and have no limit", async () => {
    const m = await t.member('Gate Creator Co', 'gate-creator', { uain: false });
    await t.db.setUainRole({ participant: m.id, role: 'project-creator', on: true, by: 'operator:test' });
    for (let i = 0; i < 3; i++) assert.equal((await propose(m)).opened, true);
    const me = await m.call('uain_whoami');
    assert.equal(me.participant.project_creator, true);
  });
});

describe('checking work', () => {
  async function setup(prefix) {
    const lead = await t.member(`${prefix} Lead Co`, `${prefix}-lead`);
    const p = (await propose(lead)).project;
    const join = async (op, name, karma, uain = false) => {
      const m = await t.member(op, name, { uain });
      if (karma !== null) await setKarma(m.id, karma);
      await m.call('uain_join_project', { project_id: p.id });
      return m;
    };
    const sub = async () =>
      (
        await lead.call('uain_contribute', {
          project_id: p.id,
          title: 'w',
          detail: 'x',
          karma_claimed: 10,
        })
      ).contribution;
    return { lead, p, join, sub };
  }

  test('below 100 karma a member cannot check, and is not offered checks', async () => {
    const { p, join, sub } = await setup('cl');
    const low = await join('Low Co', 'cl-low', 99);
    const work = await sub();
    const r = await confirm(low, work.id);
    assert.equal(r.verified, false);
    assert.equal(r.error, 'karma_too_low_to_verify');
    const menu = await low.call('uain_next', { project_id: p.id });
    assert.equal(menu.items.filter((i) => i.kind === 'verify').length, 0);
  });

  test('checks by karma-qualified members wait for a default verifier, whose check pays', async () => {
    const { lead, p, join, sub } = await setup('dv');
    const a = await join('DV A Co', 'dv-a', 150);
    const b = await join('DV B Co', 'dv-b', 150);
    const late = await join('DV Late Co', 'dv-late', 150);
    const def = await join('DV Default Co', 'dv-default', 0);
    await t.db.setUainRole({ participant: def.id, role: 'default-verifier', on: true, by: 'operator:test' });
    const work = await sub();

    await confirm(a, work.id);
    const second = await confirm(b, work.id);
    assert.equal(second.settled, false);
    assert.equal(second.awaiting_default_verifier, true);
    assert.equal((await t.db.getContribution(work.id)).state, 'held');

    // Another member is told nothing more is needed from it, and not offered it.
    const extra = await confirm(late, work.id);
    assert.equal(extra.error, 'awaiting_default_verifier');
    const lateMenu = await late.call('uain_next', { project_id: p.id });
    assert.equal(lateMenu.items.some((i) => i.contribution_id === work.id), false);

    // The default verifier is offered it as the check that releases pay.
    const menu = await def.call('uain_next', { project_id: p.id });
    const item = menu.items.find((i) => i.contribution_id === work.id);
    assert.equal(item?.default_verifier_check, true, JSON.stringify(menu.items));

    const done = await confirm(def, work.id);
    assert.equal(done.settled, true, JSON.stringify(done));
    assert.ok((await t.db.getContribution(work.id)).karma_awarded > 0);
    void lead;
  });

  test('a default verifier among the checks settles the work at once', async () => {
    const { join, sub } = await setup('dn');
    const a = await join('DN A Co', 'dn-a', 150);
    const def = await join('DN Default Co', 'dn-default', 0, true);
    const work = await sub();
    await confirm(a, work.id);
    const done = await confirm(def, work.id);
    assert.equal(done.settled, true, JSON.stringify(done));
  });

  test('contested work an arbiter confirmed still waits for a default verifier', async () => {
    const { join, sub } = await setup('ca');
    const a = await join('CA A Co', 'ca-a', 150);
    const d = await join('CA D Co', 'ca-d', 150);
    const arb = await join('CA Arb Co', 'ca-arb', 150);
    await t.db.setArbiterTrust({ participant: arb.id, trusted: true, by: 'operator:test' });
    const def = await join('CA Default Co', 'ca-default', 0);
    await t.db.setUainRole({ participant: def.id, role: 'default-verifier', on: true, by: 'operator:test' });
    const work = await sub();

    await confirm(a, work.id);
    const contested = await d.call('uain_verify', {
      contribution_id: work.id,
      verdict: 'disputed',
      note: 'Does not reproduce.',
    });
    assert.equal(contested.contested, true, JSON.stringify(contested));
    const ruled = await confirm(arb, work.id);
    assert.equal(ruled.settled, false, JSON.stringify(ruled));
    assert.equal(ruled.awaiting_default_verifier, true);
    const done = await confirm(def, work.id);
    assert.equal(done.settled, true, JSON.stringify(done));
    assert.equal(done.arbitrated, true);
  });

  test('roles are on the record, and removing one takes the exemption away', async () => {
    const m = await t.member('Role Co', 'role-m', { uain: false });
    await t.db.setUainRole({ participant: m.id, role: 'project-creator', on: true, by: 'operator:test' });
    assert.equal((await propose(m)).opened, true);
    await t.db.setUainRole({ participant: m.id, role: 'project-creator', on: false, by: 'operator:test' });
    assert.equal((await propose(m)).error, 'karma_too_low_to_propose');
    const events = await t.db.prepare("SELECT summary FROM events WHERE peer = ? AND kind = 'join'").all(m.id);
    assert.equal(events.length, 2);
    assert.deepEqual(
      (await t.db.listUainRole('project-creator')).some((r) => r.id === m.id),
      false,
    );
  });
});

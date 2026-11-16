/**
 * Two loose ends. Resuming a halted project skipped its lead's allowance: a
 * halted project stops counting, so a lead at 1,000 karma could halt one,
 * open a second, resume the first and run two. A lead's resume now fits the
 * allowance as opening a project does; an operator's is exempt.
 *
 * And the profile follow-ups from uain_profile_update (#23): the MCP
 * directory carries the member's about text as /api/directory does, the
 * directory search matches it, and a new agent added with uain_login
 * declares everything enrolment takes, endpoint and limits included.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { boot, newKey, proveWith } from './helpers.mjs';

/** Run an operator maintenance action on this test's store, as the workflow does. */
const maintenance = (env) =>
  promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL('../dist/src/application/maintenance.js', import.meta.url))],
    { env: { ...process.env, ...env } },
  );

let t;
let def;
before(async () => {
  t = await boot();
  def = await t.member('Resume Default Co', 'resume-default', { uain: false });
  await t.db.setUainRole({ participant: def.id, role: 'default-verifier', on: true, by: 'operator:test' });
});
after(async () => {
  await t.close();
});

const PRINCIPLES = ['voluntary', 'verifiable', 'authority', 'benevolent'];
const STOP = ['Halt if the work would require restricted data.'];
const setKarma = (id, karma) =>
  t.db.prepare('UPDATE participants SET karma = ? WHERE id = ?').run(karma, id);
const propose = (who, title = `P ${Math.random().toString(36).slice(2, 8)}`) =>
  who.call('uain_propose', { title, summary: 's', stop_conditions: STOP });
const halt = (who, p) =>
  who.call('uain_project_halt', { project_id: p.id, condition: STOP[0], reason: 'Restricted data came up.' });
const resume = (who, p) =>
  who.call('uain_project_resume', { project_id: p.id, reason: 'The data question is settled.' });
const stateOf = async (p) => (await t.db.getProject(p.id)).state;

describe("resuming a halted project and the lead's allowance", () => {
  test("a lead's resume must fit its allowance, as opening a project does", async () => {
    const m = await t.member('Resume Lead Co', 'resume-lead', { uain: false });
    await setKarma(m.id, 1000);

    // A project whose work is all done, halted.
    const done = (await propose(m)).project;
    await def.call('uain_join_project', { project_id: done.id });
    const sub = (
      await m.call('uain_contribute', {
        project_id: done.id,
        title: 'w',
        detail: 'x',
        karma_claimed: 1,
        verifiers_required: 1,
      })
    ).contribution;
    const checked = await def.call('uain_verify', { contribution_id: sub.id, verdict: 'confirmed', note: 'Checked.' });
    assert.equal(checked.settled, true, JSON.stringify(checked));
    await setKarma(m.id, 1000);
    assert.equal((await halt(m, done)).halted, true);

    // One still running, halted: it frees the lead's one place, and a second
    // project takes it.
    const first = (await propose(m)).project;
    assert.equal((await halt(m, first)).halted, true);
    const second = await propose(m);
    assert.equal(second.opened, true, JSON.stringify(second));

    // Resuming the first would make two. Before, it resumed.
    const refused = await resume(m, first);
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.equal(refused.error, 'project_limit_reached');
    assert.equal(refused.allowed, 1);
    assert.deepEqual(refused.running, [second.project.id]);
    assert.equal(refused.lead, m.id);
    assert.match(refused.message, /resuming/);
    assert.equal(await stateOf(first), 'halted');
    const lifted = await t.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'halt' AND summary LIKE ?")
      .get(`Resumed "${first.title}"%`);
    assert.equal(Number(lifted.n), 0, 'a refused resume is not on the record');

    // A project with nothing left to do takes no place once resumed.
    const back = await resume(m, done);
    assert.equal(back.resumed, true, JSON.stringify(back));

    // With room for two, the first resumes.
    await setKarma(m.id, 1010);
    const ok = await resume(m, first);
    assert.equal(ok.resumed, true, JSON.stringify(ok));
    assert.equal((await propose(m)).error, 'project_limit_reached');
  });

  test("an operator's resume is exempt: operators decide, whatever the lead's karma", async () => {
    const m = await t.member('Resume Op Lead Co', 'resume-op-lead', { uain: false });
    await setKarma(m.id, 1000);
    const first = (await propose(m)).project;
    assert.equal((await halt(m, first)).halted, true);
    assert.equal((await propose(m)).opened, true);
    assert.equal((await resume(m, first)).error, 'project_limit_reached');
    // Below 1,000 karma a lead may run none, as when opening one.
    await setKarma(m.id, 0);
    const low = await resume(m, first);
    assert.equal(low.error, 'karma_too_low_to_propose', JSON.stringify(low));
    assert.equal(low.needed, 1000);
    assert.match(low.message, /resuming/);

    const out = await maintenance({
      ACTION: 'resume-project',
      PROJECT: first.id,
      BASIS: 'Checked with the lead: it may run both.',
      OPERATOR_ID: 'operator:test',
    });
    assert.match(out.stdout, /resumed/);
    assert.notEqual(await stateOf(first), 'halted');
    assert.equal((await t.db.runningProjects(m.id)).length, 2);
  });
});

/** A member enrolled over MCP with a declaration, and a client acting as it. */
async function declared(name) {
  const anon = await t.connect();
  const key = newKey();
  const r = await anon.call('uain_enrol', {
    name,
    operator: `${name} Labs`,
    capabilities: ['tide modelling'],
    principles: PRINCIPLES,
    proof: proveWith(key, 'enrol'),
  });
  assert.ok(r.session_token, JSON.stringify(r));
  const me = await t.connect(r.session_token);
  return { id: r.participant.id, key, address: key.address, ...me };
}

describe('profile loose ends', () => {
  test('uain_directory carries the member and its about text, as /api/directory does', async () => {
    const a = await declared('Sanderling');
    const about = 'Sanderling models shorelines. Ask it about sediment.';
    assert.equal((await a.call('uain_profile_update', { about })).updated, true);

    const dir = await a.call('uain_directory', { capability: 'tide modelling' });
    const row = dir.participants.find((p) => p.id === a.id);
    assert.ok(row, JSON.stringify(dir));
    assert.deepEqual(row.member, { address: a.address, name: 'Sanderling Labs', about });
    assert.match(dir.declared, /not verified/);

    const http = await (await t.http(`/api/directory?q=sanderling&page_size=50`)).json();
    const same = http.participants.find((p) => p.id === a.id);
    assert.equal(same.member.about, row.member.about);
  });

  test("/api/directory's search matches the member's about text", async () => {
    const a = await declared('Turnstone');
    const b = await t.instance(a.key, 'Turnstone Labs', 'turnstone-two', { uain: false });
    await a.call('uain_profile_update', { about: 'Specialises in estuarine hydrodynamics, 100% of the time.' });
    const search = async (q) =>
      (await (await t.http(`/api/directory?q=${encodeURIComponent(q)}&page_size=50`)).json());

    const found = await search('ESTUARINE hydro');
    assert.deepEqual(found.participants.map((p) => p.id).sort(), [a.id, b.id].sort());
    assert.equal(found.count, 2);
    // Wildcards in the term are taken literally, as for the other columns.
    assert.equal((await search('100%')).count, 2);
    assert.equal((await search('100_')).count, 0);
    assert.equal((await search('riverine')).count, 0);
  });

  test('a new agent declares what enrolment takes, endpoint and limits included', async () => {
    const a = await declared('Knot');
    const anon = await t.connect();
    const r = await anon.call('uain_login', {
      proof: proveWith(a.key, 'login'),
      new_agent: {
        name: 'knot-two',
        operator: 'Knot Labs',
        endpoint: 'https://knot.example/mcp',
        limits: { contextTokens: 100000, autonomy: 'propose' },
        region: 'eu-west',
        principles: PRINCIPLES,
      },
    });
    assert.ok(r.session_token, JSON.stringify(r));
    const row = await t.db.getParticipant(r.participant.id);
    assert.equal(row.endpoint, 'https://knot.example/mcp');
    assert.deepEqual(row.limits, { contextTokens: 100000, autonomy: 'propose' });
    assert.equal(row.reachability, 'agent', 'unstated fields default as at enrolment');

    // Checked with enrolment's schemas: a limit enrolment refuses is refused.
    const bad = await anon.call('uain_login', {
      proof: proveWith(a.key, 'login'),
      new_agent: {
        name: 'knot-three',
        operator: 'Knot Labs',
        limits: { autonomy: 'anything' },
        principles: PRINCIPLES,
      },
    });
    assert.equal(bad.session_token, undefined, JSON.stringify(bad));

    // POST /api/login takes them too, as POST /api/connect does.
    const h = await t.http('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...proveWith(a.key, 'login'),
        new_agent: {
          name: 'knot-four',
          operator: 'Knot Labs',
          endpoint: 'https://knot.example/four',
          limits: { autonomy: 'observe' },
          principles: PRINCIPLES,
        },
      }),
    });
    const hr = await h.json();
    assert.equal(h.status, 200, JSON.stringify(hr));
    const four = await t.db.getParticipant(hr.participant.id);
    assert.equal(four.endpoint, 'https://knot.example/four');
    assert.deepEqual(four.limits, { autonomy: 'observe' });
  });
});

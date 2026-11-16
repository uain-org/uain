/**
 * A member from enrolment to leaving, and what the operator's purge may and
 * may not take with it (docs/federation/reconciliation.md, section 4, bugs 1
 * to 5). The purge runs as the maintenance workflow runs it: the compiled
 * script, in a process of its own, against the same store.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { boot, newKey, proveWith } from './helpers.mjs';

let t;
before(async () => {
  t = await boot();
});
after(async () => {
  await t.close();
});

const PRINCIPLES = ['voluntary', 'verifiable', 'authority', 'benevolent'];
const STOP = ['Halt if the work would require restricted data.'];

const post = (path, body) =>
  t.http(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const enrolment = (name, key) => ({
  name,
  operator: `${name} Labs`,
  principles: PRINCIPLES,
  proof: proveWith(key, 'enrol'),
});

const newAgent = (key, name) =>
  post('/api/login', {
    ...proveWith(key, 'login'),
    new_agent: { name, operator: `${name} Labs`, principles: PRINCIPLES },
  });

const MAINTENANCE = fileURLToPath(
  new URL('../dist/src/application/maintenance.js', import.meta.url),
);

/** Run an operator action, as .github/workflows/maintenance.yml does. */
function maintain(action, participant, extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAINTENANCE], {
      env: { ...process.env, ACTION: action, PARTICIPANT: participant, ...extra },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, out, err }));
  });
}

const count = async (sql, ...args) => (await t.db.prepare(sql).get(...args)).n;

async function project(lead) {
  const r = await lead.call('uain_propose', {
    title: `Project ${Math.random().toString(36).slice(2, 8)}`,
    summary: 'Test project',
    stop_conditions: STOP,
  });
  assert.equal(r.opened, true, JSON.stringify(r));
  return r.project;
}

async function task(lead, projectId) {
  const r = await lead.call('uain_task_open', {
    project_id: projectId,
    title: `Task ${Math.random().toString(36).slice(2, 8)}`,
    question: 'What is the digest of the output?',
    done_when: 'A digest is reported',
    how_to_check: 'Recompute it',
    karma_offered: 20,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.task;
}

describe('purging a record', () => {
  test("a lead is not purged while its project holds another member's work", async () => {
    const lead = await t.member('Purge Lead');
    const worker = await t.member('Purge Worker');
    const p = await project(lead);
    const k = await task(lead, p.id);
    await worker.call('uain_join_project', { project_id: p.id });
    const sub = await worker.call('uain_contribute', {
      project_id: p.id,
      task_id: k.id,
      title: 'Answer',
      detail: 'Recomputed',
      karma_claimed: 5,
      claim: 'The digest is what the task asked for.',
    });
    assert.ok(sub.contribution?.id, JSON.stringify(sub));

    const r = await maintain('purge-participant', lead.id);
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.err, /refusing: .* leads projects holding \d+ row\(s\) of others' work/);
    assert.equal(await count('SELECT COUNT(*) AS n FROM contributions WHERE id = ?', sub.contribution.id), 1);
    assert.equal(await count('SELECT COUNT(*) AS n FROM projects WHERE id = ?', p.id), 1);
    assert.equal(await count('SELECT COUNT(*) AS n FROM participants WHERE id = ?', lead.id), 1);
  });

  test('a lead whose projects hold only its own work is purged with them', async () => {
    const lead = await t.member('Lone Lead');
    const p = await project(lead);
    const k = await task(lead, p.id);
    await t.db.passTask({ participant: lead.id, taskId: k.id, reason: 'No GPU here.' });

    const r = await maintain('purge-participant', lead.id);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(await count('SELECT COUNT(*) AS n FROM projects WHERE id = ?', p.id), 0);
    assert.equal(await count('SELECT COUNT(*) AS n FROM tasks WHERE id = ?', k.id), 0);
    assert.equal(await count('SELECT COUNT(*) AS n FROM participants WHERE id = ?', lead.id), 0);
  });

  test('an agent that passed on a task and declined an item can be purged', async () => {
    const lead = await t.member('Pass Lead');
    const passer = await t.member('Passer');
    const p = await project(lead);
    const k = await task(lead, p.id);
    await passer.call('uain_join_project', { project_id: p.id });
    const passed = await t.db.passTask({ participant: passer.id, taskId: k.id, reason: 'No GPU here.' });
    assert.equal(passed.passed, k.id, JSON.stringify(passed));
    const declined = await t.db.declineItems({
      participant: passer.id,
      items: [{ kind: 'verify', contribution_id: 'RC-4501' }],
      reason: 'Not my field.',
    });
    assert.equal(declined.declined, 1);

    const r = await maintain('purge-participant', passer.id);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(await count('SELECT COUNT(*) AS n FROM participants WHERE id = ?', passer.id), 0);
    assert.equal(await count('SELECT COUNT(*) AS n FROM task_passes WHERE participant = ?', passer.id), 0);
    assert.equal(await count('SELECT COUNT(*) AS n FROM item_declines WHERE participant = ?', passer.id), 0);
    // The lead's project and task are not the passer's to take.
    assert.equal(await count('SELECT COUNT(*) AS n FROM tasks WHERE id = ?', k.id), 1);
  });

  test('a revoked key stays refused after its agents are purged', async () => {
    const key = newKey();
    const made = await (await post('/api/connect', enrolment('Purged Rogue', key))).json();
    assert.ok(made.session_token, JSON.stringify(made));
    const revoked = await t.db.revokeLicence(made.participant.id, 'test: broke a rule');
    assert.equal(revoked.address, key.address);

    const r = await maintain('purge-participant', made.participant.id);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(await count('SELECT COUNT(*) AS n FROM participants WHERE id = ?', made.participant.id), 0);

    const again = await post('/api/connect', enrolment('Purged Rogue Again', key));
    assert.equal(again.status, 403);
    assert.equal((await again.json()).error, 'licence_revoked');
    const login = await newAgent(key, 'Purged Rogue Two');
    assert.equal(login.status, 403);
    assert.equal((await login.json()).error, 'licence_revoked');
    const record = await (await t.http(`/api/members/${key.address}`)).json();
    assert.equal(record.licence.status, 'revoked');
    assert.deepEqual(record.agents, []);
  });
});

describe('purging under native authority (register #117)', () => {
  // The native-authority environment the native boundary test uses; the reader is never run.
  const NATIVE = {
    UAIN_AUTHORITY: 'native', UAIN_NATIVE_PROJECTION: '1',
    UAIN_NATIVE_STATE_BINARY: '/fixture/not-executed/state', UAIN_NATIVE_STATE_SHA256: 'a'.repeat(64),
    UAIN_NATIVE_GENESIS: '/fixture/not-executed/genesis', UAIN_NATIVE_GENESIS_SHA256: 'b'.repeat(64),
    UAIN_NATIVE_RPC: 'http://127.0.0.1:1',
  };
  test('the purge is refused while the pilot source is frozen, and nothing is deleted', async () => {
    const made = await (await post('/api/connect', enrolment('Frozen Source Agent', newKey()))).json();
    assert.ok(made.session_token, JSON.stringify(made));
    const r = await maintain('purge-participant', made.participant.id, NATIVE);
    assert.notEqual(r.code, 0, r.out + r.err);
    assert.match(r.err, /native authority: pilot source is frozen/);
    assert.equal(await count('SELECT COUNT(*) AS n FROM participants WHERE id = ?', made.participant.id), 1);
  });
});

describe('withdrawing', () => {
  test('one agent of several withdraws alone; the last takes the member with it', async () => {
    const key = newKey();
    const first = await (await post('/api/connect', enrolment('Leaver', key))).json();
    const second = await (await newAgent(key, 'Leaver Two')).json();
    assert.ok(second.session_token, JSON.stringify(second));

    const one = await (await t.connect(first.session_token)).call('uain_withdraw');
    assert.equal(one.withdrawn, true);
    assert.equal(one.member_withdrawn, false);
    assert.match(one.removed, /1 other agent and its key are unaffected/);
    assert.doesNotMatch(one.removed, /signs in nowhere/);
    let record = await (await t.http(`/api/members/${key.address}`)).json();
    assert.equal(record.licence.status, 'active');
    const gone = await post('/api/login', { ...proveWith(key, 'login'), agent: first.participant.id });
    assert.equal(gone.status, 403);
    assert.equal((await gone.json()).error, 'agent_withdrawn');
    const plain = await post('/api/login', proveWith(key, 'login'));
    assert.equal(plain.status, 200);

    const last = await (await t.connect(second.session_token)).call('uain_withdraw');
    assert.equal(last.member_withdrawn, true);
    assert.match(last.removed, /signs in and enrols nowhere again/);
    record = await (await t.http(`/api/members/${key.address}`)).json();
    assert.equal(record.licence.status, 'withdrawn');

    // The key cannot add an agent under the same licence, sign in, or enrol.
    const added = await newAgent(key, 'Leaver Three');
    assert.equal(added.status, 403);
    assert.equal((await added.json()).error, 'member_withdrawn');
    const signIn = await post('/api/login', proveWith(key, 'login'));
    assert.equal(signIn.status, 403);
    assert.equal((await signIn.json()).error, 'member_withdrawn');
    const again = await post('/api/connect', enrolment('Leaver Again', key));
    assert.equal(again.status, 403);
    assert.equal((await again.json()).error, 'member_withdrawn');
    const viaMcp = await (await t.connect()).call('uain_login', {
      proof: proveWith(key, 'login'),
      new_agent: { name: 'Leaver Four', operator: 'Leaver Labs', principles: PRINCIPLES },
    });
    assert.equal(viaMcp.error, 'member_withdrawn');
    assert.equal(
      await count("SELECT COUNT(*) AS n FROM participants WHERE member_id = ? AND state != 'withdrawn'", key.address),
      0,
    );
  });
});

describe('agent ids', () => {
  const ADDRESS = /^uain1[0-9a-f]{40}$/;

  test("an agent cannot take a member's address as its id, so revoking it by id revokes its own member", async () => {
    const owner = newKey();
    await post('/api/connect', enrolment('Owner', owner));

    const impostorKey = newKey();
    const impostor = await (
      await post('/api/connect', { ...enrolment('x', impostorKey), name: owner.address })
    ).json();
    assert.ok(impostor.participant, JSON.stringify(impostor));
    assert.notEqual(impostor.participant.id, owner.address);
    assert.doesNotMatch(impostor.participant.id, ADDRESS);

    // Nor the address of a key that has not enrolled yet.
    const later = newKey();
    const early = await (await newAgent(impostorKey, later.address)).json();
    assert.ok(early.participant, JSON.stringify(early));
    assert.notEqual(early.participant.id, later.address);
    assert.doesNotMatch(early.participant.id, ADDRESS);

    const r = await t.db.revokeLicence(impostor.participant.id, 'test: impostor');
    assert.equal(r.address, impostorKey.address);
    const record = await (await t.http(`/api/members/${owner.address}`)).json();
    assert.equal(record.licence.status, 'active');
  });
});

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import * as client from '../../../public/worker/uain-key.mjs';
import * as server from '../dist/src/identity/identity.js';
import { boot, newKey, proveWith } from './helpers.mjs';

let t;
before(async () => {
  t = await boot();
});
after(async () => {
  await t.close();
});

const PRINCIPLES = ['voluntary', 'verifiable', 'benevolent'];
const STOP = ['Halt if the work would require restricted data.'];

const post = (path, body, token) =>
  t.http(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

const enrolment = (name, key) => ({
  name,
  operator: `${name} Labs`,
  principles: PRINCIPLES,
  proof: proveWith(key, 'enrol'),
});

/** An old uain_ token for an agent, as the store held them before keys. */
async function oldToken(id) {
  const salt = readFileSync(join(process.env.UAIN_DATA_DIR, 'log.salt'), 'utf8').trim();
  const token = `uain_${randomBytes(24).toString('hex')}`;
  const hash = createHash('sha256').update(salt).update(token).digest('hex');
  await t.db.prepare('UPDATE participants SET token_hash = ? WHERE id = ?').run(hash, id);
  return token;
}

/**
 * An account from before keys, with its agents, turned into what the server
 * makes of it at start: one member with no key yet, holding every agent.
 */
async function legacyAccount(account, names, karma = 7) {
  const agents = [];
  for (const name of names) {
    const a = await t.enrol({ name, operator: `${account} Labs` });
    await t.db
      .prepare(
        'UPDATE participants SET member_id = NULL, account_id = ?, karma = ? WHERE id = ?',
      )
      .run(account, karma, a.id);
    await t.db.prepare('DELETE FROM device_tokens WHERE subject = ?').run(a.id);
    agents.push({ id: a.id, token: await oldToken(a.id) });
  }
  await t.db.prepare("DELETE FROM members WHERE NOT EXISTS (SELECT 1 FROM participants WHERE member_id = members.id)").run();
  await t.db.adoptLegacyMembers();
  return agents;
}

describe('the key', () => {
  test('client and server make the same address and message', () => {
    const key = newKey();
    assert.equal(server.addressOf(key.public_key), key.address);
    assert.equal(client.addressOf(key.public_key), key.address);
    assert.match(key.address, /^uain1[0-9a-f]{40}$/);
    assert.equal(
      server.proofMessage('login', key.address, 'x', 'ab'),
      client.proofMessage('login', key.address, 'x', 'ab'),
    );
  });

  test('a proof checks only for its own purpose, key, time and nonce', () => {
    const key = newKey();
    const proof = proveWith(key, 'login');
    assert.equal(server.checkProof(proof, 'login').address, key.address);
    assert.equal(server.checkProof(proof, 'enrol').error, 'bad_signature');
    assert.equal(
      server.checkProof({ ...proof, nonce: 'ff'.repeat(16) }, 'login').error,
      'bad_signature',
    );
    assert.equal(
      server.checkProof({ ...proof, address: newKey().address }, 'login').error,
      'address_mismatch',
    );
    const old = proveWith(key, 'login', new Date(Date.now() - 10 * 60_000).toISOString());
    assert.equal(server.checkProof(old, 'login').error, 'proof_expired');
  });
});

describe('a member and its agents', () => {
  test('enrolling makes a member with its first agent; one key is one member', async () => {
    const key = newKey();
    const { proof: _none, ...bare } = enrolment('No Key', key);
    const refused = await post('/api/connect', bare);
    assert.equal(refused.status, 422);
    assert.equal((await refused.json()).error, 'proof_required');

    const r = await post('/api/connect', enrolment('Keyed', key));
    assert.equal(r.status, 201);
    const body = await r.json();
    assert.equal(body.member.address, key.address);
    assert.equal(body.member.licence.status, 'active');
    assert.equal(body.participant.name, 'Keyed');
    assert.equal(body.participant.member.address, key.address);
    assert.equal(JSON.stringify(body).includes(key.private_key), false);

    const again = await post('/api/connect', enrolment('Keyed Twice', key));
    assert.equal(again.status, 409);
    assert.equal((await again.json()).error, 'address_taken');
  });

  test('one key runs many agents; each keeps its name, and the record shows both', async () => {
    const key = newKey();
    const first = await (await post('/api/connect', enrolment('Fleet Claude', key))).json();

    const second = await post('/api/login', {
      ...proveWith(key, 'login'),
      new_agent: { name: 'Fleet Codex', operator: 'Fleet Labs', model: 'codex', principles: PRINCIPLES },
    });
    assert.equal(second.status, 200);
    const codex = await second.json();
    assert.notEqual(codex.participant.id, first.participant.id);
    assert.equal(codex.member.address, key.address);

    // Sign an existing agent in again, from another computer.
    const back = await (
      await post('/api/login', { ...proveWith(key, 'login'), agent: first.participant.id })
    ).json();
    assert.equal(back.participant.id, first.participant.id);
    assert.notEqual(back.session_token, first.session_token);

    // Without an agent: the member and its agents, and no session.
    const plain = await (await post('/api/login', proveWith(key, 'login'))).json();
    assert.equal(plain.session_token, undefined);
    assert.deepEqual(
      plain.member.agents.map((a) => a.id).sort(),
      [first.participant.id, codex.participant.id].sort(),
    );

    const pub = await (await t.http(`/api/directory/${codex.participant.id}`)).json();
    assert.equal(pub.name, 'Fleet Codex');
    assert.equal(pub.member.address, key.address);
    assert.equal(pub.member.agents, 2);
    const record = await (await t.http(`/api/members/${key.address}`)).json();
    assert.equal(record.agents.length, 2);

    const stranger = await post('/api/login', {
      ...proveWith(key, 'login'),
      agent: 'not-one-of-mine',
    });
    assert.equal(stranger.status, 404);
  });

  test('a proof is used once, and proofs signed together both work', async () => {
    const key = newKey();
    const made = await (await post('/api/connect', enrolment('Twins', key))).json();
    const proof = proveWith(key, 'login');
    assert.equal((await post('/api/login', { ...proof, agent: made.participant.id })).status, 200);
    const replay = await post('/api/login', { ...proof, agent: made.participant.id });
    assert.equal(replay.status, 401);
    assert.equal((await replay.json()).error, 'proof_replayed');

    // Two agents of one window start in the same moment, with the same
    // signed_at: the nonce keeps both proofs good.
    const at = new Date().toISOString();
    const statuses = [];
    for (const name of ['Twin A', 'Twin B'])
      statuses.push(
        (
          await post('/api/login', {
            ...proveWith(key, 'login', at),
            new_agent: { name, operator: 'Twins Labs', principles: PRINCIPLES },
          })
        ).status,
      );
    assert.deepEqual(statuses, [200, 200]);
  });

  test('the first thing an agent reads explains the key, the address and the licence', async () => {
    const d = await (await t.connect()).call('uain_describe');
    assert.match(d.identity.what, /Ed25519/);
    assert.match(d.identity.what, /uain1/);
    assert.match(d.identity.agents, /instances/);
    assert.ok(d.identity.how_to_join.some((x) => /uain-key\.mjs new/.test(x)));
    assert.ok(d.safety.never_send.includes('your private key'));
    assert.match(d.next_action, /uain_login/);
    const desc = await (await t.http('/api/descriptor')).json();
    assert.match(desc.connection.identity.model, /instances/);
  });

  test('there are no accounts or passwords any more', async () => {
    for (const path of ['/api/accounts', '/api/account']) {
      const r = await post(path, { username: 'x', password: 'long enough pw' });
      assert.equal(r.status, 404, path);
    }
    const tools = (await (await t.connect()).client.listTools()).tools.map((x) => x.name);
    for (const gone of ['uain_account_create', 'uain_account'])
      assert.equal(tools.includes(gone), false, gone);
    assert.ok(tools.includes('uain_claim_record'));
  });
});

describe('members from before keys', () => {
  test('each account becomes one member holding its agents; an old token says to claim', async () => {
    const [a, b] = await legacyAccount('old-holder', ['Old A', 'Old B'], 5);
    const pa = await t.db.getParticipant(a.id);
    const pb = await t.db.getParticipant(b.id);
    assert.equal(pa.member_id, pb.member_id);
    assert.equal(pa.member.karma, 10);
    assert.equal(pa.member.licence.status, 'unclaimed');

    const r = await t.http('/api/next', { headers: { authorization: `Bearer ${a.token}` } });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error, 'claim_required');
    const me = await t.connect(a.token);
    const who = await me.call('uain_whoami');
    assert.equal(who.authenticated, false);
    assert.match(who.message, /uain_claim_record/);
  });

  test('claiming moves the whole member to the key, keeping every id and karma', async () => {
    const [a, b] = await legacyAccount('claimer', ['Claim A', 'Claim B'], 4);
    const key = newKey();
    const r = await client.claim(t.base, key, a.token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.member.address, key.address);
    assert.equal(r.body.member.karma, 8);
    assert.deepEqual(r.body.member.agents.map((x) => x.id).sort(), [a.id, b.id].sort());
    assert.equal(r.body.participant.id, a.id);

    // Every old token is retired, including the other agent's.
    for (const old of [a.token, b.token])
      assert.equal(
        (await t.http('/api/next', { headers: { authorization: `Bearer ${old}` } })).status,
        401,
      );
    assert.equal((await client.claim(t.base, newKey(), b.token)).status, 401);

    // The other agent signs in with the same key.
    const other = await client.login(t.base, key, { agent: b.id });
    assert.equal(other.status, 200);
    assert.equal(other.body.participant.id, b.id);
    const me = await t.connect(other.body.session_token);
    assert.equal((await me.call('uain_whoami')).participant.id, b.id);
  });

  test('over MCP, the old token as the header is enough', async () => {
    const [a] = await legacyAccount('header-holder', ['Header Holder']);
    const me = await t.connect(a.token);
    const r = await me.call('uain_claim_record', { proof: proveWith(newKey(), 'claim') });
    assert.equal(r.claimed, true, JSON.stringify(r));
    assert.equal(r.participant.id, a.id);
  });

  test('an agent that had no account becomes a member of one', async () => {
    const a = await t.enrol({ name: 'Loner', operator: 'Loner Labs' });
    await t.db.prepare('UPDATE participants SET member_id = NULL, account_id = NULL WHERE id = ?').run(a.id);
    await t.db.adoptLegacyMembers();
    const p = await t.db.getParticipant(a.id);
    assert.equal(p.member.instances, 1);
    assert.equal(p.member.name, 'Loner');
  });
});

describe('the licence', () => {
  test('a revoked licence ends every agent of the member, and the key cannot come back', async () => {
    const key = newKey();
    const made = await (await post('/api/connect', enrolment('Rogue', key))).json();
    const second = await (
      await post('/api/login', {
        ...proveWith(key, 'login'),
        new_agent: { name: 'Rogue Two', operator: 'Rogue Labs', principles: PRINCIPLES },
      })
    ).json();
    const r = await t.db.revokeLicence(made.participant.id, 'test');
    assert.equal(r.revoked, true);
    assert.equal(r.address, key.address);

    for (const token of [made.session_token, second.session_token]) {
      const me = await t.connect(token);
      assert.equal((await me.call('uain_whoami')).authenticated, false);
    }
    const login = await post('/api/login', { ...proveWith(key, 'login'), agent: made.participant.id });
    assert.equal(login.status, 403);
    assert.equal((await login.json()).error, 'licence_revoked');
    assert.equal((await post('/api/connect', enrolment('Rogue Again', key))).status, 403);

    const pub = await (await t.http(`/api/directory/${second.participant.id}`)).json();
    assert.equal(pub.member.licence.status, 'revoked');
    assert.equal(pub.state, 'revoked');
  });
});

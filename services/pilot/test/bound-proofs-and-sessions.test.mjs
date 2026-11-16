/**
 * Proofs bound to the server they are for, and sessions that end: after going
 * unused, or one at a time with uain_logout (reconciliation 4, "Reported by
 * the reviews"). Proofs from before audiences, and sessions from before
 * last-used was kept, go on working.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
const LOOK_ALIKE = 'https://uain-global.example';

const post = (path, body, { token, headers = {} } = {}) =>
  t.http(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });

const bound = (key, purpose, audience = t.base) => client.proveFor(key, purpose, audience);

/** A member with one agent, enrolled over HTTP with a bound proof. */
async function enrolled(name) {
  const key = newKey();
  const r = await post('/api/connect', {
    name,
    operator: `${name} Labs`,
    principles: PRINCIPLES,
    proof: bound(key, 'enrol'),
  });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.equal(body.proof, 'bound');
  return { key, id: body.participant.id, token: body.session_token };
}

const hashOf = (token) => {
  const salt = readFileSync(join(process.env.UAIN_DATA_DIR, 'log.salt'), 'utf8').trim();
  return createHash('sha256').update(salt).update(token).digest('hex');
};
const lastUsed = async (token) =>
  (await t.db.prepare('SELECT last_used_at FROM device_tokens WHERE hash = ?').get(hashOf(token)))
    .last_used_at;
const setLastUsed = (token, at) =>
  t.db.prepare('UPDATE device_tokens SET last_used_at = ? WHERE hash = ?').run(at, hashOf(token));
const daysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString();

/** The access log is written without waiting; this waits for a line. */
async function logged(pattern) {
  const end = Date.now() + 5000;
  for (;;) {
    const { rows } = await t.db.query(
      "SELECT detail FROM access_log WHERE detail LIKE ? ORDER BY id DESC LIMIT 1",
      [pattern],
    );
    if (rows.length) return rows[0].detail;
    if (Date.now() > end) throw new Error(`no access log line like ${pattern}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('a proof names the server it is for', () => {
  test('client and server make the same audience and the same bound message', () => {
    const key = newKey();
    for (const url of [
      'https://uain.global',
      'https://uain.global/',
      'https://UAIN.global:443/mcp',
      'http://127.0.0.1:8787',
      'ftp://uain.global',
      'not a url',
      '',
    ])
      assert.equal(server.audienceOf(url), client.audienceOf(url), url);
    assert.equal(client.audienceOf('https://UAIN.global:443/mcp'), 'https://uain.global');
    assert.equal(
      server.proofMessage('login', key.address, 'x', 'ab', 'https://uain.global'),
      client.proofMessage('login', key.address, 'x', 'ab', 'https://uain.global'),
    );
    assert.equal(
      client.proofMessage('login', key.address, 'x', 'ab', 'https://uain.global'),
      `uain:login:https://uain.global:${key.address}:x:ab`,
    );
    assert.equal(
      client.proofMessage('login', key.address, 'x', 'ab'),
      `uain:login:${key.address}:x:ab`,
      'the unbound form is unchanged',
    );
  });

  test('a bound proof checks only at the server it names', () => {
    const key = newKey();
    const proof = bound(key, 'login', 'https://uain.global/');
    assert.equal(proof.audience, 'https://uain.global', 'signed for the origin');
    const here = { audience: 'https://uain.global' };
    assert.equal(server.checkProof(proof, 'login', here).bound, true);
    assert.equal(server.checkProof(proof, 'login', { audience: 'https://uain.global/mcp' }).bound, true);

    const there = server.checkProof(proof, 'login', { audience: LOOK_ALIKE });
    assert.equal(there.error, 'wrong_audience');
    assert.equal(there.audience_expected, LOOK_ALIKE);
    assert.equal(server.checkProof(proof, 'login').error, 'wrong_audience', 'no audience here, none accepted');

    const { audience: _gone, ...stripped } = proof;
    assert.equal(server.checkProof(stripped, 'login', here).error, 'bad_signature', 'the audience cannot be dropped');
    const other = bound(key, 'login', LOOK_ALIKE);
    assert.equal(
      server.checkProof({ ...other, audience: 'https://uain.global' }, 'login', here).error,
      'bad_signature',
      'nor swapped for this server',
    );
    assert.equal(server.checkProof({ ...proof, audience: 7 }, 'login', here).error, 'proof_incomplete');
  });

  test('an unbound proof is accepted until bound ones are required', () => {
    const key = newKey();
    const old = proveWith(key, 'login');
    assert.equal(old.audience, undefined);
    const here = { audience: 'https://uain.global' };
    assert.equal(server.checkProof(old, 'login', here).bound, false);
    const refused = server.checkProof(old, 'login', { ...here, requireBound: true });
    assert.equal(refused.error, 'audience_required');
    assert.equal(refused.audience_expected, 'https://uain.global');
    assert.equal(server.checkProof(bound(key, 'login', 'https://uain.global'), 'login', { ...here, requireBound: true }).bound, true);
    assert.equal(server.checkProof(old, 'login', here).bound, false, 'the suite opts out (helpers.mjs)');
  });

  test('bound proofs are required by default; only UAIN_REQUIRE_BOUND_PROOFS=0 accepts unbound ones (E-8)', () => {
    const key = newKey();
    const old = proveWith(key, 'login');
    const here = { audience: 'https://uain.global' };
    const { UAIN_REQUIRE_BOUND_PROOFS: _optOut, ...unset } = process.env;
    const check = (env) =>
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const m=await import('./dist/src/identity/identity.js');process.stdout.write(JSON.stringify(m.checkProof(${JSON.stringify(old)},'login',${JSON.stringify(here)}).error??null))`,
        ],
        { env, encoding: 'utf8' },
      );
    assert.equal(JSON.parse(check(unset)), 'audience_required', 'unset: unbound refused');
    for (const value of ['', '1', 'false', 'off', 'no'])
      assert.equal(JSON.parse(check({ ...unset, UAIN_REQUIRE_BOUND_PROOFS: value })), 'audience_required', JSON.stringify(value));
    assert.equal(JSON.parse(check({ ...unset, UAIN_REQUIRE_BOUND_PROOFS: '0' })), null, '0 is the one opt-out');
  });

  test('uain-key.mjs signs for --audience, and signs in bound to its base', async () => {
    const key = newKey();
    assert.throws(() => proveWith(key, 'login', undefined, undefined, 'uain.global'), /origin/);
    const r = await client.login(t.base, key, {});
    assert.equal(r.status, 404, 'no member yet');
    const { key: k2, id } = await enrolled('Keyed Tool');
    const signed = await client.login(t.base, k2, { agent: id });
    assert.equal(signed.status, 200);
    assert.equal(signed.body.proof, 'bound');
    assert.ok(signed.body.session_token.startsWith('uains_'));
  });

  test('over HTTP: bound to this server works once, to another is refused, unbound still works', async () => {
    const { key, id } = await enrolled('Http Binder');
    const proof = bound(key, 'login');
    const ok = await post('/api/login', { ...proof, agent: id });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).proof, 'bound');
    assert.match(await logged(`login:${key.address}:${id} proof:bound`), /proof:bound$/);
    assert.equal((await (await post('/api/login', { ...proof, agent: id })).json()).error, 'proof_replayed');

    const there = await post('/api/login', { ...bound(key, 'login', LOOK_ALIKE), agent: id });
    assert.equal(there.status, 401);
    const body = await there.json();
    assert.equal(body.error, 'wrong_audience');
    assert.equal(body.audience_expected, t.base);
    assert.match(body.message, /do not sign for it/);

    const old = await post('/api/login', { ...proveWith(key, 'login'), agent: id });
    assert.equal(old.status, 200);
    assert.equal((await old.json()).proof, 'unbound');
    await logged(`login:${key.address}:${id} proof:unbound`);
  });

  test('over MCP: enrol, sign in and claim take bound proofs and say which kind was used', async () => {
    const anon = await t.connect();
    const key = newKey();
    const e = await anon.call('uain_enrol', {
      name: 'Mcp Binder',
      operator: 'Mcp Labs',
      principles: PRINCIPLES,
      proof: bound(key, 'enrol'),
    });
    assert.equal(e.enrolled, true);
    assert.equal(e.proof, 'bound');
    assert.equal(e.proof_notice, undefined);

    const r = await anon.call('uain_login', { proof: bound(key, 'login'), agent: e.participant.id });
    assert.equal(r.ok, true);
    assert.equal(r.proof, 'bound');
    const wrong = await anon.call('uain_login', { proof: bound(key, 'login', LOOK_ALIKE), agent: e.participant.id });
    assert.equal(wrong.error, 'wrong_audience');
    const old = await anon.call('uain_login', { proof: proveWith(key, 'login'), agent: e.participant.id });
    assert.equal(old.proof, 'unbound');
    assert.match(old.proof_notice, /--audience/);
    await logged(`${key.address}:${e.participant.id} proof:unbound`);

    // A member from before keys, claimed with a bound proof by uain-key.mjs.
    const a = await t.enrol({ name: 'Old Claimer', operator: 'Old Labs' });
    const oldToken = `uain_${randomBytes(24).toString('hex')}`;
    await t.db
      .prepare("UPDATE participants SET member_id = NULL, account_id = 'claimer', token_hash = ? WHERE id = ?")
      .run(hashOf(oldToken), a.id);
    await t.db.prepare('DELETE FROM device_tokens WHERE subject = ?').run(a.id);
    await t.db
      .prepare('DELETE FROM members WHERE NOT EXISTS (SELECT 1 FROM participants WHERE member_id = members.id)')
      .run();
    await t.db.adoptLegacyMembers();
    const claimed = await client.claim(t.base, newKey(), oldToken);
    assert.equal(claimed.status, 200);
    assert.equal(claimed.body.proof, 'bound');
  });

  test('the audience honours the proxy headers, and UAIN_PUBLIC_ORIGIN pins it', async () => {
    const { key, id } = await enrolled('Proxied');
    const behind = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'uain.example' };
    const via = await post('/api/login', { ...bound(key, 'login', 'https://uain.example'), agent: id }, { headers: behind });
    assert.equal(via.status, 200, 'the origin the descriptor would show');
    const desc = await (await t.http('/api/descriptor', { headers: behind })).json();
    assert.equal(desc.connection.identity.audience, 'https://uain.example');
    assert.match(desc.connection.identity.sign, /--audience https:\/\/uain\.example$/);

    process.env.UAIN_PUBLIC_ORIGIN = 'https://uain.example';
    try {
      // A caller choosing its own Host cannot make a look-alike's proof pass.
      const forged = await post(
        '/api/login',
        { ...bound(key, 'login', LOOK_ALIKE), agent: id },
        { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': new URL(LOOK_ALIKE).host } },
      );
      assert.equal(forged.status, 401);
      assert.equal((await forged.json()).audience_expected, 'https://uain.example');
      const direct = await post('/api/login', { ...bound(key, 'login'), agent: id });
      assert.equal((await direct.json()).error, 'wrong_audience', 'not even the address it listens on');
      const pinned = await post('/api/login', { ...bound(key, 'login', 'https://uain.example'), agent: id });
      assert.equal(pinned.status, 200);
      const d = await (await t.connect()).call('uain_describe');
      assert.match(d.identity.proofs, /reached at https:\/\/uain\.example/);
    } finally {
      delete process.env.UAIN_PUBLIC_ORIGIN;
    }
  });
});

describe('sessions end', () => {
  test('a session unused past the idle limit ends, says so, and the key signs in again', async () => {
    const { key, id, token } = await enrolled('Idle One');
    const me = await t.connect(token);
    assert.equal((await me.call('uain_whoami')).authenticated, true);

    await setLastUsed(token, daysAgo(31));
    const who = await me.call('uain_whoami');
    assert.equal(who.authenticated, false);
    assert.equal(who.error, 'session_expired');
    const acted = await me.call('uain_balance');
    assert.equal(acted.error, 'session_expired');
    assert.match(acted.message, /uain_login/);
    const http = await t.http('/api/next', { headers: { authorization: `Bearer ${token}` } });
    assert.equal(http.status, 401);
    assert.equal((await http.json()).error, 'session_expired');

    const again = await post('/api/login', { ...bound(key, 'login'), agent: id });
    const fresh = (await again.json()).session_token;
    assert.equal((await (await t.connect(fresh)).call('uain_whoami')).participant.id, id);
    assert.equal((await me.call('uain_whoami')).error, 'session_expired', 'the old one stays ended');
  });

  test('a session used within the limit, or never used since it was issued, keeps working', async () => {
    const { token } = await enrolled('Idle Two');
    await setLastUsed(token, daysAgo(29));
    const me = await t.connect(token);
    assert.equal((await me.call('uain_whoami')).authenticated, true);
    assert.ok(Date.parse(await lastUsed(token)) > Date.now() - 60_000, 'its use is noted');

    // As every session issued before this change and not used since.
    await setLastUsed(token, null);
    assert.equal((await me.call('uain_whoami')).authenticated, true);
    assert.ok(await lastUsed(token), 'the first use sets it');
  });

  test('last use is written at most once an hour', async () => {
    const { token } = await enrolled('Idle Three');
    const me = await t.connect(token);
    const recent = new Date(Date.now() - 30 * 60_000).toISOString();
    await setLastUsed(token, recent);
    await me.call('uain_whoami');
    await me.call('uain_balance');
    assert.equal(await lastUsed(token), recent, 'no write within the hour');
    const earlier = new Date(Date.now() - 2 * 3600_000).toISOString();
    await setLastUsed(token, earlier);
    await me.call('uain_whoami');
    assert.ok((await lastUsed(token)) > earlier, 'written once the hour has passed');
  });

  test('uain_logout ends the session it is called with, and no other', async () => {
    const { key, id, token } = await enrolled('Leaver');
    const second = (await (await post('/api/login', { ...bound(key, 'login'), agent: id })).json()).session_token;
    const tools = (await (await t.connect()).client.listTools()).tools.map((x) => x.name);
    assert.ok(tools.includes('uain_logout'));

    const me = await t.connect(token);
    const out = await me.call('uain_logout');
    assert.equal(out.logged_out, true);
    assert.equal(out.participant, id);
    assert.equal((await me.call('uain_whoami')).authenticated, false);
    assert.equal((await me.call('uain_logout')).error, 'not_authenticated');
    const other = await t.connect(second);
    assert.equal((await other.call('uain_whoami')).participant.id, id, 'its other session carries on');
    const member = await (await t.http(`/api/members/${key.address}`)).json();
    assert.equal(member.licence.status, 'active', 'and so does the member');
    assert.equal(member.agents[0].state, 'negotiating');
  });

  test('POST /api/logout does the same over HTTP', async () => {
    const { token } = await enrolled('Http Leaver');
    const none = await post('/api/logout', {});
    assert.equal(none.status, 401);
    const out = await post('/api/logout', {}, { token });
    assert.equal(out.status, 200);
    assert.equal((await out.json()).logged_out, true);
    const after = await t.http('/api/next', { headers: { authorization: `Bearer ${token}` } });
    assert.equal(after.status, 401);
    assert.equal((await after.json()).error, 'not_authenticated');
    const desc = await (await t.http('/api/descriptor')).json();
    assert.match(desc.connection.fallback_http.logout, /POST .*\/api\/logout$/);
  });
});

/**
 * A joined AI system adds to or refreshes its profile after enrolment
 * (uain_profile_update, POST /api/profile): the fields its agent declared,
 * and the member's own about text. Checked as enrolment checks them, only
 * what is sent changes, each update is on the ledger, and nothing that makes
 * up identity or standing can change this way.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { boot, newKey, proveWith } from './helpers.mjs';

const LIMIT = 5;
let t;
before(async () => {
  t = await boot({ UAIN_RATE_PROFILE_UPDATES_PER_HOUR: String(LIMIT) });
});
after(async () => {
  await t.close();
});

const PRINCIPLES = ['voluntary', 'verifiable', 'authority', 'benevolent'];

const record = async (id) => (await t.http(`/api/directory/${id}`)).json();
const memberRecord = async (address) => (await t.http(`/api/members/${address}`)).json();
const lastEntry = async (actor) =>
  (await t.db.prepare('SELECT * FROM events WHERE actor = ? ORDER BY id DESC LIMIT 1').get(actor));
const postProfile = (token, body) =>
  t.http('/api/profile', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

/** A member enrolled with a declaration, over MCP, and a client acting as it. */
async function declared(name, extra = {}) {
  const anon = await t.connect();
  const key = newKey();
  const r = await anon.call('uain_enrol', {
    name,
    operator: `${name} Labs`,
    model: 'model-1',
    region: 'as-east',
    protocols: ['MCP'],
    capabilities: ['protein folding'],
    offers: ['literature review'],
    requests: ['GPU hours'],
    limits: { contextTokens: 200000, autonomy: 'observe' },
    principles: PRINCIPLES,
    proof: proveWith(key, 'enrol'),
    ...extra,
  });
  assert.ok(r.session_token, JSON.stringify(r));
  const me = await t.connect(r.session_token);
  return { id: r.participant.id, token: r.session_token, key, address: key.address, ...me };
}

describe('updating a profile', () => {
  test('only the fields sent change, and the server works out the rest again', async () => {
    const a = await declared('Heron');
    const before = await record(a.id);
    const r = await a.call('uain_profile_update', {
      region: 'eu-west',
      capabilities: ['protein folding', 'docking'],
      limits: { autonomy: 'propose' },
    });
    assert.equal(r.updated, true, JSON.stringify(r));
    assert.deepEqual(r.changed, ['region', 'capabilities', 'limits']);
    assert.equal(r.status, 'declared, not verified');
    assert.match(r.declared, /not verified/);
    assert.equal(typeof r.ledger_event, 'number');

    const after_ = await record(a.id);
    assert.equal(after_.region, 'eu-west');
    assert.equal(after_.placed, true);
    assert.notDeepEqual([after_.lon, after_.lat], [before.lon, before.lat]);
    assert.deepEqual(after_.capabilities, ['protein folding', 'docking']);
    // limits is replaced whole: the context size it no longer sends is gone.
    assert.deepEqual(after_.limits, { autonomy: 'propose' });
    // Untouched fields stay as enrolled.
    assert.equal(after_.model, 'model-1');
    assert.deepEqual(after_.protocols, ['MCP']);
    assert.deepEqual(after_.offers, ['literature review']);
    assert.deepEqual(after_.requests, ['GPU hours']);
    // Nor does anything that is not declared.
    for (const f of ['name', 'operator', 'tier', 'karma', 'credits', 'state', 'enrolled_at', 'did'])
      assert.deepEqual(after_[f], before[f], f);
    assert.match(after_.declared, /not verified/);
  });

  test('offers re-derive the resource classes, and an empty list or string clears', async () => {
    const a = await declared('Plover');
    assert.deepEqual((await record(a.id)).resources, ['intelligence']);
    let r = await a.call('uain_profile_update', { offers: ['GPU compute', 'grant funding'] });
    assert.deepEqual(r.profile.resources, ['compute', 'financial']);
    assert.deepEqual((await record(a.id)).resources, ['compute', 'financial']);

    r = await a.call('uain_profile_update', { offers: [], requests: [], model: '' });
    assert.deepEqual(r.changed, ['model', 'offers', 'requests']);
    const now = await record(a.id);
    assert.deepEqual(now.offers, []);
    assert.deepEqual(now.requests, []);
    assert.deepEqual(now.resources, []);
    assert.equal(now.model, null);
    // Leaving the region unstated takes the system off the map.
    await a.call('uain_profile_update', { region: 'unstated' });
    assert.equal((await record(a.id)).placed, false);
  });

  test('sending what is already on record changes nothing and records nothing', async () => {
    const a = await declared('Avocet');
    const last = (await lastEntry(a.id)).id;
    const r = await a.call('uain_profile_update', { model: 'model-1', protocols: ['MCP'] });
    assert.equal(r.updated, false, JSON.stringify(r));
    assert.deepEqual(r.changed, []);
    assert.equal((await lastEntry(a.id)).id, last);
  });
});

describe('the member’s about text', () => {
  test('any agent of the member sets it, and every agent and the member show it', async () => {
    const a = await declared('Godwit');
    const b = await t.instance(a.key, 'Godwit Labs', 'godwit-two');
    const about = 'Godwit is a research system for coastal ecology. Send it bounded questions.';
    const r = await b.call('uain_profile_update', { about });
    assert.equal(r.updated, true, JSON.stringify(r));
    assert.deepEqual(r.changed, ['about']);
    assert.equal(r.member.about, about);

    const m = await memberRecord(a.address);
    assert.equal(m.about, about);
    assert.match(m.declared, /about/);
    for (const id of [a.id, b.id]) assert.equal((await record(id)).member.about, about);
    const dir = await (await t.http('/api/directory?q=godwit&page_size=50')).json();
    assert.match(dir.declared, /not verified/);
    const rows = dir.participants.filter((p) => p.member?.address === a.address);
    assert.equal(rows.length, 2);
    for (const p of rows) assert.equal(p.member.about, about);
    // The agent's own record was not touched by a member-level change.
    assert.equal((await record(b.id)).model, null);

    // Whoever wrote it, the other agent may replace or clear it.
    await a.call('uain_profile_update', { about: '  ' });
    assert.equal((await memberRecord(a.address)).about, null);
    await a.call('uain_profile_update', { about: 'Rewritten.' });
    assert.equal((await memberRecord(a.address)).about, 'Rewritten.');
    await a.call('uain_profile_update', { about: '' });
    assert.equal((await memberRecord(a.address)).about, null);
  });

  test('about is at most 2,000 characters', async () => {
    const a = await declared('Knot');
    const long = await a.call('uain_profile_update', { about: 'x'.repeat(2001) });
    assert.notEqual(long.updated, true);
    assert.equal((await memberRecord(a.address)).about, null);
    const fits = await a.call('uain_profile_update', { about: 'x'.repeat(2000) });
    assert.equal(fits.updated, true, JSON.stringify(fits));
    assert.equal((await memberRecord(a.address)).about.length, 2000);
  });

  test('a purged last agent of a revoked member takes the about text with it', async () => {
    const a = await declared('Dunlin');
    await a.call('uain_profile_update', { about: 'Dunlin describes itself.' });
    await t.db.revokeLicence(a.address, 'test');
    const r = await maintain('purge-participant', a.id);
    assert.equal(r.code, 0, r.out + r.err);
    const row = await t.db.prepare('SELECT state, about FROM members WHERE id = ?').get(a.address);
    assert.equal(row.state, 'revoked');
    assert.equal(row.about, null);
  });
});

describe('what cannot change, and what is refused', () => {
  test('identity and standing are not fields of an update', async () => {
    const a = await declared('Sanderling');
    // Over MCP, fields outside the schema never reach the server.
    const r = await a.call('uain_profile_update', { name: 'Impostor', operator: 'Someone Else', tier: 'T3' });
    assert.equal(r.error, 'nothing_to_update', JSON.stringify(r));
    // Over HTTP they are refused by name, and nothing else in the body lands.
    const h = await postProfile(a.token, { name: 'Impostor', karma: 1000, capabilities: ['x'] });
    assert.equal(h.status, 422);
    const body = await h.json();
    assert.equal(body.error, 'invalid_fields');
    assert.deepEqual(body.not_changeable.sort(), ['karma', 'name']);
    const now = await record(a.id);
    assert.equal(now.name, 'Sanderling');
    assert.equal(now.operator, 'Sanderling Labs');
    assert.equal(now.karma, 0);
    assert.deepEqual(now.capabilities, ['protein folding']);
    // The tool does not even offer them.
    const { tools } = await a.client.listTools();
    const shape = tools.find((x) => x.name === 'uain_profile_update').inputSchema.properties;
    for (const f of ['name', 'operator', 'member_name', 'principles', 'proof', 'tier', 'karma'])
      assert.equal(shape[f], undefined, f);
    for (const f of ['model', 'endpoint', 'reachability', 'region', 'protocols', 'capabilities', 'offers', 'requests', 'limits', 'about'])
      assert.ok(shape[f], f);
    assert.equal(shape.about.maxLength, 2000);
  });

  test('values are checked exactly as enrolment checks them', async () => {
    const a = await declared('Turnstone');
    for (const bad of [
      { region: 'mars' },
      { reachability: 'telepathy' },
      { capabilities: Array.from({ length: 51 }, (_, i) => `c${i}`) },
      { offers: ['x'.repeat(101)] },
      { protocols: [''] },
      { model: 'm'.repeat(201) },
      { endpoint: 'e'.repeat(501) },
      { limits: { autonomy: 'unbounded' } },
    ]) {
      const r = await a.call('uain_profile_update', bad);
      assert.notEqual(r.updated, true, JSON.stringify(bad));
      const h = await postProfile(a.token, bad);
      assert.equal(h.status, 422, JSON.stringify(bad));
      assert.ok((await h.json()).problems.length > 0);
      // Enrolment refuses the same value.
      const anon = await t.connect();
      const e = await anon.call('uain_enrol', {
        name: 'Refused',
        operator: 'Refused Labs',
        principles: PRINCIPLES,
        proof: proveWith(newKey(), 'enrol'),
        ...bad,
      });
      assert.notEqual(e.enrolled, true, JSON.stringify(bad));
    }
    const unchanged = await record(a.id);
    assert.equal(unchanged.region, 'as-east');
    assert.equal(unchanged.reachability, 'agent');
    assert.deepEqual(unchanged.limits, { contextTokens: 200000, autonomy: 'observe' });
  });

  test('an update needs a session, and a withdrawn agent has none', async () => {
    const anon = await t.connect();
    const r = await anon.call('uain_profile_update', { model: 'x' });
    assert.equal(r.error, 'not_authenticated', JSON.stringify(r));
    assert.equal((await postProfile(null, { model: 'x' })).status, 401);

    const a = await declared('Stint');
    await a.call('uain_withdraw');
    assert.equal((await a.call('uain_profile_update', { model: 'x' })).error, 'not_authenticated');
    assert.equal((await postProfile(a.token, { model: 'x' })).status, 401);
    // Checked again under the write lock, for an agent that withdrew mid-call.
    assert.deepEqual(await t.db.updateProfile({ participant: a.id, changes: { model: 'x' } }), {
      error: 'not_acting',
    });
  });

  test('an empty update is refused without spending the allowance', async () => {
    const a = await declared('Ruff');
    assert.equal((await a.call('uain_profile_update', {})).error, 'nothing_to_update');
    const h = await postProfile(a.token, {});
    assert.equal(h.status, 422);
    assert.equal((await h.json()).error, 'nothing_to_update');
  });
});

describe('the record of updates', () => {
  test('each update is a ledger entry naming the fields that changed, not their values', async () => {
    const a = await declared('Curlew');
    await a.call('uain_profile_update', { capabilities: ['tidal models'], endpoint: 'https://curlew.example/mcp' });
    let e = await lastEntry(a.id);
    assert.equal(e.kind, 'join');
    assert.equal(e.summary, 'Curlew updated its declared profile, not verified: endpoint, capabilities');
    assert.doesNotMatch(e.summary, /tidal|curlew\.example/);

    await a.call('uain_profile_update', { about: 'Curlew models tides.' });
    e = await lastEntry(a.id);
    assert.match(e.summary, /^Curlew set the about text of its member .* \(uain1[0-9a-f]{40}\), declared, not verified$/);
    assert.doesNotMatch(e.summary, /models tides/);

    await a.call('uain_profile_update', { region: 'oceania', about: '' });
    e = await lastEntry(a.id);
    assert.match(e.summary, /^Curlew updated its declared profile, not verified: region; and cleared the about text of its member /);
    // The ledger still verifies: an update commits no record the verifier cannot find.
    assert.equal(e.commits, null);
  });

  test('over HTTP it is the same update', async () => {
    const a = await declared('Whimbrel');
    const h = await postProfile(a.token, { requests: ['sensor data'], about: 'Whimbrel, over HTTP.' });
    assert.equal(h.status, 200);
    const r = await h.json();
    assert.deepEqual(r.changed, ['requests', 'about']);
    assert.equal(r.status, 'declared, not verified');
    assert.deepEqual((await record(a.id)).requests, ['sensor data']);
    assert.equal((await memberRecord(a.address)).about, 'Whimbrel, over HTTP.');
    const d = await (await t.http('/api/descriptor')).json();
    assert.match(d.connection.fallback_http.profile_update, /POST .*\/api\/profile$/);
  });

  test(`at most ${LIMIT} updates an hour for one agent, counted per agent`, async () => {
    const a = await declared('Phalarope');
    for (let i = 0; i < LIMIT; i += 1) {
      const r = await a.call('uain_profile_update', { model: `model-${i + 2}` });
      assert.equal(r.updated, true, JSON.stringify(r));
    }
    const over = await a.call('uain_profile_update', { model: 'one-too-many' });
    assert.equal(over.error, 'rate_limited', JSON.stringify(over));
    assert.ok(over.retry_after_seconds > 0);
    const h = await postProfile(a.token, { model: 'one-too-many' });
    assert.equal(h.status, 429);
    assert.ok(Number(h.headers.get('retry-after')) > 0);
    assert.equal((await record(a.id)).model, `model-${LIMIT + 1}`);
    // Another agent of the same member, from the same computer, has its own.
    const b = await t.instance(a.key, 'Phalarope Labs', 'phalarope-two');
    assert.equal((await b.call('uain_profile_update', { model: 'b' })).updated, true);
  });
});

describe('where it is described', () => {
  test('uain_describe and the enrolment schema point to it', async () => {
    const anon = await t.connect();
    const d = await anon.call('uain_describe');
    assert.ok(d.identity.how_to_join.some((x) => /uain_profile_update/.test(x)));
    assert.match(d.identity.profile, /declared, not verified/);
    // Enrolment still describes its declared fields, from the shared schemas.
    const { tools } = await anon.client.listTools();
    const enrol = tools.find((x) => x.name === 'uain_enrol').inputSchema;
    assert.match(enrol.properties.region.description, /Coarse region/);
    assert.equal(enrol.properties.region.default, 'unstated');
    assert.equal(enrol.properties.reachability.default, 'agent');
    assert.match(enrol.properties.limits.description, /does not yet enforce/);
    assert.deepEqual(enrol.required.sort(), ['name', 'operator', 'principles', 'proof']);
  });

  test('an agent that enrols again to change its details is pointed to it', async () => {
    const a = await declared('Killdeer');
    const again = await a.call('uain_enrol', {
      name: 'Killdeer',
      operator: 'Killdeer Labs',
      capabilities: ['something new'],
      principles: PRINCIPLES,
      proof: proveWith(newKey(), 'enrol'),
    });
    assert.equal(again.already_a_member, true, JSON.stringify(again));
    assert.match(again.message, /uain_profile_update/);
  });

  test('a participant read over MCP carries the member’s about, labelled declared', async () => {
    const a = await declared('Snipe');
    await a.call('uain_profile_update', { about: 'Snipe, briefly.' });
    const anon = await t.connect();
    const p = await anon.call('uain_participant', { id: a.id });
    assert.equal(p.member.about, 'Snipe, briefly.');
    assert.match(p.declared, /not verified/);
  });
});

const MAINTENANCE = fileURLToPath(new URL('../dist/src/application/maintenance.js', import.meta.url));

/** Run an operator action, as .github/workflows/maintenance.yml does. */
function maintain(action, participant) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAINTENANCE], {
      env: { ...process.env, ACTION: action, PARTICIPANT: participant },
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

// Baseline 06a-5 (13 November 2026): the routes and MCP tools that start a
// native proof process had no per-caller budget, and an MCP batch of 16
// counted as one request. Each proof-starting call now counts on its own.
//
// Review follow-ups (13 November 2026): two per-address budgets. State and
// receipt reads (no member named) keep 30 a minute; research publications,
// which one address may carry for many members (BAINK's server; hosted MCP
// clients behind one egress address), have their own 120. There is no
// per-member budget: signed envelopes are public, so anyone could replay a
// member's own envelope to spend it. A publication's envelope shape,
// signature and operation are checked before any proof process starts.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { boot } from './helpers.mjs';

let t, canonical;
before(async () => {
  t = await boot({ UAIN_RATE_PROOFS_PER_MIN: '5', UAIN_RATE_PUBLICATIONS_PER_MIN: '25' });
  ({ canonical } = await import('../dist/src/native/evidence.js'));
});
after(async () => { await t.close(); });

const post = (path, headers = {}) => t.http(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"keys":[]}' });

/** A member's key, as a native client makes it. */
function memberKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { privateKey, public_key: raw.toString('base64url'), member: 'uain1' + createHash('sha256').update(raw).digest('hex').slice(0, 40) };
}
/** A command signed by `key` (the client's signing bytes), or with a forged signature. */
function signed(key, n = 1, forged = false, operation = 'submit') {
  const command = { version: 1, chain_id: 'fixture', member: key.member, sequence: String(n), expires_height: '100', operation, payload: { evidence_digest: 'd'.repeat(64), id: 'C-' + n, task: 'T-1' } };
  const fields = ['version', 'chain_id', 'member', 'sequence', 'expires_height', 'operation', 'payload'];
  const bytes = Buffer.from('uain:chain-command:v1\n{' + fields.map((f) => canonical(f) + ':' + canonical(command[f])).join(',') + '}');
  const signature = forged ? Buffer.alloc(64, 7).toString('base64url') : sign(null, bytes, key.privateKey).toString('base64url');
  return { command, public_key: key.public_key, signature };
}

test('the defaults are 30 state/receipt proofs and 120 publications a minute per address, and no member budget', async () => {
  const env = { ...process.env };
  for (const k of ['UAIN_RATE_PROOFS_PER_MIN', 'UAIN_RATE_PUBLICATIONS_PER_MIN']) delete env[k];
  const module = fileURLToPath(new URL('../dist/src/storage/ratelimit.js', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(module)}); const r = m.RATE_LIMITS; console.log(r.proofs.limit, r.publications.limit, 'proof_members' in r); process.exit(0);`], { env });
  assert.equal(stdout.trim(), '30 120 false');
});

// The evidence route, driven with the server's own gate. No native authority is
// configured, so an admitted publication fails later, in the publication work:
// the audit line tells an admitted request from one refused at the gate.
async function withNativeConfig(fn) {
  const saved = { ...process.env };
  Object.assign(process.env, {
    UAIN_NATIVE_PROJECTION: '1', UAIN_NATIVE_STATE_BINARY: '/nonexistent/uain-state', UAIN_NATIVE_STATE_SHA256: 'a'.repeat(64),
    UAIN_NATIVE_GENESIS: '/nonexistent/genesis.json', UAIN_NATIVE_GENESIS_SHA256: 'b'.repeat(64), UAIN_NATIVE_RPC: 'http://127.0.0.1:1/',
  });
  try { return await fn(); } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}
/** 'admitted', 'invalid' or 'limited' for one publication from `address`. */
async function publish(envelope, address) {
  const { handleNativePublications } = await import('../dist/src/api/native-publication-routes.js');
  const { nativeEvidenceGate } = await import('../dist/src/api/server.js');
  let status;
  const details = [];
  const res = { headersSent: false, setHeader() {}, writeHead(s) { status = s; this.headersSent = true; }, end() {} };
  await handleNativePublications({ method: 'POST' }, res, new URL('http://x/api/native/evidence'), (_r, s) => { status = s; },
    (s, detail) => details.push(detail), async () => ({ body: {}, envelope, event_id: '1' }), nativeEvidenceGate(res, address));
  if (status === 429) return 'limited';
  if (details.includes('native envelope invalid')) { assert.equal(status, 503); return 'invalid'; }
  assert.equal(status, 503);
  return 'admitted';
}

test('state and receipt are refused after their budget while publications from that address still pass', () => withNativeConfig(async () => {
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await post(i % 2 ? '/api/native/receipt' : '/api/native/state')).status);
  assert.deepEqual(statuses.map((s) => s === 429), [false, false, false, false, false, true], JSON.stringify(statuses));
  const refused = await post('/api/native/state');
  assert.match(refused.headers.get('retry-after') ?? '', /^\d+$/);
  assert.equal((await refused.json()).error, 'rate_limited');
  // The same address, as the server keys it, still publishes.
  assert.equal(await publish(signed(memberKey()), t.db.hashCaller('127.0.0.1')), 'admitted');
  assert.notEqual((await t.http('/api/health')).status, 429);
}));

test('junk and replayed envelopes naming a victim cost only the sender\'s address; the victim still publishes', () => withNativeConfig(async () => {
  const victim = memberKey();
  const own = signed(victim, 1);
  const junk = [];
  for (let n = 0; n < 6; n++) junk.push(await publish(n % 2 ? signed(victim, n, true) : { public_key: victim.public_key }, 'fixture-attacker'));
  assert.deepEqual([...new Set(junk)], ['invalid'], JSON.stringify(junk));
  // A replay of the victim's own public, validly signed envelope passes the
  // cheap checks and fails later, in the publication work.
  const replays = [];
  for (let n = 0; n < 12; n++) replays.push(await publish(own, 'fixture-attacker'));
  assert.deepEqual([...new Set(replays)], ['admitted'], JSON.stringify(replays));
  for (let n = 0; n < 13; n++) assert.equal(await publish(own, 'fixture-victim'), 'admitted', `victim ${n}`);
  // The attacker used 18 of its 25: 7 more, then refused.
  const more = [];
  for (let n = 0; n < 8; n++) more.push(await publish(own, 'fixture-attacker'));
  assert.deepEqual(more.map((r) => r === 'limited'), [false, false, false, false, false, false, false, true]);
}));

test('a validly signed command that is not a submission is refused before any proof', () => withNativeConfig(async () => {
  assert.equal(await publish(signed(memberKey(), 1, false, 'transfer'), 'fixture-operation'), 'invalid');
}));

test('20 members publishing through one address are admitted up to the address budget', () => withNativeConfig(async () => {
  const many = [];
  for (let i = 0; i < 26; i++) many.push(await publish(signed(memberKey(), i), 'fixture-shared-address'));
  assert.deepEqual([...new Set(many.slice(0, 25))], ['admitted'], JSON.stringify(many));
  assert.equal(many[25], 'limited');
}));

test('MCP: the same two budgets, per call; a replayed envelope never refuses its member elsewhere', async () => {
  const { registerNativeTools } = await import('../dist/src/api/native-tools.js');
  const { hit } = await import('../dist/src/storage/ratelimit.js');
  const toolsFor = (caller) => {
    const tools = new Map();
    registerNativeTools({ registerTool: (name, _spec, handler) => tools.set(name, handler) }, {
      text: (v) => v, audit: () => {},
      budget: () => hit('proofs', caller),
      publicationBudget: () => hit('publications', caller),
    });
    return tools;
  };
  const attacker = toolsFor('fixture-mcp-attacker'), victimSide = toolsFor('fixture-mcp-victim');
  const research = (tools, envelope) => tools.get('uain_publish_research')({ envelope, event_id: '1', body: {} });
  const own = signed(memberKey(), 1);
  for (let n = 0; n < 25; n++) assert.notEqual((await research(attacker, n % 2 ? own : { public_key: own.public_key })).error, 'rate_limited', `attacker ${n}`);
  const refused = await research(attacker, own);
  assert.equal(refused.error, 'rate_limited', JSON.stringify(refused));
  assert.match(String(refused.retry_after_seconds), /^\d+$/);
  for (let n = 0; n < 13; n++) assert.notEqual((await research(victimSide, own)).error, 'rate_limited', `victim ${n}`);
  // State and receipt have their own budget of 5, unaffected by publications.
  const states = [];
  for (let i = 0; i < 6; i++) states.push((await attacker.get('uain_native_state')({ member: 'uain1' + '0'.repeat(40) })).error === 'rate_limited');
  assert.deepEqual(states, [false, false, false, false, false, true]);
  assert.equal((await attacker.get('uain_native_receipt')({ envelope: {}, event_id: '1' })).error, 'rate_limited');
  assert.notEqual((await attacker.get('uain_guide')({})).error, 'rate_limited');
});

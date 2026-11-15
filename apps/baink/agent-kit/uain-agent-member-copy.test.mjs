// uain-agent 0.2.12: what a member is told. Fixture level: the kit against a
// stubbed BAINK (no network, no real payment). The security findings named here
// are from docs/security/review-2026-11-10.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import * as kit from './uain-agent.mjs';

const sha = (v) => createHash('sha256').update(v).digest('hex');
const OTHER = 'uain1' + 'b'.repeat(40);
async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), 'uain-agent-copy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
/** A stub BAINK for an active member: `routes` maps a path to a body (or a function of the URL). */
function stub(o, routes, calls = []) {
  o.fetch = async (url, init = {}) => {
    const u = new URL(url); calls.push(`${init.method ?? 'GET'} ${u.pathname}`);
    const base = { '/api/account': { account: { native: { memberStatus: 'active' } } }, '/api/native/central/status': { licence: 'active', awards: [], earnings: { total: '0' }, balanceUnits: '0' },
      '/api/trade/enquiries': { enquiries: [] }, '/api/trade/deals': { deals: [] }, '/api/native/central/tasks': { tasks: [], more: false }, '/api/native/sends': { sends: [] }, '/api/native/payments': { intents: [] } };
    const hit = routes[u.pathname] ?? base[u.pathname];
    if (hit === undefined) return json({ error: { code: 'not_found', message: 'not found' } }, 404);
    return json(typeof hit === 'function' ? hit(u, init) : hit);
  };
  return calls;
}
const address = async (o) => JSON.parse(await readFile(join(o.home, 'default', 'identity.json'), 'utf8')).address;

test('next tells a payee to confirm a payment that has arrived, before tasks or Trade (C4, ported from the unmerged kit 0.2.8 fix)', async (t) => {
  const o = { home: await home(t), url: 'http://127.0.0.1:9' };
  await kit.ops.init(o);
  const me = await address(o), sendId = 'a'.repeat(64);
  const calls = stub(o, { '/api/native/sends': { sends: [
    { id: sendId, status: 'finalized', paid: false, intent: { from: OTHER, to: me, amountUnits: '3000000', requestId: null }, recipientConfirmation: null },
    { id: 'c'.repeat(64), status: 'finalized', paid: true, intent: { from: OTHER, to: me, amountUnits: '1000000' }, recipientConfirmation: { at: 'x' } },
  ] }, '/api/native/central/tasks': { tasks: [{ id: 'T-open', project: 'P-one', solver_amount: '1000000', state: 'open', claimable: true, why_not: null }], more: false } });
  const r = await kit.ops.next(o);
  assert.equal(r.stage, 'payment_arrived');
  assert.equal(r.next.tool, 'baink_agent_payment_received');
  assert.deepEqual(r.next.args, { send: sendId });
  assert.equal(r.next.cli, `uain-agent received ${sendId}`);
  assert.match(r.next.why, /3 AI\$/); assert.match(r.next.why, /Confirm you received it/);
  assert.equal(r.morePaymentsToConfirm, undefined, 'a payment already confirmed is not repeated');
  assert.ok(calls.every((c) => c.startsWith('GET ')), 'next only reads');
  assert.equal(calls.filter((c) => c === 'GET /api/native/sends').length, 1, 'the payment list is read once');
});

test('a refund already paid is never offered for payment again, and an arrived refund is confirmed by the buyer (C4)', async (t) => {
  const o = { home: await home(t), url: 'http://127.0.0.1:9' };
  await kit.ops.init(o);
  const me = await address(o), dealId = '77777777-7777-4777-8777-777777777777', req = '66666666-6666-4666-8666-666666666666';
  let seller = me, sends = [];
  stub(o, {
    '/api/trade/deals': () => ({ deals: [{ id: dealId, status: 'refunded', seller, buyer: seller === me ? OTHER : me, title: 'Refund once', price: '3.000000', enquiryId: 'e1' }] }),
    [`/api/trade/deals/${dealId}`]: () => ({ deal: { id: dealId, refunds: [{ id: 'f1', request: { id: req, status: 'open', to: seller, from: seller === me ? OTHER : me, amount: '3.000000' } }] } }),
    '/api/native/sends': () => ({ sends }),
  });
  let r = await kit.tradeAttention(o, me);
  assert.match(r.mine[0].cli, /pay --request/, 'with no payment yet, the seller is told to pay the refund');
  sends = [{ id: 'S-refund', status: 'finalized', paid: false, recipientConfirmation: null, intent: { requestId: req, from: me, to: OTHER, amountUnits: '3000000' } }];
  r = await kit.tradeAttention(o, me);
  assert.deepEqual(r.mine, [], 'a landed, unconfirmed refund is not offered for payment again');
  assert.match(r.others[0].what, /Do not pay again/);
  sends = [{ ...sends[0], status: 'submitted' }];
  r = await kit.tradeAttention(o, me);
  assert.deepEqual(r.mine, []); assert.match(r.others[0].what, /on its way/);
  // The buyer's side: the refund arrived, so confirming it is the buyer's step.
  seller = OTHER; sends = [{ id: 'S-refund', status: 'finalized', paid: false, recipientConfirmation: null, intent: { requestId: req, from: OTHER, to: me, amountUnits: '3000000' } }];
  r = await kit.tradeAttention(o, me);
  assert.equal(r.mine.length, 1, 'named once, not also as a loose payment');
  assert.equal(r.mine[0].cli, 'node uain-agent.mjs received S-refund');
});

test('a prepared payment is signed only when this key signed its intent (S5)', async (t) => {
  const o = { home: await home(t) };
  await kit.ops.init(o);
  const identity = await kit.loadIdentity(o), me = identity.address;
  const stored = JSON.parse(await readFile(join(o.home, 'default', 'identity.json'), 'utf8'));
  const intent = { schema: 'baink-send-intent-v1', chainId: 'fictional', genesisSha256: 'a'.repeat(64), from: me, to: OTHER, recipientAddress: 'c'.repeat(86), amountUnits: '1000000000000', nonce: 'd'.repeat(32), notAfter: '2026-11-11T00:00:00.000Z', requestId: null, memo: '' };
  const intentBytes = Buffer.from('BAINK/send-intent/v1\0' + kit.nativeJSON(intent)), id = sha(intentBytes);
  const approval = { reviewer: OTHER, effects: 'e'.repeat(64), purpose_commitment: sha('BAINK/server-send/purpose/v1\0' + id), class: 'neutral', expires_height: '200', licence_revision: '1', signature: 'A'.repeat(86), direction: 'shield', member: me, amount: intent.amountUnits };
  const command = { version: 1, chain_id: 'fictional', member: me, sequence: '4', expires_height: '160', operation: 'coin_shield', payload: { bundle: 'YnVuZGxl', approval } };
  const bytes = kit.commandBytes(command);
  const record = (signature) => ({ id, intent, signature, status: 'awaiting-signature', attempts: [{ n: 1, status: 'awaiting-signature', command, signingBytesBase64: Buffer.from(bytes).toString('base64'), commandDigest: sha(bytes), proofHeight: '100' }] });
  // A record whose intent the member never signed: a made-up signature, none at all, or another key's.
  const stranger = generateKeyPairSync('ed25519');
  for (const forged of ['not-a-signature', undefined, 'A'.repeat(86), sign(null, intentBytes, stranger.privateKey).toString('base64url')])
    await assert.rejects(kit.signPreparedSend(identity, record(forged)), (e) => e.code === 'signing_refused' && /nothing was signed/i.test(e.message));
  // The intent this key really signed is accepted.
  const key = createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', x: stored.public_key, d: stored.private_key }, format: 'jwk' });
  const own = sign(null, intentBytes, key).toString('base64url');
  const signed = await kit.signPreparedSend(identity, record(own));
  assert.equal(signed.attempt, 1); assert.match(signed.signature, /^[A-Za-z0-9_-]{86}$/);
  // The same signature over a changed intent (another amount) is refused.
  const changed = record(own); changed.intent = { ...intent, amountUnits: '5' }; changed.id = sha(Buffer.from('BAINK/send-intent/v1\0' + kit.nativeJSON(changed.intent)));
  await assert.rejects(kit.signPreparedSend(identity, changed), (e) => e.code === 'signing_refused');
});

test('restore refuses a backup of another identity than the one journaled here, also for journals without an address (L2)', async (t) => {
  const root = await home(t), a = { home: root, as: 'first' }, b = { home: root, as: 'second' }, PASS = 'fictional agent passphrase';
  const first = await kit.initIdentity(a), second = await kit.initIdentity(b);
  const backupA = await kit.backupIdentity(a, { passphrase: PASS, iterations: 100000 }), backupB = await kit.backupIdentity(b, { passphrase: PASS, iterations: 100000 });
  // A journal as kits before 0.2.12 wrote it: no address field, only the signed step.
  await writeFile(join(root, 'first', 'journal.json'), JSON.stringify({ version: 1, ids: {}, steps: { x: { intent: 'x', kind: 'central', operation: 'project_join', status: 'finalized', envelope: { command: { member: first.address } } } } }), { mode: 0o600 });
  await rm(first.file);
  await assert.rejects(kit.restoreIdentity(a, { file: backupB.file, passphrase: PASS }), (e) => e.code === 'identity_mismatch' && /Nothing was written/.test(e.message));
  assert.ok(!existsSync(first.file), 'nothing was written');
  assert.equal((await kit.restoreIdentity(a, { file: backupA.file, passphrase: PASS })).address, first.address);
  // A journal written by this kit carries its address.
  await rm(first.file);
  await writeFile(join(root, 'first', 'journal.json'), JSON.stringify({ version: 1, address: first.address, ids: {}, steps: {} }), { mode: 0o600 });
  await assert.rejects(kit.restoreIdentity(a, { file: backupB.file, passphrase: PASS }), (e) => e.code === 'identity_mismatch');
  assert.notEqual(first.address, second.address);
});

test('the backup passphrase never travels as an MCP argument: the kit makes one and saves it to its own file (L3)', async (t) => {
  const o = { home: await home(t) };
  const made = await kit.initIdentity(o);
  const call = (name, args) => kit.handleMcp(o, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }).then((r) => ({ data: JSON.parse(r.result.content[0].text), text: r.result.content[0].text, isError: r.result.isError === true }));
  const tools = Object.fromEntries(kit.MCP_TOOLS.map((x) => [x.name, x]));
  for (const name of ['baink_agent_backup', 'baink_agent_restore']) assert.ok(!Object.hasOwn(tools[name].inputSchema.properties, 'passphrase'), `${name} takes no passphrase argument`);
  // A passphrase put in the call is refused; no backup is written.
  const refused = await call('baink_agent_backup', { passphrase: 'typed into the chat by mistake', confirm: true });
  assert.equal(refused.data.error, 'backup_passphrase_in_chat'); assert.ok(refused.isError); assert.ok(!refused.text.includes('typed into the chat'));
  const before = process.env.UAIN_AGENT_BACKUP_PASSPHRASE; delete process.env.UAIN_AGENT_BACKUP_PASSPHRASE;
  t.after(() => { if (before !== undefined) process.env.UAIN_AGENT_BACKUP_PASSPHRASE = before; });
  const ok = await call('baink_agent_backup', { confirm: true });
  assert.equal(ok.data.backedUp, true); assert.equal(ok.data.address, made.address);
  const secret = (await readFile(ok.data.passphraseFile, 'utf8')).trim();
  assert.ok(secret.length >= 32); assert.equal((await stat(ok.data.passphraseFile)).mode & 0o777, 0o600);
  assert.ok(!ok.text.includes(secret), 'the passphrase is never returned');
  assert.match(ok.data.note, /Move that file somewhere else/);
  // The pair restores the identity: the passphrase is read from its file.
  const restoredTo = { home: o.home, as: 'elsewhere' };
  const restored = await kit.handleMcp(restoredTo, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'baink_agent_restore', arguments: { file: ok.data.file, passphraseFile: ok.data.passphraseFile, confirm: true } } });
  assert.equal(JSON.parse(restored.result.content[0].text).address, made.address);
  // Without a passphrase source a restore says what to do, in plain words.
  const none = await kit.handleMcp({ home: o.home, as: 'third' }, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'baink_agent_restore', arguments: { file: ok.data.file, confirm: true } } });
  const noneData = JSON.parse(none.result.content[0].text);
  assert.equal(noneData.error, 'backup_passphrase_required'); assert.match(noneData.next, /Never ask them to type the passphrase into the chat/);
});

test('history says "review delayed" and why after about 15 minutes, and the usual time otherwise', () => {
  const now = Date.parse('2026-11-10T12:00:00Z'), ago = (m) => new Date(now - m * 60000).toISOString();
  assert.match(kit.reviewWaitText(ago(3), now), /^recorded; waiting for the reviewer \(usually 2 to 10 minutes; up to an hour when many submissions arrive together\)\. Checked 12:00 UTC\.$/);
  assert.match(kit.reviewWaitText(ago(14), now), /^recorded; waiting/);
  const late = kit.reviewWaitText(ago(36), now);
  assert.match(late, /^review delayed: recorded 36 minutes ago/); assert.match(late, /starts at most 16 reviews in each clock hour \(UTC\) and 128 a day/); assert.match(late, /the rest wait for the next hour/); assert.match(late, /do not send it again/);
  assert.doesNotMatch(late, /usually 2 to 10 minutes/);
  assert.match(kit.reviewWaitText(ago(75), now), /longer than that means the reviewer is paused or behind/);
  assert.match(kit.reviewWaitText(ago(200), now), /recorded 3 hours ago/);
  assert.match(kit.reviewWaitText(undefined, now), /^recorded; waiting/, 'an unknown time never claims a delay');
});

test('status says in one line whether the membership is active, and itemises where the AI$ went', async (t) => {
  const o = { home: await home(t), url: 'http://127.0.0.1:9' };
  await kit.ops.init(o);
  const me = await address(o);
  const send = (id, from, to, amountUnits, status, confirmed = false) => ({ id, status, paid: confirmed, recipientConfirmation: confirmed ? { at: 'x' } : null, createdAt: '2026-11-10T01:00:00.000Z', intent: { from, to, amountUnits, requestId: null, memo: 'thanks' } });
  let sends = [send('s1', me, OTHER, '600000', 'finalized', true), send('s2', me, OTHER, '300000', 'finalized'), send('s3', me, OTHER, '5000000', 'checker-refused')];
  let central = { licence: 'active', awards: [], earnings: { total: '100000000' }, balanceUnits: '99100000' };
  stub(o, { '/api/native/central/status': () => central, '/api/native/sends': () => ({ sends }) });
  let s = await kit.ops.status(o);
  assert.equal(s.membershipNote, 'Your UAIN membership is active.');
  assert.equal(s.earnedAI$, '100'); assert.equal(s.balanceAI$, '99.1'); assert.equal(s['paidOutAI$'], '0.9');
  assert.deepEqual(s.paidOut.map((x) => x['amountAI$']), ['0.6', '0.3'], 'each finished payment is listed; a refused one moved nothing');
  assert.equal(s.balanceNote, 'Balance 99.1 AI$ = 100 AI$ earned from tasks, minus 0.9 AI$ you paid to other members (2 payments, listed in paidOut). No fee was taken: payments and Trade carry none.');
  // A gap the payments do not explain is named, never guessed away.
  central = { ...central, balanceUnits: '98000000' };
  s = await kit.ops.status(o);
  assert.match(s.balanceNote, /1\.1 AI\$ more has left the balance than these finished payments explain/);
  // A seller who was paid: the balance stays 0, and the received AI$ is shown with what can be done with it.
  central = { licence: 'active', awards: [], earnings: { total: '0' }, balanceUnits: '0' };
  sends = [send('r1', OTHER, me, '3000000', 'finalized', true), send('r2', OTHER, me, '2000000', 'finalized')];
  s = await kit.ops.status(o);
  assert.equal(s.balanceAI$, '0'); assert.equal(s['receivedAI$'], '5');
  assert.match(s.receivedNote, /^You received 5 AI\$ from other members \(2 payments\); 1 still waits for you to confirm/);
  assert.match(s.receivedNote, /cannot be spent or sent on today: paying from received AI\$ is not built yet\.$/);
  assert.doesNotMatch(s.receivedNote, /soon|will be/i, 'no promise about spending received AI$');
  // The payment list could not be read: say so instead of leaving the gap unexplained.
  central = { licence: 'active', awards: [], earnings: { total: '100000000' }, balanceUnits: '99100000' };
  stub(o, { '/api/native/central/status': () => central, '/api/native/sends': undefined });
  o.fetch = ((inner) => async (url, init) => (new URL(url).pathname === '/api/native/sends' ? json({ error: { code: 'busy', message: 'busy' } }, 500) : inner(url, init)))(o.fetch);
  s = await kit.ops.status(o);
  assert.match(s.balanceNote, /could not be read just now/); assert.equal(s['paidOutAI$'], undefined);
});

test('membership is one plain line at every stage, and enrol ends with it', async (t) => {
  const o = { home: await home(t), url: 'http://127.0.0.1:9' };
  await kit.ops.init(o);
  let account = { account: null };
  stub(o, { '/api/account': () => account, '/api/native/central/status': () => ({ licence: 'inactive' }) });
  o.fetch = ((inner) => async (url, init) => (new URL(url).pathname === '/api/account' && !account.account ? json({ error: { code: 'account_missing', message: 'no account' } }, 404) : inner(url, init)))(o.fetch);
  assert.match((await kit.ops.status(o)).membershipNote, /^Not a member yet: this key has no BAINK profile/);
  account = { account: { native: { memberStatus: 'missing' } } };
  assert.equal((await kit.ops.status(o)).membershipNote, 'Not a member yet. Enrol with baink_agent_enrol.');
  await writeFile(join(o.home, 'default', 'journal.json'), JSON.stringify({ version: 1, ids: {}, steps: { e: { intent: 'e', kind: 'enrol', operation: 'enrol', target: 'x', status: 'finalized', relayed: true } } }), { mode: 0o600 });
  assert.match((await kit.ops.status(o)).membershipNote, /^Your enrolment was sent; the membership is not active yet\. Check again in two minutes/);
  account = { account: { native: { memberStatus: 'unknown' } } };
  assert.match((await kit.ops.status(o)).membershipNote, /could not read your membership just now \(a network problem, not your enrolment\); nothing changed/);
  account = { account: { native: { memberStatus: 'active' } } };
  assert.equal((await kit.ops.status(o)).membershipNote, 'Your UAIN membership is active.');
  // The enrol tool and the kit's own words never say "guardian", "licence pending" or "finalized: false".
  const enrol = kit.MCP_TOOLS.find((x) => x.name === 'baink_agent_enrol');
  assert.match(enrol.description, /one line whether the membership is active/);
  assert.doesNotMatch(enrol.description + kit.MCP_INSTRUCTIONS, /guardian/i);
});

test('a refused step journaled by an older kit is read again, and is settled when BAINK holds no such step (C6, no dead end)', async (t) => {
  const o = { home: await home(t), url: 'http://127.0.0.1:9' };
  await kit.ops.init(o);
  const id = '98248054-0000-4000-8000-000000000000', file = join(o.home, 'default', 'journal.json');
  // Kits before 0.2.12 wrote a relayed-then-refused step like this: status refused, no error, no relayed mark.
  const legacy = () => writeFile(file, JSON.stringify({ version: 1, ids: {}, steps: { [id]: { intent: id, kind: 'central', operation: 'project_join', target: 'join:P-OPP-00004', status: 'refused', payload: { project: 'P-OPP-00004' } } } }), { mode: 0o600 });
  await legacy();
  let reconcile = () => ({ intent: { id, status: 'refused', receiptRequired: true } });
  const calls = stub(o, {});
  o.fetch = ((inner) => async (url, init = {}) => {
    if (new URL(url).pathname === `/api/native/central/intents/${id}/reconcile`) { calls.push('POST reconcile'); const r = reconcile(); return r instanceof Response ? r : json(r); }
    return inner(url, init);
  })(o.fetch);
  // BAINK still counts it: next reads its record and says so; nothing is sent.
  let r = await kit.ops.next(o);
  assert.equal(r.stage, 'step_unsettled'); assert.match(r.next.why, /network refused a step/); assert.equal(r.intent, id);
  assert.ok(calls.includes('POST reconcile'), 'the record was read');
  // BAINK proved it unused: settled.
  reconcile = () => ({ intent: { id, status: 'expired-unused', receiptRequired: false } });
  r = await kit.ops.next(o);
  assert.notEqual(r.stage, 'step_unsettled');
  // BAINK holds no such step at all: settled too, never a dead end.
  await legacy();
  reconcile = () => json({ error: { code: 'central_intent_missing', message: 'No such step.' } }, 404);
  r = await kit.ops.next(o);
  assert.notEqual(r.stage, 'step_unsettled');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).steps[id].status, 'not_received');
  // A refusal BAINK made itself before any relay (older kits marked it with `error`) was never open.
  await writeFile(file, JSON.stringify({ version: 1, ids: {}, steps: { [id]: { intent: id, kind: 'central', operation: 'project_join', target: 'join:P-OPP-00004', status: 'refused', error: 'central_project_inactive', payload: { project: 'P-OPP-00004' } } } }), { mode: 0o600 });
  const before = calls.filter((c) => c === 'POST reconcile').length;
  r = await kit.ops.next(o);
  assert.notEqual(r.stage, 'step_unsettled'); assert.equal(calls.filter((c) => c === 'POST reconcile').length, before, 'nothing to read for it');
});

test('an enrolment the receipt check proved never landed is prepared again under a new request id (fresh-join test, 13 Nov)', async (t) => {
  const o = { home: await home(t), url: 'http://127.0.0.1:9' };
  await kit.ops.init(o);
  const payload = { name: 'fresh', operator: 'Independent', family: '' }, key = kit.plainJSON(payload), ids = [];
  await writeFile(join(o.home, 'default', 'journal.json'), JSON.stringify({ version: 1, ids: { enrol: { payload: key, id: 'old-request-id' } },
    steps: { e: { intent: 'e', kind: 'enrol', operation: 'enrol', target: 'x', status: 'expired_unincluded', relayed: false, retry: true } } }), { mode: 0o600 });
  stub(o, { '/api/config': { nativeRegistration: { enrol: { enabled: true } } },
    '/api/native/enrol/prepare': (u, init) => { ids.push(JSON.parse(init.body).clientRequestId); return { error: 'stop here' }; } });
  o.fetch = ((inner) => async (url, init) => (new URL(url).pathname === '/api/native/enrol/prepare' ? (inner(url, init), json({ error: { code: 'stop', message: 'stop' } }, 409)) : inner(url, init)))(o.fetch);
  await assert.rejects(kit.ops.enrol({ ...o }, { name: 'fresh', operator: 'Independent', wait: 0 }));
  assert.equal(ids.length, 1);
  assert.notEqual(ids[0], 'old-request-id');
  // A plain retry with an unsettled step keeps the same request id, so BAINK answers with that step instead.
  await writeFile(join(o.home, 'default', 'journal.json'), JSON.stringify({ version: 1, ids: { enrol: { payload: key, id: 'kept-id' } },
    steps: { e: { intent: 'e', kind: 'enrol', operation: 'enrol', target: 'x', status: 'unknown', relayed: true } } }), { mode: 0o600 });
  await assert.rejects(kit.ops.enrol({ ...o }, { name: 'fresh', operator: 'Independent', wait: 0 }));
  assert.equal(ids[1], 'kept-id');
});

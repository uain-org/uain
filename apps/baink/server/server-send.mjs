/** No-install sending (design: docs/baink/no-install-send-design-2026-11-09.md).
 *
 * The member signs a send intent in the browser. The server validates and
 * persists it, builds a `coin_shield` entry bundle whose paid output goes to the
 * payee's registered Orchard address (no member spending key exists for an
 * entry), obtains the boundary checker's approval, and asks the browser to sign
 * the exact native command. It then relays the signed bytes and reconciles them
 * to finality or proved non-inclusion. The server holds no member key: without
 * the member's Ed25519 signature on the exact command nothing can be debited.
 *
 * Every step is idempotent by intent id and attempt number. A new attempt is
 * built only after the previous one is proved unincluded, so a reload, a
 * duplicate submit, a restart or a crash mid-send never debits twice. */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { canonicalJSON, chainCommandSigningBytes as signingBytes, coinBoundaryApprovalBytes } from './server-send-crypto.mjs';
import { hasPendingNativeSend } from './native-sequence-fence.mjs';
import { assertRequestUnpaid } from './request-payment-guard.mjs';
import { SEND_INTENT_DOMAIN, SEND_CONFIRM_DOMAIN, RECEIVING_ADDRESS_DOMAIN, RECEIVING_KEY_DOMAIN, SEND_PURPOSE_DOMAIN, SEND_INTENT_FIELDS, sendIntentBytes, sendIntentId, receivingAddressBytes, receivingKeyBytes, sendPurposeCommitment } from './server-send-check.mjs';

const ADDRESS = /^uain1[a-f0-9]{40}$/, HASH = /^[a-f0-9]{64}$/, ORCHARD = /^[a-f0-9]{86}$/, FVK = /^[a-f0-9]{192}$/;
const UNITS = /^[1-9][0-9]{0,18}$/, UINT = /^(0|[1-9][0-9]{0,19})$/, NONCE = /^[a-f0-9]{32}$/, ID = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_UNITS = 9223372036854775807n;
export { SEND_INTENT_DOMAIN, SEND_CONFIRM_DOMAIN, RECEIVING_ADDRESS_DOMAIN, RECEIVING_KEY_DOMAIN, SEND_PURPOSE_DOMAIN, sendIntentBytes, sendIntentId, receivingAddressBytes, receivingKeyBytes, sendPurposeCommitment };
export const SEND_LIMITS = Object.freeze({
  maxNotAfterMs: 24 * 3600 * 1000, // an intent lives at most a day
  activePerPayer: 4,               // non-terminal intents per payer
  acceptedPerDay: 48,              // intents accepted per payer per rolling day
  retainedPerPayer: 512,
  global: 20000,
  activeGlobal: 200,               // in-flight sends across all members (bundles are ~16 KB)
  // Each command expires 120 blocks after its proof: the kit and web sign up to +120. At 60 the
  // window (about 130 s at 2.2 s blocks) was used up by the ~2 min build and custody check on
  // production (10 November 2026: attempts were ready only after they had expired).
  attemptBlocks: 120n,
  rebroadcastMs: 20000,            // identical bytes at most every 20 s
  memoBytes: 200,
  unsignedRecheckMs: 60000,        // how often an unsigned command is checked against a fresh proof
  retainFailedMs: 24 * 3600 * 1000,          // a send that ended without a debit, after its intent expired
  retainFinalizedMs: 30 * 24 * 3600 * 1000,  // a confirmed payment, as the member's history
  pruneEveryMs: 3600 * 1000,
  queuedClaimRetryMs: 30000,       // re-check a held custody claim this often
  // L6 (security review, 13 November 2026): a build that fails before custody waits, doubling
  // from 5 s to at most 5 min, instead of retrying on every tick; the intent's expiry still ends it.
  buildRetryMs: 5000,
  buildRetryMaxMs: 300000,
});
export const SEND_WAITING = Object.freeze({
  earningConfirming: 'Your last earning is still being confirmed. This payment goes through by itself in about a minute.',
  earlierPayment: 'Your previous payment is still going through. This one follows by itself right after.',
});
const TERMINAL = new Set(['finalized', 'expired', 'cancelled', 'checker-refused']);
const sha = value => createHash('sha256').update(value).digest('hex');
const keyObject = raw => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(raw).toString('base64url') }, format: 'jwk' });
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === fields.length && fields.every(k => Object.hasOwn(value, k));

export class ServerSendError extends Error {
  constructor(status, code, message = code) { super(message); this.status = status; this.code = code; }
}
function check(ok, status, code, message) { if (!ok) throw new ServerSendError(status, code, message); }
const proofError = ok => check(ok, 503, 'native_proof_unavailable', 'A fresh pinned native proof is required.');

function memberKey(user) {
  check(ADDRESS.test(user?.address) && typeof user.publicKey === 'string' && user.publicKey.length === 44, 401, 'invalid_native_holder');
  const raw = Buffer.from(user.publicKey, 'base64');
  check(raw.length === 32 && raw.toString('base64') === user.publicKey && 'uain1' + sha(raw).slice(0, 40) === user.address, 401, 'invalid_native_holder');
  return raw;
}
function signature64(value, code) {
  check(typeof value === 'string' && value.length <= 128, 400, code);
  const raw = Buffer.from(value, 'base64url');
  check(raw.length === 64 && raw.toString('base64url') === value, 400, code);
  return raw;
}
export function sendConfirmationBytes(record) {
  return Buffer.from(SEND_CONFIRM_DOMAIN + canonicalJSON({ intentId: record.id, chainId: record.intent.chainId, from: record.intent.from, to: record.intent.to, amountUnits: record.intent.amountUnits, effects: record.result.effects }));
}

const INTENT_FIELDS = SEND_INTENT_FIELDS;
function validIntent(intent) {
  check(exact(intent, INTENT_FIELDS) && intent.schema === 'baink-send-intent-v1', 400, 'invalid_send_intent');
  check(typeof intent.chainId === 'string' && /^[A-Za-z0-9._-]{1,96}$/.test(intent.chainId) && HASH.test(intent.genesisSha256 ?? ''), 400, 'invalid_send_intent');
  check(ADDRESS.test(intent.from) && ADDRESS.test(intent.to) && intent.from !== intent.to, 400, 'invalid_send_intent');
  check(typeof intent.recipientAddress === 'string' && ORCHARD.test(intent.recipientAddress), 400, 'invalid_send_intent');
  check(typeof intent.amountUnits === 'string' && UNITS.test(intent.amountUnits) && BigInt(intent.amountUnits) <= MAX_UNITS, 400, 'invalid_send_intent');
  check(typeof intent.nonce === 'string' && NONCE.test(intent.nonce), 400, 'invalid_send_intent');
  check(typeof intent.notAfter === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(intent.notAfter) && Number.isFinite(Date.parse(intent.notAfter)), 400, 'invalid_send_intent');
  check(intent.requestId === null || typeof intent.requestId === 'string' && ID.test(intent.requestId), 400, 'invalid_send_intent');
  check(typeof intent.memo === 'string' && Buffer.byteLength(intent.memo) <= SEND_LIMITS.memoBytes && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(intent.memo) && intent.memo.isWellFormed(), 400, 'invalid_send_intent');
}
function validApproval(a) {
  return exact(a, ['reviewer', 'effects', 'purpose_commitment', 'class', 'expires_height', 'licence_revision', 'signature', 'direction', 'member', 'amount'])
    && ADDRESS.test(a.reviewer) && HASH.test(a.effects) && HASH.test(a.purpose_commitment) && ['benevolent', 'neutral'].includes(a.class)
    && typeof a.expires_height === 'string' && /^[1-9][0-9]{0,18}$/.test(a.expires_height) && typeof a.licence_revision === 'string' && UINT.test(a.licence_revision)
    && typeof a.signature === 'string' && /^[A-Za-z0-9_-]{86}$/.test(a.signature) && a.direction === 'shield' && ADDRESS.test(a.member) && typeof a.amount === 'string' && UNITS.test(a.amount);
}
/** The exact checks the browser repeats before signing (web/server-send.js). */
export function verifySendCommand(record, command) {
  const intent = record.intent;
  check(exact(command, ['version', 'chain_id', 'member', 'sequence', 'expires_height', 'operation', 'payload']), 409, 'send_command_mismatch');
  check(command.version === 1 && command.chain_id === intent.chainId && command.member === intent.from && command.operation === 'coin_shield' && exact(command.payload, ['bundle', 'approval']), 409, 'send_command_mismatch');
  const a = command.payload.approval;
  check(validApproval(a) && a.member === intent.from && a.amount === intent.amountUnits && a.purpose_commitment === sendPurposeCommitment(record.id) && BigInt(command.expires_height) <= BigInt(a.expires_height), 409, 'send_command_mismatch');
  const bundle = command.payload.bundle;
  check(typeof bundle === 'string' && bundle.length > 0 && bundle.length <= 22000 && Buffer.from(bundle, 'base64url').toString('base64url') === bundle, 409, 'send_command_mismatch');
  return signingBytes(command);
}

/**
 * Dependencies:
 *  store      BAINK group-commit store (transact, read).
 *  native     { configured, pins:{chainId,epoch,verifierSha256}, timeoutMs, publicState(selection,{timeoutMs}), broadcastShield(envelope,{timeoutMs}) }
 *  builder    { build({intentId,attempt,chainId,member,amountUnits,recipientAddress,memo,expiresHeight,licenceRevision,frontier,purposeCommitment}) }
 *             returns {status:'built',bundle,approval} | {status:'queued',retryAt,reason} | {status:'refused',reason}
 *  validateTradeRequest  same as native payments.
 *  addressFromKey  async (fullViewingKey) -> address: the pinned coin wallet's
 *             `address-from-fvk`, for no-install receiving keys. The custody
 *             checker derives the address again before any approval.
 *  clearSequenceFence  async (member) -> boolean: reconcile the member's held
 *             central-earning intents from chain state (sequence-fence-clear.mjs).
 *             Reads only; true when nothing of central earning holds the sequence.
 */
export function createServerSendService({ store, native, builder = null, enabled = false, allowedMembers = null, validateTradeRequest, tradeAvailability = null, now = () => Date.now(), limits = SEND_LIMITS, addressFromKey = null, clearSequenceFence = null }) {
  const ready = () => enabled === true && native?.configured === true && typeof native.broadcastShield === 'function' && typeof builder?.build === 'function';
  // First rollout (N7): only our own test accounts, both as payer and payee.
  const allowed = allowedMembers === null ? null : new Set(allowedMembers);
  if (allowed) check([...allowed].every(a => ADDRESS.test(a)), 500, 'invalid_server_send_configuration');
  const openTo = address => ready() && (allowed === null || allowed.has(address));
  const building = new Set();
  const deriving = new Set(); // members whose receiving key is being derived now
  const rows = state => (state.serverSendIntents ??= {});
  function view(record, user) {
    const result = structuredClone(record);
    result.current = result.attempts.at(-1) ?? null;
    result.role = user?.address === record.intent.from ? 'payer' : 'payee';
    if (result.role === 'payee') { // the payer's unsigned command is not the payee's business
      for (const attempt of result.attempts) { delete attempt.command; delete attempt.signingBytesBase64; delete attempt.envelope; }
    }
    result.paid = record.status === 'finalized' && record.recipientConfirmation !== null;
    return result;
  }
  function owned(user, id, role) {
    memberKey(user);
    check(typeof id === 'string' && HASH.test(id), 404, 'send_intent_missing');
    const record = store.read().serverSendIntents?.[id];
    check(record && [record.intent.from, record.intent.to].includes(user.address), 404, 'send_intent_missing');
    check(!role || (role === 'payer' ? record.intent.from : record.intent.to) === user.address, 403, role === 'payer' ? 'send_payer_required' : 'send_payee_required');
    return record;
  }
  async function proven(selection, deadline = now() + Math.min(30000, native.timeoutMs || 15000)) {
    let context;
    try { context = await native.publicState(selection, { timeoutMs: Math.max(1, deadline - now()) }); } catch { proofError(false); }
    const { proof: p, state: s } = context ?? {}, pins = native.pins;
    const age = now() - Date.parse(p?.headerTime);
    proofError(p?.authority === 'native' && p.chainId === pins.chainId && p.epoch === pins.epoch && p.verifierSha256 === pins.verifierSha256
      && Number.isFinite(age) && age >= -60000 && Number.isInteger(p.maxAgeSeconds) && age < p.maxAgeSeconds * 1000
      && /^[1-9][0-9]{0,18}$/.test(p.height ?? '') && s?.chain_id === p.chainId && s.height === p.height && s.app_hash === p.appHash);
    return context;
  }
  function licensed(member, id) {
    proofError(member?.id === id && typeof member.public_key === 'string');
    check(member.licence === 'active', 409, 'native_licence_inactive', 'Both parties need an active native licence.');
    return member;
  }
  function balanceOf(records, address) {
    const value = records['coin_balance/' + address];
    proofError(value === null || value === undefined || typeof value === 'string' && UINT.test(value));
    return BigInt(value ?? '0');
  }
  function reserved(state, payer, except) {
    return Object.values(rows(state)).filter(r => r.intent.from === payer && r.id !== except && !TERMINAL.has(r.status)).reduce((n, r) => n + BigInt(r.intent.amountUnits), 0n);
  }
  function requestFor(state, intent) {
    if (intent.requestId === null) return null;
    const request = state.requests?.[intent.requestId];
    check(request && request.to === intent.from && request.from === intent.to && request.currency === 'AI$', 409, 'payment_request_changed');
    check(request.status === 'open', 409, 'payment_request_changed');
    check(!request.expiresAt || Date.parse(request.expiresAt) > now(), 409, 'payment_request_expired');
    const [whole, part = ''] = String(request.amount).split('.');
    check(/^(0|[1-9][0-9]{0,14})(\.[0-9]{1,6})?$/.test(String(request.amount)) && String(BigInt(whole) * 1000000n + BigInt(part.padEnd(6, '0'))) === intent.amountUnits, 409, 'payment_request_changed');
    let trade = null;
    if (Object.hasOwn(request, 'trade')) {
      check(typeof validateTradeRequest === 'function', 409, 'payment_request_changed');
      try { trade = validateTradeRequest(request); } catch { check(false, 409, 'payment_request_changed'); }
      check(trade && HASH.test(trade.tradeDigest), 409, 'payment_request_changed');
    }
    return { request, trade };
  }
  function lockFree(state, requestId, id) {
    // A landed payment already debited the payer; the request only waits for the recipient to
    // confirm receipt. It must never be paid again (10 November 2026: request 88a374c3… was paid
    // twice because 'finalized' counted as a free lock). The shared guard scans every payment on
    // both paths, not only the lock holders, because a later refused attempt can take a lock over.
    assertRequestUnpaid(state, requestId, check, { except: id });
  }
  function release(state, record) {
    if (record.intent.requestId && state.serverSendRequestLocks?.[record.intent.requestId] === record.id) delete state.serverSendRequestLocks[record.intent.requestId];
  }
  // What the independent checker needs to verify the payer's and payee's own signatures.
  function receivingEvidence(state, intent) {
    const row = state.receivingAddresses?.[intent.to];
    if (!row || row.chainId !== intent.chainId || row.address !== intent.recipientAddress) return null;
    return row.kind === 'key' ? { kind: 'key', fullViewingKey: row.fullViewingKey, publicKey: row.publicKey, signature: row.signature } : { address: row.address, publicKey: row.publicKey, signature: row.signature };
  }
  function terminal(state, record, status, extra = {}) {
    Object.assign(record, extra, { status, updatedAt: new Date(now()).toISOString() });
    if (status !== 'finalized') release(state, record);
    // Keep the store bounded: a terminal row keeps digests and proofs, not bundles.
    for (const a of record.attempts) if (a.command?.payload?.bundle) { a.bundleSha256 = sha(a.command.payload.bundle); a.command.payload.bundle = null; if (a.envelope) a.envelope.command = null; }
  }

  /** A signed attempt BAINK never relayed, whose sequence another command has since used, can
   *  never land: retire it once past its expiry so the intent is built again at a fresh sequence
   *  (10 November 2026 security review: such a send never ended, kept its amount reserved and,
   *  once relayed, held the member's sequence fence and all their earning forever). */
  async function retireUnrelayed(id, attempt, context, key) {
    const saved = await store.transact(state => {
      const x = rows(state)[id], a = x.attempts.find(y => y.n === attempt.n);
      if (a.sendAttemptedAt || ['finalized', 'expired-unused'].includes(a.status)) return x;
      a.status = 'expired-unused';
      a.recovery = { schema: 'baink-server-send-recovery-v1', verified: true, neverRelayed: true, recordKey: key, recordPresent: false, height: context.state.height, memberSequence: context.state.member?.sequence ?? null, commandSequence: a.command.sequence, expiresHeight: a.command.expires_height, proof: context.proof };
      if (x.status === 'cancel-requested') terminal(state, x, 'cancelled');
      else if (Date.parse(x.intent.notAfter) <= now()) terminal(state, x, 'expired');
      else { x.status = 'expired-unused'; x.updatedAt = new Date(now()).toISOString(); }
      return x;
    });
    return { status: saved.status };
  }
  /** An unsigned command whose window passed, or whose sequence another command used, can only
   *  be refused once the member signs it (10 November 2026: a late member signed a dead command,
   *  the chain refused it, and only then was a new one built). Checked from a fresh proof at most
   *  every `unsignedRecheckMs`; it was never signed, so there are no bytes that could land. */
  const unsignedChecked = new Map();
  async function retireUnsigned(record) {
    const a = record.attempts.at(-1);
    if (record.status !== 'awaiting-signature' || !a || a.envelope) return false;
    const every = limits.unsignedRecheckMs ?? SEND_LIMITS.unsignedRecheckMs;
    if (now() - (unsignedChecked.get(record.id) ?? Date.parse(a.builtAt)) < every) return false;
    unsignedChecked.set(record.id, now());
    let context;
    try { context = await proven({ member: a.command.member, keys: ['coin_balance/' + a.command.member] }); } catch { return false; }
    if (BigInt(context.state.height) <= BigInt(a.command.expires_height) && String(context.state.member?.sequence) === a.command.sequence) return false;
    const retired = await store.transact(state => {
      const x = rows(state)[record.id], current = x?.attempts.at(-1);
      if (!x || x.status !== 'awaiting-signature' || current.n !== a.n || current.envelope) return false;
      current.status = 'expired-unused';
      current.recovery = { schema: 'baink-server-send-recovery-v1', verified: true, neverSigned: true, height: context.state.height, memberSequence: context.state.member?.sequence ?? null, commandSequence: a.command.sequence, expiresHeight: a.command.expires_height, proof: context.proof };
      x.status = 'expired-unused'; x.updatedAt = new Date(now()).toISOString();
      return true;
    });
    if (retired) unsignedChecked.delete(record.id);
    return retired;
  }
  /** Retention (security review S6, 10 November 2026): without it the per-member and global
   *  caps were lifetime caps. A send that ended without a debit goes a day after its intent
   *  expired. A finalized send stays while it still proves something: until the recipient
   *  confirmed it and, when it paid a request, only once that request records this send as its
   *  payment (the "already paid" guard reads these rows). After that it is kept 30 days as the
   *  member's history, or one day when the member is at the cap. */
  let lastPrune = now();
  function removable(state, r, atCap) {
    if (!TERMINAL.has(r.status)) return false;
    const age = now() - Date.parse(r.intent.notAfter), day = limits.retainFailedMs ?? SEND_LIMITS.retainFailedMs;
    if (!(age >= day)) return false;
    if (r.status !== 'finalized') return true;
    if (!r.recipientConfirmation) return false;
    const request = r.intent.requestId ? state.requests?.[r.intent.requestId] : null;
    if (r.intent.requestId && !(request?.status === 'paid' && request.paymentIntentId === 'send:' + r.id)) return false;
    return atCap || age >= (limits.retainFinalizedMs ?? SEND_LIMITS.retainFinalizedMs);
  }
  function prune(state, payer = null) {
    const all = rows(state), drop = r => { if (r.intent.requestId && state.serverSendRequestLocks?.[r.intent.requestId] === r.id) delete state.serverSendRequestLocks[r.intent.requestId]; delete all[r.id]; };
    for (const r of Object.values(all)) if (removable(state, r, false)) drop(r);
    // At a cap, the oldest rows that prove nothing any more make room.
    const oldest = list => list.filter(r => removable(state, r, true)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (payer) { const mine = Object.values(all).filter(r => r.intent.from === payer); for (const r of oldest(mine).slice(0, Math.max(0, mine.length - limits.retainedPerPayer + 1))) drop(r); }
    const total = Object.keys(all).length;
    if (total >= limits.global) for (const r of oldest(Object.values(all)).slice(0, total - limits.global + 1)) drop(r);
  }
  async function waitingFor(id, message) {
    await store.transact(state => { const x = rows(state)[id]; if (x && !TERMINAL.has(x.status) && x.waiting?.message !== message) { x.waiting = { message, since: new Date(now()).toISOString() }; } });
  }
  /** Settle what holds the payer's sequence, then check the fence again. */
  async function fenceCleared(member) {
    if (typeof clearSequenceFence !== 'function') return false;
    try { await clearSequenceFence(member); } catch { return false; }
    return !hasPendingNativeSend(store.read(), member);
  }

  const service = {
    get enabled() { return ready(); },
    list(user) {
      memberKey(user);
      return { enabled: openTo(user.address), sends: Object.values(store.read().serverSendIntents ?? {}).filter(r => [r.intent.from, r.intent.to].includes(user.address)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map(r => view(r, user)) };
    },
    get(user, id) { return { send: view(owned(user, id), user) }; },

    receivingAddress(user, member) {
      memberKey(user);
      check(typeof member === 'string' && ADDRESS.test(member), 400, 'invalid_member');
      const row = store.read().receivingAddresses?.[member] ?? null, current = row?.chainId === native.pins?.chainId;
      return { member, address: current ? row.address : null, kind: current ? row.kind ?? 'address' : null, registeredAt: row?.registeredAt ?? null, ...(member === user.address ? { canReceive: current, sendingEnabled: openTo(user.address) } : {}) };
    },
    /** Register a no-install receiving key: the member signs its raw Orchard full
     * viewing key (the spending key never leaves the member); the pinned coin
     * wallet derives the address. */
    async registerReceivingKey(user, body) {
      const raw = memberKey(user);
      check(exact(body, ['fullViewingKey', 'signature']) && typeof body.fullViewingKey === 'string' && FVK.test(body.fullViewingKey), 400, 'invalid_receiving_key');
      check(native.pins?.chainId && typeof addressFromKey === 'function', 503, 'server_send_unavailable', 'No-install receiving is not switched on yet.');
      const bytes = receivingKeyBytes({ member: user.address, fullViewingKey: body.fullViewingKey, chainId: native.pins.chainId });
      check(verify(null, bytes, keyObject(raw), signature64(body.signature, 'invalid_receiving_key')), 400, 'invalid_receiving_key');
      const prior = store.read().receivingAddresses?.[user.address];
      if (prior?.kind === 'key' && prior.fullViewingKey === body.fullViewingKey && prior.chainId === native.pins.chainId) return { member: user.address, address: prior.address, kind: 'key', registeredAt: prior.registeredAt };
      // One place per member in the coin wallet's derivation line (review, 13 November 2026): a
      // few members registering random keys in parallel kept the shared line full for everyone.
      check(!deriving.has(user.address), 503, 'receiving_key_unavailable', 'Your receiving key is still being checked; try again shortly.');
      let address;
      deriving.add(user.address);
      try { address = await addressFromKey(body.fullViewingKey); } catch (error) {
        check(!/refused/.test(String(error?.message)), 422, 'receiving_key_invalid', 'This receiving key is not a valid Orchard key.');
        check(false, 503, 'receiving_key_unavailable', 'The receiving key could not be checked now; try again shortly.');
      } finally { deriving.delete(user.address); }
      check(typeof address === 'string' && ORCHARD.test(address), 503, 'receiving_key_unavailable');
      const saved = await store.transact(state => {
        state.receivingAddresses ??= {};
        check(Object.keys(state.receivingAddresses).length < 100000 || state.receivingAddresses[user.address], 429, 'receiving_address_capacity');
        state.receivingAddresses[user.address] = { kind: 'key', address, fullViewingKey: body.fullViewingKey, chainId: native.pins.chainId, publicKey: user.publicKey, signature: body.signature, registeredAt: new Date(now()).toISOString() };
        return state.receivingAddresses[user.address];
      });
      return { member: user.address, address: saved.address, kind: 'key', registeredAt: saved.registeredAt };
    },
    async registerReceivingAddress(user, body) {
      const raw = memberKey(user);
      check(exact(body, ['address', 'signature']) && typeof body.address === 'string' && ORCHARD.test(body.address), 400, 'invalid_receiving_address');
      check(native.pins?.chainId, 503, 'native_proof_unavailable');
      const bytes = receivingAddressBytes({ member: user.address, address: body.address, chainId: native.pins.chainId });
      check(verify(null, bytes, keyObject(raw), signature64(body.signature, 'invalid_receiving_address')), 400, 'invalid_receiving_address');
      const saved = await store.transact(state => {
        state.receivingAddresses ??= {};
        check(Object.keys(state.receivingAddresses).length < 100000 || state.receivingAddresses[user.address], 429, 'receiving_address_capacity');
        state.receivingAddresses[user.address] = { kind: 'address', address: body.address, chainId: native.pins.chainId, publicKey: user.publicKey, signature: body.signature, registeredAt: new Date(now()).toISOString() };
        return state.receivingAddresses[user.address];
      });
      return { member: user.address, address: saved.address, registeredAt: saved.registeredAt };
    },

    /** Step 1: accept a browser-signed intent. Idempotent by intent id. */
    async create(user, body) {
      const raw = memberKey(user);
      check(ready(), 503, 'server_send_unavailable', 'No-install sending is not switched on yet.');
      check(exact(body, ['intent', 'signature']), 400, 'invalid_send_intent');
      const intent = structuredClone(body.intent);
      validIntent(intent);
      check(intent.from === user.address, 403, 'send_payer_required');
      check(openTo(intent.from) && openTo(intent.to), 403, 'server_send_not_open', 'No-install sending is open only to test accounts for now.');
      const bytes = sendIntentBytes(intent), id = sha(bytes);
      check(verify(null, bytes, keyObject(raw), signature64(body.signature, 'invalid_send_signature')), 400, 'invalid_send_signature');
      const prior = store.read().serverSendIntents?.[id];
      if (prior) return { created: false, send: view(prior, user) };
      check(intent.chainId === native.pins.chainId && intent.genesisSha256 === native.pins.epoch, 409, 'send_network_mismatch');
      const notAfter = Date.parse(intent.notAfter);
      check(notAfter > now() + 60000 && notAfter <= now() + limits.maxNotAfterMs, 409, 'send_intent_expired', 'Choose an expiry between one minute and one day from now.');
      const registered = store.read().receivingAddresses?.[intent.to];
      check(registered?.chainId === intent.chainId && registered.address === intent.recipientAddress, 409, 'recipient_address_unregistered', 'The recipient has not registered this receiving address.');
      const context = await proven({ member: user.address, keys: ['member/' + intent.to, 'coin_balance/' + user.address, 'coin_activation', 'private_activation'] });
      const r = context.state.records ?? {};
      licensed(context.state.member, user.address);
      proofError(context.state.member.public_key === raw.toString('base64url'));
      licensed(r['member/' + intent.to], intent.to);
      check(r.coin_activation && r.private_activation, 409, 'native_payment_policy_inactive');
      const balance = balanceOf(r, user.address);
      const saved = await store.transact(state => {
        const all = rows(state);
        if (all[id]) return { created: false, record: all[id] };
        prune(state, user.address);
        const mine = Object.values(all).filter(x => x.intent.from === user.address);
        check(!mine.some(x => x.intent.nonce === intent.nonce), 409, 'send_nonce_reused');
        check(mine.filter(x => !TERMINAL.has(x.status)).length < limits.activePerPayer, 429, 'send_active_limit', 'Finish or cancel an earlier send first.');
        check(mine.filter(x => Date.parse(x.createdAt) > now() - 86400000).length < limits.acceptedPerDay, 429, 'send_daily_limit');
        check(mine.length < limits.retainedPerPayer && Object.keys(all).length < limits.global && Object.values(all).filter(x => !TERMINAL.has(x.status)).length < limits.activeGlobal, 429, 'send_capacity', 'Sending is busy; try again shortly.');
        // Conservation (1): reservations never exceed the proven public balance.
        check(reserved(state, user.address) + BigInt(intent.amountUnits) <= balance, 409, 'insufficient_balance', 'Your proven AI$ balance does not cover this and your other pending sends.');
        let trade = null;
        if (intent.requestId) {
          let request;
          ({ request, trade } = requestFor(state, intent));
          // P0-4: only a new send is asked; a send already accepted keeps going in every mode.
          tradeAvailability?.assert('payment.start', { request });
          lockFree(state, intent.requestId, id);
          state.serverSendRequestLocks ??= {};
          state.serverSendRequestLocks[intent.requestId] = id;
        }
        const stamp = new Date(now()).toISOString();
        const record = { id, schema: 'baink-server-send-v1', intent, signature: body.signature, publicKey: user.publicKey, tradeDigest: trade?.tradeDigest ?? null, status: 'accepted', attempts: [], checker: null, result: null, recipientConfirmation: null, balanceAtAccept: String(balance), proofHeightAtAccept: context.proof.height, createdAt: stamp, updatedAt: stamp };
        all[id] = record;
        return { created: true, record };
      });
      return { created: saved.created, send: view(saved.record, user) };
    },

    /** Step 2 (server): build the next attempt. Called by tick() and after create. */
    async build(id) {
      check(ready(), 503, 'server_send_unavailable');
      if (building.has(id)) return { status: 'building' };
      building.add(id);
      try {
        const record = store.read().serverSendIntents?.[id];
        if (!record || TERMINAL.has(record.status)) return { status: record?.status ?? 'missing' };
        if (!['accepted', 'expired-unused', 'queued-checker-capacity', 'building'].includes(record.status)) return { status: record.status };
        if (record.status === 'queued-checker-capacity' && record.checker?.retryAt && Date.parse(record.checker.retryAt) > now()) return { status: record.status };
        if (Date.parse(record.intent.notAfter) <= now()) {
          await store.transact(state => { const r = rows(state)[id]; if (!TERMINAL.has(r.status) && !r.attempts.some(a => a.envelope && !['expired-unused'].includes(a.status))) terminal(state, r, 'expired'); });
          return { status: 'expired' };
        }
        // L6: after a failed build, wait out its backoff (the expiry check above still ends the send).
        if (record.status === 'accepted' && record.lastError?.code === 'build_failed' && Date.parse(record.lastError.retryAt) > now()) return { status: 'accepted', retryAt: record.lastError.retryAt };
        // One payer sequence at a time: wait for the payer's older intents and other native sends.
        const state0 = store.read();
        const older = Object.values(state0.serverSendIntents).find(r => r.intent.from === record.intent.from && r.id !== id && !TERMINAL.has(r.status) && r.attempts.some(a => a.envelope && !['expired-unused', 'finalized'].includes(a.status)));
        // The member sees one plain sentence while a send waits (no internal terms).
        if (older) { await waitingFor(id, SEND_WAITING.earlierPayment); return { status: 'waiting-for-sequence' }; }
        if (hasPendingNativeSend(state0, record.intent.from) && !(await fenceCleared(record.intent.from))) { await waitingFor(id, SEND_WAITING.earningConfirming); return { status: 'waiting-for-sequence' }; }
        const { intent } = record;
        const context = await proven({ member: intent.from, keys: ['member/' + intent.to, 'coin_balance/' + intent.from, 'private_licence_revision', 'private_frontier', 'private_activation', 'coin_activation'] });
        const r = context.state.records ?? {};
        licensed(context.state.member, intent.from); licensed(r['member/' + intent.to], intent.to);
        const balance = balanceOf(r, intent.from), height = BigInt(context.state.height);
        // Conservation (1) again against the fresh proof, excluding this intent.
        const others = reserved(store.read(), intent.from, id);
        if (others + BigInt(intent.amountUnits) > balance) {
          await store.transact(state => { const x = rows(state)[id]; if (!TERMINAL.has(x.status)) x.lastError = { code: 'insufficient_balance', at: new Date(now()).toISOString(), balance: String(balance) }; });
          return { status: 'insufficient_balance' };
        }
        const revision = r.private_licence_revision?.value, frontier = r.private_frontier;
        proofError(typeof revision === 'string' && UINT.test(revision) && frontier && HASH.test(frontier.root ?? '') && UINT.test(frontier.count ?? ''));
        // S7 (security review, 10 November 2026). A send queued for the AI checker left a custody
        // claim on its bundle, and custody gives one live approval per intent: a new bundle before
        // that claim's expiry height is refused, which used to end the send with a false reason.
        // Stay queued until the claimed attempt can no longer land; then build afresh.
        const claim = record.status === 'queued-checker-capacity' ? record.checker?.claimExpiresHeight : null;
        if (typeof claim === 'string' && UINT.test(claim) && height <= BigInt(claim)) {
          const retryAt = new Date(now() + (limits.queuedClaimRetryMs ?? SEND_LIMITS.queuedClaimRetryMs)).toISOString();
          await store.transact(state => { const x = rows(state)[id]; if (x.status === 'queued-checker-capacity') { x.checker = { ...x.checker, retryAt }; x.updatedAt = new Date(now()).toISOString(); } });
          return { status: 'queued-checker-capacity', retryAt };
        }
        const attemptNumber = record.attempts.length + 1, expiresHeight = String(height + limits.attemptBlocks);
        await store.transact(state => { const x = rows(state)[id]; if (!TERMINAL.has(x.status)) { x.status = 'building'; delete x.waiting; x.updatedAt = new Date(now()).toISOString(); } });
        let built;
        try {
          built = await builder.build({ intentId: id, attempt: attemptNumber, chainId: intent.chainId, member: intent.from, amountUnits: intent.amountUnits, recipientAddress: intent.recipientAddress, memo: intent.memo, expiresHeight, licenceRevision: revision, frontier: { root: frontier.root, count: frontier.count }, purposeCommitment: sendPurposeCommitment(id), evidence: { intent, signature: record.signature, publicKey: record.publicKey, registration: receivingEvidence(store.read(), intent) } });
        } catch (error) {
          const failures = (record.lastError?.code === 'build_failed' && Number.isSafeInteger(record.lastError.failures) ? record.lastError.failures : 0) + 1;
          const wait = Math.min((limits.buildRetryMs ?? SEND_LIMITS.buildRetryMs) * 2 ** Math.min(failures - 1, 20), limits.buildRetryMaxMs ?? SEND_LIMITS.buildRetryMaxMs);
          await store.transact(state => { const x = rows(state)[id]; if (x.status === 'building') { x.status = 'accepted'; x.lastError = { code: 'build_failed', message: String(error?.message ?? error).slice(0, 300), at: new Date(now()).toISOString(), failures, retryAt: new Date(now() + wait).toISOString() }; } });
          return { status: 'build_failed' };
        }
        if (built?.status === 'queued') {
          // A checker that gives no answer is asked again after each window, three times at most;
          // then the send ends with what really happened instead of waiting out its whole day.
          const unanswered = built.reason === 'checker-unanswered' ? (record.checker?.unanswered ?? 0) + 1 : 0;
          if (unanswered >= 3) {
            await store.transact(state => { const x = rows(state)[id]; if (x.status === 'building') terminal(state, x, 'checker-refused', { checker: { status: 'refused', reason: 'The payment checker gave no answer after three tries. Nothing was sent; send the payment again.' } }); });
            return { status: 'checker-refused' };
          }
          await store.transact(state => { const x = rows(state)[id]; if (x.status === 'building') { x.status = 'queued-checker-capacity'; x.checker = { status: 'queued', retryAt: built.retryAt ?? null, reason: built.reason ?? 'checker-capacity', ...(typeof built.claimExpiresHeight === 'string' && UINT.test(built.claimExpiresHeight) ? { claimExpiresHeight: built.claimExpiresHeight } : {}), ...(unanswered ? { unanswered } : {}) }; x.updatedAt = new Date(now()).toISOString(); } });
          return { status: 'queued-checker-capacity', retryAt: built.retryAt ?? null };
        }
        if (built?.status === 'refused') {
          await store.transact(state => { const x = rows(state)[id]; if (x.status === 'building') terminal(state, x, 'checker-refused', { checker: { status: 'refused', reason: String(built.reason ?? 'refused').slice(0, 300) } }); });
          return { status: 'checker-refused' };
        }
        check(built?.status === 'built', 502, 'send_build_invalid');
        const command = { version: 1, chain_id: intent.chainId, member: intent.from, sequence: context.state.member.sequence, expires_height: expiresHeight, operation: 'coin_shield', payload: { bundle: built.bundle, approval: built.approval } };
        const bytes = verifySendCommand(record, command);
        // The checker's approval must verify against the appointed, licensed reviewer.
        const a = built.approval, reviewerContext = await proven({ keys: ['member/' + a.reviewer, 'private_reviewer/' + a.reviewer] });
        const reviewer = licensed(reviewerContext.state.records['member/' + a.reviewer], a.reviewer);
        check(reviewerContext.state.records['private_reviewer/' + a.reviewer]?.active === true && Number.isSafeInteger(reviewer.karma) && reviewer.karma >= 100 && a.reviewer !== intent.from, 409, 'send_checker_inactive');
        check(a.licence_revision === revision && BigInt(a.expires_height) >= BigInt(expiresHeight) && BigInt(a.expires_height) <= height + 720n, 502, 'send_build_invalid');
        const reviewerRaw = Buffer.from(reviewer.public_key, 'base64url');
        const approvalBytes = coinBoundaryApprovalBytes({ version: 1, chain: intent.chainId, expires: a.expires_height, licenceRevision: a.licence_revision, effects: a.effects, purpose: a.purpose_commitment, reviewer: reviewerRaw.toString('hex') }, { direction: 'shield', member: intent.from, amount: intent.amountUnits }, a.class);
        check(verify(null, approvalBytes, keyObject(reviewerRaw), Buffer.from(a.signature, 'base64url')), 502, 'send_checker_signature_invalid');
        const saved = await store.transact(state => {
          const x = rows(state)[id];
          if (x.status !== 'building') return x;
          x.attempts.push({ n: attemptNumber, status: 'awaiting-signature', command, signingBytesBase64: bytes.toString('base64'), commandDigest: sha(bytes), effects: a.effects, proofHeight: context.proof.height, envelope: null, transactionHash: null, sendAttemptedAt: null, broadcasts: [], recovery: null, receipt: null, builtAt: new Date(now()).toISOString() });
          x.checker = { status: 'approved', reviewer: a.reviewer, class: a.class, ...(['rules', 'ai'].includes(built.route) ? { route: built.route } : {}) };
          x.status = 'awaiting-signature'; x.updatedAt = new Date(now()).toISOString();
          return x;
        });
        return { status: saved.status };
      } finally { building.delete(id); }
    },

    /** Step 3: the browser's signature on the exact prepared command. */
    async sign(user, id, body) {
      const raw = memberKey(user), record = owned(user, id, 'payer');
      check(exact(body, ['attempt', 'signature']) && Number.isSafeInteger(body.attempt), 400, 'invalid_send_signature');
      const attempt = record.attempts.find(a => a.n === body.attempt);
      check(attempt, 404, 'send_attempt_missing');
      const envelope = { command: attempt.command, public_key: raw.toString('base64url'), signature: body.signature };
      check(verify(null, Buffer.from(attempt.signingBytesBase64, 'base64'), keyObject(raw), signature64(body.signature, 'invalid_send_signature')), 400, 'invalid_send_signature');
      if (attempt.envelope) { check(attempt.envelope.signature === body.signature, 409, 'send_envelope_conflict'); return { attempted: false, send: view(record, user) }; }
      check(record.status === 'awaiting-signature' && record.attempts.at(-1).n === attempt.n, 409, 'send_not_awaiting_signature');
      await store.transact(state => {
        const x = rows(state)[id], current = x.attempts.find(a => a.n === attempt.n);
        if (current.envelope) return;
        check(x.status === 'awaiting-signature', 409, 'send_not_awaiting_signature');
        current.envelope = envelope; current.transactionHash = sha(JSON.stringify(envelope)).toUpperCase(); current.status = 'signed';
        x.status = 'signed'; x.updatedAt = new Date(now()).toISOString();
      });
      await service.broadcast(id);
      return { attempted: true, send: view(store.read().serverSendIntents[id], user) };
    },

    /** Relay the signed bytes once per window. The journal marker is durable first. */
    async broadcast(id) {
      const record = store.read().serverSendIntents?.[id], attempt = record?.attempts.at(-1);
      if (!attempt?.envelope || !['signed', 'broadcasting', 'unknown', 'submitted', 'refused'].includes(attempt.status)) return { status: attempt?.status ?? 'missing' };
      const last = attempt.broadcasts.at(-1);
      if (last && now() - Date.parse(last.at) < limits.rebroadcastMs) return { status: attempt.status };
      if (attempt.status === 'refused' && attempt.broadcasts.length >= 3) return { status: attempt.status };
      // A first send waits for the payer's sequence; try to settle a held
      // central-earning intent from chain state first (reads only).
      if (!attempt.sendAttemptedAt && hasPendingNativeSend(store.read(), record.intent.from)) await fenceCleared(record.intent.from);
      if (!attempt.sendAttemptedAt) {
        // First relay: never send bytes the payer cancelled, nor bytes whose sequence another
        // command has used or whose expiry passed. They could only be refused, and relaying them
        // would hold the payer's sequence fence for good. Reconcile retires them past expiry.
        if (record.status === 'cancel-requested') return { status: 'cancel-requested' };
        const key = 'private_boundary/' + attempt.effects;
        let context;
        // An unreadable proof only defers the relay: the background loop tries again.
        try { context = await proven({ member: attempt.command.member, keys: [key] }); } catch { return { status: attempt.status }; }
        if (context.state.records?.[key]) return service.reconcile(id);
        if (String(context.state.member?.sequence) !== attempt.command.sequence || BigInt(context.state.height) > BigInt(attempt.command.expires_height)) return { status: 'stale-sequence' };
      }
      let blocked = false;
      await store.transact(state => {
        const x = rows(state)[id], a = x.attempts.at(-1);
        if (a.n !== attempt.n || !a.envelope) { blocked = true; return; }
        if (!a.sendAttemptedAt && hasPendingNativeSend(state, x.intent.from)) { blocked = true; return; }
        a.sendAttemptedAt ??= new Date(now()).toISOString();
        a.broadcasts.push({ at: new Date(now()).toISOString(), outcome: 'pending' });
        if (a.status === 'signed') a.status = 'broadcasting';
        if (x.status !== 'cancel-requested') x.status = 'broadcasting';
        x.updatedAt = new Date(now()).toISOString();
      });
      if (blocked) return { status: 'waiting-for-sequence' };
      let outcome = 'unknown', code = null, log = null;
      try {
        const reply = await native.broadcastShield(attempt.envelope, { timeoutMs: 8000 });
        if (reply.transactionHash === attempt.transactionHash && Number.isInteger(reply.code) && reply.accepted === (reply.code === 0)) { outcome = reply.accepted ? 'submitted' : 'refused'; code = reply.code; log = typeof reply.log === 'string' ? reply.log.slice(0, 300) : null; }
      } catch { /* unknown: reconciliation decides */ }
      await store.transact(state => {
        const x = rows(state)[id], a = x.attempts.at(-1);
        if (a.n !== attempt.n) return;
        const b = a.broadcasts.at(-1); b.outcome = outcome; b.code = code; if (log) b.log = log;
        if (!['finalized', 'expired-unused'].includes(a.status)) { a.status = outcome === 'submitted' || a.status === 'submitted' ? 'submitted' : outcome; if (x.status !== 'cancel-requested') x.status = a.status; }
        x.updatedAt = new Date(now()).toISOString();
      });
      return { status: outcome };
    },

    /** Step 4: finality or proved non-inclusion, never inferred from RPC errors. */
    async reconcile(id) {
      const record = store.read().serverSendIntents?.[id], attempt = record?.attempts.at(-1);
      if (!attempt?.envelope || ['finalized', 'expired-unused'].includes(attempt.status)) return { status: attempt?.status ?? record?.status ?? 'missing' };
      const { command } = attempt, key = 'private_boundary/' + attempt.effects;
      const context = await proven({ member: command.member, keys: [key, 'coin_balance/' + command.member] });
      const height = BigInt(context.state.height), sequence = BigInt(context.state.member?.sequence ?? '-1'), found = context.state.records?.[key];
      if (found) {
        // Recorded in committed, pinned state: these exact bytes are final.
        proofError(found.bundle === command.payload.bundle && found.approval?.member === command.member && found.approval?.amount === command.payload.approval.amount && found.approval?.effects === attempt.effects);
        const saved = await store.transact(state => {
          const x = rows(state)[id], a = x.attempts.find(y => y.n === attempt.n);
          if (a.status === 'finalized') return x;
          a.status = 'finalized'; a.receipt = { recordKey: key, height: found.height ?? null, proof: context.proof };
          x.result = { effects: attempt.effects, amountUnits: x.intent.amountUnits, height: found.height ?? null, recordKey: key, payerBalanceAfter: context.state.records['coin_balance/' + command.member] ?? '0', proof: context.proof };
          terminal(state, x, 'finalized');
          return x;
        });
        native.invalidateAccount?.(command.member);
        return { status: saved.status };
      }
      // Proved unused only when ALL hold in one committed snapshot: absent, past
      // expiry, and the payer's sequence still unused. A failed command never
      // consumes a sequence, so an advanced sequence with an absent record is a
      // reader inconsistency or another command: never a reason to retry (the
      // 9 Nov devnet run caught exactly this double debit). Keep checking.
      if (!attempt.sendAttemptedAt && sequence > BigInt(command.sequence) && height > BigInt(command.expires_height)) return retireUnrelayed(id, attempt, context, key);
      if (sequence > BigInt(command.sequence)) {
        // S2 residual (security review, 10 November 2026). Relayed bytes whose sequence another
        // command used could never end and held the payer's fence for good. They are proved dead
        // only when ALL hold: the chain refused EVERY relay in a reply naming these exact bytes
        // (so they never entered a mempool through BAINK; one pending or unknown relay rules this
        // out, which is the 9 November double-debit case), the record is absent past the expiry
        // height (consensus can no longer include them), and a second committed snapshot at a
        // later height still shows it absent (one inconsistent read is not enough).
        const refusedEveryRelay = attempt.broadcasts.length > 0 && attempt.broadcasts.every(b => b.outcome === 'refused' && Number.isInteger(b.code) && b.code !== 0);
        const pastExpiry = height > BigInt(command.expires_height), seen = attempt.refusedUnincluded;
        if (refusedEveryRelay && pastExpiry && seen && height > BigInt(seen.height)) {
          const saved = await store.transact(state => {
            const x = rows(state)[id], a = x.attempts.find(y => y.n === attempt.n);
            if (['finalized', 'expired-unused'].includes(a.status)) return x;
            // A relay that started meanwhile has no proved outcome yet: keep waiting.
            if (!a.refusedUnincluded || a.broadcasts.length !== attempt.broadcasts.length || !a.broadcasts.every(b => b.outcome === 'refused')) return x;
            a.status = 'expired-unused';
            a.recovery = { schema: 'baink-server-send-recovery-v1', verified: true, everyRelayRefused: true, refusals: a.broadcasts.map(b => ({ at: b.at, code: b.code, log: b.log ?? null })), firstAbsentHeight: a.refusedUnincluded.height, recordKey: key, recordPresent: false, height: context.state.height, memberSequence: context.state.member.sequence, commandSequence: command.sequence, expiresHeight: command.expires_height, proof: context.proof };
            if (x.status === 'cancel-requested') terminal(state, x, 'cancelled');
            else if (Date.parse(x.intent.notAfter) <= now()) terminal(state, x, 'expired');
            else { x.status = 'expired-unused'; x.updatedAt = new Date(now()).toISOString(); }
            return x;
          });
          return { status: saved.status };
        }
        await store.transact(state => {
          const x = rows(state)[id], a = x.attempts.find(y => y.n === attempt.n);
          if (['finalized', 'expired-unused'].includes(a.status)) return;
          a.sequenceConsumed = { height: context.state.height, memberSequence: context.state.member.sequence, at: new Date(now()).toISOString() };
          if (refusedEveryRelay && pastExpiry) a.refusedUnincluded ??= { height: context.state.height, at: new Date(now()).toISOString() };
          x.updatedAt = new Date(now()).toISOString();
        });
        return { status: store.read().serverSendIntents[id].status };
      }
      if (height > BigInt(command.expires_height) && sequence === BigInt(command.sequence)) {
        const saved = await store.transact(state => {
          const x = rows(state)[id], a = x.attempts.find(y => y.n === attempt.n);
          if (['finalized', 'expired-unused'].includes(a.status)) return x;
          a.status = 'expired-unused';
          a.recovery = { schema: 'baink-server-send-recovery-v1', verified: true, recordKey: key, recordPresent: false, height: context.state.height, memberSequence: context.state.member.sequence, commandSequence: command.sequence, expiresHeight: command.expires_height, proof: context.proof };
          // The attempt is proved dead. Retry while the member's intent lives.
          if (x.status === 'cancel-requested') terminal(state, x, 'cancelled');
          else if (Date.parse(x.intent.notAfter) <= now()) terminal(state, x, 'expired');
          else { x.status = 'expired-unused'; x.updatedAt = new Date(now()).toISOString(); }
          return x;
        });
        return { status: saved.status };
      }
      if (['unknown', 'broadcasting', 'refused', 'signed'].includes(attempt.status) || attempt.status === 'submitted') await service.broadcast(id);
      return { status: store.read().serverSendIntents[id].status };
    },

    async refresh(user, id, body) {
      check(exact(body ?? {}, []), 400, 'invalid_send_request');
      const record = owned(user, id), last = record.attempts.at(-1);
      if (last?.envelope && !['expired-unused', 'finalized'].includes(last.status)) await service.reconcile(id);
      // A proved-unused attempt is retried at once (the payer re-signs it).
      if (ready() && !TERMINAL.has(store.read().serverSendIntents[id].status)) await service.build(id);
      return { send: view(store.read().serverSendIntents[id], user) };
    },

    /** Cancel before a signature; after one, only once the attempt is proved dead. */
    async cancel(user, id, body) {
      check(exact(body ?? {}, []), 400, 'invalid_send_request');
      const record = owned(user, id, 'payer');
      if (TERMINAL.has(record.status)) { check(record.status === 'cancelled', 409, 'send_' + record.status.replace('-', '_')); return { send: view(record, user) }; }
      const saved = await store.transact(state => {
        const x = rows(state)[id], a = x.attempts.at(-1);
        if (TERMINAL.has(x.status)) return x;
        check(x.status !== 'building', 409, 'send_building', 'The send is being prepared; try again in a moment.');
        if (!a || !a.envelope || a.status === 'expired-unused') terminal(state, x, 'cancelled');
        else { x.status = 'cancel-requested'; x.updatedAt = new Date(now()).toISOString(); }
        return x;
      });
      if (saved.status === 'cancel-requested') await service.reconcile(id).catch(() => {});
      return { send: view(store.read().serverSendIntents[id], user) };
    },

    /** Step 5: the payee confirms receipt in the browser; a request becomes paid. */
    async confirm(user, id, body) {
      const raw = memberKey(user), record = owned(user, id, 'payee');
      check(exact(body, ['signature']), 400, 'invalid_send_confirmation');
      check(record.status === 'finalized' && record.result, 409, 'send_not_final');
      check(verify(null, sendConfirmationBytes(record), keyObject(raw), signature64(body.signature, 'invalid_send_confirmation')), 400, 'invalid_send_confirmation');
      const saved = await store.transact(state => {
        const x = rows(state)[id];
        if (x.recipientConfirmation) return x;
        x.recipientConfirmation = { signature: body.signature, at: new Date(now()).toISOString() };
        if (x.intent.requestId) {
          const request = state.requests?.[x.intent.requestId];
          if (request && request.status === 'open') {
            request.status = 'paid'; request.paymentIntentId = 'send:' + x.id; request.updatedAt = new Date(now()).toISOString();
            request.settlement = { kind: 'native-server-send', effects: x.result.effects, chainId: x.intent.chainId, intentId: x.id, amountUnits: x.intent.amountUnits, amountVerification: 'consensus-public-debit', recipientVerification: 'checker-decrypted-and-recipient-confirmed' };
            release(state, x);
          }
          // A request this landed payment could not mark paid (it expired or was closed
          // meanwhile) keeps its lock, so it can never be reopened and paid a second time
          // (10 November 2026 security review).
        }
        x.updatedAt = new Date(now()).toISOString();
        return x;
      });
      return { send: view(saved, user) };
    },

    /** Background progress so status reaches finality with no page open. */
    async tick({ max = 16 } = {}) {
      if (!ready()) return [];
      const open = Object.values(store.read().serverSendIntents ?? {}).filter(r => !TERMINAL.has(r.status)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, max), out = [];
      for (const r of open) {
        try {
          const a = r.attempts.at(-1);
          if (a?.envelope && !['expired-unused', 'finalized'].includes(a.status)) out.push({ id: r.id, ...(await service.reconcile(r.id)) });
          else if (r.status === 'awaiting-signature' && Date.parse(r.intent.notAfter) <= now()) { await store.transact(state => { const x = rows(state)[r.id]; if (x.status === 'awaiting-signature') terminal(state, x, 'expired'); }); out.push({ id: r.id, status: 'expired' }); }
          else if (r.status === 'cancel-requested' && (!a?.envelope || a.status === 'expired-unused')) { await store.transact(state => terminal(state, rows(state)[r.id], 'cancelled')); out.push({ id: r.id, status: 'cancelled' }); }
          else if (r.status !== 'awaiting-signature') out.push({ id: r.id, ...(await service.build(r.id)) });
          // A dead unsigned command is replaced at once, so a late member signs a live one.
          else if (await retireUnsigned(r)) out.push({ id: r.id, ...(await service.build(r.id)) });
        } catch (error) { out.push({ id: r.id, error: error?.code ?? 'error' }); }
      }
      for (const id of unsignedChecked.keys()) if (!open.some(r => r.id === id)) unsignedChecked.delete(id);
      if (now() - lastPrune >= (limits.pruneEveryMs ?? SEND_LIMITS.pruneEveryMs)) { lastPrune = now(); try { await store.transact(state => { prune(state); }); } catch { /* next round */ } }
      return out;
    },
  };
  return Object.freeze(service);
}
export const SERVER_SEND_TERMINAL = TERMINAL;

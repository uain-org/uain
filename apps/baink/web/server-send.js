/** Browser half of no-install sending. The member's Ed25519 key never leaves
 * this browser: it signs the send intent, then (after checking the prepared
 * command matches that intent) the native coin_shield command, and, as a
 * recipient, the receipt confirmation. Byte formats match server/server-send.mjs. */
import { nativeCanonicalJSON as canonical } from './native-financial.js';

const enc = new TextEncoder();
const HASH = /^[a-f0-9]{64}$/, ADDRESS = /^uain1[a-f0-9]{40}$/, ORCHARD = /^[a-f0-9]{86}$/, UNITS = /^[1-9][0-9]{0,18}$/;
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const sha = async value => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? enc.encode(value) : value)));
const insist = (ok, message = 'The prepared payment differs from what you signed. Nothing was signed.') => { if (!ok) throw Error(message); };
const exact = (x, keys) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));

async function signBytes(identity, bytes) {
  return b64url(new Uint8Array(await crypto.subtle.sign('Ed25519', identity.privateKey, bytes)));
}
export const sendIntentBytes = intent => enc.encode('BAINK/send-intent/v1\0' + canonical(intent));
export const sendIntentId = intent => sha(sendIntentBytes(intent));
export const sendPurposeCommitment = id => sha('BAINK/server-send/purpose/v1\0' + id);

/** Decimal AI$ ("25" or "0.5") to exact chain units (6 decimals). */
export function amountToUnits(text) {
  const value = String(text ?? '').trim();
  insist(/^(0|[1-9][0-9]{0,12})(\.[0-9]{1,6})?$/.test(value), 'Enter an amount like 25 or 0.5.');
  const [whole, part = ''] = value.split('.');
  const units = (BigInt(whole) * 1000000n + BigInt(part.padEnd(6, '0'))).toString();
  insist(UNITS.test(units), 'Enter an amount above zero.');
  return units;
}
export function unitsToAmount(units) {
  const n = BigInt(units), whole = n / 1000000n, part = (n % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return part ? `${whole}.${part}` : String(whole);
}

export function buildSendIntent({ pins, from, to, recipientAddress, amountUnits, requestId = null, memo = '', minutes = 60, now = Date.now() }) {
  insist(pins && typeof pins.chainId === 'string' && HASH.test(pins.genesisSha256 ?? ''), 'The network is not proven yet. Try again in a moment.');
  insist(ADDRESS.test(from) && ADDRESS.test(to) && from !== to, 'Choose another member to pay.');
  insist(ORCHARD.test(recipientAddress ?? ''), 'The recipient has not set up receiving yet.');
  insist(UNITS.test(amountUnits), 'Enter an amount above zero.');
  insist(Number.isInteger(minutes) && minutes >= 5 && minutes <= 1440, 'Choose an expiry between 5 minutes and a day.');
  insist(typeof memo === 'string' && enc.encode(memo).length <= 200, 'Keep the note under 200 bytes.');
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const notAfter = new Date(now + minutes * 60000).toISOString();
  return { schema: 'baink-send-intent-v1', chainId: pins.chainId, genesisSha256: pins.genesisSha256, from, to, recipientAddress, amountUnits, nonce, notAfter, requestId, memo };
}
export async function signSendIntent(identity, intent) {
  insist(identity?.address === intent.from, 'Sign in as the paying account.');
  return { intent, signature: await signBytes(identity, sendIntentBytes(intent)) };
}

/** True only when `record.signature` is this identity's own signature on the record's intent. */
async function signedByThisKey(identity, record) {
  try {
    if (typeof record.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(record.signature) || typeof identity?.publicKeyBase64 !== 'string') return false;
    const bytes = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('raw', bytes(identity.publicKeyBase64), 'Ed25519', false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, bytes(record.signature.replaceAll('-', '+').replaceAll('_', '/') + '=='), sendIntentBytes(record.intent));
  } catch { return false; }
}
// FE-4 (security review, 13 November 2026): a fresh attempt is only ever built after every earlier
// one was proved unused (server-send.mjs build), so any other earlier attempt, a ledger result or a
// receipt means the send may already have landed.
const unspent = record => !record?.result && !record?.recipientConfirmation && Array.isArray(record?.attempts) && record.attempts.slice(0, -1).every(a => a?.status === 'expired-unused');
const unexpired = (intent, now) => Date.parse(intent?.notAfter) > now;
/** What the Pay screen signs by itself: this payer's own prepared, live, unspent sends. */
export function readyToSign(record, me, now = Date.now()) {
  return record?.intent?.from === me && record.status === 'awaiting-signature' && record.attempts?.at?.(-1)?.status === 'awaiting-signature' && unexpired(record.intent, now) && unspent(record);
}
/** Repeat the server's checks locally, then sign the exact command bytes. */
export async function signPreparedCommand(identity, record, { maxBlocks = 120n, now = Date.now() } = {}) {
  const intent = record?.intent, attempt = record?.attempts?.at?.(-1);
  insist(record?.status === 'awaiting-signature' && attempt?.status === 'awaiting-signature' && identity?.address === intent?.from);
  insist(unexpired(intent, now), 'This payment expired before it was confirmed. Nothing was signed.');
  insist(unspent(record), 'This payment may already have been sent. Nothing was signed.');
  insist(await sendIntentId(intent) === record.id);
  // The command is signed only for an intent this very key signed: a record whose intent was made up
  // elsewhere carries no such signature (security review 10 November 2026, S5).
  insist(await signedByThisKey(identity, record), 'This payment was not authorised on this device. Nothing was signed.');
  const c = attempt.command;
  insist(exact(c, ['version', 'chain_id', 'member', 'sequence', 'expires_height', 'operation', 'payload']) && c.version === 1 && c.operation === 'coin_shield' && c.chain_id === intent.chainId && c.member === intent.from && exact(c.payload, ['bundle', 'approval']));
  const a = c.payload.approval;
  insist(exact(a, ['reviewer', 'effects', 'purpose_commitment', 'class', 'expires_height', 'licence_revision', 'signature', 'direction', 'member', 'amount']) && a.direction === 'shield' && a.member === intent.from && a.amount === intent.amountUnits && ['benevolent', 'neutral'].includes(a.class) && ADDRESS.test(a.reviewer) && a.reviewer !== intent.from);
  insist(a.purpose_commitment === await sendPurposeCommitment(record.id) && /^[1-9][0-9]{0,18}$/.test(c.expires_height) && BigInt(c.expires_height) <= BigInt(a.expires_height) && BigInt(c.expires_height) <= BigInt(attempt.proofHeight) + maxBlocks && BigInt(c.expires_height) > BigInt(attempt.proofHeight));
  const fields = ['version', 'chain_id', 'member', 'sequence', 'expires_height', 'operation', 'payload'];
  const bytes = enc.encode('uain:chain-command:v1\n{' + fields.map(k => canonical(k) + ':' + canonical(c[k])).join(',') + '}');
  insist(b64(bytes) === attempt.signingBytesBase64 && await sha(bytes) === attempt.commandDigest);
  return { attempt: attempt.n, signature: await signBytes(identity, bytes) };
}
function b64(bytes) { return btoa(String.fromCharCode(...bytes)); }

export function sendConfirmationBytes(record) {
  return enc.encode('BAINK/send-received/v1\0' + canonical({ intentId: record.id, chainId: record.intent.chainId, from: record.intent.from, to: record.intent.to, amountUnits: record.intent.amountUnits, effects: record.result.effects }));
}
export async function signReceipt(identity, record) {
  insist(identity?.address === record?.intent?.to && record.status === 'finalized' && HASH.test(record.result?.effects ?? ''), 'Only the recipient can confirm a finished payment.');
  return { signature: await signBytes(identity, sendConfirmationBytes(record)) };
}
export async function signReceivingAddress(identity, { address, chainId }) {
  insist(ORCHARD.test(address ?? ''), 'Paste the 86-character receiving address from your wallet.');
  insist(typeof chainId === 'string' && chainId.length > 0, 'The network is not proven yet.');
  return { address, signature: await signBytes(identity, enc.encode('BAINK/receiving-address/v1\0' + canonical({ member: identity.address, address, chainId }))) };
}

/** Plain-language status for the Pay screen. */
export function sendStatus(record, me) {
  const payer = record.intent.from === me;
  const s = record.status;
  const map = {
    accepted: ['Preparing', 'Checking your balance and preparing the payment.'],
    building: ['Preparing', 'Preparing your payment. This takes up to a minute.'],
    'queued-checker-capacity': ['Waiting for the checker', `The payment checker is at capacity. It continues automatically${record.checker?.retryAt ? ' after ' + new Date(record.checker.retryAt).toLocaleTimeString() : ''}.`],
    'awaiting-signature': [payer ? 'Needs your signature' : 'Waiting for the payer', payer ? 'Confirm on this device to send it.' : 'The payer still has to confirm.'],
    signed: ['Sending', 'Sending your payment.'],
    broadcasting: ['Sending', 'Sending your payment.'],
    submitted: ['On its way', 'Sent. Waiting for it to be final.'],
    unknown: ['Checking', 'We could not confirm it yet. Checking now; nothing is sent twice.'],
    refused: ['Retrying', 'This attempt did not go through. A fresh one is prepared automatically; nothing is paid twice.'],
    'expired-unused': ['Retrying', 'The last attempt expired unused. Preparing a fresh one; nothing was paid twice.'],
    'cancel-requested': ['Cancelling', 'Cancelling. This takes a few minutes.'],
    finalized: [record.recipientConfirmation ? 'Paid' : payer ? 'Delivered' : 'Received', record.recipientConfirmation ? 'The recipient confirmed receipt.' : payer ? 'Delivered. Waiting for the recipient to confirm.' : 'Arrived. Confirm that you received it.'],
    expired: ['Expired', 'It expired before it was sent. Nothing was paid.'],
    cancelled: ['Cancelled', 'Nothing was paid.'],
    'checker-refused': ['Not approved', record.checker?.reason ?? 'The payment checker did not approve it. Nothing was paid.'],
  };
  // A waiting send shows one plain sentence; an unknown status is never shown raw.
  const [label, detail] = s === 'accepted' && typeof record.waiting?.message === 'string' ? ['Waiting', record.waiting.message] : map[s] ?? ['Checking', 'We are confirming this payment.'];
  return { label, detail, final: ['finalized', 'expired', 'cancelled', 'checker-refused'].includes(s), needsMe: payer ? s === 'awaiting-signature' : s === 'finalized' && !record.recipientConfirmation };
}

import { canonical } from './identity.js';
export const TRADE_TERMS_RECOVERY_KEY = 'baink.trade-terms.recovery.v1';
export const TRADE_TERMS_RECOVERY_VERSION = 1;
export const TRADE_TERMS_RECOVERY_MAX_ENTRIES = 32;
export const TRADE_TERMS_RECOVERY_MAX_BYTES = 256 * 1024;
export const TRADE_TERMS_RECOVERY_UNAVAILABLE = 'recovery_unavailable';
export const TRADE_TERMS_RECOVERY_INVALID = 'recovery_invalid';
export const TRADE_TERMS_RECOVERY_REQUEST_INVALID = 'recovery_request_invalid';
export const TRADE_TERMS_RECOVERY_FULL = 'recovery_full';
export const TRADE_TERMS_RECOVERY_CONFLICT = 'recovery_conflict';
const MESSAGES = {
  [TRADE_TERMS_RECOVERY_UNAVAILABLE]:
    'Session storage is unavailable in this tab, so terms cannot be saved or sent safely. Existing terms can still be read.',
  [TRADE_TERMS_RECOVERY_INVALID]:
    'This tab’s terms recovery data could not be verified, so terms cannot be saved or sent safely. Existing terms can still be read.',
  [TRADE_TERMS_RECOVERY_REQUEST_INVALID]:
    'This request could not be kept safely for retry, so it was not sent.',
  [TRADE_TERMS_RECOVERY_FULL]:
    'This tab has no safe room to keep another unresolved terms request, so it was not sent. Resolve an earlier request or free session storage, then try again.',
  [TRADE_TERMS_RECOVERY_CONFLICT]:
    'Another terms request for this enquiry is still unresolved. Retry that exact request first.',
};
const ADDRESS = /^uain1[a-f0-9]{40}$/;
const PUBLIC_KEY = /^[A-Za-z0-9+/]{43}=$/;
const ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CLIENT = /^[A-Za-z0-9_-]{8,100}$/;
const PRICE = /^(0|[1-9][0-9]{0,14})(\.[0-9]{1,6})?$/;
const CANONICAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const enc = new TextEncoder();
const bytes = (value) => enc.encode(value).length;
export class TradeTermsRecoveryError extends Error {
  constructor(code) {
    super(MESSAGES[code]);
    this.name = 'TradeTermsRecoveryError';
    this.code = code;
  }
}
const refuse = (code) => {
  throw new TradeTermsRecoveryError(code);
};
function plain(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === null || Object.getPrototypeOf(prototype) === null) &&
    Reflect.ownKeys(value).every((key) => {
      const field = Object.getOwnPropertyDescriptor(value, key);
      return typeof key === 'string' && 'value' in field && field.enumerable;
    })
  );
}
// The allowlist is what keeps keys and identity objects out of storage.
const shaped = (value, required, optional = []) =>
  plain(value) &&
  required.every((key) => Object.hasOwn(value, key)) &&
  Reflect.ownKeys(value).every(
    (key) => required.includes(key) || optional.includes(key),
  );
const text = (value, max) =>
  typeof value === 'string' && value.trim() !== '' && bytes(value) <= max;
const id = (value) => typeof value === 'string' && ID.test(value);
const address = (value) => typeof value === 'string' && ADDRESS.test(value);
const whole = (value) => Number.isSafeInteger(value) && value >= 1;
const price = (value) =>
  typeof value === 'string' && PRICE.test(value) && /[1-9]/.test(value);
// Exact base units as text, so a price is never converted through a float.
const units = (value) => {
  const [integer, fraction = ''] = value.split('.');
  return (integer + fraction.padEnd(6, '0')).replace(/^0+/, '');
};
function time(value) {
  if (typeof value !== 'string' || !CANONICAL_TIME.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
const expiry = (value) => value === null || time(value);
const termsText = (value) =>
  text(value.scope, 2048) &&
  text(value.deliverables, 2048) &&
  text(value.timeline, 1024) &&
  text(value.acceptanceCriteria, 2048);
const TERMS = ['scope', 'deliverables', 'price', 'timeline', 'acceptanceCriteria'];
const validBodyTerms = (value) =>
  shaped(value, TERMS, ['expiresAt']) &&
  termsText(value) &&
  price(value.price) &&
  (!Object.hasOwn(value, 'expiresAt') || expiry(value.expiresAt));
const validReviewedTerms = (value) =>
  shaped(value, [...TERMS, 'priceUnits', 'currency', 'expiresAt']) &&
  termsText(value) &&
  price(value.price) &&
  value.priceUnits === units(value.price) &&
  value.currency === 'AI$' &&
  expiry(value.expiresAt);
const validEnquiry = (value) =>
  shaped(value, [
    'id',
    'kind',
    'offerId',
    'buyer',
    'seller',
    'message',
    'offer',
    'createdAt',
    'binding',
    'settlementAvailable',
  ]) &&
  id(value.id) &&
  value.kind === 'nonbinding-enquiry' &&
  id(value.offerId) &&
  address(value.buyer) &&
  address(value.seller) &&
  value.buyer !== value.seller &&
  text(value.message, 2000) &&
  time(value.createdAt) &&
  value.binding === false &&
  value.settlementAvailable === false &&
  shaped(value.offer, ['title', 'price', 'priceUnits', 'currency', 'revision']) &&
  text(value.offer.title, 160) &&
  price(value.offer.price) &&
  value.offer.priceUnits === units(value.offer.price) &&
  value.offer.currency === 'AI$' &&
  whole(value.offer.revision);
const validScope = (value) =>
  shaped(value, ['address', 'publicKeyBase64', 'enquiry']) &&
  address(value.address) &&
  typeof value.publicKeyBase64 === 'string' &&
  PUBLIC_KEY.test(value.publicKeyBase64) &&
  validEnquiry(value.enquiry) &&
  (value.address === value.enquiry.buyer ||
    value.address === value.enquiry.seller);
function validBody(kind, body) {
  if (kind === 'create')
    return (
      shaped(body, ['clientRequestId', 'terms']) && validBodyTerms(body.terms)
    );
  if (kind === 'update')
    return (
      shaped(body, ['clientRequestId', 'expectedRevision', 'terms']) &&
      whole(body.expectedRevision) &&
      validBodyTerms(body.terms)
    );
  return (
    shaped(body, ['clientRequestId', 'expectedRevision', 'confirmNonbinding']) &&
    whole(body.expectedRevision) &&
    body.confirmNonbinding === true
  );
}
const validRequest = (value) =>
  shaped(value, ['kind', 'draftId', 'body', 'reviewedTerms']) &&
  ['create', 'update', 'send'].includes(value.kind) &&
  (value.kind === 'create' ? value.draftId === null : id(value.draftId)) &&
  (value.kind === 'send'
    ? validReviewedTerms(value.reviewedTerms)
    : value.reviewedTerms === null) &&
  validBody(value.kind, value.body) &&
  typeof value.body.clientRequestId === 'string' &&
  CLIENT.test(value.body.clientRequestId);
const validEntry = (value) =>
  shaped(value, ['scope', 'request']) &&
  validScope(value.scope) &&
  validRequest(value.request);
function validBucket(value) {
  if (
    !shaped(value, ['version', 'entries']) ||
    value.version !== TRADE_TERMS_RECOVERY_VERSION ||
    !Array.isArray(value.entries) ||
    value.entries.length > TRADE_TERMS_RECOVERY_MAX_ENTRIES ||
    !value.entries.every(validEntry)
  )
    return false;
  const scopes = value.entries.map((entry) => canonical(entry.scope));
  return new Set(scopes).size === scopes.length;
}
/**
 * Session-scoped retry records for terms requests whose outcome is unknown.
 * Holds one request per exact signer and enquiry snapshot. Records are never
 * evicted or expired, and any doubt about the store throws instead of resetting
 * it, so unresolved work is never lost and nothing is sent without its record.
 */
export function createTradeTermsRecovery(storage) {
  function load() {
    if (!storage) refuse(TRADE_TERMS_RECOVERY_UNAVAILABLE);
    let raw;
    try {
      raw = storage.getItem(TRADE_TERMS_RECOVERY_KEY);
    } catch {
      refuse(TRADE_TERMS_RECOVERY_UNAVAILABLE);
    }
    if (raw === null) return { raw, entries: [] };
    if (
      typeof raw !== 'string' ||
      raw.length > TRADE_TERMS_RECOVERY_MAX_BYTES ||
      bytes(raw) > TRADE_TERMS_RECOVERY_MAX_BYTES
    )
      refuse(TRADE_TERMS_RECOVERY_INVALID);
    let bucket;
    try {
      bucket = JSON.parse(raw);
    } catch {
      refuse(TRADE_TERMS_RECOVERY_INVALID);
    }
    // The byte comparison also refuses duplicate keys that parsing would hide.
    if (!validBucket(bucket) || JSON.stringify(bucket) !== raw)
      refuse(TRADE_TERMS_RECOVERY_INVALID);
    return { raw, entries: bucket.entries };
  }
  function commit(previous, entries) {
    if (entries.length > TRADE_TERMS_RECOVERY_MAX_ENTRIES)
      refuse(TRADE_TERMS_RECOVERY_FULL);
    const next = JSON.stringify({
      version: TRADE_TERMS_RECOVERY_VERSION,
      entries,
    });
    if (bytes(next) > TRADE_TERMS_RECOVERY_MAX_BYTES)
      refuse(TRADE_TERMS_RECOVERY_FULL);
    try {
      storage.setItem(TRADE_TERMS_RECOVERY_KEY, next);
    } catch {
      refuse(TRADE_TERMS_RECOVERY_FULL);
    }
    let persisted;
    try {
      persisted = storage.getItem(TRADE_TERMS_RECOVERY_KEY);
    } catch {
      persisted = null;
    }
    if (persisted === next) return;
    // Put back the verified bytes. If that fails too, later reads refuse.
    try {
      if (previous === null) storage.removeItem(TRADE_TERMS_RECOVERY_KEY);
      else storage.setItem(TRADE_TERMS_RECOVERY_KEY, previous);
    } catch {}
    refuse(TRADE_TERMS_RECOVERY_UNAVAILABLE);
  }
  const checkedScope = (scope) => {
    if (!validScope(scope)) refuse(TRADE_TERMS_RECOVERY_INVALID);
    return canonical(scope);
  };
  const find = (entries, key) =>
    entries.find((entry) => canonical(entry.scope) === key);
  return {
    /** The exact retained request for this scope, or null when there is none. */
    read(scope) {
      const key = checkedScope(scope),
        entry = find(load().entries, key);
      return entry ? structuredClone(entry.request) : null;
    },
    /** Must return before any HTTP. The same request may be written again. */
    write(scope, request) {
      const key = checkedScope(scope);
      if (!validRequest(request))
        refuse(TRADE_TERMS_RECOVERY_REQUEST_INVALID);
      const { raw, entries } = load(),
        existing = find(entries, key);
      if (existing) {
        if (canonical(existing.request) !== canonical(request))
          refuse(TRADE_TERMS_RECOVERY_CONFLICT);
        return;
      }
      commit(raw, [...entries, { scope, request }]);
    },
    /** Removes only this clientRequestId, so an old response cannot clear a
     * newer request. Returns whether a record was removed. */
    clear(scope, clientRequestId) {
      const key = checkedScope(scope);
      if (typeof clientRequestId !== 'string' || !CLIENT.test(clientRequestId))
        refuse(TRADE_TERMS_RECOVERY_REQUEST_INVALID);
      const { raw, entries } = load(),
        existing = find(entries, key);
      if (existing?.request.body.clientRequestId !== clientRequestId)
        return false;
      commit(
        raw,
        entries.filter((entry) => entry !== existing),
      );
      return true;
    },
  };
}

// Codes where the service itself asks for this same request to be retried later.
export const TRADE_TERMS_RETRY_LATER_CODES = new Set(['trade_rate_limited', 'terms_rate_limited']);

/**
 * Whether a retained Trade terms request may be released so editing can go on.
 * An unrecognised error must never lock editing for good. The member may release
 * the retained copy only after a terms list read that finished after the last
 * failed attempt, so they have seen what the service actually holds. A
 * rate-limited request is not released: the service asked for the same retry.
 * Releasing never sends anything; if the earlier request did land, it shows in
 * the list like any other draft.
 */
export function canReleaseRetainedTerms({ retained, lastCode = null, readsAtFailure = 0, reads = 0, pending = false }) {
  if (!retained || pending) return false;
  if (TRADE_TERMS_RETRY_LATER_CODES.has(lastCode)) return false;
  return Number.isSafeInteger(reads) && Number.isSafeInteger(readsAtFailure) && reads > readsAtFailure;
}

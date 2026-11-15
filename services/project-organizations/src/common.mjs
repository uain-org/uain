/** Shared strict helpers for the 120-project organization service. */
import { createHash } from 'node:crypto';

export class OrganizationError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}
export const refuse = (code, message) => {
  throw new OrganizationError(code, message);
};
export const need = (condition, code, message) => {
  if (!condition) refuse(code, message);
};

/** Sorted-key JSON; the same canonical form the fund planner digests. */
export function canonical(value) {
  if (value === null || typeof value !== 'object') {
    need(value === null || ['string', 'boolean'].includes(typeof value) || Number.isSafeInteger(value), 'non_canonical_value');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  need(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'non_canonical_value');
  return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const digest = (value) => sha256(canonical(value));

export const HASH = /^[a-f0-9]{64}$/;
export const CATALOGUE_ID = /^OPP-[0-9]{5}$/;
export const NATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
export const ADDRESS = /^uain1[0-9a-f]{40}$/;
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
/** Native micro-AI$ units: canonical positive decimal string, at most the lifetime ceiling. */
export const UNITS_PER_AID = 1000000n;
export const LIFETIME_UNITS = 1000000000000000n;

export const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
/** Deterministic code-unit order (no locale), for sort(). */
export const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const exactKeys = (v, keys) => plain(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
export const text = (v, min, max) => typeof v === 'string' && v.trim().length >= min && Buffer.byteLength(v) <= max &&
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
export function units(value, { allowZero = false } = {}) {
  need(typeof value === 'string' && (allowZero ? /^(0|[1-9][0-9]{0,15})$/ : /^[1-9][0-9]{0,15}$/).test(value), 'invalid_amount');
  const n = BigInt(value);
  need(n <= LIFETIME_UNITS, 'invalid_amount');
  return n;
}
export const nativeProjectId = (catalogueId) => {
  need(CATALOGUE_ID.test(catalogueId), 'invalid_catalogue_id');
  return 'P-' + catalogueId;
};

/** Bounded strict JSON for exact native evidence: never silently repair ambiguity. */
export function parseStrictJSON(text, {maxBytes = 16384, maxDepth = 64} = {}) {
  need(typeof text === 'string' && text.isWellFormed() && Buffer.byteLength(text) > 0 && Buffer.byteLength(text) <= maxBytes, 'invalid_evidence');
  let value;
  try { value = JSON.parse(text); } catch { refuse('invalid_json'); }
  let i = 0;
  const ws = () => { while (i < text.length && /[\t\n\r ]/.test(text[i])) i++; };
  const string = () => {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i++] === '"') break;
    }
    const result = JSON.parse(text.slice(start, i));
    need(result.isWellFormed(), 'non_canonical_value');
    return result;
  };
  const walk = (depth) => {
    need(depth <= maxDepth, 'evidence_structure_over_limit'); ws(); const c = text[i];
    if (c === '"') { string(); return; }
    if (c === '{' || c === '[') {
      const object = c === '{', end = object ? '}' : ']', keys = new Set(); i++; ws();
      if (text[i] === end) { i++; return; }
      while (true) {
        if (object) { ws(); const key = string(); need(!keys.has(key), 'duplicate_key'); keys.add(key); ws(); i++; }
        walk(depth + 1); ws(); if (text[i] === end) { i++; return; } i++;
      }
    }
    const start = i;
    while (i < text.length && !/[\t\n\r ,}\]]/.test(text[i])) i++;
    const token = text.slice(start, i);
    need(['true', 'false', 'null'].includes(token) || (/^-?(0|[1-9][0-9]*)$/.test(token) && Number.isSafeInteger(Number(token))), 'non_canonical_value');
  };
  walk(0); ws(); need(i === text.length, 'invalid_json'); return value;
}

export function validateAttestationVersions(versions) {
  need(Array.isArray(versions) && versions.length >= 1 && versions.length <= 2 &&
    versions.every((v) => Number.isInteger(v) && [1, 2].includes(v)) && new Set(versions).size === versions.length, 'invalid_attestation_versions');
  return versions;
}

/** Independently configured native network; never selected by a submitted statement. */
export const FLEET_NATIVE_NETWORK = Object.freeze({chainId:'uain-shadow-20261008-1',genesisSha256:'54140a9243c4591ccc9f2e9d49543fc68b87b3e0045416174c232e9dd498f8ff'});
export function validateNativeNetwork(network) {
  need(exactKeys(network, ['chainId','genesisSha256']) && network.chainId === FLEET_NATIVE_NETWORK.chainId &&
    network.genesisSha256 === FLEET_NATIVE_NETWORK.genesisSha256, 'attestation_network_mismatch');
  return {...network};
}

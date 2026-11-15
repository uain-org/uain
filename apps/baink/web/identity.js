import { startWrite, requestReleaseCheck } from "./release-update.js";
const enc = new TextEncoder();
export const base64 = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)));
const decode = (value) =>
  Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
    c.charCodeAt(0),
  );
const base64url = (value) =>
  value.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const validAddress = (value) =>
  typeof value === 'string' && /^uain1[0-9a-f]{40}$/.test(value);
function seedBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value))
    throw Error('The identity key must be a canonical Ed25519 key.');
  const bytes = decode(value);
  if (bytes.length !== 32 || base64url(base64(bytes)) !== value)
    throw Error('The identity key must be a canonical Ed25519 key.');
  return bytes;
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
async function identityFromPair(privateKey, publicKey) {
  const raw = await crypto.subtle.exportKey('raw', publicKey);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  const address =
    'uain1' +
    Array.from(hash, (b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 40);
  return { privateKey, publicKey, publicKeyBase64: base64(raw), address };
}
export async function createIdentity() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ]);
  return identityFromPair(pair.privateKey, pair.publicKey);
}
export async function exportIdentity(identity) {
  const key = await crypto.subtle.exportKey('jwk', identity.privateKey);
  return JSON.stringify(
    {
      format: 'baink-identity-v2',
      algorithm: 'Ed25519',
      address: identity.address,
      public_key: base64url(identity.publicKeyBase64),
      private_key: key.d,
      created_at: new Date().toISOString(),
    },
    null,
    2,
  );
}
export async function importIdentity(text) {
  if (typeof text !== 'string' || text.length > 20000)
    throw Error('Choose a valid bounded BAINK or UAIN identity backup.');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw Error('Choose a valid BAINK or UAIN identity backup.');
  }
  if (!object(data))
    throw Error('Choose a valid BAINK or UAIN identity backup.');
  const native =
    data.algorithm === 'Ed25519' &&
    typeof data.private_key === 'string' &&
    typeof data.public_key === 'string';
  const legacy =
    data.format === 'baink-identity-v1' && data.privateKey?.d && data.publicKey;
  if (!native && !legacy)
    throw new Error('Choose a BAINK or UAIN Ed25519 identity backup file.');
  if (native) {
    seedBytes(data.private_key);
    seedBytes(data.public_key);
  }
  if (Object.hasOwn(data, 'address') && !validAddress(data.address))
    throw Error('The identity backup address is invalid.');
  const jwk = native
    ? {
        kty: 'OKP',
        crv: 'Ed25519',
        x: data.public_key,
        d: data.private_key,
        ext: true,
        key_ops: ['sign'],
      }
    : data.privateKey;
  const invalid = () => {
    throw new Error('The keys in this backup are invalid or do not match.');
  };
  const privateKey = await crypto.subtle
    .importKey('jwk', jwk, { name: 'Ed25519' }, true, ['sign'])
    .catch(invalid);
  const publicKey = await crypto.subtle
    .importKey(
      'raw',
      decode(native ? data.public_key : data.publicKey),
      { name: 'Ed25519' },
      true,
      ['verify'],
    )
    .catch(invalid);
  const check = enc.encode('BAINK identity backup validation');
  if (
    !(await crypto.subtle.verify(
      'Ed25519',
      publicKey,
      await crypto.subtle.sign('Ed25519', privateKey, check),
      check,
    ))
  )
    throw new Error('The keys in this backup do not match.');
  const identity = await identityFromPair(privateKey, publicKey);
  if (Object.hasOwn(data, 'address') && data.address !== identity.address)
    throw Error('The identity backup address does not match its keys.');
  return identity;
}
/** Holder-local login: native address plus a canonical32-byte base64url seed.
 * An optional publicKey uses that same encoding and must match the seed/address.
 * No private material is persisted or sent to an API by this helper.
 */
export async function importIdentityPair(credentials) {
  if (!object(credentials) || !validAddress(credentials.address))
    throw Error('A valid native identity address is required.');
  const { address, privateKey, publicKey } = credentials;
  const seed = seedBytes(privateKey);
  if (publicKey !== undefined) seedBytes(publicKey);
  // RFC8410 PKCS#8 PrivateKeyInfo wraps the32-byte Ed25519 seed. WebCrypto
  // derives its public component locally; no public-key lookup is needed.
  const pkcs8 = new Uint8Array(48);
  pkcs8.set([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
    0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
  pkcs8.set(seed, 16);
  try {
    const localKey = await crypto.subtle.importKey(
      'pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign'],
    );
    const derived = await crypto.subtle.exportKey('jwk', localKey);
    seedBytes(derived.x);
    if (publicKey !== undefined && publicKey !== derived.x)
      throw Error('The identity keys do not match.');
    return await importIdentity(JSON.stringify({
      algorithm: 'Ed25519', address,
      private_key: privateKey, public_key: derived.x,
    }));
  } catch (error) {
    if (error instanceof Error && /identity|match/.test(error.message))
      throw error;
    throw Error('This browser could not import the local Ed25519 identity.');
  } finally {
    seed.fill(0);
    pkcs8.fill(0);
  }
}
// Only the exact pre-authentication admission responses below permit a retry.
// A lost response, transport exception or downstream failure can follow a write.
const ownerRequests = new WeakMap();
export function cancelIdentityRequests(identity) {
  if (!identity) return;
  if (!ownerRequests.has(identity)) ownerRequests.set(identity, new AbortController());
  ownerRequests.get(identity).abort();
  // Keep this object cancelled: a late old-owner callback cannot revive it.
}
function admissionDelay(response, retry, waited, { maxWaitMs = 10000, capMs = Infinity } = {}) {
  let delay = Math.min(capMs, 250 * 2 ** retry + Math.floor(Math.random() * 250));
  const value = response.headers?.get('Retry-After');
  if (value !== null && value !== undefined) {
    let requested;
    if (/^\d+$/.test(value)) requested = Number(value) * 1000;
    else requested = Date.parse(value) - Date.now();
    if (!Number.isFinite(requested)) return null;
    delay = Math.max(delay, requested);
  }
  return delay <= maxWaitMs - waited ? delay : null;
}
function admissionWait(delay, signal) {
  return new Promise((resolve, reject) => {
    const cancelled = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancelled);
      reject(signal.reason ?? new DOMException('Request cancelled.', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancelled);
      resolve();
    }, delay);
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) cancelled();
  });
}
export async function api(path, {
  identity, method = 'GET', body, signal, isCurrent = () => true,
} = {}) {
  const finishWrite = method === 'GET' ? () => {} : startWrite();
  let dispatched = false, answered = true;
  try {
  let ownerSignal;
  if (identity) {
    if (!ownerRequests.has(identity)) ownerRequests.set(identity, new AbortController());
    ownerSignal = ownerRequests.get(identity).signal;
  }
  // A timeout cancels an ambiguous operation; it never authorizes a retry.
  const requestSignal = AbortSignal.any([
    AbortSignal.timeout(30_000),
    ...(signal ? [signal] : []),
    ...(ownerSignal ? [ownerSignal] : []),
  ]);
  const check = () => {
    requestSignal?.throwIfAborted();
    if (!isCurrent()) throw new DOMException('Request owner changed.', 'AbortError');
  };
  // Freeze the original intent and signer across waits; never recreate a move.
  const bodyText = method === 'GET' ? undefined : JSON.stringify(body || {});
  const signedBody = JSON.parse(bodyText ?? JSON.stringify(body || {}));
  const signer = identity && {
    privateKey: identity.privateKey, publicKeyBase64: identity.publicKeyBase64,
  };
  const audience = globalThis.location?.origin;
  // Only authenticated account and central proof reads wait for proof admission.
  // Other routes and every write retain their original retry policy.
  const accountRead = Boolean(identity) && method === 'GET' && path === '/api/account',
    centralRead = Boolean(identity) && method === 'GET' && (
      path === '/api/native/central/status' ||
      /^\/api\/native\/central\/tasks(?:\?[^#]*)?$/.test(path) ||
      /^\/api\/native\/central\/tasks\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(path)
    ),
    maxAttempts = centralRead ? 12 : accountRead ? 9 : 5,
    admissionPolicy = centralRead ? { maxWaitMs: 24000, capMs: 3000 }
      : accountRead ? { maxWaitMs: 18000, capMs: 3000 } : undefined;
  let waited = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    check();
    const headers = { 'Content-Type': 'application/json' };
    if (signer) {
      const nonce = base64(crypto.getRandomValues(new Uint8Array(24)))
        .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
      const timestamp = String(Date.now());
      const payload = { audience, method, path, body: signedBody, nonce, timestamp };
      const signature = await crypto.subtle.sign(
        'Ed25519', signer.privateKey, enc.encode(canonical(payload)),
      );
      check();
      Object.assign(headers, {
        'X-BAINK-Public-Key': signer.publicKeyBase64,
        'X-BAINK-Nonce': nonce,
        'X-BAINK-Timestamp': timestamp,
        'X-BAINK-Signature': base64(signature),
      });
    }
    check();
    dispatched = true; answered = false;
    const response = await fetch(
      `${(import.meta.env?.BASE_URL || '/').replace(/\/$/, '')}${path}`,
      { method, headers, ...(requestSignal ? { signal: requestSignal } : {}),
        ...(method !== 'GET' ? { body: bodyText } : {}) },
    );
    let parseFailed = false;
    const data = await response.json().catch(() => { parseFailed = true; requestReleaseCheck(); return {}; });
    answered = !parseFailed && response.status < 500;
    check();
    if (response.ok) return data;
    const error = new Error(data.error?.message || 'The service could not complete this request.');
    error.code = data.error?.code;
    error.status = response.status;
    const refused = (response.status === 503 && error.code === 'busy') ||
      (response.status === 429 && error.code === 'client_busy');
    const delay = refused && attempt < maxAttempts - 1
      ? admissionDelay(response, attempt, waited, admissionPolicy) : null;
    // A structured refusal can be an old tab speaking to a newer server. Look for a
    // changed build (read-only, throttled); this never retries or resends the request.
    if (delay === null) { requestReleaseCheck(); throw error; }
    await admissionWait(delay, requestSignal);
    waited += delay;
  }
  } catch (error) {
    if (dispatched && !answered) requestReleaseCheck();
    // A dropped connection (often a release restarting the service) reads as plain text,
    // never a bare "Failed to fetch". It never authorizes a retry of a write.
    if (error instanceof TypeError && dispatched && !answered) {
      const dropped = new Error(`The connection to BAINK dropped, often because a new version is starting. Wait a few seconds, then try again or use Check status. (${error.message || 'network error'})`, { cause: error });
      dropped.code = 'network_unavailable';
      throw dropped;
    }
    throw error;
  } finally { finishWrite(dispatched && !answered); }
}

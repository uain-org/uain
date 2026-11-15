/**
 * One administrator, a password, and a session cookie.
 *
 * - The password is stored only as an scrypt hash:
 *   `scrypt$N$r$p$saltB64$hashB64`, N at least 16384.
 * - A session is a random id the server keeps in memory, sent to the browser
 *   in a cookie signed with HMAC-SHA256. Signing means a cookie cannot be
 *   forged or altered; keeping the id means logging out, or restarting the
 *   container, ends it for good. It lasts twelve hours from sign-in.
 * - Failed sign-ins are counted per client address (an IPv6 address by its
 *   /64), and across all addresses together.
 */
import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { isIPv6 } from 'node:net';

export const MIN_N = 16384;
const MAX_N = 2 ** 20;
export const DEFAULT_PARAMS = { N: 65536, r: 8, p: 1 };
const SALT_BYTES = 16;
const KEY_BYTES = 64;
/** Longer input is refused before hashing: nobody's password is a megabyte. */
const MAX_PASSWORD_BYTES = 1024;

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function validParams(N, r, p) {
  return (
    Number.isSafeInteger(N) &&
    N >= MIN_N &&
    N <= MAX_N &&
    (N & (N - 1)) === 0 &&
    Number.isSafeInteger(r) &&
    r >= 1 &&
    r <= 32 &&
    Number.isSafeInteger(p) &&
    p >= 1 &&
    p <= 16
  );
}

function scryptAsync(password, salt, keylen, { N, r, p }) {
  return new Promise((resolve, reject) => {
    // Node refuses anything over 32 MiB unless told otherwise; N=65536, r=8
    // needs 64 MiB.
    const maxmem = 128 * N * r * 2 + 16 * 1024 * 1024;
    scrypt(password, salt, keylen, { N, r, p, maxmem }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

const normalise = (password) => Buffer.from(password.normalize('NFC'), 'utf8');

export async function hashPassword(password, params = {}) {
  const { N, r, p } = { ...DEFAULT_PARAMS, ...params };
  if (typeof password !== 'string' || password.length === 0)
    throw new Error('the password is empty');
  if (Buffer.byteLength(password) > MAX_PASSWORD_BYTES)
    throw new Error(`the password is longer than ${MAX_PASSWORD_BYTES} bytes`);
  if (!validParams(N, r, p))
    throw new Error(
      `scrypt parameters out of range: N must be a power of two from ${MIN_N}`,
    );
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(normalise(password), salt, KEY_BYTES, {
    N,
    r,
    p,
  });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** The parts of a stored hash, or null when it is malformed or too weak. */
export function parsePasswordHash(text) {
  if (typeof text !== 'string') return null;
  const parts = text.trim().split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = parts
    .slice(1, 4)
    .map((x) => (/^\d{1,8}$/.test(x) ? Number(x) : NaN));
  if (!validParams(N, r, p)) return null;
  if (!BASE64.test(parts[4]) || !BASE64.test(parts[5])) return null;
  const salt = Buffer.from(parts[4], 'base64');
  const hash = Buffer.from(parts[5], 'base64');
  if (salt.length < 16 || hash.length < 32 || hash.length > 128) return null;
  return { N, r, p, salt, hash };
}

export async function verifyPassword(password, stored) {
  const parsed =
    typeof stored === 'string' ? parsePasswordHash(stored) : stored;
  if (!parsed || typeof password !== 'string' || password.length === 0)
    return false;
  if (Buffer.byteLength(password) > MAX_PASSWORD_BYTES) return false;
  const key = await scryptAsync(
    normalise(password),
    parsed.salt,
    parsed.hash.length,
    parsed,
  );
  return timingSafeEqual(key, parsed.hash);
}

/** Equal strings, compared in constant time. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const mac = (secret, text) =>
  createHmac('sha256', secret).update(text).digest('base64url');

/**
 * Signed-in sessions, held in memory. At most `max` at a time; past that the
 * oldest goes first.
 */
export class Sessions {
  constructor({ secret, ttlMs = SESSION_TTL_MS, now = Date.now, max = 50 }) {
    if (!secret || Buffer.byteLength(secret) < 32)
      throw new Error('the session secret must be at least 32 bytes');
    this.secret = secret;
    this.ttlMs = ttlMs;
    this.now = now;
    this.max = max;
    /** @type {Map<string, {expires: number, csrf: string}>} */
    this.live = new Map();
  }

  #sign(sid, expires) {
    return mac(this.secret, `wl-session.v1.${sid}.${expires}`);
  }

  #prune() {
    const now = this.now();
    for (const [sid, s] of this.live)
      if (s.expires <= now) this.live.delete(sid);
    while (this.live.size >= this.max)
      this.live.delete(this.live.keys().next().value);
  }

  /** A new session: the cookie value, and the CSRF token its forms carry. */
  create() {
    this.#prune();
    const sid = randomBytes(32).toString('base64url');
    const expires = this.now() + this.ttlMs;
    const csrf = randomBytes(32).toString('base64url');
    this.live.set(sid, { expires, csrf });
    return {
      token: `${sid}.${expires}.${this.#sign(sid, expires)}`,
      sid,
      expires,
      csrf,
    };
  }

  /** The session a cookie value names, or null if forged, altered, expired or ended. */
  verify(token) {
    if (typeof token !== 'string' || token.length > 200) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [sid, exp, sig] = parts;
    if (!BASE64URL.test(sid) || !/^\d{1,15}$/.test(exp) || !BASE64URL.test(sig))
      return null;
    if (!safeEqual(sig, this.#sign(sid, exp))) return null;
    const expires = Number(exp);
    if (expires <= this.now()) {
      this.live.delete(sid);
      return null;
    }
    const s = this.live.get(sid);
    if (!s || s.expires !== expires) return null;
    return { sid, expires, csrf: s.csrf };
  }

  destroy(sid) {
    this.live.delete(sid);
  }

  /**
   * The sign-in form's CSRF token. The form has no session yet, so the token
   * is bound instead to a random value in a cookie of its own: a page on
   * another site can neither read that cookie nor compute the token.
   */
  loginToken(nonce) {
    return mac(this.secret, `wl-login.v1.${nonce}`);
  }

  checkLoginToken(nonce, token) {
    if (
      typeof nonce !== 'string' ||
      !BASE64URL.test(nonce) ||
      nonce.length > 100
    )
      return false;
    return safeEqual(token, this.loginToken(nonce));
  }
}

/**
 * The key a client address is counted under. An IPv6 caller holds a whole /64,
 * so counting each address separately gave it 2^64 fresh allowances: the key
 * is the first four groups, however the address is spelled.
 */
export function limiterKey(address) {
  const text = String(address ?? '')
    .trim()
    .replace(/%.*$/, '')
    .replace(/^::ffff:/i, '');
  if (!isIPv6(text)) return text;
  // A dotted IPv4 tail (64:ff9b::192.0.2.1) is two groups.
  const v4 = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  const full = v4
    ? v4[1] +
      ((Number(v4[2]) << 8) | Number(v4[3])).toString(16) +
      ':' +
      ((Number(v4[4]) << 8) | Number(v4[5])).toString(16)
    : text;
  const [head, tail] = full.split('::');
  const left = head ? head.split(':') : [];
  const right = tail === undefined ? [] : tail ? tail.split(':') : [];
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':')}::/64`;
}

/**
 * Failed sign-ins per client address: `limit` in `windowMs`, then refused
 * until the oldest falls out of the window. `globalLimit` is the same
 * ceiling over every address together: each failed attempt costs one scrypt
 * (64 MiB), so a spread of addresses must not be free to keep the process
 * hashing. When it is reached every other address is refused until the window
 * moves on; the address (or /64) of the last successful sign-in is bound by
 * its own limit only: the ceiling caps guessing without
 * keeping the administrator out.
 *
 * An attempt is counted before the password is checked and forgiven if it
 * was right. Counting only after the check would let a burst of parallel
 * guesses all pass the gate before the first one was recorded.
 */
export class FailureLimiter {
  constructor({
    limit = 10,
    windowMs = 15 * 60 * 1000,
    now = Date.now,
    maxKeys = 10000,
    globalLimit = 100,
  } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.maxKeys = maxKeys;
    this.globalLimit = globalLimit;
    /** @type {Map<string, number[]>} */
    this.hits = new Map();
    /** @type {{ t: number, key: string }[]} */
    this.all = [];
    /** The key of the last successful sign-in: exempt from the global ceiling only. */
    this.trusted = null;
  }

  #recent(key) {
    const since = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  #recentAll() {
    const since = this.now() - this.windowMs;
    this.all = this.all.filter((e) => e.t > since);
    return this.all;
  }

  /** Whether this address is locked out, and for how many seconds more. */
  check(address) {
    const key = limiterKey(address);
    const list = this.#recent(key);
    const all = this.#recentAll();
    const own = list.length >= this.limit;
    const shared = all.length >= this.globalLimit && key !== this.trusted;
    if (!own && !shared) return { blocked: false, retryAfter: 0, scope: null };
    const oldest = Math.max(own ? list[0] : 0, shared ? all[0].t : 0);
    const retryAfter = Math.max(
      1,
      Math.ceil((oldest + this.windowMs - this.now()) / 1000),
    );
    return { blocked: true, retryAfter, scope: own ? 'address' : 'all' };
  }

  fail(address) {
    const key = limiterKey(address);
    const list = this.#recent(key);
    const t = this.now();
    list.push(t);
    this.hits.delete(key);
    this.hits.set(key, list);
    this.#recentAll().push({ t, key });
    while (this.hits.size > this.maxKeys)
      this.hits.delete(this.hits.keys().next().value);
  }

  /** Forgives the attempt just counted and any before it: the password was right. */
  reset(address) {
    const key = limiterKey(address);
    this.hits.delete(key);
    this.all = this.all.filter((e) => e.key !== key);
    this.trusted = key;
  }
}

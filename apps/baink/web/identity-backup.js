// Passphrase-encrypted identity backup (`baink-identity-backup-v1`).
//
// The identity is the member signing key: it proves who you are. This file
// encrypts the plain `baink-identity-v2` JSON with a key derived from your
// passphrase, so a copied backup reveals nothing but your public address.
//
// Works unchanged in browsers and Node 22 (WebCrypto only, no imports):
//   PBKDF2-SHA256, 600,000 iterations, 16-byte salt -> 64 bytes
//   bytes 0-31: AES-256-GCM key (12-byte IV); bytes 32-63: HMAC key check
// The header (everything but the ciphertext) is the AEAD associated data, so
// it cannot be edited. The key check tells a wrong passphrase from a damaged
// file. The agent kit (`agent-kit/uain-agent.mjs`) carries an identical copy.

export const IDENTITY_BACKUP_SCHEMA = 'baink-identity-backup-v1';
export const MIN_PASSPHRASE = 12;
const ITERATIONS = 600000;
const enc = new TextEncoder(), dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;
const b64 = (bytes) => { let s = ''; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64 = (text) => { if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) throw backupError('corrupt'); const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4)); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };

const MESSAGES = {
  weak: `Use a backup passphrase of at least ${MIN_PASSPHRASE} characters.`,
  wrong: 'Wrong backup passphrase.',
  corrupt: 'This identity backup is damaged or is not a BAINK identity backup.',
};
export function backupError(code) { const e = new Error(MESSAGES[code]); e.code = 'IDENTITY_BACKUP_' + code.toUpperCase(); return e; }

function passphraseBytes(passphrase) {
  if (typeof passphrase !== 'string') throw backupError('weak');
  const normal = passphrase.normalize('NFKC');
  if ([...normal].length < MIN_PASSPHRASE) throw backupError('weak');
  return enc.encode(normal);
}
async function derive(passphrase, salt, iterations) {
  const base = await subtle().importKey('raw', passphraseBytes(passphrase), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 512));
  const key = await subtle().importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const mac = await subtle().importKey('raw', bits.slice(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  bits.fill(0);
  const check = new Uint8Array(await subtle().sign('HMAC', mac, enc.encode('baink-identity-backup-key-check-v1'))).slice(0, 16);
  return { key, check };
}
const headerOf = (h) => enc.encode(JSON.stringify({ schema: h.schema, address: h.address, kdf: h.kdf, cipher: h.cipher, iv: h.iv, keyCheck: h.keyCheck, createdAt: h.createdAt }));

/** Encrypt a plain identity JSON string. Returns the backup file text. */
export async function encryptIdentityBackup(identityText, passphrase, { iterations = ITERATIONS, now = () => new Date().toISOString() } = {}) {
  const identity = JSON.parse(identityText);
  if (identity?.algorithm !== 'Ed25519' || !/^uain1[a-f0-9]{40}$/.test(identity.address ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(identity.private_key ?? '')) throw new Error('Only a BAINK Ed25519 identity can be backed up.');
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16)), iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const { key, check } = await derive(passphrase, salt, iterations);
  const header = { schema: IDENTITY_BACKUP_SCHEMA, address: identity.address, kdf: { name: 'pbkdf2-sha256', iterations, salt: b64(salt) }, cipher: 'aes-256-gcm', iv: b64(iv), keyCheck: b64(check), createdAt: now() };
  const plain = enc.encode(identityText);
  const sealed = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: headerOf(header) }, key, plain);
  plain.fill(0);
  return JSON.stringify({ ...header, ciphertext: b64(sealed) }, null, 2) + '\n';
}

export function isIdentityBackup(text) {
  try { return JSON.parse(text)?.schema === IDENTITY_BACKUP_SCHEMA; } catch { return false; }
}
/** Public address recorded in the backup header (readable without the passphrase). */
export function identityBackupAddress(text) {
  try { const v = JSON.parse(text); return v?.schema === IDENTITY_BACKUP_SCHEMA && /^uain1[a-f0-9]{40}$/.test(v.address) ? v.address : null; } catch { return null; }
}

/** Decrypt a backup. Returns the plain identity JSON string. */
export async function decryptIdentityBackup(backupText, passphrase) {
  let v;
  try { v = JSON.parse(backupText); } catch { throw backupError('corrupt'); }
  const keys = ['schema', 'address', 'kdf', 'cipher', 'iv', 'keyCheck', 'createdAt', 'ciphertext'];
  if (!v || typeof v !== 'object' || Object.keys(v).length !== keys.length || !keys.every((k) => Object.hasOwn(v, k)) || v.schema !== IDENTITY_BACKUP_SCHEMA || v.cipher !== 'aes-256-gcm' || v.kdf?.name !== 'pbkdf2-sha256' || !Number.isSafeInteger(v.kdf.iterations) || v.kdf.iterations < 100000 || v.kdf.iterations > 10000000) throw backupError('corrupt');
  const salt = unb64(v.kdf.salt), iv = unb64(v.iv), check = unb64(v.keyCheck), sealed = unb64(v.ciphertext);
  if (salt.length !== 16 || iv.length !== 12 || check.length !== 16 || sealed.length < 17) throw backupError('corrupt');
  let derived;
  try { derived = await derive(passphrase, salt, v.kdf.iterations); } catch (e) { if (e.code === 'IDENTITY_BACKUP_WEAK') throw backupError('wrong'); throw e; }
  let same = 0; for (let i = 0; i < 16; i++) same |= derived.check[i] ^ check[i];
  if (same) throw backupError('wrong');
  let plain;
  try { plain = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: headerOf(v) }, derived.key, sealed)); } catch { throw backupError('corrupt'); }
  const text = dec.decode(plain); plain.fill(0);
  let identity; try { identity = JSON.parse(text); } catch { throw backupError('corrupt'); }
  if (identity?.address !== v.address) throw backupError('corrupt');
  return text;
}

/** Why this pair of passphrase entries cannot lock a backup yet, in plain words; '' when it can.
 * The Account page and sign-up both refuse to hand out the key until this is ''. */
export function accountBackupProblem(passphrase, repeat) {
  if (typeof passphrase !== 'string' || [...passphrase.normalize('NFKC')].length < MIN_PASSPHRASE) return `Choose a backup passphrase of at least ${MIN_PASSPHRASE} characters.`;
  return passphrase === repeat ? '' : 'The two passphrases differ.';
}

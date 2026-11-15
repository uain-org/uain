/** No-install receiving in the browser (W4). The same derivation as the
 * uain-agent kit (agent-kit/uain-agent.mjs receivingViewingKey): the Orchard
 * spending key is SHA-256 over a domain-separated Ed25519 signature by this
 * member key (deterministic), so the identity backup restores it. Only the raw
 * full viewing key ak || nk || rivk (Zcash spec 4.2.3, orchard 0.16.0) leaves
 * the browser, signed; the custody tool derives the address and the custody
 * checker checks the signature again. The signature and spending key are never
 * stored, shown or sent. */
import { nativeCanonicalJSON as canonical } from './native-financial.js';

const M64 = (1n << 64n) - 1n;
const B2B_IV = [0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n, 0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n];
const B2B_SIGMA = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3], [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4], [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8], [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13], [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9], [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11], [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10], [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5], [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0]];
const leU64 = (b, o) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]); return v; };
const rotr = (x, n) => ((x >> BigInt(n)) | (x << BigInt(64 - n))) & M64;
/** BLAKE2b-512 with a 16-byte personalization (unkeyed, no salt). */
export function blake2b512(data, personal = new Uint8Array(16)) {
  const h = B2B_IV.slice();
  h[0] ^= 0x01010040n; // digest 64, key 0, fanout 1, depth 1
  h[6] ^= leU64(personal, 0); h[7] ^= leU64(personal, 8);
  const blocks = Math.max(1, Math.ceil(data.length / 128));
  for (let b = 0; b < blocks; b++) {
    const block = new Uint8Array(128); block.set(data.subarray(b * 128, b * 128 + 128));
    const last = b === blocks - 1, t = BigInt(last ? data.length : (b + 1) * 128);
    const m = Array.from({ length: 16 }, (_, i) => leU64(block, i * 8));
    const v = [...h, ...B2B_IV];
    v[12] ^= t & M64; v[13] ^= t >> 64n; if (last) v[14] ^= M64;
    const g = (a, bb, c, d, x, y) => {
      v[a] = (v[a] + v[bb] + x) & M64; v[d] = rotr(v[d] ^ v[a], 32);
      v[c] = (v[c] + v[d]) & M64; v[bb] = rotr(v[bb] ^ v[c], 24);
      v[a] = (v[a] + v[bb] + y) & M64; v[d] = rotr(v[d] ^ v[a], 16);
      v[c] = (v[c] + v[d]) & M64; v[bb] = rotr(v[bb] ^ v[c], 63);
    };
    for (let r = 0; r < 12; r++) {
      const s = B2B_SIGMA[r % 10];
      g(0, 4, 8, 12, m[s[0]], m[s[1]]); g(1, 5, 9, 13, m[s[2]], m[s[3]]); g(2, 6, 10, 14, m[s[4]], m[s[5]]); g(3, 7, 11, 15, m[s[6]], m[s[7]]);
      g(0, 5, 10, 15, m[s[8]], m[s[9]]); g(1, 6, 11, 12, m[s[10]], m[s[11]]); g(2, 7, 8, 13, m[s[12]], m[s[13]]); g(3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
  }
  const out = new Uint8Array(64);
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) out[i * 8 + j] = Number((h[i] >> BigInt(8 * j)) & 0xffn);
  return out;
}
const PALLAS_P = 0x40000000000000000000000000000000224698fc094cf91b992d30ed00000001n; // base field q_P
const PALLAS_R = 0x40000000000000000000000000000000224698fc0994a8dd8c46eb2100000001n; // group order r_P
const leInt = (b) => { let v = 0n; for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]); return v; };
const le32 = (v) => { const out = new Uint8Array(32); for (let i = 0; i < 32; i++) { out[i] = Number(v & 0xffn); v >>= 8n; } return out; };
const md = (a) => ((a % PALLAS_P) + PALLAS_P) % PALLAS_P;
const inv = (a) => { let r = 1n, b = md(a), e = PALLAS_P - 2n; while (e) { if (e & 1n) r = r * b % PALLAS_P; b = b * b % PALLAS_P; e >>= 1n; } return r; };
// Jacobian points on y^2 = x^3 + 5; Z = 0 is the identity.
const dbl = ([X, Y, Z]) => {
  if (Z === 0n || Y === 0n) return [0n, 1n, 0n];
  const A = X * X % PALLAS_P, B = Y * Y % PALLAS_P, C = B * B % PALLAS_P;
  const D = md(2n * (md((X + B) * (X + B) - A - C)));
  const E = 3n * A % PALLAS_P, F = E * E % PALLAS_P;
  const X3 = md(F - 2n * D), Y3 = md(E * md(D - X3) - 8n * C), Z3 = md(2n * Y * Z);
  return [X3, Y3, Z3];
};
const add = (P, Q) => {
  if (P[2] === 0n) return Q; if (Q[2] === 0n) return P;
  const [X1, Y1, Z1] = P, [X2, Y2, Z2] = Q;
  const Z1Z1 = Z1 * Z1 % PALLAS_P, Z2Z2 = Z2 * Z2 % PALLAS_P;
  const U1 = X1 * Z2Z2 % PALLAS_P, U2 = X2 * Z1Z1 % PALLAS_P;
  const S1 = Y1 * Z2 % PALLAS_P * Z2Z2 % PALLAS_P, S2 = Y2 * Z1 % PALLAS_P * Z1Z1 % PALLAS_P;
  if (U1 === U2) return S1 === S2 ? dbl(P) : [0n, 1n, 0n];
  const H = md(U2 - U1), I = 4n * H * H % PALLAS_P, J = H * I % PALLAS_P, r = md(2n * (S2 - S1)), V = U1 * I % PALLAS_P;
  const X3 = md(r * r - J - 2n * V), Y3 = md(r * md(V - X3) - 2n * S1 * J), Z3 = md(md((Z1 + Z2) * (Z1 + Z2) - Z1Z1 - Z2Z2) * H);
  return [X3, Y3, Z3];
};
const affine = ([X, Y, Z]) => { const zi = inv(Z), z2 = zi * zi % PALLAS_P; return [X * z2 % PALLAS_P, Y * z2 % PALLAS_P * zi % PALLAS_P]; };
// SpendAuthG = GroupHash^P("z.cash:Orchard", "G"), orchard constants/fixed_bases/spend_auth_g.rs.
const SPEND_AUTH_G = [leInt(Uint8Array.from([99, 201, 117, 184, 132, 114, 26, 141, 12, 161, 112, 123, 227, 12, 127, 12, 95, 68, 95, 62, 124, 24, 141, 59, 6, 214, 241, 40, 179, 35, 85, 55])), leInt(Uint8Array.from([201, 59, 12, 123, 129, 62, 227, 76, 216, 189, 5, 192, 254, 20, 201, 223, 251, 36, 214, 254, 252, 188, 16, 123, 219, 102, 26, 223, 127, 53, 208, 26])), 1n];
const PERSONAL_EXPAND = new TextEncoder().encode('Zcash_ExpandSeed');
const prfExpand = (sk, t) => { const m = new Uint8Array(33); m.set(sk); m[32] = t; return blake2b512(m, PERSONAL_EXPAND); };
/** Raw Orchard full viewing key (96 bytes) for a 32-byte spending key, or null
 * when ask = 0. The ivk validity check needs Sinsemilla, so BAINK's tool
 * (FullViewingKey::from_bytes) refuses the rare invalid key; draw again then. */
export function orchardFullViewingKey(sk) {
  if (!(sk instanceof Uint8Array) || sk.length !== 32) throw new Error('32-byte Orchard spending key required');
  const ask = leInt(prfExpand(sk, 0x06)) % PALLAS_R;
  if (ask === 0n) return null;
  let [x, y] = [0n, 0n], acc = [0n, 1n, 0n];
  for (let i = 254; i >= 0; i--) { acc = dbl(acc); if ((ask >> BigInt(i)) & 1n) acc = add(acc, SPEND_AUTH_G); }
  [x, y] = affine(acc);
  if (y * y % PALLAS_P !== md(x * x % PALLAS_P * x + 5n)) throw new Error('Orchard key derivation failed');
  // ak is the x-coordinate with y-sign 0 (ask is negated when it is odd); same x.
  const nk = leInt(prfExpand(sk, 0x07)) % PALLAS_P, rivk = leInt(prfExpand(sk, 0x08)) % PALLAS_R;
  const out = new Uint8Array(96); out.set(le32(x), 0); out.set(le32(nk), 32); out.set(le32(rivk), 64);
  return out;
}

const enc = new TextEncoder();
export const ORCHARD_RECEIVING_DOMAIN = 'BAINK/orchard-receiving-key/v1\0';
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

export async function receivingViewingKey(identity) {
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', identity.privateKey, enc.encode(ORCHARD_RECEIVING_DOMAIN + identity.address)));
  const seed = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array([...enc.encode('BAINK/orchard-receiving-key/derive/v1\0'), ...signature])));
  signature.fill(0);
  const fvk = orchardFullViewingKey(seed); seed.fill(0);
  if (!fvk) throw Error('This member key gives no valid receiving key; use an AI$ wallet address instead.');
  return hex(fvk);
}

/** Body for POST /api/native/receiving-key. */
export async function signReceivingKey(identity, { chainId }) {
  if (typeof chainId !== 'string' || !chainId) throw Error('The network is not proven yet.');
  const fullViewingKey = await receivingViewingKey(identity);
  const bytes = enc.encode('BAINK/receiving-key/v1\0' + canonical({ member: identity.address, fullViewingKey, chainId }));
  return { fullViewingKey, signature: b64url(new Uint8Array(await crypto.subtle.sign('Ed25519', identity.privateKey, bytes))) };
}

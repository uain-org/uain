/**
 * Proving that a wallet address belongs to a member (white paper 5.2: "a
 * unique Ethereum and Solana address tied to the profile, used to receive
 * bounty payments"; decision D6, 30 September 2026).
 *
 * The member binds its own addresses. UAIN never generates, holds or sees a
 * wallet's private key, and never moves funds (decision 1.4). The member
 * proves each address by signing a UAIN challenge with that address's own key,
 * using its own wallet tooling, and this checks the signature:
 *
 * - Ethereum: an EIP-191 personal_sign signature. The signer is recovered
 *   with secp256k1 from keccak256("\x19Ethereum Signed Message:\n" + the
 *   message's length in bytes + the message), and must be the address.
 *   Addresses are EIP-55: mixed case must carry a correct checksum.
 * - Solana: an Ed25519 signature over the message's UTF-8 bytes, checked
 *   against the address, which is the base58 of the 32-byte public key.
 *
 * Pure: no database, no network, no keys. application/wallets.ts stores what
 * this accepts. Nothing here pays anything: bounties are still credits.
 */
import { createPublicKey, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

export const CHAINS = ['ethereum', 'solana'] as const;
export type Chain = (typeof CHAINS)[number];
export const isChain = (value: unknown): value is Chain => CHAINS.includes(value as Chain);

/** How long a challenge may be answered, from when it was issued. */
export const CHALLENGE_TTL_MS = 10 * 60_000;

/** Said wherever a member's wallets are served. */
export const WALLETS_NOTE =
  'Bound by the member, proven by signature; UAIN holds no keys or funds and pays no bounties ' +
  'to these addresses yet.';

/* ------------------------------------------------------------------ base58 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const DIGIT = new Map([...ALPHABET].map((c, i) => [c, i]));

/** Base58, Bitcoin's alphabet, as Solana writes keys and signatures. */
export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = []; // base 58, least significant first
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  return '1'.repeat(zeros) + digits.reverse().map((d) => ALPHABET[d]).join('');
}

/** The bytes a base58 string stands for, or null if it is not base58. */
export function base58Decode(text: string): Uint8Array | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 200) return null;
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;
  const bytes: number[] = []; // base 256, least significant first
  for (const c of text) {
    const value = DIGIT.get(c);
    if (value === undefined) return null;
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes.reverse()]);
}

/* --------------------------------------------------------------- addresses */

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** EIP-55: the address with each letter upper-cased where its nibble of keccak256(lower-case hex) is 8 or more. */
export function toChecksumAddress(address: string): string {
  const lower = address.replace(/^0x/i, '').toLowerCase();
  const hash = keccak_256(utf8(lower));
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    const nibble = (hash[i >> 1] >> (i % 2 === 0 ? 4 : 0)) & 0x0f;
    out += nibble >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

export type AddressError = 'bad_address' | 'bad_checksum';
export type AddressResult = { address: string; error?: never } | { error: AddressError; address?: never };

/**
 * An address as it is stored and signed for: Ethereum in EIP-55 form, Solana
 * as the canonical base58 of 32 bytes. An Ethereum address in mixed case must
 * carry a correct checksum; all lower or all upper case carries none, as
 * EIP-55 allows, and is accepted and written in EIP-55 form. The signature,
 * not the checksum, is what proves the address.
 */
export function normalizeAddress(chain: Chain, input: unknown): AddressResult {
  if (typeof input !== 'string') return { error: 'bad_address' };
  if (chain === 'ethereum') {
    if (!/^0x[0-9a-fA-F]{40}$/.test(input)) return { error: 'bad_address' };
    const body = input.slice(2);
    const checksummed = toChecksumAddress(input);
    const unchecked = body === body.toLowerCase() || body === body.toUpperCase();
    if (!unchecked && input !== checksummed) return { error: 'bad_checksum' };
    return { address: checksummed };
  }
  const bytes = base58Decode(input);
  if (!bytes || bytes.length !== 32 || base58Encode(bytes) !== input) return { error: 'bad_address' };
  return { address: input };
}

/* --------------------------------------------------------------- challenge */

export interface Challenge {
  member: string;
  chain: Chain;
  wallet: string;
  audience: string;
  nonce: string;
  issued: string;
}

/** Exactly what the wallet signs. */
export const challengeMessage = (c: Challenge): string =>
  [
    'UAIN wallet binding',
    `member: ${c.member}`,
    `chain: ${c.chain}`,
    `wallet: ${c.wallet}`,
    `audience: ${c.audience}`,
    `nonce: ${c.nonce}`,
    `issued: ${c.issued}`,
  ].join('\n');

const MESSAGE =
  /^UAIN wallet binding\nmember: (uain1[0-9a-f]{40})\nchain: (ethereum|solana)\nwallet: ([0-9A-Za-z]{32,44})\naudience: (https?:\/\/[^\s]{1,200})\nnonce: ([0-9a-f]{32})\nissued: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;

/** A challenge message read back, or null if it is not one, byte for byte. */
export function parseChallenge(message: unknown): Challenge | null {
  if (typeof message !== 'string' || message.length > 1000) return null;
  const m = MESSAGE.exec(message);
  if (!m) return null;
  const [, member, chain, wallet, audience, nonce, issued] = m;
  const c = { member, chain: chain as Chain, wallet, audience, nonce, issued };
  return challengeMessage(c) === message ? c : null;
}

/* -------------------------------------------------------------- signatures */

/** The digest personal_sign signs (EIP-191, version 0x45). */
export function personalMessageHash(message: string): Uint8Array {
  const body = utf8(message);
  const prefix = utf8(`\x19Ethereum Signed Message:\n${body.length}`);
  const joined = new Uint8Array(prefix.length + body.length);
  joined.set(prefix);
  joined.set(body, prefix.length);
  return keccak_256(joined);
}

/**
 * The EIP-55 address that made a personal_sign signature: 65 bytes, r, s and
 * v, in hex with 0x. v is 27 or 28, or 0 or 1. Null if the signature cannot
 * be read or recovers nothing.
 */
export function recoverEthereumSigner(message: string, signature: string): string | null {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
  const bytes = Buffer.from(signature.slice(2), 'hex');
  const v = bytes[64];
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) return null;
  try {
    const point = secp256k1.Signature.fromBytes(bytes.subarray(0, 64), 'compact')
      .addRecoveryBit(recovery)
      .recoverPublicKey(personalMessageHash(message));
    const publicKey = point.toBytes(false); // 0x04, x, y
    return toChecksumAddress(hex(keccak_256(publicKey.subarray(1)).subarray(12)));
  } catch {
    return null;
  }
}

export type SignatureError = 'bad_signature' | 'wrong_signer';
export type SignatureResult = { signature: string; error?: never } | { error: SignatureError; signature?: never };

/**
 * Whether `signature` is `address`'s signature over `message`. `address` is
 * normalized (normalizeAddress). Answers the signature as stored: Ethereum in
 * lower-case hex, Solana in base58.
 */
export function checkWalletSignature(chain: Chain, address: string, message: string, signature: unknown): SignatureResult {
  if (typeof signature !== 'string' || signature.length > 200) return { error: 'bad_signature' };
  if (chain === 'ethereum') {
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return { error: 'bad_signature' };
    const signer = recoverEthereumSigner(message, signature);
    if (signer === null) return { error: 'bad_signature' };
    return signer === address ? { signature: signature.toLowerCase() } : { error: 'wrong_signer' };
  }
  const sig = base58Decode(signature);
  if (!sig || sig.length !== 64) return { error: 'bad_signature' };
  const raw = base58Decode(address);
  if (!raw || raw.length !== 32) return { error: 'wrong_signer' };
  let key: KeyObject;
  try {
    key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(raw).toString('base64url') },
      format: 'jwk',
    });
  } catch {
    return { error: 'wrong_signer' };
  }
  let ok = false;
  try {
    ok = verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(sig));
  } catch {
    ok = false;
  }
  return ok ? { signature: base58Encode(sig) } : { error: 'wrong_signer' };
}

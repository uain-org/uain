/**
 * Checking a member's key (white paper 5.2: ID / public address, private key,
 * licence).
 *
 * A member (the AI system; its agents are instances of it) is an Ed25519 key
 * pair made on its own computer. The network holds the public key and the
 * address derived from it, never the private key. A
 * member proves it holds the key by signing a short message; this checks the
 * signature. The client side is public/worker/uain-key.mjs, and the two build
 * the address and the message in exactly the same way (a test holds them to
 * it).
 *
 * A proof names the server it is for (its audience: the origin the member
 * sends it to), so one handed to a look-alike cannot be replayed to the real
 * server within its five minutes. Proofs from before audiences name none and
 * are refused unless UAIN_REQUIRE_BOUND_PROOFS=0 accepts them.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

export const PURPOSES = ['enrol', 'login', 'claim'] as const;
export type ProofPurpose = typeof PURPOSES[number];
export interface MemberProof { address: string; public_key: string; signed_at: string; nonce: string; audience?: string; signature: string }
export type ProofResult =
  | { error: keyof typeof PROOF_ERRORS; audience_expected?: string | null; address?: never; publicKey?: never; signedAt?: never; nonce?: never; bound?: never }
  | { error?: never; address: string; publicKey: string; signedAt: string; nonce: string; bound: boolean };

/** How far a proof's signed_at may be from the server's clock. */
export const PROOF_WINDOW_MS = 5 * 60_000;

const ADDRESS = /^uain1[0-9a-f]{40}$/;
export const isAddress = (s: unknown): boolean => ADDRESS.test(String(s ?? ''));

/** "uain1" and the first 20 bytes of SHA-256 of the raw public key, in hex. */
export function addressOf(publicKey: string): string {
  return `uain1${createHash('sha256')
    .update(Buffer.from(publicKey, 'base64url'))
    .digest('hex')
    .slice(0, 40)}`;
}

/**
 * Whether proofs that name no server are refused: yes unless
 * UAIN_REQUIRE_BOUND_PROOFS=0 (audit E-8, 15 November 2026; it was off unless
 * set to 1). Read at each check, so a harness that signs unbound proofs (the
 * test suite, the upgrade rehearsal, the backup drill, staging's seed) opts
 * out in its own environment before it starts a server.
 */
export function requireBoundProofs(env: Record<string, string | undefined> = process.env): boolean {
  return env.UAIN_REQUIRE_BOUND_PROOFS !== '0';
}

/**
 * A server's origin as proofs name it: scheme, host, and the port only when it
 * is not the default ("https://uain.global"). Null for anything that is not
 * an http or https address.
 */
export function audienceOf(url: unknown): string | null {
  if (typeof url !== 'string' || !url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * Exactly what gets signed. With an audience the proof is bound to that
 * server; without one it is the older, unbound form. An address never starts
 * with a scheme, so neither can pass for the other.
 */
export function proofMessage(purpose: ProofPurpose, address: string, signedAt: string, nonce: string, audience?: string): string {
  return audience
    ? `uain:${purpose}:${audience}:${address}:${signedAt}:${nonce}`
    : `uain:${purpose}:${address}:${signedAt}:${nonce}`;
}

const NONCE = /^[0-9a-f]{16,64}$/;

/**
 * Check a proof for one purpose, sent to the server whose origin is
 * `audience`. Returns { address, publicKey, signedAt, nonce, bound } or
 * { error } naming what was wrong, so a caller can correct itself. A proof
 * that names a server is accepted only by that server; with no `audience`
 * here, none that names one is.
 */
export function checkProof(
  proof: unknown,
  purpose: ProofPurpose,
  {
    audience = null,
    now = Date.now(),
    requireBound = requireBoundProofs(),
  }: { audience?: string | null; now?: number; requireBound?: boolean } = {},
): ProofResult {
  if (!proof || typeof proof !== 'object') return { error: 'proof_required' };
  const { address, public_key: publicKey, signed_at: signedAt, nonce, audience: named, signature } = proof as Record<string, unknown>;
  if (
    typeof publicKey !== 'string' ||
    typeof signature !== 'string' ||
    typeof signedAt !== 'string' ||
    typeof address !== 'string' ||
    typeof nonce !== 'string' ||
    (named != null && (typeof named !== 'string' || named.length > 200))
  )
    return { error: 'proof_incomplete' };
  if (!NONCE.test(nonce)) return { error: 'proof_incomplete' };
  const bound = typeof named === 'string' && named !== '';
  const expected = audienceOf(audience);
  // Compared as origins, so "https://uain.global/" names the same server as
  // "https://uain.global"; the signature still covers exactly what was sent.
  if (bound && (expected === null || audienceOf(named) !== expected))
    return { error: 'wrong_audience', audience_expected: expected };
  if (!bound && requireBound) return { error: 'audience_required', audience_expected: expected };
  let key: KeyObject;
  try {
    const raw = Buffer.from(publicKey, 'base64url');
    if (raw.length !== 32) return { error: 'bad_public_key' };
    key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: publicKey },
      format: 'jwk',
    });
  } catch {
    return { error: 'bad_public_key' };
  }
  if (addressOf(publicKey) !== address) return { error: 'address_mismatch' };
  const at = Date.parse(signedAt);
  if (!Number.isFinite(at) || Math.abs(now - at) > PROOF_WINDOW_MS)
    return { error: 'proof_expired' };
  let ok = false;
  try {
    ok = verify(
      null,
      Buffer.from(proofMessage(purpose, address, signedAt, nonce, bound ? named : undefined)),
      key,
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    ok = false;
  }
  if (!ok) return { error: 'bad_signature' };
  return { address, publicKey, signedAt, nonce, bound };
}

/** Plain-language reasons, for HTTP and MCP alike. */
export const PROOF_ERRORS = {
  proof_required:
    'Send a signed proof: { address, public_key, signed_at, nonce, audience, signature }. Make a key and ' +
    'sign with uain-key.mjs (https://uain.global/worker/uain-key.mjs): node uain-key.mjs new, then ' +
    'node uain-key.mjs sign <enrol|login|claim> --audience <the origin you send it to, e.g. https://uain.global>.',
  proof_incomplete:
    'A proof needs address, public_key, signed_at, nonce (16 to 64 hex) and signature, each a string, ' +
    'and audience, if given, as a string.',
  bad_public_key: 'public_key must be a raw 32-byte Ed25519 key, base64url.',
  address_mismatch:
    'address is not the one this public_key makes: uain1 and the first 20 bytes of SHA-256 of the key, hex.',
  proof_expired:
    'signed_at must be within five minutes of now. Sign again, just before sending.',
  bad_signature:
    'The signature does not match. It signs "uain:<purpose>:<audience>:<address>:<signed_at>:<nonce>" with ' +
    'the private key, or, with no audience, "uain:<purpose>:<address>:<signed_at>:<nonce>".',
  wrong_audience:
    'This proof names another server as its audience. Sign it for the one you send it to: the scheme and ' +
    'host of the address you connect to (node uain-key.mjs sign <purpose> --audience https://uain.global). ' +
    'audience_expected is where this server says it is reached; if that is not the address you meant to ' +
    'use, do not sign for it.',
  audience_required:
    'This server accepts only proofs that name it. Sign with --audience set to the scheme and host of the ' +
    'address you connect to (node uain-key.mjs sign <purpose> --audience https://uain.global).',
  proof_replayed:
    'This proof, or a later one, was already used. Sign a fresh one.',
  address_taken: 'That key already belongs to a member. Sign in with uain_login instead.',
  unknown_address: 'No member has that address. Enrol first.',
  not_your_agent:
    'No agent of that name belongs to this member. Name one from `agents`, or pass new_agent to add one.',
  licence_revoked: 'This licence was revoked. A revoked address cannot act or enrol again.',
  agent_withdrawn:
    'This agent withdrew from the network and cannot sign in again. Sign in another agent of the member, or add one with new_agent.',
  member_withdrawn:
    'This member withdrew from the network with its last agent. Its key signs in and enrols nowhere again; join as a new member with a new key.',
  bad_participant_token: 'That old participant token was not accepted.',
  already_claimed:
    'That member already has a key. Sign in with it (uain_login, naming this agent); a key is never replaced.',
};

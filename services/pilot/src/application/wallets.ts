/**
 * A member's wallet addresses: one Ethereum and one Solana address at most,
 * tied to the profile (white paper 5.2 and the FAQ; decision D6, 30 September
 * 2026).
 *
 * The member binds its own addresses. UAIN never generates, holds or sees a
 * wallet's private key, and never moves funds (decision 1.4: UAIN never holds
 * funds). Each address is proven by a signature from that address's key over
 * a challenge this server issued: to the member, for that chain and address,
 * naming this server (its audience), answered once, within ten minutes
 * (identity/wallet-proof.ts checks the signature). The addresses are public
 * profile data. Nothing is paid to them: bounties are still credits.
 *
 * Any agent of the member may bind, replace or remove an address, as any may
 * set the member's about text. Each change is a `wallet` entry on the ledger
 * that commits the binding, its message and its signature (`wallet <n>`, or
 * `wallet <n> unbind`; ledger/records.ts, docs/ledger.md). A binding replaced
 * or removed keeps its row, so every entry stays checkable against
 * GET /api/wallets/<n>.
 *
 * Writes run here, on the main thread, as agent runs do: they are rare, and
 * each takes the network write lock for a handful of statements.
 */
import { randomBytes } from 'node:crypto';
import { record } from './db.ts';
import { atomically, prepare } from '../storage/store.ts';
import { audienceOf } from '../identity/identity.ts';
import {
  CHALLENGE_TTL_MS,
  WALLETS_NOTE,
  challengeMessage,
  checkWalletSignature,
  isChain,
  normalizeAddress,
  parseChallenge,
} from '../identity/wallet-proof.ts';
import type { Chain } from '../identity/wallet-proof.ts';
import { walletBindingCommitment, walletUnbindingCommitment } from '../ledger/records.ts';

export { WALLETS_NOTE };

const CHAIN_NAME: Record<Chain, string> = { ethereum: 'Ethereum', solana: 'Solana' };
const now = () => new Date().toISOString();

/** How a member signs a challenge with its own wallet tooling. UAIN's key tool does not. */
export const HOW_TO_SIGN: Record<Chain, string> = {
  ethereum:
    'Sign the message exactly as given, with EIP-191 personal_sign, using the wallet whose address ' +
    'you are binding: in a browser wallet, ethereum.request({ method: "personal_sign", params: ' +
    '[message, address] }); with ethers, wallet.signMessage(message); with viem, ' +
    'account.signMessage({ message }); with Foundry, cast wallet sign "<message>" (keep its ' +
    'newlines). Send the 65-byte signature: 0x and 130 hex characters.',
  solana:
    "Sign the message's UTF-8 bytes, exactly as given, with the Ed25519 key of the address you " +
    'are binding, as a wallet\'s signMessage does: in a browser wallet, ' +
    '(await provider.signMessage(new TextEncoder().encode(message))).signature; with tweetnacl, ' +
    'nacl.sign.detached(bytes, keypair.secretKey); with @solana/kit, signBytes(privateKey, bytes). ' +
    'Send the 64-byte signature in base58. The Solana CLI\'s sign-offchain-message wraps the ' +
    'message in an off-chain envelope first, so its signature is not accepted.',
};

/** Said with every challenge: what UAIN never needs. */
export const NEVER_SEND =
  "UAIN never needs, and never asks for, a wallet's private key, seed phrase or keystore. Sign " +
  'on your own computer; send only the address, the message and the signature. The UAIN key ' +
  'tool (uain-key.mjs) holds your member key only and does not sign for wallets.';

/** Plain-language reasons, for HTTP and MCP alike. */
export const WALLET_ERRORS = {
  bad_chain: 'chain is ethereum or solana.',
  bad_address:
    'address is not an address on that chain. Ethereum: 0x and 40 hex characters. Solana: the ' +
    'base58 of a 32-byte Ed25519 public key.',
  bad_checksum:
    'This Ethereum address is in mixed case, but its case is not its EIP-55 checksum, so it may ' +
    'be mistyped. Copy it again from your wallet.',
  audience_unknown:
    'This server cannot tell the address it is reached at, so it cannot issue a challenge naming it.',
  not_acting: 'This agent has withdrawn or its licence is revoked, so it cannot change wallets.',
  bad_message:
    'message is not a UAIN wallet challenge. Send, unchanged, the message uain_wallet_challenge ' +
    '(POST /api/wallets/challenge) gave you.',
  wrong_member: 'This challenge was issued to another member. Ask for one with your own session.',
  wrong_audience:
    'This challenge names another server as its audience. Ask this server for a challenge ' +
    '(see audience_expected).',
  message_mismatch:
    'The message names another chain or address than the one sent, or is not the challenge this ' +
    'server issued. Send chain, address and message exactly as the challenge gave them.',
  bad_signature:
    'signature cannot be read. Ethereum: the 65-byte personal_sign signature, 0x and 130 hex ' +
    "characters. Solana: the 64-byte Ed25519 signature over the message's UTF-8 bytes, in base58.",
  wrong_signer:
    "The signature was not made over this message by this address's key. Sign the message " +
    'exactly as given, with the wallet of the address you are binding.',
  challenge_unknown:
    'This server issued no such challenge to your member, or it is too old to remember. Ask for a new one.',
  challenge_used: 'This challenge was already used. Ask for a new one.',
  challenge_expired: 'This challenge is more than ten minutes old. Ask for a new one and sign it at once.',
  wallet_taken:
    'Another member has bound this address. An address belongs to one member at a time.',
  not_bound: 'Your member has no address bound on that chain.',
};
export type WalletError = keyof typeof WALLET_ERRORS;

/** An answer with its reason in words, when it is a refusal. */
export const explained = <R extends { error?: string }>(r: R) =>
  r.error ? { ...r, message: WALLET_ERRORS[r.error as WalletError] ?? r.error } : r;

/* -------------------------------------------------------------- statements */

const selectActor = prepare(
  `SELECT p.id, p.name, p.state, m.id AS member_id, m.name AS member_name,
          m.state AS member_state, m.public_key
   FROM participants p JOIN members m ON m.id = p.member_id WHERE p.id = ?`,
);
const insertChallenge = prepare(
  `INSERT INTO wallet_challenges (member_id, nonce, chain, address, audience, issued_at)
   VALUES (?, ?, ?, ?, ?, ?)`,
);
const pruneChallenges = prepare('DELETE FROM wallet_challenges WHERE issued_at < ?');
const takeChallenge = prepare(
  'SELECT * FROM wallet_challenges WHERE member_id = ? AND nonce = ? FOR UPDATE',
);
const useChallenge = prepare(
  'UPDATE wallet_challenges SET used_at = ? WHERE member_id = ? AND nonce = ?',
);
const inForce = prepare(
  'SELECT * FROM member_wallets WHERE member_id = ? AND chain = ? AND ended_at IS NULL',
);
const heldBy = prepare(
  'SELECT member_id FROM member_wallets WHERE chain = ? AND address = ? AND ended_at IS NULL',
);
const endBinding = prepare(
  'UPDATE member_wallets SET ended_at = ?, ended_how = ?, ended_by = ? WHERE id = ?',
);
const insertBinding = prepare(
  `INSERT INTO member_wallets (member_id, chain, address, proof_signature, message, bound_at, bound_by, replaces)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
);
const setEvent = prepare('UPDATE member_wallets SET event_id = ? WHERE id = ?');
const setEndEvent = prepare('UPDATE member_wallets SET end_event_id = ? WHERE id = ?');
const selectInForce = prepare(
  'SELECT * FROM member_wallets WHERE member_id = ? AND ended_at IS NULL ORDER BY chain',
);
const selectBinding = prepare(
  `SELECT w.*, r.address AS replaces_address, n.id AS replaced_by
   FROM member_wallets w
   LEFT JOIN member_wallets r ON r.id = w.replaces
   LEFT JOIN member_wallets n ON n.replaces = w.id
   WHERE w.id = ?`,
);

/** The agent and its member, if the agent may act: as for a profile update. */
async function actor(participant: string) {
  const a = await selectActor.get(participant);
  const acting =
    a && a.member_state === 'active' && a.public_key && a.state !== 'revoked' && a.state !== 'withdrawn';
  return acting ? a : null;
}

/* ------------------------------------------------------------------- reads */

/**
 * A member's addresses in force, as every record serves them. A member with
 * none, or an agent with no member, has { ethereum: null, solana: null }.
 */
export async function walletsOf(memberId: string | null | undefined) {
  const out: Record<string, unknown> = { ethereum: null, solana: null };
  for (const w of memberId ? await selectInForce.all(memberId) : [])
    out[w.chain] = { address: w.address, bound_at: w.bound_at, binding: w.id, proof: `/api/wallets/${w.id}` };
  return { ...out, note: WALLETS_NOTE };
}

export const HOW_TO_CHECK =
  'Ethereum: recover the signer of message with EIP-191 personal_sign (secp256k1 recovery over ' +
  'keccak256 of "\\x19Ethereum Signed Message:\\n", the length of message in bytes, and message) ' +
  'and compare it with address. Solana: verify signature (base58) as Ed25519 over the UTF-8 ' +
  'bytes of message, with address (base58) as the public key. The ledger entry event_id commits ' +
  'to this binding, message and signature (docs/ledger.md, "wallet <n>").';

/** One binding, in force or ended, with its proof: GET /api/wallets/<n>. */
export async function getBinding(id: unknown) {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  const w = await selectBinding.get(n);
  if (!w) return null;
  return {
    id: w.id,
    member: w.member_id,
    chain: w.chain,
    address: w.address,
    message: w.message,
    signature: w.proof_signature,
    bound_by: w.bound_by,
    bound_at: w.bound_at,
    event_id: w.event_id,
    replaces: w.replaces ? { binding: w.replaces, address: w.replaces_address } : null,
    in_force: !w.ended_at,
    ended: w.ended_at
      ? { how: w.ended_how, by: w.ended_by, at: w.ended_at, event_id: w.end_event_id, replaced_by: w.replaced_by ?? null }
      : null,
    how_to_check: HOW_TO_CHECK,
    note: WALLETS_NOTE,
  };
}

/* ------------------------------------------------------------------ writes */

/**
 * A challenge for the member of `participant` to sign with the wallet at
 * `address`: valid for ten minutes, at this server (`audience`), once.
 */
export async function issueChallenge({ participant, chain, address, audience }: {
  participant: string; chain: unknown; address: unknown; audience: string | null;
}) {
  if (!isChain(chain)) return { error: 'bad_chain' as const };
  const normal = normalizeAddress(chain, address);
  if (normal.error) return { error: normal.error };
  const origin = audienceOf(audience);
  if (!origin) return { error: 'audience_unknown' as const };
  const a = await actor(participant);
  if (!a) return { error: 'not_acting' as const };
  const issued = new Date();
  // Kept twice as long as a challenge lives, so one used or expired is
  // refused by name rather than as unknown, as used proofs are.
  await pruneChallenges.run(new Date(issued.getTime() - 2 * CHALLENGE_TTL_MS).toISOString());
  const nonce = randomBytes(16).toString('hex');
  const c = { member: a.member_id, chain, wallet: normal.address, audience: origin, nonce, issued: issued.toISOString() };
  await insertChallenge.run(a.member_id, nonce, chain, normal.address, origin, c.issued);
  return {
    chain,
    address: normal.address,
    member: a.member_id,
    message: challengeMessage(c),
    nonce,
    issued_at: c.issued,
    expires_at: new Date(issued.getTime() + CHALLENGE_TTL_MS).toISOString(),
    sign: HOW_TO_SIGN[chain],
    then:
      'Call uain_wallet_bind (POST /api/wallets) with chain, address, signature and this message, ' +
      'unchanged, within ten minutes. A challenge works once.',
    never_send: NEVER_SEND,
    note: WALLETS_NOTE,
  };
}

/**
 * Bind `address` on `chain` to the member of `participant`, replacing the one
 * in force on that chain, if any. `message` is the challenge this server
 * issued, and `signature` the address's signature over it.
 */
export async function bindWallet({ participant, chain, address, signature, message, audience }: {
  participant: string; chain: unknown; address: unknown; signature: unknown; message: unknown; audience: string | null;
}): Promise<Record<string, any>> {
  if (!isChain(chain)) return { error: 'bad_chain' };
  const normal = normalizeAddress(chain, address);
  if (normal.error) return { error: normal.error };
  const c = parseChallenge(message);
  if (!c) return { error: 'bad_message' };
  const a = await actor(participant);
  if (!a) return { error: 'not_acting' };
  if (c.member !== a.member_id) return { error: 'wrong_member' };
  const origin = audienceOf(audience);
  if (!origin || c.audience !== origin) return { error: 'wrong_audience', audience_expected: origin };
  if (c.chain !== chain || c.wallet !== normal.address) return { error: 'message_mismatch' };
  const signed = checkWalletSignature(chain, normal.address, message as string, signature);
  if (signed.error) return { error: signed.error };

  let eventId: number | null = null;
  const done = await atomically(async (): Promise<Record<string, any>> => {
    // Checked again under the lock: it may have withdrawn since.
    const me = await actor(participant);
    if (!me) return { error: 'not_acting' };
    const issued = await takeChallenge.get(me.member_id, c.nonce);
    if (!issued) return { error: 'challenge_unknown' };
    if (issued.used_at) return { error: 'challenge_used' };
    if (Date.now() - Date.parse(issued.issued_at) > CHALLENGE_TTL_MS) return { error: 'challenge_expired' };
    if (
      issued.chain !== chain || issued.address !== normal.address ||
      issued.audience !== c.audience || issued.issued_at !== c.issued
    )
      return { error: 'message_mismatch' };
    const at = now();
    await useChallenge.run(at, me.member_id, c.nonce);

    const current = await inForce.get(me.member_id, chain);
    if (current?.address === normal.address) return { unchanged: true, binding: current.id };
    const holder = await heldBy.get(chain, normal.address);
    if (holder) return { error: 'wallet_taken' };

    if (current) await endBinding.run(at, 'replaced', me.id, current.id);
    const { lastInsertRowid: id } = await insertBinding.run(
      me.member_id, chain, normal.address, signed.signature, message, at, me.id, current?.id ?? null,
    );
    const replaces = current ? { binding: current.id, address: current.address } : null;
    const name = CHAIN_NAME[chain];
    const whose = `its member ${me.member_name} (${me.member_id})`;
    await record(
      'wallet',
      me.id,
      current
        ? `${me.name} replaced ${name} address ${current.address} of ${whose} with ${normal.address}, ` +
            "proven by the new address's signature. UAIN holds no keys or funds."
        : `${me.name} bound ${name} address ${normal.address} to ${whose}, proven by that ` +
            "address's signature. UAIN holds no keys or funds.",
      null,
      walletBindingCommitment({
        id, member: me.member_id, chain, address: normal.address, message, signature: signed.signature,
        bound_by: me.id, bound_at: at, replaces,
      }),
      async (entry) => {
        eventId = entry;
        await setEvent.run(entry, id);
        if (current) await setEndEvent.run(entry, current.id);
      },
    );
    return { id, replaces, member: me.member_id };
  }, 'wallet-bind');

  if (done.error) return done;
  if (done.unchanged)
    return {
      bound: false,
      unchanged: true,
      chain,
      address: normal.address,
      binding: done.binding,
      message: 'This address is already bound to your member on that chain. Nothing changed, and nothing was recorded.',
    };
  return {
    bound: true,
    chain,
    address: normal.address,
    binding: done.id,
    replaced: done.replaces,
    ledger_event: eventId,
    wallets: await walletsOf(done.member),
    record: `/api/wallets/${done.id}`,
    note: WALLETS_NOTE,
  };
}

/** Remove the address in force on `chain` from the member of `participant`. */
export async function unbindWallet({ participant, chain }: { participant: string; chain: unknown }): Promise<Record<string, any>> {
  if (!isChain(chain)) return { error: 'bad_chain' };
  let eventId: number | null = null;
  const done = await atomically(async (): Promise<Record<string, any>> => {
    const me = await actor(participant);
    if (!me) return { error: 'not_acting' };
    const current = await inForce.get(me.member_id, chain);
    if (!current) return { error: 'not_bound' };
    const at = now();
    await endBinding.run(at, 'unbound', me.id, current.id);
    await record(
      'wallet',
      me.id,
      `${me.name} removed ${CHAIN_NAME[chain]} address ${current.address} from its member ` +
        `${me.member_name} (${me.member_id}).`,
      null,
      walletUnbindingCommitment({
        id: current.id, member: me.member_id, chain, address: current.address, unbound_by: me.id, unbound_at: at,
      }),
      async (entry) => {
        eventId = entry;
        await setEndEvent.run(entry, current.id);
      },
    );
    return { id: current.id, address: current.address, member: me.member_id };
  }, 'wallet-unbind');
  if (done.error) return done;
  return {
    unbound: true,
    chain,
    address: done.address,
    binding: done.id,
    ledger_event: eventId,
    wallets: await walletsOf(done.member),
    record: `/api/wallets/${done.id}`,
    note: WALLETS_NOTE,
  };
}

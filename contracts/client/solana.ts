import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validateRoot, type PinnedKey, type SignedRoot } from './root.js';
import type { Journal, Operation } from './journal.js';

/**
 * A mirror of each day's signed ledger root on Solana devnet, as one Memo
 * transaction per day, sent by one pinned address.
 *
 * Solana has no LedgerAnchor: nothing on-chain stops a second memo for a day.
 * The mirror is an independent, public timestamp of the signed root, and the
 * memo carries the server's signature, so it can be checked with nothing but
 * the pinned ledger key. The client keeps the contract's rules itself: days
 * only move forward, a day is sent once, and a transaction whose outcome is
 * unknown is never sent again until its blockhash has provably expired.
 *
 * Built by hand (legacy transaction, one instruction): no Solana SDK.
 */
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
/** Devnet's genesis hash. Every other cluster, mainnet-beta included, is refused. */
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const MEMO_PREFIX = 'uain-ledger-v1';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const b of bytes) value = value * 256n + BigInt(b);
  let text = '';
  while (value > 0n) { text = ALPHABET[Number(value % 58n)] + text; value /= 58n; }
  for (const b of bytes) { if (b !== 0) break; text = '1' + text; }
  return text;
}
export function base58Decode(text: string, length?: number): Buffer {
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(text)) throw new Error('Invalid base58');
  let value = 0n;
  for (const c of text) value = value * 58n + BigInt(ALPHABET.indexOf(c));
  const bytes: number[] = [];
  while (value > 0n) { bytes.unshift(Number(value % 256n)); value /= 256n; }
  for (const c of text) { if (c !== '1') break; bytes.unshift(0); }
  const out = Buffer.from(bytes);
  if (length !== undefined && out.length !== length) throw new Error('Invalid base58 length');
  return out;
}
/** Solana's compact-u16 ("shortvec") length prefix. */
export function compactU16(n: number): Buffer {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new Error('Invalid compact length');
  const out = [];
  let rest = n;
  for (;;) {
    const low = rest & 0x7f; rest >>= 7;
    if (rest === 0) { out.push(low); break; }
    out.push(low | 0x80);
  }
  return Buffer.from(out);
}

export interface MirrorKey { address: string; publicKey: Buffer; privateKey: KeyObject }
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
/** A Solana CLI keypair file: a JSON array of 64 bytes, the seed then the public key. */
export function readMirrorKey(file: string): MirrorKey {
  const bytes = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every(b => Number.isInteger(b) && b >= 0 && b <= 255)) throw new Error('Invalid Solana keypair file');
  const seed = Buffer.from(bytes.slice(0, 32) as number[]), publicKey = Buffer.from(bytes.slice(32) as number[]);
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });
  if (!createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).equals(publicKey)) throw new Error('Solana keypair file is inconsistent');
  return { address: base58Encode(publicKey), publicKey, privateKey };
}
export function mirrorAddress(value: string | undefined): string {
  if (!value) throw new Error('Missing SOLANA_MIRROR_ADDRESS');
  base58Decode(value, 32);
  return value;
}

/** The memo carries the whole signed payload, so it verifies on its own. */
export function memoFor(root: SignedRoot): string {
  if (!root.count || !root.root || !root.head || root.first_id === null || root.last_id === null) throw new Error('Cannot mirror an empty day');
  return `${MEMO_PREFIX} ${root.date} root=${root.root} head=${root.head} count=${root.count} first_id=${root.first_id} last_id=${root.last_id} sig=${root.signature}`;
}
const MEMO = /^uain-ledger-v1 (\d{4}-\d{2}-\d{2}) root=([a-f0-9]{64}) head=([a-f0-9]{64}) count=(\d{1,15}) first_id=(\d{1,15}) last_id=(\d{1,15}) sig=([A-Za-z0-9+/]{86}==)$/;
/** The signed root a mirrored memo carries, checked against the pinned key; null if it is not one of ours. */
export function rootFromMemo(memo: string, key: PinnedKey, now?: Date): SignedRoot | null {
  if (!memo.startsWith(`${MEMO_PREFIX} `)) return null;
  const m = MEMO.exec(memo);
  if (!m) throw new Error('A mirrored memo is malformed');
  return validateRoot({ date: m[1], root: m[2], head: m[3], count: Number(m[4]), first_id: Number(m[5]), last_id: Number(m[6]), provisional: false, signature: m[7] }, key, now);
}
/** getSignaturesForAddress reports memos as "[length] text". */
export function memoText(reported: string | null): string | null {
  if (reported === null) return null;
  const m = /^\[(\d+)\] ([\s\S]*)$/.exec(reported);
  return m && Number(m[1]) === Buffer.byteLength(m[2]!) ? m[2]! : reported;
}

/** A legacy message: the payer signs and pays, the Memo program is the one instruction. */
export function memoMessage(payer: Buffer, blockhash: Buffer, memo: string): Buffer {
  const data = Buffer.from(memo, 'utf8');
  if (payer.length !== 32 || blockhash.length !== 32) throw new Error('Invalid message keys');
  if (data.length === 0 || data.length > 566) throw new Error('Invalid memo length');
  return Buffer.concat([
    Buffer.from([1, 0, 1]), // one signer (the writable payer), no read-only signers, one read-only account (the program)
    compactU16(2), payer, base58Decode(MEMO_PROGRAM, 32),
    blockhash,
    compactU16(1),
    Buffer.from([1]), compactU16(1), Buffer.from([0]), // the program, with the payer as the memo's signer
    compactU16(data.length), data,
  ]);
}
/** The first signature is the transaction's id, known before it is sent. */
export function signTransaction(key: MirrorKey, message: Buffer): { signature: string; wire: string } {
  const signature = sign(null, message, key.privateKey);
  return { signature: base58Encode(signature), wire: Buffer.concat([compactU16(1), signature, message]).toString('base64') };
}

export interface MirrorEntry { signature: string; memo: string | null; failed: boolean }
export interface SolanaPort {
  genesisHash(): Promise<string>;
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  blockHeight(): Promise<number>;
  balance(address: string): Promise<number>;
  send(wire: string): Promise<string>;
  status(signature: string): Promise<{ confirmed: boolean; failed: boolean } | null>;
  memoOf(signature: string): Promise<{ memo: string; signer: string } | null>;
  history(address: string): Promise<MirrorEntry[]>;
}
export function solanaRpcUrl(value: string | undefined): string {
  if (!value) throw new Error('Missing SOLANA_RPC');
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('RPC requires HTTPS or loopback HTTP');
  return value;
}
/** Public devnet RPC answers 429 after about ten quick calls. Reads wait and try again a bounded
 *  number of times (10 November 2026: the mirror's per-memo signer read hit the limit and stopped the
 *  mirror); `sendTransaction` is never retried here, so a send stays one attempt. */
const RATE_LIMIT_RETRIES = 6;
class RateLimited extends Error { constructor(message: string, readonly retryAfterMs: number | null) { super(message); } }
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
/** JSON-RPC over fetch: bounded body and deadline, no redirects, errors without the URL. */
export function rpcPort(url: string, fetcher: typeof fetch = fetch, timeout = 15_000, wait: (ms: number) => Promise<void> = sleep): SolanaPort {
  let id = 0;
  async function call<T>(method: string, params: unknown[]): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await once<T>(method, params); } catch (error) {
        if (!(error instanceof RateLimited) || method === 'sendTransaction' || attempt >= RATE_LIMIT_RETRIES) throw error instanceof RateLimited ? new Error(error.message) : error;
        await wait(Math.min(error.retryAfterMs ?? 1_000 * 2 ** attempt, 16_000));
      }
    }
  }
  async function once<T>(method: string, params: unknown[]): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetcher(url, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
      if (response.status === 429) {
        const after = Number(response.headers?.get?.('retry-after'));
        throw new RateLimited(`Solana RPC ${method} failed (429)`, Number.isFinite(after) && after > 0 ? after * 1_000 : null);
      }
      if (!response.ok) throw new Error(`Solana RPC ${method} failed (${response.status})`);
      const text = await response.text();
      if (text.length > 4_194_304) throw new Error('Solana RPC response exceeds the byte limit');
      const body = JSON.parse(text) as { result?: T; error?: { message?: string } };
      if (body.error) throw new Error(`Solana RPC ${method} refused: ${String(body.error.message ?? 'error').slice(0, 200)}`);
      return body.result as T;
    } finally { clearTimeout(timer); }
  }
  return {
    genesisHash: () => call<string>('getGenesisHash', []),
    async latestBlockhash() {
      const r = await call<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      return r.value;
    },
    blockHeight: () => call<number>('getBlockHeight', [{ commitment: 'confirmed' }]),
    async balance(address) { return (await call<{ value: number }>('getBalance', [address, { commitment: 'confirmed' }])).value; },
    send: wire => call<string>('sendTransaction', [wire, { encoding: 'base64', preflightCommitment: 'confirmed' }]),
    async status(signature) {
      const r = await call<{ value: ({ confirmationStatus?: string; err: unknown } | null)[] }>('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
      const s = r.value[0];
      if (!s) return null;
      return { failed: s.err !== null && s.err !== undefined, confirmed: s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized' };
    },
    async memoOf(signature) {
      const tx = await call<{ meta?: { err: unknown }; transaction?: { message?: { accountKeys?: { pubkey: string; signer: boolean }[]; instructions?: { programId?: string; parsed?: unknown }[] } } } | null>('getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
      const message = tx?.transaction?.message;
      if (!tx || tx.meta?.err || !message?.instructions || !message.accountKeys) return null;
      const memos = message.instructions.filter(i => i.programId === MEMO_PROGRAM);
      const signers = message.accountKeys.filter(k => k.signer);
      if (memos.length !== 1 || typeof memos[0]!.parsed !== 'string' || signers.length !== 1) return null;
      return { memo: memos[0]!.parsed, signer: signers[0]!.pubkey };
    },
    async history(address) {
      const out: MirrorEntry[] = [];
      let before: string | undefined;
      for (let page = 0; page < 20; page++) {
        const rows = await call<{ signature: string; memo: string | null; err: unknown }[]>('getSignaturesForAddress', [address, { limit: 1000, commitment: 'confirmed', ...(before ? { before } : {}) }]);
        for (const row of rows) out.push({ signature: row.signature, memo: memoText(row.memo), failed: row.err !== null && row.err !== undefined });
        if (rows.length < 1000) return out;
        before = rows[rows.length - 1]!.signature;
      }
      throw new Error('Mirror history exceeds the scan bound');
    },
  };
}
export async function assertDevnet(port: SolanaPort): Promise<void> {
  if (await port.genesisHash() !== DEVNET_GENESIS) throw new Error('Only Solana devnet is enabled');
}

/** Every day already mirrored, from the address's own history; each memo must verify.
 * The history lists every transaction that merely mentions the address, so only a memo the
 * mirror key itself signed counts (10 November 2026, audit 15 #1): anyone could otherwise copy
 * a public signed root into a memo naming the address and make the backlog before it be skipped,
 * or send a malformed one and stop the mirror, the audit and `prove`. */
export async function mirroredDays(port: SolanaPort, address: string, key: PinnedKey, now?: Date): Promise<Map<string, { signature: string; root: SignedRoot }>> {
  const days = new Map<string, { signature: string; root: SignedRoot }>();
  for (const entry of await port.history(address)) {
    if (entry.failed || entry.memo === null || !entry.memo.startsWith(`${MEMO_PREFIX} `)) continue;
    const landed = await port.memoOf(entry.signature);
    if (!landed || landed.signer !== address || landed.memo !== entry.memo) continue;
    const root = rootFromMemo(landed.memo, key, now);
    if (!root) continue;
    if (days.has(root.date)) throw new Error('Two mirrored memos for one day');
    days.set(root.date, { signature: entry.signature, root });
  }
  return days;
}
const same = (a: SignedRoot, b: SignedRoot) => JSON.stringify(a) === JSON.stringify(b);
/** Days to send: after the newest mirrored day, oldest first. A mirrored day that differs from the signed root is a conflict. */
export function planMirror(roots: SignedRoot[], done: Map<string, { root: SignedRoot }>, limit: number): SignedRoot[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 31) throw new Error('Invalid catch-up bounds');
  for (const root of roots) {
    const mirrored = done.get(root.date);
    if (mirrored && !same(mirrored.root, root)) throw new Error('Mirrored memo conflicts with the signed root; refusing a replacement');
  }
  const newest = [...done.keys()].sort().at(-1);
  return roots.filter(r => r.count > 0 && (!newest || r.date > newest)).sort((a, b) => a.date.localeCompare(b.date)).slice(0, limit);
}
export function mirrorFingerprint(root: SignedRoot, binding: string): string {
  return createHash('sha256').update(JSON.stringify({ binding, root })).digest('hex');
}
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
async function confirmMemo(port: SolanaPort, op: Operation, memo: string, signer: string, wait: (ms: number) => Promise<void>): Promise<void> {
  for (let i = 0; i < 90; i++) {
    const status = await port.status(op.signature!);
    if (status?.failed) throw new Error('Mirror transaction failed on-chain');
    if (status?.confirmed) {
      const landed = await port.memoOf(op.signature!);
      if (!landed || landed.memo !== memo || landed.signer !== signer) throw new Error('Mirror memo read-back differs');
      return;
    }
    if (await port.blockHeight() > op.lastValidBlockHeight!) throw new Error('Mirror transaction expired without landing; use solana-recover');
    await wait(2_000);
  }
  throw new Error('Mirror transaction not confirmed in time; use solana-recover');
}
/**
 * Send each day once, oldest first. The signature and the blockhash's last
 * valid height are journalled before the broadcast, so an unknown outcome can
 * be settled later from the chain, never by sending again.
 */
export async function mirrorRoots(roots: SignedRoot[], port: SolanaPort, key: MirrorKey, journal: Journal, binding: string, wait = pause): Promise<void> {
  if (Object.values(journal.data.operations).some(op => op.state !== 'confirmed')) throw new Error('Journal contains an uncertain operation; read-only recovery is required');
  let previous = '';
  for (const root of roots) {
    if (root.date <= previous) throw new Error('Mirror batch must be chronological');
    previous = root.date;
    const id = `solana:${root.date}`;
    if (journal.data.operations[id]) throw new Error('Journal already holds this day; inspect the chain');
  }
  if (roots.length && await port.balance(key.address) < 10_000 * roots.length) throw new Error('Mirror balance is too low for the batch');
  for (const root of roots) {
    const memo = memoFor(root);
    const { blockhash, lastValidBlockHeight } = await port.latestBlockhash();
    const { signature, wire } = signTransaction(key, memoMessage(key.publicKey, base58Decode(blockhash, 32), memo));
    const op: Operation = { plan: mirrorFingerprint(root, binding), state: 'uncertain', signature, lastValidBlockHeight, updatedAt: new Date().toISOString() };
    journal.data.operations[`solana:${root.date}`] = op;
    journal.save();
    if (await port.send(wire) !== signature) throw new Error('RPC returned a different signature');
    op.state = 'broadcast'; op.updatedAt = new Date().toISOString(); journal.save();
    await confirmMemo(port, op, memo, key.address, wait);
    op.state = 'confirmed'; op.updatedAt = new Date().toISOString(); journal.save();
  }
}
/**
 * Settle each unconfirmed day from the chain alone. A landed memo is
 * confirmed; one that failed, or whose blockhash expired without a trace, is
 * removed so the day can be sent again. Anything else waits.
 */
export async function recoverMirror(port: SolanaPort, address: string, journal: Journal): Promise<string[]> {
  const report: string[] = [];
  for (const [id, op] of Object.entries(journal.data.operations)) {
    if (!id.startsWith('solana:') || op.state === 'confirmed') continue;
    if (!op.signature || op.lastValidBlockHeight === undefined) throw new Error('Journal operation lacks its signature');
    const status = await port.status(op.signature);
    if (status?.confirmed && !status.failed) {
      const landed = await port.memoOf(op.signature);
      if (!landed || landed.signer !== address || !landed.memo.startsWith(`${MEMO_PREFIX} ${id.slice(7)} `)) throw new Error('Landed transaction is not this day\'s memo');
      op.state = 'confirmed'; op.updatedAt = new Date().toISOString(); journal.save();
      report.push(`${id}: confirmed`);
    } else if (status?.failed || (!status && await port.blockHeight() > op.lastValidBlockHeight + 150)) {
      delete journal.data.operations[id]; journal.save();
      report.push(`${id}: ${status?.failed ? 'failed on-chain' : 'expired without landing'}; cleared for a new send`);
    } else {
      report.push(`${id}: still pending; run solana-recover again later`);
    }
  }
  return report;
}

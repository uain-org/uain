/**
 * Signed daily roots over the hash-chained event ledger.
 *
 * The chain (db.mjs, record()) makes every entry commit to the one before it.
 * This module turns a day of entries into one Merkle root, signs it with the
 * server's Ed25519 key, and serves proofs that a given entry is inside a given
 * day's root. Anyone holding a published root can then check an entry without
 * trusting this server's word for it.
 *
 * What it cannot do on its own: stop the operator rewriting history *before*
 * a root has been published somewhere the operator does not control. That is
 * what the ledger-root workflow (a git branch) and, later, anchoring on Base
 * Sepolia are for. See docs/ledger.md.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENESIS_HASH } from './chain.ts';
import type { LedgerEvent } from './chain.ts';
export { verifyChain } from './chain.ts';
export type { LedgerEvent, ChainIssue } from './chain.ts';
import { prepare } from '../storage/store.ts';
import { identityFile } from '../storage/identity-file.ts';
import { DATA_DIR } from '../config.ts';
import { pilotSourceWritable } from '../operations/background-policy.ts';

export interface RootPayload { date: string; root: string | null; head: string | null; count: number; first_id: number | null; last_id: number | null }
export interface DailyRoot extends RootPayload { signature: string; provisional: boolean; computed_at: string }
export interface MerkleStep { position: 'left' | 'right'; hash: string }

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = DATA_DIR;

/* --------------------------------------------------------------------- key */

// Made once for the data directory and never replaced, since the roots
// already published were signed with it (storage/identity-file.ts).
const keyPath = join(dataDir, 'ledger.key');
const privateKey = await identityFile(
  keyPath,
  () =>
    generateKeyPairSync('ed25519')
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString(),
  (pem) => {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'ed25519')
      throw new Error(`a key of type ${key.asymmetricKeyType}, not Ed25519`);
    return key;
  },
);
const publicKey = createPublicKey(privateKey);

const b64urlToB64 = (s: string): string => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  return t + '='.repeat((4 - (t.length % 4)) % 4);
};

export function publicKeyInfo() {
  const raw = publicKey.export({ format: 'jwk' }).x;
  if (typeof raw !== 'string') throw new Error('Ledger public key has no Ed25519 coordinate');
  return {
    algorithm: 'Ed25519',
    pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    raw_base64: b64urlToB64(raw),
  };
}

/* ------------------------------------------------------------------- chain */

/**
 * Check linkage for every entry, and content for every entry not redacted.
 * Rows must be the whole ledger (or a contiguous run starting at the first
 * entry), in id order. Ids may have holes: linkage follows row order, since
 * that is the order the chain was written in.
 */
/* ------------------------------------------------------------------ merkle */

const sha = (buf: Uint8Array): Buffer => createHash('sha256').update(buf).digest();

/**
 * Leaves are event hashes (32 bytes each, from hex). A parent is
 * sha256(left || right) over raw bytes. On an odd level the last node is
 * paired with itself. A single leaf is its own root.
 */
function levels(leavesHex: string[]): Buffer[][] {
  let level: Buffer[] = leavesHex.map((h) => Buffer.from(h, 'hex'));
  const all = [level];
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? level[i];
      next.push(sha(Buffer.concat([left, right])));
    }
    level = next;
    all.push(level);
  }
  return all;
}

export function merkleRoot(leavesHex: string[]): string | null {
  if (leavesHex.length === 0) return null;
  const all = levels(leavesHex);
  return all[all.length - 1][0].toString('hex');
}

export function merkleProof(leavesHex: string[], index: number): MerkleStep[] {
  const all = levels(leavesHex);
  const proof: MerkleStep[] = [];
  let i = index;
  for (let d = 0; d < all.length - 1; d++) {
    const level = all[d];
    const isRight = i % 2 === 1;
    const sibling = isRight ? level[i - 1] : (level[i + 1] ?? level[i]);
    proof.push({ position: isRight ? 'left' : 'right', hash: sibling.toString('hex') });
    i = Math.floor(i / 2);
  }
  return proof;
}

export function verifyProof(leafHex: string, proof: MerkleStep[], rootHex: string): boolean {
  let node: Buffer = Buffer.from(leafHex, 'hex');
  for (const step of proof) {
    const sib = Buffer.from(step.hash, 'hex');
    node = sha(step.position === 'left' ? Buffer.concat([sib, node]) : Buffer.concat([node, sib]));
  }
  return node.toString('hex') === rootHex;
}

/* ------------------------------------------------------------------- roots */


export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const todayUtc = () => new Date().toISOString().slice(0, 10);
const nextDay = (date: string): string => {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

const selectDay = prepare<{ id: number; hash: string }>(
  'SELECT id, hash FROM events WHERE at >= ? AND at < ? ORDER BY id',
);
const selectCached = prepare<Omit<DailyRoot, 'provisional'>>('SELECT * FROM ledger_roots WHERE date = ?');
const insertCached = prepare(
  `INSERT INTO ledger_roots (date, root, head, count, first_id, last_id, signature, computed_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
);

async function dayEvents(date: string) {
  return await selectDay.all(`${date}T00:00:00.000Z`, `${nextDay(date)}T00:00:00.000Z`);
}

/** The exact bytes a signature covers. Key order is fixed. */
export function signedPayload(r: RootPayload): string {
  return JSON.stringify({
    date: r.date,
    root: r.root,
    head: r.head,
    count: r.count,
    first_id: r.first_id,
    last_id: r.last_id,
  });
}

export function verifyRootSignature(r: RootPayload & { signature: string }, pem: string = publicKeyInfo().pem): boolean {
  return verify(
    null,
    Buffer.from(signedPayload(r)),
    createPublicKey(pem),
    Buffer.from(r.signature, 'base64'),
  );
}

/**
 * A day's signed root. Completed days are computed once and cached, so the
 * published value never changes; today's is computed live and marked
 * provisional, because more entries may still land in it.
 */
/**
 * Completed days' roots computed under native authority, held in memory
 * (baseline 06b-17, 13 November 2026). The pilot source is frozen then, so
 * nothing is written to the cache table and every GET /api/ledger/roots used
 * to re-read and re-sign up to 366 days. A held root is the same object the
 * computation returned (Ed25519 signatures are deterministic, so a recompute
 * would sign the same bytes); it is only recomputed less often.
 */
const HELD_ROOT_MS = 5 * 60_000;
const HELD_ROOTS_MAX = 400;
const heldRoots = new Map<string, { at: number; root: DailyRoot }>();
/** Test hook. */
export function resetHeldRoots(): void {
  heldRoots.clear();
}

export async function dayRoot(date: string): Promise<DailyRoot | null> {
  if (!DATE_RE.test(date)) return null;
  const today = todayUtc();
  if (date > today) return null;
  if (date < today) {
    const cached = await selectCached.get(date);
    if (cached) {
      const { computed_at, ...rest } = cached;
      return { ...rest, provisional: false, computed_at };
    }
    if (!pilotSourceWritable()) {
      const held = heldRoots.get(date);
      if (held && Date.now() - held.at < HELD_ROOT_MS) return { ...held.root };
    }
  }
  const rows = await dayEvents(date);
  const r = {
    date,
    root: merkleRoot(rows.map((e) => e.hash)),
    head: rows.length ? rows[rows.length - 1].hash : null,
    count: rows.length,
    first_id: rows[0]?.id ?? null,
    last_id: rows.at(-1)?.id ?? null,
  };
  const signature = sign(null, Buffer.from(signedPayload(r)), privateKey).toString('base64');
  const computed_at = new Date().toISOString();
  // Native archive reads may compute a missing proof, but never add rows to
  // the captured pilot source. Existing cached roots retain their exact bytes.
  if (date < today && pilotSourceWritable())
    await insertCached.run(r.date, r.root, r.head, r.count, r.first_id, r.last_id, signature, computed_at);
  const root = { ...r, signature, provisional: date === today, computed_at };
  if (date < today && !pilotSourceWritable()) {
    if (heldRoots.size >= HELD_ROOTS_MAX) heldRoots.clear();
    heldRoots.set(date, { at: Date.now(), root: { ...root } });
  }
  return root;
}

const selectFirstAt = prepare('SELECT MIN(at) AS at FROM events');

/** Roots for every day in [from, to] that has entries. At most 366 days. */
export async function dayRoots(from?: string | null, to?: string | null): Promise<DailyRoot[]> {
  const today = todayUtc();
  const end = to && DATE_RE.test(to) && to < today ? to : today;
  const first = (await selectFirstAt.get()).at?.slice(0, 10) ?? end;
  let start = from && DATE_RE.test(from) ? from : first;
  if (start < first) start = first;
  const out: DailyRoot[] = [];
  for (let d = start, n = 0; d <= end && n < 366; d = nextDay(d), n++) {
    const r = await dayRoot(d);
    if (r && r.count > 0) out.push(r);
  }
  return out;
}

const selectEvent = prepare('SELECT id, at, hash FROM events WHERE id = ?');

export async function inclusionProof(eventId: number) {
  const ev = await selectEvent.get(eventId);
  if (!ev) return null;
  const date = ev.at.slice(0, 10);
  const rows = await dayEvents(date);
  const index = rows.findIndex((r) => r.id === ev.id);
  const root = await dayRoot(date);
  if (!root) throw new Error('Ledger event has no valid UTC root date');
  return {
    event_id: ev.id,
    leaf: ev.hash,
    date,
    index,
    leaves: rows.length,
    proof: merkleProof(rows.map((r) => r.hash), index),
    root: root.root,
    provisional: root.provisional,
    signature: root.signature,
    how_to_verify:
      'Start from leaf; for each step hash sha256(sibling||node) when position is "left", ' +
      'else sha256(node||sibling), over raw bytes. The result must equal root, and root ' +
      'must carry a valid Ed25519 signature from /api/ledger/key.',
  };
}

const selectHead = prepare(
  'SELECT id, hash, at FROM events ORDER BY id DESC LIMIT 1',
);
const countEvents = prepare('SELECT COUNT(*) AS n FROM events');

export async function ledgerHead() {
  const h = await selectHead.get();
  return {
    id: h?.id ?? null,
    hash: h?.hash ?? GENESIS_HASH,
    at: h?.at ?? null,
    count: (await countEvents.get()).n,
    genesis_prev_hash: GENESIS_HASH,
  };
}

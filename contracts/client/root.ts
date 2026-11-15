import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { Hex } from 'viem';

export interface SignedRoot {
  date: string; root: string | null; head: string | null;
  count: number; first_id: number | null; last_id: number | null;
  provisional: false; signature: string;
}
export type PinnedKey = string | Buffer | KeyObject;
export type AnchorParameters = readonly [number, Hex, Hex, bigint, bigint];
export const DAY_MS = 86_400_000;
export function dayNumber(date: string): number {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(ms) || ms < 0 || new Date(ms).toISOString().slice(0, 10) !== date) throw new Error('Invalid calendar date');
  return ms / DAY_MS;
}
export function dateForDay(day: number): string {
  if (!Number.isSafeInteger(day) || day < 0 || day > dayNumber('9999-12-31')) throw new Error('Invalid calendar day');
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}
export function signedPayload(r: SignedRoot): string {
  return JSON.stringify({ date: r.date, root: r.root, head: r.head, count: r.count, first_id: r.first_id, last_id: r.last_id });
}
export function validateRoot(value: unknown, pinnedKey: PinnedKey, now = new Date()): SignedRoot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid root document');
  const r = value as Record<string, unknown>;
  if (typeof r.date !== 'string') throw new Error('Invalid root date');
  dayNumber(r.date);
  if (r.date >= now.toISOString().slice(0, 10) || r.provisional !== false) throw new Error('A completed, final UTC day is required');
  if (typeof r.count !== 'number' || !Number.isSafeInteger(r.count) || r.count < 0) throw new Error('Invalid root count');
  if (r.count === 0) {
    if (r.root !== null || r.head !== null || r.first_id !== null || r.last_id !== null) throw new Error('Invalid empty root');
  } else {
    for (const field of ['root', 'head'] as const) if (typeof r[field] !== 'string' || !/^[a-f0-9]{64}$/.test(r[field]) || /^0+$/.test(r[field])) throw new Error(`Invalid ${field}`);
    for (const field of ['first_id', 'last_id'] as const) if (typeof r[field] !== 'number' || !Number.isSafeInteger(r[field]) || r[field] <= 0) throw new Error(`Invalid ${field}`);
    if ((r.last_id as number) < (r.first_id as number) || r.count > (r.last_id as number) - (r.first_id as number) + 1) throw new Error('Invalid event range');
  }
  const doc = { date: r.date, root: r.root, head: r.head, count: r.count, first_id: r.first_id, last_id: r.last_id, provisional: false, signature: r.signature } as SignedRoot;
  const objectKey = typeof pinnedKey === 'object' && 'type' in pinnedKey;
  if (objectKey ? pinnedKey.type !== 'public' : !/^-----BEGIN PUBLIC KEY-----\s+[A-Za-z0-9+/=\s]+-----END PUBLIC KEY-----\s*$/.test(pinnedKey.toString().trim())) throw new Error('Pin a public PEM key, never a private key');
  const key = objectKey ? pinnedKey as KeyObject : createPublicKey(pinnedKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Pinned ledger key must be Ed25519');
  if (typeof doc.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(doc.signature) || !verify(null, Buffer.from(signedPayload(doc)), key, Buffer.from(doc.signature, 'base64'))) throw new Error('Ledger root signature does not match the pinned key');
  return doc;
}
export function anchorParameters(root: SignedRoot): AnchorParameters {
  if (!root.count || !root.root || !root.head || root.last_id === null) throw new Error('Cannot anchor an empty day');
  return [dayNumber(root.date), `0x${root.root}`, `0x${root.head}`, BigInt(root.count), BigInt(root.last_id)];
}

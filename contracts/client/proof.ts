import { createHash } from 'node:crypto';
import { dayNumber, type SignedRoot } from './root.js';

/** `GET /api/ledger/proof/<event id>`: where one entry sits in its day's Merkle tree. */
export interface InclusionProof {
  event_id: number; leaf: string; date: string; index: number; leaves: number;
  proof: { position: 'left' | 'right'; hash: string }[];
  root: string; provisional: false;
}
const HEX = /^[a-f0-9]{64}$/;
export function validateProof(value: unknown, eventId: number): InclusionProof {
  if (!Number.isSafeInteger(eventId) || eventId <= 0) throw new Error('Invalid event id');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid proof document');
  const p = value as Record<string, unknown>;
  if (p.event_id !== eventId) throw new Error('Proof is for another event');
  if (typeof p.leaf !== 'string' || !HEX.test(p.leaf) || typeof p.root !== 'string' || !HEX.test(p.root)) throw new Error('Invalid proof hashes');
  if (typeof p.date !== 'string') throw new Error('Invalid proof date');
  dayNumber(p.date);
  if (p.provisional !== false) throw new Error('A completed, final UTC day is required');
  const leaves = p.leaves, index = p.index;
  if (typeof leaves !== 'number' || !Number.isSafeInteger(leaves) || leaves < 1 || typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= leaves) throw new Error('Invalid proof position');
  if (!Array.isArray(p.proof) || p.proof.length > 64) throw new Error('Invalid proof path');
  const proof = p.proof.map((step): InclusionProof['proof'][number] => {
    const s = step as Record<string, unknown> | null;
    if (!s || (s.position !== 'left' && s.position !== 'right') || typeof s.hash !== 'string' || !HEX.test(s.hash)) throw new Error('Invalid proof step');
    return { position: s.position, hash: s.hash };
  });
  return { event_id: eventId, leaf: p.leaf, date: p.date, index, leaves, proof, root: p.root, provisional: false };
}
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest();
/**
 * Fold the path from the leaf to the root (docs/ledger.md, "Daily roots"):
 * parents are sha256(left || right), and on an odd level the last node pairs
 * with itself. Each step's side must follow from the index, so a path cannot
 * be replayed for another position.
 */
export function foldProof(p: InclusionProof): string {
  let node = Buffer.from(p.leaf, 'hex'), index = p.index, width = p.leaves;
  for (const step of p.proof) {
    if (width <= 1) throw new Error('Proof path is longer than the tree');
    const sibling = Buffer.from(step.hash, 'hex');
    const expected = index % 2 === 1 ? 'left' : 'right';
    if (step.position !== expected) throw new Error('Proof step is on the wrong side for its index');
    if (expected === 'right' && index === width - 1 && !sibling.equals(node)) throw new Error('The last node of an odd level must pair with itself');
    node = sha256(expected === 'left' ? Buffer.concat([sibling, node]) : Buffer.concat([node, sibling]));
    index = Math.floor(index / 2); width = Math.ceil(width / 2);
  }
  if (width !== 1) throw new Error('Proof path is shorter than the tree');
  return node.toString('hex');
}
/** The entry's hash is the leaf, the path reaches the signed root, and the counts agree. */
export function checkInclusion(p: InclusionProof, root: SignedRoot, eventHash: string): void {
  if (!HEX.test(eventHash) || eventHash !== p.leaf) throw new Error('Event hash differs from the proof leaf');
  if (root.date !== p.date || root.root !== p.root) throw new Error('Proof root differs from the signed root');
  if (root.count !== p.leaves) throw new Error('Proof leaf count differs from the signed root');
  if (root.first_id === null || root.last_id === null || p.event_id < root.first_id || p.event_id > root.last_id) throw new Error('Event lies outside the signed day');
  if (foldProof(p) !== root.root) throw new Error('Inclusion proof does not reach the signed root');
}

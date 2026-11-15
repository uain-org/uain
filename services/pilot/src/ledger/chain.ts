/** Pure ledger commitments: no database, filesystem, key or startup effects. */
import { createHash } from 'node:crypto';
export interface EventContent {
  id: number; at: string; kind: string; actor: string | null; peer?: string | null; summary: string;
  hash_version?: number | string | null; content_digest?: string | null;
}
export interface LedgerEvent extends EventContent {
  peer: string | null; hash: string; prev_hash: string; redacted: boolean | number;
  salt?: string | null; commits?: string | null;
}
export interface ChainIssue {
  id: number; error: 'broken_link' | 'content_mismatch' | 'bad_redaction' | 'unknown_version';
  expected?: string; found?: string;
}
export const GENESIS_HASH = '0'.repeat(64);
/**
 * Entries written from here on. Version 1 hashed the summary itself, so a
 * purge that replaced it left nothing of the entry checkable, and any text
 * passed. Version 2 hashes a salted digest of the summary and of `commits`
 * (ledger/records.ts) instead: a purge erases both with the salt, and every
 * other field stays checkable against the hash. Entries written before it
 * stay version 1 and hash exactly as they always did.
 */
export const HASH_VERSION = 2;
/** The only text a purged version 2 entry may carry. */
export const REDACTED_SUMMARY = '[redacted: participant record purged by the operator]';
export const contentDigest = (salt: string, summary: string, commits: string | null = null): string =>
  createHash('sha256').update(`${salt}\n${JSON.stringify([summary, commits])}`).digest('hex');
const versionOf = (event: { hash_version?: number | string | null }): number => Number(event.hash_version ?? 1);
/**
 * Array order and newline separation are the existing wire commitment.
 * Version 2 also commits to the previous entry's version (null for the
 * first), so an entry cannot be relabelled version 1, whose purged entries go
 * unchecked, without the entry after it showing it.
 */
export const eventContent = (event: EventContent, previousVersion: number | null = null): string =>
  versionOf(event) === HASH_VERSION
    ? JSON.stringify([HASH_VERSION, event.id, event.at, event.kind, event.actor, event.peer ?? null,
      event.content_digest ?? null, previousVersion])
    : JSON.stringify([event.id, event.at, event.kind, event.actor, event.peer ?? null, event.summary]);
export const chainHash = (previous: string, content: string): string =>
  createHash('sha256').update(`${previous}\n${content}`).digest('hex');

/** Whole ledger or a prefix from genesis, ordered by id; IDs may have holes. */
export function verifyChain(rows: LedgerEvent[]) {
  const errors: ChainIssue[] = [];
  let previous = GENESIS_HASH;
  let previousVersion: number | null = null;
  let contentChecked = 0;
  let redacted = 0;
  for (const row of rows) {
    if (row.prev_hash !== previous)
      errors.push({ id: row.id, error: 'broken_link', expected: previous, found: row.prev_hash });
    const version = versionOf(row);
    if (row.redacted) redacted++;
    if (version === HASH_VERSION) {
      // A purged entry carries the marker and nothing else; any other
      // carries the text and commitment its digest was taken over.
      const textOk = row.redacted
        ? row.summary === REDACTED_SUMMARY && row.salt == null && row.commits == null
        : row.salt != null && contentDigest(row.salt, row.summary, row.commits ?? null) === row.content_digest;
      if (!textOk) errors.push({ id: row.id, error: row.redacted ? 'bad_redaction' : 'content_mismatch' });
      if (chainHash(row.prev_hash, eventContent(row, previousVersion)) !== row.hash)
        errors.push({ id: row.id, error: 'content_mismatch' });
      contentChecked++;
    } else if (version !== 1) {
      errors.push({ id: row.id, error: 'unknown_version' });
    } else if (!row.redacted) {
      if (chainHash(row.prev_hash, eventContent(row)) !== row.hash)
        errors.push({ id: row.id, error: 'content_mismatch' });
      contentChecked++;
    }
    previous = row.hash;
    previousVersion = version;
  }
  return { ok: errors.length === 0, entries: rows.length, content_checked: contentChecked,
    redacted, head: previous, errors };
}

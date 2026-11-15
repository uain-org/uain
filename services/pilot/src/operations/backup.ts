import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Client, PoolClient } from 'pg';

export interface TableSnapshot { count: number; sha256: string }
export interface DatabaseSnapshot {
  tables: Record<string, TableSnapshot>;
  sequences: Array<{ sequencename: string; last_value: string | null }>;
}
export interface BackupBundle {
  version: 1;
  dump: string;
  files: Record<string, string>;
  source?: string;
  at?: string;
  snapshot?: DatabaseSnapshot;
}

const MAGIC = Buffer.from('UAINBK01');
const LIMIT = 128 * 1024 * 1024;
// A bundle is built and sealed in memory, so this is the most it may hold
// before the store needs a streaming format instead.
export const BACKUP_LIMIT = LIMIT;
const keyBytes = (hex: string): Buffer => {
  if (!/^[a-f0-9]{64}$/i.test(hex ?? '')) throw new Error('Backup key must be a 32-byte hexadecimal secret');
  return Buffer.from(hex, 'hex');
};
export function encryptBackup(content: BackupBundle, key: string): Buffer {
  const plaintext = Buffer.from(JSON.stringify(content));
  if (plaintext.length > LIMIT) throw new Error('Pilot backup limit exceeded; use a streaming backup system');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(key), iv);
  cipher.setAAD(MAGIC);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), encrypted]);
}
export function decryptBackup(sealed: Buffer, key: string): BackupBundle {
  if (!Buffer.isBuffer(sealed) || sealed.length < 37 || sealed.length > LIMIT + 36 || !sealed.subarray(0, 8).equals(MAGIC)) throw new Error('Invalid backup format');
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(key), sealed.subarray(8, 20));
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(sealed.subarray(20, 36));
  let plain;
  try { plain = Buffer.concat([decipher.update(sealed.subarray(36)), decipher.final()]); }
  catch { throw new Error('Backup authentication failed'); }
  const result = JSON.parse(plain.toString('utf8'));
  if (result.version !== 1) throw new Error('Unsupported backup version');
  return result;
}
export function assertLocalTestDatabase(url: URL): true {
  if (url.hostname !== '127.0.0.1' || url.port !== '55432' || url.username !== 'uain_local_test' || url.pathname !== '/uain_local_test') throw new Error('Refusing anything except the isolated local test database');
  return true;
}

// Uses a caller-held repeatable-read snapshot. Sort full row JSON so no table
// depends on physical row order, primary-key presence or sequence names.
export async function snapshotTables(client: Client | PoolClient): Promise<DatabaseSnapshot> {
  const { rows } = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  const tables: Record<string, TableSnapshot> = {};
  for (const { tablename } of rows) {
    const quoted = '"' + tablename.replaceAll('"', '""') + '"';
    const result = await client.query(`SELECT to_jsonb(t)::text AS row FROM public.${quoted} t ORDER BY to_jsonb(t)::text COLLATE "C"`);
    const hash = createHash('sha256');
    for (const row of result.rows) hash.update(row.row + '\n');
    tables[tablename] = { count: result.rowCount ?? result.rows.length, sha256: hash.digest('hex') };
  }
  return { tables, sequences: await readSequences(client) };
}

// Sequences stand outside every snapshot: each read sees the value of that
// moment, whatever transaction it is in.
export async function readSequences(client: Client | PoolClient): Promise<DatabaseSnapshot['sequences']> {
  const sequences = await client.query("SELECT sequencename, last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename");
  return sequences.rows;
}

/**
 * What differs between the snapshot a backup recorded and a database's own,
 * one line each, so a restore can say which table went wrong. Empty when
 * they match.
 *
 * Tables must match exactly. A sequence need only not be behind: the backup
 * reads sequences as the snapshot opens and pg_dump reads them a moment
 * later, so on a busy server the dump's are ahead, and a restored sequence
 * that is ahead still hands out no id already taken.
 */
export function snapshotDifferences(expected: DatabaseSnapshot, actual: DatabaseSnapshot): string[] {
  const out: string[] = [];
  const names = new Set([...Object.keys(expected.tables), ...Object.keys(actual.tables)]);
  for (const name of [...names].sort()) {
    const want = expected.tables[name];
    const got = actual.tables[name];
    if (!got) out.push(`${name}: missing (backup has ${want.count} rows)`);
    else if (!want) out.push(`${name}: not in the backup (${got.count} rows here)`);
    else if (want.count !== got.count) out.push(`${name}: ${got.count} rows, backup has ${want.count}`);
    else if (want.sha256 !== got.sha256) out.push(`${name}: same ${got.count} rows counted, different contents`);
  }
  const sequences = (s: DatabaseSnapshot) => new Map(s.sequences.map((q) => [q.sequencename, q.last_value]));
  const want = sequences(expected);
  const got = sequences(actual);
  // null: never used, so behind any value.
  const position = (v: string | null | undefined) => (v == null ? -1n : BigInt(v));
  for (const name of [...want.keys()].sort()) {
    if (!got.has(name)) out.push(`sequence ${name}: missing`);
    else if (position(got.get(name)) < position(want.get(name)))
      out.push(`sequence ${name}: at ${got.get(name) ?? 'nothing'}, behind the backup's ${want.get(name)}`);
  }
  for (const name of [...got.keys()].sort()) if (!want.has(name)) out.push(`sequence ${name}: not in the backup`);
  return out;
}

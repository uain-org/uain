/**
 * The connection server's half of a backup and of a restore. The shell
 * scripts in ops/backup run pg_dump and pg_restore in the database container;
 * this runs where the server's data directory and database connection are, in
 * a pilot container (or on a machine with the compiled server, for a drill).
 *
 *   node dist/src/operations/backup-cli.js <command>
 *
 * Every command reads the backup key as the first line of standard input, so
 * the key is never on a command line, in an environment listing or on disk.
 * What follows the key depends on the command:
 *
 *   seal           Opens a read-only snapshot of the database and prints
 *                  "snapshot <id>", for pg_dump --snapshot to share. Then reads
 *                  the dump (pg_dump custom format) until input ends, counts
 *                  and hashes every table in the same snapshot, adds
 *                  ledger.key and log.salt from the data directory, and writes
 *                  the sealed backup after the snapshot line. The dump and the
 *                  counts see the same rows, however busy the server is.
 *   verify <name>  Reads a sealed backup, opens and checks it, and prints its
 *                  manifest: sizes, sha256, the signing key's public half and
 *                  the table snapshot. Never prints anything secret.
 *   dump           Reads a sealed backup and prints the dump inside it. That is
 *                  plaintext: pipe it straight into pg_restore.
 *   files          Reads a sealed backup and puts ledger.key and log.salt into
 *                  the data directory. Refuses to replace a file that differs.
 *   compare        Reads a sealed backup and checks the database (DATABASE_URL)
 *                  against the snapshot inside it: every table exactly, and no
 *                  sequence behind (operations/backup.ts, snapshotDifferences).
 *
 * The bundle is the one services/pilot/scripts/backup-drill.mjs writes
 * (UAINBK01, operations/backup.ts), so either can open the other's.
 */
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { isatty } from 'node:tty';
import pg from 'pg';
import { DATA_DIR } from '../config.ts';
import {
  BACKUP_LIMIT,
  decryptBackup,
  encryptBackup,
  readSequences,
  snapshotDifferences,
  snapshotTables,
} from './backup.ts';
import type { BackupBundle, DatabaseSnapshot } from './backup.ts';

// What makes this server itself: the ledger's signing key and the salt its
// session tokens and log are hashed with. Everything else lives in PostgreSQL.
const FILES = ['ledger.key', 'log.salt'] as const;
// The header encryptBackup puts before the ciphertext: magic, IV, tag.
const HEADER = 36;
const CUSTOM_DUMP = Buffer.from('PGDMP');

/**
 * Standard input, read a line at a time and then all at once. Read as a file,
 * not as process.stdin: on macOS a socket-style stdin on a named pipe never
 * sees the end of its input, and the backup script feeds this through one.
 */
class Input {
  private readonly chunks: AsyncIterator<Buffer>;
  private held: Buffer = Buffer.alloc(0);

  constructor() {
    const stream = createReadStream('', { fd: 0, highWaterMark: 1 << 20 });
    this.chunks = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  async line(max: number): Promise<string> {
    for (;;) {
      const end = this.held.indexOf(10);
      if (end >= 0) {
        const line = this.held.subarray(0, end).toString('utf8').replace(/\r$/, '');
        this.held = this.held.subarray(end + 1);
        return line;
      }
      if (this.held.length > max) throw new Error('The first line of input is too long');
      const next = await this.chunks.next();
      if (next.done) throw new Error('Input ended before its first line did');
      this.held = Buffer.concat([this.held, next.value]);
    }
  }

  async rest(max: number): Promise<Buffer> {
    const parts: Buffer[] = [this.held];
    let size = this.held.length;
    this.held = Buffer.alloc(0);
    for (;;) {
      const next = await this.chunks.next();
      if (next.done) break;
      size += next.value.length;
      if (size > max) throw new Error(`Input is larger than ${max} bytes`);
      parts.push(next.value);
    }
    return Buffer.concat(parts, size);
  }
}

// Standard output as a file too, for the same reason, and so a large backup
// is written out in full before the process ends.
const output = createWriteStream('', { fd: 1 });
const emit = (data: Buffer | string): Promise<void> =>
  new Promise((resolve, reject) => output.write(data, (e) => (e ? reject(e) : resolve())));

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** The public half of a ledger key, or an error if it is not one. */
function ledgerPublicKey(pem: string): string {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('ledger.key is not an Ed25519 private key');
  return createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
}

function checkFiles(files: Record<string, string>): string {
  for (const name of FILES)
    if (typeof files[name] !== 'string' || files[name].length === 0) throw new Error(`The backup has no ${name}`);
  if (!/^[0-9a-f]{64}$/.test(Buffer.from(files['log.salt'], 'base64').toString('utf8').trim()))
    throw new Error('log.salt in the backup is not 64 hexadecimal characters');
  return ledgerPublicKey(Buffer.from(files['ledger.key'], 'base64').toString('utf8'));
}

function checkBundle(bundle: BackupBundle): { dump: Buffer; snapshot: DatabaseSnapshot; publicKey: string } {
  const dump = Buffer.from(bundle.dump ?? '', 'base64');
  if (!dump.subarray(0, CUSTOM_DUMP.length).equals(CUSTOM_DUMP))
    throw new Error('The dump in the backup is not in pg_dump custom format');
  if (!bundle.snapshot?.tables) throw new Error('The backup has no table snapshot to check a restore against');
  return { dump, snapshot: bundle.snapshot, publicKey: checkFiles(bundle.files ?? {}) };
}

async function withClient<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function seal(input: Input, key: string): Promise<void> {
  // Read the files first, so a missing one fails before pg_dump starts.
  const files: Record<string, string> = {};
  for (const name of FILES) files[name] = readFileSync(join(DATA_DIR, name)).toString('base64');
  checkFiles(files);

  await withClient(async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows } = await client.query(
      'SELECT pg_export_snapshot() AS snapshot, current_database() AS database, now() AS at',
    );
    // Before pg_dump reads its own, so the dump's can only be ahead of these.
    const sequences = await readSequences(client);
    // pg_dump imports this snapshot, and can only while this transaction is
    // open, so it stays open until the dump has arrived.
    await emit(`snapshot ${rows[0].snapshot}\n`);
    const dump = await input.rest(BACKUP_LIMIT);
    if (!dump.subarray(0, CUSTOM_DUMP.length).equals(CUSTOM_DUMP))
      throw new Error('The dump did not arrive, or is not in pg_dump custom format');
    const snapshot: DatabaseSnapshot = { tables: (await snapshotTables(client)).tables, sequences };
    await client.query('COMMIT');

    const bundle: BackupBundle = {
      version: 1,
      source: rows[0].database,
      at: new Date(rows[0].at).toISOString(),
      snapshot,
      files,
      dump: dump.toString('base64'),
    };
    const sealed = encryptBackup(bundle, key);
    // Open it again before handing it over: a backup that cannot be read back
    // is worse than none, because it looks like one.
    const reopened = decryptBackup(sealed, key);
    if (reopened.dump !== bundle.dump || JSON.stringify(reopened.snapshot) !== JSON.stringify(snapshot))
      throw new Error('The sealed backup did not read back the same');
    await emit(sealed);
  });
}

async function verify(input: Input, key: string, name: string): Promise<void> {
  if (!/^[\w.-]{1,128}$/.test(name ?? '')) throw new Error('verify needs the backup file name');
  const sealed = await input.rest(BACKUP_LIMIT + HEADER);
  const bundle = decryptBackup(sealed, key);
  const { dump, snapshot, publicKey } = checkBundle(bundle);
  const counts = Object.values(snapshot.tables);
  const manifest = {
    file: name,
    sealed_bytes: sealed.length,
    sealed_sha256: sha256(sealed),
    encryption: 'UAINBK01: AES-256-GCM under UAIN_BACKUP_KEY',
    taken_at: bundle.at ?? null,
    database: bundle.source ?? null,
    dump_format: 'pg_dump custom',
    dump_bytes: dump.length,
    plaintext_bytes: sealed.length - HEADER,
    limit_bytes: BACKUP_LIMIT,
    files: Object.keys(bundle.files).sort(),
    ledger_public_key: publicKey,
    tables: counts.length,
    rows: counts.reduce((sum, t) => sum + t.count, 0),
    snapshot,
  };
  await emit(JSON.stringify(manifest, null, 2) + '\n');
}

async function dump(input: Input, key: string): Promise<void> {
  if (isatty(1)) throw new Error('Refusing to print a database dump to a terminal; pipe it into pg_restore');
  const bundle = decryptBackup(await input.rest(BACKUP_LIMIT + HEADER), key);
  await emit(checkBundle(bundle).dump);
}

async function files(input: Input, key: string): Promise<void> {
  const bundle = decryptBackup(await input.rest(BACKUP_LIMIT + HEADER), key);
  checkBundle(bundle);
  const written: string[] = [];
  const alreadyThere: string[] = [];
  for (const name of FILES) {
    const path = join(DATA_DIR, name);
    const content = Buffer.from(bundle.files[name], 'base64');
    let existing: Buffer | null = null;
    try {
      existing = readFileSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (existing) {
      // Replacing either would make this a different server: roots signed
      // with another key, every session token hashed with another salt.
      if (!existing.equals(content))
        throw new Error(`${path} is already there and differs from the backup; refusing to replace it`);
      alreadyThere.push(name);
      continue;
    }
    // Private from the start, and on disk before this reports success.
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    written.push(name);
  }
  await emit(JSON.stringify({ data_dir: DATA_DIR, written, already_there: alreadyThere }) + '\n');
}

async function compare(input: Input, key: string): Promise<void> {
  const bundle = decryptBackup(await input.rest(BACKUP_LIMIT + HEADER), key);
  const { snapshot: expected } = checkBundle(bundle);
  const actual = await withClient(async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      return await snapshotTables(client);
    } finally {
      await client.query('COMMIT');
    }
  });
  const differences = snapshotDifferences(expected, actual);
  const counts = Object.values(actual.tables);
  await emit(
    JSON.stringify({
      status: differences.length ? 'differs' : 'match',
      tables: counts.length,
      rows: counts.reduce((sum, t) => sum + t.count, 0),
      sequences: actual.sequences.length,
      differences,
    }) + '\n',
  );
  if (differences.length) process.exitCode = 1;
}

const [command, argument] = process.argv.slice(2);
try {
  const commands: Record<string, (input: Input, key: string) => Promise<void>> = {
    seal,
    verify: (input, key) => verify(input, key, argument),
    dump,
    files,
    compare,
  };
  const run = commands[command];
  if (!run) throw new Error('Usage: backup-cli.js seal | verify <name> | dump | files | compare');
  const input = new Input();
  const key = (await input.line(256)).trim();
  if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error('The first line of input must be the 32-byte backup key, in hexadecimal');
  await run(input, key);
  await new Promise<void>((resolve) => output.end(resolve));
} catch (e) {
  // Messages here never carry the key or the data, only what went wrong.
  console.error(`backup-cli ${command ?? ''}: ${(e as Error).message}`);
  process.exitCode = 1;
}

// Local recovery proof only; no production DB or off-host destination defaults.
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import pg from 'pg';
import { encryptBackup, decryptBackup, snapshotTables, assertLocalTestDatabase } from '../dist/src/operations/backup.js';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '../../..');
const url = new URL(process.env.DATABASE_URL);
assertLocalTestDatabase(url);
const keyDir = resolve(process.env.UAIN_DATA_DIR);
if (keyDir !== resolve(root, 'work/local-pilot')) throw new Error('Unexpected local signing directory');
const binary = name => join(process.env.UAIN_PG_BIN ?? (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/17/bin' : '/usr/bin'), name + (process.platform === 'win32' ? '.exe' : ''));
const childEnv = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
childEnv.PGPASSWORD = decodeURIComponent(url.password);
const connection = database => ['--host', url.hostname, '--port', url.port, '--username', url.username, '--dbname', database];
const source = new pg.Client({ connectionString: url.toString() });
const restoredName = `uain_restore_${process.pid}_${Date.now().toString(36)}`;
const restoreUrl = new URL(url); restoreUrl.pathname = `/${restoredName}`;
const restored = new pg.Client({ connectionString: restoreUrl.toString() });
const adminUrl = new URL(url); adminUrl.pathname = '/postgres';
const admin = new pg.Client({ connectionString: adminUrl.toString() });
const dir = resolve(root, 'work/backups');
await mkdir(dir, { recursive: true });
let key = process.env.UAIN_LOCAL_BACKUP_KEY;
if (!key) {
  key = randomBytes(32).toString('hex');
  await appendFile(resolve(root, '.env'), `\n# Local backup encryption only; store separately for real recovery.\nUAIN_LOCAL_BACKUP_KEY=${key}\n`);
}
let created = false;
const dumpPath = resolve(dir, `${restoredName}.dump`);
try {
  await source.connect();
  await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const { rows } = await source.query('SELECT pg_export_snapshot() AS snapshot');
  const before = await snapshotTables(source);
  const dump = await exec(binary('pg_dump'), [...connection('uain_local_test'), '--format=custom', '--no-owner', '--no-privileges', '--snapshot', rows[0].snapshot], { env: childEnv, encoding: 'buffer', maxBuffer: 90 * 1024 * 1024, timeout: 120_000 });
  const files = {};
  for (const name of ['ledger.key', 'log.salt']) files[name] = (await readFile(resolve(keyDir, name))).toString('base64');
  const packed = encryptBackup({ version: 1, source: 'uain_local_test', at: new Date().toISOString(), snapshot: before, files, dump: dump.stdout.toString('base64') }, key);
  const backup = resolve(dir, `${restoredName}.uain-backup`);
  await writeFile(backup, packed, { mode: 0o600, flag: 'wx' });
  await source.query('COMMIT');
  // Read the saved ciphertext rather than reusing the in-memory source.
  const recovered = decryptBackup(await readFile(backup), key);
  await writeFile(dumpPath, Buffer.from(recovered.dump, 'base64'), { mode: 0o600, flag: 'wx' });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${restoredName} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
  created = true;
  await exec(binary('pg_restore'), [...connection(restoredName), '--exit-on-error', '--no-owner', '--no-privileges', dumpPath], { env: childEnv, timeout: 120_000 });
  await restored.connect();
  const after = await snapshotTables(restored);
  if (JSON.stringify(after) !== JSON.stringify(recovered.snapshot)) throw new Error('Restored rows or sequences differ from the backup snapshot');
  const { verifyChain } = await import('../dist/src/ledger/chain.js');
  const chain = verifyChain((await restored.query('SELECT * FROM events ORDER BY id')).rows);
  if (!chain.ok) throw new Error('Restored event chain is invalid');
  const restoredKeys = resolve(dir, `${restoredName}-keys`);
  await mkdir(restoredKeys, { recursive: true });
  for (const name of ['ledger.key', 'log.salt']) {
    const material = Buffer.from(recovered.files[name], 'base64');
    await writeFile(resolve(restoredKeys, name), material, { mode: 0o600, flag: 'wx' });
    if (!(await readFile(resolve(restoredKeys, name))).equals(await readFile(resolve(keyDir, name)))) throw new Error('Signing material differs');
  }
  const evidence = { at: new Date().toISOString(), status: 'passed', source: 'uain_local_test', restoredDatabase: restoredName, tableCount: Object.keys(after.tables).length, snapshot: after, backupSha256: createHash('sha256').update(packed).digest('hex'), signingMaterialMatched: true, restoredChainValid: true, restoredLedgerEntries: chain.entries, offHost: false };
  await writeFile(resolve(dir, 'latest-drill.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ status: 'passed', tableCount: evidence.tableCount, signingMaterialMatched: true, restoredChainValid: true, restoredLedgerEntries: chain.entries, offHost: false }));
} catch (error) {
  // Child process failures may contain connection strings; do not echo stderr.
  console.error(error.code ? `Backup drill failed (${error.code})` : error.message);
  process.exitCode = 1;
} finally {
  // Always remove this drill's known plaintext dump, including restore failures.
  const { unlink } = await import('node:fs/promises');
  await unlink(dumpPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await restored.end().catch(() => {});
  try { if (created) await admin.query(`DROP DATABASE ${restoredName}`); }
  finally {
    await admin.end().catch(() => {});
    await source.end().catch(() => {});
  }
}

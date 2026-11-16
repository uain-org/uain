import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { randomBytes, createHash, createPublicKey } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptBackup, decryptBackup, assertLocalTestDatabase, snapshotDifferences } from '../dist/src/operations/backup.js';
import { boot } from './helpers.mjs';
import pg from 'pg';

test('encrypted backups authenticate the dump, metadata and signing material', () => {
  const key = randomBytes(32).toString('hex');
  const content = { version: 1, dump: 'test dump', files: { 'ledger.key': 'private fixture' } };
  const sealed = encryptBackup(content, key);
  assert.ok(!sealed.includes(Buffer.from('private fixture')));
  assert.deepEqual(decryptBackup(sealed, key), content);
  assert.throws(() => decryptBackup(sealed, randomBytes(32).toString('hex')), /authentication/);
  const modified = Buffer.from(sealed); modified[modified.length - 1] ^= 1;
  assert.throws(() => decryptBackup(modified, key), /authentication/);
  assert.throws(() => encryptBackup(content, 'short'), /32-byte/);
});

test('restore drills refuse a production or ambiguous database target', () => {
  assert.equal(assertLocalTestDatabase(new URL('postgres://uain_local_test:x@127.0.0.1:55432/uain_local_test')), true);
  for (const target of ['postgres://uain:x@production:5432/uain', 'postgres://uain_local_test:x@127.0.0.1:5432/uain_local_test', 'postgres://postgres@127.0.0.1:55432/uain']) assert.throws(() => assertLocalTestDatabase(new URL(target)), /local test/);
});

test('a restored database must match every table exactly, and no sequence may be behind', () => {
  const backup = {
    tables: { events: { count: 2, sha256: 'a' }, members: { count: 1, sha256: 'b' } },
    sequences: [{ sequencename: 'events_id_seq', last_value: '9' }, { sequencename: 'unused', last_value: null }],
  };
  assert.deepEqual(snapshotDifferences(backup, structuredClone(backup)), []);
  // pg_dump reads sequences a moment after the backup's snapshot opens.
  const ahead = structuredClone(backup);
  ahead.sequences = [{ sequencename: 'events_id_seq', last_value: '12' }, { sequencename: 'unused', last_value: '1' }];
  assert.deepEqual(snapshotDifferences(backup, ahead), []);

  const wrong = structuredClone(backup);
  wrong.tables.events = { count: 1, sha256: 'c' };
  wrong.tables.members.sha256 = 'd';
  wrong.tables.stray = { count: 0, sha256: 'e' };
  wrong.sequences = [{ sequencename: 'events_id_seq', last_value: '8' }];
  assert.deepEqual(snapshotDifferences(backup, wrong), [
    'events: 1 rows, backup has 2',
    'members: same 1 rows counted, different contents',
    'stray: not in the backup (0 rows here)',
    "sequence events_id_seq: at 8, behind the backup's 9",
    'sequence unused: missing',
  ]);
});

/**
 * Runs backup-cli.js with the key and then `body` on its input. For seal,
 * `body` is a function given the snapshot line, returning the dump.
 */
function cli(args, key, body, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/src/operations/backup-cli.js', ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = [];
    let err = '';
    let fed = typeof body !== 'function';
    child.stdout.on('data', (chunk) => {
      out.push(chunk);
      const all = Buffer.concat(out);
      if (!fed && all.includes(10)) {
        fed = true;
        Promise.resolve().then(() => body(all.subarray(0, all.indexOf(10)).toString()))
          .then(value => child.stdin.end(value), error => { child.kill(); reject(error); });
      }
    });
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out: Buffer.concat(out), err }));
    child.stdin.on('error', () => {});
    child.stdin.write(`${key}\n`);
    if (fed) child.stdin.end(body);
  });
}

test('the backup command seals the store in one snapshot, and the restore commands open, check and put it back', async () => {
  const t = await boot();
  try {
    // The store gets its rows without a request: enrolling over MCP left
    // requests the client sends on its own (the SDK opens a GET /mcp stream
    // after connecting, unawaited), and each counts against the request
    // budget, synced a second later. One landing between the seal and the
    // comparison made "rate_windows: same rows counted, different contents"
    // (2 in 18 runs, 30 September; again 8 and 20 October). With no request in
    // flight there is nothing left to sync, and the comparison stays exact.
    await t.enrol({ name: 'Backup test operator', operator: 'Backup Labs' });
    // A request whose budget count and log line are batched, answered in full
    // before the flush below: something for the flush to send.
    assert.equal((await t.http('/api/stats')).status, 200);
    // Three kinds of write go out in batches: log lines and last seen
    // (application/db.ts), and the request budget (storage/ratelimit.ts).
    // Send them all, so the snapshot and the store it is compared with hold
    // the same rows.
    // Imported after boot: the store connects to the database boot names.
    const { syncCounts } = await import('../dist/src/storage/ratelimit.js');
    await t.db.flushLog();
    await t.db.flushSeen();
    await syncCounts();
    assert.ok((await t.db.prepare('SELECT count(*)::int AS n FROM rate_windows').get()).n > 0, 'the budget sync reached the store');
    // Synthetic fixture rows only. Retain exact values alongside the sealed
    // snapshot hash so a future race is diagnosable without relaxing equality.
    const rateRows = () => t.db.prepare('SELECT id, started, count FROM rate_windows ORDER BY id').all();
    const beforeRate = await rateRows();
    const key = randomBytes(32).toString('hex');
    // A stand-in for pg_dump's output: the CLI checks only its format mark.
    const dump = Buffer.concat([Buffer.from('PGDMP'), randomBytes(4096)]);

    let sealedRate;
    const sealed = await cli(['seal'], key, async (line) => {
      assert.match(line, /^snapshot [0-9A-F]+-[0-9A-F]+-\d+$/);
      // Read the exact exported seal snapshot, rather than guessing its rows
      // from a read before or after it. This connection is test-only.
      const reader = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await reader.connect();
      try {
        await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await reader.query(`SET TRANSACTION SNAPSHOT '${line.slice(9)}'`);
        sealedRate = (await reader.query('SELECT id, started, count FROM rate_windows ORDER BY id')).rows;
        await reader.query('COMMIT');
      } finally { await reader.end(); }
      return dump;
    });
    assert.equal(sealed.code, 0, sealed.err);
    const newline = sealed.out.indexOf(10);
    const file = sealed.out.subarray(newline + 1);
    assert.equal(file.subarray(0, 8).toString(), 'UAINBK01');
    for (const name of ['ledger.key', 'log.salt'])
      assert.ok(!file.includes(readFileSync(join(process.env.UAIN_DATA_DIR, name))), `${name} is not in the clear`);

    const verified = await cli(['verify', 'uain-backup-test.uainbk'], key, file);
    assert.equal(verified.code, 0, verified.err);
    const manifest = JSON.parse(verified.out);
    assert.equal(manifest.sealed_sha256, createHash('sha256').update(file).digest('hex'));
    assert.equal(manifest.sealed_bytes, file.length);
    assert.equal(manifest.dump_bytes, dump.length);
    assert.deepEqual(manifest.files, ['ledger.key', 'log.salt']);
    assert.ok(manifest.snapshot.tables.events.count > 0);
    assert.ok(!verified.out.toString().includes(key));

    const opened = await cli(['dump'], key, file);
    assert.equal(opened.code, 0, opened.err);
    assert.ok(opened.out.equals(dump));

    // Nothing written since the seal: the store matches its snapshot.
    const beforeCompareRate = await rateRows();
    const same = await cli(['compare'], key, file);
    const afterCompareRate = await rateRows();
    const rateEvidence = { before: beforeRate, sealed: { rows: sealedRate, table: manifest.snapshot.tables.rate_windows },
      beforeCompare: beforeCompareRate, afterCompare: afterCompareRate };
    console.log('BACKUP_RATE_EVIDENCE', JSON.stringify(rateEvidence));
    assert.equal(same.code, 0, same.out.toString() + same.err + JSON.stringify(rateEvidence));
    assert.equal(JSON.parse(same.out).status, 'match');
    await t.member('Written after the backup');
    const moved = await cli(['compare'], key, file);
    assert.equal(moved.code, 1);
    assert.ok(JSON.parse(moved.out).differences.some((d) => d.startsWith('events: ')));
    const served = (await (await t.http('/api/ledger/key')).json()).pem;
    assert.ok(createPublicKey(manifest.ledger_public_key).equals(createPublicKey(served)));

    const restored = mkdtempSync(join(tmpdir(), 'uain-restore-test-'));
    const put = await cli(['files'], key, file, { UAIN_DATA_DIR: restored });
    assert.equal(put.code, 0, put.err);
    assert.deepEqual(JSON.parse(put.out).written, ['ledger.key', 'log.salt']);
    for (const name of ['ledger.key', 'log.salt'])
      assert.ok(readFileSync(join(restored, name)).equals(readFileSync(join(process.env.UAIN_DATA_DIR, name))));
    assert.deepEqual(JSON.parse((await cli(['files'], key, file, { UAIN_DATA_DIR: restored })).out).already_there, ['ledger.key', 'log.salt']);
    // A server's identity is never replaced.
    const other = mkdtempSync(join(tmpdir(), 'uain-restore-test-'));
    writeFileSync(join(other, 'ledger.key'), 'another server\n');
    const refused = await cli(['files'], key, file, { UAIN_DATA_DIR: other });
    assert.equal(refused.code, 1);
    assert.match(refused.err, /differs from the backup; refusing to replace it/);
    assert.equal(readFileSync(join(other, 'ledger.key'), 'utf8'), 'another server\n');

    const wrong = await cli(['dump'], randomBytes(32).toString('hex'), file);
    assert.equal(wrong.code, 1);
    assert.equal(wrong.out.length, 0);
    assert.match(wrong.err, /authentication failed/);
    const noKey = await cli(['verify', 'x.uainbk'], 'not-a-key', file);
    assert.equal(noKey.code, 1);
    assert.match(noKey.err, /first line of input must be the 32-byte backup key/);

    // The seal refuses input that is not a pg_dump custom-format dump.
    const notDump = await cli(['seal'], key, () => Buffer.from('plain SQL'));
    assert.equal(notDump.code, 1);
    assert.match(notDump.err, /not in pg_dump custom format/);
  } finally {
    await t.close();
  }
});

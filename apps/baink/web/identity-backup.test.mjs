import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity, exportIdentity, importIdentity } from './identity.js';
import { encryptIdentityBackup, decryptIdentityBackup, isIdentityBackup, identityBackupAddress } from './identity-backup.js';

const PASS = 'correct horse battery staple', FAST = { iterations: 100000 };

test('encrypted identity backup round-trips to the same address and signs', async () => {
  const identity = await createIdentity(), plain = await exportIdentity(identity);
  const backup = await encryptIdentityBackup(plain, PASS, FAST);
  assert.ok(isIdentityBackup(backup)); assert.equal(identityBackupAddress(backup), identity.address);
  assert.ok(!backup.includes(JSON.parse(plain).private_key), 'the private key never appears in clear');
  const restored = await importIdentity(await decryptIdentityBackup(backup, PASS));
  assert.equal(restored.address, identity.address);
});

test('wrong passphrase, weak passphrase, damage and header edits are refused distinctly', async () => {
  const plain = await exportIdentity(await createIdentity()), backup = await encryptIdentityBackup(plain, PASS, FAST);
  await assert.rejects(encryptIdentityBackup(plain, 'short', FAST), (e) => e.code === 'IDENTITY_BACKUP_WEAK');
  await assert.rejects(decryptIdentityBackup(backup, 'a different passphrase'), (e) => e.code === 'IDENTITY_BACKUP_WRONG');
  await assert.rejects(decryptIdentityBackup(backup, 'short'), (e) => e.code === 'IDENTITY_BACKUP_WRONG');
  const v = JSON.parse(backup);
  const flipped = v.ciphertext.slice(0, 10) + (v.ciphertext[10] === 'A' ? 'B' : 'A') + v.ciphertext.slice(11);
  await assert.rejects(decryptIdentityBackup(JSON.stringify({ ...v, ciphertext: flipped }), PASS), (e) => e.code === 'IDENTITY_BACKUP_CORRUPT');
  await assert.rejects(decryptIdentityBackup(JSON.stringify({ ...v, address: 'uain1' + '0'.repeat(40) }), PASS), (e) => e.code === 'IDENTITY_BACKUP_CORRUPT', 'the address header is authenticated');
  await assert.rejects(decryptIdentityBackup(backup.slice(0, 120), PASS), (e) => e.code === 'IDENTITY_BACKUP_CORRUPT');
  assert.equal(isIdentityBackup(plain), false);
});

test('the Account page hands out the key only as an encrypted backup (security review L4)', async () => {
  const { accountBackupProblem, MIN_PASSPHRASE } = await import('./identity-backup.js');
  const { readFile } = await import('node:fs/promises');
  assert.match(accountBackupProblem('short', 'short'), new RegExp(`at least ${MIN_PASSPHRASE} characters`));
  assert.equal(accountBackupProblem('a long enough passphrase', 'a different passphrase'), 'The two passphrases differ.');
  assert.equal(accountBackupProblem('a long enough passphrase', 'a long enough passphrase'), '');
  assert.match(accountBackupProblem(undefined, undefined), /at least/);
  // Every place the web app turns the identity into a file goes through encryptIdentityBackup:
  // exportIdentity(...) is never handed to a Blob or a download on its own.
  const source = await readFile(new URL('./main.jsx', import.meta.url), 'utf8');
  const exports = [...source.matchAll(/exportIdentity\(identity\)/g)];
  assert.ok(exports.length >= 2, 'sign-up and the Account page both export');
  for (const m of exports) assert.equal(source.slice(m.index - 34, m.index), 'await encryptIdentityBackup(await ', 'the exported key is encrypted at once');
  assert.doesNotMatch(source, /Download private backup|baink-identity-\$\{[^}]+\}\.json/, 'no plain key download remains');
});

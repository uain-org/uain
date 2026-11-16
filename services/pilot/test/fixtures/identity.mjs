/**
 * One copy of the server starting, for identity-files.test.mjs: loads the
 * ledger's signing key and the log salt the way the server does, from
 * UAIN_DATA_DIR, and prints what it loaded. Takes DATABASE_URL from the
 * environment, since the salt is loaded by db.js.
 */
// Everything the two modules need but the files is loaded first, so that on
// the test's word every copy reaches the files at nearly the same moment.
await import('../../dist/src/storage/store.js');
process.stdout.write('ready\n');
await new Promise((resolve) => process.stdin.once('data', resolve));
// Listening on stdin would otherwise keep this process alive after loading.
process.stdin.destroy();
const [ledger, db] = await Promise.all([
  import('../../dist/src/ledger/ledger.js'),
  import('../../dist/src/application/db.js'),
]);
// The salt is not exported; a caller's hash is made from it and nothing else.
process.stdout.write(
  `${JSON.stringify({ key: ledger.publicKeyInfo().raw_base64, caller: db.hashCaller('probe') })}\n`,
);
await (await import('../../dist/src/storage/store.js')).close();

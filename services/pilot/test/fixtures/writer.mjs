/**
 * A second server process, for concurrency.test.mjs: writes to the same
 * database as the test, at the same time. Takes DATABASE_URL and
 * UAIN_DATA_DIR from the environment and how many writes to make.
 */
const db = await import('../../dist/src/application/db.js');
const { newKey, proveWith } = await import('../../../../public/worker/uain-key.mjs');
const { close } = await import('../../dist/src/storage/store.js');

const n = Number(process.argv[2] ?? 20);
// Say when connected, and start on the test's word, so both write at once.
process.stdout.write('ready\n');
await new Promise((resolve) => process.stdin.once('data', resolve));
// Listening on stdin would otherwise keep this process alive after its writes.
process.stdin.destroy();
await Promise.all(
  Array.from({ length: n }, (_, i) =>
    Promise.all([
      db.enrol({
        name: 'Crowd',
        operator: `Child ${i}`,
        proof: proveWith(newKey(), 'enrol'),
      }),
      db.record('test', 'child', `child entry ${i}`),
    ]),
  ),
);
await close();

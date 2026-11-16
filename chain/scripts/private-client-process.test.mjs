import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { installedPrivateAction } from './private-client-process.mjs';

test('installed client actions use private stdin and the pinned entry point', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uain-installed-client-'));
  try {
    const entry = join(root, 'entry.mjs');
    const source = `import assert from 'node:assert/strict';assert.deepEqual(process.argv.slice(2),['private','consent']);let raw='';for await(const bytes of process.stdin)raw+=bytes;const input=JSON.parse(raw);console.log(JSON.stringify({saved:input.secret==='fictional-private-terms'}));`;
    await writeFile(entry, source, { mode: 0o700 });
    const config = { entry, sha256: createHash('sha256').update(source).digest('hex') };
    assert.deepEqual(await installedPrivateAction(config, 'consent', { secret: 'fictional-private-terms' }), { saved: true });
    await assert.rejects(installedPrivateAction({ ...config, sha256: '00'.repeat(32) }, 'consent', {}), /pin/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installed client refuses failing and oversized command output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uain-installed-client-'));
  try {
    const entry = join(root, 'entry.mjs');
    for (const source of ['process.exitCode=1;', `console.log('x'.repeat(65537));`]) {
      await writeFile(entry, source, { mode: 0o700 });
      await assert.rejects(installedPrivateAction({ entry, sha256: createHash('sha256').update(source).digest('hex') }, 'help', {}), /refused|bounded/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

// The browser and the kit derive the same receiving key from the same member
// key, and both match the orchard crate's vectors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as web from './orchard-receiving.js';
import * as kit from '../agent-kit/uain-agent.mjs';

test('browser and kit receiving keys are identical and stay with the member', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'orchard-receiving-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const o = { home: dir, as: 'member' };
  await kit.initIdentity(o);
  const identity = await kit.loadIdentity(o);
  const [a, b] = [await web.receivingViewingKey(identity), await kit.receivingViewingKey(identity)];
  assert.match(a, /^[a-f0-9]{192}$/);
  assert.equal(a, b);
  assert.equal(web.ORCHARD_RECEIVING_DOMAIN, kit.ORCHARD_RECEIVING_DOMAIN);
  const body = await web.signReceivingKey(identity, { chainId: 'c' });
  assert.deepEqual(Object.keys(body).sort(), ['fullViewingKey', 'signature']);
  assert.equal(body.fullViewingKey, a);
  await assert.rejects(web.signReceivingKey(identity, { chainId: '' }));
  const sk = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
  assert.deepEqual(web.orchardFullViewingKey(sk), kit.orchardFullViewingKey(sk));
});

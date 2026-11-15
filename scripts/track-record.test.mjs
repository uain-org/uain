import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readTrackRecord } from '../lib/network/track-record.ts';
test('retired 409 native_route_required produces unavailable evidence after one read', async () => {
  let calls = 0;
  const result = await readTrackRecord('/retired', async () => {
    calls++;
    return new Response('{"error":"native_route_required"}', { status: 409 });
  });
  assert.deepEqual(result, { state: 'unavailable' });
  assert.equal(calls, 1);
});
test('network errors, unavailable responses and malformed records cannot imply a verified record', async () => {
  for (const fetcher of [async () => { throw Error('offline'); }, async () => new Response('', { status: 503 }), async () => new Response('{}')])
    assert.deepEqual(await readTrackRecord('/record', fetcher), { state: 'unavailable' });
});
test('available records preserve their actual result fields', async () => {
  const record = { summary: { contributions: { held: 3 } }, karma_history: { events: [] }, test_results: { attempts: 0 } };
  assert.deepEqual(await readTrackRecord('/record', async () => Response.json(record)), { state: 'ready', record });
});

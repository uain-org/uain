/**
 * Rate limits are counted in PostgreSQL so every copy of the server shares one
 * window. Requests landing together, on separate connections, must still let
 * through exactly the limit: never one more because two saw the same count.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { boot } from './helpers.mjs';

let t;
let hit;
before(async () => {
  t = await boot({ UAIN_RATE_ENROLMENTS_PER_HOUR: '5' });
  ({ hit } = await import('../dist/src/storage/ratelimit.js'));
});
after(async () => {
  await t.close();
});

describe('shared rate limits', () => {
  test('twenty hits at once let exactly the limit through', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => hit('enrolments', 'same-caller')),
    );
    assert.equal(results.filter((r) => r.allowed).length, 5);
    const refused = results.find((r) => !r.allowed);
    assert.equal(refused.limit, 5);
    assert.ok(refused.retryAfter > 3500 && refused.retryAfter <= 3600);
  });

  test('another caller has a window of its own', async () => {
    assert.equal((await hit('enrolments', 'other-caller')).allowed, true);
  });
});

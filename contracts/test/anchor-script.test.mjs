import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anchorArgs, dayNumber, toBytes32 } from '../scripts/anchor-root.mjs';

const hex = 'ab'.repeat(32);

test('dates convert to days since the epoch', () => {
  assert.equal(dayNumber('1970-01-02'), 1);
  assert.equal(dayNumber('2026-09-24'), 20_720);
});

test('unprefixed ledger digests become bytes32', () => {
  assert.equal(toBytes32(hex, 'root'), `0x${hex}`);
  assert.equal(toBytes32(`0x${hex.toUpperCase()}`, 'root'), `0x${hex}`);
  assert.throws(() => toBytes32('abc', 'root'), /32-byte/);
});

test('a root document maps onto anchor() arguments', () => {
  const args = anchorArgs(
    { date: '2026-09-24', root: hex, head: 'cd'.repeat(32), count: 12, first_id: 190, last_id: 201 },
    '2026-09-24',
  );
  assert.deepEqual(args, [20_720, `0x${hex}`, `0x${'cd'.repeat(32)}`, 12n, 201n]);
});

test('refuses a mismatched date or an empty day', () => {
  assert.throws(() => anchorArgs({ date: '2026-09-23', root: hex, head: hex, count: 1, last_id: 1 }, '2026-09-24'), /asked for/);
  assert.throws(() => anchorArgs({ date: '2026-09-24', root: hex, head: hex, count: 0, last_id: 0 }, '2026-09-24'), /nothing to anchor/);
});

test('refuses normalized invalid calendar dates and non-uint64 ledger counters', () => {
  assert.throws(() => dayNumber('2026-02-30'), /bad date/);
  for (const count of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '18446744073709551616']) {
    assert.throws(() => anchorArgs({ date: '2026-09-24', root: hex, head: hex, count, first_id: 1, last_id: 1 }, '2026-09-24'), /count/);
  }
});

test('refuses provisional roots and impossible event ranges', () => {
  assert.throws(() => anchorArgs({ date: '2026-09-24', provisional: true, root: hex, head: hex, count: 1, first_id: 1, last_id: 1 }, '2026-09-24'), /provisional/);
  assert.throws(() => anchorArgs({ date: '2026-09-24', root: hex, head: hex, count: 2, first_id: 9, last_id: 3 }, '2026-09-24'), /range/);
});

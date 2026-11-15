import test from 'node:test';
import assert from 'node:assert/strict';
import { circulationView } from './supply-view.js';

const proof = (headerTime) => ({
  authority: 'native',
  height: '1283307',
  headerTime,
  maxAgeSeconds: 120,
});
const now = Date.parse('2026-11-06T20:44:30Z');
const native = (supply, p = proof('2026-11-06T20:44:20.800654105Z')) => ({
  verified: true,
  supply,
  proof: p,
});

test('in circulation is minted plus funds assigned to open tasks, with the breakdown', () => {
  const v = circulationView(
    native({ minted: '1100000', reserved: '1000000000', transparent: '1100000', shielded: '0' }),
    { now },
  );
  assert.equal(v.inCirculationUnits, '1001100000');
  assert.equal(v.label, 'In circulation');
  assert.equal(v.headline, '1,001.1 AI$');
  assert.equal(v.breakdown, '1.1 AI$ paid out · 1,000 AI$ assigned to open tasks');
  assert.equal(v.source, 'Verified on the network at block 1,283,307');
  assert.equal(v.fresh, true);
});

test('the live 6 November record reads 1,001.1 AI$ (251.1 paid out, 750 assigned)', () => {
  const v = circulationView(
    native({ minted: '251100000', reserved: '750000000', transparent: '251099999', shielded: '1' }),
    { now },
  );
  assert.equal(v.headline, '1,001.1 AI$');
  assert.equal(v.breakdown, '251.1 AI$ paid out · 750 AI$ assigned to open tasks');
});

test('a lapsed proof keeps the figure but says it is the last verified one', () => {
  const v = circulationView(native({ minted: '0', reserved: '0' }), {
    now: now + 10 * 60 * 1000,
  });
  assert.equal(v.headline, '0 AI$');
  assert.equal(v.fresh, false);
  assert.equal(v.source, 'Last verified at block 1,283,307');
});

test('no figure without a verified, well-formed supply record within the cap', () => {
  assert.equal(circulationView(null), null);
  assert.equal(circulationView({ verified: false, supply: { minted: '1', reserved: '0' } }), null);
  assert.equal(circulationView(native({ minted: 1100000, reserved: '0' })), null);
  assert.equal(circulationView(native({ minted: '1.1', reserved: '0' })), null);
  assert.equal(circulationView(native({ minted: '01', reserved: '0' })), null);
  assert.equal(
    circulationView(native({ minted: '108000000000000000000', reserved: '1' })),
    null,
  );
});

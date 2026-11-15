import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { account, newChain, revertsWith } from './evm.mjs';

const OWNER = account(1);
const ANCHORER = account(2);
const STRANGER = account(3);
const NEXT = account(4);

const h = (n) => `0x${n.toString(16).padStart(64, '0')}`;
const DAY = 20_355; // 2025-09-24 in days since epoch; any increasing sequence works

let anchor;
beforeEach(async () => {
  const chain = await newChain();
  anchor = await chain.deploy('LedgerAnchor', OWNER, [ANCHORER]);
});

describe('LedgerAnchor', () => {
  test('refuses future days that would permanently block ordinary anchors', async () => {
    assert.equal(await revertsWith(anchor.send('anchor', [4_000_000_000, h(1), h(2), 1n, 1n], ANCHORER)), 'DayNotCompleted');
    assert.equal(await anchor.read('lastDay'), 0);
  });

  test('refuses empty heads, zero counts and impossible or non-increasing event IDs', async () => {
    assert.equal(await revertsWith(anchor.send('anchor', [DAY, h(1), h(0), 1n, 1n], ANCHORER)), 'EmptyHead');
    assert.equal(await revertsWith(anchor.send('anchor', [DAY, h(1), h(2), 0n, 1n], ANCHORER)), 'InvalidEventRange');
    assert.equal(await revertsWith(anchor.send('anchor', [DAY, h(1), h(2), 3n, 2n], ANCHORER)), 'InvalidEventRange');
    await anchor.send('anchor', [DAY, h(1), h(2), 2n, 2n], ANCHORER);
    assert.equal(await revertsWith(anchor.send('anchor', [DAY + 1, h(3), h(4), 1n, 2n], ANCHORER)), 'InvalidEventRange');
  });
  test('anchors a day once, and exposes it', async () => {
    const { logs } = await anchor.send('anchor', [DAY, h(0xaa), h(0xbb), 17n, 204n], ANCHORER);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].eventName, 'Anchored');
    assert.equal(logs[0].args.day, DAY);
    assert.equal(logs[0].args.root, h(0xaa));
    assert.equal(logs[0].args.count, 17n);
    assert.equal(logs[0].args.lastEventId, 204n);

    assert.equal(await anchor.read('rootOf', [DAY]), h(0xaa));
    assert.equal(await anchor.read('lastDay'), DAY);
    const full = await anchor.read('anchorOf', [DAY]);
    assert.equal(full.head, h(0xbb));
    assert.ok(full.anchoredAt > 0n);
  });

  test('a day never anchored reads as zero', async () => {
    assert.equal(await anchor.read('rootOf', [DAY]), h(0));
  });

  test('refuses to overwrite an anchored day', async () => {
    await anchor.send('anchor', [DAY, h(0xaa), h(0xbb), 1n, 1n], ANCHORER);
    assert.equal(
      await revertsWith(anchor.send('anchor', [DAY, h(0xcc), h(0xdd), 1n, 1n], ANCHORER)),
      'AlreadyAnchored',
    );
    assert.equal(await anchor.read('rootOf', [DAY]), h(0xaa));
  });

  test('refuses a day at or before the last one, so skipped days stay empty', async () => {
    await anchor.send('anchor', [DAY + 5, h(1), h(2), 1n, 10n], ANCHORER);
    assert.equal(
      await revertsWith(anchor.send('anchor', [DAY + 2, h(3), h(4), 1n, 5n], ANCHORER)),
      'DayNotAfterLast',
    );
    await anchor.send('anchor', [DAY + 6, h(5), h(6), 1n, 11n], ANCHORER);
    assert.equal(await anchor.read('lastDay'), DAY + 6);
  });

  test('refuses an empty root', async () => {
    assert.equal(await revertsWith(anchor.send('anchor', [DAY, h(0), h(1), 0n, 0n], ANCHORER)), 'EmptyRoot');
  });

  test('only the anchorer may anchor', async () => {
    for (const who of [OWNER, STRANGER])
      assert.equal(
        await revertsWith(anchor.send('anchor', [DAY, h(1), h(2), 1n, 1n], who)),
        'NotAnchorer',
      );
  });

  test('the owner rotates the anchorer, with an event, and nobody else can', async () => {
    assert.equal(await revertsWith(anchor.send('rotateAnchorer', [NEXT], STRANGER)), 'NotOwner');
    assert.equal(await revertsWith(anchor.send('rotateAnchorer', [NEXT], ANCHORER)), 'NotOwner');

    await anchor.send('anchor', [DAY, h(1), h(2), 1n, 1n], ANCHORER);
    const { logs } = await anchor.send('rotateAnchorer', [NEXT], OWNER);
    assert.equal(logs[0].eventName, 'AnchorerRotated');
    assert.equal(logs[0].args.previous.toLowerCase(), ANCHORER);
    assert.equal(logs[0].args.next.toLowerCase(), NEXT);

    assert.equal(await revertsWith(anchor.send('anchor', [DAY + 1, h(3), h(4), 1n, 2n], ANCHORER)), 'NotAnchorer');
    await anchor.send('anchor', [DAY + 1, h(3), h(4), 1n, 2n], NEXT);
    // Rotation grants no power over what was already anchored.
    assert.equal(await revertsWith(anchor.send('anchor', [DAY, h(9), h(9), 1n, 1n], NEXT)), 'AlreadyAnchored');
  });

  test('refuses the zero address as anchorer', async () => {
    assert.equal(
      await revertsWith(anchor.send('rotateAnchorer', ['0x0000000000000000000000000000000000000000'], OWNER)),
      'ZeroAddress',
    );
  });
});

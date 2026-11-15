/**
 * The draft token is tested so its constraints are enforced from the start,
 * not because it is going anywhere: it must not be deployed before legal
 * opinions (docs/karma-decisions.md 1.2).
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { compileDraft } from '../scripts/compile.mjs';
import { account, newChain, registerArtefacts, revertsWith } from './evm.mjs';

// The draft is not in the default build, so it is compiled here, in memory,
// and never written to disk.
registerArtefacts(compileDraft());

const ADMIN = account(1);
const BRIDGE = account(2);
const HOLDER = account(3);
const STRANGER = account(4);
const ref = (n) => `0x${n.toString(16).padStart(64, '0')}`;

let token;
beforeEach(async () => {
  const chain = await newChain();
  token = await chain.deploy('UAINCredits', ADMIN, [ADMIN, BRIDGE]);
});

describe('UAINCredits (draft)', () => {
  test('there is no pre-mint', async () => {
    assert.equal(await token.read('totalSupply'), 0n);
    assert.equal(await token.read('balanceOf', [ADMIN]), 0n);
  });

  test('only the bridge can mint, and only against a ledger reference', async () => {
    for (const who of [ADMIN, HOLDER, STRANGER])
      assert.equal(
        await revertsWith(token.send('bridgeIn', [HOLDER, 100n, ref(1)], who)),
        'AccessControlUnauthorizedAccount',
      );

    const { logs } = await token.send('bridgeIn', [HOLDER, 100n, ref(1)], BRIDGE);
    const bridged = logs.find((l) => l.eventName === 'BridgedIn');
    assert.equal(bridged.args.ledgerRef, ref(1));
    assert.equal(await token.read('balanceOf', [HOLDER]), 100n);

    assert.equal(await revertsWith(token.send('bridgeIn', [HOLDER, 1n, ref(0)], BRIDGE)), 'EmptyLedgerRef');
    assert.equal(await revertsWith(token.send('bridgeIn', [HOLDER, 0n, ref(2)], BRIDGE)), 'ZeroAmount');
  });

  test('one off-chain burn cannot be minted twice', async () => {
    await token.send('bridgeIn', [HOLDER, 5n, ref(7)], BRIDGE);
    assert.equal(
      await revertsWith(token.send('bridgeIn', [HOLDER, 5n, ref(7)], BRIDGE)),
      'LedgerRefAlreadyMinted',
    );
    assert.equal(await token.read('totalSupply'), 5n);
  });

  test('holders burn back to a named participant', async () => {
    await token.send('bridgeIn', [HOLDER, 50n, ref(3)], BRIDGE);
    const { logs } = await token.send('burnToLedger', [20n, 'claude-code'], HOLDER);
    const out = logs.find((l) => l.eventName === 'BridgedOut');
    assert.equal(out.args.uainParticipantId, 'claude-code');
    assert.equal(out.args.amount, 20n);
    assert.equal(await token.read('totalSupply'), 30n);
    assert.equal(await revertsWith(token.send('burnToLedger', [1n, ''], HOLDER)), 'EmptyParticipant');
    assert.equal(await revertsWith(token.send('burnToLedger', [1000n, 'x'], HOLDER)), 'ERC20InsufficientBalance');
  });

  test('the admin can revoke the bridge, and then it cannot mint', async () => {
    const role = await token.read('BRIDGE_ROLE');
    await token.send('revokeRole', [role, BRIDGE], ADMIN);
    assert.equal(
      await revertsWith(token.send('bridgeIn', [HOLDER, 1n, ref(9)], BRIDGE)),
      'AccessControlUnauthorizedAccount',
    );
  });
});

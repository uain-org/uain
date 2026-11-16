import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessWalletSync } from './verify-wallet-sync.mjs';
const now = Date.parse('2026-10-12T00:00:00Z');
const status = (height, time = '2026-10-11T23:59:59Z') => ({ node_info: { network: 'fictional-chain', id: 'holder' }, validator_info: { voting_power: '0' }, sync_info: { catching_up: false, latest_block_height: String(height), latest_block_time: time, earliest_block_height: '1' } });
test('wallet readiness refuses false catching-up flag with old history', () => {
  assert.throws(() => assessWalletSync(status(9471, '2026-10-09T00:00:00Z'), status(168977), now), /fresh|behind/);
  assert.throws(() => assessWalletSync(status(9471), status(168977), now), /behind/);
  assert.equal(assessWalletSync(status(168976), status(168977), now).checkpoint, '168974');
});
test('wallet readiness requires full history and a nonvalidator on the reference chain', () => {
  for (const change of [{ validator_info: { voting_power: '10' } }, { node_info: { network: 'wrong-chain' } }, { sync_info: { ...status(20).sync_info, earliest_block_height: '10' } }, { sync_info: { ...status(20).sync_info, catching_up: true } }]) assert.throws(() => assessWalletSync({ ...status(20), ...change }, status(20), now));
});

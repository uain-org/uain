import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSpendable } from './note-scan.mjs';

const wallet = (...amounts) => ({ balanceUnits: amounts.reduce((s, a) => s + BigInt(a), 0n).toString(), spendableMaxUnits: amounts.reduce((m, a) => BigInt(a) > m ? BigInt(a) : m, 0n).toString(), unspentNoteCount: amounts.length });

test('a payment above the largest single note is refused even when the summed balance covers it', () => {
  const balance = wallet('600', '500');
  assert.throws(() => checkSpendable(balance, '700'), /largest single note is 600; this payment needs one note of at least 700/);
  assert.deepEqual(checkSpendable(balance, '600'), { spendable: true, amountUnits: '600', spendableMaxUnits: '600', balanceUnits: '1100' });
});

test('balance shortfall, zero and malformed amounts are refused with clear messages', () => {
  const balance = wallet('600');
  assert.throws(() => checkSpendable(balance, '601'), /balance is 600; this payment needs 601/);
  assert.throws(() => checkSpendable(balance, '0'), /positive/);
  assert.throws(() => checkSpendable(balance, '-1'), /canonical unit amount/);
  assert.throws(() => checkSpendable(balance, '01'), /canonical unit amount/);
  assert.throws(() => checkSpendable(wallet(), '1'), /balance is 0/);
});

test('an older balance without spendableMaxUnits is derived from its unspent notes only', () => {
  const balance = { balanceUnits: '900', notes: [{ amountUnits: '400', spent: false }, { amountUnits: '500', spent: false }, { amountUnits: '9000', spent: true }] };
  assert.throws(() => checkSpendable(balance, '800'), /largest single note is 500/);
  assert.equal(checkSpendable(balance, '500').spendableMaxUnits, '500');
});

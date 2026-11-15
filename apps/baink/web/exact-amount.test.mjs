import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decimalToUnits,
  unitsToDecimal,
  formatAmount,
  formatUnits,
  displayUnits,
  displayAmount,
  addUnits,
} from './exact-amount.js';

test('one micro AI Dollar roundtrips without rounding to zero', () => {
  assert.equal(decimalToUnits('0.000001'), '1');
  assert.equal(unitsToDecimal('1'), '0.000001');
  assert.equal(formatAmount('0.000001'), '0.000001');
});
test('the 108 trillion supply cap roundtrips as exact integer micro units', () => {
  const cap = '108000000000000000000';
  assert.equal(unitsToDecimal(cap), '108000000000000.000000');
  assert.equal(decimalToUnits('108000000000000'), cap);
  assert.equal(formatAmount('108000000000000'), '108,000,000,000,000');
  assert.equal(
    decimalToUnits(formatAmount(unitsToDecimal(cap)).replaceAll(',', '')),
    cap,
  );
});
test('the last micro below the supply cap is preserved in display and parsing', () => {
  const units = '107999999999999999999';
  assert.equal(decimalToUnits('107999999999999.999999'), units);
  assert.equal(unitsToDecimal(units), '107999999999999.999999');
  assert.equal(
    formatAmount('107999999999999.999999'),
    '107,999,999,999,999.999999',
  );
  assert.equal(
    formatAmount('12345678901234.000001'),
    '12,345,678,901,234.000001',
  );
});
test('financial formatting rejects floating numbers, exponent syntax, and excess precision', () => {
  for (const invalid of [
    0.1,
    108000000000000,
    '1e6',
    '0.0000001',
    'NaN',
    'Infinity',
    '-1',
    ' 1',
  ])
    assert.throws(() => decimalToUnits(invalid));
  for (const invalid of [1, '1.0', '-1', '1e6'])
    assert.throws(() => unitsToDecimal(invalid));
  assert.equal(formatAmount('0.000000'), '0');
  assert.equal(formatAmount(null), '—');
});
test('micro-AI$ quantities display with no trailing zeros and a grouped whole part', () => {
  assert.equal(formatUnits('0'), '0');
  assert.equal(formatUnits('1'), '0.000001');
  assert.equal(formatUnits('1100000'), '1.1');
  assert.equal(formatUnits('100000'), '0.1');
  assert.equal(formatUnits('250000000'), '250');
  assert.equal(formatUnits('1000000000'), '1,000');
  assert.equal(formatUnits('1234567890123456'), '1,234,567,890.123456');
  assert.equal(formatUnits('108000000000000000000'), '108,000,000,000,000');
  assert.equal(formatUnits('107999999999999999990'), '107,999,999,999,999.99999');
  for (const invalid of [1100000, 1.1, '1.1', '-1', '1e6', '', null])
    assert.throws(() => formatUnits(invalid));
  assert.equal(displayUnits('1100000'), '1.1');
  assert.equal(displayUnits(undefined), '—');
  assert.equal(displayUnits(1100000), '—');
});
test('exact decimal strings from the service display without trailing zeros', () => {
  assert.equal(displayAmount('1.100000'), '1.1');
  assert.equal(displayAmount('250.000000'), '250');
  assert.equal(displayAmount('1200'), '1,200');
  assert.equal(displayAmount(null), '—');
  assert.equal(displayAmount('not-a-price'), 'not-a-price');
});
test('micro-AI$ quantities add exactly with BigInt', () => {
  assert.equal(addUnits('1100000', '1000000000'), '1001100000');
  assert.equal(addUnits('107999999999999999999', '1'), '108000000000000000000');
  assert.throws(() => addUnits('1', 2));
});

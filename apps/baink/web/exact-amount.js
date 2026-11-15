const MICRO_SCALE = 1000000n;
/** Decimal strings are the money boundary; JavaScript numbers are never accepted. */
export function decimalToUnits(value) {
  if (
    typeof value !== 'string' ||
    value.length > 100 ||
    !/^(0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)
  )
    throw new TypeError(
      'Use an unsigned decimal string with at most six decimal places.',
    );
  const [whole, fraction = ''] = value.split('.');
  return (
    BigInt(whole) * MICRO_SCALE +
    BigInt(fraction.padEnd(6, '0'))
  ).toString();
}
export function unitsToDecimal(value) {
  if (typeof value !== 'string' || value.length > 110 || !/^\d+$/.test(value))
    throw new TypeError('Micro units must be an unsigned integer string.');
  const units = BigInt(value);
  return `${units / MICRO_SCALE}.${(units % MICRO_SCALE).toString().padStart(6, '0')}`;
}
export function formatAmount(value) {
  if (value == null) return '—';
  const [whole, fraction] = unitsToDecimal(decimalToUnits(value)).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const significant = fraction.replace(/0+$/, '');
  return significant ? `${grouped}.${significant}` : grouped;
}
/** Display text for an exact integer micro-AI$ quantity: no floating point, no
 * trailing fractional zeros, thousands grouping on the whole part.
 * '1100000' -> '1.1', '250000000' -> '250', '1' -> '0.000001'. */
export function formatUnits(value) {
  return formatAmount(unitsToDecimal(value));
}
/** formatUnits for rendering: an invalid quantity shows '—', never a guess. */
export function displayUnits(value) {
  try {
    return formatUnits(value);
  } catch {
    return '—';
  }
}
/** formatAmount for rendering an exact decimal string the service returned
 * (for example a signed trade price '1.100000'): the same quantity without
 * trailing zeros; an unparseable value is shown exactly as given. */
export function displayAmount(value) {
  if (value == null) return '—';
  try {
    return formatAmount(value);
  } catch {
    return String(value);
  }
}
/** Sum exact integer micro-AI$ strings with BigInt. */
export function addUnits(...values) {
  return values
    .reduce((sum, value) => (unitsToDecimal(value), sum + BigInt(value)), 0n)
    .toString();
}

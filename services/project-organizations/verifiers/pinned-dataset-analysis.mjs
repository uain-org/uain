/**
 * Fixed pinned-public-dataset analysis driver (driver "pinned-dataset-analysis").
 *
 * Reruns a separately reviewed analysis on bytes whose sha256 the root-owned
 * task policy pins. The POLICY declares the analysis (input, column, operation
 * and optional exact expected value); the untrusted artifact only reports the
 * values it claims. A result passes when the independent rerun equals the
 * claim and, where the policy pins one, the expected value.
 *
 * Arithmetic is exact (BigInt decimals); no floating point. Means are rounded
 * half away from zero to `decimals` places (default 6). Values are compared in
 * normalised decimal form, so "3.50" and "3.5" are the same claim.
 *
 * Self-contained on purpose: no imports, so the runner executes exactly the
 * bytes whose hash the policy pins.
 *
 * verify({ successTests, results, inputs }) -> { status, findings, outputs }
 */

const OPS = new Set(['count', 'sum', 'mean', 'min', 'max']);
const DECIMAL = /^([+-]?)([0-9]+)(?:\.([0-9]+))?$/;

class AnalysisError extends Error {}
const refuse = (reason) => {
  throw new AnalysisError(reason);
};

/** Strict RFC 4180 CSV: comma separated, "" escapes, LF or CRLF records, header row. */
export function parseCsv(bytes) {
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    refuse('input_not_utf8');
  }
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
          const next = source[i + 1];
          if (next !== undefined && next !== ',' && next !== '\n' && next !== '\r') refuse('malformed_csv');
        }
      } else field += c;
    } else if (c === '"') {
      if (fieldStarted) refuse('malformed_csv');
      quoted = true;
      fieldStarted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
      fieldStarted = false;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r') {
        if (source[i + 1] !== '\n') refuse('malformed_csv');
        i += 1;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      fieldStarted = false;
    } else {
      field += c;
      fieldStarted = true;
    }
  }
  if (quoted) refuse('malformed_csv');
  if (fieldStarted || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length < 1) refuse('empty_csv');
  const [header, ...data] = rows;
  if (new Set(header).size !== header.length) refuse('duplicate_column');
  for (const r of data) if (r.length !== header.length) refuse('ragged_row');
  return { header, data };
}

/** Exact decimal as { n: BigInt, scale } meaning n / 10^scale. */
function parseDecimal(text) {
  const m = typeof text === 'string' && text.length <= 128 ? DECIMAL.exec(text) : null;
  if (!m) return null;
  const fraction = m[3] ?? '';
  const n = BigInt(m[2] + fraction);
  return { n: m[1] === '-' ? -n : n, scale: fraction.length };
}

const rescale = (d, scale) => d.n * 10n ** BigInt(scale - d.scale);

function formatDecimal({ n, scale }) {
  const negative = n < 0n;
  const digits = (negative ? -n : n).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, '');
  const body = fraction ? `${whole}.${fraction}` : whole;
  return negative && body !== '0' ? '-' + body : body;
}

export const normalizeDecimal = (text) => {
  const d = parseDecimal(text);
  return d === null ? null : formatDecimal(d);
};

const compare = (a, b) => {
  const scale = Math.max(a.scale, b.scale);
  const x = rescale(a, scale);
  const y = rescale(b, scale);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** Rounds numerator/denominator half away from zero to `decimals` places. */
function divide(numerator, denominator, decimals) {
  const scaled = numerator * 10n ** BigInt(decimals);
  const negative = scaled < 0n !== denominator < 0n;
  const a = scaled < 0n ? -scaled : scaled;
  const b = denominator < 0n ? -denominator : denominator;
  let q = a / b;
  if ((a % b) * 2n >= b) q += 1n;
  return { n: negative ? -q : q, scale: decimals };
}

export function analyse(table, { op, column, decimals = 6 }) {
  if (!OPS.has(op)) refuse('unsupported_operation');
  const index = table.header.indexOf(column);
  if (index < 0) refuse('column_missing');
  const cells = table.data.map((r) => r[index]).filter((cell) => cell !== '');
  if (op === 'count') return String(cells.length);
  const values = cells.map((cell) => parseDecimal(cell) ?? refuse('non_numeric_cell'));
  if (op === 'sum' || op === 'mean') {
    const scale = values.reduce((s, v) => Math.max(s, v.scale), 0);
    const total = values.reduce((s, v) => s + rescale(v, scale), 0n);
    if (op === 'sum') return formatDecimal({ n: total, scale });
    if (!values.length) refuse('no_values');
    if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18) refuse('invalid_decimals');
    return formatDecimal(divide(total, BigInt(values.length) * 10n ** BigInt(scale), decimals));
  }
  if (!values.length) refuse('no_values');
  const pick = values.reduce((best, v) => (compare(v, best) === (op === 'min' ? -1 : 1) ? v : best));
  return formatDecimal(pick);
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function verify({ successTests, results, inputs }) {
  if (!Array.isArray(successTests) || successTests.length < 1) return { status: 'fail', findings: ['no_success_tests'], outputs: {} };
  const tables = new Map();
  const findings = [];
  const outputs = {};
  let status = 'pass';
  for (const test of successTests) {
    const id = test?.id;
    let reason = null;
    try {
      if (!Number.isSafeInteger(test.input) || !inputs?.[test.input]) refuse('input_missing');
      if (!tables.has(test.input)) tables.set(test.input, parseCsv(inputs[test.input]));
      const computed = analyse(tables.get(test.input), test);
      outputs[id] = computed;
      const claim = isPlain(results) && Object.hasOwn(results, id) ? normalizeDecimal(results[id]) : null;
      if (claim === null) reason = 'claim_missing_or_not_decimal';
      else if (claim !== computed) reason = 'claim_differs_from_rerun';
      else if (test.expected !== undefined && normalizeDecimal(test.expected) !== computed) reason = 'rerun_differs_from_expected';
    } catch (error) {
      if (!(error instanceof AnalysisError)) throw error;
      reason = error.message;
    }
    findings.push(`${id}:${reason ? 'fail:' + reason : 'pass'}`);
    if (reason) status = 'fail';
  }
  return { status, findings, outputs };
}

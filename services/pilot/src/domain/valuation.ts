/**
 * The benevolence valuation, formula v0. Pure: no I/O, no clock, no store.
 *
 * A challenge's budget has to be something any agent can recompute from
 * published inputs, or it becomes a matter of opinion and lobbying. So the
 * formula is a product of six scored factors, each of which a reviewer can
 * see and dispute on its own:
 *
 *   V = 10^A × S × N × P × D × Q      D = 1 / (1 + r)^years
 *   budget = round(C × V)
 *
 * See docs/karma-and-currency.md §2 and docs/valuation.md. The published copy
 * of these parameters is docs/valuation/formula-v0.json, and a test holds the
 * two equal: changing one without the other is changing the formula quietly.
 */
import { createHash } from 'node:crypto';

export const FORMULA_V0 = Object.freeze({
  name: 'uain-benevolence-valuation',
  version: 'v0',
  expression:
    'V = 10^A × S × N × P × D × Q; D = 1 / (1 + discount_rate)^years; budget = round(C × V)',
  C: 10000,
  discount_rate: 0.05,
  bounds: Object.freeze({
    A: Object.freeze({ min: 0, max: 11 }),
    S: Object.freeze({ min: 0, max: 1 }),
    N: Object.freeze({ min: 0.5, max: 2 }),
    P: Object.freeze({ min: 0, max: 1 }),
    years: Object.freeze({ min: 0, max: 100 }),
    Q: Object.freeze({ min: 0.5, max: 1 }),
  }),
  factors: Object.freeze({
    A: 'Scale: log10 of the people, or people-equivalents, affected. May be given as `people` instead.',
    S: 'Severity: the share of healthy life at stake for each person affected.',
    N: 'Neglectedness: 1 is average; above 1 under-served for its size, below 1 well funded.',
    P: 'Contribution probability: the chance the network’s work materially moves the outcome.',
    years: 'Time to benefit, discounted at discount_rate a year.',
    Q: 'Evidence quality: 1 for audited registries, 0.5 for rough estimates.',
  }),
});

const FACTOR_KEYS = ['A', 'S', 'N', 'P', 'years', 'Q'];

/**
 * Input files annotate every field with a rationale and a source, as
 * `{ value, rationale, source }`. The formula needs only the values.
 */
export function extractInputs(doc) {
  const src = doc && typeof doc === 'object' && doc.inputs ? doc.inputs : doc;
  if (!src || typeof src !== 'object' || Array.isArray(src)) return src;
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    out[k] = v && typeof v === 'object' && 'value' in v ? v.value : v;
  }
  return out;
}

/** Scale may be given as a count of people rather than its logarithm. */
function scaleOf(inputs) {
  if (inputs.A !== undefined) return inputs.A;
  if (inputs.people !== undefined) return Math.log10(inputs.people);
  return undefined;
}

/** A list of problems; empty when the inputs are acceptable. */
export function validateInputs(inputs, formula = FORMULA_V0) {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs))
    return ['inputs must be an object'];
  const problems = [];
  const has = (k) => inputs[k] !== undefined && inputs[k] !== null;

  if (has('A') && has('people'))
    problems.push('give either A or people, not both');
  if (!has('A') && !has('people')) problems.push('A (or people) is required');
  if (has('people')) {
    if (typeof inputs.people !== 'number' || !Number.isFinite(inputs.people))
      problems.push('people must be a finite number');
    else if (inputs.people < 1) problems.push('people must be at least 1');
  }

  for (const k of FACTOR_KEYS) {
    if (k === 'A' && !has('A')) continue;
    if (!has(k)) {
      problems.push(`${k} is required`);
      continue;
    }
    const v = inputs[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      problems.push(`${k} must be a finite number`);
      continue;
    }
    const { min, max } = formula.bounds[k];
    if (v < min || v > max) problems.push(`${k} must be between ${min} and ${max}`);
  }
  if (has('people') && Number.isFinite(inputs.people) && inputs.people >= 1) {
    const { max } = formula.bounds.A;
    if (Math.log10(inputs.people) > max)
      problems.push(`people implies A above ${max}`);
  }
  return problems;
}

function valueOf(f, formula) {
  const D = 1 / Math.pow(1 + formula.discount_rate, f.years);
  const V = Math.pow(10, f.A) * f.S * f.N * f.P * D * f.Q;
  return { V, D };
}

const clamp = (v, { min, max }) => Math.min(Math.max(v, min), max);

/**
 * Compute V and the budget. Throws on invalid inputs; call validateInputs
 * first where the caller is untrusted.
 *
 * Sensitivity moves each factor by ±50% within its bounds and reports the
 * budget, so a reviewer sees which single judgement drives the result. Scale
 * moves the people count by ±50% rather than A itself: A is a logarithm, and
 * halving it would divide the population by a billion, not by two.
 */
export function computeValuation(inputs, formula = FORMULA_V0) {
  const problems = validateInputs(inputs, formula);
  if (problems.length) {
    const e = Object.assign(new Error(`invalid inputs: ${problems.join('; ')}`), { problems });
    throw e;
  }
  const factors = {
    A: scaleOf(inputs),
    S: inputs.S,
    N: inputs.N,
    P: inputs.P,
    years: inputs.years,
    Q: inputs.Q,
  };
  const { V, D } = valueOf(factors, formula);
  const budget = Math.round(formula.C * V);

  const sensitivity = {};
  for (const k of FACTOR_KEYS) {
    const at = (mult) => {
      const f = { ...factors };
      if (k === 'A') f.A = clamp(factors.A + Math.log10(mult), formula.bounds.A);
      else f[k] = clamp(factors[k] * mult, formula.bounds[k]);
      return Math.round(formula.C * valueOf(f, formula).V);
    };
    const low = at(0.5);
    const high = at(1.5);
    sensitivity[k] = { low, high, swing: budget > 0 ? Math.abs(high - low) / budget : 0 };
  }

  return {
    formula_version: formula.version,
    factors: { ...factors, D },
    V,
    budget,
    sensitivity,
  };
}

/** Recursively sorted keys, so the same content always hashes the same. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The digest a valuer records as the artefact of a valuation contribution. It
 * covers the formula version, the inputs and the result, so a verifier who
 * recomputes from the same inputs gets the same digest or finds the
 * difference.
 */
export function canonicalDigest(inputs, result) {
  const body = canonical({
    formula_version: result.formula_version,
    inputs,
    result: { V: result.V, budget: result.budget },
  });
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

/**
 * The two-valuer rule. Within 3× of each other, the allocated figure is the
 * geometric mean; more than 10× apart, the valuation is disputed and goes to
 * operator review; in between, a third valuer breaks the tie.
 */
export function reconcile(a, b) {
  for (const [label, v] of [['a', a], ['b', b]]) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
      throw new Error(`${label} must be a non-negative finite number`);
  }
  if (a === 0 && b === 0) return { status: 'agreed', budget: 0, ratio: 1 };
  if (a === 0 || b === 0) return { status: 'disputed', ratio: Infinity };
  const ratio = Math.max(a, b) / Math.min(a, b);
  if (ratio <= 3)
    return { status: 'agreed', budget: Math.round(Math.sqrt(a * b)), ratio };
  if (ratio > 10) return { status: 'disputed', ratio };
  return { status: 'needs_third_valuer', ratio };
}

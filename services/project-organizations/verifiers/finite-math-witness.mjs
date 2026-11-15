/**
 * Fixed finite mathematical witness verifier (driver "finite-math-witness").
 *
 * Independently maintained and deterministic. The root-owned task policy pins
 * this file's sha256 and supplies each problem INSTANCE; the untrusted artifact
 * supplies only the WITNESS. A submitter therefore cannot pick an easier
 * instance, a different checker or a command to run.
 *
 * Self-contained on purpose: no imports, so the runner executes exactly the
 * bytes whose hash the policy pins.
 *
 * verify({ successTests, witnesses }) -> { status, findings, outputs }
 *   status: 'pass' | 'fail' | 'unverifiable'
 */

const LIMITS = Object.freeze({
  digits: 2048,
  factors: 4096,
  vertices: 100000,
  edges: 500000,
  variables: 100000,
  clauses: 500000,
  literals: 2000000,
});

/**
 * Miller-Rabin with the first 13 prime bases (2..41) is deterministic for every
 * n below this bound (Sorenson and Webster, 2015). Above it we do not guess.
 */
const MR_DETERMINISTIC_BOUND = 3317044064679887385961981n;
const MR_BASES = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n];

function modPow(base, exponent, modulus) {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    e >>= 1n;
    b = (b * b) % modulus;
  }
  return result;
}

/** true / false, or null when n is too large for a deterministic answer. */
export function isPrimeDeterministic(n) {
  if (n < 2n) return false;
  for (const p of MR_BASES) {
    if (n === p) return true;
    if (n % p === 0n) return false;
  }
  if (n >= MR_DETERMINISTIC_BOUND) return null;
  let d = n - 1n;
  let s = 0;
  while ((d & 1n) === 0n) {
    d >>= 1n;
    s += 1;
  }
  for (const a of MR_BASES) {
    let x = modPow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    let composite = true;
    for (let r = 1; r < s; r += 1) {
      x = (x * x) % n;
      if (x === n - 1n) {
        composite = false;
        break;
      }
    }
    if (composite) return false;
  }
  return true;
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCount = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const decimalInteger = (v) =>
  typeof v === 'string' && v.length <= LIMITS.digits && /^[1-9][0-9]*$/.test(v) ? BigInt(v) : null;

const PASS = { status: 'pass' };
const fail = (reason) => ({ status: 'fail', reason });
const unverifiable = (reason) => ({ status: 'unverifiable', reason });

/** instance {n}, witness {factors}: a complete nontrivial prime factorization of n. */
function checkFactorization(instance, witness) {
  const n = decimalInteger(instance?.n);
  if (n === null || n < 4n) return fail('invalid_instance');
  const factors = witness?.factors;
  if (!Array.isArray(factors) || factors.length < 2 || factors.length > LIMITS.factors) return fail('factors_not_nontrivial');
  let product = 1n;
  const parsed = [];
  for (const raw of factors) {
    const f = decimalInteger(raw);
    if (f === null || f < 2n) return fail('invalid_factor');
    parsed.push(f);
    product *= f;
    if (product > n) return fail('product_mismatch');
  }
  if (product !== n) return fail('product_mismatch');
  let undecided = false;
  for (const f of parsed) {
    const prime = isPrimeDeterministic(f);
    if (prime === false) return fail('factor_not_prime');
    if (prime === null) undecided = true;
  }
  return undecided ? unverifiable('factor_beyond_deterministic_primality_bound') : PASS;
}

/** instance {vertices, edges, k}, witness {colors}: a proper k-colouring. */
function checkColoring(instance, witness) {
  const { vertices, edges, k } = instance ?? {};
  if (!isCount(vertices, 1, LIMITS.vertices) || !isCount(k, 1, vertices) || !Array.isArray(edges) || edges.length > LIMITS.edges) {
    return fail('invalid_instance');
  }
  for (const edge of edges) {
    if (!Array.isArray(edge) || edge.length !== 2 || !edge.every((v) => isCount(v, 0, vertices - 1)) || edge[0] === edge[1]) {
      return fail('invalid_instance');
    }
  }
  const colors = witness?.colors;
  if (!Array.isArray(colors) || colors.length !== vertices || !colors.every((c) => isCount(c, 0, k - 1))) return fail('invalid_coloring');
  for (const [a, b] of edges) if (colors[a] === colors[b]) return fail('adjacent_vertices_share_color');
  return PASS;
}

/** instance {variables, clauses} in CNF (DIMACS literals), witness {assignment}: every clause satisfied. */
function checkSat(instance, witness) {
  const { variables, clauses } = instance ?? {};
  if (!isCount(variables, 1, LIMITS.variables) || !Array.isArray(clauses) || clauses.length < 1 || clauses.length > LIMITS.clauses) {
    return fail('invalid_instance');
  }
  let literals = 0;
  for (const clause of clauses) {
    if (!Array.isArray(clause) || clause.length < 1) return fail('invalid_instance');
    literals += clause.length;
    if (literals > LIMITS.literals) return fail('invalid_instance');
    if (!clause.every((l) => Number.isSafeInteger(l) && l !== 0 && Math.abs(l) <= variables)) return fail('invalid_instance');
  }
  const assignment = witness?.assignment;
  if (!Array.isArray(assignment) || assignment.length !== variables || !assignment.every((v) => typeof v === 'boolean')) {
    return fail('invalid_assignment');
  }
  for (const clause of clauses) {
    if (!clause.some((l) => assignment[Math.abs(l) - 1] === l > 0)) return fail('clause_unsatisfied');
  }
  return PASS;
}

const CHECKERS = Object.freeze({
  integer_factorization: checkFactorization,
  graph_coloring: checkColoring,
  sat_assignment: checkSat,
});

export function verify({ successTests, witnesses }) {
  if (!Array.isArray(successTests) || successTests.length < 1) return { status: 'fail', findings: ['no_success_tests'], outputs: {} };
  const findings = [];
  const outputs = {};
  let status = 'pass';
  for (const test of successTests) {
    const checker = isPlain(test) ? CHECKERS[test.witnessType] : undefined;
    const witness = isPlain(witnesses) && Object.hasOwn(witnesses, test?.id) ? witnesses[test.id] : undefined;
    let result;
    if (!checker) result = fail('unsupported_witness_type');
    else if (!isPlain(witness)) result = fail('witness_missing');
    else result = checker(test.instance, witness);
    outputs[test?.id] = result.status;
    findings.push(`${test?.id}:${result.status}${result.reason ? ':' + result.reason : ''}`);
    if (result.status === 'fail') status = 'fail';
    else if (result.status === 'unverifiable' && status === 'pass') status = 'unverifiable';
  }
  return { status, findings, outputs };
}

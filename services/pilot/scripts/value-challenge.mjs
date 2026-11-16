/**
 * Recompute a challenge budget from a published inputs file.
 *
 *   node scripts/value-challenge.mjs ../../docs/valuation/inputs/alzheimers.json
 *   node scripts/value-challenge.mjs <file> --json
 *
 * The digest printed at the end is what a valuer records as the artefact of a
 * valuation contribution; a second valuer who runs this on the same inputs
 * gets the same digest.
 */
import { readFileSync } from 'node:fs';
import {
  canonicalDigest,
  computeValuation,
  extractInputs,
  validateInputs,
} from '../dist/src/domain/valuation.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: node scripts/value-challenge.mjs <inputs.json> [--json]');
  process.exit(1);
}

const doc = JSON.parse(readFileSync(file, 'utf8'));
const inputs = extractInputs(doc);
const problems = validateInputs(inputs);
if (problems.length) {
  console.error(`invalid inputs in ${file}:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
const result = computeValuation(inputs);
const digest = canonicalDigest(inputs, result);

if (asJson) {
  console.log(JSON.stringify({ challenge: doc.challenge ?? null, ...result, digest }, null, 2));
  process.exit(0);
}

const n = (v) => v.toLocaleString('en-US', { maximumFractionDigits: 4 });
const f = result.factors;
console.log(`${doc.challenge ?? file}  (formula ${result.formula_version})\n`);
console.log(`  A      ${n(f.A)}${inputs.people !== undefined ? `   (log10 of ${n(inputs.people)})` : ''}`);
console.log(`  S      ${n(f.S)}`);
console.log(`  N      ${n(f.N)}`);
console.log(`  P      ${n(f.P)}`);
console.log(`  D      ${n(f.D)}   (${f.years} years)`);
console.log(`  Q      ${n(f.Q)}\n`);
console.log(`  V      ${n(Math.round(result.V))}`);
console.log(`  budget ${n(result.budget)}\n`);
console.log('  sensitivity (each factor ×0.5 and ×1.5, within bounds; scale moves the people count)');
for (const [k, s] of Object.entries(result.sensitivity)) {
  console.log(
    `    ${k.padEnd(6)} ${n(s.low).padStart(16)}  ${n(s.high).padStart(16)}   swing ${(s.swing * 100).toFixed(0)}%`,
  );
}
console.log(`\n  digest ${digest}`);

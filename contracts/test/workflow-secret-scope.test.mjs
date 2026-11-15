// The anchorer key and the authenticated RPC URL must reach only the step that
// may send a transaction, never the job environment that `npm ci` and the
// build inherit (audit 13, plan W11, 10 November 2026). An install script of
// any dependency could otherwise read the key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const file = new URL('../../.github/workflows/ledger-anchor.yml', import.meta.url);
const lines = readFileSync(file, 'utf8').split('\n');

/** The job-level `env:` block (4-space indent) and each step (`      - ` items). */
function parse() {
  const jobEnv = [], steps = [];
  let section = null, step = null;
  for (const line of lines) {
    if (/^ {4}env:\s*$/.test(line)) { section = 'jobEnv'; continue; }
    if (/^ {4}steps:\s*$/.test(line)) { section = 'steps'; continue; }
    if (/^ {4}\S/.test(line) || /^ {0,3}\S/.test(line)) { section = null; step = null; continue; }
    if (section === 'jobEnv') jobEnv.push(line);
    if (section === 'steps') {
      if (/^ {6}- /.test(line)) { step = { text: [line] }; steps.push(step); }
      else if (step) step.text.push(line);
    }
  }
  return { jobEnv, steps: steps.map(s => ({ ...s, body: s.text.join('\n') })) };
}

test('the job environment carries no secrets', () => {
  const { jobEnv } = parse();
  assert.ok(jobEnv.length > 0, 'job env block found');
  assert.deepEqual(jobEnv.filter(l => /secrets\./.test(l)), []);
});

test('the anchorer key and RPC reach only the sending step, not npm ci or the build', () => {
  const { steps } = parse();
  const withKey = steps.filter(s => /ANCHORER_PRIVATE_KEY:\s*\$\{\{\s*secrets\.ANCHORER_PRIVATE_KEY/.test(s.body));
  assert.equal(withKey.length, 1);
  assert.match(withKey[0].body, /name: Run a bounded chronological batch/);
  assert.match(withKey[0].body, /operations\.mjs/);
  assert.doesNotMatch(withKey[0].body, /npm (ci|install|run)/);
  const withRpc = steps.filter(s => /BASE_SEPOLIA_RPC:\s*\$\{\{\s*secrets\./.test(s.body));
  assert.deepEqual(withRpc.map(s => s.text[0].trim()), withKey.map(s => s.text[0].trim()));
  for (const s of steps.filter(s => /npm (ci|install)/.test(s.body))) {
    assert.doesNotMatch(s.body, /secrets\./, 'the install step has no secrets');
  }
});

// A dependency's install script runs before the key step and could append to
// $GITHUB_ENV (for example NODE_OPTIONS=--require=...), which later steps,
// the one holding the key included, would load (security review IN-5,
// 13 November 2026). The contracts lockfile has no install scripts to lose.
test('npm installs run no dependency scripts and the checkout keeps no token', () => {
  const { steps } = parse();
  const code = s => s.text.filter(l => !/^\s*#/.test(l)).join('\n');
  const installs = steps.filter(s => /npm (ci|install)\b/.test(code(s)));
  assert.ok(installs.length > 0);
  for (const s of installs) {
    for (const cmd of code(s).match(/npm (ci|install)\b[^&\n]*/g)) assert.match(cmd, /--ignore-scripts\b/, cmd);
  }
  const lock = readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8');
  assert.doesNotMatch(lock, /"hasInstallScript"/);
  const checkouts = steps.filter(s => /uses: actions\/checkout@/.test(s.body));
  assert.equal(checkouts.length, 1);
  assert.match(checkouts[0].body, /persist-credentials: false/);
});

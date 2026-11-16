import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import {
  ARTIFACT_SCHEMA, POLICY_SCHEMA, attestationDigestOf, attestationPayload, createRunner, driverDigest, verifyEvidence,
} from '../src/verification.mjs';
import { FLEET_ATTESTATION_DOMAIN, FLEET_ATTESTATION_SCHEMA, reviewInput, statementBytes } from '../src/review-input.mjs';
import { canonical, digest, sha256 } from '../src/common.mjs';

/** FICTIONAL vector shared with ops/custody/test_fleet_attestation.py. */
const VECTOR = JSON.parse(readFileSync(new URL('./fixtures/fleet-attestation-vector.json', import.meta.url), 'utf8'));
const clone = (v) => structuredClone(v);
const H = (c) => c.repeat(64);

const submissionOf = (task, answer) => ({
  submission: answer.id, task: task.id, reviewer: 'uain1' + 'e'.repeat(40), author: answer.author, state: 'under_review',
  criteria: task.criteria, criteria_digest: task.acceptance_digest, evidence_digest: answer.evidence_digest, proof: { verified: true },
});
const vectorSubmission = () => submissionOf(VECTOR.task, VECTOR.answer);
const vectorKeys = (environment = 'fixture') => [{ publicKey: VECTOR.envelope.publicKey, environment }];

/** A FICTIONAL in-process custody stand-in: signs exactly what fleet_attestation.py would. */
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const RAW_PUBLIC = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
const KEYS = [{ publicKey: RAW_PUBLIC, environment: 'fixture' }];
function envelope(statement, key = privateKey) {
  const bytes = statementBytes(statement);
  return { statement, statementDigest: sha256(bytes), publicKey: RAW_PUBLIC, signature: signBytes(null, bytes, key).toString('base64') };
}
function statementFor({ policy, submission, verdict = 'pass', environment = 'fixture', reproductionAttestationDigest = null }) {
  const payload = attestationPayload({
    policy, assignment: { submissionId: submission.submission, author: submission.author, criteriaDigest: submission.criteria_digest },
    artifactDigest: submission.evidence_digest, verdict, reproductionAttestationDigest,
  });
  return {
    schema: FLEET_ATTESTATION_SCHEMA, domain: FLEET_ATTESTATION_DOMAIN, environment, submission: submission.submission, author: submission.author,
    task: policy.taskId, project: policy.projectId, evidenceClass: policy.class, criteriaDigest: policy.criteriaDigest,
    evidenceDigest: submission.evidence_digest, policyDigest: digest(policy), driver: clone(policy.driver), verdict,
    reproductionAttestationDigest, verificationDigest: attestationDigestOf(payload), mainKpiSatisfied: false, attestedAt: '2026-11-06T12:00:00Z',
  };
}
const refused = (fn, code) => assert.throws(fn, (e) => e.code === code, code);

/* --------------------------------------------------- cross-language vector */

test('canonical JSON and the attestation payload digest match the Python custody vector', () => {
  for (const { value, canonical: expected, sha256: hash } of VECTOR.canonical) {
    assert.equal(canonical(value), expected);
    assert.equal(digest(value), hash);
  }
  const payload = attestationPayload({
    policy: VECTOR.policy,
    assignment: { submissionId: VECTOR.answer.id, author: VECTOR.answer.author, criteriaDigest: VECTOR.policy.criteriaDigest },
    artifactDigest: VECTOR.answer.evidence_digest,
    verdict: 'pass',
  });
  assert.deepEqual(payload, VECTOR.payload);
  assert.equal(attestationDigestOf(payload), VECTOR.verificationDigest);
  assert.equal(digest(VECTOR.policy), VECTOR.policyDigest);
  // Submitted evidence is the canonical artifact, so the native evidence_digest is the artifact digest.
  assert.equal(canonical(JSON.parse(VECTOR.answer.evidence)), VECTOR.answer.evidence);
  assert.equal(sha256(VECTOR.answer.evidence), VECTOR.answer.evidence_digest);
  assert.equal(sha256(VECTOR.task.criteria), VECTOR.policy.criteriaDigest);
});

test('an envelope signed by ops/custody/fleet_attestation.py yields bound central review input', () => {
  const input = reviewInput({ submission: vectorSubmission(), taskPolicy: VECTOR.policy, attestation: VECTOR.envelope, trustedKeys: vectorKeys(),
    environment: 'fixture' });
  assert.equal(input.status, 'attested');
  assert.equal(input.verdict, 'accept');
  assert.equal(input.fixture, true);
  assert.equal(input.environment, 'fixture');
  assert.equal(input.mainKpiSatisfied, false);
  assert.deepEqual(input.centralReview, {
    submission: VECTOR.answer.id, verdict: 'accept', criteria_digest: VECTOR.task.acceptance_digest, evidence_digest: VECTOR.answer.evidence_digest,
    verification_attestation_digest: VECTOR.envelope.statementDigest,
  });
  assert.equal(input.execution.task_verification_digest, VECTOR.verificationDigest);
  assert.equal(input.execution.driver_sha256, VECTOR.policy.driver.sha256);
  assert.equal(input.execution.policy_digest, VECTOR.policyDigest);
  assert.deepEqual(input.trusted_verification, VECTOR.envelope.statement);
  assert.equal(sha256(statementBytes(VECTOR.envelope.statement)), VECTOR.envelope.statementDigest);
});

test('a fixture key, statement or environment never yields production input', () => {
  const args = { submission: vectorSubmission(), taskPolicy: VECTOR.policy, attestation: VECTOR.envelope };
  refused(() => reviewInput({ ...args, trustedKeys: vectorKeys('fixture') }), 'attestation_key_environment_mismatch');
  // Even a key trusted for production cannot promote a statement custody marked fixture.
  refused(() => reviewInput({ ...args, trustedKeys: vectorKeys('production'), environment: 'production' }), 'attestation_environment_mismatch');
  refused(() => reviewInput({ ...args, trustedKeys: vectorKeys(), environment: 'staging' }), 'invalid_environment');
});

/* ----------------------------------------------------------- refusals */

const base = () => {
  const submission = vectorSubmission();
  const policy = clone(VECTOR.policy);
  return { submission, policy, statement: statementFor({ policy, submission }) };
};
const run = ({ submission, policy, attestation, trustedKeys = KEYS }) =>
  reviewInput({ submission, taskPolicy: policy, attestation, trustedKeys, environment: 'fixture' });

test('a statement from this test custody key is accepted and a fail verdict becomes reject', () => {
  const { submission, policy, statement } = base();
  assert.equal(run({ submission, policy, attestation: envelope(statement) }).verdict, 'accept');
  const failed = statementFor({ policy, submission, verdict: 'fail' });
  const input = run({ submission, policy, attestation: envelope(failed) });
  assert.equal(input.verdict, 'reject');
  assert.equal(input.centralReview.verdict, 'reject');
});

test('wrong key, signature and digests are refused', () => {
  const { submission, policy, statement } = base();
  const good = envelope(statement);
  refused(() => run({ submission, policy, attestation: good, trustedKeys: vectorKeys() }), 'untrusted_attestation_key');
  const other = generateKeyPairSync('ed25519').privateKey;
  refused(() => run({ submission, policy, attestation: envelope(statement, other) }), 'attestation_signature_invalid');
  refused(() => run({ submission, policy, attestation: { ...good, signature: Buffer.alloc(64).toString('base64') } }), 'attestation_signature_invalid');
  refused(() => run({ submission, policy, attestation: { ...good, statementDigest: H('0') } }), 'attestation_digest_mismatch');
  // A statement edited after signing no longer matches its digest.
  refused(() => run({ submission, policy, attestation: { ...good, statement: { ...statement, verdict: 'fail' } } }), 'attestation_digest_mismatch');
  refused(() => run({ submission, policy, attestation: { ...good, extra: 1 } }), 'invalid_attestation');
  refused(() => run({ submission, policy, attestation: good, trustedKeys: [] }), 'invalid_trusted_keys');
});

test('wrong submission, author, task, criteria, evidence, driver or verification digest are refused even when signed', () => {
  const { submission, policy, statement } = base();
  const cases = [
    [{ submission: 'sub-other' }, 'attestation_submission_mismatch'],
    [{ author: 'uain1' + 'b'.repeat(40) }, 'attestation_author_mismatch'],
    [{ task: 'T-other' }, 'attestation_task_mismatch'],
    [{ criteriaDigest: H('1') }, 'attestation_criteria_mismatch'],
    [{ evidenceDigest: H('2') }, 'attestation_evidence_mismatch'],
    [{ project: 'P-OPP-00002' }, 'attestation_policy_mismatch'],
    [{ driver: { name: 'finite-math-witness', sha256: H('3') } }, 'attestation_driver_mismatch'],
    [{ verificationDigest: H('4') }, 'attestation_verification_digest_mismatch'],
  ];
  for (const [change, code] of cases) refused(() => run({ submission, policy, attestation: envelope({ ...statement, ...change }) }), code);
  for (const change of [{ mainKpiSatisfied: true }, { driver: { name: 'pinned-dataset-analysis', sha256: H('3') } },
    { reproductionAttestationDigest: H('5') }, { verdict: 'needs_evidence' }, { environment: 'production-ish' }, { attestedAt: 'yesterday' }]) {
    refused(() => run({ submission, policy, attestation: envelope({ ...statement, ...change }) }), 'invalid_attestation');
  }
});

test('a policy changed after attestation is a stale policy digest', () => {
  const { submission, policy, statement } = base();
  const attestation = envelope(statement);
  const changed = clone(policy);
  changed.successTests[0].instance.n = '15';
  refused(() => run({ submission, policy: changed, attestation }), 'stale_policy_digest');
  refused(() => run({ submission, policy: { ...policy, taskId: 'T-other' }, attestation }), 'policy_submission_mismatch');
  refused(() => run({ submission, policy: { ...policy, driver: { name: 'pinned-dataset-analysis', sha256: H('d') } }, attestation }), 'invalid_task_policy');
});

test('the submission must be the proved native assignment', () => {
  const { submission, policy, statement } = base();
  const attestation = envelope(statement);
  for (const change of [{ proof: { verified: false } }, { state: 'accepted' }, { criteria: 'rewritten criteria' }, { evidence_digest: 'x' }]) {
    refused(() => run({ submission: { ...submission, ...change }, policy, attestation }), 'invalid_submission');
  }
});

test('unsupported classes and missing attestations need evidence, never an accept', () => {
  const { submission, policy } = base();
  for (const cls of ['wet_lab', 'clinical_efficacy', 'patient_counts', 'narrative_literature', 'Bad Class!']) {
    const input = run({ submission, policy: { ...policy, class: cls }, attestation: envelope(base().statement) });
    assert.equal(input.verdict, 'needs_evidence');
    assert.equal(input.reason, 'verification_adapter_required');
    assert.match(input.findings[0], /^verification_adapter_required:/);
    assert.equal(input.centralReview, null);
    assert.equal(input.mainKpiSatisfied, false);
  }
  for (const attestation of [undefined, null]) {
    const input = run({ submission, policy, attestation });
    assert.equal(input.verdict, 'needs_evidence');
    assert.equal(input.reason, 'protected_verification_required');
  }
});

test('source-code reproduction statements must carry the protected reproduction digest', () => {
  const submission = vectorSubmission();
  const policy = {
    schema: POLICY_SCHEMA, class: 'source_code_reproduction', taskId: submission.task, projectId: 'P-OPP-00001', criteriaDigest: submission.criteria_digest,
    inputs: [{ url: 'https://github.com/example/repo/archive/abc.tar.gz', sha256: H('a'), bytes: 10 }], primarySourceHosts: ['github.com'],
    driver: { name: 'protected-reproduction-attestation', sha256: H('b') }, successTests: [{ id: 'repro', before: 'failed', after: 'passed' }],
  };
  const statement = statementFor({ policy, submission, reproductionAttestationDigest: H('9') });
  assert.equal(run({ submission, policy, attestation: envelope(statement) }).execution.reproduction_attestation_digest, H('9'));
  refused(() => run({ submission, policy, attestation: envelope({ ...statement, reproductionAttestationDigest: null }) }), 'invalid_attestation');
  refused(() => run({ submission, policy, attestation: envelope({ ...statement, reproductionAttestationDigest: H('8') }) }),
    'attestation_verification_digest_mismatch');
});

/* ------------------------------------------------- end to end, FICTIONAL */

test('verifyEvidence through a custody-style statement to review input binds the same digests', async () => {
  const author = 'uain1' + 'a'.repeat(40);
  const criteria = 'FICTIONAL: factor the pinned n.';
  const policy = {
    schema: POLICY_SCHEMA, class: 'finite_math_witness', taskId: 'T-e2e-1', projectId: 'P-OPP-00001', criteriaDigest: sha256(criteria),
    inputs: [], primarySourceHosts: [], driver: { name: 'finite-math-witness', sha256: driverDigest('finite-math-witness') },
    successTests: [{ id: 'factor', witnessType: 'integer_factorization', instance: { n: (2147483647n * 1000000007n).toString() } }],
  };
  const artifact = { schema: ARTIFACT_SCHEMA, taskId: policy.taskId, submissionId: 'sub-e2e-1', author,
    witnesses: { factor: { factors: ['2147483647', '1000000007'] } } };
  const assignment = { taskId: policy.taskId, projectId: policy.projectId, submissionId: artifact.submissionId, author, criteriaDigest: policy.criteriaDigest };
  const result = await verifyEvidence({ taskPolicy: policy, assignment, artifact }, { runner: createRunner() });
  assert.equal(result.verdict, 'pass', result.findings.join());
  const evidence = canonical(artifact);
  const submission = { submission: artifact.submissionId, task: policy.taskId, reviewer: 'uain1' + 'e'.repeat(40), author, state: 'under_review',
    criteria, criteria_digest: policy.criteriaDigest, evidence_digest: sha256(evidence), proof: { verified: true } };
  assert.equal(result.attestation.artifactDigest, submission.evidence_digest);
  const statement = statementFor({ policy, submission });
  assert.equal(statement.verificationDigest, result.attestationDigest);
  const input = run({ submission, policy, attestation: envelope(statement) });
  assert.equal(input.verdict, 'accept');
  assert.equal(input.execution.task_verification_digest, result.attestationDigest);
});

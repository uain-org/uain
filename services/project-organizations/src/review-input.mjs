/**
 * Central review input from a custody-signed fleet verification attestation
 * (design builder-review resolution 1; consumer of verifyEvidence()).
 *
 * verifyEvidence() (verification.mjs) decides pass/fail with the fixed driver a
 * root-owned task policy pins and builds an unsigned attestationPayload.
 * ops/custody/fleet_attestation.py re-derives that payload from custody's own
 * reads (protected policy file, protected driver bytes, native task and
 * submission records, canonical evidence), requires its own fixed-driver rerun
 * to decide the same verdict, and signs a 'uain-fleet-verification-attestation-v1'
 * statement. reviewInput() is what a central reviewer would do with that
 * statement: check the trusted key and every binding against the authoritative
 * native submission and the current root-owned policy, then return the
 * criteria_digest, evidence_digest, verdict and verification digest a
 * central_review would carry, plus the execution facts for the reviewer's
 * provider input (like trusted_reproduction today).
 *
 * Refusals: an untrusted or wrong-environment key, a bad signature or digest,
 * and any submission/author/task/criteria/evidence/policy/driver mismatch throw
 * (fail closed). A missing attestation, or an evidence class with no qualified
 * adapter (verification_adapter_required), returns needs_evidence. A fixture
 * key, fixture statement or fixture environment never yields production input.
 *
 * ---------------------------------------------------------------------------
 * Follow-up: the pinned central reviewer does not accept this class yet.
 *
 * Status 2026-11-06: steps 1-6 below are implemented as source on the
 * feat/project-organizations branch (central-reviewer worker, custody-client,
 * cli-provider; ops/custody central_reviewer{,_server}.py with
 * fleet_attestation.check_review_bindings). They are NOT deployed: step 7 (pins,
 * production key ceremony, production driver rerun) and the release are open.
 * See docs/baink/central-reviewer-trusted-verification-release.md.
 *
 * services/central-reviewer/src/{worker,custody-client}.mjs and
 * ops/custody/central_reviewer{,_server}.py are source-hash pinned on the host
 * and accept only the source-code reproduction attestation
 * ('uain-trusted-reproduction-v1' via validateTrustedReproduction and the
 * server's acceptance_attestations rules). This module does not edit them.
 * Accepting fleet attestations needs a reviewed release of that pinned reviewer
 * that, at minimum:
 *   1. Server profile: adds an optional root-owned `fleet_attestations` map
 *      (task id -> { policy_path, policy_digest, criteria_digest, attestation
 *      public key, environment: 'production' }) validated like
 *      acceptance_attestations, and a reader for the signed envelope stored by
 *      custody (e.g. under ROOT/fleet-attestations/<sha256(submission)>.json),
 *      read with the same protected-snapshot rules as independent_attestation.
 *   2. /readiness: for a task in that map, returns
 *      { ready, required: true, attestationDigest: statementDigest,
 *        trusted_verification: statement } only after the checks reviewInput
 *      performs here (key, signature, submission, author, task, project,
 *      criteria, evidence, policy digest, driver, mainKpiSatisfied: false,
 *      environment 'production').
 *   3. custody-client.mjs readiness(): accepts `trusted_verification` as an
 *      alternative to `trusted_reproduction` with its own validator (the
 *      statement shape checked by validateStatement below) and the same
 *      attestationDigest binding.
 *   4. worker.mjs run(): treats trusted_verification like trustedFacts
 *      (records job.attestation_digest, used_attestation_digests,
 *      required_attestation_digest for re-review), passes it to the provider as
 *      structured input, and refuses a provider 'accept' that contradicts a
 *      driver 'fail' (and vice versa) as invalid_provider_decision, so another
 *      agent saying yes never replaces the fixed driver.
 *   5. The decision schema: a new version (e.g.
 *      'uain-central-research-decision-v2') adds `verification_attestation_digest`
 *      so verification_digest (the decision digest the server recomputes with
 *      r.decision_digest) commits to the fleet statement. The command payload
 *      shape { submission, verdict, criteria_digest, verification_digest,
 *      execution_id, evidence_digest } is unchanged, so native needs no change.
 *   6. review(): rechecks the stored envelope before signing (as it rechecks
 *      independent_attestation) and records it in the once-only job context.
 *   7. New source pins for every changed file, the fleet_attestation.py module
 *      in the custody source manifest, a production Ed25519 attestation key held
 *      by custody, and a production fixed-driver rerun (node running the exact
 *      hashed driver bytes, as createRunner does) wired into attest().
 * Until that release, reviewInput output is advisory input for qualification
 * and tests only; it is not a production review path.
 */
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { CLASS_DRIVERS, POLICY_SCHEMA, attestationDigestOf, attestationPayload, attestationPayloadV2, nativeArtifactV2, validateTaskPolicy } from './verification.mjs';
import { ADDRESS, HASH, NATIVE_ID, canonical, digest, exactKeys, need, plain, sha256, validateAttestationVersions, validateNativeNetwork } from './common.mjs';

export const FLEET_ATTESTATION_SCHEMA = 'uain-fleet-verification-attestation-v1';
export const FLEET_ATTESTATION_DOMAIN = 'UAIN/fleet-verification-attestation/v1';
export const FLEET_ATTESTATION_SCHEMA_V2 = 'uain-fleet-verification-attestation-v2';
export const FLEET_ATTESTATION_DOMAIN_V2 = 'UAIN/fleet-verification-attestation/v2';
export const REVIEW_INPUT_SCHEMA = 'uain-fleet-review-input-v1';
export const ENVIRONMENTS = Object.freeze(['production', 'fixture']);

const ENVELOPE_FIELDS = ['statement', 'statementDigest', 'publicKey', 'signature'];
const STATEMENT_FIELDS = ['schema', 'domain', 'environment', 'submission', 'author', 'task', 'project', 'evidenceClass', 'criteriaDigest',
  'evidenceDigest', 'policyDigest', 'driver', 'verdict', 'reproductionAttestationDigest', 'verificationDigest', 'mainKpiSatisfied',
  'attestedAt'];
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const ISO_SECONDS = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const VERDICTS = Object.freeze({ pass: 'accept', fail: 'reject' });

/** Strict standard base64 of exactly `length` bytes. */
function base64Bytes(value, length, code) {
  need(typeof value === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(value), code);
  const bytes = Buffer.from(value, 'base64');
  need(bytes.length === length && bytes.toString('base64') === value, code);
  return bytes;
}

/** The exact bytes custody signs: domain line, then canonical statement. */
export const statementBytes = (statement) => Buffer.from(`${statement.schema === FLEET_ATTESTATION_SCHEMA_V2 ? FLEET_ATTESTATION_DOMAIN_V2 : FLEET_ATTESTATION_DOMAIN}\n${canonical(statement)}`, 'utf8');

/** Shape of a signed statement. Throws invalid_attestation. */
export function validateStatement(statement, {allowedVersions = [1]} = {}) {
  validateAttestationVersions(allowedVersions);
  if (statement?.schema === FLEET_ATTESTATION_SCHEMA_V2) {
    need(allowedVersions.includes(2), 'attestation_version_not_allowed');
    need(exactKeys(statement, [...STATEMENT_FIELDS, 'canonicalArtifactDigest','chainId','genesisSha256']) && statement.domain === FLEET_ATTESTATION_DOMAIN_V2 &&
      statement.evidenceClass === 'prior_art_survey' && HASH.test(statement.canonicalArtifactDigest ?? ''), 'invalid_attestation');
    validateNativeNetwork({chainId:statement.chainId,genesisSha256:statement.genesisSha256});
    const mirror = {...statement, schema: FLEET_ATTESTATION_SCHEMA, domain: FLEET_ATTESTATION_DOMAIN}; delete mirror.canonicalArtifactDigest;delete mirror.chainId;delete mirror.genesisSha256;
    validateStatement(mirror); return structuredClone(statement);
  }
  need(allowedVersions.includes(1), 'attestation_version_not_allowed');
  need(exactKeys(statement, STATEMENT_FIELDS), 'invalid_attestation', 'statement shape');
  need(statement.schema === FLEET_ATTESTATION_SCHEMA && statement.domain === FLEET_ATTESTATION_DOMAIN, 'invalid_attestation', 'schema');
  need(ENVIRONMENTS.includes(statement.environment), 'invalid_attestation', 'environment');
  need([statement.submission, statement.task, statement.project].every((v) => typeof v === 'string' && NATIVE_ID.test(v)) &&
    typeof statement.author === 'string' && ADDRESS.test(statement.author), 'invalid_attestation', 'identity');
  need(Object.hasOwn(CLASS_DRIVERS, statement.evidenceClass), 'invalid_attestation', 'class');
  need(['criteriaDigest', 'evidenceDigest', 'policyDigest', 'verificationDigest'].every((k) => typeof statement[k] === 'string' && HASH.test(statement[k])),
    'invalid_attestation', 'digests');
  need(exactKeys(statement.driver, ['name', 'sha256']) && statement.driver.name === CLASS_DRIVERS[statement.evidenceClass] &&
    HASH.test(statement.driver.sha256 ?? ''), 'invalid_attestation', 'driver');
  need(Object.hasOwn(VERDICTS, statement.verdict), 'invalid_attestation', 'verdict');
  const reproduction = statement.reproductionAttestationDigest;
  need(statement.evidenceClass === 'source_code_reproduction'
    ? typeof reproduction === 'string' && HASH.test(reproduction) && statement.verdict === 'pass'
    : reproduction === null, 'invalid_attestation', 'reproduction attestation');
  need(statement.mainKpiSatisfied === false, 'invalid_attestation', 'main KPI');
  need(typeof statement.attestedAt === 'string' && ISO_SECONDS.test(statement.attestedAt) && Number.isFinite(Date.parse(statement.attestedAt)),
    'invalid_attestation', 'attestedAt');
  return structuredClone(statement);
}

function trustedKey(trustedKeys, publicKey, environment) {
  need(Array.isArray(trustedKeys) && trustedKeys.length >= 1 && trustedKeys.length <= 16, 'invalid_trusted_keys');
  for (const entry of trustedKeys) {
    need(exactKeys(entry, ['publicKey', 'environment']) && ENVIRONMENTS.includes(entry.environment), 'invalid_trusted_keys');
    base64Bytes(entry.publicKey, 32, 'invalid_trusted_keys');
  }
  const entry = trustedKeys.find((k) => k.publicKey === publicKey);
  need(entry, 'untrusted_attestation_key');
  need(entry.environment === environment, 'attestation_key_environment_mismatch');
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI, base64Bytes(publicKey, 32, 'invalid_attestation')]), format: 'der', type: 'spki' });
}

/** The native-source read() assignment: proved, under review, criteria bound to its digest. */
function validateSubmission(s) {
  need(plain(s) && s.proof?.verified === true && s.state === 'under_review', 'invalid_submission', 'proved submission under review');
  need([s.submission, s.task].every((v) => typeof v === 'string' && NATIVE_ID.test(v)) && typeof s.author === 'string' && ADDRESS.test(s.author),
    'invalid_submission', 'identity');
  need(HASH.test(s.criteria_digest ?? '') && HASH.test(s.evidence_digest ?? ''), 'invalid_submission', 'digests');
  need(typeof s.criteria === 'string' && sha256(Buffer.from(s.criteria, 'utf8')) === s.criteria_digest, 'invalid_submission', 'criteria digest');
}

const needsEvidence = (environment, reason, findings) => ({
  schema: REVIEW_INPUT_SCHEMA,
  status: 'needs_evidence',
  verdict: 'needs_evidence',
  reason,
  findings,
  environment,
  fixture: environment === 'fixture',
  centralReview: null,
  trusted_verification: null,
  mainKpiSatisfied: false,
});

/**
 * reviewInput({ submission, taskPolicy, attestation, trustedKeys, environment = 'production' })
 *
 * submission: the authoritative native assignment (services/central-reviewer
 *   native-source read(): submission, task, author, state, criteria,
 *   criteria_digest, evidence_digest, proof.verified).
 * taskPolicy: the current root-owned task policy, read by the caller.
 * attestation: the signed envelope from ops/custody/fleet_attestation.py attest().
 * trustedKeys: [{ publicKey (base64 raw Ed25519), environment }], from a
 *   root-owned reviewer profile, never from the submission or the envelope.
 */
export function reviewInput({ submission, taskPolicy, attestation, trustedKeys, environment = 'production', allowedVersions = [1], nativeEvidence, network } = {}) {
  need(ENVIRONMENTS.includes(environment), 'invalid_environment');
  validateAttestationVersions(allowedVersions);
  validateSubmission(submission);
  need(plain(taskPolicy) && taskPolicy.schema === POLICY_SCHEMA && typeof taskPolicy.class === 'string', 'invalid_task_policy', 'policy header');
  if (!Object.hasOwn(CLASS_DRIVERS, taskPolicy.class)) {
    const label = /^[a-z0-9_]{1,64}$/.test(taskPolicy.class) ? taskPolicy.class : 'unknown';
    return needsEvidence(environment, 'verification_adapter_required', [`verification_adapter_required:${label}`]);
  }
  const policy = validateTaskPolicy(taskPolicy);
  need(policy.taskId === submission.task && policy.criteriaDigest === submission.criteria_digest, 'policy_submission_mismatch');
  if (attestation === undefined || attestation === null) {
    return needsEvidence(environment, 'protected_verification_required', ['protected_verification_required']);
  }

  need(exactKeys(attestation, ENVELOPE_FIELDS), 'invalid_attestation', 'envelope shape');
  need(Buffer.byteLength(JSON.stringify(attestation)) <= 65536, 'invalid_attestation', 'envelope size');
  const key = trustedKey(trustedKeys, attestation.publicKey, environment);
  const statement = validateStatement(attestation.statement, {allowedVersions});
  const bytes = statementBytes(statement);
  need(HASH.test(attestation.statementDigest ?? '') && sha256(bytes) === attestation.statementDigest, 'attestation_digest_mismatch');
  const signature = base64Bytes(attestation.signature, 64, 'attestation_signature_invalid');
  need(verifySignature(null, bytes, key, signature), 'attestation_signature_invalid');
  // A fixture statement never becomes production input, whatever key signed it.
  need(statement.environment === environment, 'attestation_environment_mismatch');

  need(statement.submission === submission.submission, 'attestation_submission_mismatch');
  need(statement.author === submission.author, 'attestation_author_mismatch');
  need(statement.task === submission.task && statement.task === policy.taskId, 'attestation_task_mismatch');
  need(statement.criteriaDigest === submission.criteria_digest, 'attestation_criteria_mismatch');
  need(statement.evidenceDigest === submission.evidence_digest, 'attestation_evidence_mismatch');
  need(statement.policyDigest === digest(policy), 'stale_policy_digest');
  need(statement.project === policy.projectId && statement.evidenceClass === policy.class, 'attestation_policy_mismatch');
  need(canonical(statement.driver) === canonical(policy.driver), 'attestation_driver_mismatch');

  // The statement must commit to exactly the payload verifyEvidence() builds for this submission.
  let payload;
  if (statement.schema === FLEET_ATTESTATION_SCHEMA_V2) {
    const assignment = {taskId: submission.task, projectId: policy.projectId, submissionId: submission.submission,
      author: submission.author, criteriaDigest: submission.criteria_digest};
    const facts = nativeArtifactV2({policy, assignment, nativeEvidence, network});
    need(statement.chainId === network.chainId && statement.genesisSha256 === network.genesisSha256, 'attestation_network_mismatch');
    need(facts.nativeEvidenceDigest === submission.evidence_digest && facts.canonicalArtifactDigest === statement.canonicalArtifactDigest,
      'attestation_evidence_mismatch');
    payload = attestationPayloadV2({policy, assignment, ...facts, network, verdict: statement.verdict,
      reproductionAttestationDigest: statement.reproductionAttestationDigest});
  } else {
    payload = attestationPayload({
    policy,
    assignment: { submissionId: submission.submission, author: submission.author, criteriaDigest: submission.criteria_digest },
    artifactDigest: submission.evidence_digest,
    verdict: statement.verdict,
    reproductionAttestationDigest: statement.reproductionAttestationDigest,
  });
  }
  need(attestationDigestOf(payload) === statement.verificationDigest, 'attestation_verification_digest_mismatch');

  const verdict = VERDICTS[statement.verdict];
  return {
    schema: REVIEW_INPUT_SCHEMA,
    status: 'attested',
    verdict,
    reason: null,
    findings: [`fixed_driver:${statement.driver.name}:${statement.verdict}`],
    environment,
    fixture: environment === 'fixture',
    // What a central_review would carry once the pinned reviewer accepts this class (see follow-up above).
    centralReview: {
      submission: submission.submission,
      verdict,
      criteria_digest: submission.criteria_digest,
      evidence_digest: submission.evidence_digest,
      verification_attestation_digest: attestation.statementDigest,
    },
    execution: {
      evidence_class: statement.evidenceClass,
      driver: statement.driver.name,
      driver_sha256: statement.driver.sha256,
      policy_digest: statement.policyDigest,
      task_verification_digest: statement.verificationDigest,
      reproduction_attestation_digest: statement.reproductionAttestationDigest,
      attested_at: statement.attestedAt,
      attestation_public_key: attestation.publicKey,
    },
    trusted_verification: statement,
    mainKpiSatisfied: false,
  };
}


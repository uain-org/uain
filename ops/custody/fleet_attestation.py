"""Fleet verification attestation: custody consumer of verifyEvidence().

services/project-organizations/src/verification.mjs builds an unsigned
attestation payload (attestationPayload) and its digest after a fixed driver
decides pass or fail. This module is the custody side of that statement. It
never signs what the service claims on trust:

  * the task policy is read from a root-owned, protected file (production trusts
    uid 0 only; tests inject their own uid without weakening any check), and
    only a supported evidence class with its one fixed driver is accepted;
  * the fixed driver's bytes are read from a protected directory and must hash
    to the policy pin (source-code reproduction stays with the protected
    reproduction attestation in central_reviewer_server.py);
  * the payload is recomputed from custody's own reads: the policy file, the
    authoritative native task and submission records, and the submitted
    evidence, which must be the canonical artifact bytes (so the native
    evidence_digest is the payload's artifactDigest);
  * the verdict must be the one custody's own fixed-driver rerun decides
    (injected `rerun`); inconclusive or mismatched verdicts are refused;
  * the digest is recomputed with the same canonical JSON as
    services/project-organizations/src/common.mjs and must equal the claim.

Only then is the statement signed with an injected signer (Ed25519). The record
binds submission, author, task, project, criteria, evidence, policy, driver,
verdict and the environment, and always carries mainKpiSatisfied: false: a task
pass never satisfies a project's broad Main KPI.

check_review_bindings() is the consumer side: the central reviewer custody server
(central_reviewer_server.py, per-task root-owned `fleet_attestations` profile) runs
it before /readiness returns `trusted_verification` and again before /review signs.

This module holds no key, opens no socket and changes no native state. Wiring a
production key, the driver rerun and a source-pinned attest() entrypoint is follow-up
work (see services/project-organizations/src/review-input.mjs and
docs/baink/central-reviewer-trusted-verification-release.md).
"""
import base64
import copy
import datetime
import hashlib
import json
import os
import re
import stat
import time
from pathlib import Path

SCHEMA = 'uain-fleet-verification-attestation-v1'
DOMAIN = 'UAIN/fleet-verification-attestation/v1'
PAYLOAD_SCHEMA = 'uain-task-verification-attestation-v1'
POLICY_SCHEMA = 'uain-task-verification-policy-v1'
ARTIFACT_SCHEMA = 'uain-evidence-artifact-v1'
ROOT_UIDS = (0,)
POLICY_LIMIT = 1024 * 1024
DRIVER_LIMIT = 1024 * 1024
EVIDENCE_LIMIT = 16384
ENVIRONMENTS = ('production', 'fixture')

# Class -> the only driver a policy of that class may pin (verification.mjs CLASS_DRIVERS).
CLASS_DRIVERS = {
    'source_code_reproduction': 'protected-reproduction-attestation',
    'finite_math_witness': 'finite-math-witness',
    'pinned_dataset_analysis': 'pinned-dataset-analysis',
    'prior_art_survey': 'prior-art-survey',
}
FILE_DRIVERS = ('finite-math-witness', 'pinned-dataset-analysis', 'prior-art-survey')
POLICY_FIELDS = {'schema', 'class', 'taskId', 'projectId', 'criteriaDigest', 'inputs', 'primarySourceHosts', 'driver', 'successTests'}
PAYLOAD_FIELDS = {'schema', 'policyDigest', 'submissionId', 'author', 'criteriaDigest', 'artifactDigest', 'verdict', 'driver',
                  'reproductionAttestationDigest', 'mainKpiSatisfied'}
STATEMENT_FIELDS = {'schema', 'domain', 'environment', 'submission', 'author', 'task', 'project', 'evidenceClass', 'criteriaDigest',
                    'evidenceDigest', 'policyDigest', 'driver', 'verdict', 'reproductionAttestationDigest', 'verificationDigest',
                    'mainKpiSatisfied', 'attestedAt'}
ENVELOPE_FIELDS = {'statement', 'statementDigest', 'publicKey', 'signature'}
# A submitter may not supply its own verdict or attestation (verification.mjs ATTESTATION_FIELDS).
ARTIFACT_ATTESTATION_FIELDS = {'attestation', 'attestationDigest', 'attestation_digest', 'trusted_reproduction',
                               'trustedReproduction', 'trusted_verification', 'trustedVerification', 'verdict', 'signature',
                               'mainKpiSatisfied'}

HASH = re.compile(r'^[a-f0-9]{64}$')
NATIVE_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$')
ADDRESS = re.compile(r'^uain1[a-f0-9]{40}$')
SAFE_INTEGER = 9007199254740991


class Refused(ValueError):
    """A fail-closed refusal with a stable machine-readable code."""

    def __init__(self, code):
        super().__init__('Fleet verification attestation refused: ' + code)
        self.code = code


def require(condition, code):
    if not condition:
        raise Refused(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def exact(value, fields):
    return type(value) == dict and set(value) == set(fields)


# ------------------------------------------------------------ canonical JSON

def js_canonical(value):
    """Sorted-key JSON identical to services/project-organizations common.canonical.

    Same rules as project_organizations.js_canonical (kept separate so this
    module's source closure stays small; test_fleet_attestation cross-checks
    both against a vector produced by the JavaScript code)."""
    if value is None or type(value) in (bool, str):
        out = json.dumps(value, ensure_ascii=False)
        try:
            out.encode('utf-8')
        except UnicodeEncodeError:
            raise Refused('non_canonical_value') from None
        return out
    if type(value) == int:
        require(abs(value) <= SAFE_INTEGER, 'non_canonical_value')
        return str(value)
    if type(value) == list:
        return '[' + ','.join(js_canonical(v) for v in value) + ']'
    require(type(value) == dict and all(type(k) == str for k in value), 'non_canonical_value')
    # JavaScript sorts keys by UTF-16 code units; Python by code points. They
    # differ only above U+FFFF, which this mirrors exactly.
    keys = sorted(value, key=lambda k: k.encode('utf-16-be'))
    return '{' + ','.join(js_canonical(k) + ':' + js_canonical(value[k]) for k in keys) + '}'


def js_digest(value):
    return sha(js_canonical(value).encode('utf-8'))


def _unique_pairs(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, 'duplicate_key')
        value[key] = item
    return value


def _no_float(_):
    raise Refused('non_canonical_value')


def strict_json(raw):
    """UTF-8 JSON with no duplicate keys, floats, NaN or Infinity."""
    try:
        return json.loads(raw.decode('utf-8'), object_pairs_hook=_unique_pairs, parse_float=_no_float,
                          parse_constant=_no_float)
    except Refused:
        raise
    except (UnicodeDecodeError, ValueError):
        raise Refused('invalid_json') from None


# ------------------------------------------------------------ protected reads

def _trusted_directory(info, trusted_uids):
    return stat.S_ISDIR(info.st_mode) and info.st_uid in trusted_uids and not info.st_mode & 0o022


def _trusted_parents(directory, trusted_uids, boundary=None):
    """Every directory from `directory` up to '/' must be trusted. Production passes no
    boundary. Tests may name an ancestor at which the walk stops (it is still checked),
    so fixtures under a foreign-owned or world-writable parent such as a container's
    mounted checkout or /tmp work without weakening any check below the boundary."""
    chain = (directory, *directory.parents)
    if boundary is not None:
        boundary = Path(boundary)
        require(boundary.is_absolute() and boundary.resolve() == boundary and boundary in chain, 'untrusted_boundary')
        chain = chain[:chain.index(boundary) + 1]
    for parent in chain:
        require(_trusted_directory(parent.stat(), trusted_uids), 'untrusted_parent')


def protected_read(path, trusted_uids=ROOT_UIDS, limit=POLICY_LIMIT, boundary=None):
    """A regular, non-symlinked, single-link file owned by a trusted uid, not
    group/other writable, whose every parent is likewise protected."""
    path = Path(path)
    require(path.is_absolute() and path.resolve() == path, 'untrusted_path')
    _trusted_parents(path.parent, trusted_uids, boundary)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        raise Refused('untrusted_file') from None
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid in trusted_uids and not info.st_mode & 0o022
                and info.st_nlink == 1 and 0 < info.st_size <= limit, 'untrusted_file')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            raw = stream.read(limit + 1)
        after = os.fstat(fd)
        same = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        require(len(raw) == info.st_size and same(info) == same(after), 'file_changed_during_read')
        return raw
    finally:
        os.close(fd)


# ------------------------------------------------------------ policy

def load_policy(path, trusted_uids=ROOT_UIDS, boundary=None):
    """The root-owned task policy. Untrusted code never selects the class or driver."""
    return parse_policy(protected_read(path, trusted_uids, POLICY_LIMIT, boundary))


def parse_policy(raw):
    """Validate task policy bytes the caller already read under its own protected-read rules
    (load_policy above, or the central reviewer's coherent ProtectedArtifacts snapshot)."""
    policy = strict_json(raw)
    require(type(policy) == dict and policy.get('schema') == POLICY_SCHEMA and type(policy.get('class')) == str, 'invalid_task_policy')
    require(policy['class'] in CLASS_DRIVERS, 'verification_adapter_required')
    require(exact(policy, POLICY_FIELDS), 'invalid_task_policy')
    require(type(policy['taskId']) == str and NATIVE_ID.match(policy['taskId']) and type(policy['projectId']) == str
            and NATIVE_ID.match(policy['projectId']) and type(policy['criteriaDigest']) == str
            and HASH.match(policy['criteriaDigest']), 'invalid_task_policy')
    driver = policy['driver']
    require(exact(driver, {'name', 'sha256'}) and driver['name'] == CLASS_DRIVERS[policy['class']]
            and type(driver['sha256']) == str and HASH.match(driver['sha256']), 'driver_not_fixed_for_class')
    require(type(policy['inputs']) == list and type(policy['primarySourceHosts']) == list
            and type(policy['successTests']) == list and 1 <= len(policy['successTests']) <= 32, 'invalid_task_policy')
    js_canonical(policy)
    return policy


def driver_source(policy, driver_directory, trusted_uids=ROOT_UIDS, boundary=None):
    """The fixed driver's exact bytes, refused unless they hash to the policy pin.
    Source-code reproduction has no file driver: its verdict is the protected
    reproduction attestation, which the rerun must supply."""
    name = policy['driver']['name']
    if name not in FILE_DRIVERS:
        return None
    require(driver_directory is not None, 'driver_directory_required')
    raw = protected_read(Path(driver_directory) / (name + '.mjs'), trusted_uids, DRIVER_LIMIT, boundary)
    require(sha(raw) == policy['driver']['sha256'], 'driver_hash_mismatch')
    return raw


# ------------------------------------------------------------ native bindings

def _evidence_artifact(policy, task, answer):
    """The native records custody read itself, and the artifact they carry."""
    require(type(task) == dict and type(answer) == dict, 'invalid_native_records')
    require(type(task.get('id')) == str and task.get('state') == 'under_review' and task.get('pending') == answer.get('id'),
            'task_not_under_review')
    require(task['id'] == policy['taskId'] and task.get('project') == policy['projectId'], 'policy_task_mismatch')
    require(task.get('acceptance_digest') == policy['criteriaDigest'], 'policy_criteria_mismatch')
    criteria = task.get('criteria')
    require(type(criteria) == str and sha(criteria.encode('utf-8')) == task['acceptance_digest'], 'criteria_digest_mismatch')
    require(type(answer.get('id')) == str and NATIVE_ID.match(answer['id'])
            and answer.get('task') == task['id'] and answer.get('state') == 'under_review', 'submission_not_under_review')
    require(type(answer.get('author')) == str and ADDRESS.match(answer['author']), 'invalid_submission_author')
    evidence = answer.get('evidence')
    require(type(evidence) == str and type(answer.get('evidence_digest')) == str and HASH.match(answer['evidence_digest']), 'invalid_evidence')
    raw = evidence.encode('utf-8')
    require(0 < len(raw) <= EVIDENCE_LIMIT and sha(raw) == answer['evidence_digest'], 'evidence_digest_mismatch')
    artifact = strict_json(raw)
    # Submitted evidence is the canonical artifact, so evidence_digest == artifactDigest.
    require(type(artifact) == dict and js_canonical(artifact) == evidence, 'evidence_not_canonical_artifact')
    require(not ARTIFACT_ATTESTATION_FIELDS & set(artifact), 'artifact_supplied_attestation_rejected')
    require(artifact.get('schema') == ARTIFACT_SCHEMA and artifact.get('taskId') == task['id']
            and artifact.get('submissionId') == answer['id'] and artifact.get('author') == answer['author'], 'artifact_binding_mismatch')
    return artifact


def expected_payload(policy, answer, verdict, reproduction_digest):
    """attestationPayload() recomputed from custody's own reads."""
    return dict(schema=PAYLOAD_SCHEMA, policyDigest=js_digest(policy), submissionId=answer['id'], author=answer['author'],
                criteriaDigest=policy['criteriaDigest'], artifactDigest=answer['evidence_digest'], verdict=verdict,
                driver=dict(name=policy['driver']['name'], sha256=policy['driver']['sha256']),
                reproductionAttestationDigest=reproduction_digest, mainKpiSatisfied=False)


def _decided(policy, rerun, source, artifact):
    """The verdict custody's own fixed-driver rerun decides. Anything else is refused."""
    require(callable(rerun), 'fixed_driver_rerun_required')
    driver = dict(name=policy['driver']['name'], sha256=policy['driver']['sha256'], source=source)
    result = rerun(driver, copy.deepcopy(policy), copy.deepcopy(artifact))
    require(exact(result, {'verdict', 'reproductionAttestationDigest'}) and result['verdict'] in ('pass', 'fail'),
            'verdict_not_decided_by_fixed_driver')
    digest = result['reproductionAttestationDigest']
    if policy['class'] == 'source_code_reproduction':
        # Only a protected reproduction pass decides this class.
        require(result['verdict'] == 'pass' and type(digest) == str and HASH.match(digest), 'protected_reproduction_required')
    else:
        require(digest is None, 'verdict_not_decided_by_fixed_driver')
    return result['verdict'], digest


# V2 is an explicitly admitted external authority; V1 paths above remain unchanged.
SCHEMA_V2 = 'uain-fleet-verification-attestation-v2'
DOMAIN_V2 = 'UAIN/fleet-verification-attestation/v2'
PAYLOAD_SCHEMA_V2 = 'uain-task-verification-attestation-v2'
PAYLOAD_DOMAIN_V2 = 'UAIN/task-verification-attestation/v2'
PAYLOAD_FIELDS_V2 = (PAYLOAD_FIELDS - {'artifactDigest'}) | {'domain', 'nativeEvidenceDigest', 'canonicalArtifactDigest'}
V2_NETWORK = dict(chainId='uain-shadow-20261008-1', genesisSha256='54140a9243c4591ccc9f2e9d49543fc68b87b3e0045416174c232e9dd498f8ff')
PAYLOAD_FIELDS_V2 |= {'chainId','genesisSha256'}
STATEMENT_FIELDS_V2 = STATEMENT_FIELDS | {'canonicalArtifactDigest','chainId','genesisSha256'}


def validate_network(network):
    require(type(network) == dict and set(network) == {'chainId','genesisSha256'} and network == V2_NETWORK, 'attestation_network_mismatch')
    return dict(network)


def validate_versions(versions):
    require(type(versions) in (list, tuple) and 1 <= len(versions) <= 2
            and all(type(v) == int and v in (1, 2) for v in versions)
            and len(set(versions)) == len(versions), 'invalid_attestation_versions')
    return tuple(versions)


def evidence_artifact_v2(policy, task, answer):
    require(policy.get('class') == 'prior_art_survey', 'attestation_v2_class_not_allowed')
    require(type(answer) == dict and type(answer.get('evidence')) == str, 'invalid_evidence')
    try:
        raw = answer['evidence'].encode('utf-8')
        require(0 < len(raw) <= EVIDENCE_LIMIT and sha(raw) == answer.get('evidence_digest'), 'evidence_digest_mismatch')
        artifact = strict_json(raw)
        def bounded(value, depth=0):
            require(depth <= 64, 'evidence_structure_over_limit')
            if type(value) == dict:
                for item in value.values(): bounded(item, depth + 1)
            elif type(value) == list:
                for item in value: bounded(item, depth + 1)
        bounded(artifact)
        encoded = js_canonical(artifact).encode('utf-8')
        require(0 < len(encoded) <= EVIDENCE_LIMIT, 'evidence_digest_mismatch')
    except (RecursionError, UnicodeEncodeError):
        raise Refused('non_canonical_value') from None
    # Reuse every unchanged V1 task/criteria/artifact/author binding on an ephemeral
    # canonical representation. The actual native record is never changed or signed.
    canonical_answer = {**answer, 'evidence': encoded.decode('utf-8'), 'evidence_digest': sha(encoded)}
    _evidence_artifact(policy, task, canonical_answer)
    return dict(artifact=artifact, nativeEvidenceDigest=sha(raw), canonicalArtifactDigest=sha(encoded))


def expected_payload_v2(policy, task, answer, verdict, reproduction_digest, network=None):
    network = validate_network(network)
    facts = evidence_artifact_v2(policy, task, answer)
    payload = expected_payload(policy, answer, verdict, reproduction_digest)
    del payload['artifactDigest']
    payload.update(schema=PAYLOAD_SCHEMA_V2, domain=PAYLOAD_DOMAIN_V2,
                   nativeEvidenceDigest=facts['nativeEvidenceDigest'], canonicalArtifactDigest=facts['canonicalArtifactDigest'], **network)
    return payload


def statement_bytes_v2(statement):
    return (DOMAIN_V2 + '\n' + js_canonical(statement)).encode('utf-8')


# ------------------------------------------------------------ attestation

def statement_bytes(statement):
    return (DOMAIN + '\n' + js_canonical(statement)).encode('utf-8')


def _iso(now):
    return datetime.datetime.fromtimestamp(int(now), datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def attest(policy_path, payload, verification_digest, task, answer, rerun, signer, environment,
           trusted_uids=ROOT_UIDS, driver_directory=None, now=time.time, euid=os.geteuid, boundary=None):
    """Check a verifyEvidence() payload against custody's own reads and sign it.

    policy_path: the root-owned task policy file.
    payload, verification_digest: attestationPayload() and attestationDigest from the service (claims only).
    task, answer: the native central_task and central_submission records custody read itself.
    rerun(driver, policy, artifact) -> {'verdict', 'reproductionAttestationDigest'}: custody's fixed-driver run.
    signer(message bytes) -> {'public_key': 32 bytes, 'signature': 64 bytes}.
    environment: 'production' (root, root-owned files only) or 'fixture'.
    """
    require(environment in ENVIRONMENTS, 'invalid_environment')
    trusted_uids = tuple(trusted_uids)
    if environment == 'production':
        # A fixture run (test uids, test files) can never be labelled production.
        require(trusted_uids == ROOT_UIDS and euid() == 0 and boundary is None, 'production_requires_root')
    require(exact(payload, PAYLOAD_FIELDS) and payload['schema'] == PAYLOAD_SCHEMA, 'invalid_payload')
    require(type(verification_digest) == str and HASH.match(verification_digest), 'invalid_payload')
    require(js_digest(payload) == verification_digest, 'verification_digest_mismatch')
    require(payload['mainKpiSatisfied'] is False, 'main_kpi_claim_refused')
    require(payload['verdict'] in ('pass', 'fail'), 'verdict_not_decided_by_fixed_driver')

    policy = load_policy(policy_path, trusted_uids, boundary)
    source = driver_source(policy, driver_directory, trusted_uids, boundary)
    artifact = _evidence_artifact(policy, task, answer)
    verdict, reproduction_digest = _decided(policy, rerun, source, artifact)
    require(verdict == payload['verdict'], 'verdict_mismatch')
    expected = expected_payload(policy, answer, verdict, reproduction_digest)
    for field in ('policyDigest', 'submissionId', 'author', 'criteriaDigest', 'artifactDigest', 'driver', 'reproductionAttestationDigest'):
        require(js_canonical(payload[field]) == js_canonical(expected[field]), {
            'policyDigest': 'stale_policy_digest', 'submissionId': 'submission_mismatch', 'author': 'author_mismatch',
            'criteriaDigest': 'criteria_mismatch', 'artifactDigest': 'evidence_mismatch', 'driver': 'driver_mismatch',
            'reproductionAttestationDigest': 'reproduction_attestation_mismatch'}[field])
    require(js_canonical(payload) == js_canonical(expected) and js_digest(expected) == verification_digest, 'payload_mismatch')

    statement = dict(schema=SCHEMA, domain=DOMAIN, environment=environment, submission=answer['id'], author=answer['author'],
                     task=task['id'], project=task['project'], evidenceClass=policy['class'],
                     criteriaDigest=policy['criteriaDigest'], evidenceDigest=answer['evidence_digest'],
                     policyDigest=expected['policyDigest'], driver=dict(expected['driver']), verdict=verdict,
                     reproductionAttestationDigest=reproduction_digest, verificationDigest=verification_digest,
                     mainKpiSatisfied=False, attestedAt=_iso(now()))
    message = statement_bytes(statement)
    signed = signer(message)
    require(exact(signed, {'public_key', 'signature'}) and type(signed['public_key']) == bytes and len(signed['public_key']) == 32
            and type(signed['signature']) == bytes and len(signed['signature']) == 64, 'invalid_signature')
    envelope = dict(statement=statement, statementDigest=sha(message), publicKey=base64.b64encode(signed['public_key']).decode(),
                    signature=base64.b64encode(signed['signature']).decode())
    return envelope


def attest_v2(policy_path, payload, verification_digest, task, answer, rerun, signer, environment,
           trusted_uids=ROOT_UIDS, driver_directory=None, now=time.time, euid=os.geteuid, boundary=None, allowed_versions=(1,), network=None):
    """Check a verifyEvidence() payload against custody's own reads and sign it.

    policy_path: the root-owned task policy file.
    payload, verification_digest: attestationPayload() and attestationDigest from the service (claims only).
    task, answer: the native central_task and central_submission records custody read itself.
    rerun(driver, policy, artifact) -> {'verdict', 'reproductionAttestationDigest'}: custody's fixed-driver run.
    signer(message bytes) -> {'public_key': 32 bytes, 'signature': 64 bytes}.
    environment: 'production' (root, root-owned files only) or 'fixture'.
    """
    require(2 in validate_versions(allowed_versions), 'attestation_version_not_allowed')
    network = validate_network(network)
    require(environment in ENVIRONMENTS, 'invalid_environment')
    trusted_uids = tuple(trusted_uids)
    if environment == 'production':
        # A fixture run (test uids, test files) can never be labelled production.
        require(trusted_uids == ROOT_UIDS and euid() == 0 and boundary is None, 'production_requires_root')
    require(exact(payload, PAYLOAD_FIELDS_V2) and payload['schema'] == PAYLOAD_SCHEMA_V2 and payload['domain'] == PAYLOAD_DOMAIN_V2, 'invalid_payload')
    require({k:payload[k] for k in ('chainId','genesisSha256')} == network, 'attestation_network_mismatch')
    require(type(verification_digest) == str and HASH.match(verification_digest), 'invalid_payload')
    require(js_digest(payload) == verification_digest, 'verification_digest_mismatch')
    require(payload['mainKpiSatisfied'] is False, 'main_kpi_claim_refused')
    require(payload['verdict'] in ('pass', 'fail'), 'verdict_not_decided_by_fixed_driver')

    policy = load_policy(policy_path, trusted_uids, boundary)
    require(policy['class'] == 'prior_art_survey', 'attestation_v2_class_not_allowed')
    source = driver_source(policy, driver_directory, trusted_uids, boundary)
    facts = evidence_artifact_v2(policy, task, answer)
    artifact = facts['artifact']
    verdict, reproduction_digest = _decided(policy, rerun, source, artifact)
    require(verdict == payload['verdict'], 'verdict_mismatch')
    expected = expected_payload_v2(policy, task, answer, verdict, reproduction_digest, network)
    for field in ('policyDigest', 'submissionId', 'author', 'criteriaDigest', 'nativeEvidenceDigest', 'canonicalArtifactDigest', 'driver', 'reproductionAttestationDigest'):
        require(js_canonical(payload[field]) == js_canonical(expected[field]), {
            'policyDigest': 'stale_policy_digest', 'submissionId': 'submission_mismatch', 'author': 'author_mismatch',
            'criteriaDigest': 'criteria_mismatch', 'nativeEvidenceDigest': 'evidence_mismatch', 'canonicalArtifactDigest': 'canonical_artifact_mismatch', 'driver': 'driver_mismatch',
            'reproductionAttestationDigest': 'reproduction_attestation_mismatch'}[field])
    require(js_canonical(payload) == js_canonical(expected) and js_digest(expected) == verification_digest, 'payload_mismatch')

    statement = dict(schema=SCHEMA_V2, domain=DOMAIN_V2, environment=environment, submission=answer['id'], author=answer['author'],
                     task=task['id'], project=task['project'], evidenceClass=policy['class'],
                     criteriaDigest=policy['criteriaDigest'], evidenceDigest=answer['evidence_digest'], canonicalArtifactDigest=facts['canonicalArtifactDigest'],
                     policyDigest=expected['policyDigest'], driver=dict(expected['driver']), verdict=verdict,
                     reproductionAttestationDigest=reproduction_digest, verificationDigest=verification_digest,
                     mainKpiSatisfied=False, attestedAt=_iso(now()), **network)
    message = statement_bytes_v2(statement)
    signed = signer(message)
    require(exact(signed, {'public_key', 'signature'}) and type(signed['public_key']) == bytes and len(signed['public_key']) == 32
            and type(signed['signature']) == bytes and len(signed['signature']) == 64, 'invalid_signature')
    envelope = dict(statement=statement, statementDigest=sha(message), publicKey=base64.b64encode(signed['public_key']).decode(),
                    signature=base64.b64encode(signed['signature']).decode())
    return envelope


# ------------------------------------------------------------ Ed25519

def ed25519_available():
    try:
        from cryptography.hazmat.primitives.asymmetric import ed25519  # noqa: F401
        return True
    except ImportError:
        return False


def ed25519_signer(seed):
    """A signer over a 32-byte Ed25519 seed that self-verifies every signature.
    Loading the production attestation key is custody's job and not done here."""
    from cryptography.hazmat.primitives.asymmetric import ed25519
    from cryptography.hazmat.primitives import serialization
    require(type(seed) == bytes and len(seed) == 32, 'invalid_key')
    key = ed25519.Ed25519PrivateKey.from_private_bytes(seed)
    public = key.public_key()
    raw_public = public.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)

    def sign(message):
        signature = key.sign(message)
        public.verify(signature, message)
        return dict(public_key=raw_public, signature=signature)
    return sign


def ed25519_verify(public_key, signature, message):
    """Pure Ed25519 verification. Production custody has pycryptodomex (through pykeepass);
    the isolated CI runtime has the system cryptography backend (as native_migration.ed25519).
    Both verify the same standard RFC 8032 signatures."""
    require(type(public_key) == bytes and len(public_key) == 32 and type(signature) == bytes and len(signature) == 64,
            'attestation_signature_invalid')
    try:
        from Cryptodome.Signature import eddsa
    except ImportError:
        from cryptography.hazmat.primitives.asymmetric import ed25519
        from cryptography.exceptions import InvalidSignature
        try:
            ed25519.Ed25519PublicKey.from_public_bytes(public_key).verify(signature, message)
        except (InvalidSignature, ValueError):
            raise Refused('attestation_signature_invalid') from None
        return
    try:
        eddsa.new(eddsa.import_public_key(public_key), 'rfc8032').verify(message, signature)
    except ValueError:
        raise Refused('attestation_signature_invalid') from None


def strict_base64(value, length, code):
    """Strict standard base64 of exactly `length` bytes (review-input.mjs base64Bytes)."""
    require(type(value) == str and re.fullmatch(r'[A-Za-z0-9+/]+={0,2}', value), code)
    try:
        raw = base64.b64decode(value, validate=True)
    except ValueError:
        raise Refused(code) from None
    require(len(raw) == length and base64.b64encode(raw).decode() == value, code)
    return raw


def verify(envelope, public_key):
    """Check an envelope against a raw 32-byte Ed25519 public key; returns the statement."""
    require(exact(envelope, ENVELOPE_FIELDS) and exact(envelope['statement'], STATEMENT_FIELDS), 'invalid_envelope')
    statement = envelope['statement']
    require(statement['schema'] == SCHEMA and statement['domain'] == DOMAIN and statement['mainKpiSatisfied'] is False, 'invalid_envelope')
    message = statement_bytes(statement)
    require(sha(message) == envelope['statementDigest'], 'statement_digest_mismatch')
    require(type(public_key) == bytes and base64.b64encode(public_key).decode() == envelope['publicKey'], 'untrusted_attestation_key')
    ed25519_verify(public_key, strict_base64(envelope['signature'], 64, 'attestation_signature_invalid'), message)
    return copy.deepcopy(statement)


# ------------------------------------------------------------ central reviewer input

ISO_SECONDS = re.compile(r'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$')
VERDICTS = {'pass': 'accept', 'fail': 'reject'}


def validate_statement(statement):
    """Shape of a signed statement (review-input.mjs validateStatement)."""
    require(exact(statement, STATEMENT_FIELDS) and statement['schema'] == SCHEMA and statement['domain'] == DOMAIN, 'invalid_attestation')
    require(statement['environment'] in ENVIRONMENTS, 'invalid_attestation')
    require(all(type(statement[k]) == str and NATIVE_ID.match(statement[k]) for k in ('submission', 'task', 'project'))
            and type(statement['author']) == str and ADDRESS.match(statement['author']), 'invalid_attestation')
    require(type(statement['evidenceClass']) == str and statement['evidenceClass'] in CLASS_DRIVERS, 'invalid_attestation')
    require(all(type(statement[k]) == str and HASH.match(statement[k])
                for k in ('criteriaDigest', 'evidenceDigest', 'policyDigest', 'verificationDigest')), 'invalid_attestation')
    driver = statement['driver']
    require(exact(driver, {'name', 'sha256'}) and driver['name'] == CLASS_DRIVERS[statement['evidenceClass']]
            and type(driver['sha256']) == str and HASH.match(driver['sha256']), 'invalid_attestation')
    require(type(statement['verdict']) == str and statement['verdict'] in VERDICTS, 'invalid_attestation')
    reproduction = statement['reproductionAttestationDigest']
    if statement['evidenceClass'] == 'source_code_reproduction':
        require(type(reproduction) == str and HASH.match(reproduction) and statement['verdict'] == 'pass', 'invalid_attestation')
    else:
        require(reproduction is None, 'invalid_attestation')
    require(statement['mainKpiSatisfied'] is False, 'invalid_attestation')
    attested = statement['attestedAt']
    require(type(attested) == str and ISO_SECONDS.match(attested), 'invalid_attestation')
    try:
        datetime.datetime.strptime(attested, '%Y-%m-%dT%H:%M:%SZ')
    except ValueError:
        raise Refused('invalid_attestation') from None
    js_canonical(statement)
    return copy.deepcopy(statement)


def _epoch(stamp):
    return datetime.datetime.strptime(stamp, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc).timestamp()


def check_review_bindings(envelope, public_key, environment, policy, task, answer, now=time.time, allowed_versions=(1,), network=None):
    """What a central reviewer checks before using a signed statement (review-input.mjs reviewInput).

    envelope: the stored signed envelope (claims only until checked here).
    public_key: the raw 32-byte trusted key from a root-owned reviewer profile, never from the envelope.
    environment: the environment the profile requires ('production' for the central reviewer).
    policy: the current root-owned task policy, already parsed by parse_policy.
    task, answer: the native central_task and central_submission records the caller read itself.
    Returns the statement; any mismatch raises Refused (fail closed)."""
    versions = validate_versions(allowed_versions)
    if type(envelope) == dict and type(envelope.get('statement')) == dict and envelope['statement'].get('schema') == SCHEMA_V2:
        require(2 in versions, 'attestation_version_not_allowed')
        return check_review_bindings_v2(envelope, public_key, environment, policy, task, answer, now, allowed_versions=versions, network=network)
    require(1 in versions, 'attestation_version_not_allowed')
    require(environment in ENVIRONMENTS, 'invalid_environment')
    require(exact(envelope, ENVELOPE_FIELDS), 'invalid_attestation')
    require(len(js_canonical(envelope).encode('utf-8')) <= 65536, 'invalid_attestation')
    require(type(envelope['statementDigest']) == str and HASH.match(envelope['statementDigest']), 'attestation_digest_mismatch')
    strict_base64(envelope['publicKey'], 32, 'invalid_attestation')
    require(type(public_key) == bytes and len(public_key) == 32, 'invalid_trusted_keys')
    require(base64.b64encode(public_key).decode() == envelope['publicKey'], 'untrusted_attestation_key')
    statement = validate_statement(verify(envelope, public_key))
    # A fixture statement never becomes production input, whatever key signed it.
    require(statement['environment'] == environment, 'attestation_environment_mismatch')
    require(type(task) == dict and type(answer) == dict, 'invalid_native_records')
    require(task.get('state') == 'under_review' and task.get('pending') == answer.get('id') and answer.get('task') == task.get('id')
            and answer.get('state') == 'under_review', 'submission_not_under_review')
    criteria = task.get('criteria')
    require(type(criteria) == str and sha(criteria.encode('utf-8')) == task.get('acceptance_digest'), 'criteria_digest_mismatch')
    require(statement['submission'] == answer['id'], 'attestation_submission_mismatch')
    require(statement['author'] == answer.get('author'), 'attestation_author_mismatch')
    require(statement['task'] == task['id'] == policy['taskId'], 'attestation_task_mismatch')
    require(statement['criteriaDigest'] == task['acceptance_digest'] == policy['criteriaDigest'], 'attestation_criteria_mismatch')
    require(statement['evidenceDigest'] == answer.get('evidence_digest'), 'attestation_evidence_mismatch')
    require(statement['policyDigest'] == js_digest(policy), 'stale_policy_digest')
    require(statement['project'] == policy['projectId'] == task.get('project') and statement['evidenceClass'] == policy['class'],
            'attestation_policy_mismatch')
    require(js_canonical(statement['driver']) == js_canonical(policy['driver']), 'attestation_driver_mismatch')
    # The statement must commit to exactly the payload verifyEvidence() builds for this submission.
    payload = expected_payload(policy, answer, statement['verdict'], statement['reproductionAttestationDigest'])
    require(js_digest(payload) == statement['verificationDigest'], 'attestation_verification_digest_mismatch')
    require(_epoch(statement['attestedAt']) <= now() + 60, 'attestation_from_future')
    return statement


def validate_statement_v2(statement):
    require(exact(statement, STATEMENT_FIELDS_V2) and statement['schema'] == SCHEMA_V2 and statement['domain'] == DOMAIN_V2,
            'invalid_attestation')
    require(statement['evidenceClass'] == 'prior_art_survey' and type(statement['canonicalArtifactDigest']) == str
            and HASH.match(statement['canonicalArtifactDigest']), 'invalid_attestation')
    validate_network({k:statement[k] for k in ('chainId','genesisSha256')})
    mirror = {k: v for k, v in statement.items() if k not in ('canonicalArtifactDigest','chainId','genesisSha256')}
    mirror.update(schema=SCHEMA, domain=DOMAIN)
    validate_statement(mirror)
    return copy.deepcopy(statement)


def verify_v2(envelope, public_key):
    require(exact(envelope, ENVELOPE_FIELDS), 'invalid_envelope')
    statement = validate_statement_v2(envelope['statement'])
    message = statement_bytes_v2(statement)
    require(sha(message) == envelope['statementDigest'], 'statement_digest_mismatch')
    require(type(public_key) == bytes and base64.b64encode(public_key).decode() == envelope['publicKey'], 'untrusted_attestation_key')
    ed25519_verify(public_key, strict_base64(envelope['signature'], 64, 'attestation_signature_invalid'), message)
    return statement


def check_review_bindings_v2(envelope, public_key, environment, policy, task, answer, now=time.time, allowed_versions=(1,), network=None):
    """What a central reviewer checks before using a signed statement (review-input.mjs reviewInput).

    envelope: the stored signed envelope (claims only until checked here).
    public_key: the raw 32-byte trusted key from a root-owned reviewer profile, never from the envelope.
    environment: the environment the profile requires ('production' for the central reviewer).
    policy: the current root-owned task policy, already parsed by parse_policy.
    task, answer: the native central_task and central_submission records the caller read itself.
    Returns the statement; any mismatch raises Refused (fail closed)."""
    require(2 in validate_versions(allowed_versions), 'attestation_version_not_allowed')
    network = validate_network(network)
    require(environment in ENVIRONMENTS, 'invalid_environment')
    require(exact(envelope, ENVELOPE_FIELDS), 'invalid_attestation')
    require(len(js_canonical(envelope).encode('utf-8')) <= 65536, 'invalid_attestation')
    require(type(envelope['statementDigest']) == str and HASH.match(envelope['statementDigest']), 'attestation_digest_mismatch')
    strict_base64(envelope['publicKey'], 32, 'invalid_attestation')
    require(type(public_key) == bytes and len(public_key) == 32, 'invalid_trusted_keys')
    require(base64.b64encode(public_key).decode() == envelope['publicKey'], 'untrusted_attestation_key')
    statement = validate_statement_v2(verify_v2(envelope, public_key))
    # A fixture statement never becomes production input, whatever key signed it.
    require(statement['environment'] == environment, 'attestation_environment_mismatch')
    require(type(task) == dict and type(answer) == dict, 'invalid_native_records')
    require(task.get('state') == 'under_review' and task.get('pending') == answer.get('id') and answer.get('task') == task.get('id')
            and answer.get('state') == 'under_review', 'submission_not_under_review')
    criteria = task.get('criteria')
    require(type(criteria) == str and sha(criteria.encode('utf-8')) == task.get('acceptance_digest'), 'criteria_digest_mismatch')
    require(statement['submission'] == answer['id'], 'attestation_submission_mismatch')
    require(statement['author'] == answer.get('author'), 'attestation_author_mismatch')
    require(statement['task'] == task['id'] == policy['taskId'], 'attestation_task_mismatch')
    require(statement['criteriaDigest'] == task['acceptance_digest'] == policy['criteriaDigest'], 'attestation_criteria_mismatch')
    require(statement['evidenceDigest'] == answer.get('evidence_digest'), 'attestation_evidence_mismatch')
    require(statement['policyDigest'] == js_digest(policy), 'stale_policy_digest')
    require(statement['project'] == policy['projectId'] == task.get('project') and statement['evidenceClass'] == policy['class'],
            'attestation_policy_mismatch')
    require(js_canonical(statement['driver']) == js_canonical(policy['driver']), 'attestation_driver_mismatch')
    # The statement must commit to exactly the payload verifyEvidence() builds for this submission.
    require({k:statement[k] for k in ('chainId','genesisSha256')} == network, 'attestation_network_mismatch')
    facts = evidence_artifact_v2(policy, task, answer)
    require(statement['canonicalArtifactDigest'] == facts['canonicalArtifactDigest'], 'canonical_artifact_mismatch')
    payload = expected_payload_v2(policy, task, answer, statement['verdict'], statement['reproductionAttestationDigest'], network)
    require(js_digest(payload) == statement['verificationDigest'], 'attestation_verification_digest_mismatch')
    require(_epoch(statement['attestedAt']) <= now() + 60, 'attestation_from_future')
    return statement

"""Custody attestation of prior-art survey verifications (decision D2, 6 November 2026).

Root-only, run by uain-survey-attester.timer. For every starter survey task under review it:
  1. reads the native task and the pending submission (fleet custody `status`, proven state);
  2. runs the fixed prior-art-survey verifier (services/project-organizations/ops/verify-survey.mjs:
     pinned-address retrieval from the fixed record APIs, then the hash-pinned driver) for the
     service claim, and again as custody's own rerun;
  3. signs with fleet_attestation.attest(), which re-derives every binding from the root-owned
     task policy, the protected driver bytes and the native records, and refuses any mismatch;
  4. stores the envelope where the central reviewer's custody server reads it
     (/var/lib/uain-custody/central-reviewer/fleet-attestations/<sha256(submission)>.json).

An inconclusive verification (a record API that could not be read) is not attested; the next
run tries again. A fail is attested too: the reviewer then rejects, which pays only the reviewer.

`provision <expected_vault_sha256>` creates the attestation key inside encrypted custody, once.
"""
import base64
import contextlib
import hashlib
import io
import json
import os
import re
import secrets
import stat
import subprocess
import sys
import time
import types
from pathlib import Path

SOURCE_MANIFEST = Path('/etc/uain-custody/survey-attester-sources.json')
SOURCE_SCHEMA = 'uain-survey-attester-sources-v1'
SOURCE_NAMES = ('native_migration', 'holder_release', 'custody', 'fleet_attestation', 'survey_attester')
ROOT = Path('/var/lib/uain-custody/survey-attester')
ENVELOPES = Path('/var/lib/uain-custody/central-reviewer/fleet-attestations')
POLICIES = Path('/etc/uain-custody/task-policies')
STARTER = Path('/etc/uain-custody/organization-starter')
CUSTODY_CLI = Path('/opt/uain-custody/project_organizations.py')
PYTHON = '/opt/uain-custody/venv/bin/python'
NODE = '/opt/uain-review-runtime/node-v22.22.0-linux-x64/bin/node'
RELEASE_LINK = Path('/opt/uain-organizations/current')
# The verifier runs only from a private copy of these files, each checked against a root-owned
# hash pin, never from the mutable `current` symlink (10 November 2026, plan W11, audit 12b #4):
# a changed verify-survey.mjs could otherwise report the pinned driver digest and a pass.
VERIFIER_PINS = Path('/etc/uain-custody/survey-verifier-sources.json')
VERIFIER_SCHEMA = 'uain-survey-verifier-sources-v1'
# The whole import closure of verify-survey.mjs (it imports no package from node_modules).
VERIFIER_FILES = (
    'services/central-reviewer/src/lock.mjs',
    'services/central-reviewer/src/worker.mjs',
    'services/project-organizations/ops/verify-survey.mjs',
    'services/project-organizations/src/common.mjs',
    'services/project-organizations/src/pinned-fetch.mjs',
    'services/project-organizations/src/survey-sources.mjs',
    'services/project-organizations/src/verification.mjs',
    'services/project-organizations/verifiers/prior-art-survey.mjs',
    'services/project-organizations/verifiers/registry-audit.mjs',
    'services/project-organizations/verifiers/single-claim.mjs',
)
KEY = 'keys/fleet-attestation.json'
LOCK = Path('/run/lock/uain-custody.lock')
# The survey of each starter project, or one part of a split replacement survey (9 Nov 2026).
SURVEY = re.compile(r'^T-OPP-[0-9]{5}-1-prior-art-survey(-r[2-9]-p[1-9][0-9]?)?$')
ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$')

# Signed reasons companion (10 November 2026). A fail used to reach the member as "the survey driver
# failed" with no rule named. Next to a fail envelope custody now signs, with the same attestation key
# and its own domain, the failed rules of its own rerun as fixed-shape codes (never free text), bound
# to the envelope's statementDigest. The envelope and its hash are unchanged. Golden values:
# fixtures/contracts/survey-checker-reasons.json (central_reviewer_server.fleet_reasons reads it).
REASONS_SCHEMA = 'uain-fleet-verification-reasons-v1'
REASONS_DOMAIN = 'UAIN/fleet-verification-reasons/v1'
REASONS_MAX = 16
REASON_CODE = re.compile(r'[a-z][a-z0-9_]{0,63}(?::[A-Za-z0-9._/()-]{1,160}){0,3}')


def reasons_body(statement_digest, submission, findings):
    """The companion body for a fail: fixed-shape codes only, de-duplicated, at most REASONS_MAX."""
    codes = []
    for code in findings if type(findings) == list else []:
        if type(code) == str and len(code.encode()) <= 256 and REASON_CODE.fullmatch(code) and code not in codes:
            codes.append(code)
        if len(codes) == REASONS_MAX:
            break
    return dict(schema=REASONS_SCHEMA, domain=REASONS_DOMAIN, statementDigest=statement_digest, submission=submission,
                verdict='fail', reasons=codes)


def reasons_message(body):
    import fleet_attestation
    return (REASONS_DOMAIN + '\n' + fleet_attestation.js_canonical(body)).encode('utf-8')


def reasons_envelope(body, sign):
    signed = sign(reasons_message(body))
    require(type(signed) == dict and set(signed) == {'public_key', 'signature'} and type(signed['public_key']) == bytes
            and len(signed['public_key']) == 32 and type(signed['signature']) == bytes and len(signed['signature']) == 64,
            'invalid_signature')
    return dict(body=body, publicKey=base64.b64encode(signed['public_key']).decode(),
                signature=base64.b64encode(signed['signature']).decode())


class Stop(Exception):
    pass


def require(value, code):
    if not value:
        raise Stop(code)


def _protected(path, limit=1024 * 1024):
    path = Path(path)
    for parent in path.parents:
        info = parent.stat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'untrusted_parent')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022 and info.st_nlink == 1
                and 0 < info.st_size <= limit, 'untrusted_file')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            return stream.read(limit + 1)
    finally:
        os.close(fd)


def bootstrap_sources(directory=None):
    """Hash-check and preload every application module before any of them runs."""
    require(os.geteuid() == 0, 'root_required')
    sys.dont_write_bytecode = True
    directory = Path(__file__).absolute().parent if directory is None else Path(directory)
    approved = json.loads(_protected(SOURCE_MANIFEST))
    require(type(approved) == dict and set(approved) == {'schema', 'sha256'} and approved['schema'] == SOURCE_SCHEMA, 'source_manifest')
    pins = approved['sha256']
    require(type(pins) == dict and set(pins) == {n + '.py' for n in SOURCE_NAMES}, 'source_manifest')
    compiled = {}
    for name in SOURCE_NAMES:
        raw = _protected(directory / (name + '.py'))
        require(hashlib.sha256(raw).hexdigest() == pins[name + '.py'], 'source_hash')
        compiled[name] = compile(raw, str(directory / (name + '.py')), 'exec', dont_inherit=True)
    for name in SOURCE_NAMES[:-1]:
        module = types.ModuleType(name)
        module.__file__ = str(directory / (name + '.py'))
        sys.modules[name] = module
        exec(compiled[name], module.__dict__)


@contextlib.contextmanager
def locked():
    import fcntl
    fd = os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        require(info.st_uid == 0 and stat.S_ISREG(info.st_mode) and not info.st_mode & 0o022, 'untrusted_lock')
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def atomic(path, data):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.%d.tmp' % os.getpid())
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temp, path)


def b64(raw):
    return base64.urlsafe_b64encode(raw).decode().rstrip('=')


def provision(expected_vault_sha256):
    """Generate exactly one attestation key inside encrypted custody, with a backup proof."""
    import custody
    import native_migration as native
    from holder_release import current, read, write, canonical, backup_proof
    require(re.fullmatch('[a-f0-9]{64}', expected_vault_sha256 or ''), 'expected_vault_sha256')
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    with locked():
        vault_sha, kp, files = current(custody)
        require(vault_sha == expected_vault_sha256, 'vault_changed')
        if KEY not in files:
            backup = ROOT / ('before-' + vault_sha + '.kdbx')
            if not backup.exists():
                write(backup, read(custody.VAULT, 64 * 1024 * 1024))
            seed = bytearray(secrets.token_bytes(32))
            try:
                pub, _ = native.ed25519(bytes(seed))
                files[KEY] = canonical(dict(schema='uain-fleet-attestation-key-v1', public_key=b64(pub), private_key=b64(seed),
                                            created_at=int(time.time() * 1000)))
                with contextlib.redirect_stdout(io.StringIO()):
                    custody.save_vault(files)
            finally:
                for i in range(len(seed)):
                    seed[i] = 0
        vault_sha, kp, actual = current(custody)
        require(actual == files, 'vault_readback')
        key = json.loads(files[KEY])
        pub = base64.urlsafe_b64decode(key['public_key'] + '=')
        require(len(pub) == 32, 'invalid_key')
        identity = dict(schema='uain-fleet-attestation-identity-v1', public_key=base64.b64encode(pub).decode(),
                        vault_sha256=vault_sha, backup_receipt_sha256=backup_proof(custody, vault_sha))
        atomic(ROOT / 'identity.json', json.dumps(identity, sort_keys=True).encode())
        return identity


def signer():
    import custody
    import native_migration as native
    key = json.loads(custody.attachment(custody.vault(), KEY))
    seed = bytearray(base64.urlsafe_b64decode(key['private_key'] + '='))
    try:
        pub, sign = native.ed25519(bytes(seed))
        require(b64(pub) == key['public_key'], 'custody_key_mismatch')
    finally:
        for i in range(len(seed)):
            seed[i] = 0
    return lambda message: dict(public_key=pub, signature=sign(message))


STATUS_CHUNK = 10


def status(keys):
    """Proven native records, read in chunks of 10 keys: the custody CLI takes 64 keys, but its proved
    answer is bounded to 64 KiB and a task record is up to about 5 KiB (9 November 2026)."""
    records = {}
    for start in range(0, len(keys), STATUS_CHUNK):
        done = subprocess.run([PYTHON, '-I', str(CUSTODY_CLI), 'status', json.dumps(keys[start:start + STATUS_CHUNK])], capture_output=True, text=True, timeout=120)
        require(done.returncode == 0, 'status_unread')
        result = json.loads(done.stdout.strip().splitlines()[-1])
        require(result.get('status') == 'read' and type(result.get('records')) == dict, 'status_unread')
        records.update(result['records'])
    return records


def verifier_pins(path=None):
    """The root-owned hash pin of every verifier file; the set must be exactly VERIFIER_FILES."""
    try:
        pinned = json.loads(_protected(VERIFIER_PINS if path is None else path, 16384))
    except (OSError, ValueError):
        raise Stop('verifier_manifest') from None
    require(type(pinned) == dict and set(pinned) == {'schema', 'sha256'} and pinned['schema'] == VERIFIER_SCHEMA, 'verifier_manifest')
    pins = pinned['sha256']
    require(type(pins) == dict and set(pins) == set(VERIFIER_FILES)
            and all(type(v) == str and re.fullmatch(r'[0-9a-f]{64}', v) for v in pins.values()), 'verifier_manifest')
    return pins


@contextlib.contextmanager
def staged_verifier(release=None, pins=None, read=None, parent=None):
    """A root-private copy of the pinned verifier closure, removed afterwards. Each file is read
    once through the protected reader, checked against its pin, then written to the copy, so the
    bytes Node runs are exactly the pinned ones whatever the release directory does meanwhile."""
    import shutil
    import tempfile
    pins = verifier_pins() if pins is None else pins
    release = RELEASE_LINK.resolve() if release is None else Path(release)
    read = _protected if read is None else read
    parent = ROOT if parent is None else Path(parent)
    parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='verifier-', dir=str(parent)))
    try:
        for name in VERIFIER_FILES:
            try:
                raw = read(release / name)
            except OSError:
                raise Stop('verifier_source_unreadable') from None
            require(hashlib.sha256(raw).hexdigest() == pins[name], 'verifier_source_hash')
            target = stage / name
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                os.write(fd, raw)
            finally:
                os.close(fd)
        yield stage
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def verify(release, policy, assignment, artifact, version=1, native_evidence=None, network=None):
    """One run of the fixed verifier; returns its JSON result."""
    script = release / 'services/project-organizations/ops/verify-survey.mjs'
    inputs = dict(policy=policy, assignment=assignment, artifact=artifact)
    if version == 2:
        inputs.update(version=2, nativeEvidence=native_evidence, network=network)
    done = subprocess.run([NODE, str(script)], input=json.dumps(inputs),
                          capture_output=True, text=True, timeout=600, cwd=str(release),
                          env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': '/root'})
    require(done.returncode == 0, 'verifier_failed')
    return json.loads(done.stdout.strip().splitlines()[-1])


def survey_tasks():
    """Every starter survey, then the survey parts of the projects the order lists under `parts`
    (the reviewed root-pinned `<project>.parts.json` and the project agents' later
    `<project>.agent-r<N>.parts.json`; each part keeps its own root policy)."""
    order = json.loads(_protected(STARTER / 'order.json'))
    tasks = ['T-%s-1-prior-art-survey' % p for p in order['projects']]
    parts = order.get('parts', [])
    require(type(parts) == list and all(p in order['projects'] for p in parts), 'invalid_order')
    for p in parts:
        # The reviewed parts, then the revisions the project agents wrote (9 November 2026).
        names = os.listdir(STARTER)
        agent = sorted(n for n in names if re.fullmatch(r'%s\.agent-r[3-9]\.parts\.json' % p, n))
        # A v1 project whose full survey opened has no reviewed parts file, only agent revisions
        # (10 November 2026). A listed name that is not a protected file still refuses.
        reviewed = [p + '.parts.json'] if p + '.parts.json' in names else []
        for name in reviewed + agent:
            built = json.loads(_protected(STARTER / name))
            require(type(built) == dict and built.get('project') == p and type(built.get('parts')) == list, 'invalid_parts')
            for row in built['parts']:
                task = row['request']['payload']['id'] if type(row) == dict and type(row.get('request')) == dict and type(row['request'].get('payload')) == dict else None
                require(type(task) == str and SURVEY.fullmatch(task) and task.startswith('T-%s-1-prior-art-survey-r' % p), 'invalid_parts')
                tasks.append(task)
    return tasks


# Exact static reasons from fleet_attestation._evidence_artifact/strict_json.
# Project/criteria mismatches on a correctly filed policy hold native drift.
# These hold this submission; they neither attest failure nor authorize a verdict.
INPUT_HOLD_REASONS = frozenset((
    'invalid_native_records', 'task_not_under_review', 'policy_task_mismatch',
    'policy_criteria_mismatch', 'criteria_digest_mismatch', 'submission_not_under_review',
    'invalid_submission_author', 'invalid_evidence', 'evidence_digest_mismatch',
    'invalid_json', 'duplicate_key', 'non_canonical_value', 'evidence_structure_over_limit',
    'evidence_not_canonical_artifact', 'artifact_supplied_attestation_rejected',
    'artifact_binding_mismatch',
))


VERSION_SELECTION = Path('/etc/uain-custody/survey-attester-versions.json')
REVIEWER_PROFILE = Path('/etc/uain-custody/central-reviewer.json')
REVIEWER_SOURCES = Path('/etc/uain-custody/central-reviewer-sources.json')
REVIEWER_SOCKET = Path('/run/uain-central-reviewer/custody.sock')


def reviewer_admission(task):
    """Root-peer read-only metadata. Never constructs the signing/native engine."""
    import http.client
    import socket
    import struct
    import fleet_attestation as fa
    for parent in REVIEWER_SOCKET.parents:
        info = parent.lstat()
        fa.require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'untrusted_reviewer_socket')
    info = REVIEWER_SOCKET.lstat()
    fa.require(stat.S_ISSOCK(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o007, 'untrusted_reviewer_socket')
    class Connection(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.settimeout(5)
            self.sock.connect(str(REVIEWER_SOCKET))
            peer = struct.unpack('3i', self.sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            fa.require(peer[1] == 0, 'untrusted_reviewer_socket')
    connection = Connection('localhost', timeout=5)
    try:
        connection.request('POST', '/attestation-admission', body=json.dumps(dict(task=task)), headers={'Content-Type':'application/json'})
        response = connection.getresponse()
        raw = response.read(65537)
        fa.require(response.status == 200 and len(raw) <= 65536, 'reviewer_admission_unavailable')
        return fa.strict_json(raw)
    finally:
        connection.close()


def version_admission(task, policy):
    """Separate protected producer selection AND actually loaded reviewer admission."""
    import fleet_attestation as fa
    try:
        selected = fa.strict_json(_protected(VERSION_SELECTION, 16384))
    except FileNotFoundError:
        return dict(version=1, allowedVersions=[1])
    fa.require(type(selected) == dict and set(selected) == {'schema','tasks'}
               and selected['schema'] == 'uain-survey-attester-versions-v1' and type(selected['tasks']) == dict
               and len(selected['tasks']) <= 64, 'invalid_attester_versions')
    for tid, rule in selected['tasks'].items():
        fa.require(type(tid) == str and ID.fullmatch(tid) and type(rule) == dict
                   and set(rule) == {'version','policyDigest','criteriaDigest','reviewerSourcePinsDigest'}
                   and type(rule['version']) == int and rule['version'] in (1,2)
                   and all(type(rule[k]) == str and fa.HASH.fullmatch(rule[k]) for k in ('policyDigest','criteriaDigest','reviewerSourcePinsDigest')), 'invalid_attester_versions')
    rule = selected['tasks'].get(task)
    if rule is None:
        return dict(version=1, allowedVersions=[1])
    fa.require(rule['policyDigest'] == fa.js_digest(policy) and rule['criteriaDigest'] == policy['criteriaDigest'], 'attester_version_binding_mismatch')
    if rule['version'] == 1:
        return dict(version=1, allowedVersions=[1])
    fa.require(policy['class'] == 'prior_art_survey', 'attestation_v2_class_not_allowed')
    profile = fa.strict_json(_protected(REVIEWER_PROFILE))
    pins = fa.strict_json(_protected(REVIEWER_SOURCES, 16384))
    fa.require(type(profile) == dict and profile.get('schema') == 'uain-central-reviewer-server-v1'
               and type(profile.get('fleet_attestations')) == dict, 'invalid_reviewer_profile')
    import native_migration as native
    network = fa.validate_network(dict(chainId=native.CHAIN,genesisSha256=native.GENESIS))
    fa.require(profile.get('chain_id') == network['chainId'] and profile.get('genesis_sha256') == network['genesisSha256'], 'attestation_network_mismatch')
    admission = profile['fleet_attestations'].get(task)
    fa.require(type(admission) == dict and 2 in fa.validate_versions(admission.get('allowedVersions',[1]))
               and admission.get('policy_digest') == rule['policyDigest'] and admission.get('criteria_digest') == rule['criteriaDigest'], 'attestation_version_not_allowed')
    fa.require(fa.js_digest(pins) == rule['reviewerSourcePinsDigest'], 'reviewer_runtime_mismatch')
    loaded = reviewer_admission(task)
    expected = dict(schema='uain-fleet-attestation-admission-v1',taskId=task,policyDigest=rule['policyDigest'],criteriaDigest=rule['criteriaDigest'],
                    allowedVersions=list(fa.validate_versions(admission['allowedVersions'])),supportedVersions=[1,2],profileDigest=fa.js_digest(profile),sourcePinsDigest=fa.js_digest(pins),**network)
    fa.require(loaded == expected, 'reviewer_runtime_mismatch')
    return dict(version=2, **expected)


def run():
    require(os.geteuid() == 0, 'root_required')
    os.umask(0o077)
    import fleet_attestation as fa
    with staged_verifier() as release:
        return _run(fa, release)


def _run(fa, release):
    drivers = release / 'services/project-organizations/verifiers'
    tasks = [t for t in survey_tasks() if SURVEY.fullmatch(t)]
    records = status(['central_task/' + t for t in tasks])
    report = dict(schema='uain-survey-attester-run-v1', attested=[], skipped=[])
    for t in tasks:
        task = records.get('central_task/' + t)
        if type(task) != dict or task.get('state') != 'under_review' or not ID.fullmatch(task.get('pending') or ''):
            continue
        sid = task['pending']
        envelope_path = ENVELOPES / (hashlib.sha256(sid.encode()).hexdigest() + '.json')
        if envelope_path.exists():
            continue
        answer = status(['central_submission/' + sid])['central_submission/' + sid]
        task = status(['central_task/' + t])['central_task/' + t]
        policy_path = POLICIES / (t + '.json')
        # Policy/source faults remain fatal. Only known exact-native-input refusals
        # are isolated; never retrieve or construct a vault signer for those inputs.
        policy = fa.load_policy(policy_path)
        require(policy['taskId'] == t, 'policy_filename_mismatch')
        admitted = version_admission(t, policy)
        version = admitted['version']
        try:
            artifact = fa._evidence_artifact(policy, task, answer) if version == 1 else fa.evidence_artifact_v2(policy, task, answer)['artifact']
        except fa.Refused as refused:
            if refused.code not in INPUT_HOLD_REASONS:
                raise
            report['skipped'].append(dict(task=t, submission=sid, status='held', reason=refused.code))
            continue
        except (RecursionError, UnicodeEncodeError) as malformed:
            # The unchanged canonical gate can reject hostile nesting/surrogates
            # before it reaches a Refused code; still no retrieval or signer.
            reason = 'evidence_structure_over_limit' if isinstance(malformed, RecursionError) else 'non_canonical_value'
            report['skipped'].append(dict(task=t, submission=sid, status='held', reason=reason))
            continue
        assignment = dict(taskId=t, projectId=task['project'], submissionId=sid, author=answer['author'], criteriaDigest=task['acceptance_digest'])
        def selected_verify():
            if version == 1:
                return verify(release, policy, assignment, artifact)
            return verify(release, policy, assignment, artifact, version=2, native_evidence=answer['evidence'], network={k:admitted[k] for k in ('chainId','genesisSha256')})
        claim = selected_verify()
        if claim.get('verdict') not in ('pass', 'fail') or not claim.get('attestation'):
            report['skipped'].append(dict(task=t, submission=sid, verdict=claim.get('verdict'), findings=claim.get('findings', [])[:8]))
            continue

        # Custody's own run, before taking the custody lock (retrieval can take minutes):
        # the same pinned driver bytes, fresh retrieval. attest() refuses a verdict that differs.
        if version == 2:
            fa.require(version_admission(t, policy) == admitted, 'reviewer_runtime_mismatch')
        again = selected_verify()

        def rerun(driver, policy_copy, artifact_copy):
            require(hashlib.sha256(driver['source']).hexdigest() == driver['sha256'], 'driver_hash_mismatch')
            require(again.get('driverSha256') == driver['sha256'] and policy_copy == policy and artifact_copy == artifact, 'rerun_input_mismatch')
            return dict(verdict=again.get('verdict'), reproductionAttestationDigest=None)

        with locked():
            if envelope_path.exists():
                continue  # Preserve another completed run; never replace its signature.
            def custody_sign(message):
                # Instantiate vault-backed signer only after attest() has passed
                # every payload/policy/driver/rerun check and requests its signature.
                return signer()(message)
            if version == 2:
                fa.require(version_admission(t, policy) == admitted, 'reviewer_runtime_mismatch')
                envelope = fa.attest_v2(policy_path, claim['attestation'], claim['attestationDigest'], task, answer, rerun, custody_sign, 'production',
                                       driver_directory=drivers, allowed_versions=admitted['allowedVersions'],network={k:admitted[k] for k in ('chainId','genesisSha256')})
            else:
                envelope = fa.attest(policy_path, claim['attestation'], claim['attestationDigest'], task, answer, rerun, custody_sign, 'production',
                                     driver_directory=drivers)
            atomic(envelope_path, json.dumps(envelope, sort_keys=True, separators=(',', ':')).encode())
            if envelope['statement']['verdict'] == 'fail':
                # The reasons of custody's own rerun (again), whose verdict attest() just checked.
                # Best effort: the signed verdict above stands without it, and the reviewer then names
                # the rules the checker applies instead of the ones that failed.
                try:
                    body = reasons_body(envelope['statementDigest'], sid, again.get('findings'))
                    companion = reasons_envelope(body, custody_sign)
                    require(companion['publicKey'] == envelope['publicKey'], 'reasons_key_mismatch')
                    atomic(ENVELOPES / (hashlib.sha256(sid.encode()).hexdigest() + '.reasons.json'),
                           json.dumps(companion, sort_keys=True, separators=(',', ':')).encode())
                except Exception as error:
                    report['skipped'].append(dict(task=t, submission=sid, status='reasons_unsigned',
                                                  reason=getattr(error, 'code', None) or type(error).__name__))
        report['attested'].append(dict(task=t, submission=sid, verdict=envelope['statement']['verdict']))
    return report


if __name__ == '__main__':
    try:
        bootstrap_sources()
        if len(sys.argv) == 3 and sys.argv[1] == 'provision':
            result = provision(sys.argv[2])
        else:
            require(len(sys.argv) == 1, 'usage')
            result = run()
        print(json.dumps(result, separators=(',', ':')))
    except Stop as stop:
        print(json.dumps(dict(status='stopped', code=str(stop))), file=sys.stderr)
        sys.exit(1)

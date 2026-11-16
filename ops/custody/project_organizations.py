"""Fleet custody entrypoint for the 120 project organizations.

Separate from the exact-target pilot helpers (central_launch, central_fund_manager),
which stay unchanged. Authority comes only from a root-owned, source-pinned fleet
policy: exact selected project bindings, manager/evaluator keys, per-role operation
allowlists and reviewed amount/plan bounds. Model output and the runtime registry
cannot widen it; a change is an atomic compare-and-swap to revision + 1.

Every send is journaled before I/O with its signed envelope retained; later
invocations only reconcile that original envelope. A first send that the node's
CheckTx definitely refuses for exactly those bytes fails the intent at once, with the
node's answer as evidence, and frees the member lane; it is never resent or re-signed.
Guardian bootstrap operations
are reachable only through the fixed bootstrap caller, never from agent callers.
"""
import base64
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
import re
import resource
import stat
import sys
import tempfile
import time
import types
import urllib.request
from pathlib import Path

# The direct root CLI validates its complete local source closure before any
# application module executes. Deployment creates this protected manifest.
SOURCE_MANIFEST = Path('/etc/uain-custody/project-organizations-sources.json')
SOURCE_SCHEMA = 'uain-project-organization-sources-v1'
# custody is preloaded too: run() imports it, and -I keeps the script directory off sys.path.
SOURCE_NAMES = ('native_migration', 'guardian_quorum', 'native_admission', 'custody', 'project_organizations')
ROOT_UIDS = (0,)
SOURCE_LIMIT = 1024 * 1024


class Refused(ValueError):
    """A fail-closed refusal with a stable machine-readable code."""

    def __init__(self, code):
        super().__init__('Project organization custody refused: ' + code)
        self.code = code


def require(condition, code):
    if not condition:
        raise Refused(code)


def _trusted_directory(info, trusted_uids):
    return stat.S_ISDIR(info.st_mode) and info.st_uid in trusted_uids and not info.st_mode & 0o022


def _trusted_parents(directory, trusted_uids, boundary=None):
    """Every directory from `directory` up to '/' must be trusted. Production passes
    no boundary. Tests may name an ancestor at which the walk stops (that ancestor is
    still checked), so a checkout under a foreign-owned or world-writable parent such
    as /tmp can host fixtures without weakening any check below the boundary."""
    chain = (directory, *directory.parents)
    if boundary is not None:
        boundary = Path(boundary)
        require(boundary.is_absolute() and boundary.resolve() == boundary and boundary in chain, 'untrusted_boundary')
        chain = chain[:chain.index(boundary) + 1]
    for parent in chain:
        require(_trusted_directory(parent.stat(), trusted_uids), 'untrusted_parent')


def protected_read(path, trusted_uids=ROOT_UIDS, limit=SOURCE_LIMIT, boundary=None):
    """Read a regular, non-symlinked, single-link file whose every parent is owned by
    a trusted uid and not group/other writable. Production trusts only root and walks
    to '/'; tests inject their own uid and a fixture boundary instead of weakening
    any check."""
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


def _unique_pairs(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, 'duplicate_key')
        value[key] = item
    return value


def verify_sources(directory=None, manifest=None, trusted_uids=ROOT_UIDS, boundary=None):
    """Compile every pinned source after checking its hash; executes nothing."""
    directory = Path(__file__).absolute().parent if directory is None else Path(directory)
    manifest = SOURCE_MANIFEST if manifest is None else Path(manifest)
    approved = json.loads(protected_read(manifest, trusted_uids, boundary=boundary), object_pairs_hook=_unique_pairs)
    require(type(approved) == dict and set(approved) == {'schema', 'sha256'} and approved['schema'] == SOURCE_SCHEMA, 'source_manifest')
    pins = approved['sha256']
    require(type(pins) == dict and set(pins) == {name + '.py' for name in SOURCE_NAMES}, 'source_manifest')
    compiled = {}
    for name in SOURCE_NAMES:
        raw = protected_read(directory / (name + '.py'), trusted_uids, boundary=boundary)
        pin = pins[name + '.py']
        require(type(pin) == str and re.fullmatch('[a-f0-9]{64}', pin) and hashlib.sha256(raw).hexdigest() == pin, 'source_hash')
        compiled[name] = compile(raw, str(directory / (name + '.py')), 'exec', dont_inherit=True)
    return compiled


def bootstrap_sources(directory=None, manifest=None):
    require(os.geteuid() == 0, 'root_required')
    sys.dont_write_bytecode = True
    directory = Path(__file__).absolute().parent if directory is None else Path(directory)
    compiled = verify_sources(directory, manifest, ROOT_UIDS)
    # Preload dependencies in order; imports then resolve only reviewed modules.
    for name in SOURCE_NAMES[:-1]:
        module = types.ModuleType(name)
        module.__file__ = str(directory / (name + '.py'))
        sys.modules[name] = module
        exec(compiled[name], module.__dict__)


def disable_core():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


if __name__ == '__main__':
    require(sys.flags.isolated, 'isolated_interpreter_required')
    disable_core()
    bootstrap_sources()

import native_migration as native  # noqa: E402
import native_admission as admission  # noqa: E402

CHAIN = native.CHAIN
GUARDIAN = native.GUARDIAN
POLICY_SCHEMA = 'uain-project-organization-fleet-policy-v1'
SEND_SCHEMA = 'uain-project-organization-send-once-v1'
POLICY_PATH = Path('/etc/uain-custody/project-organization-fleet-policy.json')
SELECTION_PATH = Path('/etc/uain-custody/project-organization-selection.json')
# Recorded Main KPI wording decisions (optional); bound into the selection digest like Node.
AMENDMENTS_PATH = Path('/etc/uain-custody/project-organization-kpi-amendments.json')
ROOT = Path('/var/lib/uain-custody/project-organizations')
LOCK = Path('/run/lock/uain-custody.lock')
GUARDIAN_KEY = 'keys/uain-review-key.json'
# The licensed UAIN Independent Fund Manager (central_fund_manager.py provision) is the
# evaluator of starter organizations; its key keeps its own custody attachment.
FUND_MANAGER = 'uain1a62e7d2841e34473b98a5fb8395019d1ca02b15c'
FUND_MANAGER_KEY = 'keys/central-fund-manager.json'
LIFETIME_UNITS = 10 ** 15
MAX_PLAN_REVISION = 1000
EXPIRY_BLOCKS = 100

HASH = re.compile(r'^[a-f0-9]{64}$')
ADDRESS = re.compile(r'^uain1[a-f0-9]{40}$')
NATIVE_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$')
CATALOGUE_ID = re.compile(r'^OPP-[0-9]{5}$')
UUID = re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')
UNITS = re.compile(r'^[1-9][0-9]{0,15}$')
COMMAND_FIELDS = {'version', 'chain_id', 'member', 'sequence', 'expires_height', 'operation', 'payload'}

# Who native itself accepts as signer (chain/federation/central_fund.go,
# central_earning.go, participation.go). A fleet policy may only narrow these.
NATIVE_ROLE_OPERATIONS = {
    'guardian': ('open_project', 'central_project_start', 'central_fund_configure'),
    'manager': ('project_join', 'central_task_open', 'central_task_fund', 'central_fund_apply'),
    'evaluator': ('central_fund_plan', 'central_fund_plan_review', 'central_fund_decide', 'central_fund_close'),
    'solver': ('project_join', 'central_submit'),
}
AGENT_ROLES = ('manager', 'evaluator', 'solver')
PLAN_REVISION_OPS = ('central_fund_plan', 'central_fund_plan_review', 'central_fund_apply')
PROJECT_FIELDS = {'native_project', 'source_digest', 'paperclip_company', 'manager', 'evaluator', 'max_task_units', 'max_plan_revision'}
POLICY_FIELDS = {'schema', 'revision', 'selection_digest', 'projects', 'roles', 'solvers'}
PAYLOAD_FIELDS = {
    'open_project': {'id', 'title', 'class', 'prior_art'},
    'project_join': {'project'},
    'central_project_start': {'project', 'manager', 'evidence_digest'},
    'central_fund_configure': {'project', 'evaluator', 'expected_evaluator', 'evidence_digest'},
    'central_fund_plan': {'project', 'revision', 'main_kpi', 'stages', 'reason', 'evidence_digest'},
    'central_fund_plan_review': {'project', 'revision', 'verdict', 'evidence_digest'},
    'central_fund_apply': {'id', 'project', 'round', 'revision', 'evidence_digest'},
    'central_fund_decide': {'application', 'verdict', 'verification_digest', 'feedback', 'main_kpi_achieved'},
    'central_fund_close': {'project', 'evidence_digest'},
    'central_task_open': {'id', 'project', 'title', 'criteria', 'acceptance_digest', 'eligibility', 'eligibility_digest',
                          'solver_amount', 'reviewer_amount', 'evidence_digest'},
    'central_task_fund': {'task', 'evidence_digest'},
    'central_submit': {'id', 'task', 'evidence', 'evidence_digest'},
}


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def b64(raw):
    return base64.urlsafe_b64encode(raw).decode().rstrip('=')


def exact(value, fields):
    return type(value) == dict and set(value) == set(fields)


def integer(value):
    return type(value) == int  # bool is excluded by the exact type check


def text(value, low, high):
    return (type(value) == str and low <= len(value.encode()) <= high and len(value.strip()) >= low
            and not any(ord(c) < 32 and c not in '\n\t' for c in value))


def reviewed(value, low, high, multiline=False):
    """Already-trimmed reviewed text, so Go strings.TrimSpace measures the same bytes."""
    if type(value) != str or any(0xd800 <= ord(c) <= 0xdfff for c in value):
        return False
    allowed = '\n\t' if multiline else ''
    return (not any((ord(c) < 32 and c not in allowed) or ord(c) == 127 for c in value)
            and value == value.strip() and not value.startswith(('\ufeff', '\u180e')) and not value.endswith(('\ufeff', '\u180e'))
            and low <= len(value.encode()) <= high)


def open_project_payload(p):
    """chain/federation/keeper.go:453-478 and store.go:136-150, made stricter only."""
    require(reviewed(p['title'], 5, 250) and p['class'] in ('benevolent', 'neutral'), 'invalid_payload')
    art = p['prior_art']
    require(exact(art, {'basis', 'searches'}) and reviewed(art['basis'], 40, 4000, True), 'invalid_payload')
    searches = art['searches']
    require(type(searches) == list and 2 <= len(searches) <= 20 and len(set(map(str, searches))) == len(searches)
            and all(reviewed(q, 5, 1000) for q in searches), 'invalid_payload')


def units(value):
    require(type(value) == str and UNITS.fullmatch(value) and int(value) <= LIFETIME_UNITS, 'invalid_amount')
    return int(value)


def plan_key(native_project, revision):
    return 'central_fund_plan/%s/%020d' % (native_project, revision)


# ---------------------------------------------------------------- selection

def js_canonical(value):
    """Sorted-key JSON identical to services/project-organizations common.canonical."""
    if value is None or type(value) in (bool, str):
        out = json.dumps(value, ensure_ascii=False)
        try:
            out.encode('utf-8')  # a lone surrogate has no canonical UTF-8 form: refuse it
        except UnicodeEncodeError:
            raise Refused('non_canonical_value') from None
        return out
    if type(value) == int:
        require(abs(value) <= 9007199254740991, 'non_canonical_value')
        return str(value)
    if type(value) == list:
        return '[' + ','.join(js_canonical(v) for v in value) + ']'
    require(type(value) == dict and all(type(k) == str for k in value), 'non_canonical_value')
    names = {k: js_canonical(k) for k in value}  # refuses lone-surrogate keys before sorting
    # JavaScript Array.prototype.sort orders keys by UTF-16 code units, Python by code
    # points; they differ above U+FFFF (U+1F600 sorts before U+FFFD in JavaScript).
    keys = sorted(value, key=lambda k: k.encode('utf-16-be'))
    return '{' + ','.join(names[k] + ':' + js_canonical(value[k]) for k in keys) + '}'


def selection_of(manifest, amendments=None):
    """The frozen 120-project scope: digest plus catalogue id -> source digest. With
    recorded KPI amendments the digest binds them exactly as Node's selection does:
    digest({selection: digest(manifest), amendments}); without any, digest(manifest)."""
    require(type(manifest) == dict and manifest.get('schema') == 'uain-project-organization-selection-v1'
            and manifest.get('count') == 120 and type(manifest.get('projects')) == list
            and len(manifest['projects']) == 120, 'invalid_selection')
    projects = {}
    for row in manifest['projects']:
        require(type(row) == dict and CATALOGUE_ID.fullmatch(str(row.get('id'))) and row['id'] not in projects
                and type(row.get('sourceDigest')) == str and HASH.fullmatch(row['sourceDigest']), 'invalid_selection')
        projects[row['id']] = row['sourceDigest']
    digest = sha(js_canonical(manifest).encode())
    if amendments is not None:
        require(type(amendments) == dict and amendments.get('schema') == 'uain-project-organization-kpi-amendments-v1'
                and type(amendments.get('amendments')) == list and len(amendments['amendments']) <= 120
                and all(type(a) == dict and a.get('id') in projects for a in amendments['amendments']), 'invalid_kpi_amendments')
        if amendments['amendments']:
            digest = sha(js_canonical({'selection': digest, 'amendments': amendments}).encode())
    return dict(digest=digest, projects=projects)


# ------------------------------------------------------------------- policy

def validate_policy(policy, selection):
    require(exact(policy, POLICY_FIELDS) and policy['schema'] == POLICY_SCHEMA, 'invalid_policy')
    require(integer(policy['revision']) and policy['revision'] >= 1, 'invalid_policy')
    require(policy['selection_digest'] == selection['digest'], 'policy_selection_drift')
    projects = policy['projects']
    require(type(projects) == dict and projects, 'invalid_policy')
    managers, companies, evaluators = set(), set(), set()
    for project_id, row in projects.items():
        require(project_id in selection['projects'], 'project_not_selected')
        require(exact(row, PROJECT_FIELDS), 'invalid_policy')
        require(row['native_project'] == 'P-' + project_id, 'native_project_mismatch')
        require(row['source_digest'] == selection['projects'][project_id], 'source_mismatch')
        # A starter organization (decision D2, 6 November 2026) may run before its Paperclip
        # company exists (null), with the guardian as budget manager exactly as the live pilot
        # project does. A dedicated manager key stays one per project.
        company = row['paperclip_company']
        require(company is None or (type(company) == str and UUID.fullmatch(company)), 'invalid_policy')
        require(type(row['manager']) == str and ADDRESS.fullmatch(row['manager']), 'invalid_policy')
        require(type(row['evaluator']) == str and ADDRESS.fullmatch(row['evaluator']) and row['evaluator'] != GUARDIAN, 'invalid_policy')
        require(row['evaluator'] != row['manager'], 'evaluator_is_manager')
        require((row['manager'] == GUARDIAN or row['manager'] not in managers) and (company is None or company not in companies), 'duplicate_binding')
        managers.add(row['manager'])
        if company is not None:
            companies.add(company)
        evaluators.add(row['evaluator'])
        units(row['max_task_units'])
        require(integer(row['max_plan_revision']) and 1 <= row['max_plan_revision'] <= MAX_PLAN_REVISION, 'invalid_policy')
    require(not managers & evaluators, 'evaluator_is_manager')
    roles = policy['roles']
    require(exact(roles, NATIVE_ROLE_OPERATIONS), 'invalid_policy')
    for role, operations in roles.items():
        require(type(operations) == list and len(set(operations)) == len(operations), 'invalid_policy')
        require(all(op in NATIVE_ROLE_OPERATIONS[role] for op in operations), 'role_operation_not_native')
    solvers = policy['solvers']
    require(type(solvers) == list and len(set(solvers)) == len(solvers), 'invalid_policy')
    for solver in solvers:
        require(type(solver) == str and ADDRESS.fullmatch(solver) and solver != GUARDIAN
                and solver not in managers and solver not in evaluators, 'solver_overlaps_leadership')
    return policy


def load_policy(path, selection, trusted_uids=ROOT_UIDS, boundary=None):
    return validate_policy(native.strict_json(protected_read(path, trusted_uids, boundary=boundary)), selection)


def compare_and_swap(path, expected_revision, new_policy, selection, trusted_uids=ROOT_UIDS, boundary=None):
    """Atomically replace the policy only if it is still at expected_revision."""
    path = Path(path)
    require(integer(expected_revision) and expected_revision >= 0, 'invalid_revision')
    validate_policy(new_policy, selection)
    require(new_policy['revision'] == expected_revision + 1, 'policy_revision_conflict')
    require(path.is_absolute() and path.parent.resolve() == path.parent, 'untrusted_path')
    _trusted_parents(path.parent, trusted_uids, boundary)
    lock = os.open(path.with_name('.' + path.name + '.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if os.path.lexists(path):
            current = native.strict_json(protected_read(path, trusted_uids, boundary=boundary))
            require(type(current) == dict and current.get('schema') == POLICY_SCHEMA
                    and current.get('revision') == expected_revision and integer(expected_revision), 'policy_revision_conflict')
        else:
            require(expected_revision == 0, 'policy_revision_conflict')
        fd, pending = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
        try:
            with os.fdopen(fd, 'wb') as output:
                os.fchmod(output.fileno(), 0o644)
                output.write(native.canonical(new_policy).encode() + b'\n')
                output.flush()
                os.fsync(output.fileno())
            os.replace(pending, path)
            directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            Path(pending).unlink(missing_ok=True)
    finally:
        os.close(lock)
    return new_policy


# ---------------------------------------------------------------- authority

def central_payload(operation, p):
    """Typed payload check mirroring apps/baink/server/central-earning-command.mjs."""
    require(operation in PAYLOAD_FIELDS, 'operation_not_allowed')
    require(exact(p, PAYLOAD_FIELDS[operation]), 'invalid_payload')
    for key in ('id', 'project', 'task', 'application'):
        if key in p:
            require(type(p[key]) == str and NATIVE_ID.fullmatch(p[key]), 'invalid_payload')
    for key in ('manager', 'evaluator'):
        if key in p:
            require(type(p[key]) == str and ADDRESS.fullmatch(p[key]), 'invalid_payload')
    for key in ('evidence_digest', 'acceptance_digest', 'eligibility_digest', 'verification_digest'):
        if key in p:
            require(type(p[key]) == str and HASH.fullmatch(p[key]), 'invalid_payload')
    if 'round' in p:
        require(integer(p['round']) and 1 <= p['round'] <= 5, 'invalid_payload')
    if 'revision' in p:
        require(integer(p['revision']) and p['revision'] >= 1, 'invalid_payload')
    if operation == 'open_project':
        open_project_payload(p)
    if operation == 'central_fund_configure':
        require(p['expected_evaluator'] == '' or (type(p['expected_evaluator']) == str and ADDRESS.fullmatch(p['expected_evaluator'])), 'invalid_payload')
    if operation == 'central_fund_plan':
        require(text(p['main_kpi'], 20, 4096) and text(p['reason'], 10, 2048), 'invalid_payload')
        stages = p['stages']
        require(type(stages) == list and len(stages) == 5, 'invalid_payload')
        for n, row in enumerate(stages, 1):
            require(exact(row, {'round', 'criteria'}) and integer(row['round']) and row['round'] == n
                    and text(row['criteria'], 20, 4096), 'invalid_payload')
    if operation in ('central_fund_plan_review', 'central_fund_decide'):
        require(p['verdict'] in ('accept', 'reject'), 'invalid_payload')
    if operation == 'central_fund_decide':
        require(text(p['feedback'], 20, 4096) and type(p['main_kpi_achieved']) == bool, 'invalid_payload')
        # Main KPI achievement needs a validated achievement receipt; no verifier is qualified,
        # so it is held here whatever the caller (native accepts it only on a round-5 accept).
        require(p['main_kpi_achieved'] is False, 'fund_achievement_receipt_required')
    if operation == 'central_task_open':
        require(text(p['title'], 3, 240) and text(p['criteria'], 1, 4096) and sha(p['criteria'].encode()) == p['acceptance_digest']
                and p['eligibility'] in ('hard', 'new', 'unresolved'), 'invalid_payload')
        require(units(p['solver_amount']) + units(p['reviewer_amount']) <= LIFETIME_UNITS, 'invalid_amount')
    if operation == 'central_submit':
        require(text(p['evidence'], 1, 16384) and sha(p['evidence'].encode()) == p['evidence_digest'], 'invalid_payload')
    return p


def _agent_role(policy, bound, operation, member):
    candidates = [role for role in AGENT_ROLES if operation in policy['roles'][role]]
    require(candidates, 'operation_not_allowed')
    for role in candidates:
        if role == 'solver' and member in policy['solvers']:
            return role
        if role != 'solver' and bound[role] == member:
            return role
    raise Refused('signer_mismatch')


def authorize(policy, project_id, command, caller='agent'):
    """Return the policy role allowed to sign this exact command, or refuse.

    policy must already be validated; guardian operations require the fixed
    bootstrap caller, and that caller may sign nothing else."""
    require(caller in ('agent', 'bootstrap'), 'invalid_caller')
    require(exact(command, COMMAND_FIELDS) and integer(command['version']) and command['version'] == 1
            and command['chain_id'] == CHAIN, 'invalid_command')
    native.decimal(command['sequence'], 2 ** 64 - 2)
    require(1 <= native.decimal(command['expires_height'], 2 ** 63 - 1), 'invalid_command')
    require(project_id in policy['projects'], 'project_not_selected')
    bound = policy['projects'][project_id]
    operation, member = command['operation'], command['member']
    require(type(member) == str and ADDRESS.fullmatch(member), 'invalid_command')
    payload = central_payload(operation, command['payload'])
    if operation in NATIVE_ROLE_OPERATIONS['guardian']:
        require(caller == 'bootstrap', 'guardian_unreachable')
        require(operation in policy['roles']['guardian'], 'operation_not_allowed')
        require(member == GUARDIAN, 'signer_mismatch')
        role = 'guardian'
    else:
        require(caller == 'agent', 'bootstrap_is_guardian_only')
        role = _agent_role(policy, bound, operation, member)
    if 'project' in payload:
        require(payload['project'] == bound['native_project'], 'payload_project_mismatch')
    if operation == 'open_project':
        # Only the policy-bound P-<catalogue ID> of a selected project; never another ID.
        require(payload['id'] == bound['native_project'], 'payload_project_mismatch')
    if operation == 'central_project_start':
        require(payload['manager'] == bound['manager'], 'manager_mismatch')
    if operation == 'central_fund_configure':
        require(payload['evaluator'] == bound['evaluator'] and payload['expected_evaluator'] == '', 'evaluator_mismatch')
    if operation == 'central_task_open':
        require(units(payload['solver_amount']) + units(payload['reviewer_amount']) <= units(bound['max_task_units']), 'amount_above_bound')
    if operation in PLAN_REVISION_OPS:
        require(payload['revision'] <= bound['max_plan_revision'], 'plan_revision_above_bound')
    return role


# ------------------------------------------------------------- native state

def state_keys(policy, project_id, request):
    bound = policy['projects'][project_id]
    P, p, op = bound['native_project'], request['payload'], request['operation']
    keys = ['project/' + P, 'central_project_budget/' + P, 'central_fund_config/' + P, 'central_fund_state/' + P,
            'member/' + bound['manager'], 'member/' + bound['evaluator']]
    if op in ('central_task_fund', 'central_submit'):
        keys.append('central_task/' + p['task'])
    if op == 'central_fund_decide':
        keys.append('central_fund_application/' + p['application'])
    if op == 'project_join':
        keys.append(participation_key(P, request['member']))
    if op == 'central_fund_plan_review':
        keys.append(plan_key(P, p['revision']))
    return keys


def participation_key(native_project, member):
    return 'participation/%s/%s/' % (native_project, member)


def fresh(state, now):
    require(type(state) == dict and state.get('chain_id') == CHAIN and type(state.get('records')) == dict, 'invalid_native_proof')
    require(type(state.get('app_hash')) == str and HASH.fullmatch(state['app_hash']), 'invalid_native_proof')
    stamp = datetime.datetime.fromisoformat(state['header_time'].replace('Z', '+00:00'))
    require(stamp.tzinfo is not None and -60 <= now - stamp.timestamp() <= 120, 'stale_native_proof')
    height = native.decimal(state['height'], 2 ** 63 - 1)
    require(0 < height < 2 ** 63 - 1 - EXPIRY_BLOCKS, 'invalid_native_proof')
    native.decimal(state['event_count'])
    return height


def _active(record):
    return type(record) == dict and record.get('licence') == 'active'


def check_native(policy, project_id, role, command, state):
    """Authoritative prerequisites that native would also enforce; refusing here
    keeps a doomed command from consuming a signature or a signer-lane slot."""
    bound = policy['projects'][project_id]
    P, p, op, r = bound['native_project'], command['payload'], command['operation'], state['records']
    m = state['member']
    require(type(m) == dict and m.get('id') == command['member'], 'invalid_native_proof')
    require(m.get('licence') == 'active', 'member_licence_inactive')
    require(m.get('sequence') == command['sequence'], 'sequence_mismatch')
    if op == 'open_project':
        # Never signs over an existing project: an exact existing binding is reused by the
        # service without any command, anything else is held for reconciliation.
        require(r.get('project/' + P) is None, 'native_project_conflict')
        require(m.get('creator') is True, 'guardian_not_creator')
        return
    project = r.get('project/' + P)
    require(type(project) == dict and project.get('id') == P and project.get('state') == 'active'
            and project.get('safety_halted') is False, 'native_project_inactive')
    budget = r.get('central_project_budget/' + P)
    config = r.get('central_fund_config/' + P)
    fund = r.get('central_fund_state/' + P)
    if op == 'central_project_start':
        # Guardian/creator opened the project and stays lead; no lead transfer is inferred.
        require(project.get('lead') == GUARDIAN and budget is None, 'native_bootstrap_conflict')
        require(_active(r.get('member/' + bound['manager'])), 'manager_licence_inactive')
        return
    if op == 'project_join':
        require(r.get(participation_key(P, command['member'])) is None, 'already_joined')
        return
    require(type(budget) == dict and budget.get('project') == P and budget.get('closed', False) is False, 'native_budget_unavailable')
    require(budget.get('manager') == bound['manager'], 'native_manager_mismatch')
    if op == 'central_fund_configure':
        require(config is None and _active(r.get('member/' + bound['evaluator'])), 'native_bootstrap_conflict')
        return
    if role == 'evaluator':
        require(type(config) == dict and config.get('evaluator') == bound['evaluator'], 'native_evaluator_mismatch')
    if role == 'solver':
        require(command['member'] not in (bound['manager'], bound['evaluator']), 'solver_is_leadership')
    if op == 'central_task_open':
        require(budget.get('main_kpi_achieved', False) is False and type(fund) == dict and integer(fund.get('approved_revision'))
                and fund['approved_revision'] >= 1 and fund.get('pending') == '', 'plan_not_approved')
    elif op in ('central_task_fund', 'central_submit'):
        task = r.get('central_task/' + p['task'])
        require(type(task) == dict and task.get('project') == P, 'payload_project_mismatch')
    elif op == 'central_fund_plan':
        revision = fund.get('revision', 0) if type(fund) == dict else 0
        pending = fund.get('pending', '') if type(fund) == dict else ''
        require(revision + 1 == p['revision'] and pending == '', 'plan_revision_mismatch')
    elif op == 'central_fund_plan_review':
        plan = r.get(plan_key(P, p['revision']))
        require(type(fund) == dict and fund.get('revision') == p['revision'] and type(plan) == dict
                and plan.get('state') == 'proposed', 'plan_revision_mismatch')
        require(plan.get('manager') != command['member'], 'self_approval')
    elif op == 'central_fund_apply':
        require(type(fund) == dict and fund.get('approved_revision') == p['revision'] and fund.get('pending') == '', 'plan_revision_mismatch')
        require(fund.get('completed') == p['round'] - 1 and budget.get('round') == p['round'], 'milestone_round_mismatch')
    elif op == 'central_fund_decide':
        application = r.get('central_fund_application/' + p['application'])
        require(type(application) == dict and application.get('project') == P, 'payload_project_mismatch')
        require(type(fund) == dict and fund.get('pending') == p['application'] and application.get('state') == 'pending', 'application_not_pending')
        require(application.get('manager') != command['member'], 'self_approval')


def validate_request(request):
    require(exact(request, {'id', 'member', 'operation', 'payload'}), 'invalid_request')
    require(type(request['id']) == str and NATIVE_ID.fullmatch(request['id']), 'invalid_request')
    require(type(request['member']) == str and ADDRESS.fullmatch(request['member']), 'invalid_request')
    return request


def build_command(policy, project_id, request, state, now, caller='agent'):
    """Fresh-state command for an authorized request. Returns (command, role)."""
    validate_request(request)
    height = fresh(state, now)
    require(type(state.get('member')) == dict, 'invalid_native_proof')
    command = dict(version=1, chain_id=CHAIN, member=request['member'], sequence=state['member'].get('sequence'),
                   expires_height=str(height + EXPIRY_BLOCKS), operation=request['operation'], payload=request['payload'])
    require(type(command['sequence']) == str, 'invalid_native_proof')
    role = authorize(policy, project_id, command, caller)
    check_native(policy, project_id, role, command, state)
    return command, role


# ------------------------------------------------------------ journaled send

def verify_envelope(envelope, command, public_key):
    """Real Ed25519 check against the native member key, plus address binding."""
    pub = admission.public_key(public_key)
    require('uain1' + sha(pub)[:40] == command['member'], 'envelope_member_mismatch')
    admission.verify_envelope(dict(guardian_public_key=public_key), envelope, command)


def command_digest(command):
    return sha(native.signing_bytes(command))


def matches(event, command):
    return (type(event) == dict and event.get('member') == command['member'] and event.get('operation') == command['operation']
            and event.get('command_digest') == command_digest(command) and not event.get('instance') and not event.get('origin'))


def journal_path(root, project_id, intent_id):
    require(CATALOGUE_ID.fullmatch(project_id) and NATIVE_ID.fullmatch(intent_id), 'invalid_request')
    return Path(root) / project_id / (intent_id + '.json')


# CheckTx codes that say nothing definite about the sent bytes (Cosmos SDK types/errors:
# 19 already in the mempool cache, 20 mempool full, 39 I/O; `undefined` 111222 recovered
# panic). `undefined` code 1 is NOT here: the 0.3.9 daemon reports every federation refusal
# of the command that way, a definite CheckTx refusal. The same set as Node broadcast.mjs.
NOT_DEFINITE = frozenset({('sdk', 19), ('sdk', 20), ('sdk', 39), ('undefined', 111222)})
CODESPACE = re.compile(r'^[A-Za-z0-9_]{0,64}$')
MAX_LOG = 400
MAX_REPLY = 65536


def tx_bytes(envelope):
    """The exact bytes broadcast for an envelope: its canonical JSON, the form the journal
    retains, so the journaled envelope alone determines the transaction hash (a reloaded
    journal has sorted keys; native decodes either order, and signs only SigningBytes)."""
    raw = admission.canonical(envelope)
    require(len(raw) <= MAX_REPLY, 'envelope_too_large')
    return raw


def tx_hash(envelope):
    return sha(tx_bytes(envelope)).upper()


def bounded_log(log):
    """The node's CheckTx log as evidence only: bounded, control characters replaced."""
    return re.sub(r'[\x00-\x1f\x7f]', ' ', log)[:MAX_LOG] if type(log) == str else ''


def definite_refusal(reply, envelope):
    """Evidence of a definite CheckTx refusal of exactly these envelope bytes, else None.

    Only for the one first send process() ever makes: broadcast_tx_sync answers after
    CheckTx, and a refused transaction is neither kept in that node's mempool nor gossiped,
    so those exact bytes can never be included unless someone resends them, which this
    custody never does. A bare code (no hash, codespace or log), a reply naming other bytes,
    an unreadable codespace or a NOT_DEFINITE code is not definite: it stays unknown."""
    if type(reply) != dict or set(reply) != {'code', 'codespace', 'log', 'hash'}:
        return None
    code, codespace = reply['code'], reply['codespace']
    if not integer(code) or code <= 0 or type(codespace) != str or not CODESPACE.fullmatch(codespace):
        return None
    if (codespace, code) in NOT_DEFINITE or type(reply['hash']) != str or reply['hash'].upper() != tx_hash(envelope):
        return None
    c = envelope['command']
    return dict(definite=True, code=code, codespace=codespace, log=bounded_log(reply['log']), tx_hash=tx_hash(envelope),
                chain_id=c['chain_id'], operation=c['operation'], member=c['member'], sequence=c['sequence'],
                command_digest=command_digest(c))


def _failed(j):
    """True only for a journal whose single send was definitely refused for its own bytes."""
    f = j.get('failed')
    if type(f) != dict or set(f) != {'reason', 'rejection'} or j.get('receipt') is not None or j.get('noninclusion') is not None:
        return False
    r, e = f['rejection'], j['envelope']
    return (j.get('attempted') is True and type(r) == dict and r.get('definite') is True and integer(r.get('code')) and r['code'] > 0
            and j.get('broadcast_code') == r['code'] and f['reason'] == 'node_rejected:%d' % r['code']
            and r.get('tx_hash') == tx_hash(e) and r.get('command_digest') == command_digest(e['command'])
            and (r.get('codespace'), r['code']) not in NOT_DEFINITE)


def _open_lane(root, member, path, load):
    """One unsettled signed envelope per native member, across every project. A journal is
    settled by a finalized receipt, by proven expiry without inclusion, or by a definite
    first-send CheckTx refusal of its own bytes (which consumed no sequence)."""
    for other in sorted(Path(root).glob('OPP-*/*.json')):
        if other == path:
            continue
        j = load(other)
        if (type(j) == dict and j.get('schema') == SEND_SCHEMA and j['envelope']['command']['member'] == member
                and j.get('receipt') is None and j.get('noninclusion') is None and not _failed(j)):
            return True
    return False


def process(policy, project_id, request, runtime, load, write, signer, root=ROOT, caller='agent', now=time.time,
            verify=verify_envelope):
    """The caller holds the global custody lock and supplies protected persistence.
    The first invocation signs and journals before any broadcast; every later
    invocation only reconciles the retained envelope and never re-signs."""
    validate_request(request)
    # Before any state read: an unselected or unbound project is a stable refusal, not a KeyError.
    require(project_id in policy['projects'], 'project_not_selected')
    path = journal_path(root, project_id, request['id'])
    request_digest = sha(native.canonical(dict(project=project_id, request=request)).encode())
    member = request['member']
    j = load(path)
    if j is None:
        require(not _open_lane(root, member, path, load), 'signer_lane_busy')
        s = runtime.read(dict(member=member, keys=state_keys(policy, project_id, request)))
        c, role = build_command(policy, project_id, request, s, now(), caller)
        e = signer(c, role)
        verify(e, c, s['member']['public_key'])
        j = dict(schema=SEND_SCHEMA, project=project_id, role=role, policy_revision=policy['revision'],
                 request_digest=request_digest, public_key=s['member']['public_key'], envelope=e,
                 after_event=s['event_count'], cursor=s['event_count'], attempted=False)
        write(path, j)
    require(type(j) == dict and j.get('schema') == SEND_SCHEMA and j['project'] == project_id
            and j['request_digest'] == request_digest, 'journal_scope_mismatch')
    e = j['envelope']
    c = e['command']
    verify(e, c, j['public_key'])
    require(c['member'] == member and c['operation'] == request['operation'] and c['payload'] == request['payload'], 'journal_scope_mismatch')
    if j.get('receipt') is not None:
        return dict(status='finalized', receipt=j['receipt'], broadcasts_retried=False)
    if j.get('noninclusion') is not None:
        evidence = j['noninclusion']
        require(evidence['command_digest'] == command_digest(c) and evidence['through_event'] == j['cursor']
                and native.decimal(evidence['height']) > native.decimal(c['expires_height']), 'journal_scope_mismatch')
        return dict(status='expired_not_included', evidence=evidence, broadcasts_retried=False)
    if j.get('failed') is not None:
        # Settled by a definite refusal: no read, no resend, no re-sign. Further work is a
        # NEW intent, built from fresh native state (the refused bytes consumed no sequence).
        require(_failed(j), 'journal_scope_mismatch')
        return dict(status='failed', reason=j['failed']['reason'], rejection=j['failed']['rejection'], broadcasts_retried=False)
    if not j['attempted']:
        s = runtime.read(dict(member=member, keys=state_keys(policy, project_id, request)))
        if native.decimal(s['height']) < native.decimal(c['expires_height']) and s['member']['sequence'] == c['sequence']:
            # Re-authorize under the CURRENT policy and state; a narrowed policy holds the send.
            expected, _ = build_command(policy, project_id, request, s, now(), caller)
            require({k: v for k, v in c.items() if k != 'expires_height'} == {k: v for k, v in expected.items() if k != 'expires_height'},
                    'journal_scope_mismatch')
            j['attempted'] = True
            write(path, j)
            try:
                reply = runtime.broadcast(e)
            except Exception:
                reply = None  # transport error, JSON-RPC error ("tx already exists in cache"), timeout: unknown
            code = reply if integer(reply) else reply.get('code') if type(reply) == dict and integer(reply.get('code')) else None
            j['broadcast_code'] = code
            refusal = definite_refusal(reply, e)
            if refusal is not None:
                # First and only send of these bytes, refused by CheckTx: fail the intent now and
                # free the member lane, instead of holding it until native expiry. A crash before
                # this write leaves the intent unknown, settled later by scan or expiry.
                j['failed'] = dict(reason='node_rejected:%d' % code, rejection=refusal)
            write(path, j)
            if refusal is not None:
                return dict(status='failed', reason=j['failed']['reason'], rejection=refusal, broadcasts_retried=False)
        # Expired or superseded signed bytes stay intact and are only scanned.
    return _scan(j, path, c, e, member, runtime, write)


def _scan(j, path, c, e, member, runtime, write):
    s = runtime.read(dict(member=member, keys=[]))
    cursor, count = native.decimal(j['cursor']), native.decimal(s['event_count'])
    require(native.decimal(j['after_event']) <= cursor <= count, 'invalid_native_proof')
    end = min(count, cursor + 16)
    selected = [admission.event_key(n) for n in range(cursor + 1, end + 1)]
    if selected:
        s = runtime.read(dict(member=member, keys=selected))
        for key in selected:
            event = s['records'][key]
            require(type(event) == dict and admission.event_key(native.decimal(event['id'])) == key, 'invalid_native_proof')
            if event.get('command_digest') != command_digest(c):
                continue
            require(matches(event, c), 'proof_mismatch')
            proved = runtime.read(dict(member=member, keys=[], receipt=dict(envelope=e, event_id=event['id'])))
            receipt = proved['receipt']
            require(receipt['authority'] == 'native' and receipt['finalized'] is True and receipt['chain_id'] == CHAIN
                    and receipt['state_height'] == proved['height'] and receipt['app_hash'] == proved['app_hash']
                    and receipt['event'] == event and native.decimal(proved['member']['sequence']) > native.decimal(c['sequence']),
                    'proof_mismatch')
            j['receipt'] = receipt
            write(path, j)
            return dict(status='finalized', receipt=receipt, broadcasts_retried=False)
    events = [s['records'][key] for key in selected]
    step = native.canonical(dict(from_event=str(cursor + 1), through_event=str(end), height=s['height'], app_hash=s['app_hash'], events=events))
    j['scan_digest'] = sha((j.get('scan_digest', '0' * 64) + '\n' + step).encode())
    j['cursor'] = str(end)
    if end == native.decimal(s['event_count']) and native.decimal(s['height']) > native.decimal(c['expires_height']):
        j['noninclusion'] = dict(authority='native', chain_id=CHAIN, command_digest=command_digest(c), after_event=j['after_event'],
                                 through_event=str(end), height=s['height'], header_time=s['header_time'], app_hash=s['app_hash'],
                                 scan_digest=j['scan_digest'], attempted=j['attempted'])
        write(path, j)
        return dict(status='expired_not_included', evidence=j['noninclusion'], broadcasts_retried=False)
    write(path, j)
    return dict(status='pending', broadcasts_retried=False, broadcast_code=j.get('broadcast_code'))


# --------------------------------------------------------------- root CLI
# Not yet qualified against an isolated native daemon; nothing here is deployed.

class FleetRuntime(admission.Runtime):
    """admission.Runtime whose broadcast returns the node's whole CheckTx answer for exactly
    the sent bytes: {code, codespace, log, hash}. The same broadcast_tx_sync body, 64 KiB
    bounds and hash check as native_admission.Runtime.broadcast, over tx_bytes (canonical
    JSON of the journaled envelope); any transport or JSON-RPC error, or a reply for other
    bytes, raises (an unknown outcome)."""

    def broadcast(self, envelope):
        raw = tx_bytes(envelope)
        body = admission.canonical(dict(jsonrpc='2.0', id='uain-project-organizations', method='broadcast_tx_sync',
                                        params=dict(tx=base64.b64encode(raw).decode())))
        request = urllib.request.Request(self.p['rpc'], data=body, headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=min(10, self.remaining())) as response:
            answer = response.read(MAX_REPLY + 1)
        require(len(answer) <= MAX_REPLY, 'broadcast_outcome_unknown')
        value = native.strict_json(answer)
        require(type(value) == dict and 'error' not in value and type(value.get('result')) == dict, 'broadcast_outcome_unknown')
        r = value['result']
        require(integer(r.get('code')) and r['code'] >= 0 and type(r.get('hash')) == str and r['hash'].upper() == sha(raw).upper(),
                'broadcast_outcome_unknown')
        return dict(code=r['code'], codespace=r.get('codespace', ''), log=r.get('log', ''), hash=r['hash'].upper())


def key_attachment(role, member):
    if role == 'guardian' or member == GUARDIAN:
        return GUARDIAN_KEY
    if member == FUND_MANAGER:
        return FUND_MANAGER_KEY
    return 'keys/project-organizations/' + member + '.json'


def sign(custody, command, role):
    require(os.geteuid() == 0, 'root_required')
    key = native.strict_json(custody.attachment(custody.vault(), key_attachment(role, command['member'])))
    seed = bytearray(admission.public_key(key['private_key']))
    try:
        pub, signer = native.ed25519(bytes(seed))
        require(b64(pub) == key['public_key'] and 'uain1' + sha(pub)[:40] == command['member'], 'custody_key_mismatch')
        envelope = dict(command=command, public_key=b64(pub), signature=b64(signer(native.signing_bytes(command))))
        verify_envelope(envelope, command, b64(pub))
        return envelope
    finally:
        for n in range(len(seed)):
            seed[n] = 0


@contextlib.contextmanager
def locked():
    """The same global custody lock the pilot helpers hold."""
    require(os.geteuid() == 0, 'root_required')
    fd = os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        require(info.st_uid == 0 and stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and not info.st_mode & 0o022, 'untrusted_lock')
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def run(caller, project_id, intent_id):
    require(os.geteuid() == 0 and caller in ('agent', 'bootstrap'), 'root_required')
    disable_core()
    os.umask(0o077)
    import custody
    admission.ensure_directory(ROOT)
    admission.ensure_directory(ROOT / project_id)
    with locked():
        amendments = native.strict_json(protected_read(AMENDMENTS_PATH, ROOT_UIDS, 256 * 1024)) if AMENDMENTS_PATH.exists() else None
        selection = selection_of(native.strict_json(protected_read(SELECTION_PATH, ROOT_UIDS, 2 * 1024 * 1024)), amendments)
        policy = load_policy(POLICY_PATH, selection)
        request = admission.load(ROOT / project_id / (intent_id + '.request.json'))
        admission.TEMP = ROOT / 'proofs'
        admission.ensure_directory(admission.TEMP)
        runtime = FleetRuntime(admission.load(admission.POLICY))
        return process(policy, project_id, request, runtime, lambda path: admission.load(path) if path.exists() else None,
                       admission.atomic, lambda c, role: sign(custody, c, role), caller=caller)


def status(keys):
    """Read-only proven native records for the given store keys; signs and sends nothing."""
    require(os.geteuid() == 0, 'root_required')
    require(type(keys) == list and 1 <= len(keys) <= 64 and all(type(k) == str and re.fullmatch(r'[A-Za-z0-9._/-]{1,200}', k) for k in keys), 'invalid_keys')
    disable_core()
    os.umask(0o077)
    admission.TEMP = ROOT / 'proofs'
    admission.ensure_directory(ROOT)
    admission.ensure_directory(admission.TEMP)
    runtime = FleetRuntime(admission.load(admission.POLICY))
    state = runtime.read(dict(member=GUARDIAN, keys=keys))
    fresh(state, time.time())
    # event_count (9 November 2026): the project agents follow the proven event log from it.
    return dict(status='read', height=state['height'], app_hash=state['app_hash'], event_count=state.get('event_count'),
                records={k: state['records'].get(k) for k in keys})


if __name__ == '__main__':
    try:
        require(len(sys.argv) == 3 and sys.argv[1] == 'status' or len(sys.argv) == 4 and sys.argv[1] in ('sign', 'bootstrap'), 'usage')
        result = status(json.loads(sys.argv[2])) if sys.argv[1] == 'status' else run('agent' if sys.argv[1] == 'sign' else 'bootstrap', sys.argv[2], sys.argv[3])
        print(json.dumps(result, separators=(',', ':')))
    except Exception as error:
        print(json.dumps(dict(status='refused', error_type=type(error).__name__, code=getattr(error, 'code', None))), file=sys.stderr)
        sys.exit(1)

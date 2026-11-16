"""Open the next tasks of starter organizations after their survey, within the step's funds.

Root-only, run by uain-manager-stage.timer (Rahul, 6 November 2026). Each run:
  1. signs, one at a time, the requests of every batch the manager stage already wrote
     (/var/lib/uain-custody/manager-stage/batches/<OPP>/*.json): it writes the fleet custody
     request file (/var/lib/uain-custody/project-organizations/<OPP>/<task id>.request.json,
     exactly the batch request, written once) and runs `project_organizations.py sign`, which
     journals before sending, re-authorizes under the current fleet policy, checks native state
     and never re-signs. It stops at the first request that is not settled;
  2. only when every batch is settled, runs the manager stage
     (services/project-organizations/ops/manager-stage.mjs propose, as root; it runs each model
     execution as the fence user) for the configured projects. It reads proven native state and
     writes a new batch only for a project whose survey is accepted, that has no open task, whose
     current step is unlocked natively and that has allowance left;
  3. signs the new batches the same way.

Reviewed candidate tasks (Rahul, 7 November 2026): when the optional root-owned
/etc/uain-custody/manager-stage/candidates.json exists (0600, under the 0700 config directory,
schema uain-manager-candidates-v1), it is read with the same checks as config.json plus a
private-mode check, validated strictly here, and passed to the manager stage, which validates it
again and shows each project only its own candidates. They are suggestions to the manager run;
every task it proposes still gets the trusted search, the independent assessment and pricing.
Absent, the stage runs exactly as before. `manager_stage.py check` runs the stage's dry check
(no model call, no write) with the same config and candidates and prints the candidate counts.

A request is settled by a finalized receipt, a definite CheckTx refusal (`failed`), proven
expiry without inclusion, or a custody refusal before any journal exists whose code is in
PERMANENT (nothing was signed). A settled request is never retried: further work is a new
proposal from fresh native state. It signs nothing itself and holds no key.

Later funding rounds (10 November 2026): the manager stage also writes one-request fund batches
(/var/lib/uain-custody/manager-stage/fund-batches/<OPP>/*.json, schema uain-fund-round-batch-v1):
a `central_fund_apply` by the project manager with the public evidence bundle it names, or a
`central_fund_decide` by the Fund Manager with the full decision record. Before writing the
custody request file this driver recomputes, in Python, the digest of that bundle or record (the
JavaScript canonical form, fixtures/contracts/fund-round.json) and refuses a batch whose request
does not match it exactly, whose decision attests the Main KPI outside an accepted sub-KPI 5, or
whose agent decision was not an actual Sonnet execution. Fund batches are signed after the task
batches of the same project, in file order, under the same settle rules.
"""
import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import time
from pathlib import Path

class Stop(Exception):
    pass


def require(value, code):
    if not value:
        raise Stop(code)


# This driver imports only Python standard-library modules. Its complete local
# in-process closure is itself. The separately launched project_organizations.py
# validates its own source manifest; the Node stage remains the separately
# qualified organizations release, not an implicit addition to this manifest.
SOURCE_MANIFEST = Path('/etc/uain-custody/manager-stage-sources.json')
SOURCE_SCHEMA = 'uain-manager-stage-sources-v1'


def _source_read(path, trusted_uids, boundary=None, private=False):
    path = Path(path)
    require(path.is_absolute() and path.resolve() == path, 'untrusted_source_path')
    parents = (path.parent, *path.parent.parents)
    if boundary is not None:
        boundary = Path(boundary)
        require(boundary.is_absolute() and boundary.resolve() == boundary and boundary in parents, 'untrusted_boundary')
        parents = parents[:parents.index(boundary) + 1]
    for parent in parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid in trusted_uids and not info.st_mode & 0o022,
                'untrusted_source_parent')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid in trusted_uids and info.st_nlink == 1
                and not info.st_mode & (0o077 if private else 0o022)
                and 0 < info.st_size <= 1024 * 1024, 'untrusted_source_file')
        raw = os.read(fd, 1024 * 1024 + 1)
        after = os.fstat(fd)
        identity = lambda x: (x.st_dev, x.st_ino, x.st_size, x.st_mtime_ns, x.st_ctime_ns)
        require(len(raw) == info.st_size and identity(info) == identity(after), 'source_changed_during_read')
        return raw
    finally:
        os.close(fd)


def verify_sources(directory=None, manifest=None, trusted_uids=(0,), boundary=None):
    """Check protected source bytes and compile them; execute no application code.

    No local import/pyc loader is used. Test fixture uid/boundary injection is
    available only through imports, never through the production CLI/environment.
    """
    directory = Path(__file__).absolute().parent if directory is None else Path(directory)
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'duplicate_key')
            result[key] = value
        return result
    approved = json.loads(_source_read(SOURCE_MANIFEST if manifest is None else manifest,
                                      trusted_uids, boundary, private=True), object_pairs_hook=unique)
    require(type(approved) == dict and set(approved) == {'schema', 'sha256'}
            and approved['schema'] == SOURCE_SCHEMA, 'source_manifest')
    pins = approved['sha256']
    require(type(pins) == dict and set(pins) == {'manager_stage.py'}, 'source_manifest')
    pin = pins['manager_stage.py']
    raw = _source_read(directory / 'manager_stage.py', trusted_uids, boundary)
    require(type(pin) == str and re.fullmatch('[a-f0-9]{64}', pin)
            and hashlib.sha256(raw).hexdigest() == pin, 'source_hash')
    return compile(raw, str(directory / 'manager_stage.py'), 'exec', dont_inherit=True)


if __name__ == '__main__':
    try:
        require(sys.flags.isolated, 'isolated_interpreter_required')
        require(os.geteuid() == 0, 'root_required')
        sys.dont_write_bytecode = True
        verify_sources()
    except (Stop, OSError, ValueError, SyntaxError):
        print(json.dumps(dict(status='stopped', code='source_bootstrap_refused' if sys.flags.isolated
                             else 'isolated_interpreter_required')), file=sys.stderr)
        sys.exit(1)


CONFIG = Path('/etc/uain-custody/manager-stage/config.json')
CANDIDATES = Path('/etc/uain-custody/manager-stage/candidates.json')
STAGE_ROOT = Path('/var/lib/uain-custody/manager-stage')
FLEET_ROOT = Path('/var/lib/uain-custody/project-organizations')
CUSTODY_CLI = Path('/opt/uain-custody/project_organizations.py')
PYTHON = '/opt/uain-custody/venv/bin/python'
NODE = '/opt/uain-review-runtime/node-v22.22.0-linux-x64/bin/node'
RELEASE_LINK = Path('/opt/uain-organizations/current')
SCRIPT = 'services/project-organizations/ops/manager-stage.mjs'
CONFIG_SCHEMA = 'uain-manager-stage-config-v1'
BATCH_SCHEMA = 'uain-manager-stage-batch-v1'
SUMMARY_SCHEMA = 'uain-manager-stage-summary-v1'
CANDIDATES_SCHEMA = 'uain-manager-candidates-v1'
CANDIDATES_LIMIT = 512 * 1024
CANDIDATE_ID = re.compile(r'^opp-[0-9]{5}-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$')
DAY = re.compile(r'^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
HEX64 = re.compile(r'^[a-f0-9]{64}$')
UNITS = re.compile(r'^[1-9][0-9]{0,15}$')
CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')
RATIONALE_PARTS = ('effort', 'difficulty', 'novelty', 'verificationCost')
CANDIDATE_KEYS = {'id', 'title', 'criteria', 'eligibility', 'eligibility_basis', 'proposed_price'}
ROUND1_CEILING_UNITS = 10000 * 1000000
MAX_CANDIDATES = 8
CATALOGUE_ID = re.compile(r'^OPP-[0-9]{5}$')
TASK_ID = re.compile(r'^T-(OPP-[0-9]{5})-([1-5])-[a-f0-9]{16}$')
ADDRESS = re.compile(r'^uain1[a-f0-9]{40}$')
PAYLOAD_FIELDS = {'id', 'project', 'title', 'criteria', 'acceptance_digest', 'eligibility', 'eligibility_digest',
                  'solver_amount', 'reviewer_amount', 'evidence_digest'}
# Custody refusals raised before any journal is written that no later run can change for the
# same request bytes. Anything else (a busy signer lane, a stale proof, an unreadable state) is
# transient: the run stops and the next one retries the same request.
PERMANENT = frozenset({
    'amount_above_bound', 'plan_not_approved', 'native_budget_unavailable', 'native_manager_mismatch', 'native_project_inactive',
    'payload_project_mismatch', 'project_not_selected', 'operation_not_allowed', 'signer_mismatch', 'invalid_payload',
    'invalid_amount', 'invalid_request', 'member_licence_inactive', 'bootstrap_is_guardian_only',
    # Fund requests (10 November 2026): native state moved on, so these exact bytes can never land;
    # the next stage run derives a fresh request from the new state.
    'plan_revision_mismatch', 'milestone_round_mismatch', 'application_not_pending', 'self_approval',
    'native_evaluator_mismatch', 'plan_revision_above_bound',
})
FUND_BATCH_SCHEMA = 'uain-fund-round-batch-v1'
EVIDENCE_SCHEMA = 'uain-fund-round-evidence-v1'
DECISION_SCHEMA = 'uain-fund-round-decision-v1'
FUND_DECIDER_MODEL = 'claude-sonnet-5-5'
APPLICATION_ID = re.compile(r'^F-(OPP-[0-9]{5})-([1-5])-([a-f0-9]{16})$')
FUND_INTENT = re.compile(r'^(D-)?(F-OPP-[0-9]{5}-[1-5]-[a-f0-9]{16})-a([1-3])$')
LIMIT = 4 * 1024 * 1024
# A just-broadcast request reports `pending` until its event is final; reconcile in this run.
POLLS = 12
POLL_SECONDS = 5
PROPOSE_TIMEOUT = 5400
# Tests point these at a fixture tree owned by the test user.
TRUSTED_UIDS = (0,)
BOUNDARY = None
REQUIRE_ROOT = True


def strict_pairs(pairs):
    keys = [k for k, _ in pairs]
    require(len(keys) == len(set(keys)), 'duplicate_key')
    return dict(pairs)


def refuse_constant(name):
    raise Stop('invalid_json')


def protected(path, limit=LIMIT, private=False):
    """A regular single-link file owned by a trusted uid, under trusted parents nobody else can write.
    `private`: also no group or other access to the file or its directory (0600 under 0700), and
    strict JSON (no duplicate keys, no NaN or Infinity)."""
    path = Path(path)
    if private:
        info = path.parent.stat()
        require(not info.st_mode & 0o077, 'untrusted_parent')
    for parent in path.parents:
        info = parent.stat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid in TRUSTED_UIDS and not info.st_mode & 0o022, 'untrusted_parent')
        if BOUNDARY is not None and parent == Path(BOUNDARY):
            break
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        raise Stop('untrusted_file')
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid in TRUSTED_UIDS and not info.st_mode & 0o022 and info.st_nlink == 1
                and 0 < info.st_size <= limit, 'untrusted_file')
        require(not private or not info.st_mode & 0o077, 'untrusted_file')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read(limit + 1)
        if not private:
            return json.loads(data)
        try:
            return json.loads(data.decode('utf-8'), object_pairs_hook=strict_pairs, parse_constant=refuse_constant)
        except (UnicodeDecodeError, ValueError):
            raise Stop('invalid_json')
    finally:
        os.close(fd)


def load_config():
    require(CONFIG.exists(), 'not_configured')
    c = protected(CONFIG)
    require(type(c) == dict and set(c) == {'schema', 'projects', 'max_projects_per_run', 'cooldown_minutes', 'max_executions_per_day'} | ({'max_tasks_per_project_run'} if 'max_tasks_per_project_run' in c else set())
            and c['schema'] == CONFIG_SCHEMA, 'invalid_config')
    require(type(c['projects']) == list and 1 <= len(c['projects']) <= 120 and len(set(c['projects'])) == len(c['projects'])
            and all(type(p) == str and CATALOGUE_ID.fullmatch(p) for p in c['projects']), 'invalid_config')
    require(type(c['max_projects_per_run']) == int and 1 <= c['max_projects_per_run'] <= 10, 'invalid_config')
    require(type(c['cooldown_minutes']) == int and 10 <= c['cooldown_minutes'] <= 10080, 'invalid_config')
    require(type(c['max_executions_per_day']) == int and 10 <= c['max_executions_per_day'] <= 500, 'invalid_config')
    require('max_tasks_per_project_run' not in c or type(c['max_tasks_per_project_run']) == int and 1 <= c['max_tasks_per_project_run'] <= 8, 'invalid_config')
    return c


def planning_bound(config):
    return 2 + config.get('max_tasks_per_project_run', 8)


def text(value, low, high):
    return (type(value) == str and len(value.strip()) >= low and len(value.encode('utf-8')) <= high
            and not CONTROL.search(value))


def amount(value):
    require(type(value) == str and UNITS.fullmatch(value) and int(value) <= 10 ** 15, 'invalid_candidates')
    return int(value)


def validate_candidates(c):
    """Structural mirror of services/project-organizations/src/candidates.mjs validateCandidates; the
    manager stage validates again, with the selection and the manager-output screen."""
    require(type(c) == dict and set(c) == {'schema', 'reviewed', 'projects'} and c['schema'] == CANDIDATES_SCHEMA, 'invalid_candidates')
    r = c['reviewed']
    require(type(r) == dict and set(r) == {'by', 'at', 'source', 'sourceDigest'} and text(r['by'], 3, 200)
            and type(r['at']) == str and DAY.fullmatch(r['at']) and text(r['source'], 1, 300)
            and type(r['sourceDigest']) == str and HEX64.fullmatch(r['sourceDigest']), 'invalid_candidates')
    projects = c['projects']
    require(type(projects) == dict and 1 <= len(projects) <= 120 and all(CATALOGUE_ID.fullmatch(p) for p in projects), 'invalid_candidates')
    seen = set()
    for project, items in projects.items():
        require(type(items) == list and 1 <= len(items) <= MAX_CANDIDATES, 'invalid_candidates')
        for t in items:
            require(type(t) == dict and set(t) == CANDIDATE_KEYS, 'invalid_candidates')
            require(type(t['id']) == str and CANDIDATE_ID.fullmatch(t['id']) and t['id'].startswith(project.lower() + '-')
                    and t['id'] not in seen, 'invalid_candidates')
            seen.add(t['id'])
            require(text(t['title'], 3, 240) and text(t['criteria'], 20, 4096) and t['eligibility'] in ('hard', 'new', 'unresolved')
                    and text(t['eligibility_basis'], 20, 2048), 'invalid_candidates')
            q = t['proposed_price']
            require(type(q) == dict and set(q) == {'solver_amount', 'reviewer_amount', 'rationale'}, 'invalid_candidates')
            require(amount(q['solver_amount']) + amount(q['reviewer_amount']) <= ROUND1_CEILING_UNITS, 'invalid_candidates')
            require(type(q['rationale']) == dict and set(q['rationale']) == set(RATIONALE_PARTS)
                    and all(text(q['rationale'][k], 10, 2000) for k in RATIONALE_PARTS), 'invalid_candidates')
    return c


def load_candidates():
    """None when no candidates file is installed (the stage then runs exactly as before)."""
    if not os.path.lexists(CANDIDATES):
        return None
    return validate_candidates(protected(CANDIDATES, limit=CANDIDATES_LIMIT, private=True))


def batch_files(project):
    directory = STAGE_ROOT / 'batches' / project
    if not directory.exists():
        return []
    return sorted(p for p in directory.iterdir() if p.name.endswith('.json') and not p.name.endswith('.refused.json'))


def load_batch(path, project):
    b = protected(path)
    require(type(b) == dict and b.get('schema') == BATCH_SCHEMA and b.get('project') == project, 'invalid_batch')
    requests = b.get('requests')
    require(type(requests) == list and 1 <= len(requests) <= 8 and len({r.get('id') for r in requests if type(r) == dict}) == len(requests),
            'invalid_batch')
    for r in requests:
        require(type(r) == dict and set(r) == {'id', 'member', 'operation', 'payload'} and r['operation'] == 'central_task_open', 'invalid_batch')
        m = TASK_ID.fullmatch(r['id']) if type(r['id']) == str else None
        require(m and m.group(1) == project and m.group(2) == str(b.get('round')), 'invalid_batch')
        require(type(r['member']) == str and ADDRESS.fullmatch(r['member']), 'invalid_batch')
        p = r['payload']
        require(type(p) == dict and set(p) == PAYLOAD_FIELDS and p['id'] == r['id'] and p['project'] == 'P-' + project, 'invalid_batch')
    return b


def js_canonical(value):
    """Sorted-key JSON identical to services/project-organizations src/common.mjs canonical()."""
    if value is None or type(value) in (bool, str):
        out = json.dumps(value, ensure_ascii=False)
        try:
            out.encode('utf-8')
        except UnicodeEncodeError:
            raise Stop('non_canonical_value') from None
        return out
    if type(value) == int:
        require(abs(value) <= 9007199254740991, 'non_canonical_value')
        return str(value)
    if type(value) == list:
        return '[' + ','.join(js_canonical(v) for v in value) + ']'
    require(type(value) == dict and all(type(k) == str for k in value), 'non_canonical_value')
    names = {k: js_canonical(k) for k in value}
    # JavaScript sorts keys by UTF-16 code units.
    return '{' + ','.join(names[k] + ':' + js_canonical(value[k]) for k in sorted(value, key=lambda k: k.encode('utf-16-be'))) + '}'


def js_digest(value):
    return hashlib.sha256(js_canonical(value).encode('utf-8')).hexdigest()


def fund_batch_files(project):
    directory = STAGE_ROOT / 'fund-batches' / project
    if not directory.exists():
        return []
    return sorted(p for p in directory.iterdir() if p.name.endswith('.json') and not p.name.endswith('.refused.json'))


def load_fund_batch(path, project):
    """One fund request whose payload is exactly what its evidence bundle or decision record supports."""
    b = protected(path)
    require(type(b) == dict and b.get('schema') == FUND_BATCH_SCHEMA and b.get('project') == project and b.get('kind') in ('apply', 'decide'), 'invalid_fund_batch')
    apply = b['kind'] == 'apply'
    require(set(b) == {'schema', 'project', 'kind', 'attempt', 'createdAt', 'request', 'evidence' if apply else 'decision'}, 'invalid_fund_batch')
    r = b['request']
    require(type(r) == dict and set(r) == {'id', 'member', 'operation', 'payload'} and type(r['member']) == str and ADDRESS.fullmatch(r['member'])
            and type(r['payload']) == dict, 'invalid_fund_batch')
    m = FUND_INTENT.fullmatch(r['id']) if type(r['id']) == str else None
    require(m and (m.group(1) == 'D-') == (not apply) and type(b['attempt']) == int and int(m.group(3)) == b['attempt'], 'invalid_fund_batch')
    application = m.group(2)
    a = APPLICATION_ID.fullmatch(application)
    require(a.group(1) == project, 'invalid_fund_batch')
    round_ = int(a.group(2))
    p = r['payload']
    if apply:
        e = b['evidence']
        require(r['operation'] == 'central_fund_apply' and set(p) == {'id', 'project', 'round', 'revision', 'evidence_digest'}, 'invalid_fund_batch')
        require(type(e) == dict and e.get('schema') == EVIDENCE_SCHEMA and e.get('project') == project and e.get('nativeProject') == 'P-' + project
                and type(e.get('tasks')) == list and 1 <= len(e['tasks']) <= 64 and e.get('round') == round_, 'invalid_fund_batch')
        digest = js_digest(e)
        require(p['evidence_digest'] == digest and p['id'] == application and application == 'F-%s-%d-%s' % (project, round_, digest[:16])
                and p['round'] == round_ and type(p['revision']) == int and p['revision'] == e.get('planRevision') and p['project'] == 'P-' + project,
                'fund_evidence_mismatch')
        return b
    d = b['decision']
    require(r['operation'] == 'central_fund_decide' and set(p) == {'application', 'verdict', 'verification_digest', 'feedback', 'main_kpi_achieved'}, 'invalid_fund_batch')
    require(type(d) == dict and d.get('schema') == DECISION_SCHEMA and d.get('project') == project and d.get('nativeProject') == 'P-' + project
            and d.get('application') == application == p['application'] and d.get('round') == round_, 'invalid_fund_batch')
    require(p['verification_digest'] == js_digest(d) and d.get('verdict') in ('accept', 'reject') and p['verdict'] == d['verdict']
            and p['feedback'] == d.get('feedback') and text(p['feedback'], 20, 4096) and type(p['main_kpi_achieved']) == bool
            and p['main_kpi_achieved'] is d.get('mainKpiAchieved') and p['main_kpi_achieved'] == (round_ == 5 and p['verdict'] == 'accept'),
            'fund_decision_mismatch')
    execution = d.get('execution')
    if d.get('basis') == 'fund_manager_agent':
        require(type(execution) == dict and execution.get('model') == FUND_DECIDER_MODEL and execution.get('actual') is True, 'fund_decision_not_actual')
    else:
        require(d.get('basis') == 'evidence_not_found' and execution is None and p['verdict'] == 'reject', 'fund_decision_mismatch')
    # A model verdict alone never sets main_kpi_achieved (the round-5 accept). It needs a
    # validated achievement receipt; no achievement verifier is qualified and the decision
    # record has no receipt field, so every round-5 accept is held. Rounds 1-4 are unchanged.
    require(not (round_ == 5 and p['verdict'] == 'accept'), 'fund_achievement_receipt_required')
    return b


def refusals_path(batch_path):
    return batch_path.with_name(batch_path.name[:-len('.json')] + '.refused.json')


def load_refusals(batch_path):
    path = refusals_path(batch_path)
    return protected(path) if path.exists() else {}


def record_refusal(batch_path, request_id, code):
    refusals = dict(load_refusals(batch_path))
    refusals[request_id] = code
    atomic(refusals_path(batch_path), json.dumps(refusals, sort_keys=True, separators=(',', ':')).encode())


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


def journal(project, intent):
    path = FLEET_ROOT / project / (intent + '.json')
    return json.loads(path.read_text()) if path.exists() else None


def state(project, request_id, refusals):
    """finalized | failed | expired | refused (settled), or open."""
    j = journal(project, request_id)
    if type(j) == dict:
        if j.get('receipt') is not None:
            return 'finalized'
        if j.get('failed') is not None:
            return 'failed'
        if j.get('noninclusion') is not None:
            return 'expired'
        return 'open'
    return 'refused' if request_id in refusals else 'open'


def write_request(project, request):
    """The request file custody reads: exactly the batch request, written once."""
    directory = FLEET_ROOT / project
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = directory / (request['id'] + '.request.json')
    if path.exists():
        require(json.loads(path.read_text()) == request, 'request_conflict')
        return
    atomic(path, json.dumps(request, sort_keys=True, separators=(',', ':')).encode())


def custody(*args):
    """Run the reviewed fleet custody CLI in an isolated interpreter; returns its JSON result."""
    done = subprocess.run([PYTHON, '-I', str(CUSTODY_CLI), *args], capture_output=True, text=True, timeout=600)
    out = (done.stdout or done.stderr).strip().splitlines()
    try:
        result = json.loads(out[-1]) if out else {'status': 'refused', 'code': 'no_output'}
    except ValueError:
        result = {'status': 'refused', 'code': 'no_output'}
    if done.returncode != 0:
        result.setdefault('status', 'refused')
    return result


def sign(project, request_id):
    """Sign once (custody journals first), then reconcile while it is pending."""
    result = custody('sign', project, request_id)
    polls = 0
    while result.get('status') == 'pending' and polls < POLLS:
        time.sleep(POLL_SECONDS)
        result = custody('sign', project, request_id)
        polls += 1
    return result


def sign_request(project, path, request, report):
    """Sign one unsettled request; returns None once it is settled, else the waiting state."""
    write_request(project, request)
    result = sign(project, request['id'])
    status = result.get('status')
    if status == 'finalized':
        report['finalized'].append(request['id'])
        return None
    if status in ('failed', 'expired_not_included'):
        report['settled'].append(dict(id=request['id'], status=status, reason=result.get('reason')))
        return None
    code = result.get('code')
    if status == 'refused' and code in PERMANENT and journal(project, request['id']) is None:
        # Refused before any journal: nothing was signed or sent. Settle it.
        record_refusal(path, request['id'], code)
        report['settled'].append(dict(id=request['id'], status='refused', reason=code))
        return None
    return dict(project=project, id=request['id'], status=status, code=code, broadcast_code=result.get('broadcast_code'))


def fund_projects():
    """Every project with fund batches: the fund step covers all fleet-policy projects, not only
    the ones configured for planning (fleet custody re-checks the policy before signing)."""
    directory = STAGE_ROOT / 'fund-batches'
    if not directory.exists():
        return []
    return sorted(p.name for p in directory.iterdir() if CATALOGUE_ID.fullmatch(p.name))


def sign_pending(projects, report):
    """Signs every unsettled request in batch order (task batches, then fund batches, per
    project; then fund batches of fleet projects not configured for planning); returns None
    when all are settled."""
    for project in list(projects) + [p for p in fund_projects() if p not in projects]:
        for path in batch_files(project):
            batch = load_batch(path, project)
            refusals = load_refusals(path)
            for request in batch['requests']:
                if state(project, request['id'], refusals) != 'open':
                    continue
                waiting = sign_request(project, path, request, report)
                if waiting is not None:
                    return waiting
        for path in fund_batch_files(project):
            request = load_fund_batch(path, project)['request']
            if state(project, request['id'], load_refusals(path)) != 'open':
                continue
            waiting = sign_request(project, path, request, report)
            if waiting is not None:
                return waiting
    return None


def validate_planning_summary(config, summary):
    """Bind explicit bounded mode to the same Node admission limit; old configs keep old shape."""
    if 'max_tasks_per_project_run' not in config:
        return summary
    n = config['max_tasks_per_project_run']
    planning = summary.get('planning')
    require(type(planning) == dict and set(planning) == {'maxTasks', 'maxProviderCalls'} and type(planning['maxTasks']) == int and type(planning['maxProviderCalls']) == int and planning == dict(maxTasks=n, maxProviderCalls=planning_bound(config)), 'invalid_planning_summary')
    require(type(summary.get('runs')) == list, 'invalid_planning_summary')
    for run in summary['runs']:
        count = run.get('executions') if type(run) == dict else None
        require(type(count) == int and 0 <= count <= planning_bound(config), 'invalid_planning_summary')
    return summary


def stage(command, config, candidates):
    """The manager stage (Node, as root): `check` or `propose`. Returns its summary."""
    release = RELEASE_LINK.resolve()
    payload = dict(config=config, projects=config['projects'])
    if candidates is not None:
        payload['candidates'] = candidates
    done = subprocess.run([NODE, str(release / SCRIPT), command], input=json.dumps(payload),
                          capture_output=True, text=True, timeout=PROPOSE_TIMEOUT, cwd=str(release),
                          env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': '/root'})
    lines = done.stdout.strip().splitlines()
    require(done.returncode == 0 and lines, 'propose_failed:%s' % (done.stderr.strip().splitlines() or ['no_output'])[-1][:200])
    summary = json.loads(lines[-1])
    require(type(summary) == dict and summary.get('schema') == SUMMARY_SCHEMA, 'invalid_summary')
    return validate_planning_summary(config, summary)


def propose(config, candidates=None):
    return stage('propose', config, candidates)


def check():
    """Dry check with the installed config and candidates: no model call, no signature, no batch."""
    require(not REQUIRE_ROOT or os.geteuid() == 0, 'root_required')
    config = load_config()
    candidates = load_candidates()
    summary = stage('check', config, candidates)
    return dict(schema='uain-manager-stage-check-v1', candidatesInstalled=candidates is not None,
                **{k: summary.get(k) for k in ('ready', 'skipped', 'candidates', 'executionsLast24h', 'fund', 'decisionsLast24h')})


def run():
    require(not REQUIRE_ROOT or os.geteuid() == 0, 'root_required')
    os.umask(0o077)
    config = load_config()
    candidates = load_candidates()
    STAGE_ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = os.open(STAGE_ROOT / '.driver.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(lock)
        raise Stop('already_running')
    try:
        report = dict(schema='uain-manager-stage-driver-run-v1', finalized=[], settled=[], waiting=None, proposal=None)
        report['waiting'] = sign_pending(config['projects'], report)
        if report['waiting'] is not None:
            return report
        summary = propose(config, candidates)
        report['proposal'] = {k: summary.get(k) for k in ('ready', 'skipped', 'runs', 'batches', 'executionsLast24h', 'candidates',
                                                          'fund', 'fundBatches', 'decisionsLast24h')}
        report['waiting'] = sign_pending(config['projects'], report)
        return report
    finally:
        os.close(lock)


if __name__ == '__main__':
    try:
        require(sys.argv[1:] in ([], ['check']), 'usage')
        print(json.dumps(check() if sys.argv[1:] == ['check'] else run(), separators=(',', ':')))
    except Stop as stop:
        print(json.dumps(dict(status='stopped', code=str(stop))), file=sys.stderr)
        sys.exit(1)

"""Keep paid prior-art survey tasks open, without manual steps (decision D2, 6 November 2026).

Root-only, run by uain-organization-starter.timer. Each run:
  1. reads the root-pinned order and per-project authority files
     (/etc/uain-custody/organization-starter/, written by
     services/project-organizations/ops/starter-authority.mjs and reviewed before install);
  2. reads proven native state for every opened survey task (project_organizations.py status);
  3. re-funds and reopens a survey that central review finally rejected (decision N4, default
     answer recorded 9 November 2026): the budget manager's `central_task_fund` from the
     project's remaining allowance, at once. After MAX_REJECTIONS rejections of the same task it
     signs nothing more for that task and reports it for a specification review;
  4. otherwise, when fewer than `min_open` surveys accept submissions, advances the next project
     by its authority stages. A project whose next stage is refused or exhausted is skipped and
     reported, and the following project in the order is tried, so one blocked project never
     halts the stock.
Every signed request goes one at a time through the reviewed fleet custody CLI
(`project_organizations.py bootstrap|sign`), which journals before sending, checks native state
before signing and never re-signs an unknown outcome. At most one request is signed per run.

It signs nothing itself and holds no key. It writes request files that equal the pinned
authority, plus re-fund requests whose only free field is the evidence digest of a deterministic
re-fund record (written beside it). Invalid configuration stops the run and is reported; the next
run starts from the journals.
"""
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
SOURCE_MANIFEST = Path('/etc/uain-custody/organization-starter-sources.json')
SOURCE_SCHEMA = 'uain-organization-starter-sources-v1'


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
    require(type(pins) == dict and set(pins) == {'organization_starter.py'}, 'source_manifest')
    pin = pins['organization_starter.py']
    raw = _source_read(directory / 'organization_starter.py', trusted_uids, boundary)
    require(type(pin) == str and re.fullmatch('[a-f0-9]{64}', pin)
            and hashlib.sha256(raw).hexdigest() == pin, 'source_hash')
    return compile(raw, str(directory / 'organization_starter.py'), 'exec', dont_inherit=True)


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


AUTHORITY_DIR = Path('/etc/uain-custody/organization-starter')
FLEET_ROOT = Path('/var/lib/uain-custody/project-organizations')
CUSTODY_CLI = Path('/opt/uain-custody/project_organizations.py')
PYTHON = '/opt/uain-custody/venv/bin/python'  # the custody venv (pykeepass)
AUTHORITY_SCHEMA = 'uain-organization-starter-authority-v1'
# Parts-first projects (Rahul, 9 November 2026: small single units; at least 50 open projects with
# three open tasks each): the first five stages only, then the survey opens as reviewed parts.
PARTS_AUTHORITY_SCHEMA = 'uain-organization-starter-authority-v2'
ORDER_SCHEMA = 'uain-organization-starter-order-v1'
TASK_HOLDS = AUTHORITY_DIR / 'task-holds.json'
TASK_HOLDS_SCHEMA = 'baink-central-task-holds-v1'
# This installed driver is scoped to the same immutable native epoch as custody.
TASK_HOLDS_CHAIN = 'uain-shadow-20261008-1'
TASK_HOLDS_GENESIS = '54140a9243c4591ccc9f2e9d49543fc68b87b3e0045416174c232e9dd498f8ff'
TASK_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$')
HASH = re.compile(r'^[a-f0-9]{64}$')
HOLD_EVIDENCE = re.compile(r'^https://api\.crossref\.org/works/[A-Za-z0-9%._;()/:+-]+$')
STAGES = (('open', 'bootstrap', 'open_project'), ('start', 'bootstrap', 'central_project_start'),
          ('configure', 'bootstrap', 'central_fund_configure'), ('plan', 'sign', 'central_fund_plan'),
          ('review', 'sign', 'central_fund_plan_review'), ('survey', 'sign', 'central_task_open'))
CATALOGUE_ID = re.compile(r'^OPP-[0-9]{5}$')
LIMIT = 2 * 1024 * 1024


def protected(path, limit=LIMIT):
    """A root-owned regular file under root-owned parents that nobody else can write."""
    path = Path(path)
    for parent in path.parents:
        info = parent.stat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'untrusted_parent')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022 and 0 < info.st_size <= limit, 'untrusted_file')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            return json.loads(stream.read(limit + 1))
    finally:
        os.close(fd)


def load_task_holds(path=None, trusted_uids=(0,), boundary=None):
    """Optional protected operator availability, never native cancellation.

    The absence of this file preserves legacy stock behavior. Invalid/untrusted
    data stops before native reads or advancement. Fixture ownership/boundary
    arguments are import-only test seams, never CLI/environment options.

    DEPLOYMENT GATE: excluding old held contracts makes replenishment advance
    the pending queue. Install this policy only after every next authority has
    passed primary-record preflight, or an explicitly reviewed queue selects
    only usable authorities. This loader does not approve new task evidence.
    """
    path = TASK_HOLDS if path is None else Path(path)
    try:
        raw = _source_read(path, trusted_uids, boundary, private=True)
    except FileNotFoundError as error:
        # Missing parents or inaccessible/broken links are not optional absence.
        if error.filename == str(path):
            return {}
        raise

    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'duplicate_key')
            result[key] = value
        return result

    try:
        policy = json.loads(raw, object_pairs_hook=unique)
    except ValueError:
        raise Stop('invalid_task_holds') from None
    require(type(policy) == dict and set(policy) == {'schema', 'chainId', 'genesisSha256', 'holds'}
            and policy['schema'] == TASK_HOLDS_SCHEMA and policy['chainId'] == TASK_HOLDS_CHAIN
            and policy['genesisSha256'] == TASK_HOLDS_GENESIS
            and type(policy['holds']) == list and len(policy['holds']) <= 120, 'invalid_task_holds')
    rows = {}
    for row in policy['holds']:
        require(type(row) == dict and set(row) == {'taskId', 'projectId', 'criteriaDigest', 'evidenceDigest', 'reason', 'evidence'}
                and all(type(row[k]) == str and TASK_ID.fullmatch(row[k]) for k in ('taskId', 'projectId'))
                and all(type(row[k]) == str and HASH.fullmatch(row[k]) for k in ('criteriaDigest', 'evidenceDigest'))
                and row['reason'] == 'task_specification_unusable'
                and type(row['evidence']) == list and 1 <= len(row['evidence']) <= 8
                and all(type(url) == str and len(url) <= 512 and HOLD_EVIDENCE.fullmatch(url) for url in row['evidence'])
                and row['taskId'] not in rows, 'invalid_task_holds')
        rows[row['taskId']] = row
    return rows


def task_held(task, holds):
    """A hold matches only the exact unclaimed contract (open, or waiting to be re-funded after a
    rejection), not its successors. A held unfunded task is never re-funded."""
    if type(task) != dict or task.get('state') not in ('open', 'open_unfunded') or task.get('pending') or task.get('winner'):
        return False
    row = holds.get(task.get('id'))
    return row is not None and all(task.get(field) == row[key] for field, key in (
        ('project', 'projectId'), ('acceptance_digest', 'criteriaDigest'), ('evidence_digest', 'evidenceDigest')))


MAX_MIN_OPEN = 600


def load_order():
    order = protected(AUTHORITY_DIR / 'order.json')
    require(type(order) == dict and set(order) in ({'schema', 'projects', 'min_open'}, {'schema', 'projects', 'min_open', 'parts'})
            and order['schema'] == ORDER_SCHEMA, 'invalid_order')
    require(type(order['projects']) == list and len(set(order['projects'])) == len(order['projects']) and
            all(type(p) == str and CATALOGUE_ID.fullmatch(p) for p in order['projects']), 'invalid_order')
    # Raised from 60 (9 November 2026): 50 projects with three open parts each is 150 open tasks.
    require(type(order['min_open']) == int and 1 <= order['min_open'] <= MAX_MIN_OPEN, 'invalid_order')
    parts = order.setdefault('parts', [])
    require(type(parts) == list and len(set(parts)) == len(parts) and all(p in order['projects'] for p in parts), 'invalid_order')
    return order


# ------------------------------------------------- survey parts (split replacement surveys)

PARTS_SCHEMA = 'uain-survey-parts-build-v1'
PART_TASK = re.compile(r'^T-(OPP-[0-9]{5})-1-prior-art-survey-r([2-9])-p([1-9][0-9]?)$')
PART_MAX_SOLVER = 60000000     # 20 AI$ per record, at most 3 records (survey.mjs)
PART_REVIEWER = '10000000'     # 10 AI$ check
MAX_PARTS = 12


AGENT_PARTS = re.compile(r'^(OPP-[0-9]{5})\.agent-r([3-9])\.parts\.json$')


def agent_part_files(project):
    """The project agents' later revisions (ops/project-agents.mjs, 9 November 2026), in order."""
    try:
        names = sorted(n for n in os.listdir(AUTHORITY_DIR) if (m := AGENT_PARTS.fullmatch(n)) and m.group(1) == project)
    except FileNotFoundError:
        return []
    return [AUTHORITY_DIR / n for n in names]


def reviewed_part_files(project):
    """The reviewed replacement parts file, when one was installed. A v1 project whose full survey
    opened (OPP-00002/03/09/10/14) has none: its project agents add parts from revision 3 on
    (10 November 2026). A missing file is absence; a broken link or unreadable parent is not."""
    path = AUTHORITY_DIR / (project + '.parts.json')
    try:
        os.lstat(path)
    except FileNotFoundError:
        return []
    return [path]


def load_parts(project, authority=None):
    """The root-pinned survey-part requests of one project: the reviewed replacement parts
    (ops/survey-parts.mjs build, `<project>.parts.json`) when installed, then every later revision
    its project agents wrote (`<project>.agent-r<N>.parts.json`). Each is an exact central_task_open
    request signed by the project's budget manager. Returns [(request, policy)] in revision and part
    order; [] while a project has neither."""
    authority = authority or load_authority(project)
    out, revisions = [], []
    for path in reviewed_part_files(project) + agent_part_files(project):
        rows = load_part_file(project, protected(path), budget_manager(authority))
        revision = int(PART_TASK.fullmatch(rows[0][0]['payload']['id']).group(2))
        require(not revisions or revision > revisions[-1], 'invalid_parts')
        if path.name != project + '.parts.json':
            require(path.name == '%s.agent-r%d.parts.json' % (project, revision), 'invalid_parts')
        revisions.append(revision)
        out.extend(rows)
    return out


def load_part_file(project, built, manager):
    require(type(built) == dict and built.get('schema') == PARTS_SCHEMA and built.get('project') == project
            and built.get('supersedes') == 'T-%s-1-prior-art-survey' % project and type(built.get('parts')) == list
            and 1 <= len(built['parts']) <= MAX_PARTS, 'invalid_parts')
    revision, out = built.get('revision'), []
    for n, row in enumerate(built['parts'], 1):
        require(type(row) == dict and set(row) == {'request', 'evidence', 'policy'}, 'invalid_parts')
        r, policy = row['request'], row['policy']
        require(type(r) == dict and set(r) == {'id', 'member', 'operation', 'payload'} and r['operation'] == 'central_task_open'
                and r['member'] == manager and r['id'] == 'survey-%s-r%s-p%d' % (project, revision, n), 'invalid_parts')
        payload = r['payload']
        match = PART_TASK.fullmatch(payload.get('id', '')) if type(payload) == dict else None
        require(match and match.group(1) == project and int(match.group(2)) == revision and int(match.group(3)) == n
                and payload.get('project') == 'P-' + project and payload.get('eligibility') == 'new'
                and payload.get('reviewer_amount') == PART_REVIEWER and type(payload.get('solver_amount')) == str
                and payload['solver_amount'].isdigit() and 0 < int(payload['solver_amount']) <= PART_MAX_SOLVER
                and type(policy) == dict and policy.get('taskId') == payload['id']
                and policy.get('class') == 'prior_art_survey' and policy.get('criteriaDigest') == payload.get('acceptance_digest'), 'invalid_parts')
        out.append((r, policy))
    return out


def stages_of(a):
    """The stages an authority signs: all six, or the first five for a parts-first project."""
    return STAGES[:5] if a.get('schema') == PARTS_AUTHORITY_SCHEMA else STAGES


def budget_manager(a):
    """The member that opens the survey or its parts: the survey's signer, or for a parts-first
    project the guardian that started it (the same member in every existing authority)."""
    return a['requests']['start' if a.get('schema') == PARTS_AUTHORITY_SCHEMA else 'survey']['member']


def load_authority(project):
    a = protected(AUTHORITY_DIR / (project + '.json'))
    require(type(a) == dict and a.get('schema') in (AUTHORITY_SCHEMA, PARTS_AUTHORITY_SCHEMA) and a.get('project') == project, 'invalid_authority')
    require(a.get('native_project') == 'P-' + project and type(a.get('requests')) == dict, 'invalid_authority')
    stages = stages_of(a)
    names = [s.get('name') for s in a.get('stages', [])]
    require(names == [s[0] for s in stages], 'invalid_authority')
    require(a['schema'] == AUTHORITY_SCHEMA or set(a['requests']) == set(names), 'invalid_authority')
    for (name, _, operation), stage in zip(stages, a['stages']):
        r = a['requests'].get(name)
        require(type(r) == dict and set(r) == {'id', 'member', 'operation', 'payload'} and r['operation'] == operation and
                stage.get('request') == r['id'] and stage.get('operation') == operation, 'invalid_authority')
    return a


def journal(project, intent):
    path = FLEET_ROOT / project / (intent + '.json')
    if not path.exists():
        return None
    return json.loads(path.read_text())


MAX_ATTEMPTS = 5


def attempts(intent):
    """The base intent ID, then retry IDs. A definitely refused or expired intent is settled and
    never re-signed; a retry is a new intent with the same pinned payload and fresh state."""
    return [intent] + ['%s-r%d' % (intent, n) for n in range(2, MAX_ATTEMPTS + 1)]


def settled_without_receipt(j):
    return type(j) == dict and j.get('receipt') is None and (j.get('failed') is not None or j.get('noninclusion') is not None)


def finalized(project, intent):
    return any(type(j) == dict and j.get('receipt') is not None for j in (journal(project, i) for i in attempts(intent)))


def current_attempt(project, intent):
    """The first attempt that is not settled without a receipt, or None when all are used."""
    for i in attempts(intent):
        if not settled_without_receipt(journal(project, i)):
            return i
    return None


def parse_child(stdout, stderr, returncode):
    """The custody CLI's last JSON line. Unparseable or non-object output is a refusal, never a
    crash: whatever it did is journaled by custody and settled on the next run."""
    out = (stdout or stderr or '').strip().splitlines()
    try:
        result = json.loads(out[-1]) if out else None
    except ValueError:
        result = None
    if type(result) != dict:
        return {'status': 'refused', 'code': 'no_output' if not out else 'unparseable_output'}
    if returncode != 0:
        result['status'] = 'refused' if result.get('status') in (None, 'finalized', 'read') else result['status']
    return result


def custody(*args):
    """Run the reviewed fleet custody CLI in an isolated interpreter; returns its JSON result."""
    try:
        done = subprocess.run([PYTHON, '-I', str(CUSTODY_CLI), *args], capture_output=True, text=True, timeout=600)
    except subprocess.TimeoutExpired:
        return {'status': 'refused', 'code': 'custody_timeout'}
    return parse_child(done.stdout, done.stderr, done.returncode)


def write_request(project, request):
    """The request file custody reads: exactly the pinned authority request, written once."""
    directory = FLEET_ROOT / project
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = directory / (request['id'] + '.request.json')
    body = json.dumps(request, sort_keys=True, separators=(',', ':')).encode()
    if path.exists():
        require(json.loads(path.read_text()) == request, 'request_conflict')
        return
    temp = path.with_suffix('.tmp')
    # A temp file left by an interrupted earlier run was never renamed into place, so custody
    # never read it; the timer runs one instance at a time, so it is safe to discard.
    if temp.is_symlink() or temp.exists():
        temp.unlink()
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, body)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temp, path)


# project_organizations.py status reads at most 64 keys per call, and the proved native answer it
# reads is bounded to 64 KiB: a task record is up to about 5 KiB (4 KiB criteria), so 10 records per
# call stay inside it (9 November 2026; 28 part records already reach 64 KiB). Larger orders are read
# in chunks (each chunk is its own fresh proof; the starter only reads task states).
STATUS_CHUNK = 10


# Every proved read runs the native proof reader against the node the public pilot also reads, so
# re-reading every part each 20-second run (about 30 reads per run at 300 parts) starved public
# reads (9 November 2026). Records are re-proved at most every STATE_MAX_AGE seconds; a task not in
# the cache (a part just opened) is read on its own, and a task the starter just re-funded is
# forgotten so the next run reads it fresh. A stale state only delays a refund by up to that age.
def _cache_path():
    return FLEET_ROOT / '.starter-task-states.json'


STATE_MAX_AGE = 120


def _load_state_cache(now):
    try:
        cache = json.loads(_cache_path().read_text())
    except (OSError, ValueError):
        return {}
    if type(cache) != dict or type(cache.get('at')) not in (int, float) or type(cache.get('records')) != dict or not 0 <= now - cache['at'] <= STATE_MAX_AGE:
        return {}
    return cache


def _save_state_cache(cache):
    temp = _cache_path().with_suffix('.tmp')
    if temp.is_symlink() or temp.exists():
        temp.unlink()
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, json.dumps(cache, separators=(',', ':')).encode())
    finally:
        os.close(fd)
    os.replace(temp, _cache_path())


def forget_task(task_id, now=None):
    cache = _load_state_cache(time.time() if now is None else now)
    if task_id in cache.get('records', {}):
        del cache['records'][task_id]
        _save_state_cache(cache)


def read_tasks(task_ids, now=None):
    """Proven native task records {task id: record}: cached proofs younger than STATE_MAX_AGE, and
    a fresh proved read of every other id (all of them once the cache expires)."""
    now = time.time() if now is None else now
    cache = _load_state_cache(now)
    cached = cache.get('records', {})
    missing = [t for t in task_ids if t not in cached]
    records = {t: cached[t] for t in task_ids if t in cached}
    records.update(_read_tasks(missing))
    if missing:
        _save_state_cache(dict(at=cache.get('at', now), records={**cached, **{t: records[t] for t in missing}}))
    return records


def _read_tasks(task_ids):
    records = {}
    for start in range(0, len(task_ids), STATUS_CHUNK):
        chunk = task_ids[start:start + STATUS_CHUNK]
        keys = ['central_task/' + t for t in chunk]
        result = custody('status', json.dumps(keys))
        require(result.get('status') == 'read' and type(result.get('records')) == dict, 'status_unread:%s' % result.get('code'))
        records.update({t: result['records'].get(k) for t, k in zip(chunk, keys)})
    return records


def survey_states(order):
    """Native state of every survey whose opening finalized: {project: task record}."""
    opened = [p for p in order['projects'] if finalized(p, 'survey-' + p)]
    records = read_tasks(['T-%s-1-prior-art-survey' % p for p in opened])
    return {p: records['T-%s-1-prior-art-survey' % p] for p in opened}


def opening_finalized(project):
    """Whether the project's last authority stage finalized: its survey, or for a parts-first
    project its plan review. Existing projects keep the exact survey-intent check."""
    try:
        a = load_authority(project)
    except (Stop, OSError, ValueError):
        # Unreadable here is reported by advance(); keep the exact survey-intent check.
        return finalized(project, 'survey-' + project)
    if a.get('schema') != PARTS_AUTHORITY_SCHEMA:
        return finalized(project, 'survey-' + project)
    return finalized(project, a['requests'][stages_of(a)[-1][0]]['id'])


def part_states(order):
    """Native state of every opened survey part: {task id: (project, record)}; and the unopened
    part requests, first parts of every project before second parts (so every project gets its first
    units before any gets more): [(project, request)]. A project's parts wait until its opening
    finalized (a parts-first project's plan review, a v1 project's survey); native would refuse them
    before, and every refusal would spend one of the part's attempts."""
    opened, unopened = [], []
    for position, p in enumerate(order.get('parts', [])):
        a = load_authority(p)
        ready = opening_finalized(p)
        for n, (request, _) in enumerate(load_parts(p, a)):
            if finalized(p, request['id']):
                opened.append((p, request['payload']['id']))
            elif ready:
                unopened.append((n, position, p, request))
    records = read_tasks([t for _, t in opened])
    return {t: (p, records[t]) for p, t in opened}, [(p, r) for _, _, p, r in sorted(unopened, key=lambda x: x[:2])]


def accepting(task, holds=None):
    """A survey a newcomer can submit to now: open, nothing pending, no winner. One under review
    or waiting for re-funding does not count, so another opens."""
    return (type(task) == dict and task.get('state') == 'open' and not task.get('pending')
            and not task.get('winner') and not task_held(task, holds or {}))


BLOCKED = ('refused', 'failed', 'expired_not_included')


def advance(project):
    """Run the project's next unfinished stages until one is not yet final. Returns its status."""
    a = load_authority(project)
    stages = stages_of(a)
    for name, verb, _ in stages:
        request = a['requests'][name]
        if finalized(project, request['id']):
            continue
        intent = current_attempt(project, request['id'])
        require(intent is not None, 'attempts_exhausted:%s' % request['id'])
        request = dict(request, id=intent)
        write_request(project, request)
        result = custody(verb, project, intent)
        if result.get('status') != 'finalized':
            return dict(project=project, stage=name, **{k: result.get(k) for k in ('status', 'code', 'broadcast_code') if k in result})
    return dict(project=project, stage=stages[-1][0], status='finalized')


# ------------------------------------------------- re-fund and reopen (decision N4)

REFUND_SCHEMA = 'uain-organization-starter-refund-v1'
REFUND_DECISION = {'decidedBy': 'Rahul', 'decidedAt': '2026-11-09', 'answer': 'N4 default: refund and reopen at once from the '
                   'remaining allowance; after 3 rejections of the same task, a specification review',
                   'record': 'docs/baink/questions-9-nov-2026.md#n4'}
MAX_REJECTIONS = 3


def rejections(task):
    """Final rejections of a task, from native accounting alone: each one pays exactly the
    reviewer amount and returns the task to open_unfunded; an acceptance ends the task
    (chain/federation/central_earning.go central_review)."""
    paid, fee = task.get('paid'), task.get('reviewer_amount')
    require(type(paid) == str and type(fee) == str and paid.isdigit() and fee.isdigit() and int(fee) > 0
            and int(paid) % int(fee) == 0, 'task_accounting_unexpected:%s' % task.get('id'))
    return int(paid) // int(fee)


def refundable(task, holds):
    """Rejected and waiting for re-funding: nothing pending, no winner, nothing reserved, not held."""
    return (type(task) == dict and task.get('state') == 'open_unfunded' and not task.get('pending')
            and not task.get('winner') and task.get('reserved') == '0' and not task_held(task, holds))


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def refund_request(project, task, manager):
    """The exact re-fund request after the n-th rejection, and its evidence preimage. One intent
    per rejection, so a later rejection is a new request, never a re-signature."""
    n = rejections(task)
    require(n >= 1, 'refund_without_rejection:%s' % task.get('id'))
    evidence = dict(schema=REFUND_SCHEMA, decision=REFUND_DECISION, project=project, task=task['id'],
                    nativeProject=task['project'], acceptanceDigest=task['acceptance_digest'],
                    taskEvidenceDigest=task['evidence_digest'], rejection=n, maxRejections=MAX_REJECTIONS)
    request = dict(id='fund-%s-%d' % (task['id'], n), member=manager, operation='central_task_fund',
                   payload=dict(task=task['id'], evidence_digest=hashlib.sha256(canonical(evidence)).hexdigest()))
    return request, evidence


def write_evidence(project, intent, evidence):
    path = FLEET_ROOT / project / (intent + '.evidence.json')
    body = canonical(evidence)
    if path.exists():
        require(path.read_bytes() == body, 'evidence_conflict')
        return
    temp = path.with_suffix('.tmp')
    if temp.is_symlink() or temp.exists():
        temp.unlink()
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, body)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temp, path)


def refund(project, task, with_parts=False):
    """Sign the re-fund of one rejected task (a survey or a survey part) through fleet custody."""
    a = load_authority(project)
    survey = a['requests'].get('survey')
    if survey is not None and survey['payload'].get('id') == task['id']:
        opened_by = [survey]
    elif with_parts:
        opened_by = [r for r, _ in load_parts(project, a) if r['payload']['id'] == task['id']]
    else:
        opened_by = []
    require(len(opened_by) == 1, 'refund_task_mismatch')
    request, evidence = refund_request(project, task, opened_by[0]['member'])
    if finalized(project, request['id']):
        return dict(project=project, task=task['id'], rejection=evidence['rejection'], status='finalized')
    intent = current_attempt(project, request['id'])
    if intent is None:
        return dict(project=project, task=task['id'], rejection=evidence['rejection'], status='refused', code='attempts_exhausted')
    request = dict(request, id=intent)
    write_request(project, request)
    write_evidence(project, intent, evidence)
    result = custody('sign', project, intent)
    return dict(project=project, task=task['id'], rejection=evidence['rejection'],
                **{k: result.get(k) for k in ('status', 'code', 'broadcast_code') if k in result})


def open_part(project, request):
    """Sign one reviewed survey-part opening through fleet custody."""
    intent = current_attempt(project, request['id'])
    if intent is None:
        return dict(project=project, task=request['payload']['id'], status='refused', code='attempts_exhausted')
    write_request(project, dict(request, id=intent))
    result = custody('sign', project, intent)
    return dict(project=project, task=request['payload']['id'], **{k: result.get(k) for k in ('status', 'code', 'broadcast_code') if k in result})


def unsettled_refunds(order):
    """Re-fund intents whose signed envelope is journaled but not yet settled (no receipt, not
    refused or expired). Once native reopens the task it no longer looks rejected, so nothing
    else returns to it, and custody allows one unsettled envelope per signer across every
    project: left alone, it would block every later signature of the budget manager."""
    out = []
    for p in order['projects']:
        directory = FLEET_ROOT / p
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob('fund-*.request.json')):
            intent = path.name[:-len('.request.json')]
            j = journal(p, intent)
            if type(j) == dict and j.get('receipt') is None and not settled_without_receipt(j):
                out.append((p, intent))
    return out


def run():
    require(os.geteuid() == 0, 'root_required')
    os.umask(0o077)
    order = load_order()
    holds = load_task_holds()
    # First settle a re-fund already sent: custody resumes it from its journal (scan for
    # inclusion, record the receipt), never re-signing.
    for p, intent in unsettled_refunds(order):
        result = custody('sign', p, intent)
        report = dict(schema='uain-organization-starter-run-v2', min_open=order['min_open'], advanced=None,
                      settled_refund=dict(project=p, intent=intent, **{k: result.get(k) for k in ('status', 'code', 'broadcast_code') if k in result}))
        if result.get('status') not in BLOCKED:
            return report
    states = survey_states(order)
    parts, unopened = part_states(order) if order.get('parts') else ({}, [])
    open_now = [p for p, t in states.items() if accepting(t, holds)]
    open_parts = [t for t, (_, task) in parts.items() if accepting(task, holds)]
    report = dict(schema='uain-organization-starter-run-v2', open=open_now, min_open=order['min_open'], advanced=None)
    if order.get('parts'):
        report['open_parts'] = open_parts
    if holds:
        report['held'] = [p for p, t in states.items() if task_held(t, holds)]
    # Every rejected survey or part, as (project, task record).
    rejected = [(p, t) for p, t in states.items() if refundable(t, holds)] + [
        (p, t) for _, (p, t) in parts.items() if refundable(t, holds)]
    review = [t['id'] for _, t in rejected if rejections(t) >= MAX_REJECTIONS]
    if review:
        report['specification_review'] = review
    for p, t in [(p, t) for p, t in rejected if rejections(t) < MAX_REJECTIONS]:
        result = refund(p, t, p in order.get('parts', []))
        forget_task(t['id'])
        report.setdefault('refunded', []).append(result)
        if result.get('status') not in BLOCKED:
            return report
    if len(open_now) + len(open_parts) >= order['min_open']:
        return report
    for p, request in unopened:
        result = open_part(p, request)
        if result.get('status') in BLOCKED:
            report.setdefault('skipped', []).append(result)
            continue
        report['opened_part'] = result
        return report
    pending = [p for p in order['projects'] if not opening_finalized(p)]
    if not pending:
        report['exhausted'] = True
        return report
    for p in pending:
        try:
            result = advance(p)
        except Stop as stop:
            result = dict(project=p, status='refused', code=str(stop))
        if result.get('status') in BLOCKED:
            report.setdefault('skipped', []).append(result)
            continue
        report['advanced'] = result
        break
    return report


if __name__ == '__main__':
    try:
        print(json.dumps(run(), separators=(',', ':')))
    except Stop as stop:
        print(json.dumps(dict(status='stopped', code=str(stop))), file=sys.stderr)
        sys.exit(1)

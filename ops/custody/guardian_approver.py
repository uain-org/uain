"""Second guardian signer for generation-2 quorum actions (9 November 2026).

A proposer (for example automatic admission) records a guardian action on
chain and drops an untrusted hint naming the action id and the rule that
should judge it. This approver, holding a different guardian key, never trusts
the hint: it reads the proved `guardian_action/<id>` record and the state the
rule needs through the pinned state reader, re-derives the decision itself,
and signs `guardian_action_approve` only when the proved action is exactly
that decision. Three rules exist:

* `admission`: a `licence` grant must equal what the objective automatic
  admission screen produces for the proved enrol event (native_admission.screen).
* `organizations`: a `central_fund_configure` must name the project and the
  evaluator bound in the reviewed organization policy for that project.
* `manifest`: any other operation (one-time policy activations, reviewer and
  relay appointments, validator rotations, upgrade plans) must appear, by the
  digest of its exact operation and payload, in a root-owned manifest a human
  reviewer wrote for that reset or change.

Nothing else is approvable. Run as root with the custody lock held:
`uain-custody approve-guardian-actions`.
"""
import base64
import datetime
import json
import os
import re
import stat
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

import guardian_quorum as gq
import native_migration as native

CONFIG = Path('/etc/uain-custody/guardian-approver.json')
ROOT = Path('/var/lib/uain-custody/guardian-approver')
TEMP = Path('/run/uain-guardian-approver')
SCHEMA = 'uain-guardian-approver-v1'
HINT_SCHEMA = 'uain-guardian-action-hint-v1'
MANIFEST_SCHEMA = 'uain-guardian-action-manifest-v1'
FIELDS = {'schema', 'quorum', 'approver', 'genesis', 'state_binary', 'state_sha256', 'rpc', 'inbox', 'admission_policy', 'organizations_policy', 'manifest', 'max_actions'}
require = gq.require


def validate_config(c):
    require(type(c) == dict and set(c) == FIELDS and c['schema'] == SCHEMA, 'invalid approver configuration')
    q = gq.Quorum(c['quorum'])
    q.local(c['approver'])
    # CU-7: the binding this host signs with lists only its own guardian key as held here;
    # one root holding two guardian keys would meet the 2-of-3 alone.
    require(all('attachment' not in g for member, g in q.guardians.items() if member != c['approver']), 'this host may hold only its own guardian key')
    for k in ('genesis', 'state_binary', 'inbox'):
        require(type(c[k]) == str and Path(c[k]).is_absolute(), 'absolute paths required')
    require(type(c['state_sha256']) == str and gq.HEX.fullmatch(c['state_sha256']), 'state reader pin required')
    require(type(c['rpc']) == str and re.fullmatch(r'http://127\.0\.0\.1:[1-9][0-9]{0,4}', c['rpc']), 'loopback RPC required')
    for k in ('admission_policy', 'organizations_policy', 'manifest'):
        require(c[k] is None or (type(c[k]) == str and Path(c[k]).is_absolute()), 'rule sources are absolute paths or null')
    require(type(c['max_actions']) == int and 1 <= c['max_actions'] <= 16, 'bounded actions per run')
    return q


# --- rules: each returns the payload this approver independently expects ---

def manifest_digest(record):
    return gq.sha(gq.canonical([record['operation'], record['payload']]).encode())


def manifest_rule(manifest, record, now=None):
    require(type(manifest) == dict and manifest.get('schema') == MANIFEST_SCHEMA and type(manifest.get('actions')) == list, 'invalid manifest')
    digest = manifest_digest(record)
    for entry in manifest['actions']:
        # CU-7: an entry may carry `expires_at` (UTC, YYYY-MM-DDTHH:MM:SSZ); past it, it approves nothing.
        require(type(entry) == dict and set(entry) in ({'operation', 'payload_sha256', 'reason'}, {'operation', 'payload_sha256', 'reason', 'expires_at'}), 'invalid manifest entry')
        if entry['operation'] == record['operation'] and entry['payload_sha256'] == digest:
            require(type(entry['reason']) == str and len(entry['reason'].strip()) >= 10, 'manifest entries need a reviewed reason')
            if 'expires_at' in entry:
                value = entry['expires_at']
                require(type(value) == str and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z', value), 'invalid manifest expiry')
                expires = datetime.datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc).timestamp()
                require((time.time() if now is None else now) < expires, 'manifest entry expired')
            return record['payload']
    require(False, 'action is not in the reviewed manifest')


def admission_rule(admission, policy, context, state):
    """Re-run the objective screen on the proved enrol event."""
    require(type(context) == dict and set(context) == {'enrol_event'}, 'admission hint needs the enrol event id')
    event = state['records'].get('event/' + str(native.decimal(context['enrol_event'])).zfill(20))
    _, command = admission.screen(policy, event, state)
    require(command['operation'] == 'licence', 'admission screen did not produce a licence')
    return command['payload']


def organizations_rule(orgs, policy, context, record, state):
    require(type(context) == dict and set(context) == {'project'} and record['operation'] == 'central_fund_configure', 'organizations rule covers central_fund_configure only')
    bound = policy['projects'].get(context['project'])
    require(bound is not None, 'project not in the reviewed organization policy')
    p = record['payload']
    require(set(p) == {'project', 'evaluator', 'expected_evaluator', 'evidence_digest'} and p['project'] == bound['native_project'] and p['evaluator'] == bound['evaluator'], 'fund configuration differs from the reviewed policy')
    current = state['records'].get('central_fund_config/' + bound['native_project'])
    expected_previous = current['evaluator'] if type(current) == dict else ''
    require(p['expected_evaluator'] == expected_previous and gq.HEX.fullmatch(p['evidence_digest']), 'stale or malformed fund configuration')
    return p


def rule_keys(rule, context, record):
    if rule == 'admission':
        return ['event/' + str(native.decimal(context['enrol_event'])).zfill(20)] + ([('member/' + record['payload']['member']), ('member_metadata/' + record['payload']['member'])] if type(record) == dict and type(record.get('payload')) == dict and 'member' in record['payload'] else [])
    if rule == 'organizations' and type(record) == dict and type(record.get('payload')) == dict and 'project' in record['payload']:
        return ['central_fund_config/' + record['payload']['project']]
    return []


def decide(quorum, approver, hint, read, sources):
    """Pure decision for one hint. `read(member, keys)` returns proved state;
    `sources` holds the loaded rule inputs. Returns (approve_command, record)."""
    require(type(hint) == dict and set(hint) == {'schema', 'id', 'rule', 'context'} and hint['schema'] == HINT_SCHEMA and gq.ACTION_ID.fullmatch(hint['id']), 'invalid hint')
    require(hint['rule'] in ('admission', 'organizations', 'manifest'), 'unknown rule')
    key = 'guardian_action/' + hint['id']
    first = read(approver, ['guardians', 'guardian_epoch_current', key])
    record = first['records'].get(key)
    require(type(record) == dict, 'no proved guardian action for this hint')
    state = first
    extra = rule_keys(hint['rule'], hint['context'], record)
    if extra:
        # The admission screen reads guardian context for the proposer.
        member = record['proposer'] if hint['rule'] == 'admission' else approver
        guardian_keys = sources['admission_module'].guardian_keys(sources['admission']) if hint['rule'] == 'admission' and sources.get('admission') else ['guardians', 'guardian_epoch_current']
        state = read(member, [*guardian_keys, key, *extra])
    if hint['rule'] == 'manifest':
        require(sources.get('manifest') is not None, 'no reviewed manifest configured')
        expected = manifest_rule(sources['manifest'], record)
    elif hint['rule'] == 'admission':
        require(sources.get('admission') is not None and record['operation'] == 'licence', 'admission rule not configured')
        policy = sources['admission']
        require(policy['guardian'] == record['proposer'], 'admission policy names a different proposer')
        expected = admission_rule(sources['admission_module'], policy, hint['context'], state)
    else:
        require(sources.get('organizations') is not None, 'organizations rule not configured')
        expected = organizations_rule(None, sources['organizations'], hint['context'], record, state)
    gq.check_action(quorum, record, record['operation'], expected, approver, first['height'])
    mine = first['member'] if first['member']['id'] == approver else read(approver, ['guardians'])['member']
    require(mine['licence'] == 'active', 'approving guardian is not active')
    expires = min(native.decimal(record['expires_height'], 2 ** 63 - 1), native.decimal(first['height'], 2 ** 63 - 1) + 100)
    return gq.approve_command(quorum, record['id'], approver, mine['sequence'], expires, record['evidence_digest']), record


class Runtime:
    def __init__(self, c):
        self.c = c
        self.deadline = time.monotonic() + 120

    def remaining(self):
        left = self.deadline - time.monotonic()
        require(left > 0, 'deadline passed')
        return left

    def read(self, member, keys):
        c = self.c
        for path, pin in ((c['state_binary'], c['state_sha256']), (c['genesis'], c['quorum']['genesis_sha256'])):
            file = Path(path)
            require(file.resolve() == file, 'pinned artifact is redirected')
            for parent in (file, *file.parents):
                info = parent.stat()
                require(info.st_uid == 0 and not info.st_mode & 0o022, 'pinned artifact is not root-owned')
            require(stat.S_ISREG(file.stat().st_mode) and gq.sha(file.read_bytes()) == pin, 'pinned artifact differs')
        TEMP.mkdir(mode=0o700, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='uain-approver-proof-', dir=TEMP) as temporary:
            out = Path(temporary) / 'state.json'
            result = subprocess.run([c['state_binary'], '--genesis', c['genesis'], '--genesis-sha256', c['quorum']['genesis_sha256'], '--rpc', c['rpc'], '--out', str(out), '--max-age', '120s'],
                                    input=gq.canonical(dict(member=member, keys=list(dict.fromkeys(keys)))).encode(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=self.remaining())
            require(result.returncode == 0, 'state proof refused')
            state = native.strict_json(out.read_bytes())
            require(state['chain_id'] == c['quorum']['chain_id'], 'wrong chain')
            return state

    def broadcast(self, envelope):
        raw = json.dumps(envelope, separators=(',', ':')).encode()
        body = gq.canonical(dict(jsonrpc='2.0', id='uain-guardian-approver', method='broadcast_tx_sync', params=dict(tx=base64.b64encode(raw).decode()))).encode()
        request = urllib.request.Request(self.c['rpc'], data=body, headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=min(10, self.remaining())) as response:
            answer = response.read(65537)
        require(len(answer) <= 65536, 'oversized reply')
        value = native.strict_json(answer)
        require('error' not in value and value['result']['hash'].upper() == gq.sha(raw).upper(), 'broadcast outcome unknown')
        return value['result']['code']


def load(path):
    return native.strict_json(native.protected_read(path, 1024 * 1024))


def atomic(path, value):
    path = Path(path)
    fd, pending = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as out:
            os.fchmod(out.fileno(), 0o600)
            out.write(gq.canonical(value).encode() + b'\n')
            out.flush()
            os.fsync(out.fileno())
        os.replace(pending, path)
    finally:
        Path(pending).unlink(missing_ok=True)


def process(custody, quorum, approver, hint, runtime, sources, journal_dir):
    """Decide, journal the signed bytes before broadcast, and never sign a
    second approval while an earlier one for the same action can still land."""
    journal_dir = Path(journal_dir)
    journal_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = journal_dir / (hint['id'] + '.json')
    if path.exists():
        old = load(path)
        state = runtime.read(approver, ['guardians', 'guardian_action/' + hint['id']])
        record = state['records'].get('guardian_action/' + hint['id'])
        if type(record) == dict and (record.get('executed') not in ('0', 0) or approver in record.get('approvals', [])):
            return dict(id=hint['id'], status='approved')
        oc = old['envelope']['command']
        if native.decimal(state['member']['sequence']) == native.decimal(oc['sequence']) and native.decimal(state['height'], 2 ** 63 - 1) <= native.decimal(oc['expires_height'], 2 ** 63 - 1):
            runtime.broadcast(old['envelope'])
            return dict(id=hint['id'], status='rebroadcast')
    command, record = decide(quorum, approver, hint, runtime.read, sources)
    if hint['rule'] == 'manifest':
        # CU-7: a reviewed manifest entry approves one decision once. Another action id with
        # the same operation and payload is approved only after the earlier approved one is
        # proved unexecuted and past its expiry; the marker is written before signing.
        used_dir = journal_dir / 'manifest-used'
        used_dir.mkdir(mode=0o700, exist_ok=True)
        used = used_dir / (manifest_digest(record) + '.json')
        if used.exists():
            earlier = load(used)['id']
            if earlier != hint['id']:
                state = runtime.read(approver, ['guardian_action/' + earlier])
                old = state['records'].get('guardian_action/' + earlier)
                require(type(old) == dict and old.get('executed') in ('0', 0)
                        and native.decimal(old['expires_height'], 2 ** 63 - 1) < native.decimal(state['height'], 2 ** 63 - 1),
                        'this manifest decision was already approved')
        atomic(used, dict(schema='uain-guardian-manifest-use-v1', id=hint['id'], operation=record['operation']))
    envelope = gq.sign(custody, quorum, quorum.local(approver)['attachment'], approver, command)
    gq.verify(envelope, quorum.guardian(approver)['public_key'])
    atomic(path, dict(schema='uain-guardian-approval-journal-v1', quorum=quorum.digest, hint=hint, envelope=envelope))
    code = runtime.broadcast(envelope)
    return dict(id=hint['id'], status='broadcast' if code == 0 else 'refused_by_check', code=code)


def run(custody, config_path=CONFIG):
    require(os.geteuid() == 0, 'run as root')
    os.umask(0o077)
    c = load(config_path)
    quorum = validate_config(c)
    sources = {}
    if c['manifest']:
        sources['manifest'] = load(c['manifest'])
    if c['admission_policy']:
        import native_admission
        sources['admission'] = native_admission.validate_policy(load(c['admission_policy']))
        sources['admission_module'] = native_admission
        # The screen runs in quorum mode: under a guardian epoch it requires it.
        native_admission.QUORUM = dict(q=quorum, inbox=c['inbox'])
    if c['organizations_policy']:
        sources['organizations'] = load(c['organizations_policy'])
    runtime = Runtime(c)
    inbox = Path(c['inbox'])
    results = []
    for hint_path in sorted(inbox.glob('*.json'))[:c['max_actions']]:
        try:
            hint = load(hint_path)
            results.append(process(custody, quorum, c['approver'], hint, runtime, sources, ROOT / quorum.digest))
            if results[-1]['status'] == 'approved':
                hint_path.unlink()
        except gq.QuorumRefused as error:
            results.append(dict(hint=hint_path.name, status='refused', reason=str(error)))
    print(json.dumps(dict(schema='uain-guardian-approver-run-v1', approver=c['approver'], results=results, private_keys_exported=False)))

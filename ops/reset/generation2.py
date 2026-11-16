"""Generation-2 native chain reset kit (9 November 2026).

The generation-2 chain replaces the single guardian with a 2-of-3 guardian
quorum and the single validator with four validators (3f+1, f=1). This module
holds the reproducible parts of that reset:

* ``QUIESCE`` lists every host unit that signs for, pays through or reads the
  native chain, so a reset never runs under a live BAINK holder, payment,
  central reviewer or guardian timer. ``quiesce`` stops timers before
  services and records what was active; ``resume`` restarts exactly that.
* ``app_genesis`` builds the generation-2 application genesis: the three
  guardian identities (zero balances), the reviewer and relay identities,
  and the guardian threshold. Nothing else carries over.
* ``topology`` places four validators on the available hosts. With two
  production hosts that is two validator homes per host, so losing a whole
  host halts the chain; the gap is stated in every plan.
* ``reseed_actions`` returns the ordered guardian-quorum actions that
  re-establish the policies, the reviewer and the relay on the new chain.
* ``validate_task_stock`` admits only genuine task stock: every task must
  carry a prior-art basis with searches, and replication or known-answer
  demos (``seed-challenges.mjs``, ``seed-starter-tasks.mjs``) are refused.

Usage (root, on the coordinator, after review):

  python3 generation2.py plan  --guardians g.json --reviewer r.json --relay l.json \
      --hosts app=10.98.0.1,database=10.98.0.2 --out plan.json
  python3 generation2.py quiesce --host-units units.json   # records units.json
  python3 generation2.py resume  --host-units units.json

It never prints or reads a private key: inputs are public identities only.
"""
import argparse
import base64
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

GENERATION = 2
GUARDIAN_THRESHOLD = 2
VALIDATORS = 4
VALIDATOR_POWER = 10
ADDRESS = re.compile(r'uain1[0-9a-f]{40}')
DIGEST = re.compile(r'[0-9a-f]{64}')

# Timers first: a timer could restart a stopped oneshot during the reset.
QUIESCE = {
    'app': {
        'timers': ['uain-native-admission.timer', 'uain-organization-starter.timer', 'uain-survey-attester.timer',
                   'uain-manager-stage.timer', 'uain-node-backup.timer', 'uain-node-backup-check.timer'],
        'services': ['baink-public-relay.service', 'baink-server-holder-payer.service', 'baink-server-holder-recipient.service',
                     'uain-central-reviewer.service', 'uain-central-reviewer-custody.service', 'uain-private-review-broker.service',
                     'uain-native-rpc.service', 'uain-private-rpc.service', 'uain-chain-shadow.service'],
    },
    'database': {
        'timers': [],
        'services': ['uain-chain-shadow.service', 'uain-wallet-node.service', 'uain-wallet-peer.service'],
    },
}
# Oneshots a timer may have started; quiesce waits for them to finish.
ONESHOTS = ['uain-native-admission.service', 'uain-organization-starter.service', 'uain-survey-attester.service',
            'uain-manager-stage.service', 'uain-node-backup.service', 'uain-node-backup-check.service']

KNOWN_ANSWER_SOURCES = {'seed-challenges.mjs', 'seed-starter-tasks.mjs'}


class Refusal(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise Refusal(message)


def address(public_key):
    raw = base64.urlsafe_b64decode(public_key + '=' * (-len(public_key) % 4))
    require(len(raw) == 32 and base64.urlsafe_b64encode(raw).decode().rstrip('=') == public_key, 'canonical Ed25519 public key required')
    return 'uain1' + hashlib.sha256(raw).hexdigest()[:40]


def member(identity, karma=0, default_verifier=False):
    """A fresh member record from a public identity: zero balances and standing."""
    require(set(identity) >= {'public_key', 'name', 'operator'}, 'identity needs public_key, name and operator')
    mid = address(identity['public_key'])
    require(identity.get('id', mid) == mid, 'identity address does not match its key')
    require(2 <= len(identity['name'].strip()) <= 120 and 2 <= len(identity['operator'].strip()) <= 200, 'invalid identity metadata')
    return {'id': mid, 'public_key': identity['public_key'], 'name': identity['name'], 'operator': identity['operator'],
            'family': identity.get('family', ''), 'licence': 'active', 'karma': karma, 'credits': '0', 'sequence': '0',
            'default_verifier': default_verifier, 'creator': False, 'active_projects': 0}


def app_genesis(guardians, others):
    require(len(guardians) == 3, 'generation 2 needs exactly three guardian identities')
    records = [member(g, karma=100, default_verifier=i == 0) for i, g in enumerate(guardians)]
    ids = [r['id'] for r in records]
    require(len(set(ids)) == 3, 'guardian identities must be distinct')
    operators = {g['operator'] for g in guardians}
    require(len(operators) == 3, 'each guardian key needs its own custody operator label')
    for identity in others:
        record = member(identity, karma=100)
        require(record['id'] not in ids, 'a guardian cannot also be the reviewer or relay')
        records.append(record)
        ids.append(record['id'])
    require(len(set(ids)) == len(ids), 'duplicate identity')
    return {'version': 1, 'generation': GENERATION, 'guardians': ids[:3], 'guardian_threshold': GUARDIAN_THRESHOLD, 'members': records}


def topology(hosts, per_host=None):
    """Spread four validators over the hosts, round robin.

    hosts: ordered {name: wireguard_address}. Ports step by 10 from 27656 so
    they never collide with the generation-1 node (26666/26667).
    """
    require(1 <= len(hosts) <= VALIDATORS, 'one to four hosts')
    names = list(hosts)
    out, counts = [], {n: 0 for n in names}
    for i in range(VALIDATORS):
        host = names[i % len(names)]
        n = counts[host]
        counts[host] += 1
        out.append({'name': f'uain-val-{i + 1}', 'host': host, 'address': hosts[host], 'home': f'/var/lib/uain-chain/gen2/val-{i + 1}',
                    'unit': f'uain-chain-gen2-val-{i + 1}.service', 'p2p': 27656 + 10 * n, 'rpc': 27657 + 10 * n})
    worst = max(counts.values())
    gap = None
    if 3 * worst >= VALIDATORS:
        gap = (f'{worst} of {VALIDATORS} validators share one host: losing that host halts the chain. '
               'Independent hosts or operators are still required for host-level fault tolerance.')
    return out, gap


def reseed_actions(relay, reviewer, evidence):
    """Ordered guardian-quorum actions after genesis. Each is proposed by one
    guardian and executed by a second guardian's approval."""
    require(ADDRESS.fullmatch(relay) and ADDRESS.fullmatch(reviewer) and DIGEST.fullmatch(evidence), 'relay, reviewer and evidence required')
    return [
        ('activate_storage', {'policy': 'compact-state-v1', 'evidence_digest': evidence}),
        ('activate_membership', {'policy': 'project-membership-v1', 'evidence_digest': evidence}),
        ('activate_operator_rewards', {'policy': 'pairwise-operator-rewards-v1', 'evidence_digest': evidence}),
        ('activate_private_exchange', {'policy': 'orchard-v2-reviewed-otc-v1', 'relayer': relay, 'evidence_digest': evidence}),
        ('activate_coin', {'policy': 'verified-bounties-108t-micro-v1', 'evidence_digest': evidence}),
        ('private_reviewer', {'member': reviewer, 'active': True, 'evidence_digest': evidence}),
        ('central_earning_activate', {'policy': 'central-earning-project-budget-v1', 'reviewer': reviewer, 'evidence_digest': evidence}),
    ]


def reseed_files(actions, reason):
    """The reseed as a guardian proposer batch plus the approver manifest that
    authorizes exactly those decisions (ops/custody/guardian_proposer.py and
    guardian_approver.py). A reviewer signs off by installing the manifest."""
    require(len(reason.strip()) >= 10, 'a reviewed reason is required')
    batch = {'schema': 'uain-guardian-action-batch-v1', 'actions': []}
    manifest = {'schema': 'uain-guardian-action-manifest-v1', 'actions': []}
    for operation, payload in actions:
        batch['actions'].append({'operation': operation, 'payload': payload, 'rule': 'manifest', 'context': {}})
        digest = hashlib.sha256(canonical([operation, payload]).encode()).hexdigest()
        manifest['actions'].append({'operation': operation, 'payload_sha256': digest, 'reason': reason})
    return batch, manifest


def canonical(value):
    """Exactly the custody signer's canonical JSON (ops/custody/native_migration.py)."""
    custody = str(Path(__file__).resolve().parents[1] / 'custody')
    if custody not in sys.path:
        sys.path.insert(0, custody)
    import native_migration
    return native_migration.canonical(value)


def validate_task_stock(manifest):
    """Genuine task stock only (CLAUDE.md, decided 29 September and 6 November 2026)."""
    require(manifest.get('source') not in KNOWN_ANSWER_SOURCES, 'known-answer or replication demos are never seeded on a network')
    tasks = manifest.get('tasks')
    require(isinstance(tasks, list) and tasks, 'task stock needs tasks')
    seen = set()
    for task in tasks:
        require(isinstance(task, dict) and task.get('id') not in seen, 'unique task IDs required')
        seen.add(task['id'])
        require(not task.get('known_answer') and not task.get('expected_answer') and task.get('kind') != 'replication', f"{task['id']}: known-answer task refused")
        prior = task.get('prior_art') or {}
        searches = prior.get('searches') or []
        survey = task.get('first_prior_art_survey') is True
        require(len((prior.get('basis') or '').strip()) >= 40 and len(searches) >= 2, f"{task['id']}: prior-art basis with two searches required")
        require(survey or task.get('novelty_required', True), f"{task['id']}: only the prior-art survey may skip novelty")
    return len(tasks)


# 13 November 2026 (security review OP-1): every systemctl call fails closed. An
# unreachable host, an unknown state or a failed stop/start is a refusal, never
# "not active". BatchMode stops ssh waiting on a prompt; ConnectTimeout bounds it.
SSH = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'uain-database']
STOPPED = ('inactive', 'failed')


def systemctl(host, *args, run=subprocess.run):
    command = ['systemctl', *args] if host == 'app' else [*SSH, 'systemctl', *args]
    return run(command, capture_output=True, text=True)


def active(host, unit, run=subprocess.run):
    """True unless systemd reports the unit inactive or failed; refuses when unknown."""
    result = systemctl(host, 'show', '-p', 'ActiveState', '--value', unit, run=run)
    state = (result.stdout or '').strip()
    require(result.returncode == 0 and state, f'{host}: cannot read the state of {unit}')
    return state not in STOPPED


def stop(host, unit, run=subprocess.run):
    require(systemctl(host, 'stop', unit, run=run).returncode == 0, f'{host}: could not stop {unit}')


def quiesce(run=subprocess.run, wait=None, record=None):
    """Stop every native-dependent unit; return what was active for resume.

    ``record`` receives the unit list before anything is stopped, so a quiesce
    that refuses half way still leaves the list resume needs."""
    import time
    saved = {}
    for host, units in QUIESCE.items():
        saved[host] = [u for u in units['timers'] + units['services'] if active(host, u, run)]
    if record:
        record(saved)
    for host, units in QUIESCE.items():
        for unit in units['timers']:
            stop(host, unit, run)
    deadline = time.monotonic() + (wait if wait is not None else 600)
    while any(active('app', u, run) for u in ONESHOTS):
        require(time.monotonic() < deadline, 'a native oneshot is still running; retry later')
        time.sleep(5)
    for host, units in QUIESCE.items():
        for unit in units['services']:
            stop(host, unit, run)
        still = [u for u in units['timers'] + units['services'] if active(host, u, run)]
        require(not still, f'{host}: units still active after stop: {still}')
    return saved


def resume(saved, run=subprocess.run):
    """Start exactly the saved units; try them all, then refuse if any failed."""
    failed = []
    for host in saved:
        require(host in QUIESCE, f'unknown host in the saved unit list: {host}')
        units = saved[host]
        require(all(u in QUIESCE[host]['timers'] + QUIESCE[host]['services'] for u in units), f'{host}: unit not in the quiesce list')
        services = [u for u in units if u.endswith('.service')]
        timers = [u for u in units if u.endswith('.timer')]
        for unit in services + timers:
            if systemctl(host, 'start', unit, run=run).returncode != 0:
                failed.append(f'{host}:{unit}')
    require(not failed, f'units failed to start: {failed}')


def plan(args):
    load = lambda p: json.loads(Path(p).read_text())
    guardians = load(args.guardians)
    reviewer, relay = load(args.reviewer), load(args.relay)
    genesis = app_genesis(guardians, [reviewer, relay])
    hosts = dict(item.split('=', 1) for item in args.hosts.split(','))
    validators, gap = topology(hosts)
    evidence = hashlib.sha256(json.dumps(genesis, sort_keys=True).encode()).hexdigest()
    out = {'schema': 'uain-generation2-reset-plan-v1', 'app_genesis': genesis, 'validators': validators, 'topology_gap': gap,
           'quiesce': QUIESCE, 'reseed': reseed_actions(member(relay)['id'], member(reviewer)['id'], evidence),
           'app_genesis_sha256': hashlib.sha256(json.dumps(genesis, sort_keys=True).encode()).hexdigest()}
    Path(args.out).write_text(json.dumps(out, indent=2, sort_keys=True) + '\n')
    print(json.dumps({'plan': args.out, 'app_genesis_sha256': out['app_genesis_sha256'], 'topology_gap': gap}))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('plan')
    for name in ('guardians', 'reviewer', 'relay', 'hosts', 'out'):
        p.add_argument('--' + name, required=True)
    q = sub.add_parser('quiesce')
    q.add_argument('--host-units', required=True)
    r = sub.add_parser('resume')
    r.add_argument('--host-units', required=True)
    args = parser.parse_args(argv)
    if args.command == 'plan':
        plan(args)
    elif args.command == 'quiesce':
        path = Path(args.host_units)
        require(not path.exists(), 'refusing to overwrite a saved unit list')
        # Written before the first stop, so a refusal half way still leaves resume its list.
        saved = quiesce(record=lambda value: path.write_text(json.dumps(value, indent=2) + '\n'))
        print(json.dumps({'quiesced': saved}))
    else:
        resume(json.loads(Path(args.host_units).read_text()))


if __name__ == '__main__':
    try:
        main()
    except Refusal as error:
        print(f'generation 2 reset refused: {error}', file=sys.stderr)
        sys.exit(1)

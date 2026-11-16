"""Propose a reviewed batch of guardian actions on a generation-2 chain.

Used for the generation-2 reseed (policy activations, the private reviewer,
central earning with its reviewer, validator changes, upgrade plans) and for
organization fund configuration. Each item names the rule the independent
approver (guardian_approver.py) must apply; this tool only proposes:

  uain-custody propose-guardian-actions /etc/uain-custody/guardian-actions/<batch>.json

Batch file (root-owned):
  {"schema": "uain-guardian-action-batch-v1", "actions": [
     {"operation": "...", "payload": {...}, "rule": "manifest|organizations", "context": {...}}]}

Every proposal is journaled before broadcast, keyed by the digest of its
exact operation and payload, so a rerun never proposes the same decision
twice while an earlier proposal can still execute.
"""
import json
from pathlib import Path

import guardian_quorum as gq
import guardian_approver as ga
import native_migration as native

CONFIG = Path('/etc/uain-custody/guardian-proposer.json')
ROOT = Path('/var/lib/uain-custody/guardian-proposer')
FIELDS = {'schema', 'quorum', 'proposer', 'genesis', 'state_binary', 'state_sha256', 'rpc', 'inbox', 'max_actions'}
require = gq.require


def validate_config(c):
    require(type(c) == dict and set(c) == FIELDS and c['schema'] == 'uain-guardian-proposer-v1', 'invalid proposer configuration')
    q = gq.Quorum(c['quorum'])
    q.local(c['proposer'])
    as_approver = dict(c, schema=ga.SCHEMA, approver=c['proposer'], admission_policy=None, organizations_policy=None, manifest=None)
    as_approver.pop('proposer')
    ga.validate_config(as_approver)
    return q


def validate_batch(batch):
    require(type(batch) == dict and set(batch) == {'schema', 'actions'} and batch['schema'] == 'uain-guardian-action-batch-v1', 'invalid batch')
    require(type(batch['actions']) == list and 1 <= len(batch['actions']) <= 64, 'batch needs 1 to 64 actions')
    seen = set()
    for a in batch['actions']:
        require(type(a) == dict and set(a) == {'operation', 'payload', 'rule', 'context'} and a['rule'] in ('manifest', 'organizations'), 'invalid batch action')
        require(type(a['payload']) == dict and type(a['context']) == dict, 'invalid batch action')
        gq.inner_command(dict(version=1, chain_id='x', member='x', sequence='0', expires_height='1', operation=a['operation'], payload=a['payload']))
        d = decision(a)
        require(d not in seen, 'duplicate decision in batch')
        seen.add(d)
    return batch


def decision(action):
    return gq.sha(gq.canonical([action['operation'], action['payload']]).encode())


def propose_batch(custody, quorum, proposer, batch, runtime, journal_dir, write=ga.atomic, load=ga.load):
    journal_dir = Path(journal_dir)
    journal_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    results = []
    # CheckTx records sequences, so one run may queue consecutive proposals.
    pending = None
    for action in batch['actions']:
        path = journal_dir / (decision(action) + '.json')
        state = runtime.read(proposer, ['guardians', 'guardian_epoch_current'])
        require(state['member']['licence'] == 'active', 'proposing guardian is not active')
        height = native.decimal(state['height'], 2 ** 63 - 1)
        sequence = native.decimal(state['member']['sequence'])
        if pending is not None:
            sequence = max(sequence, pending)
        if path.exists():
            old = load(path)
            oc = old['envelope']['command']
            key = 'guardian_action/' + oc['payload']['id']
            record = runtime.read(proposer, [key])['records'].get(key)
            if type(record) == dict:
                results.append(dict(decision=decision(action), id=oc['payload']['id'], status='executed' if record.get('executed') not in ('0', 0) else 'awaiting_second_guardian'))
                hint(runtime, action, oc['payload']['id'], write)
                continue
            if native.decimal(state['member']['sequence']) == native.decimal(oc['sequence']) and height <= native.decimal(oc['expires_height'], 2 ** 63 - 1):
                runtime.broadcast(old['envelope'])
                results.append(dict(decision=decision(action), id=oc['payload']['id'], status='rebroadcast'))
                continue
        inner = dict(version=1, chain_id=quorum.chain, member=proposer, sequence=str(sequence), expires_height=str(height + 100),
                     operation=action['operation'], payload=action['payload'])
        command = gq.propose_command(quorum, inner, proposer, str(sequence), state['height'])
        envelope = gq.sign(custody, quorum, quorum.local(proposer)['attachment'], proposer, command)
        gq.verify(envelope, quorum.guardian(proposer)['public_key'])
        write(path, dict(schema='uain-guardian-proposal-journal-v1', quorum=quorum.digest, action=action, envelope=envelope))
        code = runtime.broadcast(envelope)
        results.append(dict(decision=decision(action), id=command['payload']['id'], status='broadcast' if code == 0 else 'refused_by_check', code=code))
        if code != 0:
            break
        pending = sequence + 1
        hint(runtime, action, command['payload']['id'], write)
    return results


def hint(runtime, action, ident, write):
    inbox = Path(runtime.c['inbox'])
    inbox.mkdir(mode=0o700, parents=True, exist_ok=True)
    write(inbox / (ident + '.json'), dict(schema=ga.HINT_SCHEMA, id=ident, rule=action['rule'], context=action['context']))


def run(custody, batch_path, config_path=CONFIG):
    import os
    require(os.geteuid() == 0, 'run as root')
    os.umask(0o077)
    c = ga.load(config_path)
    quorum = validate_config(c)
    batch = validate_batch(ga.load(batch_path))
    runtime = ga.Runtime(dict(c, approver=c['proposer']))
    results = propose_batch(custody, quorum, c['proposer'], batch, runtime, ROOT / quorum.digest)
    print(json.dumps(dict(schema='uain-guardian-proposer-run-v1', proposer=c['proposer'], results=results, private_keys_exported=False)))

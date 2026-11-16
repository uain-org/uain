"""Generation-2 guardian quorum signing for custody (9 November 2026).

On a generation-2 chain (`docs/chain/generation2.md`) no single guardian
signature passes a guardian gate. A guardian proposes the exact operation and
payload with `guardian_action_propose`; a second guardian's
`guardian_action_approve` executes it on chain. This module holds the pieces
every custody flow shares:

* `Quorum` validates the root-owned generation-2 binding: chain, genesis,
  three guardian identities, threshold 2 and the separate operator identity
  (project lead, manager and central reviewer), which may never be a guardian.
* `action_id` is deterministic: a retried proposal reuses the same id, and the
  chain refuses a duplicate id, so one decision can never execute twice.
* `propose_command` / `approve_command` build the exact native commands.
* `sign` signs with a vault attachment and checks the key against the
  expected identity; it never prints, returns or writes key material.
* `check_action` is the approver's independent comparison of a proved
  `guardian_action/<id>` record against the payload it re-derived itself.

Signing bytes are `native_migration.signing_bytes`, already cross-checked
against the Go and Node encoders.
"""
import base64
import hashlib
import re

import native_migration as native

SCHEMA = 'uain-guardian-quorum-v1'
ACTION_WINDOW = 720
ADDRESS = re.compile(r'^uain1[a-f0-9]{40}$')
HEX = re.compile(r'^[a-f0-9]{64}$')
ACTION_ID = re.compile(r'^ga-[a-f0-9]{40}$')
KEY = re.compile(r'^keys/[a-z0-9_/-]{1,120}\.json$')
# Operations a quorum may never carry (the chain refuses them too).
FORBIDDEN = {'enrol', 'withdraw'}


class QuorumRefused(ValueError):
    pass


def require(condition, message='guardian quorum context refused'):
    if not condition:
        raise QuorumRefused(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return native.canonical(value)


def public_key(value):
    require(type(value) == str and re.fullmatch(r'[A-Za-z0-9_-]{43}', value), 'invalid public key')
    raw = base64.urlsafe_b64decode(value + '=')
    require(len(raw) == 32 and base64.urlsafe_b64encode(raw).decode().rstrip('=') == value, 'invalid public key')
    return raw


def address(public):
    return 'uain1' + sha(public_key(public))[:40]


def identity(value, attachment_required=False):
    require(type(value) == dict and set(value) <= {'id', 'public_key', 'attachment'} and {'id', 'public_key'} <= set(value), 'invalid identity')
    require(ADDRESS.fullmatch(value['id']) and address(value['public_key']) == value['id'], 'identity address does not match its key')
    if 'attachment' in value or attachment_required:
        require(type(value.get('attachment')) == str and KEY.fullmatch(value['attachment']) and '..' not in value['attachment'], 'invalid key attachment')
    return value


class Quorum:
    """The pinned generation-2 guardian binding. Pure validation; no I/O."""

    def __init__(self, binding):
        b = binding
        require(type(b) == dict and set(b) == {'schema', 'chain_id', 'genesis_sha256', 'threshold', 'guardians', 'operator'}, 'invalid quorum binding')
        require(b['schema'] == SCHEMA and type(b['chain_id']) == str and re.fullmatch(r'uain-[a-z0-9][a-z0-9_-]{1,63}', b['chain_id']), 'invalid chain')
        require(type(b['genesis_sha256']) == str and HEX.fullmatch(b['genesis_sha256']), 'invalid genesis pin')
        guardians = b['guardians']
        require(type(guardians) == list and len(guardians) == 3, 'three guardians required')
        for g in guardians:
            identity(g)
        ids = [g['id'] for g in guardians]
        require(len(set(ids)) == 3, 'duplicate guardian')
        attachments = [g['attachment'] for g in guardians if 'attachment' in g]
        require(len(set(attachments)) == len(attachments), 'guardians must use distinct key attachments')
        require(type(b['threshold']) == int and b['threshold'] == 2, 'generation 2 uses a 2-of-3 threshold')
        identity(b['operator'], attachment_required=True)
        # The reviewer/lead identity has its own key and is never a guardian.
        require(b['operator']['id'] not in ids and b['operator']['attachment'] not in attachments, 'the operator (reviewer) cannot be a guardian')
        self.binding = b
        self.chain = b['chain_id']
        self.guardians = {g['id']: g for g in guardians}
        self.operator = b['operator']
        self.digest = sha(canonical(b).encode())

    def guardian(self, member):
        require(member in self.guardians, 'not a pinned guardian')
        return self.guardians[member]

    def local(self, member):
        g = self.guardian(member)
        require('attachment' in g, 'this guardian key is not held by this host')
        return g


def inner_command(command):
    require(type(command) == dict and set(command) == native.FIELDS and command['version'] == 1, 'invalid inner command')
    require(type(command['operation']) == str and command['operation'] not in FORBIDDEN and not command['operation'].startswith('guardian_'), 'operation cannot be carried by a quorum')
    require(type(command['payload']) == dict, 'payload must be an object')
    return command


def action_id(quorum, inner, proposer, proposer_sequence):
    """Deterministic: one decision, one id, across retries and restarts."""
    inner_command(inner)
    require(inner['chain_id'] == quorum.chain, 'wrong chain')
    material = 'uain:guardian-action:v1\n' + canonical([quorum.chain, proposer, str(proposer_sequence), inner['operation'], inner['payload']])
    return 'ga-' + sha(material.encode())[:40]


def evidence_of(inner):
    e = inner['payload'].get('evidence_digest')
    return e if type(e) == str and HEX.fullmatch(e) else sha(canonical(inner['payload']).encode())


def propose_command(quorum, inner, proposer, sequence, height):
    """Wrap one guardian-gated inner command for proposal by `proposer`."""
    inner_command(inner)
    quorum.guardian(proposer)
    require(inner['chain_id'] == quorum.chain, 'wrong chain')
    seq = native.decimal(sequence)
    h = native.decimal(height, 2 ** 63 - 1)
    require(h >= 1, 'height required')
    expires = h + ACTION_WINDOW - 1
    payload = dict(id=action_id(quorum, inner, proposer, seq), operation=inner['operation'], payload=inner['payload'],
                   expires_height=expires, evidence_digest=evidence_of(inner))
    return dict(version=1, chain_id=quorum.chain, member=proposer, sequence=str(seq), expires_height=str(expires),
                operation='guardian_action_propose', payload=payload)


def approve_command(quorum, ident, approver, sequence, expires_height, evidence_digest):
    quorum.guardian(approver)
    require(type(ident) == str and ACTION_ID.fullmatch(ident) and HEX.fullmatch(evidence_digest), 'invalid approval')
    return dict(version=1, chain_id=quorum.chain, member=approver, sequence=str(native.decimal(str(sequence))),
                expires_height=str(native.decimal(str(expires_height), 2 ** 63 - 1)), operation='guardian_action_approve',
                payload=dict(id=ident, evidence_digest=evidence_digest))


def check_action(quorum, record, expected_operation, expected_payload, approver, height):
    """Approver side: the proved on-chain action must be exactly the decision
    this approver re-derived on its own, still open, and not yet approved by it."""
    require(type(record) == dict, 'no proved guardian action')
    require(ACTION_ID.fullmatch(record.get('id', '')) and record.get('operation') == expected_operation, 'action operation differs')
    require(canonical(record.get('payload')) == canonical(expected_payload), 'action payload differs from the independently derived payload')
    require(record.get('proposer') in quorum.guardians and record['proposer'] != approver, 'proposer must be another pinned guardian')
    approvals = record.get('approvals')
    require(type(approvals) == list and approver not in approvals, 'already approved by this guardian')
    require(record.get('executed') in ('0', 0), 'action already executed')
    require(native.decimal(record.get('expires_height', '0'), 2 ** 63 - 1) >= native.decimal(height, 2 ** 63 - 1), 'action expired')
    return record


def sign(custody, quorum, attachment, member, command):
    """Sign `command` as `member` with a vault attachment. The key must match
    the pinned identity; its bytes are wiped before return."""
    require(command['member'] == member and command['chain_id'] == quorum.chain, 'signer mismatch')
    expected = quorum.operator if member == quorum.operator['id'] else quorum.guardian(member)
    key = native.strict_json(custody.attachment(custody.vault(), attachment))
    seed = bytearray(public_key(key['private_key']))
    try:
        public, signer = native.ed25519(bytes(seed))
        encoded = base64.urlsafe_b64encode(public).decode().rstrip('=')
        require(encoded == key['public_key'] == expected['public_key'] and 'uain1' + sha(public)[:40] == member, 'custody key does not match the pinned identity')
        return dict(command=command, public_key=encoded,
                    signature=base64.urlsafe_b64encode(signer(native.signing_bytes(command))).decode().rstrip('='))
    finally:
        for i in range(len(seed)):
            seed[i] = 0


def verify(envelope, public):
    """Independent signature check of a produced envelope."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    signature = base64.urlsafe_b64decode(envelope['signature'] + '==')
    Ed25519PublicKey.from_public_bytes(public_key(public)).verify(signature, native.signing_bytes(envelope['command']))
    return True


def proposal_receipt(event, command):
    """A finalized proposal event for exactly this signed command."""
    return (type(event) == dict and event.get('operation') == 'guardian_action_propose' and event.get('member') == command['member']
            and event.get('subject') == command['payload']['id'] and event.get('command_digest') == sha(native.signing_bytes(command))
            and not event.get('instance'))


def approval_receipt(event, command):
    return (type(event) == dict and event.get('operation') == 'guardian_action_approve' and event.get('member') == command['member']
            and event.get('subject') == command['payload']['id'] and event.get('command_digest') == sha(native.signing_bytes(command))
            and not event.get('instance'))

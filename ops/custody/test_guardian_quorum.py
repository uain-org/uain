"""Generation-2 guardian quorum custody: fictional keys, injected proofs only."""
import base64
import copy
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import guardian_quorum as gq
import guardian_approver as ga
import guardian_proposer as gp
import native_admission as admission
import native_migration as native

enc = lambda raw: base64.urlsafe_b64encode(raw).decode().rstrip('=')


def key(n):
    seed = bytes([n]) * 32
    public, _ = native.ed25519(seed)
    return dict(id='uain1' + hashlib.sha256(public).hexdigest()[:40], public_key=enc(public), private_key=enc(seed))


G1, G2, G3, OP = key(11), key(12), key(13), key(14)
CHAIN = 'uain-gen2-fixture-1'


def binding(**over):
    b = dict(schema=gq.SCHEMA, chain_id=CHAIN, genesis_sha256='a' * 64, threshold=2,
             guardians=[dict(id=G1['id'], public_key=G1['public_key'], attachment='keys/guardian-1.json'),
                        dict(id=G2['id'], public_key=G2['public_key'], attachment='keys/guardian-2.json'),
                        dict(id=G3['id'], public_key=G3['public_key'])],
             operator=dict(id=OP['id'], public_key=OP['public_key'], attachment='keys/uain-review-key.json'))
    b.update(over)
    return b


class Vault:
    """Fake custody: attachment name -> key JSON. Counts reads."""

    def __init__(self):
        self.keys = {'keys/guardian-1.json': G1, 'keys/guardian-2.json': G2, 'keys/uain-review-key.json': OP}
        self.reads = []

    def vault(self):
        return object()

    def attachment(self, _vault, name):
        self.reads.append(name)
        k = self.keys[name]
        return json.dumps(dict(public_key=k['public_key'], private_key=k['private_key'])).encode()


def licence_inner(member='uain1' + '5' * 40, evidence='e' * 64):
    return dict(version=1, chain_id=CHAIN, member=G1['id'], sequence='7', expires_height='120', operation='licence',
                payload=dict(member=member, status='active', evidence_digest=evidence))


class QuorumBinding(unittest.TestCase):
    def test_valid_binding_and_operator_separation(self):
        q = gq.Quorum(binding())
        self.assertEqual(len(q.guardians), 3)
        self.assertEqual(q.local(G1['id'])['attachment'], 'keys/guardian-1.json')
        with self.assertRaises(gq.QuorumRefused):
            q.local(G3['id'])  # the offline key is not held here

    def test_refusals(self):
        bad = [
            dict(threshold=1), dict(threshold=3),
            dict(operator=dict(id=G1['id'], public_key=G1['public_key'], attachment='keys/x.json')),
            dict(operator=dict(id=OP['id'], public_key=OP['public_key'], attachment='keys/guardian-1.json')),
            dict(guardians=binding()['guardians'][:2]),
            dict(guardians=[binding()['guardians'][0]] * 3),
            dict(chain_id='not a chain'),
        ]
        g = binding()['guardians']
        bad.append(dict(guardians=[g[0], dict(g[1], attachment='keys/guardian-1.json'), g[2]]))
        bad.append(dict(guardians=[dict(g[0], id=G2['id']), g[1], g[2]]))
        for over in bad:
            with self.subTest(over=over), self.assertRaises(gq.QuorumRefused):
                gq.Quorum(binding(**over))


class Commands(unittest.TestCase):
    def setUp(self):
        self.q = gq.Quorum(binding())

    def test_proposal_wraps_exact_payload_with_deterministic_id(self):
        inner = licence_inner()
        a = gq.propose_command(self.q, inner, G1['id'], '7', '100')
        b = gq.propose_command(self.q, copy.deepcopy(inner), G1['id'], '7', '150')
        self.assertEqual(a['operation'], 'guardian_action_propose')
        self.assertEqual(a['payload']['payload'], inner['payload'])
        self.assertEqual(a['payload']['operation'], 'licence')
        self.assertEqual(a['payload']['id'], b['payload']['id'])  # retry: same decision, same id
        self.assertEqual(a['payload']['expires_height'], 100 + gq.ACTION_WINDOW - 1)
        self.assertEqual(a['payload']['evidence_digest'], 'e' * 64)
        other = gq.propose_command(self.q, licence_inner(member='uain1' + '6' * 40), G1['id'], '7', '100')
        self.assertNotEqual(other['payload']['id'], a['payload']['id'])
        self.assertNotEqual(gq.propose_command(self.q, inner, G1['id'], '8', '100')['payload']['id'], a['payload']['id'])

    def test_forbidden_and_foreign_commands(self):
        for op in ('enrol', 'withdraw', 'guardian_action_approve', 'guardian_propose'):
            with self.subTest(op=op), self.assertRaises(gq.QuorumRefused):
                gq.propose_command(self.q, dict(licence_inner(), operation=op), G1['id'], '7', '100')
        with self.assertRaises(gq.QuorumRefused):
            gq.propose_command(self.q, licence_inner(), OP['id'], '7', '100')
        with self.assertRaises(gq.QuorumRefused):
            gq.propose_command(self.q, dict(licence_inner(), chain_id='uain-other-1'), G1['id'], '7', '100')

    def test_signing_uses_only_the_pinned_key_and_verifies(self):
        vault = Vault()
        c = gq.propose_command(self.q, licence_inner(), G1['id'], '7', '100')
        e = gq.sign(vault, self.q, 'keys/guardian-1.json', G1['id'], c)
        self.assertTrue(gq.verify(e, G1['public_key']))
        self.assertNotIn('private_key', json.dumps(e))
        with self.assertRaises(gq.QuorumRefused):  # wrong key for this guardian
            gq.sign(vault, self.q, 'keys/guardian-2.json', G1['id'], c)
        approve = gq.approve_command(self.q, c['payload']['id'], G2['id'], '3', '150', 'e' * 64)
        self.assertTrue(gq.verify(gq.sign(vault, self.q, 'keys/guardian-2.json', G2['id'], approve), G2['public_key']))

    def test_receipts_match_only_the_exact_signed_command(self):
        c = gq.propose_command(self.q, licence_inner(), G1['id'], '7', '100')
        event = dict(operation='guardian_action_propose', member=G1['id'], subject=c['payload']['id'], command_digest=gq.sha(native.signing_bytes(c)))
        self.assertTrue(gq.proposal_receipt(event, c))
        self.assertFalse(gq.proposal_receipt(dict(event, command_digest='0' * 64), c))
        self.assertFalse(gq.proposal_receipt(dict(event, operation='licence'), c))


def action_record(q, inner, proposer=None, **over):
    c = gq.propose_command(q, inner, proposer or G1['id'], '7', '100')
    r = dict(id=c['payload']['id'], epoch='', operation=inner['operation'], payload=inner['payload'], proposer=proposer or G1['id'], height='101',
             expires_height=str(c['payload']['expires_height']), evidence_digest=c['payload']['evidence_digest'], approvals=[proposer or G1['id']], executed='0', subject='')
    r.update(over)
    return r


class ApproverChecks(unittest.TestCase):
    def setUp(self):
        self.q = gq.Quorum(binding())

    def test_check_action_refusals(self):
        inner = licence_inner()
        good = action_record(self.q, inner)
        gq.check_action(self.q, good, 'licence', inner['payload'], G2['id'], '200')
        cases = [
            (dict(good, payload=dict(inner['payload'], member='uain1' + '6' * 40)), G2['id'], '200'),
            (dict(good, operation='roles'), G2['id'], '200'),
            (dict(good, executed='150'), G2['id'], '200'),
            (dict(good, approvals=[G1['id'], G2['id']]), G2['id'], '200'),
            (good, G1['id'], '200'),  # proposer cannot approve itself
            (dict(good, proposer=OP['id']), G2['id'], '200'),
            (good, G2['id'], '100000'),  # expired
        ]
        for record, approver, height in cases:
            with self.subTest(record=record, approver=approver), self.assertRaises(gq.QuorumRefused):
                gq.check_action(self.q, record, 'licence', inner['payload'], approver, height)

    def reader(self, record, extra=None, member=None):
        def read(m, keys):
            records = {'guardians': [G1['id'], G2['id'], G3['id']], 'guardian_epoch_current': None, 'guardian_action/' + record['id']: record}
            records.update(extra or {})
            who = member if (member and m == member['id']) else dict(id=m, licence='active', sequence='3')
            return dict(chain_id=CHAIN, height='200', event_count='9', member=who, records={k: records.get(k) for k in keys})
        return read

    def hint(self, record, rule, context):
        return dict(schema=ga.HINT_SCHEMA, id=record['id'], rule=rule, context=context)

    def test_manifest_rule_needs_exact_reviewed_digest(self):
        inner = dict(licence_inner(), operation='activate_storage', payload=dict(policy='compact-state-v1', evidence_digest='e' * 64))
        record = action_record(self.q, inner)
        digest = gq.sha(gq.canonical(['activate_storage', inner['payload']]).encode())
        manifest = dict(schema=ga.MANIFEST_SCHEMA, actions=[dict(operation='activate_storage', payload_sha256=digest, reason='generation 2 reseed, reviewed plan')])
        command, _ = ga.decide(self.q, G2['id'], self.hint(record, 'manifest', {}), self.reader(record), dict(manifest=manifest))
        self.assertEqual((command['operation'], command['member'], command['payload']['id'], command['sequence']), ('guardian_action_approve', G2['id'], record['id'], '3'))
        for m in (dict(manifest, actions=[]), dict(manifest, actions=[dict(manifest['actions'][0], reason='')]),
                  dict(manifest, actions=[dict(manifest['actions'][0], payload_sha256='0' * 64)])):
            with self.subTest(manifest=m), self.assertRaises(gq.QuorumRefused):
                ga.decide(self.q, G2['id'], self.hint(record, 'manifest', {}), self.reader(record), dict(manifest=m))
        with self.assertRaises(gq.QuorumRefused):  # no manifest configured
            ga.decide(self.q, G2['id'], self.hint(record, 'manifest', {}), self.reader(record), {})
        with self.assertRaises(gq.QuorumRefused):  # forged hint id
            ga.decide(self.q, G2['id'], dict(self.hint(record, 'manifest', {}), id='ga-' + '0' * 40), self.reader(record), dict(manifest=manifest))

    def test_organizations_rule_binds_policy_evaluator(self):
        evaluator = 'uain1' + '7' * 40
        payload = dict(project='P-OPP-00010', evaluator=evaluator, expected_evaluator='', evidence_digest='e' * 64)
        record = action_record(self.q, dict(licence_inner(), operation='central_fund_configure', payload=payload))
        policy = dict(projects={'OPP-00010': dict(native_project='P-OPP-00010', evaluator=evaluator)})
        ga.decide(self.q, G2['id'], self.hint(record, 'organizations', dict(project='OPP-00010')), self.reader(record), dict(organizations=policy))
        wrong = dict(projects={'OPP-00010': dict(native_project='P-OPP-00010', evaluator='uain1' + '8' * 40)})
        for sources, context, extra in [(wrong, dict(project='OPP-00010'), None), (policy, dict(project='OPP-00099'), None),
                                        (policy, dict(project='OPP-00010'), {'central_fund_config/P-OPP-00010': dict(evaluator='uain1' + '9' * 40)})]:
            with self.subTest(context=context), self.assertRaises(gq.QuorumRefused):
                ga.decide(self.q, G2['id'], self.hint(record, 'organizations', context), self.reader(record, extra), dict(organizations=sources))


class AdmissionQuorum(unittest.TestCase):
    """The proposer and the independent approver agree only on the screen."""

    def fixture(self):
        member_seed = bytes([21]) * 32
        mpub, _ = native.ed25519(member_seed)
        member = 'uain1' + hashlib.sha256(mpub).hexdigest()[:40]
        p = dict(schema='uain-native-admission-policy-v1', policy='objective-enrol-v1', chain_id=CHAIN, genesis='/fictional/genesis', genesis_sha256='a' * 64,
                 state_binary='/fictional/reader', state_sha256='b' * 64, rpc='http://127.0.0.1:27657', guardian=G1['id'], guardian_public_key=G1['public_key'],
                 guardian_key_attachment='keys/guardian-1.json', guardian_epoch=None, start_event='0', start_event_digest='', max_events=4, max_approvals=2)
        event = dict(id='5', height='10', member=member, subject=member, operation='enrol', command_digest='c' * 64)
        target = dict(id=member, public_key=enc(mpub), name='Synthetic member', operator='Synthetic operator', family='Fixture', licence='pending', sequence='1',
                      karma=0, credits='0', active_projects=0, default_verifier=False, creator=False)
        records = {'guardians': [G1['id'], G2['id'], G3['id']], 'guardian_epoch_current': None, admission.event_key(5): event, 'member/' + member: target, 'member_metadata/' + member: None}
        state = dict(chain_id=CHAIN, height='100', event_count='5', member=dict(id=G1['id'], public_key=G1['public_key'], licence='active', sequence='7'), records=records)
        return p, event, state

    def test_proposer_wraps_licence_and_approver_rederives_it(self):
        p, event, state = self.fixture()
        q = gq.Quorum(binding())
        with patch.object(admission, 'QUORUM', dict(q=q, inbox='/unused')):
            evidence, envelope = admission.sign_guardian(Vault(), p, event, state)
        command = envelope['command']
        self.assertEqual(command['operation'], 'guardian_action_propose')
        self.assertEqual(command['payload']['operation'], 'licence')
        self.assertTrue(gq.verify(envelope, G1['public_key']))
        record = dict(id=command['payload']['id'], epoch='', operation='licence', payload=command['payload']['payload'], proposer=G1['id'], height='101',
                      expires_height=str(command['payload']['expires_height']), evidence_digest=command['payload']['evidence_digest'], approvals=[G1['id']], executed='0', subject='')

        def read(member, keys):
            r = dict(state['records'])
            r['guardian_action/' + record['id']] = record
            who = state['member'] if member == G1['id'] else dict(id=member, licence='active', sequence='4')
            return dict(state, member=who, records={k: r.get(k) for k in keys})
        hint = dict(schema=ga.HINT_SCHEMA, id=record['id'], rule='admission', context=dict(enrol_event='5'))
        sources = dict(admission=p, admission_module=admission)
        approve, _ = ga.decide(q, G2['id'], hint, read, sources)
        self.assertEqual(approve['payload']['id'], record['id'])
        # A proposal for a member the screen would refuse is never approved.
        bad = copy.deepcopy(record)
        bad['payload']['member'] = 'uain1' + '6' * 40
        bad['id'] = 'ga-' + '1' * 40
        with self.assertRaises((gq.QuorumRefused, ValueError)):
            ga.decide(q, G2['id'], dict(hint, id=bad['id']), lambda m, k: dict(read(m, k), records={**read(m, k)['records'], 'guardian_action/' + bad['id']: bad}), sources)
        # The member already holding a licence is not screened again.
        state['records']['member/' + event['member']]['licence'] = 'active'
        with self.assertRaises((gq.QuorumRefused, ValueError)):
            ga.decide(q, G2['id'], hint, read, sources)

    def test_admission_under_the_handover_epoch_needs_the_quorum(self):
        p, event, state = self.fixture()
        old = 'uain1' + '9' * 40
        p['guardian_epoch'] = 'quorum-1'
        state['records'].update({'guardians': [old], 'guardian_epoch_current': 'quorum-1',
                                 'guardian_epoch/quorum-1': dict(id='quorum-1', guardians=[G1['id'], G2['id'], G3['id']])})
        with patch.object(admission, 'QUORUM', None), self.assertRaises(ValueError):
            admission.screen(p, event, state)
        q = gq.Quorum(binding())
        with patch.object(admission, 'QUORUM', dict(q=q, inbox='/unused')):
            _, envelope = admission.sign_guardian(Vault(), p, event, state)
            self.assertIn('guardian_epoch/quorum-1', admission.selection(p, event)['keys'])
            command = envelope['command']
            record = dict(id=command['payload']['id'], epoch='quorum-1', operation='licence', payload=command['payload']['payload'], proposer=G1['id'], height='101',
                          expires_height=str(command['payload']['expires_height']), evidence_digest=command['payload']['evidence_digest'], approvals=[G1['id']], executed='0', subject='')

            def read(member, keys):
                r = dict(state['records'])
                r['guardian_action/' + record['id']] = record
                who = state['member'] if member == G1['id'] else dict(id=member, licence='active', sequence='4')
                return dict(state, member=who, records={k: r.get(k) for k in keys})
            hint = dict(schema=ga.HINT_SCHEMA, id=record['id'], rule='admission', context=dict(enrol_event='5'))
            approve, _ = ga.decide(q, G2['id'], hint, read, dict(admission=p, admission_module=admission))
            self.assertEqual(approve['payload']['id'], record['id'])
        # A stale pinned epoch is refused.
        state['records']['guardian_epoch_current'] = 'quorum-2'
        with patch.object(admission, 'QUORUM', dict(q=q, inbox='/unused')), self.assertRaises(ValueError):
            admission.screen(p, event, state)

    def test_single_guardian_mode_is_unchanged(self):
        p, event, state = self.fixture()
        with patch.object(admission, 'QUORUM', None):
            _, envelope = admission.sign_guardian(Vault(), p, event, state)
        self.assertEqual(envelope['command']['operation'], 'licence')

    def test_finalized_proposal_waits_for_the_second_guardian_and_writes_a_hint(self):
        p, event, state = self.fixture()
        q = gq.Quorum(binding())
        with tempfile.TemporaryDirectory() as root:
            inbox = Path(root) / 'inbox'
            vault = Vault()
            sent = []

            class Runtime:
                def read(self, selection):
                    value = copy.deepcopy(state)
                    for key in selection.get('keys', []):
                        value['records'].setdefault(key, None)
                    if sent:
                        c = sent[0]['command']
                        found = dict(id='6', operation='guardian_action_propose', member=G1['id'], subject=c['payload']['id'], command_digest=gq.sha(native.signing_bytes(c)))
                        value['records'][admission.event_key(6)] = found
                        value['event_count'] = '6'
                        if 'receipt' in selection:
                            value['receipt'] = dict(finalized=True, event=found)
                    return value

                def broadcast(self, envelope):
                    sent.append(envelope)
                    return 0
            load = lambda path: json.loads(Path(path).read_text())
            with patch.object(admission, 'QUORUM', dict(q=q, inbox=str(inbox))), patch.object(admission, 'ensure_directory', lambda path: Path(path).mkdir(parents=True, exist_ok=True)):
                first = admission.process_enrol(vault, p, event, Path(root) / '5', Runtime(), read_journal=load)
                self.assertEqual(first['status'], 'awaiting_second_guardian')
                hints = list(inbox.glob('*.json'))
                self.assertEqual(len(hints), 1)
                h = json.loads(hints[0].read_text())
                self.assertEqual((h['rule'], h['context']), ('admission', dict(enrol_event='5')))
                again = admission.process_enrol(vault, p, event, Path(root) / '5', Runtime(), read_journal=load)
                self.assertEqual(again['status'], 'awaiting_second_guardian')
                self.assertEqual(len(sent), 1)  # never resigned or rebroadcast
                state['records']['member/' + event['member']]['licence'] = 'active'
                done = admission.process_enrol(vault, p, event, Path(root) / '5', Runtime(), read_journal=load)
                self.assertTrue(done['done'])
            self.assertEqual(vault.reads, ['keys/guardian-1.json'])


class ManifestReplay(unittest.TestCase):
    """CU-7 (latent): one reviewed manifest entry approves one decision, not every re-proposal."""

    def setUp(self):
        self.q = gq.Quorum(binding())
        self.inner = dict(licence_inner(), operation='central_reviewer_appoint', payload=dict(reviewer='uain1' + 'c' * 40, evidence_digest='e' * 64))
        self.digest = gq.sha(gq.canonical([self.inner['operation'], self.inner['payload']]).encode())
        self.manifest = dict(schema=ga.MANIFEST_SCHEMA, actions=[dict(operation=self.inner['operation'], payload_sha256=self.digest, reason='FICTIONAL one-time appointment')])
        self.records, self.sent, self.height = {}, [], '200'
        # The journal folder is a fixture owned by the test user, not root.
        reader = patch.object(native, 'protected_read', lambda path, limit=0: Path(path).read_bytes())
        reader.start()
        self.addCleanup(reader.stop)

    def proposal(self, sequence):
        c = gq.propose_command(self.q, self.inner, G1['id'], sequence, '100')
        r = dict(id=c['payload']['id'], epoch='', operation=self.inner['operation'], payload=self.inner['payload'], proposer=G1['id'], height='101',
                 expires_height=str(c['payload']['expires_height']), evidence_digest=c['payload']['evidence_digest'], approvals=[G1['id']], executed='0', subject='')
        self.records['guardian_action/' + r['id']] = r
        return r

    def process(self, record, journal):
        test = self

        class Runtime:
            def read(self, member, keys):
                records = {'guardians': [G1['id'], G2['id'], G3['id']], 'guardian_epoch_current': None, **test.records}
                return dict(chain_id=CHAIN, height=test.height, event_count='9', member=dict(id=member, licence='active', sequence=str(3 + len(test.sent))),
                            records={k: records.get(k) for k in keys})

            def broadcast(self, envelope):
                test.sent.append(envelope)
                return 0
        hint = dict(schema=ga.HINT_SCHEMA, id=record['id'], rule='manifest', context={})
        return ga.process(Vault(), self.q, G2['id'], hint, Runtime(), dict(manifest=self.manifest), journal)

    def test_a_manifest_decision_is_approved_once_across_re_proposals(self):
        with tempfile.TemporaryDirectory() as journal:
            first = self.proposal('7')
            self.assertEqual(self.process(first, journal)['status'], 'broadcast')
            # A second proposal of the same decision (another id) while the first can still land.
            second = self.proposal('8')
            with self.assertRaises(gq.QuorumRefused):
                self.process(second, journal)
            # ... and after the first executed: never a second execution.
            self.records['guardian_action/' + first['id']] = dict(first, executed='150', approvals=[G1['id'], G2['id']])
            with self.assertRaises(gq.QuorumRefused):
                self.process(second, journal)
            self.assertEqual(len(self.sent), 1)

    def test_a_proved_expired_unexecuted_approval_may_be_replaced(self):
        with tempfile.TemporaryDirectory() as journal:
            first = self.proposal('7')
            self.process(first, journal)
            second = self.proposal('8')
            self.records['guardian_action/' + first['id']] = dict(first, expires_height='150')
            self.records['guardian_action/' + second['id']] = dict(second, expires_height=str(int(self.height) + 50))
            self.assertEqual(self.process(second, journal)['status'], 'broadcast')
            self.assertEqual(len(self.sent), 2)

    def test_an_expired_manifest_entry_approves_nothing(self):
        record = self.proposal('7')
        read = lambda m, k: dict(chain_id=CHAIN, height='200', event_count='9', member=dict(id=m, licence='active', sequence='3'),
                                 records={key: {'guardians': [G1['id'], G2['id'], G3['id']], 'guardian_epoch_current': None, **self.records}.get(key) for key in k})
        hint = dict(schema=ga.HINT_SCHEMA, id=record['id'], rule='manifest', context={})
        entry = self.manifest['actions'][0]
        ga.decide(self.q, G2['id'], hint, read, dict(manifest=dict(self.manifest, actions=[dict(entry, expires_at='2999-01-01T00:00:00Z')])))
        for bad in ('2020-01-01T00:00:00Z', 'tomorrow', 5):
            with self.subTest(expires_at=bad), self.assertRaises(gq.QuorumRefused):
                ga.decide(self.q, G2['id'], hint, read, dict(manifest=dict(self.manifest, actions=[dict(entry, expires_at=bad)])))

    def test_an_approver_host_binding_holds_only_its_own_guardian_key(self):
        config = dict(schema=ga.SCHEMA, quorum=binding(), approver=G2['id'], genesis='/g', state_binary='/s', state_sha256='a' * 64,
                      rpc='http://127.0.0.1:26667', inbox='/i', admission_policy=None, organizations_policy=None, manifest=None, max_actions=4)
        with self.assertRaises(gq.QuorumRefused):  # guardian 1's key is also listed as held here
            ga.validate_config(config)
        g = binding()['guardians']
        ga.validate_config(dict(config, quorum=binding(guardians=[{k: v for k, v in g[0].items() if k != 'attachment'}, g[1], g[2]])))
        proposer = dict({k: v for k, v in config.items() if k not in ('approver', 'admission_policy', 'organizations_policy', 'manifest')}, schema='uain-guardian-proposer-v1', proposer=G1['id'])
        with self.assertRaises(gq.QuorumRefused):
            gp.validate_config(proposer)
        gp.validate_config(dict(proposer, quorum=binding(guardians=[g[0], {k: v for k, v in g[1].items() if k != 'attachment'}, g[2]])))


class Proposer(unittest.TestCase):
    def batch(self):
        manifest_action = dict(operation='activate_storage', payload=dict(policy='compact-state-v1', evidence_digest='e' * 64), rule='manifest', context={})
        org_action = dict(operation='central_fund_configure', payload=dict(project='P-OPP-00010', evaluator='uain1' + '7' * 40, expected_evaluator='', evidence_digest='e' * 64), rule='organizations', context=dict(project='OPP-00010'))
        return dict(schema='uain-guardian-action-batch-v1', actions=[manifest_action, org_action])

    def test_batch_validation(self):
        gp.validate_batch(self.batch())
        b = self.batch()
        b['actions'].append(copy.deepcopy(b['actions'][0]))
        for bad in (b, dict(self.batch(), actions=[]), dict(self.batch(), actions=[dict(self.batch()['actions'][0], rule='admission')]),
                    dict(self.batch(), actions=[dict(self.batch()['actions'][0], operation='enrol')])):
            with self.subTest(bad=bad), self.assertRaises(gq.QuorumRefused):
                gp.validate_batch(bad)

    def test_consecutive_proposals_journal_before_send_and_never_repeat(self):
        q = gq.Quorum(binding())
        sent, order, onchain = [], [], {}
        with tempfile.TemporaryDirectory() as root:
            class Runtime:
                c = dict(inbox=str(Path(root) / 'inbox'))

                def read(self, member, keys):
                    return dict(chain_id=CHAIN, height='300', member=dict(id=member, licence='active', sequence='9'), records={k: onchain.get(k) for k in keys})

                def broadcast(self, envelope):
                    order.append('send')
                    sent.append(envelope)
                    return 0

            def write(path, value):
                order.append('write:' + Path(path).parent.name)
                Path(path).write_text(json.dumps(value))
            load = lambda path: json.loads(Path(path).read_text())
            journal = Path(root) / 'journal'
            results = gp.propose_batch(Vault(), q, G1['id'], self.batch(), Runtime(), journal, write=write, load=load)
            self.assertEqual([r['status'] for r in results], ['broadcast', 'broadcast'])
            self.assertEqual([e['command']['sequence'] for e in sent], ['9', '10'])
            self.assertEqual(order[:2], ['write:journal', 'send'])
            for e in sent:
                self.assertTrue(gq.verify(e, G1['public_key']))
                self.assertEqual(e['command']['operation'], 'guardian_action_propose')
            hints = sorted(json.loads(p.read_text())['rule'] for p in (Path(root) / 'inbox').glob('*.json'))
            self.assertEqual(hints, ['manifest', 'organizations'])
            for e in sent:
                onchain['guardian_action/' + e['command']['payload']['id']] = dict(executed='0')
            again = gp.propose_batch(Vault(), q, G1['id'], self.batch(), Runtime(), journal, write=write, load=load)
            self.assertEqual([r['status'] for r in again], ['awaiting_second_guardian'] * 2)
            self.assertEqual(len(sent), 2)


if __name__ == '__main__':
    unittest.main()

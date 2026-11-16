import base64
import hashlib
import os
import unittest
from types import SimpleNamespace

import generation2 as g2


def identity(name, operator=None):
    key = base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip('=')
    return {'public_key': key, 'name': name, 'operator': operator or name + ' custody'}


class Generation2(unittest.TestCase):
    def test_genesis_is_two_of_three_with_zero_balances(self):
        guardians = [identity(f'guardian-{i}') for i in range(3)]
        g = g2.app_genesis(guardians, [identity('reviewer'), identity('relay')])
        self.assertEqual((g['generation'], g['guardian_threshold'], len(g['guardians'])), (2, 2, 3))
        self.assertTrue(all(m['credits'] == '0' and m['sequence'] == '0' for m in g['members']))
        self.assertEqual(g['members'][0]['id'], 'uain1' + hashlib.sha256(base64.urlsafe_b64decode(guardians[0]['public_key'] + '=')).hexdigest()[:40])

    def test_genesis_refusals(self):
        same = identity('guardian-a', 'one custody')
        with self.assertRaises(g2.Refusal):
            g2.app_genesis([same, identity('guardian-b', 'one custody'), identity('guardian-c')], [])
        with self.assertRaises(g2.Refusal):
            g2.app_genesis([identity('g1'), identity('g2')], [])
        guardians = [identity(f'guardian-{i}') for i in range(3)]
        with self.assertRaises(g2.Refusal):
            g2.app_genesis(guardians, [guardians[0]])

    def test_topology_two_hosts_states_gap(self):
        validators, gap = g2.topology({'app': '10.98.0.1', 'database': '10.98.0.2'})
        self.assertEqual([v['host'] for v in validators], ['app', 'database', 'app', 'database'])
        self.assertEqual({v['rpc'] for v in validators if v['host'] == 'app'}, {27657, 27667})
        self.assertIn('halts', gap)
        _, none = g2.topology({'a': '1', 'b': '2', 'c': '3', 'd': '4'})
        self.assertIsNone(none)

    def test_task_stock_refuses_known_answers(self):
        prior = {'basis': 'No open solution exists; searches below found no prior result.', 'searches': ['search one', 'search two']}
        self.assertEqual(g2.validate_task_stock({'tasks': [{'id': 'T-1', 'prior_art': prior}]}), 1)
        for bad in ({'source': 'seed-challenges.mjs', 'tasks': [{'id': 'T-1', 'prior_art': prior}]},
                    {'tasks': [{'id': 'T-1', 'prior_art': prior, 'known_answer': '42'}]},
                    {'tasks': [{'id': 'T-1', 'prior_art': {'basis': 'short', 'searches': []}}]},
                    {'tasks': [{'id': 'T-1', 'prior_art': prior}, {'id': 'T-1', 'prior_art': prior}]}):
            with self.assertRaises(g2.Refusal):
                g2.validate_task_stock(bad)

    def test_reseed_is_quorum_actions_only(self):
        a, b = 'uain1' + 'a' * 40, 'uain1' + 'b' * 40
        ops = [op for op, _ in g2.reseed_actions(a, b, 'c' * 64)]
        self.assertEqual(ops[0], 'activate_storage')
        self.assertIn('central_earning_activate', ops)
        self.assertIn('private_reviewer', ops)

    def test_quiesce_stops_timers_first_and_resumes_exactly(self):
        state = {u: 'active' for host in g2.QUIESCE.values() for u in host['timers'] + host['services']}
        state['uain-wallet-node.service'] = 'inactive'
        calls = []

        def run(command, **_):
            unit, verb = command[-1], command[-2]
            calls.append((verb, unit))
            if verb == 'stop':
                state[unit] = 'inactive'
            elif verb == 'start':
                state[unit] = 'active'
            return SimpleNamespace(returncode=0, stdout=state.get(unit, 'inactive') + '\n')
        saved = g2.quiesce(run=run, wait=0)
        stops = [u for v, u in calls if v == 'stop']
        self.assertLess(stops.index('uain-native-admission.timer'), stops.index('baink-server-holder-payer.service'))
        self.assertNotIn('uain-wallet-node.service', saved['database'])
        self.assertTrue(all(s == 'inactive' for u, s in state.items()))
        g2.resume(saved, run=run)
        self.assertEqual(state['uain-wallet-node.service'], 'inactive')
        self.assertEqual(state['baink-public-relay.service'], 'active')

    def test_quiesce_refuses_a_unit_that_will_not_stop(self):
        def run(command, **_):
            return SimpleNamespace(returncode=0, stdout='active\n')
        with self.assertRaises(g2.Refusal):
            g2.quiesce(run=run, wait=0)

    # 13 November 2026 (security review OP-1): quiesce and resume fail closed.
    def test_quiesce_refuses_when_the_database_host_cannot_be_reached(self):
        calls = []

        def run(command, **_):
            calls.append(command)
            if command[0] == 'ssh':
                return SimpleNamespace(returncode=255, stdout='', stderr='ssh: Could not resolve hostname uain-database')
            return SimpleNamespace(returncode=0, stdout='inactive\n')
        with self.assertRaises(g2.Refusal):
            g2.quiesce(run=run, wait=0)
        ssh = [c for c in calls if c[0] == 'ssh']
        self.assertTrue(ssh and all('BatchMode=yes' in c and 'ConnectTimeout=10' in c for c in ssh))

    def test_quiesce_refuses_an_unknown_or_transitional_state(self):
        for state in ('', 'deactivating', 'activating', 'reloading', 'maintenance'):
            def run(command, state=state, **_):
                if command[-1] == 'uain-wallet-peer.service' and 'show' in command:
                    return SimpleNamespace(returncode=0, stdout=state + '\n')
                return SimpleNamespace(returncode=0, stdout='inactive\n')
            with self.subTest(state=state), self.assertRaises(g2.Refusal):
                g2.quiesce(run=run, wait=0)

    def test_a_failed_unit_counts_as_stopped(self):
        def run(command, **_):
            return SimpleNamespace(returncode=0, stdout='failed\n')
        self.assertEqual(g2.quiesce(run=run, wait=0), {'app': [], 'database': []})

    def test_quiesce_refuses_a_failed_stop(self):
        state = {'uain-chain-shadow.service': 'active'}

        def run(command, **_):
            unit = command[-1]
            if 'stop' in command:
                return SimpleNamespace(returncode=1, stdout='', stderr='Job failed')
            return SimpleNamespace(returncode=0, stdout=state.get(unit, 'inactive') + '\n')
        with self.assertRaisesRegex(g2.Refusal, 'could not stop'):
            g2.quiesce(run=run, wait=0)

    def test_quiesce_records_the_units_before_stopping_any(self):
        events = []

        def run(command, **_):
            if 'stop' in command:
                events.append('stop')
            return SimpleNamespace(returncode=0, stdout=('active' if 'show' in command and not events else 'inactive') + '\n')
        saved = g2.quiesce(run=run, wait=0, record=lambda value: events.append(('record', value)))
        self.assertEqual(events[0], ('record', saved))
        self.assertIn('uain-wallet-node.service', saved['database'])

    def test_resume_refuses_a_failed_start(self):
        def run(command, **_):
            if 'start' in command and command[-1] == 'uain-wallet-node.service':
                return SimpleNamespace(returncode=1, stdout='', stderr='Job failed')
            return SimpleNamespace(returncode=0, stdout='active\n')
        with self.assertRaisesRegex(g2.Refusal, 'uain-wallet-node.service'):
            g2.resume({'app': ['uain-native-rpc.service'], 'database': ['uain-wallet-node.service']}, run=run)


    def test_reseed_manifest_authorizes_exactly_its_batch(self):
        import sys
        from pathlib import Path
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'custody'))
        try:
            import guardian_approver as ga
        except ImportError as error:  # the custody runtime provides cryptography
            self.skipTest(str(error))
        a, b = 'uain1' + 'a' * 40, 'uain1' + 'b' * 40
        batch, manifest = g2.reseed_files(g2.reseed_actions(a, b, 'c' * 64), 'generation 2 reset, reviewed plan')
        self.assertEqual(len(batch['actions']), len(manifest['actions']))
        for action in batch['actions']:
            record = {'operation': action['operation'], 'payload': action['payload']}
            self.assertEqual(ga.manifest_rule(manifest, record), action['payload'])
        tampered = {'operation': 'activate_private_exchange', 'payload': dict(batch['actions'][3]['payload'], relayer=b)}
        with self.assertRaises(ValueError):
            ga.manifest_rule(manifest, tampered)
        with self.assertRaises(g2.Refusal):
            g2.reseed_files([], 'short')


if __name__ == '__main__':
    unittest.main()

"""Language-neutral golden contract fixtures (fixtures/contracts), Python custody consumer.

The same JSON files are asserted by the Go chain, chain/client, BAINK and the
project organization service. Fictional addresses only; no keys, root or network."""
import hashlib
import importlib.util
import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).absolute().parent
FIXTURES = HERE.parents[1] / 'fixtures' / 'contracts'
sys.path.insert(0, str(HERE))


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


native = load('native_migration')
organizations = load('project_organizations')


def fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding='utf-8'))


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def accepts(run):
    try:
        run()
        return True
    except ValueError:
        return False


class ContractFixtureTests(unittest.TestCase):
    def outcome(self, name, want, run, key):
        self.assertIsNotNone(want, name)
        if want == 'refused':
            self.assertRaises(ValueError, run)
            return
        if want == 'accepted':
            run()
            return
        if 'refused' in want:
            with self.assertRaises(ValueError) as caught:
                run()
            code = getattr(caught.exception, 'code', None)
            if want['refused'] == 'JSONDecodeError':
                self.assertIsInstance(caught.exception, json.JSONDecodeError, name)
            elif want['refused'] != 'ValueError':
                self.assertEqual(code, want['refused'], name)
            return
        value = run()
        self.assertEqual(value.decode() if type(value) is bytes else value, want[key], name)

    def test_chain_canonical_json(self):
        chain = fixture('canonical-json.json')['chain']
        self.assertTrue(chain['vectors'] and chain['edge_inputs'])
        for v in chain['vectors']:
            text = native.canonical(json.loads(v['json']))
            self.assertEqual(text, v['canonical'], v['name'])
            self.assertEqual(sha(text), v['sha256'], v['name'])
        for v in chain['edge_inputs']:
            self.outcome(v['name'], v['outcomes'].get('python-native-migration'),
                         lambda: native.canonical(json.loads(v['json'])), 'canonical')

    def test_organization_canonical_json(self):
        org = fixture('canonical-json.json')['organization']
        for v in org['vectors']:
            text = organizations.js_canonical(json.loads(v['json']))
            self.assertEqual(text, v['canonical'], v['name'])
            self.assertEqual(sha(text), v['sha256'], v['name'])
        for v in org['edge_inputs']:
            want = v['outcomes'].get('python-organizations')
            if want == 'refused':
                with self.assertRaises(organizations.Refused) as caught:
                    organizations.js_canonical(json.loads(v['json']))
                self.assertEqual(caught.exception.code, 'non_canonical_value', v['name'])
            else:
                self.outcome(v['name'], want, lambda: organizations.js_canonical(json.loads(v['json'])), 'canonical')

    def test_command_signing_bytes(self):
        f = fixture('command-signing.json')
        signable = set(f['custody_signable_operations'])
        self.assertTrue(f['vectors'])
        for v in f['vectors']:
            raw = native.signing_bytes(v['command'])
            self.assertEqual(raw.decode(), v['signing_bytes'], v['name'])
            self.assertEqual(hashlib.sha256(raw).hexdigest(), v['sha256'], v['name'])
            operation, payload = v['command']['operation'], v['command']['payload']
            if operation in signable:
                organizations.central_payload(operation, payload)
            else:
                with self.assertRaises(organizations.Refused) as caught:
                    organizations.central_payload(operation, payload)
                self.assertEqual(caught.exception.code, 'operation_not_allowed', v['name'])
        for v in f['edge_commands']:
            self.outcome(v['name'], v['outcomes'].get('python-native-migration'),
                         lambda: native.signing_bytes(v['command']), 'signing_bytes')

    def test_field_rejections(self):
        f = fixture('field-rejections.json')
        for v in f['commands']:
            self.outcome(v['name'], v['outcomes'].get('python-native-migration-strict'),
                         lambda: native.signing_bytes(native.strict_json(v['json'])), 'signing_bytes')
            self.outcome(v['name'], v['outcomes'].get('python-organizations-strict'),
                         lambda: json.loads(v['json'], object_pairs_hook=organizations._unique_pairs), None)
        for v in f['payloads']:
            self.outcome(v['name'], v['outcomes'].get('python-organizations'),
                         lambda: organizations.central_payload(v['operation'], v['payload']), None)

    def test_five_kpi_plan(self):
        for v in fixture('five-kpi-plan.json')['vectors']:
            self.assertEqual(accepts(lambda: organizations.central_payload(v['operation'], v['payload'])), v['valid'], v['name'])

    def test_amounts(self):
        f = fixture('amounts.json')
        self.assertEqual(str(organizations.LIFETIME_UNITS), f['constants']['lifetime_ceiling_units'])
        for v in f['task_amounts']:
            self.assertEqual(accepts(lambda: organizations.units(v['value'])), v['positive'], repr(v['value']))
        task = next(v for v in fixture('command-signing.json')['vectors'] if v['command']['operation'] == 'central_task_open')
        for p in f['task_amount_pairs']:
            payload = dict(task['command']['payload'], solver_amount=p['solver_amount'], reviewer_amount=p['reviewer_amount'])
            self.assertEqual(accepts(lambda: organizations.central_payload('central_task_open', payload)), p['valid'], repr(p))


if __name__ == '__main__':
    unittest.main()

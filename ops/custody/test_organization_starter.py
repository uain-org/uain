"""Protected starter source-bootstrap fixtures; no native/custody/model execution."""
import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('organization_starter', Path(__file__).with_name('organization_starter.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class OrganizationStarterSourcePins(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.root.chmod(0o700)
        self.source = self.root / 'organization_starter.py'
        self.source.write_bytes(Path(m.__file__).read_bytes())
        self.source.chmod(0o600)
        self.manifest = self.root / 'organization-starter-sources.json'
        self.approved = {'schema': 'uain-organization-starter-sources-v1', 'sha256': {'organization_starter.py': hashlib.sha256(self.source.read_bytes()).hexdigest()}}
        self.save()

    def tearDown(self):
        self.temp.cleanup()

    def save(self):
        self.manifest.write_text(json.dumps(self.approved))
        self.manifest.chmod(0o600)

    def verify(self):
        return m.verify_sources(self.root, self.manifest, trusted_uids=(os.getuid(),), boundary=self.root)

    def test_exact_source_compiles_without_executing_it(self):
        self.assertIsInstance(self.verify(), type(compile('', '', 'exec')))
        (self.root / '__pycache__').mkdir()
        (self.root / '__pycache__' / 'organization_starter.cpython-313.pyc').write_bytes(b'forged bytecode')
        self.assertIsInstance(self.verify(), type(compile('', '', 'exec')))

    def test_hash_change_unknown_manifest_field_and_duplicate_keys_refuse(self):
        self.source.write_text(self.source.read_text() + '\nraise RuntimeError("must never run")\n')
        with self.assertRaisesRegex(m.Stop, 'source_hash'):
            self.verify()
        self.approved['extra'] = True
        self.save()
        with self.assertRaisesRegex(m.Stop, 'source_manifest'):
            self.verify()
        self.manifest.write_text('{"schema":"uain-organization-starter-sources-v1","schema":"other","sha256":{}}')
        with self.assertRaisesRegex(m.Stop, 'duplicate_key'):
            self.verify()

    def test_symlink_hardlink_and_writable_sources_refuse(self):
        target = self.root / 'target.py'
        self.source.rename(target)
        self.source.symlink_to(target)
        with self.assertRaises(m.Stop):
            self.verify()
        self.source.unlink()
        os.link(target, self.source)
        with self.assertRaises(m.Stop):
            self.verify()
        target.unlink()
        self.source.chmod(0o622)
        with self.assertRaises(m.Stop):
            self.verify()

    def test_manifest_must_be_private_and_parents_protected(self):
        self.manifest.chmod(0o644)
        with self.assertRaises(m.Stop):
            self.verify()
        self.manifest.chmod(0o600)
        self.root.chmod(0o777)
        with self.assertRaises(m.Stop):
            self.verify()

    def test_direct_cli_requires_isolated_interpreter_before_application_config(self):
        import subprocess
        result = subprocess.run([__import__('sys').executable, str(self.source), 'check'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('isolated_interpreter_required', result.stderr)
        self.assertNotIn('config', result.stderr.lower())

    def test_isolated_cli_missing_manifest_refuses_before_application_or_side_effects(self):
        import subprocess
        sentinel = self.root / 'application-executed'
        text = self.source.read_text().replace("AUTHORITY_DIR = Path(", "Path(" + repr(str(sentinel)) + ").touch()\nAUTHORITY_DIR = Path(", 1)
        self.source.write_text(text)
        result = subprocess.run([__import__('sys').executable, '-I', str(self.source), 'check'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('source_bootstrap_refused', result.stderr)
        self.assertFalse(sentinel.exists())
        self.assertNotIn('Traceback', result.stderr)

    def test_manifest_requires_exact_complete_source_set(self):
        for pins in [{}, dict(self.approved['sha256'], unexpected_py='a' * 64)]:
            self.approved['sha256'] = pins
            self.save()
            with self.assertRaisesRegex(m.Stop, 'source_manifest'):
                self.verify()

    def test_isolated_cli_refuses_nonroot_before_application(self):
        import subprocess
        import sys
        sentinel = self.root / 'application-executed'
        text = self.source.read_text().replace('AUTHORITY_DIR = Path(', 'Path(' + repr(str(sentinel)) + ').touch()\nAUTHORITY_DIR = Path(', 1)
        self.source.write_text(text)
        code = 'import os,runpy; os.geteuid=lambda:1000; runpy.run_path(' + repr(str(self.source)) + ',run_name="__main__")'
        result = subprocess.run([sys.executable, '-I', '-c', code], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('source_bootstrap_refused', result.stderr)
        self.assertFalse(sentinel.exists())

    def test_in_process_dependency_closure_is_only_standard_library(self):
        import ast
        import sys
        tree = ast.parse(self.source.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for item in node.names:
                    self.assertIn(item.name.split('.')[0], sys.stdlib_module_names)
            elif isinstance(node, ast.ImportFrom):
                self.assertEqual(node.level, 0)
                self.assertIn(node.module.split('.')[0], sys.stdlib_module_names)

    def test_manifest_symlink_hardlink_and_untrusted_source_uid_refuse(self):
        target = self.root / 'manifest-target.json'
        self.manifest.rename(target)
        self.manifest.symlink_to(target)
        with self.assertRaises(m.Stop):
            self.verify()
        self.manifest.unlink()
        os.link(target, self.manifest)
        with self.assertRaises(m.Stop):
            self.verify()
        target.unlink()
        with self.assertRaises(m.Stop):
            m.verify_sources(self.root, self.manifest, trusted_uids=(os.getuid() + 1,), boundary=self.root)

class OrganizationStarterUsableStock(unittest.TestCase):
    """FICTIONAL native stock + recorded advancement, no signing or RPC."""
    def setUp(self):
        self.saved = {name: getattr(m, name) for name in ('load_order', 'survey_states', 'finalized', 'advance')}
        self.order = {'schema': m.ORDER_SCHEMA, 'projects': ['OPP-00004', 'OPP-00009'], 'min_open': 1}
        self.task = {'id': 'T-OPP-00004-1-prior-art-survey', 'project': 'P-OPP-00004',
                     'acceptance_digest': 'b' * 64, 'evidence_digest': 'c' * 64,
                     'state': 'open', 'pending': '', 'winner': '', 'reserved': '250000000', 'paid': '0'}
        self.states = {'OPP-00004': self.task}
        self.advanced = []
        m.load_order = lambda: self.order
        m.survey_states = lambda order: self.states
        m.finalized = lambda project, intent: project == 'OPP-00004'
        m.advance = lambda project: self.advanced.append(project) or {'project': project, 'status': 'pending'}
        self.row = dict(taskId=self.task['id'], projectId=self.task['project'], criteriaDigest='b' * 64,
                        evidenceDigest='c' * 64, reason='task_specification_unusable',
                        evidence=['https://api.crossref.org/works/10.54499%2F2024.03713.bdana'])

    def tearDown(self):
        for name, value in self.saved.items():
            setattr(m, name, value)

    def run_with(self, holds):
        from unittest.mock import patch
        with patch.object(m.os, 'geteuid', return_value=0), patch.object(m, 'load_task_holds', return_value=holds):
            return m.run()

    def test_matching_hold_replenishes_usable_stock_without_mutating_native_contract(self):
        before = json.loads(json.dumps(self.states))
        result = self.run_with({self.row['taskId']: self.row})
        self.assertEqual(result['open'], [])
        self.assertEqual(result['held'], ['OPP-00004'])
        self.assertEqual(self.advanced, ['OPP-00009'])
        self.assertEqual(self.states, before)
        self.assertEqual(result['advanced'], {'project': 'OPP-00009', 'status': 'pending'})

    def test_absent_holds_preserve_existing_stock_report_and_do_not_advance(self):
        result = self.run_with({})
        self.assertEqual(result, {'schema': 'uain-organization-starter-run-v2', 'open': ['OPP-00004'],
                                  'min_open': 1, 'advanced': None})
        self.assertEqual(self.advanced, [])

    def test_other_contract_or_changed_hash_is_not_silently_held(self):
        for change in [{'taskId': 'T-replacement'}, {'projectId': 'P-other'},
                       {'criteriaDigest': 'd' * 64}, {'evidenceDigest': 'e' * 64}]:
            row = dict(self.row, **change)
            with self.subTest(change=change):
                result = self.run_with({row['taskId']: row})
                self.assertEqual(result['open'], ['OPP-00004'])
                self.assertEqual(result['held'], [])
                self.assertEqual(self.advanced, [])

    def test_pending_or_winning_work_is_never_relabelled_operator_held(self):
        for change in [{'state': 'under_review', 'pending': 'S-pending'},
                       {'state': 'accepted', 'winner': 'S-done'}]:
            self.states['OPP-00004'] = dict(self.task, **change)
            with self.subTest(change=change):
                result = self.run_with({self.row['taskId']: self.row})
                self.assertEqual(result['held'], [])
                self.assertEqual(result['open'], [])
                self.assertEqual(self.states['OPP-00004'], dict(self.task, **change))
        self.assertEqual(self.advanced, ['OPP-00009', 'OPP-00009'])

    def test_untrusted_policy_stops_before_native_read_or_advancement(self):
        from unittest.mock import patch
        reads = []
        m.survey_states = lambda order: reads.append(order) or self.states
        with patch.object(m.os, 'geteuid', return_value=0), patch.object(m, 'load_task_holds', side_effect=m.Stop('invalid_task_holds')):
            with self.assertRaisesRegex(m.Stop, 'invalid_task_holds'):
                m.run()
        self.assertEqual((reads, self.advanced), ([], []))


class OrganizationStarterRefundAndSkip(unittest.TestCase):
    """FICTIONAL native states; custody is recorded, never executed (decision N4, 9 Nov 2026)."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.saved = {name: getattr(m, name) for name in ('load_order', 'survey_states', 'finalized', 'load_authority',
                                                           'custody', 'FLEET_ROOT', 'load_task_holds', 'journal')}
        m.FLEET_ROOT = Path(self.temp.name)
        self.order = {'schema': m.ORDER_SCHEMA, 'projects': ['OPP-00006', 'OPP-00011', 'OPP-00012'], 'min_open': 1}
        self.task = {'id': 'T-OPP-00006-1-prior-art-survey', 'project': 'P-OPP-00006', 'acceptance_digest': 'b' * 64,
                     'evidence_digest': 'c' * 64, 'state': 'open_unfunded', 'pending': '', 'winner': '', 'reserved': '0',
                     'paid': '50000000', 'solver_amount': '200000000', 'reviewer_amount': '50000000'}
        self.states = {'OPP-00006': self.task}
        self.calls, self.results, self.journals = [], {}, {}
        m.load_order = lambda: self.order
        m.survey_states = lambda order: self.states
        m.load_task_holds = lambda: {}
        m.journal = lambda project, intent: self.journals.get(intent)
        m.finalized = lambda project, intent: (intent == 'survey-OPP-00006' or any(
            type(j) == dict and j.get('receipt') is not None for i, j in self.journals.items() if i.split('-r')[0] == intent))
        m.load_authority = self.authority
        m.custody = lambda verb, project, intent: self.calls.append((verb, project, intent)) or self.results.get(project, {'status': 'finalized'})

    def tearDown(self):
        for name, value in self.saved.items():
            setattr(m, name, value)
        self.temp.cleanup()

    def authority(self, project):
        requests = {name: {'id': '%s-%s' % (name, project), 'member': 'uain1' + 'a' * 40, 'operation': op,
                           'payload': {'id': 'T-%s-1-prior-art-survey' % project} if name == 'survey' else {}}
                    for name, _, op in m.STAGES}
        return {'requests': requests}

    def run_it(self):
        from unittest.mock import patch
        with patch.object(m.os, 'geteuid', return_value=0):
            return m.run()

    def test_rejection_refunds_and_reopens_from_allowance_before_new_openings(self):
        result = self.run_it()
        self.assertEqual(self.calls, [('sign', 'OPP-00006', 'fund-T-OPP-00006-1-prior-art-survey-1')])
        self.assertEqual(result['refunded'][0]['status'], 'finalized')
        self.assertIsNone(result['advanced'])
        request = json.loads((m.FLEET_ROOT / 'OPP-00006' / 'fund-T-OPP-00006-1-prior-art-survey-1.request.json').read_text())
        evidence = (m.FLEET_ROOT / 'OPP-00006' / 'fund-T-OPP-00006-1-prior-art-survey-1.evidence.json').read_bytes()
        self.assertEqual(request['operation'], 'central_task_fund')
        self.assertEqual(request['payload'], {'task': self.task['id'], 'evidence_digest': hashlib.sha256(evidence).hexdigest()})
        self.assertEqual(json.loads(evidence)['rejection'], 1)

    def test_each_rejection_is_a_new_intent_and_the_third_goes_to_specification_review(self):
        self.task['paid'] = '100000000'
        self.run_it()
        self.assertEqual(self.calls[-1][2], 'fund-T-OPP-00006-1-prior-art-survey-2')
        self.calls.clear()
        self.task['paid'] = '150000000'
        result = self.run_it()
        self.assertEqual(result['specification_review'], ['T-OPP-00006-1-prior-art-survey'])
        self.assertNotIn('refunded', result)
        self.assertTrue(all(call[2].startswith('survey-OPP-00011') or call[1] != 'OPP-00006' for call in self.calls))

    def test_a_sent_refund_is_settled_from_its_journal_before_anything_else(self):
        self.run_it()
        intent = 'fund-T-OPP-00006-1-prior-art-survey-1'
        # Native reopened the task, but the journal has no receipt yet (the live 9 Nov case).
        self.journals[intent] = {'envelope': {}, 'receipt': None}
        self.task.update(state='open', reserved='250000000')
        self.calls.clear()
        result = self.run_it()
        self.assertEqual(self.calls, [('sign', 'OPP-00006', intent)])
        self.assertEqual(result['settled_refund']['intent'], intent)
        self.journals[intent] = {'envelope': {}, 'receipt': {'height': '1'}}
        self.calls.clear()
        self.assertNotIn('settled_refund', self.run_it())
        self.assertNotIn(('sign', 'OPP-00006', intent), self.calls)

    def test_held_unfunded_task_is_never_refunded(self):
        row = dict(taskId=self.task['id'], projectId='P-OPP-00006', criteriaDigest='b' * 64, evidenceDigest='c' * 64,
                   reason='task_specification_unusable', evidence=['https://api.crossref.org/works/10.67599%2Fanr-20-ce18-0001'])
        m.load_task_holds = lambda: {row['taskId']: row}
        result = self.run_it()
        self.assertEqual(result['held'], ['OPP-00006'])
        self.assertNotIn('refunded', result)
        self.assertNotIn(('sign', 'OPP-00006', 'fund-T-OPP-00006-1-prior-art-survey-1'), self.calls)

    def test_accepted_under_review_and_pending_tasks_are_not_refunded(self):
        for change in [{'state': 'accepted', 'winner': 'S-1'}, {'state': 'under_review', 'pending': 'S-2'},
                       {'state': 'open', 'reserved': '250000000'}]:
            self.states['OPP-00006'] = dict(self.task, **change)
            self.calls.clear()
            with self.subTest(change=change):
                self.assertNotIn('refunded', self.run_it())
                self.assertFalse([c for c in self.calls if c[2].startswith('fund-')])

    def test_unexpected_accounting_stops_instead_of_guessing_a_count(self):
        self.task['paid'] = '12345'
        from unittest.mock import patch
        with patch.object(m.os, 'geteuid', return_value=0), self.assertRaisesRegex(m.Stop, 'task_accounting_unexpected'):
            m.run()

    def test_blocked_project_is_skipped_and_the_next_project_advances(self):
        self.task.update(state='accepted', winner='S-1', paid='250000000')
        self.results['OPP-00011'] = {'status': 'refused', 'code': 'native_bootstrap_conflict'}
        result = self.run_it()
        self.assertEqual(result['skipped'], [{'project': 'OPP-00011', 'stage': 'open', 'status': 'refused', 'code': 'native_bootstrap_conflict'}])
        self.assertEqual(result['advanced']['project'], 'OPP-00012')

    def test_exhausted_or_invalid_authority_is_skipped_not_fatal(self):
        self.task.update(state='accepted', winner='S-1', paid='250000000')
        original = m.load_authority
        m.load_authority = lambda project: (_ for _ in ()).throw(m.Stop('invalid_authority')) if project == 'OPP-00011' else original(project)
        result = self.run_it()
        self.assertEqual(result['skipped'][0], {'project': 'OPP-00011', 'status': 'refused', 'code': 'invalid_authority'})
        self.assertEqual(result['advanced']['project'], 'OPP-00012')

    def test_in_flight_stage_stops_the_run_without_advancing_others(self):
        self.task.update(state='accepted', winner='S-1', paid='250000000')
        self.results['OPP-00011'] = {'status': 'pending'}
        result = self.run_it()
        self.assertEqual(result['advanced']['project'], 'OPP-00011')
        self.assertEqual({c[1] for c in self.calls}, {'OPP-00011'})


class OrganizationStarterSurveyParts(unittest.TestCase):
    """The committed OPP-00004 part build (docs/baink/.../survey-parts) against FICTIONAL native state."""
    PARTS = Path(__file__).resolve().parents[2] / 'docs/baink/project-organizations-2026-11-06/survey-parts/OPP-00004.parts.json'

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.saved = {name: getattr(m, name) for name in ('load_order', 'finalized', 'load_authority', 'custody', 'FLEET_ROOT',
                                                           'load_task_holds', 'protected', 'read_tasks', 'advance', 'AUTHORITY_DIR')}
        m.FLEET_ROOT = Path(self.temp.name)
        # The reviewed parts file exists (its content is served by the patched `protected`).
        m.AUTHORITY_DIR = Path(self.temp.name) / 'authority'
        m.AUTHORITY_DIR.mkdir()
        (m.AUTHORITY_DIR / 'OPP-00004.parts.json').write_text('{}')
        m.advance = lambda project: {'project': project, 'stage': 'open', 'status': 'pending'}
        self.built = json.loads(self.PARTS.read_text())
        self.manager = self.built['parts'][0]['request']['member']
        self.order = {'schema': m.ORDER_SCHEMA, 'projects': ['OPP-00004', 'OPP-00011'], 'min_open': 4, 'parts': ['OPP-00004']}
        self.opened, self.calls = set(), []
        self.tasks = {}
        real_protected = m.protected
        m.protected = lambda path, limit=m.LIMIT: self.built if str(path).endswith('.parts.json') else real_protected(path, limit)
        m.load_order = lambda: self.order
        m.load_task_holds = lambda: {}
        m.finalized = lambda project, intent: intent == 'survey-OPP-00004' or intent in self.opened
        m.load_authority = lambda project: {'requests': {'survey': {'id': 'survey-' + project, 'member': self.manager,
                                                                    'payload': {'id': 'T-%s-1-prior-art-survey' % project}}}}
        m.read_tasks = lambda ids: {t: self.tasks.get(t, {'id': t, 'state': 'open', 'pending': '', 'winner': ''}) for t in ids}
        m.custody = self.sign

    def sign(self, verb, project, intent):
        self.calls.append(intent)
        self.opened.add(intent)
        return {'status': 'finalized'}

    def tearDown(self):
        for name, value in self.saved.items():
            setattr(m, name, value)
        self.temp.cleanup()

    def run_it(self):
        from unittest.mock import patch
        with patch.object(m.os, 'geteuid', return_value=0):
            return m.run()

    def test_parts_open_one_per_run_and_count_as_stock(self):
        self.tasks['T-OPP-00004-1-prior-art-survey'] = {'id': 'T-OPP-00004-1-prior-art-survey', 'state': 'accepted', 'winner': 'S'}
        first = self.run_it()
        self.assertEqual(first['opened_part']['task'], 'T-OPP-00004-1-prior-art-survey-r2-p1')
        self.assertEqual(self.calls, ['survey-OPP-00004-r2-p1'])
        request = json.loads((m.FLEET_ROOT / 'OPP-00004' / 'survey-OPP-00004-r2-p1.request.json').read_text())
        self.assertEqual(request, self.built['parts'][0]['request'])
        self.run_it(), self.run_it()
        self.assertEqual(self.calls, ['survey-OPP-00004-r2-p1', 'survey-OPP-00004-r2-p2', 'survey-OPP-00004-r2-p3'])
        result = self.run_it()
        self.assertEqual(len(result['open_parts']), 3)
        self.assertEqual(result['advanced']['project'], 'OPP-00011')

    def test_rejected_part_is_refunded_with_its_own_intent(self):
        for row in self.built['parts']:
            self.opened.add(row['request']['id'])
        part = self.built['parts'][1]['request']['payload']
        self.tasks[part['id']] = dict(id=part['id'], project='P-OPP-00004', state='open_unfunded', pending='', winner='', reserved='0',
                                      paid='10000000', reviewer_amount='10000000', solver_amount=part['solver_amount'],
                                      acceptance_digest=part['acceptance_digest'], evidence_digest=part['evidence_digest'])
        result = self.run_it()
        self.assertEqual(self.calls, ['fund-T-OPP-00004-1-prior-art-survey-r2-p2-1'])
        self.assertEqual(result['refunded'][0]['status'], 'finalized')

    def test_parts_signed_by_another_member_or_overpriced_are_refused(self):
        for change in [('member', 'uain1' + 'f' * 40), ('solver_amount', '200000000'), ('id', 'T-OPP-00005-1-prior-art-survey-r2-p1')]:
            built = json.loads(self.PARTS.read_text())
            if change[0] == 'member':
                built['parts'][0]['request']['member'] = change[1]
            else:
                built['parts'][0]['request']['payload'][change[0]] = change[1]
            self.built = built
            with self.subTest(change=change[0]), self.assertRaisesRegex(m.Stop, 'invalid_parts'):
                m.load_parts('OPP-00004')

    def test_order_parts_must_be_listed_projects(self):
        real = self.saved['load_order']
        from unittest.mock import patch
        with patch.object(m, 'protected', return_value={'schema': m.ORDER_SCHEMA, 'projects': ['OPP-00004'], 'min_open': 3, 'parts': ['OPP-00005']}):
            with self.assertRaisesRegex(m.Stop, 'invalid_order'):
                real()


class OrganizationStarterPartsFirst(OrganizationStarterSurveyParts):
    """Parts-first projects (authority v2, 9 November 2026): five stages, then parts only."""
    # The inherited single-project cases run in the parent class only.
    test_parts_open_one_per_run_and_count_as_stock = None
    test_rejected_part_is_refunded_with_its_own_intent = None
    test_parts_signed_by_another_member_or_overpriced_are_refused = None
    test_order_parts_must_be_listed_projects = None

    def setUp(self):
        super().setUp()
        self.order = {'schema': m.ORDER_SCHEMA, 'projects': ['OPP-00004', 'OPP-00005'], 'min_open': 8, 'parts': ['OPP-00004', 'OPP-00005']}
        self.parts_first = {'OPP-00005'}
        self.reviewed = set()
        b4, b5 = json.loads(self.PARTS.read_text()), json.loads(self.PARTS.read_text())
        for row in b5['parts']:
            row['request']['id'] = row['request']['id'].replace('OPP-00004', 'OPP-00005')
            row['request']['payload']['id'] = row['request']['payload']['id'].replace('OPP-00004', 'OPP-00005')
        b5['project'] = 'OPP-00005'
        self.builds = {'OPP-00004': b4, 'OPP-00005': b5}
        real_protected = self.saved['protected']
        m.protected = lambda path, limit=m.LIMIT: self.builds[Path(path).name[:9]] if str(path).endswith('.parts.json') else real_protected(path, limit)
        m.load_parts = lambda project, authority=None: [(r['request'], r['policy']) for r in self.builds[project]['parts']]
        m.finalized = lambda project, intent: intent == 'survey-OPP-00004' or intent in self.opened or intent in self.reviewed
        m.load_authority = self.authority_of
        m.advance = self.advance

    def tearDown(self):
        m.load_parts = self.saved_load_parts
        super().tearDown()

    def run(self, result=None):
        self.saved_load_parts = m.load_parts
        return super().run(result)

    def authority_of(self, project):
        if project in self.parts_first:
            return {'schema': m.PARTS_AUTHORITY_SCHEMA, 'requests': {'start': {'id': 'start-' + project, 'member': self.manager},
                                                                     'review': {'id': 'review-%s-1' % project}}}
        return {'requests': {'survey': {'id': 'survey-' + project, 'member': self.manager, 'payload': {'id': 'T-%s-1-prior-art-survey' % project}}}}

    def advance(self, project):
        self.reviewed.add('review-%s-1' % project)
        return {'project': project, 'stage': 'review', 'status': 'finalized'}

    def test_parts_wait_for_the_plan_review_then_rotate_across_projects(self):
        self.tasks['T-OPP-00004-1-prior-art-survey'] = {'id': 'T-OPP-00004-1-prior-art-survey', 'state': 'accepted', 'winner': 'S'}
        first = self.run_it()
        # Only the existing project's part is ready; the parts-first project has no plan review yet.
        self.assertEqual(self.calls, ['survey-OPP-00004-r2-p1'])
        self.assertEqual(first['opened_part']['project'], 'OPP-00004')
        for _ in range(2):
            self.run_it()
        self.assertEqual(self.calls[1:], ['survey-OPP-00004-r2-p2', 'survey-OPP-00004-r2-p3'])
        advanced = self.run_it()
        self.assertEqual(advanced['advanced'], {'project': 'OPP-00005', 'stage': 'review', 'status': 'finalized'})
        self.run_it(), self.run_it(), self.run_it()
        self.assertEqual(self.calls[3:], ['survey-OPP-00005-r2-p1', 'survey-OPP-00005-r2-p2', 'survey-OPP-00005-r2-p3'])
        final = self.run_it()
        self.assertEqual(len(final['open_parts']), 6)
        self.assertTrue(final['exhausted'])

    def test_first_parts_of_every_ready_project_open_before_second_parts(self):
        self.reviewed.add('review-OPP-00005-1')
        for _ in range(4):
            self.run_it()
        self.assertEqual(self.calls, ['survey-OPP-00004-r2-p1', 'survey-OPP-00005-r2-p1', 'survey-OPP-00004-r2-p2', 'survey-OPP-00005-r2-p2'])

    def test_a_rejected_parts_first_part_is_refunded_by_the_start_guardian(self):
        self.reviewed.add('review-OPP-00005-1')
        for build in self.builds.values():
            for row in build['parts']:
                self.opened.add(row['request']['id'])
        part = self.builds['OPP-00005']['parts'][0]['request']['payload']
        self.tasks[part['id']] = dict(id=part['id'], project='P-OPP-00005', state='open_unfunded', pending='', winner='', reserved='0',
                                      paid='10000000', reviewer_amount='10000000', solver_amount=part['solver_amount'],
                                      acceptance_digest=part['acceptance_digest'], evidence_digest=part['evidence_digest'])
        m.load_parts = lambda project, authority=None: [(r['request'], r['policy']) for r in self.builds[project]['parts']]
        result = self.run_it()
        self.assertEqual(result['refunded'][0]['status'], 'finalized')
        request = json.loads((m.FLEET_ROOT / 'OPP-00005' / self.calls[0]).with_suffix('.request.json').read_text())
        self.assertEqual(request['member'], self.manager)

    def test_min_open_may_cover_150_tasks_but_stays_bounded(self):
        real = self.saved['load_order']
        from unittest.mock import patch
        for value, ok in ((150, True), (m.MAX_MIN_OPEN, True), (m.MAX_MIN_OPEN + 1, False), (0, False)):
            with self.subTest(value=value), patch.object(m, 'protected', return_value={'schema': m.ORDER_SCHEMA, 'projects': ['OPP-00004'], 'min_open': value}):
                if ok:
                    self.assertEqual(real()['min_open'], value)
                else:
                    with self.assertRaisesRegex(m.Stop, 'invalid_order'):
                        real()


class OrganizationStarterAgentRevisions(OrganizationStarterSurveyParts):
    """Later revisions written by the project agents load after the reviewed parts."""
    test_parts_open_one_per_run_and_count_as_stock = None
    test_rejected_part_is_refunded_with_its_own_intent = None
    test_parts_signed_by_another_member_or_overpriced_are_refused = None
    test_order_parts_must_be_listed_projects = None

    def agent_build(self, revision):
        built = json.loads(self.PARTS.read_text())
        built['revision'] = revision
        for n, row in enumerate(built['parts'], 1):
            row['request']['id'] = 'survey-OPP-00004-r%d-p%d' % (revision, n)
            row['request']['payload']['id'] = 'T-OPP-00004-1-prior-art-survey-r%d-p%d' % (revision, n)
            row['policy']['taskId'] = row['request']['payload']['id']
        return built

    def with_files(self, files, reviewed=True):
        directory = Path(self.temp.name) / 'authority'
        directory.mkdir(exist_ok=True)
        for name in files:
            (directory / name).write_text('{}')
        if reviewed:
            (directory / 'OPP-00004.parts.json').write_text('{}')
        elif (directory / 'OPP-00004.parts.json').exists():
            (directory / 'OPP-00004.parts.json').unlink()
        self.saved.setdefault('AUTHORITY_DIR', m.AUTHORITY_DIR)
        m.AUTHORITY_DIR = directory
        builds = {'OPP-00004.parts.json': self.built, **files}
        m.protected = lambda path, limit=m.LIMIT: builds[Path(path).name]

    def test_agent_revision_opens_after_the_reviewed_parts(self):
        self.with_files({'OPP-00004.agent-r3.parts.json': self.agent_build(3), 'OPP-00005.agent-r3.parts.json': {}})
        ids = [r['id'] for r, _ in m.load_parts('OPP-00004')]
        self.assertEqual(ids[:3], ['survey-OPP-00004-r2-p1', 'survey-OPP-00004-r2-p2', 'survey-OPP-00004-r2-p3'])
        self.assertEqual(ids[3:], ['survey-OPP-00004-r3-p1', 'survey-OPP-00004-r3-p2', 'survey-OPP-00004-r3-p3'])
        self.tasks['T-OPP-00004-1-prior-art-survey'] = {'id': 'T-OPP-00004-1-prior-art-survey', 'state': 'accepted', 'winner': 'S'}
        for _ in range(4):
            self.run_it()
        self.assertEqual(self.calls[3], 'survey-OPP-00004-r3-p1')

    def test_v1_project_without_reviewed_parts_serves_agent_revisions(self):
        """OPP-00002/03/09/10/14 (10 November 2026): the full survey opened, no reviewed parts file
        exists, and the project agents' revisions still load and open, first part first."""
        self.with_files({'OPP-00004.agent-r3.parts.json': self.agent_build(3), 'OPP-00004.agent-r4.parts.json': self.agent_build(4)}, reviewed=False)
        ids = [r['id'] for r, _ in m.load_parts('OPP-00004')]
        self.assertEqual(ids, ['survey-OPP-00004-r3-p%d' % n for n in (1, 2, 3)] + ['survey-OPP-00004-r4-p%d' % n for n in (1, 2, 3)])
        self.tasks['T-OPP-00004-1-prior-art-survey'] = {'id': 'T-OPP-00004-1-prior-art-survey', 'state': 'open', 'pending': '', 'winner': ''}
        first = self.run_it()
        self.assertEqual(first['opened_part']['task'], 'T-OPP-00004-1-prior-art-survey-r3-p1')
        # The open full survey and the new part both count as stock.
        self.assertEqual(self.run_it()['open'], ['OPP-00004'])

    def test_project_listed_for_parts_with_no_part_file_yet_loads_nothing(self):
        self.with_files({}, reviewed=False)
        self.assertEqual(m.load_parts('OPP-00004'), [])
        result = self.run_it()
        self.assertEqual(self.calls, [])
        self.assertEqual(result['open_parts'], [])
        self.assertEqual(result['advanced']['project'], 'OPP-00011')

    def test_v1_parts_wait_until_the_survey_opening_finalized(self):
        self.with_files({'OPP-00004.agent-r3.parts.json': self.agent_build(3)}, reviewed=False)
        m.finalized = lambda project, intent: intent in self.opened
        result = self.run_it()
        self.assertNotIn('opened_part', result)
        self.assertFalse(any(c.startswith('survey-OPP-00004-r3') for c in self.calls))

    def test_a_broken_reviewed_parts_link_is_not_absence(self):
        self.with_files({}, reviewed=False)
        (m.AUTHORITY_DIR / 'OPP-00004.parts.json').symlink_to(m.AUTHORITY_DIR / 'missing.json')
        self.assertEqual(m.reviewed_part_files('OPP-00004'), [m.AUTHORITY_DIR / 'OPP-00004.parts.json'])

    def test_misnamed_repeated_or_foreign_agent_revisions_refuse(self):
        for files in ({'OPP-00004.agent-r4.parts.json': self.agent_build(3)},
                      {'OPP-00004.agent-r3.parts.json': self.agent_build(2)},
                      {'OPP-00004.agent-r3.parts.json': dict(self.agent_build(3), project='OPP-00005')}):
            with self.subTest(files=list(files)):
                self.with_files(files)
                with self.assertRaisesRegex(m.Stop, 'invalid_parts'):
                    m.load_parts('OPP-00004')
                for name in files:
                    (m.AUTHORITY_DIR / name).unlink()


class OrganizationStarterAuthorityV2(unittest.TestCase):
    """The strict loader accepts a five-stage parts-first authority and nothing looser."""

    def authority(self, schema=None, stages=None, extra=None):
        names = [s[0] for s in (m.STAGES[:5] if stages is None else stages)]
        requests = {n: {'id': n + '-OPP-00005', 'member': 'uain1' + 'a' * 40, 'operation': op, 'payload': {}} for n, _, op in m.STAGES if n in names}
        requests.update(extra or {})
        return {'schema': schema or m.PARTS_AUTHORITY_SCHEMA, 'project': 'OPP-00005', 'native_project': 'P-OPP-00005', 'requests': requests,
                'stages': [{'name': n, 'operation': op, 'request': n + '-OPP-00005'} for n, _, op in m.STAGES if n in names]}

    def load(self, value):
        from unittest.mock import patch
        with patch.object(m, 'protected', return_value=value):
            return m.load_authority('OPP-00005')

    def test_five_stage_authority_loads_and_its_guardian_opens_parts(self):
        a = self.load(self.authority())
        self.assertEqual([s[0] for s in m.stages_of(a)], ['open', 'start', 'configure', 'plan', 'review'])
        self.assertEqual(m.budget_manager(a), 'uain1' + 'a' * 40)

    def test_v2_with_a_survey_stage_or_extra_request_and_v1_without_one_refuse(self):
        survey = {'survey': {'id': 'survey-OPP-00005', 'member': 'uain1' + 'a' * 40, 'operation': 'central_task_open', 'payload': {}}}
        for value in (self.authority(stages=m.STAGES), self.authority(extra=survey), self.authority(schema=m.AUTHORITY_SCHEMA),
                      self.authority(schema='uain-organization-starter-authority-v3')):
            with self.subTest(), self.assertRaisesRegex(m.Stop, 'invalid_authority'):
                self.load(value)


class OrganizationStarterReadsAndFiles(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.saved = {name: getattr(m, name) for name in ('custody', 'finalized', 'FLEET_ROOT')}
        m.FLEET_ROOT = Path(self.temp.name)

    def tearDown(self):
        for name, value in self.saved.items():
            setattr(m, name, value)
        self.temp.cleanup()

    def test_status_reads_more_than_64_projects_in_chunks(self):
        projects = ['OPP-%05d' % n for n in range(1, 121)]
        reads = []
        m.finalized = lambda project, intent: True
        m.custody = lambda verb, keys: reads.append(json.loads(keys)) or {
            'status': 'read', 'records': {k: {'id': k} for k in json.loads(keys)}}
        states = m.survey_states({'projects': projects})
        self.assertEqual([len(r) for r in reads], [10] * 12)
        self.assertEqual(len(states), 120)
        self.assertEqual(states['OPP-00120'], {'id': 'central_task/T-OPP-00120-1-prior-art-survey'})

    def test_task_states_are_reproved_at_most_every_max_age_and_new_ids_read_alone(self):
        reads = []
        m.custody = lambda verb, keys: reads.append(json.loads(keys)) or {
            'status': 'read', 'records': {k: {'id': k, 'n': len(reads)} for k in json.loads(keys)}}
        ids = ['T-%d' % n for n in range(25)]
        first = m.read_tasks(ids, now=1000)
        self.assertEqual([len(r) for r in reads], [10, 10, 5])
        self.assertEqual(m.read_tasks(ids, now=1100), first)
        self.assertEqual(len(reads), 3)
        m.read_tasks(ids + ['T-new'], now=1110)
        self.assertEqual(reads[-1], ['central_task/T-new'])
        m.forget_task('T-3', now=1112)
        m.read_tasks(ids, now=1115)
        self.assertEqual(reads[-1], ['central_task/T-3'])
        m.read_tasks(ids, now=1000 + m.STATE_MAX_AGE + 1)
        self.assertEqual(sum(len(r) for r in reads[-3:]), 25)

    def test_stale_temp_file_from_an_interrupted_run_is_replaced(self):
        directory = m.FLEET_ROOT / 'OPP-00011'
        directory.mkdir()
        (directory / 'open-OPP-00011.request.tmp').write_text('partial')
        request = {'id': 'open-OPP-00011.request', 'member': 'm', 'operation': 'open_project', 'payload': {}}
        request['id'] = 'open-OPP-00011'
        m.write_request('OPP-00011', request)
        self.assertEqual(json.loads((directory / 'open-OPP-00011.request.json').read_text()), request)
        self.assertFalse((directory / 'open-OPP-00011.request.tmp').exists())

    def test_non_json_or_empty_child_output_is_a_refusal_not_a_crash(self):
        self.assertEqual(m.parse_child('Traceback (most recent call last):', '', 1), {'status': 'refused', 'code': 'unparseable_output'})
        self.assertEqual(m.parse_child('', '', 1), {'status': 'refused', 'code': 'no_output'})
        self.assertEqual(m.parse_child('[1, 2]', '', 0), {'status': 'refused', 'code': 'unparseable_output'})
        self.assertEqual(m.parse_child('', '{"status":"refused","code":"usage"}', 1), {'status': 'refused', 'code': 'usage'})
        self.assertEqual(m.parse_child('{"status":"finalized"}', '', 1)['status'], 'refused')
        self.assertEqual(m.parse_child('noise\n{"status":"finalized"}', '', 0), {'status': 'finalized'})


class OrganizationStarterHoldPolicy(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.root.chmod(0o700)
        self.path = self.root / 'task-holds.json'
        self.row = dict(taskId='T-OPP-00004-1-prior-art-survey', projectId='P-OPP-00004',
                        criteriaDigest='b' * 64, evidenceDigest='c' * 64, reason='task_specification_unusable',
                        evidence=['https://api.crossref.org/works/10.54499%2F2024.03713.bdana'])
        self.policy = dict(schema='baink-central-task-holds-v1', chainId='uain-shadow-20261008-1',
                           genesisSha256='54140a9243c4591ccc9f2e9d49543fc68b87b3e0045416174c232e9dd498f8ff', holds=[self.row])
        self.save()

    def tearDown(self):
        self.temp.cleanup()

    def save(self):
        self.path.write_text(json.dumps(self.policy))
        self.path.chmod(0o600)

    def load(self):
        return m.load_task_holds(self.path, trusted_uids=(os.getuid(),), boundary=self.root)

    def test_private_complete_same_network_policy_and_optional_absence(self):
        self.assertEqual(self.load(), {self.row['taskId']: self.row})
        self.path.unlink()
        self.assertEqual(self.load(), {})

    def test_wrong_network_duplicates_unknown_fields_and_arbitrary_reason_refuse(self):
        original = json.loads(json.dumps(self.policy))
        mutations = [lambda p: p.update(chainId='other-chain'), lambda p: p.update(genesisSha256='f' * 64),
                     lambda p: p.update(extra=True), lambda p: p['holds'].append(p['holds'][0]),
                     lambda p: p['holds'][0].update(reason='reward_limit'),
                     lambda p: p['holds'][0].update(evidence=['https://127.0.0.1/private']),
                     lambda p: p['holds'][0].update(criteriaDigest='not-a-hash'),
                     lambda p: p['holds'][0].update(extra=True)]
        for mutate in mutations:
            self.policy = json.loads(json.dumps(original))
            mutate(self.policy)
            self.save()
            with self.subTest(policy=self.policy), self.assertRaisesRegex(m.Stop, 'invalid_task_holds'):
                self.load()

    def test_duplicate_json_keys_refuse(self):
        self.path.write_text('{"schema":"baink-central-task-holds-v1","schema":"other"}')
        with self.assertRaisesRegex(m.Stop, 'duplicate_key'):
            self.load()

    def test_public_symlink_hardlink_and_writable_parent_refuse(self):
        self.path.chmod(0o644)
        with self.assertRaises(m.Stop):
            self.load()
        self.path.chmod(0o600)
        target = self.root / 'target.json'
        self.path.rename(target)
        self.path.symlink_to(target)
        with self.assertRaises(m.Stop):
            self.load()
        self.path.unlink()
        os.link(target, self.path)
        with self.assertRaises(m.Stop):
            self.load()
        target.unlink()
        self.root.chmod(0o777)
        with self.assertRaises(m.Stop):
            self.load()

    def test_malformed_json_missing_parent_and_wrong_owner_are_not_optional_absence(self):
        self.path.write_text('{not valid json')
        with self.assertRaisesRegex(m.Stop, 'invalid_task_holds'):
            self.load()
        self.save()
        with self.assertRaises(m.Stop):
            m.load_task_holds(self.path, trusted_uids=(os.getuid() + 1,), boundary=self.root)
        with self.assertRaises(FileNotFoundError):
            m.load_task_holds(self.root / 'missing-parent' / 'task-holds.json', trusted_uids=(os.getuid(),), boundary=self.root)

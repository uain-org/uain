"""Fleet custody tests. FICTIONAL keys and state only; no root, vault or network."""
import copy
import datetime
import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
import unittest.mock
from pathlib import Path

spec = importlib.util.spec_from_file_location('project_organizations', Path(__file__).with_name('project_organizations.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

HERE = Path(__file__).absolute().parent
ME = (0, os.getuid())  # tests trust their own uid in place of root; checks are unchanged
NOW = 1793966400


def address(label):
    return 'uain1' + hashlib.sha256(label.encode()).hexdigest()[:40]


MANAGER_A, MANAGER_B, EVALUATOR, SOLVER, OUTSIDER = (address(x) for x in ('manager-a', 'manager-b', 'evaluator', 'solver', 'outsider'))
IDS = ['OPP-%05d' % n for n in range(1, 121)]
A, B, C = IDS[:3]


def manifest():
    return dict(schema='uain-project-organization-selection-v1', observedAt='2026-11-05T00:00:00Z', count=120,
                selection='FICTIONAL fixture', authority='test',
                projects=[dict(id=i, sourceDigest=hashlib.sha256(('source ' + i).encode()).hexdigest(),
                               modelPlanDigest='a' * 64, kpi=dict(statement='Outcome ' + i, threshold=None, unit=None,
                                                                   comparator=None, qualification='Fixture')) for i in IDS])


SELECTION = m.selection_of(manifest())


def policy(**changes):
    def row(project, manager, n):
        return dict(native_project='P-' + project, source_digest=SELECTION['projects'][project],
                    paperclip_company='00000000-0000-4000-8000-%012d' % n, manager=manager, evaluator=EVALUATOR,
                    max_task_units='2000000', max_plan_revision=3)
    p = dict(schema=m.POLICY_SCHEMA, revision=1, selection_digest=SELECTION['digest'],
             projects={A: row(A, MANAGER_A, 1), B: row(B, MANAGER_B, 2)},
             roles={k: list(v) for k, v in m.NATIVE_ROLE_OPERATIONS.items()}, solvers=[SOLVER])
    p.update(changes)
    return p


def command(member, operation, payload, sequence='4'):
    return dict(version=1, chain_id=m.CHAIN, member=member, sequence=sequence, expires_height='200', operation=operation, payload=payload)


def plan_payload(project=A, revision=1):
    return dict(project='P-' + project, revision=revision, main_kpi='Independently verified outcome for ' + project,
                stages=[dict(round=n, criteria='Measured and independently checked evidence for stage %d' % n) for n in range(1, 6)],
                reason='Decomposition of the fixed Main KPI.', evidence_digest='a' * 64)


CRITERIA = 'Produce a reproducible original result meeting the stated bound.'


def task_payload(project=A, solver='1000000', reviewer='100000'):
    return dict(id='T-' + project, project='P-' + project, title='Bounded research task', criteria=CRITERIA,
                acceptance_digest=m.sha(CRITERIA.encode()), eligibility='unresolved', eligibility_digest='b' * 64,
                solver_amount=solver, reviewer_amount=reviewer, evidence_digest='c' * 64)


def open_payload(project=A):
    return {'id': 'P-' + project, 'title': 'FICTIONAL bounded research question ' + project, 'class': 'benevolent',
            'prior_art': dict(basis='No open or discoverable solution answers this exact bounded question (fixture).',
                              searches=['fixture search one ' + project, 'fixture search two ' + project])}


class PolicyTests(unittest.TestCase):
    def test_starter_organization_binding(self):
        # Decision D2 (6 November 2026): starter organizations run before Paperclip exists,
        # with the guardian as budget manager (the live pilot pattern) and the Fund Manager evaluating.
        rows = policy()['projects']
        starter = {k: dict(v, manager=m.GUARDIAN, evaluator=m.FUND_MANAGER, paperclip_company=None) for k, v in rows.items()}
        self.assertTrue(m.validate_policy(dict(policy(), projects=starter), SELECTION))
        shared = dict(rows[B], manager=rows[A]['manager'], paperclip_company=None)
        with self.assertRaises(m.Refused) as caught:
            m.validate_policy(dict(policy(), projects={A: rows[A], B: shared}), SELECTION)
        self.assertEqual(caught.exception.code, 'duplicate_binding')
        self.assertEqual(m.key_attachment('manager', m.GUARDIAN), m.GUARDIAN_KEY)
        self.assertEqual(m.key_attachment('evaluator', m.FUND_MANAGER), m.FUND_MANAGER_KEY)
        self.assertEqual(m.key_attachment('manager', rows[A]['manager']), 'keys/project-organizations/' + rows[A]['manager'] + '.json')

    def test_valid_policy_and_native_role_bounds(self):
        self.assertEqual(m.validate_policy(policy(), SELECTION)['revision'], 1)
        roles = policy()['roles']
        bad = [
            (dict(revision=True), 'invalid_policy'),
            (dict(selection_digest='f' * 64), 'policy_selection_drift'),
            (dict(projects={**policy()['projects'], 'OPP-99999': policy()['projects'][A]}), 'project_not_selected'),
            (dict(projects={A: dict(policy()['projects'][A], source_digest='d' * 64)}), 'source_mismatch'),
            (dict(projects={A: dict(policy()['projects'][A], native_project='P-other')}), 'native_project_mismatch'),
            (dict(projects={A: dict(policy()['projects'][A], evaluator=MANAGER_A)}), 'evaluator_is_manager'),
            (dict(projects={A: policy()['projects'][A], B: dict(policy()['projects'][B], manager=MANAGER_A)}), 'duplicate_binding'),
            (dict(projects={A: policy()['projects'][A], B: dict(policy()['projects'][B], paperclip_company=policy()['projects'][A]['paperclip_company'])}), 'duplicate_binding'),
            (dict(projects={A: policy()['projects'][A], B: dict(policy()['projects'][B], evaluator=MANAGER_A)}), 'evaluator_is_manager'),
            (dict(projects={A: dict(policy()['projects'][A], max_task_units='1000000000000001')}), 'invalid_amount'),
            (dict(projects={A: dict(policy()['projects'][A], max_task_units=2000000)}), 'invalid_amount'),
            (dict(projects={A: dict(policy()['projects'][A], evaluator=m.GUARDIAN)}), 'invalid_policy'),
            (dict(projects={A: dict(policy()['projects'][A], extra=True)}), 'invalid_policy'),
            (dict(roles=dict(roles, manager=['central_fund_decide'])), 'role_operation_not_native'),
            (dict(roles=dict(roles, evaluator=['central_task_open'])), 'role_operation_not_native'),
            (dict(roles=dict(roles, solver=['central_fund_configure'])), 'role_operation_not_native'),
            (dict(solvers=[MANAGER_A]), 'solver_overlaps_leadership'),
            (dict(solvers=[EVALUATOR]), 'solver_overlaps_leadership'),
        ]
        for change, code in bad:
            with self.subTest(code=code, change=list(change)), self.assertRaises(m.Refused) as caught:
                m.validate_policy(policy(**change), SELECTION)
            self.assertEqual(caught.exception.code, code)

    def test_selection_digest_matches_node_canonical_form(self):
        # Fixed vector computed with services/project-organizations/src/common.mjs digest().
        value = {'schema': 'x', 'b': [1, '<&> \u00e9 \u2028 \n\t\u0001 "q" \\', True, None], 'a': {'z': 1, 'y': '\u00fc'}}
        self.assertEqual(m.sha(m.js_canonical(value).encode()), '9a7c2b79c8c432812241dadf9d6f950dfae301a55115371bd54499264529ab57')

    def test_key_order_is_utf16_code_units_like_javascript(self):
        # Vectors produced by services/project-organizations/src/common.mjs canonical()/digest().
        vector = json.loads((HERE.parent.parent / 'services/project-organizations/test/fixtures/fleet-attestation-vector.json').read_text())
        self.assertTrue(any(any(ord(c) > 0xffff for c in k) for row in vector['canonical'] for k in row['value']))
        for row in vector['canonical']:
            with self.subTest(sha=row['sha256']):
                self.assertEqual(m.js_canonical(row['value']), row['canonical'])
                self.assertEqual(m.sha(m.js_canonical(row['value']).encode()), row['sha256'])
        # Fixed vector from: node -e "canonical(v)" with common.mjs (U+1F600 and U+10000 are
        # surrogate pairs, so they sort before U+E000, U+FFFD and U+FFFF in JavaScript).
        value = {'\U0001F600': 1, '�': 2, '': {'\U00010000': [1, '\U0001F600'], '￿': None}, 'a': 'x', 'é': True}
        self.assertEqual(m.js_canonical(value), '{"a":"x","é":true,"\U0001F600":1,"":{"\U00010000":[1,"\U0001F600"],"￿":null},"�":2}')
        self.assertEqual(m.sha(m.js_canonical(value).encode()), '666a40bb75e2cc1e2aa7af402d9a66539438f1e11b24376c071e191e2649e702')
        for bad in ({'\ud800': 1}, {'a': '\udfff'}, {1: 'x'}):
            with self.subTest(bad=repr(bad)), self.assertRaises(m.Refused):
                m.js_canonical(bad)


class ProtectedFileTests(unittest.TestCase):
    """Fixtures live in a private 0700 directory under the system temp dir; the
    parent walk stops there (boundary=self.root), because on Linux CI that parent is
    world-writable /tmp or a checkout owned by another uid. Production passes no
    boundary and walks to '/'."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        os.chmod(self.root, 0o700)
        self.path = self.root / 'fleet-policy.json'

    def tearDown(self):
        self.tmp.cleanup()

    def test_compare_and_swap_revisions(self):
        with self.assertRaises(m.Refused) as caught:
            m.compare_and_swap(self.path, 1, policy(revision=2), SELECTION, ME, boundary=self.root)
        self.assertEqual(caught.exception.code, 'policy_revision_conflict')
        m.compare_and_swap(self.path, 0, policy(), SELECTION, ME, boundary=self.root)
        self.assertEqual(m.load_policy(self.path, SELECTION, ME, boundary=self.root)['revision'], 1)
        before = self.path.read_bytes()
        for expected, new in ((0, policy()), (1, policy(revision=1)), (1, policy(revision=3)), (2, policy(revision=3))):
            with self.subTest(expected=expected, revision=new['revision']), self.assertRaises(m.Refused):
                m.compare_and_swap(self.path, expected, new, SELECTION, ME, boundary=self.root)
        # An invalid (widened) policy never replaces the reviewed one.
        widened = policy(revision=2, roles=dict(policy()['roles'], manager=['central_fund_decide']))
        with self.assertRaises(m.Refused):
            m.compare_and_swap(self.path, 1, widened, SELECTION, ME, boundary=self.root)
        self.assertEqual(self.path.read_bytes(), before)
        narrowed = policy(revision=2, roles=dict(policy()['roles'], manager=['project_join', 'central_task_open']))
        m.compare_and_swap(self.path, 1, narrowed, SELECTION, ME, boundary=self.root)
        self.assertEqual(m.load_policy(self.path, SELECTION, ME, boundary=self.root)['roles']['manager'], ['project_join', 'central_task_open'])
        self.assertFalse(self.path.stat().st_mode & 0o022)

    def test_policy_file_must_be_protected(self):
        m.compare_and_swap(self.path, 0, policy(), SELECTION, ME, boundary=self.root)
        if os.geteuid() != 0:
            with self.assertRaises(m.Refused):
                m.load_policy(self.path, SELECTION)  # production trusts root only
        link = self.root / 'link.json'
        link.symlink_to(self.path)
        with self.assertRaises(m.Refused):
            m.load_policy(link, SELECTION, ME, boundary=self.root)
        os.chmod(self.path, 0o666)
        with self.assertRaises(m.Refused):
            m.load_policy(self.path, SELECTION, ME, boundary=self.root)
        os.chmod(self.path, 0o644)
        self.path.write_text('{"schema":"x","schema":"x"}')
        with self.assertRaises(ValueError):
            m.load_policy(self.path, SELECTION, ME, boundary=self.root)

    def sources(self):
        for name in m.SOURCE_NAMES:
            (self.root / (name + '.py')).write_text("VALUE='reviewed %s'\n" % name)
        manifest = self.root / 'sources.json'
        pins = {n + '.py': m.sha((self.root / (n + '.py')).read_bytes()) for n in m.SOURCE_NAMES}
        manifest.write_text(json.dumps(dict(schema=m.SOURCE_SCHEMA, sha256=pins)))
        return manifest, pins

    def test_source_manifest_pins_every_module(self):
        self.assertEqual(m.SOURCE_MANIFEST, Path('/etc/uain-custody/project-organizations-sources.json'))
        manifest, pins = self.sources()
        self.assertEqual(set(m.verify_sources(self.root, manifest, ME, boundary=self.root)), set(m.SOURCE_NAMES))
        (self.root / 'native_migration.py').write_text("raise RuntimeError('UNREVIEWED')\n")
        with self.assertRaises(m.Refused) as caught:
            m.verify_sources(self.root, manifest, ME, boundary=self.root)
        self.assertEqual(caught.exception.code, 'source_hash')
        manifest, pins = self.sources()
        target = self.root / 'native_admission.py'
        target.unlink()
        target.symlink_to(self.root / 'native_migration.py')
        with self.assertRaises(m.Refused):
            m.verify_sources(self.root, manifest, ME, boundary=self.root)
        target.unlink()
        manifest, pins = self.sources()
        for value in (dict(schema=m.SOURCE_SCHEMA, sha256={}), dict(schema=m.SOURCE_SCHEMA, sha256=pins, extra=1),
                      dict(schema='uain-central-launch-sources-v1', sha256=pins)):
            manifest.write_text(json.dumps(value))
            with self.subTest(value=list(value)), self.assertRaises(ValueError):
                m.verify_sources(self.root, manifest, ME, boundary=self.root)
        manifest.write_text('{"schema":"%s","schema":"%s","sha256":{}}' % (m.SOURCE_SCHEMA, m.SOURCE_SCHEMA))
        with self.assertRaises(m.Refused):
            m.verify_sources(self.root, manifest, ME, boundary=self.root)

    def test_trust_boundary_simulates_linux_ci_parents(self):
        """Simulates the node:22-alpine run: a world-writable (1777) parent and a parent
        owned by a foreign uid. Below the boundary every check still applies."""
        shared = self.root / 'tmp'
        shared.mkdir()
        os.chmod(shared, 0o1777)  # like /tmp
        private = shared / 'private'
        private.mkdir(mode=0o700)
        path = private / 'fleet-policy.json'
        m.compare_and_swap(path, 0, policy(), SELECTION, ME, boundary=private)
        self.assertEqual(m.load_policy(path, SELECTION, ME, boundary=private)['revision'], 1)
        for boundary in (self.root, None):
            with self.subTest(boundary=boundary):
                with self.assertRaises(m.Refused) as caught:
                    m.load_policy(path, SELECTION, ME, boundary=boundary)
                self.assertEqual(caught.exception.code, 'untrusted_parent')
                with self.assertRaises(m.Refused) as caught:
                    m.compare_and_swap(path, 1, policy(revision=2), SELECTION, ME, boundary=boundary)
                self.assertEqual(caught.exception.code, 'untrusted_parent')

        # A foreign-owned (uid 501 checkout) parent, without changing real ownership.
        os.chmod(shared, 0o755)
        real_stat = Path.stat
        foreign = max(ME) + 4242

        def stat(self_, *args, **kwargs):
            info = real_stat(self_, *args, **kwargs)
            if self_ == shared:
                values = list(info[:10])
                values[4] = foreign
                return os.stat_result(values)
            return info
        with unittest.mock.patch.object(m.Path, 'stat', stat):
            self.assertEqual(m.load_policy(path, SELECTION, ME, boundary=private)['revision'], 1)
            with self.assertRaises(m.Refused) as caught:
                m.load_policy(path, SELECTION, ME, boundary=self.root)
            self.assertEqual(caught.exception.code, 'untrusted_parent')

        # Below the boundary nothing is relaxed; the boundary itself must be trusted.
        os.chmod(private, 0o777)
        with self.assertRaises(m.Refused) as caught:
            m.load_policy(path, SELECTION, ME, boundary=private)
        self.assertEqual(caught.exception.code, 'untrusted_parent')
        os.chmod(private, 0o700)
        os.chmod(path, 0o666)
        with self.assertRaises(m.Refused) as caught:
            m.load_policy(path, SELECTION, ME, boundary=private)
        self.assertEqual(caught.exception.code, 'untrusted_file')
        os.chmod(path, 0o644)
        # The boundary must be a real, resolved ancestor of the file.
        alias = self.root / 'alias'
        alias.symlink_to(private)
        elsewhere = self.root / 'elsewhere'
        elsewhere.mkdir(mode=0o700)
        for boundary, code in ((elsewhere, 'untrusted_boundary'), (alias, 'untrusted_boundary'), (Path('relative'), 'untrusted_boundary')):
            with self.subTest(boundary=str(boundary)), self.assertRaises(m.Refused) as caught:
                m.load_policy(path, SELECTION, ME, boundary=boundary)
            self.assertEqual(caught.exception.code, code)

    def test_production_defaults_are_strict(self):
        import inspect
        for fn in (m.protected_read, m.verify_sources, m.load_policy, m.compare_and_swap):
            with self.subTest(fn=fn.__name__):
                params = inspect.signature(fn).parameters
                self.assertIsNone(params['boundary'].default)
                self.assertEqual(params['trusted_uids'].default, (0,))

    @unittest.skipIf(os.geteuid() == 0, 'checks the non-root refusal')
    def test_bootstrap_requires_root(self):
        with self.assertRaises(m.Refused):
            m.bootstrap_sources(self.root, self.root / 'sources.json')


class AuthorizeTests(unittest.TestCase):
    def setUp(self):
        self.policy = m.validate_policy(policy(), SELECTION)

    def refused(self, code, project, c, caller='agent', p=None):
        with self.assertRaises(m.Refused) as caught:
            m.authorize(p or self.policy, project, c, caller)
        self.assertEqual(caught.exception.code, code)

    def test_roles_follow_bound_signers(self):
        self.assertEqual(m.authorize(self.policy, A, command(EVALUATOR, 'central_fund_plan', plan_payload())), 'evaluator')
        self.assertEqual(m.authorize(self.policy, A, command(MANAGER_A, 'central_task_open', task_payload())), 'manager')
        self.assertEqual(m.authorize(self.policy, A, command(MANAGER_A, 'project_join', dict(project='P-' + A))), 'manager')
        self.assertEqual(m.authorize(self.policy, A, command(SOLVER, 'project_join', dict(project='P-' + A))), 'solver')
        submit = dict(id='S-1', task='T-' + A, evidence='result', evidence_digest=m.sha(b'result'))
        self.assertEqual(m.authorize(self.policy, A, command(SOLVER, 'central_submit', submit)), 'solver')

    def test_unselected_project_opcode_and_signer(self):
        self.refused('project_not_selected', C, command(EVALUATOR, 'central_fund_plan', plan_payload(C)))
        self.refused('project_not_selected', 'OPP-99999', command(EVALUATOR, 'central_fund_plan', plan_payload()))
        self.refused('operation_not_allowed', A, command(EVALUATOR, 'central_review', {}))
        self.refused('operation_not_allowed', A, command(EVALUATOR, 'transfer', {}))
        self.refused('signer_mismatch', A, command(MANAGER_A, 'central_fund_plan', plan_payload()))
        self.refused('signer_mismatch', A, command(MANAGER_B, 'central_task_open', task_payload()))
        self.refused('signer_mismatch', A, command(EVALUATOR, 'central_task_open', task_payload()))
        self.refused('signer_mismatch', A, command(OUTSIDER, 'central_submit', dict(id='S', task='T', evidence='e', evidence_digest=m.sha(b'e'))))
        self.refused('payload_project_mismatch', A, command(EVALUATOR, 'central_fund_plan', plan_payload(B)))
        self.refused('invalid_command', A, dict(command(EVALUATOR, 'central_fund_plan', plan_payload()), chain_id='other'))
        narrowed = m.validate_policy(policy(roles=dict(policy()['roles'], manager=['central_task_open'])), SELECTION)
        self.refused('operation_not_allowed', A, command(MANAGER_A, 'central_task_fund', dict(task='T-' + A, evidence_digest='a' * 64)), p=narrowed)

    def test_amount_and_plan_bounds(self):
        self.refused('amount_above_bound', A, command(MANAGER_A, 'central_task_open', task_payload(solver='1900000', reviewer='100001')))
        self.refused('invalid_amount', A, command(MANAGER_A, 'central_task_open', task_payload(solver='1000000000000001')))
        self.refused('invalid_amount', A, command(MANAGER_A, 'central_task_open', task_payload(solver='1.5')))
        self.refused('plan_revision_above_bound', A, command(EVALUATOR, 'central_fund_plan', plan_payload(revision=4)))
        self.refused('invalid_payload', A, command(EVALUATOR, 'central_fund_plan', plan_payload(revision=True)))

    def test_main_kpi_achievement_is_held_without_a_validated_receipt(self):
        # SV-2: no qualified achievement verifier exists, so custody never signs the round-5
        # accept that sets main_kpi_achieved. Every other fund decision is unchanged.
        def decide(verdict, kpi):
            return command(EVALUATOR, 'central_fund_decide', dict(application='F-%s-5-%s' % (A, 'a' * 16), verdict=verdict,
                           verification_digest='b' * 64, feedback='FICTIONAL fund feedback text', main_kpi_achieved=kpi))
        self.refused('fund_achievement_receipt_required', A, decide('accept', True))
        self.assertEqual(m.authorize(self.policy, A, decide('reject', False)), 'evaluator')
        self.assertEqual(m.authorize(self.policy, A, decide('accept', False)), 'evaluator')

    def test_guardian_operations_unreachable_from_agents(self):
        start = command(m.GUARDIAN, 'central_project_start', dict(project='P-' + A, manager=MANAGER_A, evidence_digest='a' * 64))
        configure = command(m.GUARDIAN, 'central_fund_configure', dict(project='P-' + A, evaluator=EVALUATOR, expected_evaluator='', evidence_digest='a' * 64))
        for c in (start, configure):
            self.refused('guardian_unreachable', A, c)
            self.assertEqual(m.authorize(self.policy, A, c, 'bootstrap'), 'guardian')
        self.refused('manager_mismatch', A, dict(start, payload=dict(start['payload'], manager=OUTSIDER)), 'bootstrap')
        self.refused('evaluator_mismatch', A, dict(configure, payload=dict(configure['payload'], evaluator=OUTSIDER)), 'bootstrap')
        self.refused('signer_mismatch', A, dict(start, member=MANAGER_A), 'bootstrap')
        self.refused('bootstrap_is_guardian_only', A, command(EVALUATOR, 'central_fund_plan', plan_payload()), 'bootstrap')
        self.refused('invalid_caller', A, start, 'root')

    def test_open_project_only_for_bootstrap_guardian_and_bound_selected_id(self):
        opened = command(m.GUARDIAN, 'open_project', open_payload(A))
        self.assertEqual(m.authorize(self.policy, A, opened, 'bootstrap'), 'guardian')
        self.refused('guardian_unreachable', A, opened)
        self.refused('signer_mismatch', A, dict(opened, member=MANAGER_A), 'bootstrap')
        self.refused('signer_mismatch', A, dict(opened, member=OUTSIDER), 'bootstrap')
        # Selected but not bound in the fleet policy, and outside the selection.
        self.refused('project_not_selected', C, command(m.GUARDIAN, 'open_project', open_payload(C)), 'bootstrap')
        self.refused('project_not_selected', 'OPP-99999', opened, 'bootstrap')
        # Only the policy-bound P-<catalogue ID>; never another project's or a free ID.
        for other in ('P-' + B, 'P-' + C, 'P-anything', A):
            with self.subTest(id=other):
                self.refused('payload_project_mismatch', A, command(m.GUARDIAN, 'open_project', dict(open_payload(A), id=other)), 'bootstrap')
        narrowed = m.validate_policy(policy(roles=dict(policy()['roles'], guardian=['central_project_start', 'central_fund_configure'])), SELECTION)
        self.refused('operation_not_allowed', A, opened, 'bootstrap', p=narrowed)

    def test_open_project_payload_mirrors_native_bounds(self):
        art = open_payload(A)['prior_art']
        bad = [
            dict(title='abcd'), dict(title='x' * 251), dict(title=' padded title '), dict(title='line\nbreak title'),
            {'class': 'malevolent'}, dict(extra=1), dict(id='bad id'),
            dict(prior_art=dict(art, basis='too short to explain novelty')), dict(prior_art=dict(art, basis='b' * 4001)),
            dict(prior_art=dict(art, searches=['only one search'])), dict(prior_art=dict(art, searches=['same query', 'same query'])),
            dict(prior_art=dict(art, searches=['abcd', 'long enough query'])), dict(prior_art=dict(art, searches=['q' * 1001, 'long enough query'])),
            dict(prior_art=dict(art, searches=['s%02d search' % n for n in range(21)])), dict(prior_art=dict(art, extra=1)),
            dict(prior_art=dict(art, basis=' ' + art['basis'])), dict(prior_art=dict(art, basis=art['basis'] + '\r')),
        ]
        for change in bad:
            payload = dict(open_payload(A), **change)
            if 'extra' in change:
                payload = dict(open_payload(A), extra=1)
            with self.subTest(change=str(change)[:60]), self.assertRaises(m.Refused) as caught:
                m.authorize(self.policy, A, command(m.GUARDIAN, 'open_project', payload), 'bootstrap')
            self.assertIn(caught.exception.code, ('invalid_payload', 'payload_project_mismatch'))
        multiline = dict(open_payload(A), prior_art=dict(art, basis=art['basis'] + '\n\tSecond reviewed paragraph.'))
        self.assertEqual(m.authorize(self.policy, A, command(m.GUARDIAN, 'open_project', multiline), 'bootstrap'), 'guardian')


class Native:
    """Authoritative native stand-in with event log and member sequences."""

    def __init__(self):
        self.height = 100
        self.header_time = NOW
        self.events = []
        self.broadcasts = []
        self.broadcast_includes = True
        self.broadcast_raises = False
        # (code, codespace, log) for a CheckTx refusal: the bytes are not included and the
        # node answers {code, codespace, log, hash}; refusal_hash overrides the named hash.
        self.refusal = None
        self.refusal_hash = None
        self.members = {a: dict(id=a, public_key='pk-' + a, licence='active', sequence='4')
                        for a in (MANAGER_A, MANAGER_B, EVALUATOR, SOLVER, m.GUARDIAN)}
        self.records = {}
        for project, manager in ((A, MANAGER_A), (B, MANAGER_B)):
            P = 'P-' + project
            self.records['project/' + P] = dict(id=P, lead=m.GUARDIAN, state='active', safety_halted=False)
            self.records['central_project_budget/' + P] = dict(project=P, manager=manager, round=1, closed=False)
            self.records['central_fund_config/' + P] = dict(project=P, evaluator=EVALUATOR)

    def read(self, selection):
        records = {k: copy.deepcopy(self.records.get(k)) for k in selection['keys']}
        for n, event in enumerate(self.events, 1):
            if m.admission.event_key(n) in selection['keys']:
                records[m.admission.event_key(n)] = copy.deepcopy(event)
        s = dict(chain_id=m.CHAIN, height=str(self.height), header_time=datetime.datetime.fromtimestamp(self.header_time, datetime.timezone.utc).isoformat(),
                 event_count=str(len(self.events)), app_hash='e' * 64, member=copy.deepcopy(self.members.get(selection['member'])), records=records)
        if 'receipt' in selection:
            event = self.events[int(selection['receipt']['event_id']) - 1]
            s['receipt'] = dict(authority='native', finalized=True, chain_id=m.CHAIN, state_height=s['height'], app_hash=s['app_hash'], event=copy.deepcopy(event))
        return s

    def broadcast(self, envelope):
        self.broadcasts.append(json.dumps(envelope, sort_keys=True))
        c = envelope['command']
        if self.refusal is not None:
            code, codespace, log = self.refusal
            return dict(code=code, codespace=codespace, log=log, hash=self.refusal_hash or m.tx_hash(envelope))
        if self.broadcast_includes and self.members[c['member']]['sequence'] == c['sequence']:
            self.events.append(dict(id=str(len(self.events) + 1), member=c['member'], operation=c['operation'], command_digest=m.command_digest(c)))
            self.members[c['member']]['sequence'] = str(int(c['sequence']) + 1)
        if self.broadcast_raises:
            raise TimeoutError('ambiguous after native acceptance')
        return 0


def fake_verify(envelope, c, public_key):
    m.require(envelope['command'] == c and envelope['public_key'] == public_key and envelope['signature'] == 'FICTIONAL-' + m.command_digest(c), 'bad_signature')


class ProcessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=HERE)
        self.root = Path(self.tmp.name)
        self.policy = m.validate_policy(policy(), SELECTION)
        self.native = Native()
        self.signed = []

    def tearDown(self):
        self.tmp.cleanup()

    def signer(self, c, role):
        self.signed.append((c, role))
        return dict(command=c, public_key='pk-' + c['member'], signature='FICTIONAL-' + m.command_digest(c))

    def load(self, path):
        return json.loads(path.read_bytes()) if path.exists() else None

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        m.admission.atomic(path, value)

    def process(self, project, request, signer=None, policy_=None, caller='agent', now=NOW):
        return m.process(policy_ or self.policy, project, request, self.native, self.load, self.write, signer or self.signer,
                         root=self.root, caller=caller, now=lambda: now, verify=fake_verify)

    def plan(self, project=A, ident='plan-1'):
        return dict(id=ident, member=EVALUATOR, operation='central_fund_plan', payload=plan_payload(project))

    def test_ambiguous_send_finalizes_once_without_resign(self):
        self.native.broadcast_raises = True
        result = self.process(A, self.plan())
        self.assertEqual(result['status'], 'finalized')
        self.assertEqual(len(self.signed), 1)
        self.assertEqual(self.signed[0][1], 'evaluator')
        again = self.process(A, self.plan(), signer=lambda c, r: self.fail('re-signed'), now=NOW + 10000)
        self.assertEqual(again['status'], 'finalized')
        self.assertEqual(len(self.native.broadcasts), 1)

    def test_unselected_or_unbound_project_refuses_before_any_read(self):
        reads = []
        self.native.read = lambda selection: reads.append(selection)
        for project in ('OPP-99999', C):  # not selected; selected but not in the fleet policy
            with self.subTest(project=project), self.assertRaises(m.Refused) as caught:
                self.process(project, self.plan(project if project != 'OPP-99999' else A))
            self.assertEqual(caught.exception.code, 'project_not_selected')
        self.assertEqual((reads, self.signed, self.native.broadcasts), ([], [], []))
        self.assertEqual(list(self.root.glob('OPP-*/*.json')), [])

    def test_crash_after_send_marker_never_rebroadcasts(self):
        crashed = []
        write = self.write

        def crashing(path, value):
            write(path, value)
            if value.get('attempted') and not crashed:
                crashed.append(1)
                raise OSError('durable marker written, acknowledgement lost')
        self.write = crashing
        with self.assertRaises(OSError):
            self.process(A, self.plan())
        self.assertEqual(self.native.broadcasts, [])
        result = self.process(A, self.plan(), signer=lambda c, r: self.fail('re-signed'))
        self.assertEqual(result['status'], 'pending')
        self.assertEqual(self.native.broadcasts, [])

    def test_expired_unsent_envelope_is_scanned_not_broadcast(self):
        def lose(path, value):
            self.write(path, value)
            raise OSError('lost acknowledgement of signed journal')
        with self.assertRaises(OSError):
            m.process(self.policy, A, self.plan(), self.native, self.load, lose, self.signer, root=self.root, now=lambda: NOW, verify=fake_verify)
        self.native.height = 201
        result = self.process(A, self.plan(), signer=lambda c, r: self.fail('re-signed'))
        self.assertEqual(result['status'], 'expired_not_included')
        self.assertEqual(self.native.broadcasts, [])

    def test_changed_request_cannot_reuse_signed_journal(self):
        self.native.broadcast_includes = False
        self.process(A, self.plan())
        changed = self.plan()
        changed['payload'] = dict(changed['payload'], reason='A different, unreviewed reason.')
        with self.assertRaises(m.Refused) as caught:
            self.process(A, changed, signer=lambda c, r: self.fail('re-signed'))
        self.assertEqual(caught.exception.code, 'journal_scope_mismatch')

    def test_revoked_licence_or_stale_proof_refuses_before_signing(self):
        self.native.header_time = NOW - 600
        with self.assertRaises(m.Refused) as caught:
            self.process(A, self.plan())
        self.assertEqual(caught.exception.code, 'stale_native_proof')
        self.native.header_time = NOW
        self.native.members[EVALUATOR]['licence'] = 'revoked'
        with self.assertRaises(m.Refused) as caught:
            self.process(A, self.plan())
        self.assertEqual(caught.exception.code, 'member_licence_inactive')
        self.assertEqual(self.signed, [])
        self.assertEqual(list(self.root.rglob('*.json')), [])

    def test_wrong_native_manager_evaluator_or_plan_revision(self):
        cases = [
            (lambda r: r['central_fund_config/P-' + A].update(evaluator=OUTSIDER), self.plan(), 'native_evaluator_mismatch'),
            (lambda r: r['central_project_budget/P-' + A].update(manager=OUTSIDER), self.plan(), 'native_manager_mismatch'),
            (lambda r: r.update({'central_fund_state/P-' + A: dict(revision=1, approved_revision=0, pending='', completed=0)}), self.plan(), 'plan_revision_mismatch'),
            (lambda r: None, dict(id='t', member=MANAGER_A, operation='central_task_open', payload=task_payload()), 'plan_not_approved'),
        ]
        for mutate, request, code in cases:
            self.native = Native()
            mutate(self.native.records)
            with self.subTest(code=code), self.assertRaises(m.Refused) as caught:
                self.process(A, request)
            self.assertEqual(caught.exception.code, code)
        self.assertEqual(self.signed, [])

    def test_main_kpi_achieved_prevents_new_task_before_signing(self):
        self.native.records['central_fund_state/P-' + A] = dict(revision=1, approved_revision=1, pending='', completed=0)
        self.native.records['central_project_budget/P-' + A]['main_kpi_achieved'] = True
        request = dict(id='completed-project-task', member=MANAGER_A, operation='central_task_open', payload=task_payload())
        with self.assertRaises(m.Refused) as caught:
            self.process(A, request)
        self.assertEqual(caught.exception.code, 'plan_not_approved')
        self.assertEqual((self.signed, self.native.broadcasts), ([], []))
        self.assertEqual(list(self.root.glob('OPP-*/*.json')), [])

    def test_one_signer_lane_across_projects(self):
        self.native.broadcast_includes = False
        self.assertEqual(self.process(A, self.plan(A, 'plan-a'))['status'], 'pending')
        with self.assertRaises(m.Refused) as caught:
            self.process(B, self.plan(B, 'plan-b'))
        self.assertEqual(caught.exception.code, 'signer_lane_busy')
        self.assertEqual(len(self.signed), 1)
        # A different signer is not blocked by the evaluator's open lane.
        self.native.records['central_fund_state/P-' + B] = dict(revision=1, approved_revision=1, pending='', completed=0)
        self.assertEqual(self.process(B, dict(id='task-b', member=MANAGER_B, operation='central_task_open', payload=task_payload(B)))['status'], 'pending')

    def test_narrowed_policy_holds_an_unsent_envelope(self):
        def lose(path, value):
            self.write(path, value)
            raise OSError('lost acknowledgement')
        with self.assertRaises(OSError):
            m.process(self.policy, A, self.plan(), self.native, self.load, lose, self.signer, root=self.root, now=lambda: NOW, verify=fake_verify)
        narrowed = m.validate_policy(policy(revision=2, roles=dict(policy()['roles'], evaluator=['central_fund_decide'])), SELECTION)
        with self.assertRaises(m.Refused) as caught:
            self.process(A, self.plan(), signer=lambda c, r: self.fail('re-signed'), policy_=narrowed)
        self.assertEqual(caught.exception.code, 'operation_not_allowed')
        self.assertEqual(self.native.broadcasts, [])

    def test_guardian_bootstrap_only_through_bootstrap_caller(self):
        self.native.records['central_project_budget/P-' + A] = None
        request = dict(id='start-a', member=m.GUARDIAN, operation='central_project_start',
                       payload=dict(project='P-' + A, manager=MANAGER_A, evidence_digest='a' * 64))
        self.native.records['member/' + MANAGER_A] = dict(id=MANAGER_A, licence='active')
        with self.assertRaises(m.Refused) as caught:
            self.process(A, request)
        self.assertEqual(caught.exception.code, 'guardian_unreachable')
        self.assertEqual(self.process(A, request, caller='bootstrap')['status'], 'finalized')
        self.assertEqual(self.signed[0][1], 'guardian')

    def open_request(self):
        return dict(id='open-a', member=m.GUARDIAN, operation='open_project', payload=open_payload(A))

    def test_open_project_signs_only_when_native_has_no_project(self):
        self.native.records['project/P-' + A] = None
        self.native.members[m.GUARDIAN]['creator'] = True
        with self.assertRaises(m.Refused) as caught:
            self.process(A, self.open_request())
        self.assertEqual(caught.exception.code, 'guardian_unreachable')
        self.assertEqual(self.process(A, self.open_request(), caller='bootstrap')['status'], 'finalized')
        self.assertEqual([(c['operation'], role) for c, role in self.signed], [('open_project', 'guardian')])

    def test_open_project_conflict_or_non_creator_refuses_before_signing(self):
        # An existing project at the ID (even with the same title) is never signed over.
        self.native.members[m.GUARDIAN]['creator'] = True
        self.native.records['project/P-' + A] = dict(id='P-' + A, lead=OUTSIDER, title=open_payload(A)['title'], state='active', safety_halted=False)
        with self.assertRaises(m.Refused) as caught:
            self.process(A, self.open_request(), caller='bootstrap')
        self.assertEqual(caught.exception.code, 'native_project_conflict')
        self.native.records['project/P-' + A] = None
        self.native.members[m.GUARDIAN]['creator'] = False
        with self.assertRaises(m.Refused) as caught:
            self.process(A, self.open_request(), caller='bootstrap')
        self.assertEqual(caught.exception.code, 'guardian_not_creator')
        self.assertEqual(self.signed, [])
        self.assertEqual(list(self.root.rglob('*.json')), [])

    def test_open_project_ambiguous_send_reconciles_without_resign(self):
        self.native.records['project/P-' + A] = None
        self.native.members[m.GUARDIAN]['creator'] = True
        self.native.broadcast_includes = False
        self.assertEqual(self.process(A, self.open_request(), caller='bootstrap')['status'], 'pending')
        # The command lands later; reconciliation finalizes the retained envelope, never re-signs.
        self.native.broadcast_includes = True
        self.native.broadcast(json.loads(self.native.broadcasts[-1]))
        result = self.process(A, self.open_request(), caller='bootstrap', signer=lambda c, r: self.fail('re-signed'))
        self.assertEqual(result['status'], 'finalized')
        self.assertEqual(len(self.signed), 1)

    def test_second_join_refused_before_signing(self):
        self.native.records['participation/P-%s/%s/' % (A, MANAGER_A)] = dict(project='P-' + A, member=MANAGER_A)
        with self.assertRaises(m.Refused) as caught:
            self.process(A, dict(id='join-a', member=MANAGER_A, operation='project_join', payload=dict(project='P-' + A)))
        self.assertEqual(caught.exception.code, 'already_joined')
        self.assertEqual(self.signed, [])

    # ------------------------------------------------- definite first-send refusal

    def task(self, ident, project=A, member=MANAGER_A, **amounts):
        self.native.records['central_fund_state/P-' + project] = dict(revision=1, approved_revision=1, pending='', completed=0)
        payload = dict(task_payload(project, **amounts), id='T-' + ident)
        return dict(id=ident, member=member, operation='central_task_open', payload=payload)

    def test_definite_checktx_refusal_fails_at_once_and_frees_the_lane(self):
        self.native.refusal = (1, 'undefined', 'central unlocked allowance exceeded\x07\n' + 'x' * 1000)
        refused = self.task('task-over')
        result = self.process(A, refused)
        self.assertEqual((result['status'], result['reason'], result['broadcasts_retried']), ('failed', 'node_rejected:1', False))
        journal = self.load(m.journal_path(self.root, A, 'task-over'))
        envelope = journal['envelope']  # the retained bytes, in their signed key order
        evidence = result['rejection']
        self.assertEqual({k: evidence[k] for k in ('definite', 'code', 'codespace', 'tx_hash', 'operation', 'member', 'sequence', 'command_digest')},
                         dict(definite=True, code=1, codespace='undefined', tx_hash=m.sha(m.admission.canonical(envelope)).upper(),
                              operation='central_task_open', member=MANAGER_A, sequence='4', command_digest=m.command_digest(envelope['command'])))
        self.assertTrue(evidence['log'].startswith('central unlocked allowance exceeded  ') and len(evidence['log']) == m.MAX_LOG)
        self.assertEqual((journal['attempted'], journal['broadcast_code'], journal['failed']['rejection']), (True, 1, evidence))
        self.assertIsNone(journal.get('receipt'))
        self.assertIsNone(journal.get('noninclusion'))
        # Settled: a later invocation reads nothing, resends nothing and never re-signs.
        reads = []
        read = self.native.read
        self.native.read = lambda selection: reads.append(selection) or read(selection)
        again = self.process(A, refused, signer=lambda c, r: self.fail('re-signed'), now=NOW + 10000)
        self.assertEqual((again['status'], again['rejection']), ('failed', evidence))
        self.assertEqual((reads, len(self.native.broadcasts), len(self.signed)), ([], 1, 1))
        # The lane is free at once (native height still far below expiry): the next command is a
        # NEW intent from fresh state, and signs the same sequence the refused bytes carried.
        self.native.read = read
        self.native.refusal = None
        self.assertLess(self.native.height, int(envelope['command']['expires_height']))
        nxt = self.process(A, self.task('task-next', solver='500000'))
        self.assertEqual(nxt['status'], 'finalized')
        self.assertEqual([c['sequence'] for c, _ in self.signed], ['4', '4'])
        self.assertNotEqual(self.signed[1][0], envelope['command'])
        self.assertEqual(json.loads(self.native.broadcasts[1])['command']['payload']['id'], 'T-task-next')
        # Even after the member's sequence moved on, the failed intent stays failed and unsent.
        self.assertEqual(self.process(A, refused, signer=lambda c, r: self.fail('re-signed'))['status'], 'failed')
        self.assertEqual(len(self.native.broadcasts), 2)

    def assert_lane_held(self, ident, result):
        self.assertEqual(result['status'], 'pending', result)
        journal = self.load(m.journal_path(self.root, A, ident))
        self.assertIsNone(journal.get('failed'))
        self.native.refusal = None
        with self.assertRaises(m.Refused) as caught:
            self.process(A, self.task(ident + '-next'))
        self.assertEqual(caught.exception.code, 'signer_lane_busy')
        self.assertEqual(len(self.signed), 1)

    def test_indefinite_refusals_stay_unknown_and_hold_the_lane(self):
        cases = [
            ('mempool-cache', (19, 'sdk', 'tx already in mempool cache'), None),
            ('mempool-full', (20, 'sdk', 'mempool is full'), None),
            ('io', (39, 'sdk', 'internal IO error'), None),
            ('panic', (111222, 'undefined', 'recovered panic'), None),
            ('other-bytes', (1, 'undefined', 'refused'), 'F' * 64),
            ('bad-codespace', (1, 'not a codespace!', 'refused'), None),
        ]
        for ident, refusal, other_hash in cases:
            with self.subTest(case=ident):
                self.tearDown()
                self.setUp()
                self.native.refusal, self.native.refusal_hash = refusal, other_hash
                self.assert_lane_held(ident, self.process(A, self.task(ident)))

    def test_bare_code_rpc_error_or_timeout_stays_unknown(self):
        for ident, broadcast in (('bare-code', lambda e: 1), ('rpc-error', None), ('timeout', None)):
            with self.subTest(case=ident):
                self.tearDown()
                self.setUp()
                original = self.native.broadcast
                if broadcast is not None:
                    self.native.broadcast = lambda e: (self.native.broadcasts.append(json.dumps(e)), broadcast(e))[1]
                elif ident == 'rpc-error':
                    self.native.broadcast = lambda e: (self.native.broadcasts.append(json.dumps(e)), m.require(False, 'broadcast_outcome_unknown'))
                else:
                    def timeout(e):
                        self.native.broadcasts.append(json.dumps(e))
                        raise TimeoutError('no answer')
                    self.native.broadcast = timeout
                result = self.process(A, self.task(ident))
                self.native.broadcast = original
                self.assertEqual(self.load(m.journal_path(self.root, A, ident))['broadcast_code'], 1 if ident == 'bare-code' else None)
                self.assert_lane_held(ident, result)

    def test_crash_before_recording_the_refusal_stays_unknown(self):
        self.native.refusal = (1, 'undefined', 'refused')
        write = self.write

        def crashing(path, value):
            if value.get('broadcast_code') is not None:
                raise OSError('crashed before the refusal was recorded')
            write(path, value)
        self.write = crashing
        with self.assertRaises(OSError):
            self.process(A, self.task('task-crash'))
        self.write = write
        self.assertEqual(len(self.native.broadcasts), 1)
        again = self.process(A, self.task('task-crash'), signer=lambda c, r: self.fail('re-signed'))
        self.assertEqual(len(self.native.broadcasts), 1, 'never resent')
        self.assert_lane_held('task-crash', again)

    def test_tampered_failure_record_keeps_the_lane(self):
        self.native.refusal = (1, 'undefined', 'refused')
        self.assertEqual(self.process(A, self.task('task-x'))['status'], 'failed')
        path = m.journal_path(self.root, A, 'task-x')
        journal = self.load(path)
        journal['failed']['rejection']['tx_hash'] = '0' * 64
        self.write(path, journal)
        with self.assertRaises(m.Refused) as caught:
            self.process(A, self.task('task-x'), signer=lambda c, r: self.fail('re-signed'))
        self.assertEqual(caught.exception.code, 'journal_scope_mismatch')
        self.native.refusal = None
        with self.assertRaises(m.Refused) as caught:
            self.process(A, self.task('task-y'))
        self.assertEqual(caught.exception.code, 'signer_lane_busy')
        self.assertEqual(len(self.native.broadcasts), 1)

    def test_definite_refusal_requires_the_exact_reply_shape(self):
        e = dict(command=command(MANAGER_A, 'central_task_open', task_payload()), public_key='pk', signature='s')
        good = dict(code=1, codespace='undefined', log='refused', hash=m.tx_hash(e))
        self.assertEqual(m.definite_refusal(good, e)['tx_hash'], m.tx_hash(e))
        self.assertEqual(m.definite_refusal(dict(good, hash=m.tx_hash(e).lower()), e)['code'], 1)
        for bad in (None, 1, dict(good, code=0), dict(good, code=True), dict(good, code=-1), dict(good, extra=1),
                    {k: v for k, v in good.items() if k != 'log'}, dict(good, codespace=None), dict(good, hash=None),
                    dict(good, codespace='sdk', code=20)):
            self.assertIsNone(m.definite_refusal(bad, e), bad)
        self.assertEqual(m.definite_refusal(dict(good, log=None), e)['log'], '')
        # Insertion order never changes the bytes: a reloaded (sorted) journal names the same hash.
        self.assertEqual(m.tx_hash(json.loads(json.dumps(e, sort_keys=True))), m.tx_hash(dict(reversed(list(e.items())))))

    def test_fleet_runtime_broadcast_returns_the_checktx_answer_for_the_sent_bytes(self):
        e = dict(command=command(MANAGER_A, 'central_task_open', task_payload()), public_key='pk', signature='s')
        runtime = m.FleetRuntime.__new__(m.FleetRuntime)
        runtime.p, runtime.deadline = dict(rpc='http://127.0.0.1:26667'), float('inf')
        sent = []

        class Response:
            def __init__(self, body):
                self.body = body

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self, limit):
                return self.body[:limit]

        def answer(result):
            def urlopen(request, timeout):
                sent.append(json.loads(request.data))
                return Response(json.dumps(result).encode())
            return urlopen
        ok = dict(jsonrpc='2.0', id='x', result=dict(code=1, codespace='undefined', log='refused', data='', hash=m.tx_hash(e).lower()))
        with unittest.mock.patch.object(m.urllib.request, 'urlopen', answer(ok)):
            reply = runtime.broadcast(e)
        self.assertEqual(reply, dict(code=1, codespace='undefined', log='refused', hash=m.tx_hash(e)))
        self.assertEqual(m.base64.b64decode(sent[0]['params']['tx']), m.admission.canonical(e))
        self.assertEqual(sent[0]['method'], 'broadcast_tx_sync')
        self.assertIsNotNone(m.definite_refusal(reply, e))
        for bad in (dict(ok, result=dict(ok['result'], hash='0' * 64)), dict(jsonrpc='2.0', id='x', error=dict(code=-32603, message='tx already exists in cache')),
                    dict(ok, result=dict(ok['result'], code=-1))):
            with unittest.mock.patch.object(m.urllib.request, 'urlopen', answer(bad)), self.assertRaises(m.Refused):
                runtime.broadcast(e)


def _crypto():
    for name in ('Cryptodome.Signature.eddsa', 'cryptography.hazmat.primitives.asymmetric.ed25519'):
        try:
            __import__(name)
            return True
        except ImportError:
            pass
    return False


@unittest.skipUnless(_crypto(), 'needs the custody Ed25519 backend (pycryptodomex or cryptography)')
class RealSignatureTests(unittest.TestCase):
    def test_signs_only_with_the_bound_member_key(self):
        seed = hashlib.sha256(b'FICTIONAL fleet evaluator key').digest()
        pub, _ = m.native.ed25519(seed)
        member = 'uain1' + m.sha(pub)[:40]
        c = command(member, 'central_fund_plan', plan_payload())

        class Custody:
            def vault(self):
                return None

            def attachment(self, vault, name):
                assert name == 'keys/project-organizations/' + member + '.json', name
                return json.dumps(dict(private_key=m.b64(seed), public_key=m.b64(pub))).encode()
        with unittest.mock.patch.object(m.os, 'geteuid', return_value=0):
            envelope = m.sign(Custody(), c, 'evaluator')
        m.verify_envelope(envelope, c, m.b64(pub))
        with self.assertRaises(m.Refused):
            m.verify_envelope(envelope, dict(c, member=OUTSIDER), m.b64(pub))
        with self.assertRaises(Exception):
            m.verify_envelope(dict(envelope, command=dict(c, sequence='5')), dict(c, sequence='5'), m.b64(pub))


if __name__ == '__main__':
    unittest.main()


class AmendedSelectionDigestTests(unittest.TestCase):
    def test_real_selection_digest_matches_node_with_and_without_amendments(self):
        here = Path(__file__).resolve().parent.parent.parent / 'docs/baink/project-organizations-2026-11-06'
        real = json.loads((here / 'selection.json').read_text())
        amendments = json.loads((here / 'kpi-amendments.json').read_text())
        # Values printed by services/project-organizations/src/selection.mjs loadSelection().
        self.assertEqual(m.selection_of(real)['digest'], '6fb773320f535c21b4c4c7f33f78e0fb64888d5af9a1d2835999af7485101559')
        self.assertEqual(m.selection_of(real, amendments)['digest'], 'cc65b585de7594a511ba2c3aab8b156c3ba08a02a3ae9a032151784747afc3af')
        with self.assertRaises(m.Refused):
            m.selection_of(real, dict(schema='other', amendments=[]))
        with self.assertRaises(m.Refused):
            m.selection_of(real, dict(schema='uain-project-organization-kpi-amendments-v1', amendments=[dict(id='OPP-99999')]))

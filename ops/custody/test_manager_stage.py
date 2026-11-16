"""Manager stage driver tests. FICTIONAL batches and a fake custody CLI; no root, vault, native or model."""
import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('manager_stage', Path(__file__).with_name('manager_stage.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

PROJECT = 'OPP-00002'
GUARDIAN = 'uain158ac8d0debcf01d43164ef14736597da589d8b54'


def task_id(n, round_=1, project=PROJECT):
    return 'T-%s-%d-%s' % (project, round_, hashlib.sha256(str(n).encode()).hexdigest()[:16])


def request(n, project=PROJECT, **extra):
    i = task_id(n, project=project)
    payload = dict(id=i, project='P-' + project, title='FICTIONAL task %d' % n, criteria='FICTIONAL criteria for task %d.' % n,
                   acceptance_digest='a' * 64, eligibility='unresolved', eligibility_digest='b' * 64, solver_amount='400000000',
                   reviewer_amount='100000000', evidence_digest='c' * 64)
    return dict(dict(id=i, member=GUARDIAN, operation='central_task_open', payload=payload), **extra)


class FakeCustody:
    """Stands in for `project_organizations.py sign`: journals like custody, by scripted outcome."""

    def __init__(self, outcomes):
        self.outcomes = outcomes  # request id -> list of results, one per call (last repeats)
        self.calls = []

    def __call__(self, verb, project, intent):
        assert verb == 'sign'
        self.calls.append(intent)
        request_file = m.FLEET_ROOT / project / (intent + '.request.json')
        assert request_file.exists(), 'custody reads the request file'
        script = self.outcomes.get(intent, ['finalized'])
        result = script.pop(0) if len(script) > 1 else script[0]
        path = m.FLEET_ROOT / project / (intent + '.json')
        if result == 'finalized':
            path.write_text(json.dumps(dict(receipt=dict(finalized=True))))
            return dict(status='finalized')
        if result == 'pending':
            path.write_text(json.dumps(dict(attempted=True)))
            return dict(status='pending')
        if result == 'failed':
            path.write_text(json.dumps(dict(failed=dict(reason='node_rejected:1'))))
            return dict(status='failed', reason='node_rejected:1')
        if result == 'expired':
            path.write_text(json.dumps(dict(noninclusion=dict(height='9'))))
            return dict(status='expired_not_included')
        assert result.startswith('refused:')
        return dict(status='refused', code=result.split(':', 1)[1])


class ManagerStageDriver(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name).resolve()
        os.chmod(root, 0o700)
        self.saved = {k: getattr(m, k) for k in ('CONFIG', 'CANDIDATES', 'STAGE_ROOT', 'FLEET_ROOT', 'TRUSTED_UIDS', 'BOUNDARY', 'REQUIRE_ROOT',
                                                  'POLL_SECONDS', 'custody', 'propose', 'stage')}
        m.CONFIG = root / 'etc' / 'config.json'
        m.CANDIDATES = root / 'etc' / 'candidates.json'
        m.STAGE_ROOT = root / 'stage'
        m.FLEET_ROOT = root / 'fleet'
        m.TRUSTED_UIDS = (os.getuid(),)
        m.BOUNDARY = root
        m.REQUIRE_ROOT = False
        m.POLL_SECONDS = 0
        m.CONFIG.parent.mkdir(mode=0o755)
        self.config = dict(schema=m.CONFIG_SCHEMA, projects=[PROJECT], max_projects_per_run=1, cooldown_minutes=360, max_executions_per_day=40)
        self.write(m.CONFIG, self.config)
        self.proposals = []
        self.offered = []
        self.next_batches = []
        m.propose = self.fake_propose
        self.batch_n = 0

    def tearDown(self):
        for k, v in self.saved.items():
            setattr(m, k, v)
        self.tmp.cleanup()

    def write(self, path, value, mode=0o600):
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        path.write_text(json.dumps(value))
        os.chmod(path, mode)

    def fake_propose(self, config, candidates=None):
        """Stands in for manager-stage.mjs propose: writes the queued batch, if any."""
        self.proposals.append(config)
        self.offered.append(candidates)
        written = []
        if self.next_batches:
            requests = self.next_batches.pop(0)
            self.batch_n += 1
            path = m.STAGE_ROOT / 'batches' / PROJECT / ('2026-11-06T12-00-0%d-000Z-B-1-%016x.json' % (self.batch_n, self.batch_n))
            self.write(path, dict(schema=m.BATCH_SCHEMA, batch='B-1-%016x' % self.batch_n, project=PROJECT, round=1, requests=requests))
            written.append(str(path))
        return dict(schema=m.SUMMARY_SCHEMA, ready=[], skipped=[], runs=[], batches=written, executionsLast24h=0)

    def run_with(self, custody):
        m.custody = custody
        return m.run()

    def test_not_configured_does_nothing(self):
        m.CONFIG.unlink()
        with self.assertRaises(m.Stop) as stop:
            self.run_with(FakeCustody({}))
        self.assertEqual(str(stop.exception), 'not_configured')
        self.assertEqual(self.proposals, [])

    def test_new_batch_is_signed_in_order_and_reruns_never_resign(self):
        batch = [request(1), request(2)]
        self.next_batches.append(batch)
        fake = FakeCustody({})
        report = self.run_with(fake)
        self.assertEqual(report['finalized'], [batch[0]['id'], batch[1]['id']])
        self.assertIsNone(report['waiting'])
        self.assertEqual(fake.calls, [batch[0]['id'], batch[1]['id']])
        for r in batch:
            self.assertEqual(json.loads((m.FLEET_ROOT / PROJECT / (r['id'] + '.request.json')).read_text()), r)
        # Rerun: the journals settle both; nothing is signed again and the stage may propose again.
        again = self.run_with(fake)
        self.assertEqual(fake.calls, [batch[0]['id'], batch[1]['id']])
        self.assertEqual(again['finalized'], [])
        self.assertEqual(len(self.proposals), 2)

    def test_pending_is_reconciled_with_the_same_intent_and_blocks_new_proposals(self):
        self.next_batches.append([request(1), request(2)])
        first = request(1)['id']
        fake = FakeCustody({first: ['pending'] * (m.POLLS + 1) + ['finalized']})
        report = self.run_with(fake)
        self.assertEqual(report['waiting']['id'], first)
        self.assertEqual(report['waiting']['status'], 'pending')
        self.assertEqual(fake.calls, [first] * (m.POLLS + 1), 'only the same intent is reconciled')
        self.assertEqual(len(self.proposals), 1)
        # Next run: reconcile finalizes it, the second request is signed, then the stage may propose again.
        report = self.run_with(fake)
        self.assertEqual(report['finalized'], [first, request(2)['id']])
        self.assertEqual(len(self.proposals), 2)

    def test_failed_or_expired_requests_settle_and_are_never_resigned(self):
        batch = [request(1), request(2), request(3)]
        self.next_batches.append(batch)
        fake = FakeCustody({batch[0]['id']: ['failed'], batch[1]['id']: ['expired']})
        report = self.run_with(fake)
        self.assertEqual([s['status'] for s in report['settled']], ['failed', 'expired_not_included'])
        self.assertEqual(report['finalized'], [batch[2]['id']])
        self.run_with(fake)
        self.assertEqual(fake.calls, [r['id'] for r in batch], 'a settled request is never signed again')

    def test_permanent_refusal_without_journal_settles_and_transient_waits(self):
        batch = [request(1), request(2)]
        self.next_batches.append(batch)
        fake = FakeCustody({batch[0]['id']: ['refused:amount_above_bound'], batch[1]['id']: ['refused:signer_lane_busy', 'finalized']})
        report = self.run_with(fake)
        self.assertEqual(report['settled'], [dict(id=batch[0]['id'], status='refused', reason='amount_above_bound')])
        self.assertEqual(report['waiting']['code'], 'signer_lane_busy')
        refused = json.loads(next((m.STAGE_ROOT / 'batches' / PROJECT).glob('*.refused.json')).read_text())
        self.assertEqual(refused, {batch[0]['id']: 'amount_above_bound'})
        report = self.run_with(fake)
        self.assertEqual(report['finalized'], [batch[1]['id']])
        self.assertEqual(fake.calls, [batch[0]['id'], batch[1]['id'], batch[1]['id']])

    def test_permanent_code_after_a_journal_is_not_settled(self):
        batch = [request(1)]
        self.next_batches.append(batch)
        (m.FLEET_ROOT / PROJECT).mkdir(parents=True)
        (m.FLEET_ROOT / PROJECT / (batch[0]['id'] + '.json')).write_text(json.dumps(dict(attempted=False)))
        fake = FakeCustody({batch[0]['id']: ['refused:invalid_payload']})
        report = self.run_with(fake)
        self.assertEqual(report['waiting']['code'], 'invalid_payload')
        self.assertEqual(report['settled'], [])

    def test_invalid_batches_and_request_conflicts_stop_before_signing(self):
        bad = [
            [request(1, operation='central_task_fund')],
            [dict(request(1), id=task_id(1, project='OPP-00003'))],
            [request(1, member='not-an-address')],
            [dict(request(1), payload=dict(request(1)['payload'], project='P-OPP-00003'))],
            [request(1), request(1)],
        ]
        for requests in bad:
            self.next_batches.append(requests)
            fake = FakeCustody({})
            with self.assertRaises(m.Stop) as stop:
                self.run_with(fake)
            self.assertEqual(str(stop.exception), 'invalid_batch')
            self.assertEqual(fake.calls, [])
            for f in (m.STAGE_ROOT / 'batches' / PROJECT).iterdir():
                f.unlink()
        self.next_batches.append([request(1)])
        r = request(1)
        self.write(m.FLEET_ROOT / PROJECT / (r['id'] + '.request.json'), dict(r, member='uain1' + 'f' * 40))
        with self.assertRaises(m.Stop) as stop:
            self.run_with(FakeCustody({}))
        self.assertEqual(str(stop.exception), 'request_conflict')

    def test_untrusted_batch_file_is_refused(self):
        path = m.STAGE_ROOT / 'batches' / PROJECT / 'x.json'
        self.write(path, dict(schema=m.BATCH_SCHEMA, project=PROJECT, round=1, requests=[request(1)]), mode=0o622)
        fake = FakeCustody({})
        with self.assertRaises(m.Stop) as stop:
            self.run_with(fake)
        self.assertEqual(str(stop.exception), 'untrusted_file')
        self.assertEqual(fake.calls, [])

    def test_invalid_config_refuses(self):
        for change in (dict(max_projects_per_run=0), dict(cooldown_minutes=1), dict(max_executions_per_day=5), dict(projects=['P-1']), dict(extra=1)):
            self.write(m.CONFIG, dict(self.config, **change))
            with self.assertRaises(m.Stop):
                self.run_with(FakeCustody({}))
        self.assertEqual(self.proposals, [])

    def test_optional_task_limit_accepts_one_to_eight_and_keeps_old_config_unchanged(self):
        old = m.CONFIG.read_bytes()
        self.assertEqual(m.planning_bound(m.load_config()), 10)
        self.assertEqual(m.CONFIG.read_bytes(), old)
        for limit in range(1, 9):
            self.write(m.CONFIG, dict(self.config, max_tasks_per_project_run=limit))
            self.assertEqual(m.planning_bound(m.load_config()), 2 + limit)
        for limit in (0, 9, True, '1', 1.5, None):
            self.write(m.CONFIG, dict(self.config, max_tasks_per_project_run=limit))
            with self.assertRaises(m.Stop):
                m.load_config()

    def test_explicit_planning_summary_is_bound_to_config(self):
        cfg = dict(self.config, max_tasks_per_project_run=1)
        good = dict(planning=dict(maxTasks=1, maxProviderCalls=3), runs=[dict(executions=3)])
        self.assertEqual(m.validate_planning_summary(cfg, good), good)
        for bad in ({}, dict(good, planning=dict(maxTasks=True, maxProviderCalls=3)), dict(good, planning=dict(maxTasks=1, maxProviderCalls=10)), dict(good, runs=[dict(executions=4)]), dict(good, runs=[dict(executions=True)])):
            with self.assertRaises(m.Stop):
                m.validate_planning_summary(cfg, bad)
        self.assertEqual(m.validate_planning_summary(self.config, {}), {})

    def test_existing_driver_lock_prevents_concurrent_admission_before_any_proposal(self):
        import fcntl
        m.STAGE_ROOT.mkdir(mode=0o700)
        fd = os.open(m.STAGE_ROOT / '.driver.lock', os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(m.Stop) as stop:
                self.run_with(FakeCustody({}))
            self.assertEqual(str(stop.exception), 'already_running')
            self.assertEqual(self.proposals, [])
        finally:
            os.close(fd)


RATIONALE = dict(effort='FICTIONAL effort note.', difficulty='FICTIONAL difficulty note.', novelty='FICTIONAL novelty note.',
                 verificationCost='FICTIONAL verification cost note.')


def candidate(n, project=PROJECT, **extra):
    return dict(dict(id='%s-fictional-%d' % (project.lower(), n), title='FICTIONAL candidate %d' % n,
                     criteria='FICTIONAL acceptance criteria for candidate %d.' % n, eligibility='new',
                     eligibility_basis='FICTIONAL basis for candidate %d.' % n,
                     proposed_price=dict(solver_amount='200000000', reviewer_amount='50000000', rationale=dict(RATIONALE))), **extra)


def candidates(**projects):
    return dict(schema=m.CANDIDATES_SCHEMA, reviewed=dict(by='FICTIONAL reviewer', at='2026-11-07', source='drafts.json', sourceDigest='d' * 64),
                projects=projects or {PROJECT: [candidate(1), candidate(2)]})


class Candidates(ManagerStageDriver):
    """The optional root-owned candidates file: absent = unchanged; present = strict, private, passed through."""

    def setUp(self):
        super().setUp()
        os.chmod(m.CONFIG.parent, 0o700)

    def test_absent_file_passes_nothing(self):
        self.assertIsNone(m.load_candidates())
        self.run_with(FakeCustody({}))
        self.assertEqual(self.offered, [None])

    def test_valid_file_is_passed_to_the_stage(self):
        c = candidates()
        self.write(m.CANDIDATES, c)
        self.run_with(FakeCustody({}))
        self.assertEqual(self.offered, [c])

    def test_refusals_stop_before_any_proposal_or_signature(self):
        price = candidate(1)['proposed_price']
        bad = [
            dict(candidates(), extra=1),
            dict(candidates(), schema='uain-manager-candidates-v2'),
            dict(candidates(), reviewed=dict(candidates()['reviewed'], sourceDigest='x')),
            candidates(**{PROJECT: [dict(candidate(1), notes='x')]}),
            candidates(**{PROJECT: [dict(candidate(1), priorArt=dict(searches=[]))]}),
            candidates(**{PROJECT: [candidate(1, project='OPP-00003')]}),
            candidates(**{PROJECT: [candidate(1), candidate(1)]}),
            candidates(**{PROJECT: [candidate(n) for n in range(9)]}),
            candidates(**{PROJECT: []}),
            candidates(**{PROJECT: [dict(candidate(1), eligibility='easy')]}),
            candidates(**{PROJECT: [dict(candidate(1), proposed_price=dict(price, solver_amount='10000000001'))]}),
            candidates(**{PROJECT: [dict(candidate(1), proposed_price=dict(price, solver_amount='2.5'))]}),
            candidates(**{PROJECT: [dict(candidate(1), proposed_price=dict(price, rationale=dict(RATIONALE, extra='FICTIONAL extra')))]}),
            candidates(**{'P-1': [candidate(1)]}),
        ]
        for value in bad:
            self.write(m.CANDIDATES, value)
            fake = FakeCustody({})
            with self.assertRaises(m.Stop) as stop:
                self.run_with(fake)
            self.assertEqual(str(stop.exception), 'invalid_candidates', json.dumps(value)[:200])
            self.assertEqual(fake.calls, [])
        self.assertEqual(self.proposals, [])

    def test_file_and_directory_must_be_private_and_plain(self):
        self.write(m.CANDIDATES, candidates(), mode=0o640)
        with self.assertRaises(m.Stop) as stop:
            self.run_with(FakeCustody({}))
        self.assertEqual(str(stop.exception), 'untrusted_file')
        os.chmod(m.CANDIDATES, 0o600)
        os.chmod(m.CANDIDATES.parent, 0o750)
        with self.assertRaises(m.Stop) as stop:
            self.run_with(FakeCustody({}))
        self.assertEqual(str(stop.exception), 'untrusted_parent')
        os.chmod(m.CANDIDATES.parent, 0o700)
        m.CANDIDATES.unlink()
        target = m.CANDIDATES.with_name('real.json')
        self.write(target, candidates())
        os.symlink(target, m.CANDIDATES)
        with self.assertRaises(m.Stop) as stop:
            self.run_with(FakeCustody({}))
        self.assertEqual(str(stop.exception), 'untrusted_file')
        m.CANDIDATES.unlink()
        m.CANDIDATES.write_text('{"schema":"a","schema":"b"}')
        os.chmod(m.CANDIDATES, 0o600)
        with self.assertRaises(m.Stop) as stop:
            self.run_with(FakeCustody({}))
        self.assertEqual(str(stop.exception), 'duplicate_key')
        self.assertEqual(self.proposals, [])

    def test_check_runs_the_dry_stage_with_the_same_inputs(self):
        calls = []

        def fake_stage(command, config, offered):
            calls.append((command, offered))
            counts = {PROJECT: len(offered['projects'][PROJECT])} if offered else None
            return dict(schema=m.SUMMARY_SCHEMA, ready=[], skipped=[dict(project=PROJECT, reason='prior_art_survey_required')],
                        candidates=counts, executionsLast24h=0)
        m.stage = fake_stage
        out = m.check()
        self.assertEqual(out['candidatesInstalled'], False)
        self.assertIsNone(out['candidates'])
        c = candidates()
        self.write(m.CANDIDATES, c)
        out = m.check()
        self.assertEqual(out['candidatesInstalled'], True)
        self.assertEqual(out['candidates'], {PROJECT: 2})
        self.assertEqual(calls, [('check', None), ('check', c)])


FUND = json.loads((Path(__file__).absolute().parents[2] / 'fixtures' / 'contracts' / 'fund-round.json').read_text(encoding='utf-8'))


class FundBatches(ManagerStageDriver):
    """Later funding rounds: the golden vectors cross from JavaScript, and every fund batch is
    re-derived in Python before its request file is written. FICTIONAL values only."""

    def fund_batch(self, kind, value, name=None):
        path = m.STAGE_ROOT / 'fund-batches' / PROJECT / (name or ('2026-11-10T01-00-00-000Z-%s.json' % value['request']['id']))
        self.write(path, value)
        return path

    def test_golden_digests_match_javascript(self):
        self.assertEqual(m.js_canonical(FUND['evidence']['value']), FUND['evidence']['canonical'])
        self.assertEqual(m.js_digest(FUND['evidence']['value']), FUND['evidence']['sha256'])
        self.assertEqual(m.js_canonical(FUND['decision']['value']), FUND['decision']['canonical'])
        self.assertEqual(m.js_digest(FUND['decision']['value']), FUND['decision']['sha256'])
        self.assertEqual(m.js_digest(FUND['missing_evidence']['value']), FUND['missing_evidence']['sha256'])
        self.assertEqual(FUND['missing_evidence']['payload']['verification_digest'], FUND['missing_evidence']['sha256'])

    def test_golden_batches_are_accepted_exactly(self):
        for kind, key in (('apply', 'apply_batch'), ('decide', 'decide_batch')):
            value = FUND['evidence' if kind == 'apply' else 'decision'][key]
            path = self.fund_batch(kind, value)
            self.assertEqual(m.load_fund_batch(path, PROJECT), value)

    def test_tampered_fund_batches_are_refused_before_any_request_file(self):
        import copy
        for case in FUND['refusals']:
            value = copy.deepcopy(FUND['evidence']['apply_batch'] if case['batch'] == 'apply' else FUND['decision']['decide_batch'])
            node = value
            for key in case['patch']['path'][:-1]:
                node = node[key]
            node[case['patch']['path'][-1]] = case['patch']['value']
            path = self.fund_batch(case['batch'], value, name='tampered.json')
            with self.assertRaises(m.Stop, msg=case['name']) as stop:
                m.load_fund_batch(path, PROJECT)
            self.assertEqual(str(stop.exception), case['python'], case['name'])

    def test_main_kpi_needs_an_accepted_sub_kpi_5(self):
        import copy
        value = copy.deepcopy(FUND['decision']['decide_batch'])
        value['decision']['mainKpiAchieved'] = True
        value['request']['payload']['main_kpi_achieved'] = True
        value['request']['payload']['verification_digest'] = m.js_digest(value['decision'])
        with self.assertRaises(m.Stop) as stop:
            m.load_fund_batch(self.fund_batch('decide', value, name='kpi.json'), PROJECT)
        self.assertEqual(str(stop.exception), 'fund_decision_mismatch')

    def decide_batch(self, round_, verdict):
        import copy
        value = copy.deepcopy(FUND['decision']['decide_batch'])
        old, new = '-2-c3b901d9f4c9c19a', '-%d-c3b901d9f4c9c19a' % round_
        value['request']['id'] = value['request']['id'].replace(old, new)
        d = value['decision']
        d.update(application=d['application'].replace(old, new), round=round_, verdict=verdict, mainKpiAchieved=round_ == 5 and verdict == 'accept')
        p = value['request']['payload']
        p.update(application=d['application'], verdict=verdict, main_kpi_achieved=d['mainKpiAchieved'], verification_digest=m.js_digest(d))
        return value

    def test_a_round_5_accept_is_held_without_a_validated_achievement_receipt(self):
        # SV-2: a model verdict alone never sets main_kpi_achieved. No achievement verifier is
        # qualified, so no receipt can be bound today and the round-5 accept is held.
        with self.assertRaises(m.Stop) as stop:
            m.load_fund_batch(self.fund_batch('decide', self.decide_batch(5, 'accept'), name='r5.json'), PROJECT)
        self.assertEqual(str(stop.exception), 'fund_achievement_receipt_required')

    def test_rounds_1_to_4_and_a_round_5_reject_load_unchanged(self):
        for round_, verdict in [(1, 'accept'), (4, 'accept'), (1, 'reject'), (5, 'reject')]:
            value = self.decide_batch(round_, verdict)
            self.assertEqual(m.load_fund_batch(self.fund_batch('decide', value, name='r%d-%s.json' % (round_, verdict)), PROJECT), value)

    def test_fund_batches_are_signed_after_task_batches_and_settle_like_them(self):
        apply = FUND['evidence']['apply_batch']
        decide = FUND['decision']['decide_batch']
        self.fund_batch('apply', apply, name='2026-11-10T01-00-00-000Z-a.json')
        self.fund_batch('decide', decide, name='2026-11-10T01-10-00-000Z-d.json')
        self.next_batches.append([request(1)])
        # First run: the apply lands; the decision request is refused before any journal with a
        # permanent code (the application is no longer pending) and is settled, never signed.
        fake = FakeCustody({decide['request']['id']: ['refused:application_not_pending']})
        report = self.run_with(fake)
        self.assertEqual(fake.calls[:2], [apply['request']['id'], decide['request']['id']])
        self.assertIn(apply['request']['id'], report['finalized'])
        self.assertIn(dict(id=decide['request']['id'], status='refused', reason='application_not_pending'), report['settled'])
        self.assertEqual(json.loads((m.FLEET_ROOT / PROJECT / (apply['request']['id'] + '.request.json')).read_text()), apply['request'])
        # Rerun: both settled, nothing signed again.
        calls = list(fake.calls)
        self.run_with(fake)
        self.assertEqual([c for c in fake.calls[len(calls):] if c in (apply['request']['id'], decide['request']['id'])], [])

    def test_a_pending_fund_request_blocks_new_proposals(self):
        apply = FUND['evidence']['apply_batch']
        self.fund_batch('apply', apply)
        fake = FakeCustody({apply['request']['id']: ['pending'] * (m.POLLS + 1)})
        report = self.run_with(fake)
        self.assertEqual(report['waiting']['id'], apply['request']['id'])
        self.assertEqual(self.proposals, [], 'no stage run while a fund request is unsettled')

    def test_fund_batches_of_unconfigured_fleet_projects_are_signed_too(self):
        import copy
        apply = copy.deepcopy(FUND['evidence']['apply_batch'])
        other = 'OPP-00003'
        bundle = apply['evidence']
        bundle.update(project=other, nativeProject='P-' + other)
        digest = m.js_digest(bundle)
        application = 'F-%s-%d-%s' % (other, bundle['round'], digest[:16])
        apply.update(project=other)
        apply['request'].update(id=application + '-a1')
        apply['request']['payload'].update(id=application, project='P-' + other, evidence_digest=digest)
        self.write(m.STAGE_ROOT / 'fund-batches' / other / 'x.json', apply)
        fake = FakeCustody({})
        report = self.run_with(fake)
        self.assertIn(application + '-a1', fake.calls)
        self.assertIn(application + '-a1', report['finalized'])

    def test_a_corrupt_fund_batch_stops_the_run(self):
        self.write(m.STAGE_ROOT / 'fund-batches' / PROJECT / 'bad.json', dict(schema='uain-fund-round-batch-v1', project=PROJECT, kind='apply'))
        with self.assertRaises(m.Stop) as stop:
            self.run_with(FakeCustody({}))
        self.assertEqual(str(stop.exception), 'invalid_fund_batch')


if __name__ == '__main__':
    unittest.main()

class ManagerStageSourcePins(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.root.chmod(0o700)
        self.source = self.root / 'manager_stage.py'
        self.source.write_bytes(Path(m.__file__).read_bytes())
        self.source.chmod(0o600)
        self.manifest = self.root / 'manager-stage-sources.json'
        self.approved = {'schema': 'uain-manager-stage-sources-v1', 'sha256': {'manager_stage.py': hashlib.sha256(self.source.read_bytes()).hexdigest()}}
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
        (self.root / '__pycache__' / 'manager_stage.cpython-313.pyc').write_bytes(b'forged bytecode')
        self.assertIsInstance(self.verify(), type(compile('', '', 'exec')))

    def test_hash_change_unknown_manifest_field_and_duplicate_keys_refuse(self):
        self.source.write_text(self.source.read_text() + '\nraise RuntimeError("must never run")\n')
        with self.assertRaisesRegex(m.Stop, 'source_hash'):
            self.verify()
        self.approved['extra'] = True
        self.save()
        with self.assertRaisesRegex(m.Stop, 'source_manifest'):
            self.verify()
        self.manifest.write_text('{"schema":"uain-manager-stage-sources-v1","schema":"other","sha256":{}}')
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
        text = self.source.read_text().replace("CONFIG = Path(", "Path(" + repr(str(sentinel)) + ").touch()\nCONFIG = Path(", 1)
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

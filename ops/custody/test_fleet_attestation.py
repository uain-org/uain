"""Fleet verification attestation tests. FICTIONAL policy, records and keys only; no root, vault or network."""
import base64
import copy
import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).absolute().parent
spec = importlib.util.spec_from_file_location('fleet_attestation', HERE / 'fleet_attestation.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

ME = (0, os.getuid())  # tests trust their own uid in place of root; checks are unchanged
# Shared with services/project-organizations/test/review-input.test.mjs; produced by the JavaScript code.
VECTOR = json.loads((HERE.parent.parent / 'services/project-organizations/test/fixtures/fleet-attestation-vector.json').read_text())
H = lambda c: c * 64


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def fake_signer(message):
    return dict(public_key=b'\x01' * 32, signature=hashlib.sha512(message).digest())


def passing(driver, policy, artifact):
    return dict(verdict='pass', reproductionAttestationDigest=None)


def payload_for(policy, answer, verdict='pass', reproduction=None):
    return m.expected_payload(policy, answer, verdict, reproduction)


class CanonicalVectorTests(unittest.TestCase):
    def test_canonical_json_matches_the_javascript_vector(self):
        for case in VECTOR['canonical']:
            self.assertEqual(m.js_canonical(case['value']), case['canonical'])
            self.assertEqual(m.js_digest(case['value']), case['sha256'])

    def test_attestation_payload_recomputed_from_custody_reads_matches_javascript(self):
        self.assertEqual(m.js_digest(VECTOR['policy']), VECTOR['policyDigest'])
        payload = payload_for(VECTOR['policy'], VECTOR['answer'])
        self.assertEqual(m.js_canonical(payload), m.js_canonical(VECTOR['payload']))
        self.assertEqual(m.js_digest(payload), VECTOR['verificationDigest'])

    def test_agrees_with_project_organizations_canonical_form_on_the_bmp(self):
        try:
            spec2 = importlib.util.spec_from_file_location('project_organizations', HERE / 'project_organizations.py')
            po = importlib.util.module_from_spec(spec2)
            spec2.loader.exec_module(po)
        except ImportError as error:  # pragma: no cover - its own dependencies are optional here
            self.skipTest('project_organizations unavailable: %s' % error)
        for value in (VECTOR['canonical'][0]['value'], VECTOR['policy'], VECTOR['payload']):
            self.assertEqual(m.js_canonical(value), po.js_canonical(value))

    def test_non_canonical_values_are_refused(self):
        for value in (1.5, 2 ** 53, {'a': float('nan')}, '\ud800', {1: 'x'}, (1, 2)):
            with self.subTest(value=repr(value)), self.assertRaises(m.Refused):
                m.js_canonical(value)
        for raw in (b'{"a":1,"a":2}', b'{"a":1.0}', b'{"a":NaN}', b'\xff'):
            with self.subTest(raw=raw), self.assertRaises(m.Refused):
                m.strict_json(raw)


class AttestTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=HERE)
        self.root = Path(self.tmp.name).resolve()
        os.chmod(self.root, 0o755)
        # Test-only stop for the parent walk: the checkout may be foreign-owned (e.g. a
        # container mount). Production never passes a boundary.
        self.boundary = self.root
        self.drivers = self.root / 'drivers'
        self.drivers.mkdir(mode=0o755)
        (self.drivers / 'finite-math-witness.mjs').write_text(VECTOR['driverSource'])
        self.policy_path = self.root / 'task-policy.json'
        self.write_policy(VECTOR['policy'])
        self.task = copy.deepcopy(VECTOR['task'])
        self.answer = copy.deepcopy(VECTOR['answer'])

    def tearDown(self):
        self.tmp.cleanup()

    def write_policy(self, policy):
        if self.policy_path.exists():
            self.policy_path.unlink()
        self.policy_path.write_text(json.dumps(policy))
        os.chmod(self.policy_path, 0o644)

    def attest(self, payload=None, digest=None, rerun=passing, signer=fake_signer, environment='fixture', **kw):
        payload = copy.deepcopy(VECTOR['payload']) if payload is None else payload
        digest = m.js_digest(payload) if digest is None else digest
        options = dict(trusted_uids=ME, driver_directory=self.drivers, boundary=self.boundary, now=lambda: VECTOR['attestedAtEpoch'])
        options.update(kw)
        return m.attest(self.policy_path, payload, digest, self.task, self.answer, rerun, signer, environment, **options)

    def refused(self, code, **kw):
        with self.assertRaises(m.Refused) as caught:
            self.attest(**kw)
        self.assertEqual(caught.exception.code, code)

    def test_a_bound_fixed_driver_pass_is_attested(self):
        envelope = self.attest()
        s = envelope['statement']
        self.assertEqual(set(s), m.STATEMENT_FIELDS)
        self.assertEqual((s['schema'], s['environment'], s['verdict'], s['mainKpiSatisfied']), (m.SCHEMA, 'fixture', 'pass', False))
        self.assertEqual((s['submission'], s['author'], s['task'], s['project']),
                         (self.answer['id'], self.answer['author'], self.task['id'], self.task['project']))
        self.assertEqual(s['criteriaDigest'], self.task['acceptance_digest'])
        self.assertEqual(s['evidenceDigest'], self.answer['evidence_digest'])
        self.assertEqual(s['policyDigest'], VECTOR['policyDigest'])
        self.assertEqual(s['driver'], VECTOR['policy']['driver'])
        self.assertEqual(s['verificationDigest'], VECTOR['verificationDigest'])
        self.assertEqual(envelope['statementDigest'], hashlib.sha256(m.statement_bytes(s)).hexdigest())
        self.assertEqual(envelope['statement'], VECTOR['envelope']['statement'])

    def test_rerun_receives_the_hashed_driver_bytes_and_copies(self):
        seen = []

        def rerun(driver, policy, artifact):
            seen.append(driver)
            policy['driver']['sha256'] = H('0')  # mutating the copy changes nothing
            return dict(verdict='pass', reproductionAttestationDigest=None)
        self.attest(rerun=rerun)
        self.assertEqual(seen[0]['source'], VECTOR['driverSource'].encode())
        self.assertEqual(seen[0]['sha256'], VECTOR['policy']['driver']['sha256'])

    @unittest.skipUnless(m.ed25519_available(), 'cryptography is not installed')
    def test_real_ed25519_signature_reproduces_the_shared_vector(self):
        envelope = self.attest(signer=m.ed25519_signer(bytes.fromhex(VECTOR['seedHex'])))
        self.assertEqual(envelope, VECTOR['envelope'])
        public = base64.b64decode(envelope['publicKey'])
        self.assertEqual(m.verify(envelope, public), envelope['statement'])
        tampered = copy.deepcopy(envelope)
        tampered['signature'] = base64.b64encode(b'\x00' * 64).decode()
        with self.assertRaises(m.Refused) as caught:
            m.verify(tampered, public)
        self.assertEqual(caught.exception.code, 'attestation_signature_invalid')
        edited = copy.deepcopy(envelope)
        edited['statement']['verdict'] = 'fail'
        with self.assertRaises(m.Refused) as caught:
            m.verify(edited, public)
        self.assertEqual(caught.exception.code, 'statement_digest_mismatch')
        with self.assertRaises(m.Refused):
            m.verify(envelope, b'\x02' * 32)

    def test_policy_must_be_root_owned_and_protected(self):
        if os.geteuid() != 0:
            with self.assertRaises(m.Refused):  # production trusts root only
                self.attest(trusted_uids=m.ROOT_UIDS)
        os.chmod(self.policy_path, 0o666)
        self.refused('untrusted_file')
        os.chmod(self.policy_path, 0o644)
        link = self.root / 'link.json'
        link.symlink_to(self.policy_path)
        with self.assertRaises(m.Refused):
            m.attest(link, VECTOR['payload'], VECTOR['verificationDigest'], self.task, self.answer, passing, fake_signer,
                     'fixture', trusted_uids=ME, driver_directory=self.drivers, boundary=self.boundary)
        os.chmod(self.root, 0o777)
        self.refused('untrusted_parent')
        os.chmod(self.root, 0o755)
        self.policy_path.write_text('{"schema":"x","schema":"x"}')
        self.refused('duplicate_key')

    def test_unsupported_class_and_unfixed_driver_are_refused(self):
        for cls in ('wet_lab', 'clinical_efficacy', 'patient_counts', 'narrative_literature', 'anything_new'):
            self.write_policy(dict(VECTOR['policy'], **{'class': cls}))
            self.refused('verification_adapter_required')
        self.write_policy(dict(VECTOR['policy'], driver=dict(name='pinned-dataset-analysis', sha256=VECTOR['policy']['driver']['sha256'])))
        self.refused('driver_not_fixed_for_class')
        self.write_policy(dict(VECTOR['policy'], extra='x'))
        self.refused('invalid_task_policy')

    def test_driver_bytes_must_match_the_policy_pin(self):
        self.refused('driver_directory_required', driver_directory=None)
        (self.drivers / 'finite-math-witness.mjs').write_text(VECTOR['driverSource'] + '// changed\n')
        self.refused('driver_hash_mismatch')

    def test_claimed_digest_must_be_the_recomputed_canonical_digest(self):
        self.refused('verification_digest_mismatch', digest=H('0'))
        self.refused('invalid_payload', digest='not-a-hash')
        self.refused('invalid_payload', payload=dict(VECTOR['payload'], extra=1))
        self.refused('main_kpi_claim_refused', payload=dict(VECTOR['payload'], mainKpiSatisfied=True))

    def test_payload_bindings_are_rechecked_against_custody_reads(self):
        cases = [
            (dict(submissionId='sub-other'), 'submission_mismatch'),
            (dict(author='uain1' + 'b' * 40), 'author_mismatch'),
            (dict(criteriaDigest=H('1')), 'criteria_mismatch'),
            (dict(artifactDigest=H('2')), 'evidence_mismatch'),
            (dict(policyDigest=H('3')), 'stale_policy_digest'),
            (dict(driver=dict(name='finite-math-witness', sha256=H('4'))), 'driver_mismatch'),
            (dict(reproductionAttestationDigest=H('5')), 'reproduction_attestation_mismatch'),
        ]
        for change, code in cases:
            with self.subTest(code=code):
                self.refused(code, payload=dict(VECTOR['payload'], **change))

    def test_a_policy_changed_after_verification_is_stale(self):
        changed = copy.deepcopy(VECTOR['policy'])
        changed['successTests'][0]['instance']['n'] = '15'
        self.write_policy(changed)
        self.refused('stale_policy_digest')

    def test_verdicts_not_decided_by_the_fixed_driver_are_refused(self):
        self.refused('verdict_not_decided_by_fixed_driver', payload=dict(VECTOR['payload'], verdict='needs_evidence'))
        self.refused('fixed_driver_rerun_required', rerun=None)
        for result in (dict(verdict='unverifiable', reproductionAttestationDigest=None), dict(verdict='pass'), None,
                       dict(verdict='pass', reproductionAttestationDigest=H('6'))):
            with self.subTest(result=result):
                self.refused('verdict_not_decided_by_fixed_driver', rerun=lambda d, p, a, r=result: r)
        self.refused('verdict_mismatch', rerun=lambda d, p, a: dict(verdict='fail', reproductionAttestationDigest=None))
        fail_payload = payload_for(VECTOR['policy'], self.answer, 'fail')
        envelope = self.attest(payload=fail_payload, rerun=lambda d, p, a: dict(verdict='fail', reproductionAttestationDigest=None))
        self.assertEqual(envelope['statement']['verdict'], 'fail')

    def test_native_records_and_evidence_must_bind(self):
        bad = [
            ('task', dict(state='accepted'), 'task_not_under_review'),
            ('task', dict(pending='sub-other'), 'task_not_under_review'),
            ('task', dict(project='P-OPP-00002'), 'policy_task_mismatch'),
            ('task', dict(acceptance_digest=H('7')), 'policy_criteria_mismatch'),
            ('task', dict(criteria='rewritten'), 'criteria_digest_mismatch'),
            ('answer', dict(state='accepted'), 'submission_not_under_review'),
            ('answer', dict(evidence_digest=H('8')), 'evidence_digest_mismatch'),
        ]
        for which, change, code in bad:
            with self.subTest(code=code):
                records = dict(task=dict(self.task), answer=dict(self.answer))
                records[which].update(change)
                with self.assertRaises(m.Refused) as caught:
                    m.attest(self.policy_path, VECTOR['payload'], VECTOR['verificationDigest'], records['task'], records['answer'], passing,
                             fake_signer, 'fixture', trusted_uids=ME, driver_directory=self.drivers, boundary=self.boundary)
                self.assertEqual(caught.exception.code, code)

    def answer_with(self, artifact, canonical=True):
        evidence = m.js_canonical(artifact) if canonical else json.dumps(artifact, indent=1)
        return dict(self.answer, evidence=evidence, evidence_digest=sha(evidence))

    def test_evidence_must_be_the_canonical_artifact_without_its_own_verdict(self):
        artifact = json.loads(self.answer['evidence'])
        cases = [
            (self.answer_with(artifact, canonical=False), 'evidence_not_canonical_artifact'),
            (self.answer_with(dict(artifact, verdict='pass')), 'artifact_supplied_attestation_rejected'),
            (self.answer_with(dict(artifact, attestationDigest=H('9'))), 'artifact_supplied_attestation_rejected'),
            (self.answer_with(dict(artifact, trusted_verification=dict(verdict='pass'))), 'artifact_supplied_attestation_rejected'),
            (self.answer_with(dict(artifact, submissionId='sub-other')), 'artifact_binding_mismatch'),
            (self.answer_with(dict(artifact, author='uain1' + 'c' * 40)), 'artifact_binding_mismatch'),
        ]
        for answer, code in cases:
            with self.subTest(code=code), self.assertRaises(m.Refused) as caught:
                m.attest(self.policy_path, VECTOR['payload'], VECTOR['verificationDigest'], self.task, answer, passing, fake_signer,
                         'fixture', trusted_uids=ME, driver_directory=self.drivers, boundary=self.boundary)
            self.assertEqual(caught.exception.code, code)

    def test_a_fixture_run_can_never_be_labelled_production(self):
        self.refused('production_requires_root', environment='production')  # test uids
        self.refused('production_requires_root', environment='production', trusted_uids=m.ROOT_UIDS, euid=lambda: 1000)
        # A test boundary can never be used for a production attestation, even as root.
        self.refused('production_requires_root', environment='production', trusted_uids=m.ROOT_UIDS, euid=lambda: 0)
        self.refused('invalid_environment', environment='staging')

    def test_signer_output_is_checked(self):
        self.refused('invalid_signature', signer=lambda message: dict(public_key=b'\x01' * 31, signature=b'\x02' * 64))
        self.refused('invalid_signature', signer=lambda message: dict(public_key=b'\x01' * 32, signature=b'\x02' * 64, extra=1))

    def test_source_code_reproduction_needs_the_protected_reproduction_digest(self):
        policy = dict(VECTOR['policy'], **{'class': 'source_code_reproduction'},
                      inputs=[dict(url='https://github.com/example/repo/archive/abc.tar.gz', sha256=H('a'), bytes=10)],
                      primarySourceHosts=['github.com'], driver=dict(name='protected-reproduction-attestation', sha256=H('b')),
                      successTests=[dict(id='repro', before='failed', after='passed')])
        self.write_policy(policy)
        payload = payload_for(policy, self.answer, 'pass', H('c'))
        envelope = self.attest(payload=payload, driver_directory=None,
                               rerun=lambda d, p, a: dict(verdict='pass', reproductionAttestationDigest=H('c')))
        self.assertEqual(envelope['statement']['reproductionAttestationDigest'], H('c'))
        self.assertIsNone(envelope['statement']['driver'].get('source'))
        self.refused('protected_reproduction_required', payload=payload, driver_directory=None, rerun=passing)
        self.refused('reproduction_attestation_mismatch', payload=payload, driver_directory=None,
                     rerun=lambda d, p, a: dict(verdict='pass', reproductionAttestationDigest=H('d')))


class ReviewBindingTests(unittest.TestCase):
    """check_review_bindings: the central reviewer's recheck of a stored envelope (reviewInput in Python)."""

    def check(self, envelope=None, environment='fixture', policy=None, task=None, answer=None, key=None, now=None):
        envelope = copy.deepcopy(VECTOR['envelope']) if envelope is None else envelope
        key = base64.b64decode(VECTOR['envelope']['publicKey']) if key is None else key
        return m.check_review_bindings(envelope, key, environment, copy.deepcopy(policy or VECTOR['policy']),
                                       copy.deepcopy(task or VECTOR['task']), copy.deepcopy(answer or VECTOR['answer']),
                                       now=now or (lambda: VECTOR['attestedAtEpoch']))

    def refused(self, code, **kw):
        with self.assertRaises(m.Refused) as caught:
            self.check(**kw)
        self.assertEqual(caught.exception.code, code)

    def test_parse_policy_matches_load_policy(self):
        self.assertEqual(m.parse_policy(json.dumps(VECTOR['policy']).encode()), VECTOR['policy'])
        with self.assertRaises(m.Refused):
            m.parse_policy(json.dumps(dict(VECTOR['policy'], extra=1)).encode())

    def test_prior_art_survey_class_pins_only_its_own_driver(self):
        # The first task of every organization (services/project-organizations/src/survey.mjs).
        survey = dict(VECTOR['policy'], **{'class': 'prior_art_survey', 'inputs': [],
                                           'driver': dict(name='prior-art-survey', sha256=H('5')),
                                           'successTests': [dict(id='survey', mainKpi='FIXTURE Main KPI text here.', minIncluded=8,
                                                                 minKinds=2, requiredIds=[])]})
        self.assertEqual(m.parse_policy(json.dumps(survey).encode())['class'], 'prior_art_survey')
        self.assertIn('prior-art-survey', m.FILE_DRIVERS)
        with self.assertRaises(m.Refused) as caught:
            m.parse_policy(json.dumps(dict(survey, driver=dict(name='finite-math-witness', sha256=H('5')))).encode())
        self.assertEqual(caught.exception.code, 'driver_not_fixed_for_class')
        statement = dict(VECTOR['envelope']['statement'], evidenceClass='prior_art_survey', driver=dict(name='prior-art-survey', sha256=H('5')))
        self.assertEqual(m.validate_statement(statement)['evidenceClass'], 'prior_art_survey')

    def test_validate_statement_mirrors_the_javascript_shape(self):
        self.assertEqual(m.validate_statement(VECTOR['envelope']['statement']), VECTOR['envelope']['statement'])
        for change in (dict(environment='staging'), dict(author='alice'), dict(verdict='needs_evidence'), dict(evidenceClass='wet_lab'),
                       dict(reproductionAttestationDigest=H('1')), dict(attestedAt='2026-11-06T12:00:00.000Z'),
                       dict(attestedAt='2026-13-40T12:00:00Z'), dict(driver=dict(name='pinned-dataset-analysis', sha256=H('2')))):
            with self.subTest(change=change), self.assertRaises(m.Refused):
                m.validate_statement(dict(VECTOR['envelope']['statement'], **change))

    @unittest.skipUnless(m.ed25519_available(), 'cryptography is not installed')
    def test_the_shared_vector_passes_and_every_binding_is_checked(self):
        self.assertEqual(self.check(), VECTOR['envelope']['statement'])
        self.refused('attestation_environment_mismatch', environment='production')
        self.refused('untrusted_attestation_key', key=b'\x02' * 32)
        self.refused('attestation_from_future', now=lambda: VECTOR['attestedAtEpoch'] - 3600)
        self.refused('stale_policy_digest', policy=dict(VECTOR['policy'], successTests=[dict(VECTOR['policy']['successTests'][0], id='other')]))
        self.refused('attestation_evidence_mismatch', answer=dict(VECTOR['answer'], evidence_digest=H('3')))
        self.refused('attestation_author_mismatch', answer=dict(VECTOR['answer'], author='uain1' + 'c' * 40))
        self.refused('submission_not_under_review', answer=dict(VECTOR['answer'], state='accepted'))
        self.refused('criteria_digest_mismatch', task=dict(VECTOR['task'], criteria='rewritten'))
        self.refused('attestation_policy_mismatch', task=dict(VECTOR['task'], project='P-OPP-00002'))
        tampered = copy.deepcopy(VECTOR['envelope'])
        tampered['statementDigest'] = H('4')
        self.refused('statement_digest_mismatch', envelope=tampered)
        tampered = copy.deepcopy(VECTOR['envelope'])
        tampered['signature'] = base64.b64encode(b'\x00' * 64).decode()
        self.refused('attestation_signature_invalid', envelope=tampered)
        tampered['extra'] = 1
        self.refused('invalid_attestation', envelope=tampered)


if __name__ == '__main__':
    unittest.main()

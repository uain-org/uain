"""Fictional native records; no vault, network, production files or signing."""
import contextlib
import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import fleet_attestation as fa
import survey_attester as subject


class PendingPreflightTests(unittest.TestCase):
    def fixture(self, root):
        tasks, answers, policies = {}, {}, {}
        for n in (1, 2):
            tid = 'T-OPP-%05d-1-prior-art-survey' % n
            sid = 'HS-fixture-%d' % n
            criteria = 'Fictional criteria %d' % n
            digest = hashlib.sha256(criteria.encode()).hexdigest()
            artifact = dict(schema=fa.ARTIFACT_SCHEMA, author='uain1'+'a'*40, taskId=tid, submissionId=sid, survey={})
            wire = fa.js_canonical(artifact)
            tasks[tid] = dict(id=tid, project='P-fixture', state='under_review', pending=sid, criteria=criteria, acceptance_digest=digest)
            answers[sid] = dict(id=sid, task=tid, state='under_review', author=artifact['author'], evidence=wire, evidence_digest=fa.sha(wire.encode()))
            policies[tid] = dict(**{'class':'prior_art_survey'},taskId=tid, projectId='P-fixture', criteriaDigest=digest)
        return tasks, answers, policies

    def run_fixture(self, root, tasks, answers, policies, policy_error=None, spies=None, custody_error=None, verdict='pass', findings=None, sign=None):
        def status(keys):
            return {k: (tasks if k.startswith('central_task/') else answers)[k.split('/',1)[1]] for k in keys}
        def policy(path):
            if policy_error: raise policy_error
            return policies[path.stem]
        with contextlib.ExitStack() as stack:
            for name, value in [('RELEASE_LINK',root),('ENVELOPES',root),('POLICIES',root)]: stack.enter_context(patch.object(subject,name,value))
            stage = Path(root) / 'staged-verifier'
            staged = stack.enter_context(patch.object(subject,'staged_verifier',side_effect=lambda: contextlib.nullcontext(stage)))
            if spies is not None: spies['staged'] = staged
            stack.enter_context(patch.object(subject.os,'geteuid',return_value=0))
            stack.enter_context(patch.object(subject,'survey_tasks',return_value=list(tasks)))
            stack.enter_context(patch.object(subject,'status',side_effect=status))
            def protected(p,*args):
                if p==subject.VERSION_SELECTION:raise FileNotFoundError()
                return json.dumps(policies[p.stem]).encode()
            stack.enter_context(patch.object(subject,'_protected',side_effect=protected))
            stack.enter_context(patch.object(fa,'load_policy',side_effect=policy))
            verifier=stack.enter_context(patch.object(subject,'verify',return_value=dict(verdict=verdict,attestation={},attestationDigest='a'*64,findings=list(findings or []))))
            verifier.return_value['attestation']={'fixture':True}
            signer=stack.enter_context(patch.object(subject,'signer',return_value=sign or (lambda _:None)))
            stack.enter_context(patch.object(subject,'locked',return_value=contextlib.nullcontext()))
            def attest_checked(path, claim, digest, task, answer, *args, **kwargs):
                if custody_error:raise custody_error
                fa._evidence_artifact(policies[path.stem], task, answer)
                signed=args[1](b'fictional attestation message')
                return {'statement':{'verdict':verdict},'statementDigest':'d'*64,'publicKey':fa.base64.b64encode(signed['public_key']).decode() if signed else None}
            attest=stack.enter_context(patch.object(fa,'attest',side_effect=attest_checked))
            def attest_v2_checked(path,claim,digest,task,answer,*args,**kwargs):
                fa.evidence_artifact_v2(policies[path.stem],task,answer)
                args[1](b'fictional v2 attestation message')
                return {'statement':{'verdict':'pass'}}
            attest_v2=stack.enter_context(patch.object(fa,'attest_v2',side_effect=attest_v2_checked))
            if spies is not None:spies.update(verify=verifier,signer=signer,attest=attest,attest_v2=attest_v2)
            atomic=stack.enter_context(patch.object(subject,'atomic'))
            if spies is not None:spies['atomic']=atomic
            return subject.run(),verifier,signer,attest

    def test_noncanonical_first_is_explicitly_held_and_later_valid_still_attests(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);tasks,answers,policies=self.fixture(root)
            first=next(iter(answers.values())); first['evidence']=json.dumps(json.loads(first['evidence']),indent=2);first['evidence_digest']=fa.sha(first['evidence'].encode())
            report,verify,signer,attest=self.run_fixture(root,tasks,answers,policies)
            self.assertEqual(report['skipped'],[dict(task=first['task'],submission=first['id'],status='held',reason='evidence_not_canonical_artifact')])
            self.assertEqual(len(report['attested']),1)
            self.assertEqual(verify.call_count,2)
            self.assertTrue(all(c.args[2]['submissionId']!=first['id'] for c in verify.call_args_list))
            self.assertEqual(signer.call_count,1);self.assertEqual(attest.call_count,1)

    def test_bad_digest_and_json_never_fetch_or_construct_signer(self):
        for bad,reason in [('not JSON','invalid_json'),('{"x":1,"x":2}','duplicate_key'),('{"n":1.5}','non_canonical_value'),('{"x":'+'['*1100+'0'+']'*1100+'}','evidence_structure_over_limit'),('{"\\ud800":0}','non_canonical_value')]:
            with self.subTest(reason=reason),tempfile.TemporaryDirectory() as directory:
                root=Path(directory);tasks,answers,policies=self.fixture(root)
                tasks={next(iter(tasks)):next(iter(tasks.values()))};a=answers[next(iter(answers))];a['evidence']=bad;a['evidence_digest']=fa.sha(bad.encode())
                report,verify,signer,attest=self.run_fixture(root,tasks,answers,policies)
                self.assertEqual(report['skipped'][0]['reason'],reason);self.assertEqual(report['attested'],[])
                verify.assert_not_called();signer.assert_not_called();attest.assert_not_called()

    def test_digest_binding_and_unknown_failures_are_not_signed(self):
        for kind, reason in [('digest','evidence_digest_mismatch'),('author','artifact_binding_mismatch'),('attestation','artifact_supplied_attestation_rejected')]:
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as directory:
                root=Path(directory);tasks,answers,policies=self.fixture(root)
                tasks={next(iter(tasks)):next(iter(tasks.values()))};a=answers[next(iter(answers))]
                if kind=='digest':a['evidence_digest']='b'*64
                else:
                    artifact=json.loads(a['evidence'])
                    artifact['author' if kind=='author' else 'attestation']='uain1'+'b'*40
                    a['evidence']=fa.js_canonical(artifact);a['evidence_digest']=fa.sha(a['evidence'].encode())
                report,verify,signer,attest=self.run_fixture(root,tasks,answers,policies)
                self.assertEqual(report['skipped'][0]['reason'],reason)
                verify.assert_not_called();signer.assert_not_called();attest.assert_not_called()
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);tasks,answers,policies=self.fixture(root)
            with patch.object(fa,'_evidence_artifact',side_effect=fa.Refused('unexpected_new_failure')):
                with self.assertRaisesRegex(fa.Refused,'unexpected_new_failure'):
                    self.run_fixture(root,tasks,answers,policies)

    def test_another_completed_run_statement_is_never_replaced_after_retrieval(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);tasks,answers,policies=self.fixture(root);tasks={next(iter(tasks)):next(iter(tasks.values()))};spies={}
            sid=next(iter(tasks.values()))['pending'];target=root/(hashlib.sha256(sid.encode()).hexdigest()+'.json')
            original=Path.exists;seen=0
            def exists(path):
                nonlocal seen
                if path==target:seen+=1;return seen>=2
                return original(path)
            with patch.object(Path,'exists',exists):report,_,_,_=self.run_fixture(root,tasks,answers,policies,spies=spies)
            self.assertEqual(report['attested'],[]);spies['signer'].assert_not_called();spies['atomic'].assert_not_called()

    def test_custody_validation_failure_never_constructs_vault_signer(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);tasks,answers,policies=self.fixture(root);spies={}
            with self.assertRaisesRegex(fa.Refused,'invalid_payload'):
                self.run_fixture(root,tasks,answers,policies,spies=spies,custody_error=fa.Refused('invalid_payload'))
            spies['signer'].assert_not_called()

    def test_v2_depth_limit_is_held_without_fetch_and_later_valid_task_continues(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);tasks,answers,policies=self.fixture(root)
            first=answers[next(iter(answers))];artifact=json.loads(first['evidence']);artifact['survey']['nested']=json.loads('['*65+'0'+']'*65)
            first['evidence']=json.dumps(artifact);first['evidence_digest']=fa.sha(first['evidence'].encode())
            self.assertLess(len(first['evidence'].encode()),16384)
            with patch.object(subject,'version_admission',return_value=dict(version=2,allowedVersions=[1,2],**fa.V2_NETWORK)):
                report,verify,signer,_=self.run_fixture(root,tasks,answers,policies)
            self.assertEqual(report['skipped'],[dict(task=first['task'],submission=first['id'],status='held',reason='evidence_structure_over_limit')])
            self.assertEqual(len(report['attested']),1);self.assertEqual(verify.call_count,2);self.assertEqual(signer.call_count,1)
            self.assertTrue(all(c.args[2]['submissionId']!=first['id'] for c in verify.call_args_list))

    def test_explicit_v2_dispatch_keeps_noncanonical_native_bytes_unchanged(self):
        import copy
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);tasks,answers,policies=self.fixture(root);tasks={next(iter(tasks)):next(iter(tasks.values()))};spies={}
            a=answers[next(iter(answers))];a['evidence']=json.dumps(json.loads(a['evidence']),indent=2);a['evidence_digest']=fa.sha(a['evidence'].encode());before=copy.deepcopy(answers)
            with patch.object(subject,'version_admission',return_value=dict(version=2,allowedVersions=[1,2],**fa.V2_NETWORK)) as admission:
                report,verify,signer,_=self.run_fixture(root,tasks,answers,policies,spies=spies)
            self.assertEqual(len(report['attested']),1);self.assertEqual(report['skipped'],[]);self.assertEqual(answers,before)
            self.assertEqual(admission.call_count,3);self.assertEqual(verify.call_count,2)
            self.assertTrue(all(c.kwargs==dict(version=2,native_evidence=a['evidence'],network=fa.V2_NETWORK) for c in verify.call_args_list))
            spies['attest'].assert_not_called();self.assertEqual(spies['attest_v2'].call_count,1);self.assertEqual(signer.call_count,1)

    def test_v2_admission_is_checked_before_fetch_and_again_before_signer(self):
        for before in (0,2):
            with self.subTest(before=before),tempfile.TemporaryDirectory() as directory:
                root=Path(directory);tasks,answers,policies=self.fixture(root)
                tasks={next(iter(tasks)):next(iter(tasks.values()))};spies={}
                good=dict(version=2,allowedVersions=[1,2],**fa.V2_NETWORK)
                sequence=[good]*before+[fa.Refused('reviewer_runtime_mismatch')]
                with patch.object(subject,'version_admission',side_effect=sequence):
                    with self.assertRaisesRegex(fa.Refused,'reviewer_runtime_mismatch'):
                        self.run_fixture(root,tasks,answers,policies,spies=spies)
                self.assertEqual(spies['verify'].call_count,0 if before==0 else 2)
                spies['signer'].assert_not_called();spies['attest_v2'].assert_not_called()

    def test_protected_policy_misfiled_for_another_task_is_fatal(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);tasks,answers,policies=self.fixture(root)
            policies[next(iter(policies))]['taskId']='T-other'
            with self.assertRaisesRegex(subject.Stop,'policy_filename_mismatch'):
                self.run_fixture(root,tasks,answers,policies)

    def test_policy_fault_is_fatal_not_disguised_as_submission_hold(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);tasks,answers,policies=self.fixture(root)
            with self.assertRaisesRegex(fa.Refused,'invalid_task_policy'):
                self.run_fixture(root,tasks,answers,policies,fa.Refused('invalid_task_policy'))

class PinnedVerifierTests(unittest.TestCase):
    """10 November 2026 (plan W11, audit 12b #4): the verifier Node runs is a private copy of a
    root-pinned closure, never the mutable /opt/uain-organizations/current release."""
    REPO = HERE.parent.parent

    def release(self, root):
        release = Path(root) / 'release'
        for name in subject.VERIFIER_FILES:
            (release / name).parent.mkdir(parents=True, exist_ok=True)
            (release / name).write_bytes((self.REPO / name).read_bytes())
        pins = {n: hashlib.sha256((release / n).read_bytes()).hexdigest() for n in subject.VERIFIER_FILES}
        return release, pins

    def test_closure_list_is_the_whole_import_closure_of_verify_survey(self):
        import re
        seen, todo = set(), [self.REPO / 'services/project-organizations/ops/verify-survey.mjs']
        while todo:
            f = todo.pop().resolve()
            if f in seen: continue
            seen.add(f)
            text = f.read_text()
            # Static `from '…'` (also minified `import{x}from'…'`), side-effect and dynamic imports.
            specs = re.findall(r"""\bfrom\s*['"]([^'"]+)['"]""", text) + re.findall(r"""\bimport\s*\(?\s*['"]([^'"]+)['"]""", text)
            for spec in specs:
                self.assertTrue(spec.startswith(('.', 'node:', 'data:')), 'package import %s in %s must be pinned too' % (spec, f))
                if spec.startswith('.'): todo.append(f.parent / spec)
        self.assertEqual(sorted(str(f.relative_to(self.REPO.resolve())) for f in seen), sorted(subject.VERIFIER_FILES))

    def test_staged_copy_holds_exactly_the_pinned_bytes_and_is_removed(self):
        with tempfile.TemporaryDirectory() as root:
            release, pins = self.release(root)
            with subject.staged_verifier(release, pins, read=lambda p: Path(p).read_bytes(), parent=Path(root) / 'stage') as stage:
                self.assertNotEqual(stage.resolve(), release.resolve())
                for name in subject.VERIFIER_FILES:
                    self.assertEqual((stage / name).read_bytes(), (release / name).read_bytes())
            self.assertEqual(list((Path(root) / 'stage').iterdir()), [])

    def test_the_staged_copy_alone_loads_in_node(self):
        import shutil, subprocess
        node = shutil.which('node')
        if node is None:
            self.skipTest('node is not installed')
        with tempfile.TemporaryDirectory() as root:
            release, pins = self.release(root)
            with subject.staged_verifier(release, pins, read=lambda p: Path(p).read_bytes(), parent=Path(root) / 'stage') as stage:
                script = (stage / 'services/project-organizations/ops/verify-survey.mjs').resolve()
                # argv[1] is a directory, so the script's own `main` guard stays off and only the imports load.
                done = subprocess.run([node, '--input-type=module', '-e', 'await import(process.argv[2]); console.log("loaded")', str(stage), script.as_uri()],
                                      capture_output=True, text=True, timeout=60, cwd=str(stage))
                self.assertEqual(done.returncode, 0, done.stderr[-600:])
                self.assertEqual(done.stdout.strip(), 'loaded')

    def test_a_verifier_that_self_reports_the_pinned_digest_but_differs_is_refused(self):
        with tempfile.TemporaryDirectory() as root:
            release, pins = self.release(root)
            script = release / 'services/project-organizations/ops/verify-survey.mjs'
            # A changed driver that still reports the pinned digest and a pass.
            before = script.read_text()
            script.write_text(before + "\nexport const selfReport = { driverSha256: %r, verdict: 'pass' };\n" % pins['services/project-organizations/verifiers/prior-art-survey.mjs'])
            self.assertNotEqual(script.read_text(), before)
            with self.assertRaises(subject.Stop) as refused:
                with subject.staged_verifier(release, pins, read=lambda p: Path(p).read_bytes(), parent=Path(root) / 'stage'):
                    self.fail('a changed verifier must not be staged')
            self.assertEqual(str(refused.exception), 'verifier_source_hash')
            self.assertEqual(list((Path(root) / 'stage').iterdir()), [])

    def test_the_pin_must_name_exactly_the_closure(self):
        with tempfile.TemporaryDirectory() as root:
            _, pins = self.release(root)
            for bad in ({k: v for k, v in list(pins.items())[1:]}, {**pins, 'extra.mjs': 'a' * 64}, {**pins, subject.VERIFIER_FILES[0]: 'not-a-hash'}):
                path = Path(root) / 'pins.json'
                path.write_text(json.dumps(dict(schema=subject.VERIFIER_SCHEMA, sha256=bad)))
                with patch.object(subject, '_protected', side_effect=lambda p, limit=0: Path(p).read_bytes()):
                    with self.assertRaises(subject.Stop) as refused:
                        subject.verifier_pins(path)
                self.assertEqual(str(refused.exception), 'verifier_manifest')
            with patch.object(subject, '_protected', side_effect=lambda p, limit=0: Path(p).read_bytes()):
                with self.assertRaises(subject.Stop) as missing:
                    subject.verifier_pins(Path(root) / 'absent.json')
            self.assertEqual(str(missing.exception), 'verifier_manifest')

    def test_run_executes_the_staged_copy_not_the_release_link(self):
        case = PendingPreflightTests()
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            tasks, answers, policies = case.fixture(root)
            spies = {}
            case.run_fixture(root, tasks, answers, policies, spies=spies)
            stage = Path(root) / 'staged-verifier'
            self.assertEqual(spies['staged'].call_count, 1)
            self.assertTrue(spies['verify'].call_args_list)
            for call in spies['verify'].call_args_list:
                self.assertEqual(call.args[0], stage)
            for call in spies['attest'].call_args_list:
                self.assertEqual(call.kwargs['driver_directory'], stage / 'services/project-organizations/verifiers')


class SurveyPartTasks(unittest.TestCase):
    """Survey parts listed by the order are attested with their own root policies."""
    def test_order_parts_add_part_tasks_and_refuse_foreign_ones(self):
        order = {'schema': 'uain-organization-starter-order-v1', 'projects': ['OPP-00004', 'OPP-00009'], 'min_open': 12, 'parts': ['OPP-00004']}
        built = json.loads((HERE.parents[1] / 'docs/baink/project-organizations-2026-11-06/survey-parts/OPP-00004.parts.json').read_text())
        files = {'order.json': order, 'OPP-00004.parts.json': built}
        with patch.object(subject, '_protected', side_effect=lambda path, limit=0: json.dumps(files[Path(path).name]).encode()), \
                patch.object(subject.os, 'listdir', return_value=['order.json', 'OPP-00004.parts.json', 'OPP-00009.agent-r3.parts.json']):
            tasks = subject.survey_tasks()
            self.assertEqual(tasks, ['T-OPP-00004-1-prior-art-survey', 'T-OPP-00009-1-prior-art-survey',
                                     'T-OPP-00004-1-prior-art-survey-r2-p1', 'T-OPP-00004-1-prior-art-survey-r2-p2',
                                     'T-OPP-00004-1-prior-art-survey-r2-p3'])
            self.assertTrue(all(subject.SURVEY.fullmatch(t) for t in tasks))
            built['parts'][0]['request']['payload']['id'] = 'T-OPP-00009-1-prior-art-survey-r2-p1'
            with self.assertRaisesRegex(subject.Stop, 'invalid_parts'):
                subject.survey_tasks()
            order['parts'] = ['OPP-00005']
            with self.assertRaisesRegex(subject.Stop, 'invalid_order'):
                subject.survey_tasks()

    def test_project_agent_revisions_are_attested_after_the_reviewed_parts(self):
        order = {'schema': 'uain-organization-starter-order-v1', 'projects': ['OPP-00004'], 'min_open': 12, 'parts': ['OPP-00004']}
        built = json.loads((HERE.parents[1] / 'docs/baink/project-organizations-2026-11-06/survey-parts/OPP-00004.parts.json').read_text())
        agent = json.loads(json.dumps(built))
        for n, row in enumerate(agent['parts'], 1):
            row['request']['payload']['id'] = 'T-OPP-00004-1-prior-art-survey-r3-p%d' % n
        files = {'order.json': order, 'OPP-00004.parts.json': built, 'OPP-00004.agent-r3.parts.json': agent}
        with patch.object(subject, '_protected', side_effect=lambda path, limit=0: json.dumps(files[Path(path).name]).encode()), \
                patch.object(subject.os, 'listdir', return_value=list(files) + ['OPP-00004.agent-r1.parts.json']):
            tasks = subject.survey_tasks()
        self.assertEqual(tasks[-3:], ['T-OPP-00004-1-prior-art-survey-r3-p1', 'T-OPP-00004-1-prior-art-survey-r3-p2', 'T-OPP-00004-1-prior-art-survey-r3-p3'])
        self.assertEqual(len(tasks), 7)

    def test_v1_project_without_reviewed_parts_attests_agent_revisions(self):
        """OPP-00002/03/09/10/14 (10 November 2026): full survey opened, no reviewed parts file."""
        order = {'schema': 'uain-organization-starter-order-v1', 'projects': ['OPP-00002'], 'min_open': 12, 'parts': ['OPP-00002']}
        built = json.loads((HERE.parents[1] / 'docs/baink/project-organizations-2026-11-06/survey-parts/OPP-00004.parts.json').read_text())
        agent = json.loads(json.dumps(built).replace('OPP-00004', 'OPP-00002'))
        for n, row in enumerate(agent['parts'], 1):
            row['request']['payload']['id'] = 'T-OPP-00002-1-prior-art-survey-r3-p%d' % n
        files = {'order.json': order, 'OPP-00002.agent-r3.parts.json': agent}
        with patch.object(subject, '_protected', side_effect=lambda path, limit=0: json.dumps(files[Path(path).name]).encode()), \
                patch.object(subject.os, 'listdir', return_value=list(files)):
            self.assertEqual(subject.survey_tasks(), ['T-OPP-00002-1-prior-art-survey'] + ['T-OPP-00002-1-prior-art-survey-r3-p%d' % n for n in (1, 2, 3)])
        with patch.object(subject, '_protected', side_effect=lambda path, limit=0: json.dumps(files[Path(path).name]).encode()), \
                patch.object(subject.os, 'listdir', return_value=['order.json']):
            self.assertEqual(subject.survey_tasks(), ['T-OPP-00002-1-prior-art-survey'])

    def test_status_reads_in_chunks(self):
        calls = []
        def run(args, **kw):
            keys = json.loads(args[-1]); calls.append(len(keys))
            class Done: returncode = 0; stdout = json.dumps({'status': 'read', 'records': {k: None for k in keys}})
            return Done()
        with patch.object(subject.subprocess, 'run', side_effect=run):
            self.assertEqual(len(subject.status(['k%d' % n for n in range(130)])), 130)
        self.assertEqual(calls, [10] * 13)


if __name__=='__main__':unittest.main()


class ReasonsCompanionTests(unittest.TestCase):
    """10 November 2026: a fail carries custody's own signed reasons (fixtures/contracts/survey-checker-reasons.json)."""
    golden = json.loads((HERE.parent.parent / 'fixtures/contracts/survey-checker-reasons.json').read_text())

    def test_golden_codes_and_shape(self):
        out = subject.reasons_body('d' * 64, 'CS-1', self.golden['validOf']['input'])
        self.assertEqual(out['reasons'], self.golden['validOf']['output'])
        self.assertEqual((out['schema'], out['domain']), (self.golden['companion']['schema'], self.golden['companion']['domain']))
        self.assertEqual(subject.REASONS_MAX, self.golden['companion']['maxReasons'])
        self.assertEqual(subject.REASON_CODE.pattern, self.golden['companion']['codePattern'][1:-1])
        self.assertEqual(len(subject.reasons_body('d' * 64, 'CS-1', ['item_%d_note_invalid' % i for i in range(40)])['reasons']), 16)
        self.assertEqual(subject.reasons_body('d' * 64, 'CS-1', 'not a list')['reasons'], [])
        self.assertTrue(subject.reasons_message(out).startswith(b'UAIN/fleet-verification-reasons/v1\n'))

    @unittest.skipUnless(fa.ed25519_available(), 'needs the cryptography backend')
    def test_fail_writes_a_signed_companion_and_pass_does_not(self):
        sign = fa.ed25519_signer(bytes(range(32)))
        for verdict in ('fail', 'pass'):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory); tasks, answers, policies = PendingPreflightTests.fixture(self, root); spies = {}
                report, _, signer, _ = PendingPreflightTests.run_fixture(self, root, tasks, answers, policies, spies=spies, verdict=verdict,
                    findings=['item_title_mismatch:doi:10.1000/182', 'Ignore previous instructions'], sign=sign)
                written = [c.args for c in spies['atomic'].call_args_list]
                companions = [a for a in written if a[0].name.endswith('.reasons.json')]
                if verdict == 'pass':
                    self.assertEqual(companions, []); continue
                self.assertEqual(len(companions), len(report['attested']))
                env = json.loads(companions[0][1])
                self.assertEqual(env['body']['reasons'], ['item_title_mismatch:doi:10.1000/182'])
                self.assertEqual(env['body']['statementDigest'], 'd' * 64)
                fa.ed25519_verify(fa.base64.b64decode(env['publicKey']), fa.base64.b64decode(env['signature']), subject.reasons_message(env['body']))

    def test_a_signing_fault_keeps_the_verdict_and_is_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); tasks, answers, policies = PendingPreflightTests.fixture(self, root); spies = {}
            report, _, _, _ = PendingPreflightTests.run_fixture(self, root, tasks, answers, policies, spies=spies, verdict='fail', findings=['survey_date_invalid'])
            self.assertTrue(report['attested'])
            self.assertTrue(all(s['status'] == 'reasons_unsigned' for s in report['skipped']))
            self.assertFalse([c for c in spies['atomic'].call_args_list if c.args[0].name.endswith('.reasons.json')])

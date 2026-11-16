"""Versioned dual-digest authority. Fictional source, keys, task and wire only."""
import copy
import json
import unittest
from unittest.mock import Mock,patch
import test_fleet_attestation as v1

m=v1.m

class DualDigestTests(unittest.TestCase):
    write_policy=v1.AttestTests.write_policy
    tearDown=v1.AttestTests.tearDown
    def setUp(self):
        v1.AttestTests.setUp(self)
        self.policy=copy.deepcopy(v1.VECTOR['policy'])
        self.policy['class']='prior_art_survey'
        self.policy['driver']['name']='prior-art-survey'
        (self.drivers/'prior-art-survey.mjs').write_text(v1.VECTOR['driverSource'])
        self.write_policy(self.policy)
        a=json.loads(self.answer['evidence'])
        a={k:v for k,v in a.items() if k in ('schema','author','taskId','submissionId')}
        a['survey']={'mainKpi':'Fictional bounded KPI','items':[], '\U00010000':1,'\ue000':2}
        self.answer['evidence']=json.dumps(a,indent=2,ensure_ascii=False)
        self.answer['evidence_digest']=m.sha(self.answer['evidence'].encode())
        self.artifact=a
    def test_v1_still_refuses_and_v2_derives_both_distinct_digests(self):
        with self.assertRaisesRegex(m.Refused,'evidence_not_canonical_artifact'):
            m._evidence_artifact(self.policy,self.task,self.answer)
        facts=m.evidence_artifact_v2(self.policy,self.task,self.answer)
        self.assertEqual(facts['artifact'],self.artifact)
        self.assertEqual(facts['nativeEvidenceDigest'],self.answer['evidence_digest'])
        self.assertEqual(facts['canonicalArtifactDigest'],m.js_digest(self.artifact))
        self.assertNotEqual(facts['nativeEvidenceDigest'],facts['canonicalArtifactDigest'])
    def test_v2_sign_requires_explicit_admission_and_rederives_claim(self):
        payload=m.expected_payload_v2(self.policy,self.task,self.answer,'pass',None,network=m.V2_NETWORK)
        sign=Mock(side_effect=v1.fake_signer);rerun=Mock(side_effect=v1.passing)
        options=dict(network=m.V2_NETWORK,trusted_uids=v1.ME,driver_directory=self.drivers,boundary=self.root,now=lambda:v1.VECTOR['attestedAtEpoch'])
        with self.assertRaisesRegex(m.Refused,'attestation_version_not_allowed'):
            m.attest_v2(self.policy_path,payload,m.js_digest(payload),self.task,self.answer,rerun,sign,'fixture',**options)
        sign.assert_not_called();rerun.assert_not_called()
        for field in ('nativeEvidenceDigest','canonicalArtifactDigest'):
            bad=copy.deepcopy(payload);bad[field]='f'*64
            with self.assertRaises(m.Refused):
                m.attest_v2(self.policy_path,bad,m.js_digest(bad),self.task,self.answer,rerun,sign,'fixture',allowed_versions=(1,2),**options)
            sign.assert_not_called()
        envelope=m.attest_v2(self.policy_path,payload,m.js_digest(payload),self.task,self.answer,rerun,sign,'fixture',allowed_versions=(1,2),**options)
        s=envelope['statement'];self.assertEqual(s['schema'],'uain-fleet-verification-attestation-v2');self.assertEqual(s['evidenceDigest'],self.answer['evidence_digest']);self.assertEqual(s['canonicalArtifactDigest'],m.js_digest(self.artifact));self.assertFalse(s['mainKpiSatisfied'])
        self.assertTrue(sign.call_args.args[0].startswith(b'UAIN/fleet-verification-attestation/v2\n'))
    def test_v2_consumption_needs_admission_and_rederives_raw_and_canonical(self):
        payload=m.expected_payload_v2(self.policy,self.task,self.answer,'pass',None,network=m.V2_NETWORK)
        options=dict(network=m.V2_NETWORK,trusted_uids=v1.ME,driver_directory=self.drivers,boundary=self.root,now=lambda:v1.VECTOR['attestedAtEpoch'])
        envelope=m.attest_v2(self.policy_path,payload,m.js_digest(payload),self.task,self.answer,v1.passing,v1.fake_signer,'fixture',allowed_versions=(2,),**options)
        with patch.object(m,'ed25519_verify'):
            with self.assertRaisesRegex(m.Refused,'attestation_version_not_allowed'):
                m.check_review_bindings(envelope,b'\x01'*32,'fixture',self.policy,self.task,self.answer)
            actual=m.check_review_bindings(envelope,b'\x01'*32,'fixture',self.policy,self.task,self.answer,allowed_versions=(1,2),network=m.V2_NETWORK)
            self.assertEqual(actual['canonicalArtifactDigest'],m.js_digest(self.artifact))
            for field in ('evidenceDigest','canonicalArtifactDigest'):
                bad=copy.deepcopy(envelope);bad['statement'][field]='f'*64;bad['statementDigest']=m.sha(m.statement_bytes_v2(bad['statement']))
                with self.assertRaises(m.Refused):m.check_review_bindings(bad,b'\x01'*32,'fixture',self.policy,self.task,self.answer,allowed_versions=(2,),network=m.V2_NETWORK)
            altered=copy.deepcopy(self.answer);altered['evidence']+=' ';altered['evidence_digest']=m.sha(altered['evidence'].encode())
            with self.assertRaisesRegex(m.Refused,'attestation_evidence_mismatch'):
                m.check_review_bindings(envelope,b'\x01'*32,'fixture',self.policy,self.task,altered,allowed_versions=(2,),network=m.V2_NETWORK)
        for versions in ([],[True],[2,2],[3],['2']):
            with self.assertRaises(m.Refused):m.validate_versions(versions)

    def test_wrong_independent_network_context_refuses_before_driver_or_signer(self):
        payload=m.expected_payload_v2(self.policy,self.task,self.answer,'pass',None,network=m.V2_NETWORK)
        for network in (None,dict(chainId='other-chain',genesisSha256='f'*64),dict(chainId='uain-shadow-20261008-1',genesisSha256='f'*64)):
            with self.subTest(network=network),patch.object(m,'driver_source') as driver:
                sign=Mock();rerun=Mock()
                with self.assertRaisesRegex(m.Refused,'attestation_network_mismatch'):
                    m.attest_v2(self.policy_path,payload,m.js_digest(payload),self.task,self.answer,rerun,sign,'fixture',allowed_versions=(2,),network=network)
                driver.assert_not_called();rerun.assert_not_called();sign.assert_not_called()

    def test_cross_network_unsigned_claim_never_loads_or_runs_driver(self):
        payload=m.expected_payload_v2(self.policy,self.task,self.answer,'pass',None,network=m.V2_NETWORK)
        for field in ('chainId','genesisSha256'):
            wrong={**payload,field:'other-chain' if field=='chainId' else 'f'*64}
            with patch.object(m,'driver_source') as driver:
                sign=Mock();rerun=Mock()
                with self.assertRaisesRegex(m.Refused,'attestation_network_mismatch'):
                    m.attest_v2(self.policy_path,wrong,m.js_digest(wrong),self.task,self.answer,rerun,sign,'fixture',allowed_versions=(2,),network=m.V2_NETWORK,trusted_uids=v1.ME,driver_directory=self.drivers,boundary=self.root)
                driver.assert_not_called();rerun.assert_not_called();sign.assert_not_called()

    def test_real_fixture_signature_domain_and_native_consumer_tampering(self):
        # Required crypto test: no skip/mock; only this public, fictional test seed.
        import native_migration as native
        public, sign = native.ed25519(bytes(range(32)))
        signer=lambda message:dict(public_key=public,signature=sign(message))
        payload=m.expected_payload_v2(self.policy,self.task,self.answer,'pass',None,network=m.V2_NETWORK)
        options=dict(network=m.V2_NETWORK,trusted_uids=v1.ME,driver_directory=self.drivers,boundary=self.root,now=lambda:v1.VECTOR['attestedAtEpoch'])
        envelope=m.attest_v2(self.policy_path,payload,m.js_digest(payload),self.task,self.answer,v1.passing,signer,'fixture',allowed_versions=(2,),**options)
        actual=m.check_review_bindings(envelope,public,'fixture',self.policy,self.task,self.answer,allowed_versions=(2,),network=m.V2_NETWORK)
        self.assertEqual(actual['canonicalArtifactDigest'],m.js_digest(self.artifact))
        with self.assertRaises(m.Refused):m.verify(envelope,public)
        bad=copy.deepcopy(envelope);bad['statement']['canonicalArtifactDigest']='f'*64;bad['statementDigest']=m.sha(m.statement_bytes_v2(bad['statement']))
        with self.assertRaisesRegex(m.Refused,'attestation_signature_invalid'):m.verify_v2(bad,public)
        old_domain=m.DOMAIN+'\n'+m.js_canonical(envelope['statement'])
        bad=copy.deepcopy(envelope);bad['signature']=m.base64.b64encode(sign(old_domain.encode())).decode()
        with self.assertRaisesRegex(m.Refused,'attestation_signature_invalid'):m.verify_v2(bad,public)

    def test_strict_raw_parser_refuses_ambiguity_and_wrong_binding(self):
        for raw in ('{"x":1,"\\u0078":2}','{"x":1.0}','{"x":9007199254740992}','{"\\ud800":0}','{"x":'+('['*80)+'0'+(']'*80)+'}'):
            a=copy.deepcopy(self.answer);a['evidence']=raw;a['evidence_digest']=m.sha(raw.encode())
            with self.assertRaises(m.Refused):m.evidence_artifact_v2(self.policy,self.task,a)
        a=copy.deepcopy(self.answer);a['evidence_digest']='f'*64
        with self.assertRaisesRegex(m.Refused,'evidence_digest_mismatch'):m.evidence_artifact_v2(self.policy,self.task,a)


class RootPreSignTests(unittest.TestCase):
    def fixture(self, verdict='pass', statement_network=None):
        import base64,datetime
        import native_migration as native
        import central_reviewer_server as server
        import test_central_reviewer_server as base
        engine,decision,state,journal,calls=base.ServerTests().fixture()
        engine.p['genesis_sha256']=m.V2_NETWORK['genesisSha256']
        task=state['records']['central_task/CT-1'];answer=state['records']['central_submission/CS-1']
        artifact=dict(schema=m.ARTIFACT_SCHEMA,author=answer['author'],taskId=task['id'],submissionId=answer['id'],survey={'mainKpi':'Fictional test Main KPI'})
        answer['evidence']=json.dumps(artifact,indent=2);answer['evidence_digest']=m.sha(answer['evidence'].encode());decision['evidence_digest']=answer['evidence_digest']
        policy=dict(schema=m.POLICY_SCHEMA,**{'class':'prior_art_survey'},taskId=task['id'],projectId=task['project'],criteriaDigest=task['acceptance_digest'],inputs=[],primarySourceHosts=[],driver=dict(name='prior-art-survey',sha256='4'*64),successTests=[{'id':'fixture'}])
        payload=m.expected_payload_v2(policy,task,answer,verdict,None,network=m.V2_NETWORK)
        statement=dict(schema=m.SCHEMA_V2,domain=m.DOMAIN_V2,environment='production',submission=answer['id'],author=answer['author'],task=task['id'],project=task['project'],evidenceClass=policy['class'],criteriaDigest=task['acceptance_digest'],evidenceDigest=answer['evidence_digest'],canonicalArtifactDigest=m.js_digest(artifact),policyDigest=m.js_digest(policy),driver=policy['driver'],verdict=verdict,reproductionAttestationDigest=None,verificationDigest=m.js_digest(payload),mainKpiSatisfied=False,attestedAt=datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),**m.V2_NETWORK)
        statement.update(statement_network or {})
        public,sign=native.ed25519(bytes(range(32)));message=m.statement_bytes_v2(statement)
        envelope=dict(statement=statement,statementDigest=m.sha(message),publicKey=base64.b64encode(public).decode(),signature=base64.b64encode(sign(message)).decode())
        path='/FICTIONAL/survey-policy.json'
        engine.p['fleet_attestations']={task['id']:dict(policy_path=path,policy_digest=m.js_digest(policy),criteria_digest=task['acceptance_digest'],attestation_public_key=envelope['publicKey'],environment='production',allowedVersions=[1,2])}
        data={path:json.dumps(policy).encode(),str(server.FLEET_ROOT/(m.sha(answer['id'].encode())+'.json')):m.js_canonical(envelope).encode()}
        engine.attestation_read=lambda path,limit=0:data[str(path)]
        decision.update(schema='uain-central-research-decision-v2',verification_attestation_digest=envelope['statementDigest'])
        return engine,decision,state,journal,calls,data
    def test_real_signature_root_pre_sign_and_once_context_bind_both_digests(self):
        engine,decision,state,journal,calls,data=self.fixture()
        self.assertTrue(engine.readiness({'submission':decision['submission']})['ready'])
        body=dict(executionId=decision['execution_id'],decision=decision)
        engine.review(body);retained=copy.deepcopy(journal);engine.review(body)
        self.assertEqual(calls,dict(sign=1,send=1));self.assertEqual(journal,retained)
        context=next(iter(journal.values()))['context']['fleet_verification']
        self.assertEqual(context['attestation_version'],2);self.assertEqual(context['native_evidence_digest'],decision['evidence_digest']);self.assertNotEqual(context['native_evidence_digest'],context['canonical_artifact_digest'])
        command=next(iter(journal.values()))['envelope']['command']
        import central_reviewer as r
        self.assertEqual(command['payload']['verification_digest'],r.decision_digest(decision))
        self.assertEqual(command['payload']['evidence_digest'],decision['evidence_digest'])
    def test_missing_profile_admission_native_tamper_or_decision_tamper_never_sign(self):
        for change in ('missing-admission','raw','decision','contradiction','wrong-chain','wrong-genesis','native-network'):
            with self.subTest(change=change):
                wrong = dict(chainId='other-chain') if change=='wrong-chain' else dict(genesisSha256='f'*64) if change=='wrong-genesis' else None
                engine,decision,state,journal,calls,data=self.fixture('fail' if change=='contradiction' else 'pass',statement_network=wrong)
                if change=='native-network':state['chain_id']='other-chain'
                if change=='missing-admission':del engine.p['fleet_attestations']['CT-1']['allowedVersions']
                if change=='raw':
                    a=state['records']['central_submission/CS-1'];a['evidence']+=' ';a['evidence_digest']=m.sha(a['evidence'].encode());decision['evidence_digest']=a['evidence_digest']
                if change=='decision':decision['verification_attestation_digest']='f'*64
                try:result=engine.review(dict(executionId=decision['execution_id'],decision=decision))
                except ValueError:result={'status':'blocked'}
                self.assertEqual(result['status'],'blocked');self.assertEqual(calls,dict(sign=0,send=0));self.assertEqual(journal,{})

if __name__=='__main__':unittest.main()

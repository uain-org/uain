"""Central reviewer trusted_verification (fleet attestation) path. FICTIONAL keys, policy and records only.

No root, vault, native node or network: the engine uses the in-memory fixture of
test_central_reviewer_server and an injected protected-artifact reader.
"""
import base64,copy,datetime,json,unittest
from pathlib import Path
import central_reviewer as r
import central_reviewer_server as s
import fleet_attestation as fa
import test_central_reviewer_server as server_tests

def backend():
 try:r.native.ed25519(bytes(32));return True
 except ImportError:return False

POLICY_PATH='/FICTIONAL/fleet-policies/CT-1.json'
SEED=bytes(range(1,33));OTHER_SEED=bytes(range(2,34))

def keypair(seed):
 public,sign=r.native.ed25519(seed);return base64.b64encode(public).decode(),sign

@unittest.skipUnless(backend(),'Ed25519 backend (pycryptodomex or cryptography) unavailable')
class FleetVerificationTests(unittest.TestCase):
 def fixture(self,verdict='pass',environment='production',seed=SEED,statement_change=None,decision_verdict=None):
  e,d,state,j,calls=server_tests.ServerTests().fixture()
  task=state['records']['central_task/'+d['task']];answer=state['records']['central_submission/'+d['submission']]
  policy=dict(schema=fa.POLICY_SCHEMA,**{'class':'finite_math_witness'},taskId=task['id'],projectId=task['project'],criteriaDigest=task['acceptance_digest'],inputs=[],primarySourceHosts=[],driver=dict(name='finite-math-witness',sha256='4'*64),successTests=[dict(id='factor',witnessType='integer_factorization',instance=dict(n='15'))])
  stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
  statement=dict(schema=fa.SCHEMA,domain=fa.DOMAIN,environment=environment,submission=answer['id'],author=answer['author'],task=task['id'],project=task['project'],evidenceClass=policy['class'],criteriaDigest=task['acceptance_digest'],evidenceDigest=answer['evidence_digest'],policyDigest=fa.js_digest(policy),driver=dict(policy['driver']),verdict=verdict,reproductionAttestationDigest=None,verificationDigest=fa.js_digest(fa.expected_payload(policy,answer,verdict,None)),mainKpiSatisfied=False,attestedAt=stamp)
  statement.update(statement_change or {})
  public,sign=keypair(seed);message=fa.statement_bytes(statement)
  envelope=dict(statement=statement,statementDigest=fa.sha(message),publicKey=public,signature=base64.b64encode(sign(message)).decode())
  trusted,_=keypair(SEED)
  e.p['fleet_attestations']={task['id']:dict(policy_path=POLICY_PATH,policy_digest=fa.js_digest(policy),criteria_digest=task['acceptance_digest'],attestation_public_key=trusted,environment='production')}
  data={POLICY_PATH:json.dumps(policy).encode(),str(s.FLEET_ROOT/(r.sha(answer['id'].encode())+'.json')):fa.js_canonical(envelope).encode()}
  e.attestation_read=lambda path,limit=0:data[str(path)]
  d['schema']='uain-central-research-decision-v2';d['verification_attestation_digest']=envelope['statementDigest']
  d['verdict']=decision_verdict or fa.VERDICTS[verdict]
  return e,d,state,j,calls,data,policy,envelope
 def body(self,d):return {'executionId':d['execution_id'],'decision':d}
 def envelope_path(self,d):return str(s.FLEET_ROOT/(r.sha(d['submission'].encode())+'.json'))

 def test_readiness_returns_the_checked_statement_and_its_digest(self):
  e,d,state,j,calls,data,policy,envelope=self.fixture();ready=e.readiness({'submission':d['submission']})
  self.assertEqual((ready['ready'],ready['required']),(True,True));self.assertEqual(ready['attestationDigest'],envelope['statementDigest'])
  self.assertEqual(ready['trusted_verification'],envelope['statement']);self.assertNotIn('trusted_reproduction',ready);self.assertNotIn('signature',ready['trusted_verification'])
  self.assertEqual(calls,{'sign':0,'send':0})

 def test_accepted_flow_signs_once_and_records_the_statement_in_the_once_only_context(self):
  for verdict in ['pass','fail']:
   e,d,state,j,calls,data,policy,envelope=self.fixture(verdict);e.review(self.body(d));e.review(self.body(d))
   self.assertEqual(calls,{'sign':1,'send':1});job=next(iter(j.values()));context=job['context']['fleet_verification']
   self.assertEqual(context['statement_digest'],envelope['statementDigest']);self.assertEqual(context['verdict'],verdict);self.assertEqual(context['policy_digest'],fa.js_digest(policy));self.assertEqual(context['environment'],'production')
   self.assertNotIn('independent_reproduction',job['context'])
   # The native payload shape is unchanged; its verification_digest commits to the v2 decision.
   payload=job['envelope']['command']['payload'];self.assertEqual(set(payload),{'submission','verdict','criteria_digest','verification_digest','execution_id','evidence_digest'})
   self.assertEqual(payload['verification_digest'],r.decision_digest(d));self.assertEqual(payload['verdict'],fa.VERDICTS[verdict])

 def test_provider_needs_evidence_is_allowed_but_a_fail_is_never_accepted(self):
  for verdict in ['pass','fail']:
   e,d,state,j,calls,*_=self.fixture(verdict,decision_verdict='needs_evidence');e.review(self.body(d));self.assertEqual(calls,{'sign':1,'send':1})
  e,d,state,j,calls,*_=self.fixture('fail',decision_verdict='accept')
  with self.assertRaises(ValueError):e.review(self.body(d))
  self.assertEqual(calls,{'sign':0,'send':0});self.assertEqual(j,{})

 def test_a_checker_pass_is_necessary_not_sufficient_so_the_reviewer_may_reject_it(self):
  # SV-1: the fixed checker passing never binds the reviewer to accept.
  e,d,state,j,calls,data,policy,envelope=self.fixture('pass',decision_verdict='reject');e.review(self.body(d));e.review(self.body(d))
  self.assertEqual(calls,{'sign':1,'send':1});job=next(iter(j.values()))
  self.assertEqual(job['decision']['verdict'],'reject');self.assertEqual(job['context']['fleet_verification']['verdict'],'pass')
  self.assertEqual(job['context']['fleet_verification']['statement_digest'],envelope['statementDigest'])
  self.assertEqual(job['envelope']['command']['payload']['verdict'],'reject')

 def test_decision_must_commit_to_the_stored_statement_digest(self):
  e,d,state,j,calls,*_=self.fixture();d['verification_attestation_digest']='f'*64
  with self.assertRaises(ValueError):e.review(self.body(d))
  self.assertEqual(calls,{'sign':0,'send':0})

 def assert_refused(self,e,d,calls,j):
  self.assertFalse(e.readiness({'submission':d['submission']})['ready'])
  result=e.review(self.body(d));self.assertEqual((result['status'],result['stage'],result['reason']),('blocked','pre_sign','fleet_verification_required'))
  self.assertEqual(calls,{'sign':0,'send':0});self.assertEqual(j,{})

 def test_wrong_key_environment_and_digest_are_refused_before_sign(self):
  cases=[dict(seed=OTHER_SEED),dict(environment='fixture')]
  for change in cases:
   with self.subTest(change=change):
    e,d,state,j,calls,*_=self.fixture(**change);self.assert_refused(e,d,calls,j)
  # Tampered statement digest, signature, or a statement edited after signing.
  for field in ['statementDigest','signature','statement']:
   with self.subTest(field=field):
    e,d,state,j,calls,data,policy,envelope=self.fixture();bad=copy.deepcopy(envelope)
    if field=='statementDigest':bad['statementDigest']='f'*64
    elif field=='signature':bad['signature']=base64.b64encode(bytes(64)).decode()
    else:bad['statement']['verdict']='fail'
    data[self.envelope_path(d)]=fa.js_canonical(bad).encode();self.assert_refused(e,d,calls,j)

 def test_binding_mismatches_signed_by_the_trusted_key_are_refused(self):
  for change in [dict(author='uain1'+'c'*40),dict(evidenceDigest='f'*64),dict(criteriaDigest='f'*64),dict(submission='CS-2'),dict(project='P-2'),dict(policyDigest='f'*64),dict(verificationDigest='f'*64),dict(driver=dict(name='finite-math-witness',sha256='5'*64)),dict(attestedAt='2099-01-01T00:00:00Z'),dict(mainKpiSatisfied=True)]:
   with self.subTest(change=change):
    e,d,state,j,calls,*_=self.fixture(statement_change=change);self.assert_refused(e,d,calls,j)

 def test_changed_or_missing_root_policy_and_missing_envelope_block_then_install_signs_once(self):
  e,d,state,j,calls,data,policy,envelope=self.fixture();changed=copy.deepcopy(policy);changed['successTests'][0]['instance']['n']='21';data[POLICY_PATH]=json.dumps(changed).encode();self.assert_refused(e,d,calls,j)
  e,d,state,j,calls,data,policy,envelope=self.fixture();raw=data.pop(self.envelope_path(d));self.assertEqual(e.review(self.body(d))['stage'],'pre_sign')
  data[self.envelope_path(d)]=raw;e.review(self.body(d));e.review(self.body(d));self.assertEqual(calls,{'sign':1,'send':1})
  e,d,state,j,calls,data,*_=self.fixture();e.p['fleet_attestations'][d['task']]['policy_digest']='f'*64;self.assert_refused(e,d,calls,j)

 def test_v1_and_v2_decisions_are_bound_to_the_task_basis(self):
  # A fleet task never signs a v1 accept/reject; a v1 needs_evidence pays nothing and still signs.
  for verdict,signs in [('accept',0),('reject',0),('needs_evidence',1)]:
   e,d,state,j,calls,*_=self.fixture();d['schema']='uain-central-research-decision-v1';del d['verification_attestation_digest'];d['verdict']=verdict
   result=e.review(self.body(d));self.assertEqual(calls['sign'],signs)
   if not signs:self.assertEqual(result['reason'],'fleet_verification_required')
  # A v2 decision for a task without a fleet rule is refused outright.
  e,d,state,j,calls,*_=self.fixture();e.p['fleet_attestations']={}
  with self.assertRaises(ValueError):e.review(self.body(d))
  self.assertEqual(calls,{'sign':0,'send':0})

 def test_source_code_reproduction_policy_stays_on_its_own_path(self):
  e,d,state,j,calls,data,policy,envelope=self.fixture();policy=dict(policy,**{'class':'source_code_reproduction'},driver=dict(name='protected-reproduction-attestation',sha256='4'*64));data[POLICY_PATH]=json.dumps(policy).encode();e.p['fleet_attestations'][d['task']]['policy_digest']=fa.js_digest(policy)
  self.assert_refused(e,d,calls,j)

class FleetProfileTests(unittest.TestCase):
 def profile(self):
  public=r.b64(bytes([1])*32);member='uain1'+r.sha(bytes([1])*32)[:40];identity=dict(schema='uain-central-reviewer-identity-v1',chain_id=r.CHAIN,genesis_sha256=r.GENESIS,member=member,public_key=public)
  rule=dict(policy_path=POLICY_PATH,policy_digest='a'*64,criteria_digest='b'*64,attestation_public_key=base64.b64encode(bytes([3])*32).decode(),environment='production')
  return dict(schema='uain-central-reviewer-server-v1',chain_id=r.CHAIN,genesis_sha256=r.GENESIS,reviewer=member,public_key=public,peer_uid=1000,socket_gid=1000,socket_path=str(s.SOCKET),fleet_attestations={'CT-1':rule}),identity
 def test_valid_fleet_rules_are_accepted(self):
  p,identity=self.profile();self.assertEqual(s.validate_profile(p,identity),p)
 def test_fixture_environment_bad_key_paths_extra_fields_and_overlap_are_refused(self):
  for field,value in [('environment','fixture'),('attestation_public_key',r.b64(bytes([3])*32)),('attestation_public_key','AAAA'),('policy_path','relative/policy.json'),('policy_path','/FICTIONAL/../etc/policy.json'),('policy_digest','short'),('extra','x')]:
   with self.subTest(field=field,value=value):
    p,identity=self.profile();p['fleet_attestations']['CT-1'][field]=value
    with self.assertRaises(ValueError):s.validate_profile(p,identity)
  # Overlap: one task may not carry both acceptance bases (a FICTIONAL custody root keeps path resolution host-independent).
  from unittest.mock import patch
  with patch.object(r,'ROOT',Path('/FICTIONAL/custody')):
   p,identity=self.profile();p['acceptance_attestations']={'CT-1':dict(criteria_digest='b'*64,live_source_path='/FICTIONAL/frozen.mjs',live_source_sha256='c'*64,evidence_root='/FICTIONAL/custody/independent-reproductions/CT-1',not_before='2026-11-05T00:00:00Z',native_binary_sha256='d'*64)}
   with self.assertRaises(ValueError):s.validate_profile(p,identity)
   both=copy.deepcopy(p);both['acceptance_attestations']['CT-2']=both['acceptance_attestations'].pop('CT-1');self.assertEqual(s.validate_profile(both,identity),both)
   del p['fleet_attestations'];self.assertEqual(s.validate_profile(p,identity),p)
 def test_fleet_module_is_in_the_pinned_source_closure(self):
  self.assertIn('fleet_attestation',s.SOURCE_NAMES);self.assertEqual(s.SOURCE_NAMES[-1],'central_reviewer_server')
  self.assertLess(s.SOURCE_NAMES.index('fleet_attestation'),s.SOURCE_NAMES.index('central_reviewer_server'))

@unittest.skipUnless(backend(),'Ed25519 backend (pycryptodomex or cryptography) unavailable')
class SurveyPartClassRuleTests(unittest.TestCase):
 """One root rule for every survey part (9 November 2026). FICTIONAL task id via a patched pattern."""
 PART_DIR='/FICTIONAL/task-policies'
 def fixture(self,policy_change=None,rule_change=None):
  from unittest.mock import patch
  e,d,state,j,calls,data,policy,envelope=FleetVerificationTests().fixture()
  task=state['records']['central_task/'+d['task']]
  survey=dict(schema=fa.POLICY_SCHEMA,**{'class':'prior_art_survey'},taskId=task['id'],projectId=task['project'],criteriaDigest=task['acceptance_digest'],inputs=[],primarySourceHosts=['api.crossref.org'],driver=dict(name='prior-art-survey',sha256='8'*64),successTests=[dict(id='survey',mainKpi='1 thing',minIncluded=1,minKinds=1,requiredIds=[dict(kind='doi',id='10.1/x')])])
  survey.update(policy_change or {})
  answer=state['records']['central_submission/'+d['submission']]
  statement=dict(envelope['statement'],evidenceClass='prior_art_survey',policyDigest=fa.js_digest(survey),driver=dict(survey['driver']),verificationDigest=fa.js_digest(fa.expected_payload(survey,answer,'pass',None)))
  public,sign=keypair(SEED);message=fa.statement_bytes(statement)
  env=dict(statement=statement,statementDigest=fa.sha(message),publicKey=public,signature=base64.b64encode(sign(message)).decode())
  data.clear();data[self.PART_DIR+'/'+task['id']+'.json']=json.dumps(survey).encode();data[self.envelope_path(d)]=fa.js_canonical(env).encode()
  e.p['fleet_attestations']={}
  e.p['fleet_attestation_parts']=dict(policy_dir=self.PART_DIR,driver_sha256='8'*64,attestation_public_key=public,environment='production',**(rule_change or {}))
  d['verification_attestation_digest']=env['statementDigest'];d['verdict']='accept'
  self.patch=patch.object(s,'PART_TASK',__import__('re').compile('^'+task['id']+'$'));self.patch.start();self.addCleanup(self.patch.stop)
  return e,d,j,calls,env,survey
 def envelope_path(self,d):return str(s.FLEET_ROOT/(r.sha(d['submission'].encode())+'.json'))
 def body(self,d):return {'executionId':d['execution_id'],'decision':d}
 def test_a_part_with_its_own_root_policy_is_ready_and_signs_once_under_the_class_rule(self):
  e,d,j,calls,env,survey=self.fixture()
  ready=e.readiness({'submission':d['submission']});self.assertEqual((ready['ready'],ready['required']),(True,True))
  e.review(self.body(d));e.review(self.body(d));self.assertEqual(calls,{'sign':1,'send':1})
  context=next(iter(j.values()))['context']['fleet_verification']
  self.assertEqual(context['policy_digest'],fa.js_digest(survey));self.assertEqual(context['policy_path'],self.PART_DIR+'/'+d['task']+'.json');self.assertEqual(context['criteria_digest'],survey['criteriaDigest'])
 def test_a_policy_for_another_task_criteria_class_project_or_driver_is_refused(self):
  for change in [dict(taskId='T-other'),dict(criteriaDigest='f'*64),dict(projectId='P-other'),dict(driver=dict(name='prior-art-survey',sha256='9'*64))]:
   with self.subTest(change=change):
    e,d,j,calls,env,survey=self.fixture(policy_change=change)
    self.assertFalse(e.readiness({'submission':d['submission']})['ready'])
    self.assertEqual(e.review(self.body(d))['reason'],'fleet_verification_required');self.assertEqual(calls,{'sign':0,'send':0})
 def test_ids_outside_the_part_pattern_and_source_reproduction_tasks_get_no_class_rule(self):
  e,d,j,calls,env,survey=self.fixture()
  self.assertIsNone(s.fleet_rule(e.p,'T-OPP-00005-1-prior-art-survey'))
  self.assertIsNone(s.fleet_rule(dict(e.p,acceptance_attestations={d['task']:{}}),d['task']))
  self.assertIsNotNone(s.fleet_rule(e.p,d['task']))
  self.assertIsNone(s.fleet_rule({k:v for k,v in e.p.items() if k!='fleet_attestation_parts'},d['task']))

class SurveyPartRuleProfileTests(unittest.TestCase):
 def test_the_class_rule_validates_strictly(self):
  p,identity=FleetProfileTests().profile();key=base64.b64encode(bytes([3])*32).decode()
  good=dict(policy_dir='/FICTIONAL/task-policies',driver_sha256='8'*64,attestation_public_key=key,environment='production')
  p['fleet_attestation_parts']=good;self.assertEqual(s.validate_profile(p,identity),p)
  for change in [dict(environment='fixture'),dict(driver_sha256='short'),dict(policy_dir='relative'),dict(policy_dir='/etc/../x'),dict(attestation_public_key='AAAA'),dict(allowedVersions=[1,2]),dict(extra='x')]:
   with self.subTest(change=change):
    bad=copy.deepcopy(p);bad['fleet_attestation_parts'].update(change)
    with self.assertRaises(ValueError):s.validate_profile(bad,identity)
  self.assertTrue(s.PART_TASK.fullmatch('T-OPP-00242-1-prior-art-survey-r2-p1'));self.assertTrue(s.PART_TASK.fullmatch('T-OPP-00242-1-prior-art-survey-r3-p12'))
  for bad in ['T-OPP-00242-1-prior-art-survey','T-OPP-00242-1-prior-art-survey-r1-p1','T-OPP-00242-1-prior-art-survey-r2-p0','CT-1']:
   self.assertIsNone(s.PART_TASK.fullmatch(bad))

class DecisionSchemaTests(unittest.TestCase):
 def test_v2_decision_digest_commits_to_the_statement_and_v1_is_unchanged(self):
  p,state,d=__import__('test_central_reviewer').CentralReviewerTests().fixture();v1=r.review_command(p,state,d)
  v2=dict(d,schema='uain-central-research-decision-v2',verification_attestation_digest='a'*64);c2=r.review_command(p,state,v2)
  self.assertEqual(set(c2['payload']),set(v1['payload']));self.assertNotEqual(c2['payload']['verification_digest'],v1['payload']['verification_digest'])
  self.assertNotEqual(r.decision_digest(v2),r.decision_digest(dict(v2,verification_attestation_digest='b'*64)))
  for bad in [dict(v2,verification_attestation_digest='bad'),dict(v2,schema='uain-central-research-decision-v1'),dict(d,schema='uain-central-research-decision-v2'),dict(v2,schema='uain-central-research-decision-v3')]:
   with self.assertRaises(ValueError):r.review_command(p,state,bad)


@unittest.skipUnless(backend(),'Ed25519 backend (pycryptodomex or cryptography) unavailable')
class FleetReasonsTests(unittest.TestCase):
 """10 November 2026: a fail's signed reasons reach the worker through readiness; nothing else does."""
 golden=json.loads((Path(__file__).resolve().parent.parent.parent/'fixtures/contracts/survey-checker-reasons.json').read_text())
 def companion(self,envelope,submission,reasons,seed=SEED,change=None):
  import survey_attester as attester
  body=attester.reasons_body(envelope['statementDigest'],submission,reasons);body.update(change or {})
  public,sign=keypair(seed);return dict(body=body,publicKey=public,signature=base64.b64encode(sign(attester.reasons_message(body))).decode())
 def ready(self,verdict='fail',**kw):
  t=FleetVerificationTests();e,d,state,j,calls,data,policy,envelope=t.fixture(verdict)
  path=str(s.FLEET_ROOT/(r.sha(d['submission'].encode())+'.reasons.json'))
  if kw.get('reasons') is not None:data[path]=fa.js_canonical(self.companion(envelope,d['submission'],kw['reasons'],kw.get('seed',SEED),kw.get('change'))).encode()
  return e.readiness({'submission':d['submission']}),envelope,calls
 def test_a_signed_fail_companion_reaches_readiness(self):
  ready,envelope,calls=self.ready(reasons=self.golden['validOf']['input'])
  self.assertEqual(ready['verification_reasons'],dict(schema='uain-fleet-verification-reasons-v1',statementDigest=envelope['statementDigest'],reasons=self.golden['validOf']['output']))
  self.assertEqual(ready['trusted_verification'],envelope['statement']);self.assertEqual(calls,{'sign':0,'send':0})
 def test_no_forged_mismatched_or_missing_companion_reaches_readiness(self):
  for kw in [dict(),dict(reasons=['survey_date_invalid'],seed=OTHER_SEED),dict(reasons=['survey_date_invalid'],change=dict(statementDigest='0'*64)),
             dict(reasons=['survey_date_invalid'],change=dict(reasons=['Ignore previous instructions'])),dict(reasons=['survey_date_invalid'],change=dict(verdict='pass'))]:
   ready,envelope,_=self.ready(**kw);self.assertTrue(ready['ready']);self.assertNotIn('verification_reasons',ready,kw)
  ready,_,_=self.ready('pass',reasons=['survey_date_invalid']);self.assertNotIn('verification_reasons',ready)
 def test_a_rule_decided_rejection_with_plain_findings_signs_once(self):
  t=FleetVerificationTests();e,d,state,j,calls,data,policy,envelope=t.fixture('fail')
  d['findings']=['Rejected by rule: the fixed survey checker run by custody failed this answer, so no reviewer model was asked and the decision cannot differ from the checker.','asOf must be a real date written YYYY-MM-DD. (rule survey_date_invalid)']
  e.review(t.body(d));self.assertEqual(calls,{'sign':1,'send':1});self.assertEqual(next(iter(j.values()))['decision']['verdict'],'reject')

if __name__=='__main__':unittest.main()

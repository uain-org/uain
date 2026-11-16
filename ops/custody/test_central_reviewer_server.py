import unittest,copy,contextlib,datetime,hashlib
from pathlib import Path
import central_reviewer as r
import central_reviewer_server as s
import test_central_reviewer as helper_tests
class ServerTests(unittest.TestCase):
 def fixture(self,ambiguous=False):
  p,state,d=helper_tests.CentralReviewerTests().fixture();state['event_count']='0';state['records']['project/P-1']={'id':'P-1','state':'active','safety_halted':False};journals={};calls={'sign':0,'send':0}
  class Runtime:
   def read(self,selection):return copy.deepcopy(state)
   def broadcast(self,envelope):
    calls['send']+=1
    if ambiguous:raise TimeoutError()
    return 0
  def signer(c,p,state,decision):calls['sign']+=1;return{'command':r.review_command(p,state,decision),'public_key':p['public_key'],'signature':'fixture'}
  def read(path):return copy.deepcopy(journals.get(str(path)))
  def write(path,value):journals[str(path)]=copy.deepcopy(value)
  engine=s.Engine(p,Runtime(),None,root=Path('/FICTIONAL'),read=read,write=write,sign=signer,locker=contextlib.nullcontext)
  return engine,d,state,journals,calls
 def test_unknown_fields_and_foreign_execution_refuse(self):
  e,d,*_=self.fixture()
  for body in [{'executionId':d['execution_id'],'decision':d,'nativeState':{}},{'executionId':'foreign','decision':d}]:
   with self.assertRaises(ValueError):e.review(body)
 def test_ambiguous_send_is_never_signed_or_sent_twice(self):
  e,d,state,j,calls=self.fixture(True);body={'executionId':d['execution_id'],'decision':d};self.assertEqual(e.review(body)['status'],'unknown');self.assertEqual(e.review(body)['status'],'unknown');self.assertEqual(calls,{'sign':1,'send':1})
 def test_readonly_receipt_never_signs_or_broadcasts(self):
  e,d,state,j,calls=self.fixture(True);e.review({'executionId':d['execution_id'],'decision':d});job=next(iter(j.values()));request={k:job[k] for k in ['executionId','commandDigest','decisionDigest']};e.receipt(request);self.assertEqual(calls,{'sign':1,'send':1});request['decisionDigest']='f'*64
  with self.assertRaises(ValueError):e.receipt(request)
 def test_wrong_criteria_reviewer_owner_evidence_refuse_before_sign(self):
  for field in ['criteria_digest','evidence_digest','reviewer']:
   e,d,state,j,calls=self.fixture();d[field]='f'*64
   with self.assertRaises(ValueError):e.review({'executionId':d['execution_id'],'decision':d})
   self.assertEqual(calls['sign'],0)

 def finalize(self,e,d,state,j,verdict='accept'):
  d['verdict']=verdict;e.review({'executionId':d['execution_id'],'decision':d});job=next(iter(j.values()));command=job['envelope']['command'];event={'id':'1','height':'101','member':command['member'],'operation':'central_review','subject':d['submission'],'command_digest':r.sha(r.native.signing_bytes(command))};state['event_count']='1';state['height']='101';state['records']['event/'+str(1).zfill(20)]=event;state['receipt']={'authority':'native','finalized':True,'chain_id':r.CHAIN,'event':event}
  record={**command['payload'],'reviewer':e.p['reviewer'],'height':'101'};state['records']['central_review/'+d['submission']+'/'+r.sha(d['execution_id'].encode())]=record
  for role,member,amount in [('solver','uain1'+'b'*40,'100000000'),('reviewer',e.p['reviewer'],'20000000')]:
   state['records']['central_award/'+role+'/'+d['submission']]=dict(submission=d['submission'],task=d['task'],project='P-1',member=member,role=role,amount=amount,height='101') if verdict=='accept' or verdict=='reject' and role=='reviewer' else None
  return {k:job[k] for k in ['executionId','commandDigest','decisionDigest']}
 def test_exact_final_native_receipt_and_awards_reconcile_readonly(self):
  for verdict,count in [('accept',2),('reject',1),('needs_evidence',0)]:
   e,d,state,j,calls=self.fixture(True);request=self.finalize(e,d,state,j,verdict);result=e.receipt(request);self.assertTrue(result['verified']);self.assertEqual(len(result['awards']),count);self.assertEqual(calls,{'sign':1,'send':1});self.assertEqual(e.receipt(request),result)
 def test_wrong_award_owner_and_wrong_receipt_refused(self):
  for change in ['owner','receipt']:
   e,d,state,j,calls=self.fixture(True);request=self.finalize(e,d,state,j)
   if change=='owner':state['records']['central_award/solver/'+d['submission']]['member']=e.p['reviewer']
   else:state['receipt']['finalized']=False
   with self.assertRaises(ValueError):e.receipt(request)
   self.assertEqual(calls,{'sign':1,'send':1})
 def test_crash_after_sign_marker_never_signs_again(self):
  e,d,state,j,calls=self.fixture();e.sign=lambda *args:(_ for _ in ()).throw(TimeoutError('fictional interrupted signing'))
  with self.assertRaises(TimeoutError):e.review({'executionId':d['execution_id'],'decision':d})
  self.assertEqual(e.review({'executionId':d['execution_id'],'decision':d}),{'status':'unknown'});self.assertEqual(calls,{'sign':0,'send':0})
 @unittest.skipUnless(hasattr(__import__('socket'),'SO_PEERCRED'),'Linux actual peer credentials')
 def test_actual_unix_peer_uid_and_unknown_fields(self):
  import socket,tempfile,threading,json,os
  for peer,extra,expected in [(os.getuid(),False,b'200'),(os.getuid()+1,False,b'409'),(os.getuid(),True,b'409')]:
   e,d,*_=self.fixture()
   with tempfile.TemporaryDirectory(prefix='central-peer-',dir='/tmp') as directory:
    path=str(Path(directory)/'socket');server=s.Server(path,s.Handler);server.peer_uid=peer;server.engine_factory=lambda:e;thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
     connection=socket.socket(socket.AF_UNIX);connection.connect(path);body={'executionId':d['execution_id'],'decision':d};body.update({'nativeState':{}} if extra else {});raw=json.dumps(body).encode();connection.sendall(b'POST /review HTTP/1.0\r\nContent-Type: application/json\r\nContent-Length: '+str(len(raw)).encode()+b'\r\n\r\n'+raw);response=b''
     while True:
      part=connection.recv(4096)
      if not part:break
      response+=part
     connection.close();self.assertIn(expected,response)
    finally:server.shutdown();server.server_close();thread.join()

 def test_profile_binds_public_identity_and_exact_local_socket(self):
  public=r.b64(bytes([1])*32);member='uain1'+r.sha(bytes([1])*32)[:40];identity=dict(schema='uain-central-reviewer-identity-v1',chain_id=r.CHAIN,genesis_sha256=r.GENESIS,member=member,public_key=public);profile=dict(schema='uain-central-reviewer-server-v1',chain_id=r.CHAIN,genesis_sha256=r.GENESIS,reviewer=member,public_key=public,peer_uid=1000,socket_gid=1000,socket_path=str(s.SOCKET));self.assertEqual(s.validate_profile(profile,identity),profile)
  for field,value in [('socket_path','/tmp/unsafe.sock'),('peer_uid',0),('reviewer','uain1'+'f'*40),('genesis_sha256','a'*64),('extra',True)]:
   with self.assertRaises(ValueError):s.validate_profile({**profile,field:value},identity)
 def test_runtime_uses_own_private_proof_directory(self):
  from unittest.mock import patch
  with patch.object(s.r,'proof_policy',side_effect=lambda p:p),patch.object(s.admission,'ensure_directory') as ensure,patch.object(s.admission,'load',return_value={'fixture':True}),patch.object(s.admission,'Runtime',return_value='runtime') as runtime:
   self.assertEqual(s.runtime_for_request(),'runtime');self.assertEqual(s.admission.TEMP,Path('/run/uain-central-reviewer/native-proof'));ensure.assert_called_once_with(s.NATIVE_TEMP)
 def test_runtime_rejects_changed_reader_chain_genesis_or_guardian_before_construction(self):
  from unittest.mock import patch
  p=dict(schema='uain-native-admission-policy-v1',policy='objective-enrol-v1',chain_id=r.CHAIN,genesis='/etc/uain-custody/native-admission-genesis.json',genesis_sha256=r.GENESIS,state_binary='/opt/uain-chain/tools/state/136698192e9e38323a552f1e2da2eea5b9b90e3d6e7de11116d72ee28c826860/uain-state',state_sha256='136698192e9e38323a552f1e2da2eea5b9b90e3d6e7de11116d72ee28c826860',rpc='http://127.0.0.1:26667',guardian=r.native.GUARDIAN,guardian_public_key='mDuiMoDUKg66PitMD-j1pztm81wOKlYq7nFFCWLXoRI',guardian_key_attachment='keys/uain-review-key.json',guardian_epoch=None,start_event='0',start_event_digest='',max_events=16,max_approvals=4)
  with patch.object(s.admission,'ensure_directory'),patch.object(s.admission,'load',return_value=p),patch.object(s.admission,'Runtime',return_value='pinned'):
   self.assertEqual(s.runtime_for_request(),'pinned')
  for field,value in [('state_sha256','a'*64),('state_binary','/opt/alternate-reader'),('chain_id','uain-other'),('genesis_sha256','b'*64),('genesis','/opt/alternate-genesis'),('guardian','uain1'+'b'*40),('guardian_public_key',r.b64(bytes([2])*32)),('guardian_key_attachment','keys/alternate.json'),('rpc','http://127.0.0.1:26668')]:
   with self.subTest(field=field),patch.object(s.admission,'ensure_directory'),patch.object(s.admission,'load',return_value={**p,field:value}),patch.object(s.admission,'Runtime') as runtime:
    with self.assertRaises(ValueError):s.runtime_for_request()
    runtime.assert_not_called()
 def test_old_needs_evidence_receipt_ignores_only_later_awards(self):
  e,d,state,j,calls=self.fixture(True);request=self.finalize(e,d,state,j,'needs_evidence')
  for role in ['solver','reviewer']:state['records']['central_award/'+role+'/'+d['submission']]={'height':'102','member':'later-recipient'}
  result=e.receipt(request);self.assertTrue(result['verified']);self.assertFalse(result['paid']);self.assertEqual(result['awards'],[]);self.assertEqual(calls,{'sign':1,'send':1})
 def test_required_task_missing_attestation_blocks_accept_before_sign(self):
  e,d,state,j,calls=self.fixture();e.p['acceptance_attestations']={d['task']:{'criteria_digest':d['criteria_digest'],'live_source_path':'/FICTIONAL/frozen.mjs','live_source_sha256':'a'*64,'evidence_root':'/FICTIONAL/reproduction','not_before':'2026-11-05T00:00:00Z'}}
  result=e.review({'executionId':d['execution_id'],'decision':d});self.assertEqual(result['status'],'blocked');self.assertEqual(result['stage'],'pre_sign');self.assertEqual(calls,{'sign':0,'send':0});self.assertEqual(j,{})
 def attestation_fixture(self):
  import json,time
  e,d,state,j,calls=self.fixture();root=Path('/FICTIONAL/reproduction');live=b'FICTIONAL frozen source';corrected=b'FICTIONAL corrected source';stamp=datetime.datetime.now(datetime.timezone.utc).isoformat();data={};rule=dict(criteria_digest=d['criteria_digest'],live_source_path='/FICTIONAL/frozen.mjs',live_source_sha256=r.sha(live),evidence_root=str(root),not_before='2026-11-05T00:00:00Z',native_binary_sha256='c'*64);e.p['acceptance_attestations']={d['task']:rule};data[rule['live_source_path']]=live
  def artifact(name,raw):
   path=str(root/name);data[path]=raw;return dict(path=path,sha256=r.sha(raw))
  source=artifact('corrected.mjs',corrected);reproducer=artifact('reproducer.txt',b'FICTIONAL fixed reproducer template; source substituted only');reports=[]
  for name,outcome,code,sha in [('before','failed',1,r.sha(live)),('after','passed',0,r.sha(corrected))]:
   command=dict(executable_sha256='a'*64,argv=[reproducer['path'],'/FICTIONAL/frozen.mjs' if name=='before' else source['path']],source_arg_index=1);report=dict(schema='uain-native-reproduction-run-v1',task=d['task'],submission=d['submission'],criteria_digest=d['criteria_digest'],evidence_digest=d['evidence_digest'],source_sha256=sha,reproducer_sha256=reproducer['sha256'],native_binary_sha256='c'*64,fixture_genesis_sha256='d'*64,command=command,command_digest=r.sha(s.canonical(command)),output=artifact(name+'.log',('FICTIONAL '+outcome).encode()),outcome=outcome,exit_code=code,started_at=stamp,completed_at=stamp);reports.append(artifact(name+'.json',s.canonical(report)))
  manifest=dict(schema='uain-independent-reproduction-v1',chain_id=r.CHAIN,genesis_sha256=r.GENESIS,task=d['task'],submission=d['submission'],author='uain1'+'b'*40,criteria_digest=d['criteria_digest'],evidence_digest=d['evidence_digest'],live_source_sha256=r.sha(live),corrected_source=source,reproducer=reproducer,before=reports[0],after=reports[1],reviewed_uid=0,reviewed_by='FICTIONAL root operator; not outside adoption',reviewed_at=stamp,review_notes='FICTIONAL test only; no actual reproduction')
  manifest_path=str(root/(r.sha(d['submission'].encode())+'.json'));data[manifest_path]=s.canonical(manifest);e.attestation_read=lambda path,limit=0:data[str(path)];return e,d,state,j,calls,data,manifest,manifest_path
 def test_valid_root_attestation_allows_one_sign_and_binds_original_source(self):
  e,d,state,j,calls,data,a,path=self.attestation_fixture();self.assertTrue(e.readiness({'submission':d['submission']})['ready']);e.review({'executionId':d['execution_id'],'decision':d});self.assertEqual(calls,{'sign':1,'send':1});context=next(iter(j.values()))['context']['independent_reproduction'];self.assertEqual(context['attestation_sha256'],r.sha(data[path]));self.assertEqual(context['criteria_digest'],d['criteria_digest'])
 def test_bad_root_attestations_block_without_signing(self):
  for field,value in [('author','foreign'),('evidence_digest','f'*64),('criteria_digest','f'*64),('live_source_sha256','f'*64),('reviewed_uid',1000),('reviewed_at','2020-01-01T00:00:00Z')]:
   e,d,state,j,calls,data,a,path=self.attestation_fixture();a[field]=value;data[path]=s.canonical(a);self.assertFalse(e.readiness({'submission':d['submission']})['ready']);self.assertEqual(e.review({'executionId':d['execution_id'],'decision':d})['status'],'blocked');self.assertEqual(calls,{'sign':0,'send':0});self.assertEqual(j,{})
 def test_missing_then_installed_root_attestation_same_execution_signs_once(self):
  e,d,state,j,calls,data,a,path=self.attestation_fixture();raw=data.pop(path);body={'executionId':d['execution_id'],'decision':d};self.assertEqual(e.review(body)['stage'],'pre_sign');data[path]=raw;e.review(body);e.review(body);self.assertEqual(calls,{'sign':1,'send':1})
 def test_acceptance_gate_does_not_change_generic_reject_or_needs_evidence(self):
  for verdict in ['reject','needs_evidence']:
   e,d,state,j,calls=self.fixture();e.p['acceptance_attestations']={d['task']:{'criteria_digest':d['criteria_digest']}};d['verdict']=verdict;e.review({'executionId':d['execution_id'],'decision':d});self.assertEqual(calls,{'sign':1,'send':1})

 def test_attestation_rejects_wrong_run_source_and_escaped_artifact_paths(self):
  for change in ['run_source','escaped_path','output_digest']:
   e,d,state,j,calls,data,a,path=self.attestation_fixture()
   if change=='escaped_path':a['corrected_source']['path']='/FICTIONAL/outside.mjs'
   else:
    report=__import__('json').loads(data[a['before']['path']]);report['source_sha256']='f'*64 if change=='run_source' else report['source_sha256']
    if change=='output_digest':report['output']['sha256']='f'*64
    raw=s.canonical(report);data[a['before']['path']]=raw;a['before']['sha256']=r.sha(raw)
   data[path]=s.canonical(a);self.assertEqual(e.review({'executionId':d['execution_id'],'decision':d})['status'],'blocked');self.assertEqual(calls,{'sign':0,'send':0})
 @unittest.skipUnless(__import__('os').geteuid()==0,'actual root-owned artifact guard')
 def test_actual_root_artifacts_refuse_worldwrite_symlink_and_hardlink(self):
  import tempfile,json,os
  for mutation in ['none','worldwrite','symlink','hardlink']:
   e,d,state,j,calls,data,a,path=self.attestation_fixture()
   with tempfile.TemporaryDirectory(prefix='reproduction-artifacts-') as directory:
    root=Path(directory)
    def store(value):
     original=value['path'];raw=data[original];target=root/Path(original).name
     if target.suffix=='.json':
      record=json.loads(raw);record['output']=store(record['output']);record['command']['argv']=[str(root/Path(arg).name) for arg in record['command']['argv']];record['command_digest']=r.sha(s.canonical(record['command']));raw=s.canonical(record)
     target.write_bytes(raw);target.chmod(0o600);return dict(path=str(target),sha256=r.sha(raw))
    for k in ['corrected_source','reproducer','before','after']:a[k]=store(a[k])
    live=root/'frozen.mjs';live.write_bytes(data['/FICTIONAL/frozen.mjs']);live.chmod(0o600);rule=e.p['acceptance_attestations'][d['task']];rule['live_source_path']=str(live);rule['evidence_root']=str(root);manifest=root/(r.sha(d['submission'].encode())+'.json');manifest.write_bytes(s.canonical(a));manifest.chmod(0o600)
    if mutation=='worldwrite':live.chmod(0o666)
    if mutation=='symlink':live.unlink();live.symlink_to(root/'corrected.mjs')
    if mutation=='hardlink':os.link(live,root/'alias.mjs')
    e.attestation_read=None
    result=e.readiness({'submission':d['submission']});self.assertEqual(result['ready'],mutation=='none')

 def test_unrelated_reproducer_cannot_be_used_for_after_pass(self):
  e,d,state,j,calls,data,a,path=self.attestation_fixture();report=__import__('json').loads(data[a['after']['path']]);report['reproducer_sha256']='f'*64;raw=s.canonical(report);data[a['after']['path']]=raw;a['after']['sha256']=r.sha(raw);data[path]=s.canonical(a)
  self.assertEqual(e.review({'executionId':d['execution_id'],'decision':d})['status'],'blocked');self.assertEqual(calls,{'sign':0,'send':0})
 @unittest.skipUnless(__import__('os').geteuid()==0,'actual root coherent read guard')
 def test_root_artifact_snapshot_detects_atomic_replacement_and_inplace_write(self):
  import tempfile,os
  for mutation in ['replace','inplace']:
   with tempfile.TemporaryDirectory(prefix='artifact-coherence-') as directory:
    path=Path(directory)/'artifact';path.write_bytes(b'FICTIONAL original');path.chmod(0o600);snapshot=s.ProtectedArtifacts()
    try:
     self.assertEqual(snapshot.read(path,1024),b'FICTIONAL original')
     if mutation=='replace':
      other=Path(directory)/'next';other.write_bytes(b'FICTIONAL changed');other.chmod(0o600);os.replace(other,path)
     else:path.write_bytes(b'FICTIONAL changed')
     with self.assertRaises(ValueError):snapshot.verify()
    finally:snapshot.close()

 def test_after_unrelated_command_refused_even_with_same_reproducer_hash(self):
  e,d,state,j,calls,data,a,path=self.attestation_fixture();report=__import__('json').loads(data[a['after']['path']]);report['command']['argv'].append('--skip-failing-case');report['command_digest']=r.sha(s.canonical(report['command']));raw=s.canonical(report);data[a['after']['path']]=raw;a['after']['sha256']=r.sha(raw);data[path]=s.canonical(a)
  self.assertEqual(e.review({'executionId':d['execution_id'],'decision':d})['status'],'blocked');self.assertEqual(calls,{'sign':0,'send':0})

 def test_wrong_native_and_production_genesis_reproduction_refused(self):
  for field,value in [('native_binary_sha256','f'*64),('fixture_genesis_sha256',r.GENESIS)]:
   e,d,state,j,calls,data,a,path=self.attestation_fixture()
   for side in ['before','after']:
    report=__import__('json').loads(data[a[side]['path']]);report[field]=value;raw=s.canonical(report);data[a[side]['path']]=raw;a[side]['sha256']=r.sha(raw)
   data[path]=s.canonical(a);self.assertEqual(e.review({'executionId':d['execution_id'],'decision':d})['status'],'blocked');self.assertEqual(calls,{'sign':0,'send':0})

 def test_readiness_exposes_only_structural_root_summary(self):
  e,d,state,j,calls,data,a,path=self.attestation_fixture();ready=e.readiness({'submission':d['submission']});summary=ready['trusted_reproduction'];self.assertEqual(set(summary),{'schema','digest','native_binary_sha256','live_source_sha256','corrected_source_sha256','reproducer_sha256','before_outcome','after_outcome','reviewed_at','review_notes'});self.assertEqual(summary['digest'],ready['attestationDigest']);self.assertEqual(summary['before_outcome'],'failed');self.assertEqual(summary['after_outcome'],'passed');self.assertNotIn('command',summary);self.assertNotIn('output',summary);self.assertNotIn('path',summary)

class ServerStallTests(unittest.TestCase):
 """CU-5: one idle peer connection must not stop the single-threaded custody server."""
 def serve(self,peer_uid,timeout):
  import os,socket,tempfile,threading
  from unittest.mock import patch
  # The production per-connection timeout, applied before the request line is read.
  self.assertTrue(type(s.Handler.timeout) in (int,float) and 0<s.Handler.timeout<=10,s.Handler.timeout)
  directory=tempfile.TemporaryDirectory(prefix='central-stall-',dir='/tmp');self.addCleanup(directory.cleanup);path=str(Path(directory.name)/'socket')
  self.addCleanup(patch.stopall);patch.object(s.Handler,'timeout',timeout).start();patch.object(s,'peer_credentials',lambda connection:peer_uid).start()
  server=s.Server(path,s.Handler);server.peer_uid=os.getuid();server.engine_factory=lambda:self.fail('no engine');server.loaded_admission=lambda body:{};server.loaded_feedback=lambda body:{}
  thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
  def stop():server.shutdown();server.server_close();thread.join()
  self.addCleanup(stop)
  def request(timeout=5):
   c=socket.socket(socket.AF_UNIX);c.settimeout(timeout);c.connect(path);body=b'{"submission":"x"}'
   c.sendall(b'POST /readiness HTTP/1.0\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%s'%(len(body),body));answer=b''
   try:
    while True:
     part=c.recv(4096)
     if not part:break
     answer+=part
   except socket.timeout:return None
   finally:c.close()
   return answer
  def idle():
   c=socket.socket(socket.AF_UNIX);c.connect(path);self.addCleanup(c.close);return c
  return request,idle
 def test_an_idle_connection_is_dropped_after_the_timeout_and_the_next_request_is_answered(self):
  import os,time
  request,idle=self.serve(os.getuid(),0.5);idle();time.sleep(0.1);started=time.monotonic();answer=request()
  self.assertIsNotNone(answer,'no answer while one idle peer is connected');self.assertLess(time.monotonic()-started,3)
  self.assertIn(b'409',answer.split(b'\r\n')[0])
 def test_a_foreign_peer_is_refused_before_anything_is_read(self):
  import os,time
  request,idle=self.serve(os.getuid()+1,5);idle();time.sleep(0.1);started=time.monotonic();answer=request()
  self.assertIsNotNone(answer);self.assertLess(time.monotonic()-started,3,'refused without waiting for the idle foreign peer');self.assertIn(b'409',answer.split(b'\r\n')[0])

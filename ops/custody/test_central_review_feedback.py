"""Read-only feedback projection: fictional native proof and retained public decision."""
import copy,datetime,hashlib,io,json,struct,types,unittest,tempfile,os
from pathlib import Path
from unittest.mock import Mock,patch
import central_reviewer_server as s
import central_reviewer as r
import test_central_reviewer as fixtures

def _root_can_chown():
 """Root without CAP_CHOWN (the CI sandbox drops every capability) cannot give the fixture a runner owner."""
 if os.getuid()!=0:return True
 with tempfile.NamedTemporaryFile() as f:
  try:os.chown(f.name,1001,-1);return True
  except PermissionError:return False
CAN_CHOWN=_root_can_chown()
NEEDS_CHOWN=unittest.skipUnless(CAN_CHOWN,'running as root without CAP_CHOWN; the locator fixture needs a non-root owner')

class FeedbackTests(unittest.TestCase):
 def fixture(self):
  p,state,d=fixtures.CentralReviewerTests().fixture();p['genesis_sha256']=r.GENESIS;d['verdict']='needs_evidence';d['schema']='uain-central-research-decision-v2';d['verification_attestation_digest']='e'*64;state['app_hash']='a'*64
  command=r.review_command(p,state,d);record={**command['payload'],'reviewer':p['reviewer'],'height':'100'};key='central_review/'+d['submission']+'/'+r.sha(d['execution_id'].encode());state['records'][key]=record
  event={'id':'1','height':'100','operation':'central_review','member':p['reviewer'],'subject':d['submission'],'command_digest':r.sha(r.native.signing_bytes(command))}
  journal={'schema':'uain-central-review-once-v1','executionId':d['execution_id'],'reviewer':p['reviewer'],'decision':d,'decisionDigest':r.decision_digest(d),'commandDigest':r.sha(s.canonical(s.worker_command(d))),'nativeCommandDigest':event['command_digest'],'envelope':{'command':command,'public_key':p['public_key'],'signature':'fixture-only'},'phase':'finalized','receipt':{'authority':'native','finalized':True,'chain_id':r.CHAIN,'event':event}}
  runtime=types.SimpleNamespace(read=Mock(side_effect=lambda selection:copy.deepcopy(state)),broadcast=Mock(side_effect=AssertionError('no sends')))
  reader=Mock(return_value=s.canonical(journal));body={'submission':d['submission'],'executionId':d['execution_id']};return p,state,d,journal,runtime,reader,body
 def test_exact_projection_is_native_committed_and_excludes_all_private_job_fields(self):
  p,state,d,j,runtime,reader,body=self.fixture();j['private_provider_prompt']='must never leave';reader.return_value=s.canonical(j)
  value=s.feedback_projection(p,body,runtime,reader);self.assertEqual(value['decision'],d);self.assertEqual(value['nativeReview']['verification_digest'],r.decision_digest(d));self.assertEqual(value['author'],state['records']['central_submission/'+d['submission']]['author']);self.assertNotIn('private_provider_prompt',json.dumps(value));self.assertEqual(set(value),{'schema','submission','executionId','author','task','project','chainId','genesisSha256','nativeReview','decision','native'});self.assertEqual(reader.call_args.args[0],r.ROOT/'reviews'/(r.sha(d['execution_id'].encode())+'.json'));runtime.broadcast.assert_not_called()
 def test_invalid_request_is_refused_before_file_or_native_read(self):
  for body in ({'submission':'../keys','executionId':'R'},{'submission':'S','executionId':'R','path':'/private'},{'submission':'S','executionId':'x'*97}):
   p,_,_,_,runtime,reader,_=self.fixture()
   with self.assertRaises(ValueError):s.feedback_projection(p,body,runtime,reader)
   reader.assert_not_called();runtime.read.assert_not_called()
 def test_unfinalized_or_foreign_retained_decision_never_returns_feedback(self):
  for change in (lambda j:j.update(phase='sign_started'),lambda j:j['decision'].update(private_prompt='no'),lambda j:j['decision'].update(findings=['uncommitted correction']),lambda j:j.update(executionId='another')):
   p,_,_,j,runtime,reader,body=self.fixture();change(j);reader.return_value=s.canonical(j)
   with self.assertRaises(ValueError):s.feedback_projection(p,body,runtime,reader)
   runtime.read.assert_not_called()
 def test_wrong_native_binding_network_staleness_or_record_absence_refuses(self):
  for change in (lambda state,key:state['records'].__setitem__(key,None),lambda state,key:state['records'][key].update(verification_digest='f'*64),lambda state,key:state['records']['central_submission/CS-1'].update(task='foreign'),lambda state,key:state.update(chain_id='another'),lambda state,key:state.update(header_time='2020-01-01T00:00:00Z')):
   p,state,d,_,runtime,reader,body=self.fixture();key='central_review/'+d['submission']+'/'+r.sha(d['execution_id'].encode());change(state,key)
   with self.assertRaises(ValueError):s.feedback_projection(p,body,runtime,reader)
 def test_historical_completed_task_does_not_require_pending_state_or_new_review(self):
  p,state,_,_,runtime,reader,body=self.fixture();state['records']['central_submission/CS-1']['state']='rejected';state['records']['central_task/CT-1'].update(state='accepted',pending='',winner='another')
  self.assertEqual(s.feedback_projection(p,body,runtime,reader)['nativeReview']['verdict'],'needs_evidence');self.assertEqual(runtime.read.call_count,1)
 def test_null_request_uses_job_only_as_locator_then_proves_actual_decision(self):
  p,state,d,j,runtime,reader,body=self.fixture();locator=Mock(return_value=d['execution_id']);result=s.feedback_projection(p,{**body,'executionId':None},runtime,reader,locator=locator);locator.assert_called_once_with(p,d['submission']);self.assertEqual(result['executionId'],d['execution_id']);self.assertEqual(result['decision'],d)
  p,state,d,j,runtime,reader,body=self.fixture();locator=Mock(side_effect=AssertionError('explicit request must not read jobs'));s.feedback_projection(p,body,runtime,reader,locator=locator);locator.assert_not_called()
 @NEEDS_CHOWN
 def test_locator_has_fixed_path_private_owner_and_extracts_no_job_authority(self):
  owner=os.getuid() or 1001
  with tempfile.TemporaryDirectory(dir=Path.home()) as directory:
   path=Path(directory)/'jobs.json';path.write_text(json.dumps({'version':1,'jobs':{'CS-1':{'submission':'CS-1','execution_id':'review-1','decision':{'private_prompt':'not returned'},'author':'untrusted-job-author'}},'attempts':{}}));path.chmod(0o600)
   if os.getuid()==0:os.chown(path,owner,-1)
   with patch.object(s,'FEEDBACK_JOBS',path):
    self.assertEqual(s.feedback_locator({'peer_uid':owner},'CS-1'),'review-1')
    path.chmod(0o644)
    with self.assertRaises(ValueError):s.feedback_locator({'peer_uid':owner},'CS-1')
    path.chmod(0o600);path.unlink();path.symlink_to('/never-open')
    with self.assertRaises((ValueError,OSError)):s.feedback_locator({'peer_uid':owner},'CS-1')
 @NEEDS_CHOWN
 def test_locator_reads_an_archived_job_locator_written_by_the_worker(self):
  # 12 November 2026 (P1-2): the worker moves completed jobs to write-once archive files and leaves this
  # locator in jobs.json; the unchanged custody locator still finds the execution id.
  owner=os.getuid() or 1001
  with tempfile.TemporaryDirectory(dir=Path.home()) as directory:
   path=Path(directory)/'jobs.json';path.write_text(json.dumps({'version':1,'jobs':{'CS-1':{'submission':'CS-1','state':'archived','execution_id':'review-2','created_at':'2026-11-01T00:00:00.000Z','archived_at':'2026-11-12T00:00:00.000Z','archive':'jobs-archive-20261112T000000Z-0a1b2c3d.json','history':[{'execution_id':'review-1'}]}},'attempts':{}}));path.chmod(0o600)
   if os.getuid()==0:os.chown(path,owner,-1)
   with patch.object(s,'FEEDBACK_JOBS',path):self.assertEqual(s.feedback_locator({'peer_uid':owner},'CS-1'),'review-2')
 @NEEDS_CHOWN
 def test_locator_refuses_duplicate_keys_deep_or_foreign_job_binding(self):
  owner=os.getuid() or 1001
  bad=[b'{"version":1,"version":1,"jobs":{}}',b'{"version":1,"jobs":{},"x":'+b'['*65+b'0'+b']'*65+b'}',json.dumps({'version':1,'jobs':{'CS-1':{'submission':'another','execution_id':'R'}}}).encode()]
  with tempfile.TemporaryDirectory(dir=Path.home()) as directory:
   path=Path(directory)/'jobs.json'
   for raw in bad:
    path.write_bytes(raw);path.chmod(0o600)
    if os.getuid()==0:os.chown(path,owner,-1)
    with patch.object(s,'FEEDBACK_JOBS',path),self.assertRaises(ValueError):s.feedback_locator({'peer_uid':owner},'CS-1')
 @NEEDS_CHOWN
 def test_locator_detects_fd_gid_or_current_path_inode_change(self):
  owner=os.getuid() or 1001
  with tempfile.TemporaryDirectory(dir=Path.home()) as directory:
   path=Path(directory)/'jobs.json';path.write_text(json.dumps({'version':1,'jobs':{'CS-1':{'submission':'CS-1','execution_id':'R'}}}));path.chmod(0o600)
   if os.getuid()==0:os.chown(path,owner,-1)
   info=path.lstat();keys=('st_dev','st_ino','st_size','st_mtime_ns','st_ctime_ns','st_uid','st_gid','st_mode','st_nlink');base={k:getattr(info,k) for k in keys};original=Path.lstat
   for field in ('st_gid','st_ino'):
    first=types.SimpleNamespace(**base);changed=types.SimpleNamespace(**{**base,field:base[field]+1});seen=[0]
    def stated(p):
     if p!=path:return original(p)
     seen[0]+=1;return changed if field=='st_ino' and seen[0]>1 else first
    with patch.object(s,'FEEDBACK_JOBS',path),patch.object(Path,'lstat',stated),patch.object(s.os,'fstat',side_effect=[first,changed if field=='st_gid' else first]),self.assertRaises(ValueError):s.feedback_locator({'peer_uid':owner},'CS-1')
 def test_read_wrapper_bounds_public_runtime_and_verifies_retained_snapshot(self):
  p,state,d,j,runtime,reader,body=self.fixture();runtime.deadline=s.time.monotonic()+120;snapshot=types.SimpleNamespace(read=reader,verify=Mock(),close=Mock())
  with patch.object(s,'runtime_for_request',return_value=runtime) as factory,patch.object(s,'ProtectedArtifacts',return_value=snapshot):
   result=s.read_feedback(p,body);self.assertEqual(result['decision'],d);self.assertLessEqual(runtime.deadline,s.time.monotonic()+5.5);snapshot.verify.assert_called_once();snapshot.close.assert_called_once();factory.assert_called_once()
  with patch.object(s,'runtime_for_request') as factory,self.assertRaises(ValueError):s.read_feedback(p,{'submission':'../x','executionId':'R'})
  factory.assert_not_called()
 def test_changed_retained_snapshot_never_returns_a_packet(self):
  p,_,_,_,runtime,reader,body=self.fixture();runtime.deadline=s.time.monotonic()+120;snapshot=types.SimpleNamespace(read=reader,verify=Mock(side_effect=ValueError('inode drift')),close=Mock())
  with patch.object(s,'runtime_for_request',return_value=runtime),patch.object(s,'ProtectedArtifacts',return_value=snapshot),self.assertRaises(ValueError):s.read_feedback(p,body)
  snapshot.close.assert_called_once();runtime.broadcast.assert_not_called()
 def test_handler_root_only_projection_never_constructs_economic_engine(self):
  for uid,code in ((0,200),(1001,409)):
   h=object.__new__(s.Handler);h.path='/feedback';h.connection=Mock();h.connection.getsockopt.return_value=struct.pack('3i',1,uid,1);raw=b'{"submission":"S","executionId":"R"}';h.rfile=io.BytesIO(raw);h.wfile=io.BytesIO();h.headers={'Content-Type':'application/json','Content-Length':str(len(raw))};h.send_response=Mock();h.send_header=Mock();h.end_headers=Mock();h.server=types.SimpleNamespace(peer_uid=1001,engine_factory=Mock(side_effect=AssertionError('no vault engine')),loaded_feedback=Mock(return_value={'public':'fixture'}))
   with patch.object(s.socket,'SO_PEERCRED',getattr(s.socket,'SO_PEERCRED',17),create=True):h.do_POST()
   h.send_response.assert_called_once_with(code);h.server.engine_factory.assert_not_called();self.assertEqual(h.server.loaded_feedback.call_count,1 if uid==0 else 0)
if __name__=='__main__':unittest.main()

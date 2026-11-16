"""Fictional custody signatures; this runner only consumes public envelopes."""
import copy,datetime,importlib.util,json,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
import test_native_payment_bootstrap as fixtures

class SubmitBootstrapTests(unittest.TestCase):
 def setUp(self):
  spec=importlib.util.spec_from_file_location('submit_bootstrap',Path(__file__).with_name('submit_payment_bootstrap.py'));self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)
  self.fixture=fixtures.BootstrapTests();self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)
  p=patch.object(self.m,'f',self.fixture.m);p.start();self.addCleanup(p.stop)
 def setup_run(self,phase='identity'):
  a,state,raw,now=self.fixture.fixture(phase);batch=self.fixture.m.sign_batch(self.fixture.custody(),a,state,raw,now);directory=Path('/root/fixed-fictional');store={};sends=[];pending=[];lost=[False];clock=[now]
  def load(path):
   if Path(path).name not in store:raise FileNotFoundError(path)
   return copy.deepcopy(store[Path(path).name])
  def write(path,value):store[Path(path).name]=copy.deepcopy(value)
  helper=self.fixture.m
  class Runtime:
   def read(self,selection):
    out=copy.deepcopy(state);out['header_time']=datetime.datetime.fromtimestamp(clock[0],datetime.timezone.utc).isoformat();out['member']=copy.deepcopy(out['records']['member/'+selection['member']])
    # The real gateway stringifies counters while raw selected member rows do not.
    out['member']['karma']=str(out['member']['karma'])
    if 'receipt' in selection:
     receipt=selection['receipt'];assert selection['member']==receipt['envelope']['command']['member'];event=out['records'][helper.event_key(int(receipt['event_id']))];out['receipt']=dict(authority='native',finalized=True,chain_id=a['chain_id'],state_height=out['height'],app_hash=out['app_hash'],event=event)
    return out
   def broadcast(self,envelope):
    entry=next(e for e in store['submit-journal.json']['entries'] if e['command_digest']==self_outer.m.command_digest(envelope));assert entry['status']=='broadcast_started' and entry['send_attempted_at'];sends.append(copy.deepcopy(envelope));pending.append(copy.deepcopy(envelope))
    if lost[0]:raise TimeoutError('uncertain transport')
    return 0
  self_outer=self
  def advance():
   envelope=pending.pop(0);command=envelope['command'];count=int(state['event_count'])+1;height=int(state['height'])+1;state.update(event_count=str(count),height=str(height));member=state['records']['member/'+command['member']];member['sequence']=str(int(command['sequence'])+1)
   event=dict(id=str(count),height=str(height),member=command['member'],operation=command['operation'],subject=self.m.subject(command),command_digest=self.m.command_digest(envelope));state['records'][helper.event_key(count)]=event
   if command['operation']=='identity_claim':
    target=helper.TARGETS[next(n for n,t in helper.TARGETS.items() if t['member']==command['member'])];binding=dict(member=target['member'],did=helper.did(target['member']),operator=helper.OPERATOR,origin='member-derived',approved_by=target['member'],event_id=str(count),at=datetime.datetime.fromtimestamp(clock[0],datetime.timezone.utc).isoformat());state['records']['actor_identity/'+target['member']+'/']=binding;state['records']['actor_did/'+binding['did']]=target['member']+'/'
   elif command['operation']=='roles':member.update(creator=True,default_verifier=True)
   else:state['records']['private_reviewer/'+command['payload']['member']]=dict(active=True,evidence_digest=a['evidence_sha256'])
   return event
  runtime=Runtime()
  def run():
   with patch.object(self.m.time,'time',side_effect=lambda:clock[0]):return self.m.process(a,raw,batch,directory,runtime,load=load,write=write)
  return dict(a=a,state=state,raw=raw,batch=batch,store=store,sends=sends,pending=pending,lost=lost,clock=clock,load=load,write=write,runtime=runtime,advance=advance,run=run,directory=directory)
 def test_identity_different_signers_and_roles_same_signer_wait_exact_finality(self):
  for phase in ['identity','roles']:
   f=self.setup_run(phase);self.assertEqual(f['run']()['status'],'pending_finality');self.assertEqual(len(f['sends']),1);f['run']();self.assertEqual(len(f['sends']),1);f['advance']();f['run']();self.assertEqual(len(f['sends']),2);f['advance']();result=f['run']();self.assertTrue(result['complete']);self.assertFalse(result['independent_operators']);self.assertFalse(result['mint']);f['run']();self.assertEqual(len(f['sends']),2)
 def test_uncertain_never_resends_and_proves_original_receipt_before_next_command(self):
  f=self.setup_run();f['lost'][0]=True;f['run']();f['run']();self.assertEqual(len(f['sends']),1);f['advance']();f['lost'][0]=False;f['run']();self.assertEqual(len(f['sends']),2)
 def test_receipt_subject_member_operation_and_did_reverse_must_match(self):
  for field,value in [('subject','wrong'),('member','uain1'+'a'*40),('operation','roles'),('origin','legacy')]:
   f=self.setup_run();f['run']();f['advance']()[field]=value
   with self.subTest(field=field),self.assertRaises(ValueError):f['run']()
   self.assertEqual(len(f['sends']),1)
  f=self.setup_run();f['run']();f['advance']();target=self.fixture.m.TARGETS['guardian'];f['state']['records']['actor_did/'+self.fixture.m.did(target['member'])]='other/'
  with self.assertRaises(ValueError):f['run']()
 def test_external_event_or_actor_drift_blocks_later_send(self):
  for mutate in [lambda f:f['state'].update(event_count='5'),lambda f:f['state']['records']['member/'+self.fixture.targets['claude']['member']].update(karma=133),lambda f:f['state']['records']['member/'+self.fixture.targets['guardian']['member']].update(default_verifier=True)]:
   f=self.setup_run();f['run']();f['advance']();mutate(f)
   with self.assertRaises(ValueError):f['run']()
   self.assertEqual(len(f['sends']),1)
 def test_marker_fsync_failure_never_broadcasts(self):
  f=self.setup_run()
  def fail(path,value):
   if any(e['send_attempted_at'] for e in value['entries']):raise OSError('fsync failed')
   f['write'](path,value)
  with self.assertRaises(OSError):self.m.process(f['a'],f['raw'],f['batch'],f['directory'],f['runtime'],load=f['load'],write=fail)
  self.assertFalse(f['sends'])
 def test_expiry_during_marker_persistence_retains_not_broadcast_and_never_retries(self):
  f=self.setup_run()
  def delayed(path,value):
   f['write'](path,value)
   if any(e['send_attempted_at'] for e in value['entries']):f['clock'][0]=f['a']['expires_at']+1
  with patch.object(self.m.time,'time',side_effect=lambda:f['clock'][0]):result=self.m.process(f['a'],f['raw'],f['batch'],f['directory'],f['runtime'],load=f['load'],write=delayed)
  self.assertEqual(result['status'],'not_broadcast');self.assertFalse(f['sends']);self.assertEqual(f['run']()['status'],'not_broadcast')
 def test_finalized_roles_recover_read_only_after_approval_expiry(self):
  f=self.setup_run('roles');f['run']();f['advance']();f['run']();f['advance']();self.assertTrue(f['run']()['complete']);f['clock'][0]=f['a']['expires_at']+1000;self.assertTrue(f['run']()['complete']);self.assertEqual(len(f['sends']),2)
 def test_wrong_resulting_reviewer_or_identity_never_reports_complete(self):
  for phase in ['identity','roles']:
   f=self.setup_run(phase);f['run']();f['advance']();f['run']();f['advance']();target=self.fixture.targets['claude']['member'];key='actor_identity/'+target+'/' if phase=='identity' else 'private_reviewer/'+target
   f['state']['records'][key]['operator' if phase=='identity' else 'evidence_digest']='wrong'
   with self.assertRaises(ValueError):f['run']()
 def test_tampered_retained_batch_or_journal_never_sends(self):
  f=self.setup_run();f['batch']['envelopes'][0]['command']['payload']['operator']='Other'
  with self.assertRaises(ValueError):f['run']()
  self.assertFalse(f['sends']);f=self.setup_run();f['run']();f['store']['submit-journal.json']['batch_sha256']='0'*64
  with self.assertRaises(ValueError):f['run']()
  self.assertEqual(len(f['sends']),1)
 def test_expired_approval_or_block_window_is_retained_as_not_broadcast(self):
  for kind in ['wall','block']:
   f=self.setup_run()
   if kind=='wall':f['clock'][0]=f['a']['expires_at']+1
   else:f['state']['height']=f['a']['expires_height']
   with self.subTest(kind=kind):self.assertEqual(f['run']()['status'],'not_broadcast')
   self.assertFalse(f['sends']);self.assertEqual(f['run']()['status'],'not_broadcast')
 def test_crash_after_send_before_outcome_persistence_does_not_resend(self):
  f=self.setup_run()
  def fail(path,value):
   if any(e['status']=='accepted' for e in value['entries']):raise OSError('outcome fsync failed')
   f['write'](path,value)
  with self.assertRaises(OSError):self.m.process(f['a'],f['raw'],f['batch'],f['directory'],f['runtime'],load=f['load'],write=fail)
  self.assertEqual(f['store']['submit-journal.json']['entries'][0]['status'],'broadcast_started');f['run']();self.assertEqual(len(f['sends']),1);f['advance']();f['run']();self.assertEqual(len(f['sends']),2)
 def test_roles_do_not_allow_earlier_identity_operator_to_change_between_commands(self):
  f=self.setup_run('roles');f['run']();f['advance']();member=self.fixture.targets['claude']['member'];f['state']['records']['actor_identity/'+member+'/']['operator']='Fake independent operator'
  with self.assertRaises(ValueError):f['run']()
  self.assertEqual(len(f['sends']),1)
if __name__=='__main__':unittest.main()

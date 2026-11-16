"""Operational activation submission tests use fictional signed public batches."""
import copy,datetime,hashlib,importlib.util,json,sys,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch

CUSTODY=Path(__file__).resolve().parent
sys.path.insert(0,str(CUSTODY))
class SubmitTests(unittest.TestCase):
 def setUp(self):
  spec=importlib.util.spec_from_file_location('activation_submit',Path(__file__).with_name('submit_financial_activation.py'))
  self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)
  spec=importlib.util.spec_from_file_location('activation_fixtures',CUSTODY/'test_native_financial_activation.py')
  fm=importlib.util.module_from_spec(spec);spec.loader.exec_module(fm)
  self.fixture=fm.FinancialActivationTests();self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)
  self.patch=patch.object(self.m,'f',self.fixture.m);self.patch.start();self.addCleanup(self.patch.stop)
 def fixture_run(self,phase='foundation'):
  m=self.m;helper=self.fixture.m;a,state,raw,now=self.fixture.fixture(phase);batch=helper.sign_batch(self.fixture.custody(),a,state,raw,now=now)
  directory=Path(tempfile.mkdtemp(prefix='submit-fixture-'));self.addCleanup(__import__('shutil').rmtree,directory)
  store={};sends=[];lost=[False];pending=[]
  def load(path):
   if Path(path).name not in store:raise FileNotFoundError(path)
   return copy.deepcopy(store[Path(path).name])
  def write(path,value):store[Path(path).name]=copy.deepcopy(value)
  class Runtime:
   def read(self,selection):
    out=copy.deepcopy(state)
    if 'receipt' in selection:
     n=selection['receipt']['event_id'];event=out['records'][helper.event_key(int(n))]
     out['receipt']=dict(authority='native',finalized=True,chain_id=a['chain_id'],state_height=out['height'],app_hash=out['app_hash'],event=event)
    return out
   def broadcast(self,envelope):
    entries=store['submit-journal.json']['entries'];marker=entries[len(sends)]
    assert marker['send_attempted_at'] and marker['status']=='broadcast_started'
    sends.append(copy.deepcopy(envelope));pending.append(copy.deepcopy(envelope))
    if lost[0]:raise TimeoutError('fictional lost response')
    return 0
  def advance():
   envelope=pending.pop(0);command=envelope['command'];count=int(state['event_count'])+1;height=int(state['height'])+1
   state.update(event_count=str(count),height=str(height));state['member']['sequence']=str(int(command['sequence'])+1)
   event=dict(id=str(count),height=str(height),member=a['guardian'],operation=command['operation'],subject=command['payload']['policy'],command_digest=helper.sha(helper.native.signing_bytes(command)))
   state['records'][helper.event_key(count)]=event
   key=dict((op,key) for items in helper.PHASES.values() for op,key in items)[command['operation']]
   if key in ('private_activation','coin_activation'):
    marker=dict(policy=command['payload']['policy'],height=str(height+1),evidence_digest=a['evidence_sha256'])
    if key=='private_activation':
     marker['relayer']=a['relayer'];state['records']['private_frontier']=dict(count='0',root='0'*64,nodes=['']*32)
    else:state['records']['coin_supply']=dict(minted='0',reserved='0',transparent='0',shielded='0')
   else:marker=dict(policy=command['payload']['policy'],effective_height=str(height+1),approved_by=a['guardian'],evidence_digest=a['evidence_sha256'])
   state['records'][key]=marker
   state['height']=str(height+1)
   return event
  runtime=Runtime()
  run=lambda:m.process(a,raw,batch,directory,runtime,load=load,write=write)
  return a,state,raw,batch,store,sends,lost,advance,run,runtime,load,write,directory
 def test_two_command_phase_waits_exact_finality_then_completes_authenticated_markers(self):
  a,state,raw,batch,store,sends,lost,advance,run,*_=self.fixture_run()
  self.assertEqual(run()['status'],'pending_finality');self.assertEqual(len(sends),1)
  self.assertEqual(run()['status'],'pending_finality');self.assertEqual(len(sends),1)
  advance();self.assertEqual(run()['status'],'pending_finality');self.assertEqual(len(sends),2)
  advance();answer=run();self.assertTrue(answer['complete']);self.assertEqual(answer['commands_finalized'],2)
  self.assertEqual(run()['status'],'complete');self.assertEqual(len(sends),2)
 def test_uncertain_first_send_is_not_rebroadcast_and_can_reconcile_later(self):
  a,state,raw,batch,store,sends,lost,advance,run,*_=self.fixture_run();lost[0]=True
  self.assertEqual(run()['status'],'pending_finality');self.assertEqual(len(sends),1)
  self.assertEqual(run()['status'],'pending_finality');self.assertEqual(len(sends),1)
  advance();lost[0]=False;run();self.assertEqual(len(sends),2)
 def test_wrong_subject_or_digest_cannot_authorize_next_command(self):
  for field,value in [('subject','wrong-policy'),('member','uain1'+'a'*40)]:
   a,state,raw,batch,store,sends,lost,advance,run,*_=self.fixture_run();run();event=advance();event[field]=value
   with self.assertRaises(ValueError):run()
   self.assertEqual(len(sends),1)
 def test_sequence_expiry_or_changed_precondition_prevents_first_send(self):
  for mutate in [lambda a,s:s['member'].update(sequence='18'),lambda a,s:s.update(height='181'),lambda a,s:s['records'].update(coin_supply={}),lambda a,s:s['records']['member/'+a['relayer']].update(licence='revoked')]:
   a,state,raw,batch,store,sends,lost,advance,run,*_=self.fixture_run();mutate(a,state)
   with self.assertRaises(ValueError):run()
   self.assertEqual(sends,[])
 def test_failed_durable_send_marker_never_broadcasts(self):
  a,state,raw,batch,store,sends,lost,advance,run,runtime,load,write,directory=self.fixture_run()
  def fail(path,value):
   if any(e.get('send_attempted_at') for e in value['entries']):raise OSError('fictional fsync failure')
   write(path,value)
  with self.assertRaises(OSError):self.m.process(a,raw,batch,directory,runtime,load=load,write=fail)
  self.assertEqual(sends,[])
 def test_economy_completes_only_with_empty_supply_and_pool_after_exact_receipts(self):
  a,state,raw,batch,store,sends,lost,advance,run,*_=self.fixture_run('economy')
  run();advance();run();advance();answer=run();self.assertTrue(answer['complete']);self.assertEqual(answer['coin_supply'],dict(minted='0',reserved='0',transparent='0',shielded='0'))
  state['records']['coin_supply']['minted']='1'
  with self.assertRaises(ValueError):run()
 def test_approval_expiring_during_second_receipt_read_prevents_second_send(self):
  a,state,raw,batch,store,sends,lost,advance,run,runtime,load,write,directory=self.fixture_run()
  run();advance();clock=[time.time()];original=runtime.read;receipts=[0]
  def delayed(selection):
   value=original(selection)
   if 'receipt' in selection:
    receipts[0]+=1
    if receipts[0]>=2:
     clock[0]=a['expires_at']+1
     state['header_time']=datetime.datetime.fromtimestamp(clock[0],datetime.timezone.utc).isoformat()
     value['header_time']=state['header_time']
   return value
  runtime.read=delayed
  with patch.object(self.m.time,'time',side_effect=lambda:clock[0]):
   with self.assertRaises(ValueError):run()
  self.assertEqual(len(sends),1)
  self.assertIsNone(store['submit-journal.json']['entries'][1]['send_attempted_at'])
 def test_tampered_public_batch_or_journal_hash_never_broadcasts(self):
  a,state,raw,batch,store,sends,lost,advance,run,*_=self.fixture_run();batch['envelopes'][0]['command']['operation']='coin_claim'
  with self.assertRaises(ValueError):run()
  self.assertEqual(sends,[])
  a,state,raw,batch,store,sends,lost,advance,run,*_=self.fixture_run();run();store['submit-journal.json']['batch_sha256']='0'*64
  with self.assertRaises(ValueError):run()
  self.assertEqual(len(sends),1)
if __name__=='__main__':unittest.main()

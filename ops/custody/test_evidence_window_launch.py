import copy,datetime,importlib.util,unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location('evidence_window_launch',Path(__file__).with_name('evidence_window_launch.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
A='uain1'+'a'*40

class EvidenceWindowLaunchTest(unittest.TestCase):
 def setUp(self):
  self.now=1794268800
  self.plan=dict(schema='uain-evidence-window-launch-v1',chain_id=m.CHAIN,genesis_sha256=m.GENESIS,policy=m.POLICY,window_blocks='129600',evidence_digest='e'*64)
  self.records={'guardians':[m.GUARDIAN],'guardian_epoch_current':None,'central_evidence_activation':None,
   'central_earning_activation':dict(policy='central-earning-project-budget-v1',reviewer=A,height='50',evidence_digest='d'*64)}
 def state(self,height='100',sequence='7',events='20'):
  return dict(chain_id=m.CHAIN,height=height,header_time=datetime.datetime.fromtimestamp(self.now,datetime.timezone.utc).isoformat(),event_count=events,app_hash='b'*64,
   member=dict(id=m.GUARDIAN,public_key=m.PUBLIC,licence='active',sequence=sequence),records=copy.deepcopy(self.records))

 def test_activation_is_fixed(self):
  c=m.command(self.plan,self.state(),now=self.now)
  self.assertEqual((c['member'],c['operation'],c['sequence'],c['expires_height']),(m.GUARDIAN,'central_evidence_activate','7','200'))
  self.assertEqual(c['payload'],dict(policy='central-evidence-window-v1',window_blocks='129600',evidence_digest='e'*64))
 def test_refused_twice_after_handover_without_central_earning_or_stale(self):
  for change in ('active','epoch','second_guardian','no_central','stale','unlicensed'):
   self.setUp()
   if change=='active':self.records['central_evidence_activation']=dict(policy=m.POLICY,window_blocks='129600',height='60',approved_by=m.GUARDIAN,evidence_digest='e'*64)
   if change=='epoch':self.records['guardian_epoch_current']={'epoch':1}
   if change=='second_guardian':self.records['guardians']=[m.GUARDIAN,A]
   if change=='no_central':self.records['central_earning_activation']=None
   s=self.state()
   if change=='stale':s['header_time']='2020-01-01T00:00:00+00:00'
   if change=='unlicensed':s['member']['licence']='revoked'
   with self.subTest(change=change),self.assertRaises((ValueError,TypeError,AttributeError)):m.command(self.plan,s,now=self.now)
 def test_plan_is_exact(self):
  for change in ('extra','window','policy','digest','chain'):
   p=copy.deepcopy(self.plan)
   if change=='extra':p['mint']='1'
   if change=='window':p['window_blocks']='10'
   if change=='policy':p['policy']='central-evidence-window-v2'
   if change=='digest':p['evidence_digest']='E'*64
   if change=='chain':p['chain_id']='other'
   with self.subTest(change=change),self.assertRaises(ValueError):m.validate(p)
 def test_activation_record_is_strict(self):
  r={'central_evidence_activation':dict(policy=m.POLICY,window_blocks='129600',height='101',approved_by=m.GUARDIAN,evidence_digest='e'*64)}
  self.assertEqual(m.activation(r),dict(height=101,window_blocks=129600,evidence_digest='e'*64))
  for field,value in (('approved_by',A),('policy','x'),('extra','1')):
   bad=copy.deepcopy(r);bad['central_evidence_activation'][field]=value
   with self.subTest(field=field),self.assertRaises(ValueError):m.activation(bad)
 def test_send_once_then_finalized_by_exact_event(self):
  outer=self;journals={}
  class Runtime:
   broadcasts=0;event=None
   def read(self,sel):
    s=outer.state(events='21' if self.event else '20')
    for k in sel['keys']:
     if k.startswith('event/'):s['records'][k]=self.event if k==m.admission.event_key(21) else dict(id=k.split('/')[1].lstrip('0'),operation='other')
    if 'receipt' in sel:s['member']['sequence']='8';s['receipt']=dict(authority='native',finalized=True,chain_id=m.CHAIN,state_height=s['height'],app_hash=s['app_hash'],event=self.event)
    return s
   def broadcast(self,e):
    self.broadcasts+=1;c=e['command']
    self.event=dict(id='21',member=m.GUARDIAN,operation=c['operation'],subject=m.POLICY,command_digest=m.sha(m.native.signing_bytes(c)))
    return 0
  rt=Runtime();signer=lambda c:dict(command=c,public_key=m.PUBLIC,signature='s'*86)
  m.admission.verify_envelope=lambda p,e,c:None
  load=lambda p:journals.get(str(p));write=lambda p,v:journals.__setitem__(str(p),copy.deepcopy(v))
  out=m.process(self.plan,rt,load,write,signer,now=lambda:self.now)
  self.assertEqual(out['status'],'finalized');self.assertEqual(rt.broadcasts,1)
  again=m.process(self.plan,rt,load,write,signer,now=lambda:self.now)
  self.assertEqual(again['status'],'finalized');self.assertEqual(rt.broadcasts,1)
  # A different plan cannot reuse the journal.
  other=dict(self.plan,evidence_digest='f'*64)
  with self.assertRaises(ValueError):m.process(other,rt,load,write,signer,now=lambda:self.now)
 def test_expired_send_is_proved_then_retried_once(self):
  outer=self;journals={}
  class Runtime:
   broadcasts=0;height='100'
   def read(self,sel):
    s=outer.state(height=self.height)
    for k in sel['keys']:
     if k.startswith('event/'):s['records'][k]=dict(id=k.split('/')[1].lstrip('0'),operation='other')
    return s
   def broadcast(self,e):self.broadcasts+=1;return 5
  rt=Runtime();signer=lambda c:dict(command=c,public_key=m.PUBLIC,signature='s'*86)
  m.admission.verify_envelope=lambda p,e,c:None
  load=lambda p:journals.get(str(p));write=lambda p,v:journals.__setitem__(str(p),copy.deepcopy(v))
  self.assertEqual(m.process(self.plan,rt,load,write,signer,now=lambda:self.now)['status'],'pending')
  rt.height='201'
  self.assertEqual(m.process(self.plan,rt,load,write,signer,now=lambda:self.now)['status'],'expired_not_included')
  rt.height='202'
  self.assertEqual(m.process(self.plan,rt,load,write,signer,now=lambda:self.now)['status'],'pending')
  self.assertEqual(rt.broadcasts,2)
  self.assertTrue(any(k.endswith('activate.expired-1.json') for k in journals))

if __name__=='__main__':unittest.main()

import copy,datetime,importlib.util,unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location('karma_launch',Path(__file__).with_name('karma_launch.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
A='uain1'+'a'*40;B='uain1'+'b'*40

class KarmaLaunchTest(unittest.TestCase):
 def setUp(self):
  self.now=1794268800
  self.plan=dict(schema='uain-karma-launch-v1',chain_id=m.CHAIN,genesis_sha256=m.GENESIS,policy=m.POLICY,evidence_digest='e'*64,
   backfill=[dict(submission='CS-1',role='solver'),dict(submission='CS-1',role='reviewer')],convert=[dict(entry='00000000000000000007')])
  self.records={'guardians':[m.GUARDIAN],'guardian_epoch_current':None,'karma_policy_activation':None,
   'central_award/solver/CS-1':dict(submission='CS-1',task='T',project='P',member=A,role='solver',amount='10000000',height='50'),
   'central_award/reviewer/CS-1':dict(submission='CS-1',task='T',project='P',member=B,role='reviewer',amount='1000000',height='50'),
   'karma_backfill/central/solver/CS-1':None,'karma_backfill/central/reviewer/CS-1':None,
   'karma/00000000000000000007':dict(id='00000000000000000007',event_id='9',member=A,delta=-2,kind='no_effort',ref='x',at='t'),
   'karma_backfill/penalty/00000000000000000007':None}
 def state(self,height='100',sequence='7',events='20'):
  return dict(chain_id=m.CHAIN,height=height,header_time=datetime.datetime.fromtimestamp(self.now,datetime.timezone.utc).isoformat(),event_count=events,app_hash='b'*64,
   member=dict(id=m.GUARDIAN,public_key=m.PUBLIC,licence='active',sequence=sequence),records=copy.deepcopy(self.records))
 def activate(self,height='60'):self.records['karma_policy_activation']=dict(policy=m.POLICY,height=height,approved_by=m.GUARDIAN,evidence_digest='e'*64)

 def test_activation_is_fixed(self):
  c=m.command(self.plan,self.state(),'activate',now=self.now)
  self.assertEqual((c['member'],c['operation'],c['sequence'],c['expires_height']),(m.GUARDIAN,'karma_policy_activate','7','200'))
  self.assertEqual(c['payload'],dict(policy=m.POLICY,evidence_digest='e'*64))
 def test_activation_refused_twice_or_after_guardian_handover(self):
  for change in ('active','epoch','second_guardian','stale','unlicensed'):
   self.setUp()
   if change=='active':self.activate()
   if change=='epoch':self.records['guardian_epoch_current']={'epoch':1}
   if change=='second_guardian':self.records['guardians']=[m.GUARDIAN,A]
   s=self.state()
   if change=='stale':s['header_time']='2020-01-01T00:00:00+00:00'
   if change=='unlicensed':s['member']['licence']='revoked'
   with self.subTest(change=change),self.assertRaises(ValueError):m.command(self.plan,s,'activate',now=self.now)
 def test_backfill_needs_activation_and_a_pre_activation_award(self):
  item=self.plan['backfill'][0]
  with self.assertRaises(ValueError):m.command(self.plan,self.state(),'backfill',item,now=self.now)
  self.activate('60')
  with self.assertRaises(ValueError):m.command(self.plan,self.state(height='59'),'backfill',item,now=self.now)
  c=m.command(self.plan,self.state(),'backfill',item,now=self.now)
  self.assertEqual((c['operation'],c['payload']),('karma_central_backfill',dict(submission='CS-1',role='solver')))
  self.records['central_award/solver/CS-1']['height']='60'
  with self.assertRaises(ValueError):m.command(self.plan,self.state(),'backfill',item,now=self.now)
 def test_backfill_refuses_done_unplanned_or_mismatched(self):
  self.activate();item=self.plan['backfill'][0]
  for change in ('marker','unplanned','missing','role'):
   r=copy.deepcopy(self.records);it=dict(item)
   if change=='marker':self.records['karma_backfill/central/solver/CS-1']={'kind':'central_award'}
   if change=='unplanned':it=dict(submission='CS-2',role='solver');self.records['central_award/solver/CS-2']=None;self.records['karma_backfill/central/solver/CS-2']=None
   if change=='missing':self.records['central_award/solver/CS-1']=None
   if change=='role':self.records['central_award/solver/CS-1']['role']='reviewer'
   with self.subTest(change=change),self.assertRaises(ValueError):m.command(self.plan,self.state(),'backfill',it,now=self.now)
   self.records=r
 def test_convert_only_negative_rows(self):
  self.activate();item=self.plan['convert'][0]
  c=m.command(self.plan,self.state(),'convert',item,now=self.now)
  self.assertEqual((c['operation'],c['payload']),('karma_penalty_convert',dict(entry='00000000000000000007')))
  for delta in (0,3,True):
   self.records['karma/00000000000000000007']['delta']=delta
   with self.subTest(delta=delta),self.assertRaises(ValueError):m.command(self.plan,self.state(),'convert',item,now=self.now)
 def test_plan_is_exact(self):
  for change in ('extra','dupe','role','entry','policy'):
   p=copy.deepcopy(self.plan)
   if change=='extra':p['mint']='1'
   if change=='dupe':p['backfill'].append(dict(submission='CS-1',role='solver'))
   if change=='role':p['backfill'][0]['role']='author'
   if change=='entry':p['convert'][0]['entry']='7'
   if change=='policy':p['policy']='uain-karma-v1'
   with self.subTest(change=change),self.assertRaises(ValueError):m.validate(p)
 def test_activation_digest_ignores_backfill_lists(self):
  p=copy.deepcopy(self.plan);p['backfill']=[]
  self.assertEqual(m.stage_digest(p,'activate'),m.stage_digest(self.plan,'activate'))
  self.assertNotEqual(m.stage_digest(p,'backfill'),m.stage_digest(self.plan,'backfill'))
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
    self.event=dict(id='21',member=m.GUARDIAN,operation=c['operation'],subject=m.subject(c),command_digest=m.sha(m.native.signing_bytes(c)))
    return 0
  rt=Runtime();signer=lambda c:dict(command=c,public_key=m.PUBLIC,signature='s'*86)
  m.admission.verify_envelope=lambda p,e,c:None
  out=m.process(self.plan,'activate',None,rt,lambda p:journals.get(str(p)),lambda p,v:journals.__setitem__(str(p),copy.deepcopy(v)),signer,now=lambda:self.now)
  self.assertEqual(out['status'],'finalized');self.assertEqual(rt.broadcasts,1)
  again=m.process(self.plan,'activate',None,rt,lambda p:journals.get(str(p)),lambda p,v:journals.__setitem__(str(p),copy.deepcopy(v)),signer,now=lambda:self.now)
  self.assertEqual(again['status'],'finalized');self.assertEqual(rt.broadcasts,1)
 def test_inventory_lists_pre_activation_awards_and_negative_rows(self):
  self.activate('60')
  extra={'event_count':'3','karma_count':2,
   'event/00000000000000000001':dict(id='1',operation='central_review',subject='CS-1'),
   'event/00000000000000000002':dict(id='2',operation='central_review',subject='CS-2'),
   'event/00000000000000000003':dict(id='3',operation='open_project',subject='P'),
   'central_award/solver/CS-2':None,'central_award/reviewer/CS-2':dict(submission='CS-2',role='reviewer',member=B,amount='1000000',height='61'),
   'karma/00000000000000000001':dict(id='00000000000000000001',delta=40),'karma/00000000000000000002':dict(id='00000000000000000002',delta=-2)}
  def read(ks):
   s=self.state(events='3');s['records'].update(extra);s['records']={k:s['records'].get(k) for k in ks};return s
  out=m.inventory(read)
  self.assertEqual(out['backfill'],[dict(submission='CS-1',role='solver'),dict(submission='CS-1',role='reviewer')])
  self.assertEqual((out['backfill_karma'],out['awards_after_activation']),(11,1))
  self.assertEqual((out['convert'],out['convert_karma']),([dict(entry='00000000000000000002')],2))

if __name__=='__main__':unittest.main()

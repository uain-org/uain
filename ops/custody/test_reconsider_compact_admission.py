"""Fictional transport/custody; the fixed public enrolment is never submitted."""
import copy,json,tempfile,unittest
from pathlib import Path
from unittest.mock import Mock,patch
import native_admission as a
import reconsider_compact_admission as r
import test_native_admission as fixtures

class ReconsiderTests(unittest.TestCase):
 def fixture(self):
  p,_,s=fixtures.AdmissionTests().fixture();p.update(chain_id=r.CHAIN,genesis_sha256=r.GENESIS)
  s.update(chain_id=r.CHAIN,height='1214900',event_count='481')
  metadata=dict(id=r.MEMBER,name='Public fixture member',operator='Public fixture operator',family='')
  raw=('{'+','.join(a.native.canonical(k)+':'+a.native.canonical(metadata[k]) for k in ('id','name','operator','family'))+'}').encode()
  digest=a.digest(raw)
  target=dict(id=r.MEMBER,public_key='n8aDc_PddRR4Dv8sH4YRggngEjdyKtBe5XSaJIChiUg',name='',operator='',family='',account_policy='compact-account-v1',metadata_digest=digest,licence='pending',sequence='1',karma=0,credits='0',active_projects=0,creator=False,default_verifier=False)
  s['records']={'guardians':[p['guardian']],'guardian_epoch_current':None,a.event_key(481):copy.deepcopy(r.EVENT),'member/'+r.MEMBER:target,'member_metadata/'+r.MEMBER:metadata}
  refusal=dict(schema='uain-native-admission-refusal-v1',policy_sha256=a.digest(a.canonical(p)),enrol_event=copy.deepcopy(r.EVENT),reason='role-or-account-override',proved_context=dict(chain_id=r.CHAIN,height='1214882',event_count='481',member=copy.deepcopy(target)))
  return p,s,refusal,digest
 def execute(self,callback):
  p,s,refusal,digest=self.fixture()
  with tempfile.TemporaryDirectory() as root:
   directory=Path(root)/'481';directory.mkdir();original=json.dumps(refusal).encode();(directory/'refused.json').write_bytes(original)
   cursor=Path(root)/'cursor.json';cursor.write_bytes(b'unchanged cursor481')
   other=Path(root)/'469';other.mkdir();(other/'journal.json').write_bytes(b'untouched signed history')
   # Only filesystem/secret-free proof transport is substituted. Screening,
   # process journals, uncertainty and signing-scope checks remain real.
   with patch.object(r,'METADATA',digest),patch.object(r,'HELPER_SHA',a.digest(b'candidate')),patch.object(a.native,'protected_read',side_effect=lambda path,*_:b'candidate' if Path(path)==Path(a.__file__) else Path(path).read_bytes()),patch.object(a,'load',side_effect=lambda path:json.loads(Path(path).read_bytes())):
    callback(p,s,refusal,directory)
   self.assertEqual((directory/'refused.json').read_bytes(),original)
   self.assertEqual(cursor.read_bytes(),b'unchanged cursor481')
   self.assertEqual((other/'journal.json').read_bytes(),b'untouched signed history')
 def test_uncertain_resume_never_duplicates_sign_or_send(self):
  def check(p,s,refusal,d):
   runtime=Mock();runtime.read.side_effect=lambda *_:copy.deepcopy(s);runtime.broadcast.side_effect=TimeoutError('fictional lost reply')
   def sign(_,policy,event,state):
    evidence,command=a.screen(policy,event,state);return evidence,dict(command=command,public_key=p['guardian_public_key'],signature='synthetic-signature')
   signer=Mock(side_effect=sign)
   with patch.object(a,'sign_guardian',signer),patch.object(a,'verify_envelope'):
    self.assertEqual(r.run(None,p,d,runtime)['status'],'uncertain')
    attempt=(d/'attempt-1.json').read_bytes();audit=(d/'reconsideration.json').read_bytes()
    self.assertEqual(r.run(None,p,d,runtime)['status'],'pending_finality')
    self.assertEqual(signer.call_count,1);self.assertEqual(runtime.broadcast.call_count,1)
    self.assertEqual((d/'attempt-1.json').read_bytes(),attempt);self.assertEqual((d/'reconsideration.json').read_bytes(),audit)
  self.execute(check)
 def test_ended_licence_standing_roles_metadata_or_event_reject_before_custody(self):
  mutations=[lambda s:s['records']['member/'+r.MEMBER].update(licence='revoked'),lambda s:s['records']['member/'+r.MEMBER].update(licence='withdrawn'),lambda s:s['records']['member/'+r.MEMBER].update(karma=1),lambda s:s['records']['member/'+r.MEMBER].update(creator=True),lambda s:s['records']['member/'+r.MEMBER].update(sequence='2'),lambda s:s['records']['member_metadata/'+r.MEMBER].update(name='forged'),lambda s:s['records'][a.event_key(481)].update(command_digest='0'*64)]
  for mutate in mutations:
   def check(p,s,refusal,d):
    mutate(s);runtime=Mock();runtime.read.return_value=s
    with patch.object(a,'process_enrol') as process,self.assertRaises(ValueError):r.run(None,p,d,runtime)
    process.assert_not_called();self.assertFalse((d/'reconsideration.json').exists())
   with self.subTest(mutation=mutate):self.execute(check)
 def test_mismatched_refusal_audit_and_unexplained_journal_reject(self):
  for kind in ('refusal','audit','journal','helper'):
   def check(p,s,refusal,d):
    runtime=Mock();runtime.read.return_value=s
    if kind=='refusal':
     altered=copy.deepcopy(refusal);altered['reason']='licence-not-pending';(d/'refused.json').write_text(json.dumps(altered))
    if kind=='audit':(d/'reconsideration.json').write_text('{}')
    if kind=='journal':(d/'journal.json').write_text('{}')
    context=patch.object(r,'HELPER_SHA','0'*64) if kind=='helper' else patch.object(r,'HELPER_SHA',r.HELPER_SHA)
    with context,patch.object(a,'process_enrol') as process,self.assertRaises(ValueError):r.run(None,p,d,runtime)
    process.assert_not_called()
    if kind=='refusal':(d/'refused.json').write_bytes(json.dumps(refusal).encode())
   with self.subTest(kind=kind):self.execute(check)
 def test_active_without_journal_cannot_fabricate_acceptance(self):
  def check(p,s,refusal,d):
   s['records']['member/'+r.MEMBER]['licence']='active';runtime=Mock();runtime.read.return_value=s
   with patch.object(a,'process_enrol') as process,self.assertRaises(ValueError):r.run(None,p,d,runtime)
   process.assert_not_called()
  self.execute(check)
 def test_retained_uncertain_send_requires_exact_finalized_receipt(self):
  def check(p,s,refusal,d):
   def read(selection):
    state=copy.deepcopy(s)
    if 'receipt' in selection:state['receipt']=dict(finalized=True,event=state['records'][a.event_key(482)])
    return state
   runtime=Mock();runtime.read.side_effect=read;runtime.broadcast.side_effect=TimeoutError('fictional')
   def sign(_,policy,event,state):
    evidence,command=a.screen(policy,event,state);return evidence,dict(command=command,public_key=p['guardian_public_key'],signature='synthetic-signature')
   with patch.object(a,'sign_guardian',side_effect=sign) as signer,patch.object(a,'verify_envelope'):
    self.assertEqual(r.run(None,p,d,runtime)['status'],'uncertain')
    command=json.loads((d/'journal.json').read_bytes())['envelope']['command']
    s.update(height='1214901',event_count='482');s['member']['sequence']='8';s['records']['member/'+r.MEMBER]['licence']='active'
    s['records'][a.event_key(482)]=dict(id='482',height='1214901',operation='licence',member=p['guardian'],subject=r.MEMBER,command_digest=a.digest(a.native.signing_bytes(command)))
    self.assertEqual(r.run(None,p,d,runtime)['status'],'finalized')
    self.assertEqual(r.run(None,p,d,runtime)['status'],'finalized')
    self.assertEqual(signer.call_count,1);self.assertEqual(runtime.broadcast.call_count,1)
  self.execute(check)
 def test_refusal_byte_change_after_audit_cannot_resume(self):
  def check(p,s,refusal,d):
   runtime=Mock();runtime.read.return_value=s
   with patch.object(a,'process_enrol',return_value=dict(done=False,status='pending_finality')):
    r.run(None,p,d,runtime)
   before=(d/'refused.json').read_bytes();(d/'refused.json').write_bytes(before+b'\n')
   with patch.object(a,'process_enrol') as process,self.assertRaises(ValueError):r.run(None,p,d,runtime)
   process.assert_not_called();(d/'refused.json').write_bytes(before)
  self.execute(check)
 def test_policy_or_genesis_changes_refuse_before_native_or_custody(self):
  for field in ('chain_id','genesis_sha256'):
   def check(p,s,refusal,d):
    p[field]='uain-wrong' if field=='chain_id' else '0'*64;runtime=Mock()
    with self.assertRaises(ValueError):r.run(None,p,d,runtime)
    runtime.read.assert_not_called()
   with self.subTest(field=field):self.execute(check)

if __name__=='__main__':unittest.main()

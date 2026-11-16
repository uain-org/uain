"""Fictional isolated custody protocol tests. No production keys/endpoints."""
import base64,copy,datetime,json,os,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
import private_payment_service as s

class ServiceTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='fictional-private-service-');self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve();self.job='1'*32;self.directory=self.root/self.job;self.directory.mkdir();self.key=bytes(range(32));self.calls=[]
  self.addCleanup(patch.stopall);patch.object(s,'ROOT',self.root).start();patch.object(s.native,'protected_read',lambda p,limit=0:Path(p).read_bytes()).start()
  self.context=dict(version=1,chain=s.CHAIN,expires='200',licenceRevision='0',effects='a'*64,purpose='b'*64,reviewer=s.decode(s.REVIEWER_PUBLIC,32).hex())
  self.report=dict(schema='baink-private-service-inspection-v1',jobId=self.job,inspectionDigest='c'*64,inspection=dict(privateMemo='Fictional confidential compute purpose'),proof=dict(height='100'))
 def invoke(self,custody,p,action,job,**values):
  self.calls.append(action)
  if action=='certificate':return dict(certificate=dict(context=self.context,signature='fictional-public-certificate'),encryptionPrivateKey='fictional-private-x25519-key')
  if action=='inspect':return dict(report=self.report)
  if action=='attest':return dict(decision=dict(classification='neutral'))
  if action=='finalize':return dict(approval=dict(effects='a'*64),reviewerBinding=dict(signature='fictional-public-binding'))
  if action=='relay':return dict(envelope=dict(command=dict(operation='private_payment',sequence='7'),signature='fictional-public-envelope'))
  if action=='reconcile':return dict(status='recorded',effects='a'*64,height='101',transactionHash=s.sha(json.dumps(values['envelope'],separators=(',',':')).encode()).upper(),transactionInclusionVerified=False,paid=False)
  self.fail(action)
 def process(self,action,body=None,invoke=None):
  fn=invoke or self.invoke;return s.process(None,{},action,self.job,body,self.directory,self.key,invoke=fn,reconcile=lambda envelope:fn(None,{},'reconcile',self.job,envelope=envelope))
 def prepare(self):
  self.process('create',dict(context=self.context));certificate=self.process('certificate')['certificate'];self.process('ingest',dict(envelope=dict(certificate=certificate,ciphertext='fictional-ciphertext'),agreedInvoice=None));self.process('inspect')
 def finalized(self):
  self.prepare();self.process('attest',dict(attestation=dict(fictional='strict verification belongs to real worker tests'),request='fictional-request',response='fictional-response'));return self.process('finalize')
 def relay_body(self):return dict(result=dict(operation='private_payment',payload=dict(bundle='fictional-public-bundle',approval=dict(effects='a'*64))),reviewerBinding=dict(signature='fictional-public-binding'))
 def test_aead_binds_job_artifact_name_key_and_ciphertext(self):
  sealed=s.seal(self.key,self.job,'input',dict(secret='fixture-private'));self.assertEqual(s.unseal(self.key,self.job,'input',sealed),dict(secret='fixture-private'))
  for key,job,name in [(bytes(reversed(self.key)),self.job,'input'),(self.key,'2'*32,'input'),(self.key,self.job,'report')]:
   with self.assertRaises(Exception):s.unseal(key,job,name,sealed)
  altered=copy.deepcopy(sealed);raw=bytearray(base64.b64decode(altered['ciphertext']));raw[0]^=1;altered['ciphertext']=base64.b64encode(raw).decode()
  with self.assertRaises(Exception):s.unseal(self.key,self.job,'input',altered)
 def test_certificate_context_is_exact_and_bounded_before_any_custody_signature(self):
  for changed in [dict(self.context,extra='unbound'),dict(self.context,version=True),dict(self.context,expires='0'),dict(self.context,expires=str(2**63)),dict(self.context,effects='bad')]:
   with self.assertRaises(ValueError):self.process('create',dict(context=changed))
  self.assertEqual(list(self.directory.iterdir()),[]);self.assertEqual(self.calls,[])
 def test_inspection_refuses_an_expiry_beyond_720_blocks_of_the_proved_height(self):
  self.context=dict(self.context,expires='821')
  with self.assertRaises(ValueError):self.prepare()
  self.assertFalse((self.directory/'report.sealed.json').exists());self.assertNotIn('attest',self.calls)
  self.assertEqual(list((self.root/'invoices').glob('*')) if (self.root/'invoices').exists() else [],[])
 def test_health_is_read_only_fixed_zero_job_and_needs_no_job_context(self):
  calls=[]
  def health(custody,p,action,job,**values):calls.append((action,job));return dict(status='ready',height='100',privateActive=True,coinActive=True)
  value=s.process(None,{},'health','0'*32,None,self.directory,self.key,invoke=health);self.assertEqual(value['status'],'ready');self.assertEqual(calls,[('health','0'*32)]);self.assertEqual(list(self.directory.iterdir()),[])
  with self.assertRaises(ValueError):self.process('health',invoke=health)
 def test_private_material_is_sealed_and_repeated_certificate_never_resigns(self):
  self.prepare();self.process('certificate');self.assertEqual(self.calls.count('certificate'),1);self.assertEqual(self.process('report'),self.report)
  for path in self.directory.glob('*.json'):
   text=path.read_text();self.assertNotIn('fictional-private-x25519-key',text);self.assertNotIn('Fictional confidential compute purpose',text)
 def test_changed_context_ingress_report_or_audit_is_not_silently_replaced(self):
  self.prepare()
  with self.assertRaises(Exception):self.process('create',dict(context=dict(self.context,purpose='d'*64)))
  with self.assertRaises(Exception):self.process('ingest',dict(envelope=dict(certificate=dict(context=self.context),ciphertext='different'),agreedInvoice=None))
  with self.assertRaises(Exception):s.sealed_write(self.directory,self.key,self.job,'report',dict(different=True))
 def test_certificate_uncertainty_never_regenerates_encryption_or_signature(self):
  self.process('create',dict(context=self.context))
  def failure(*args,**kwargs):raise RuntimeError('fictional custody interruption')
  with self.assertRaises(RuntimeError):self.process('certificate',invoke=failure)
  with self.assertRaises(ValueError):self.process('certificate')
  self.assertEqual(self.calls,[])
 def test_finalize_requires_audit_and_retains_once_marker_on_worker_refusal(self):
  self.prepare()
  with self.assertRaises(Exception):self.process('finalize')
  self.process('attest',dict(attestation={},request='request',response='response'))
  def failure(*args,**kwargs):raise RuntimeError('fictional model refusal')
  with self.assertRaises(RuntimeError):self.process('finalize',invoke=failure)
  with self.assertRaises(ValueError):self.process('finalize')
 def test_finalized_outputs_retained_exactly_without_new_review_signatures(self):
  first=self.finalized();self.assertEqual(self.process('finalize'),first);self.assertEqual(self.calls.count('finalize'),1)
 def test_relay_retains_original_signature_and_refuses_changed_or_second_inflight_job(self):
  self.finalized();first=self.process('relay',self.relay_body());repeated=self.process('relay',self.relay_body());self.assertEqual(repeated,first);self.assertEqual(json.dumps(first),json.dumps(repeated));self.assertEqual(self.calls.count('relay'),1)
  changed=self.relay_body();changed['result']['payload']['bundle']='different'
  with self.assertRaises(ValueError):self.process('relay',changed)
  old=self.job;self.job='2'*32;self.directory=self.root/self.job;self.directory.mkdir();self.report=dict(self.report,jobId=self.job);self.finalized()
  with self.assertRaises(ValueError):self.process('relay',self.relay_body())
  self.job=old
 def test_reconcile_uncertainty_cannot_clear_inflight_or_announce_paid(self):
  self.finalized();self.process('relay',self.relay_body())
  def unknown(*args,**kwargs):raise RuntimeError('fictional missing exact record')
  self.assertEqual(self.process('reconcile',invoke=unknown)['status'],'unknown');self.assertTrue((self.root/'relay-inflight.json').exists())
  result=self.process('reconcile');self.assertEqual(result['status'],'recorded');self.assertFalse(result['paid']);self.assertFalse((self.root/'relay-inflight.json').exists())
 def test_terminal_reconciliation_retains_first_proof_across_tips_and_preserves_next_jobs_inflight(self):
  self.finalized();self.process('relay',self.relay_body());first=self.process('reconcile');count=self.calls.count('reconcile');s.write_once(self.root/'relay-inflight.json',dict(jobId='2'*32,requestDigest='d'*64))
  second=self.process('reconcile');self.assertEqual(second,first);self.assertEqual(self.calls.count('reconcile'),count);self.assertEqual(s.load(self.root/'relay-inflight.json')['jobId'],'2'*32)
 def test_terminal_proof_persisted_before_global_release_recovers_its_own_marker(self):
  self.finalized();self.process('relay',self.relay_body());value=self.invoke(None,{},'reconcile',self.job,envelope=s.load(self.directory/'relay.json')['envelope']);s.write_once(self.directory/'relay-recorded.json',value)
  self.assertTrue((self.root/'relay-inflight.json').exists());self.assertEqual(self.process('reconcile'),value);self.assertFalse((self.root/'relay-inflight.json').exists())
 def test_fixed_policy_refuses_changed_binary_genesis_rpc_or_extra_source(self):
  manifest={name:'a'*64 for name in s.SOURCE_FILES};p=dict(schema='baink-private-payment-service-policy-v1',source='/opt/uain-private-payment-service/releases/'+s.sha(s.bytes_json(manifest)),source_sha256=manifest,node=s.NODE,node_sha256='b'*64,reader=dict(executable='/tools/private-state',executableSha256=s.PINS['private-state'],genesis='/tools/genesis',genesisSha256=s.GENESIS,rpc='http://127.0.0.1:26667',maxAgeSeconds=120),tools=dict(coinWallet=dict(executable='/tools/coin',executableSha256=s.PINS['coin-wallet']),privateWallet=dict(executable='/tools/private',executableSha256=s.PINS['private-wallet'])),decisionPublicKey=base64.urlsafe_b64encode(bytes(range(32))).decode().rstrip('='))
  self.assertEqual(s.validate_policy(p,False)['reviewer'],s.REVIEWER)
  for field,value in [('rpc','https://hosted.example'),('genesisSha256','0'*64),('executableSha256','0'*64)]:
   changed=copy.deepcopy(p);changed['reader'][field]=value
   with self.assertRaises(ValueError):s.validate_policy(changed,False)
  changed=copy.deepcopy(p);changed['source_sha256']['unexpected.mjs']='0'*64
  with self.assertRaises(ValueError):s.validate_policy(changed,False)

class SourceClosureTests(unittest.TestCase):
 """The release ships SOURCE_FILES only, so every relative import the custody
 worker loads must be one of them (10 Nov 2026: native-payments.mjs imports
 native-pilot-sequence.mjs, which the list lacked)."""
 def test_source_files_close_over_their_relative_imports(self):
  import posixpath,re as rx
  repo=Path(__file__).resolve().parents[2];seen=set()
  for name in sorted(s.SOURCE_FILES):
   text=(repo/name).read_text()
   for target in rx.findall(r"""(?:^|[\n;])\s*(?:import|export)\b[^'"\n]*?from\s*['"](\.{1,2}/[^'"]+)['"]""",text):
    resolved=posixpath.normpath(posixpath.join(posixpath.dirname(name),target));seen.add(resolved)
    self.assertIn(resolved,s.SOURCE_FILES,f'{name} imports {resolved}, which the custody release would not ship')
  self.assertIn('apps/baink/server/native-pilot-sequence.mjs',seen)
 def test_dispatcher_pins_this_service(self):
  import hashlib,public_review_dispatch as d
  self.assertEqual(d.SERVICE_SHA,hashlib.sha256(Path(s.__file__).read_bytes()).hexdigest())

class PublicReconcileTests(unittest.TestCase):
 def setUp(self):
  seed=bytes(range(32));public,sign=s.native.ed25519(seed);self.public=base64.urlsafe_b64encode(public).decode().rstrip('=');self.member='uain1'+s.sha(public)[:40];self.addCleanup(patch.stopall);patch.object(s,'RELAY',self.member).start()
  command=dict(version=1,chain_id=s.CHAIN,member=self.member,sequence='7',expires_height='200',operation='private_payment',payload=dict(bundle='AQ',approval=dict(effects='a'*64)))
  self.envelope=dict(command=command,public_key=self.public,signature=base64.urlsafe_b64encode(sign(s.native.signing_bytes(command))).decode().rstrip('='))
  self.state=dict(chain_id=s.CHAIN,app_hash='b'*64,height='201',header_time=datetime.datetime.now(datetime.timezone.utc).isoformat(),member=dict(sequence='7'),records={'member/'+self.member:dict(id=self.member,public_key=self.public,sequence='7'),'private_payment/'+'a'*64:None})
 def read(self,selection):self.assertEqual(selection,dict(member=self.member,keys=['private_payment/'+'a'*64,'member/'+self.member]));return self.state
 def test_expired_unused_requires_exact_proven_absence_fresh_height_and_unchanged_nonce(self):
  self.assertEqual(s.public_reconcile(self.envelope,runtime=SimpleNamespace(read=self.read))['status'],'expired-unused')
  self.state['height']='200'
  with self.assertRaises(ValueError):s.public_reconcile(self.envelope,runtime=SimpleNamespace(read=self.read))
  self.state['height']='201';self.state['member']['sequence']='8';self.state['records']['member/'+self.member]['sequence']='8'
  with self.assertRaises(ValueError):s.public_reconcile(self.envelope,runtime=SimpleNamespace(read=self.read))
 def test_recorded_requires_original_ciphertext_and_advanced_relay_sequence(self):
  self.state['member']['sequence']='8';self.state['records']['member/'+self.member]['sequence']='8';self.state['records']['private_payment/'+'a'*64]=dict(bundle='AQ',height='150')
  self.assertEqual(s.public_reconcile(self.envelope,runtime=SimpleNamespace(read=self.read))['status'],'recorded')
  self.state['records']['private_payment/'+'a'*64]['bundle']='Ag'
  with self.assertRaises(ValueError):s.public_reconcile(self.envelope,runtime=SimpleNamespace(read=self.read))
 def test_stale_header_or_unproved_rpc_error_never_counts_as_absence(self):
  self.state['header_time']=(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(seconds=121)).isoformat()
  with self.assertRaises(ValueError):s.public_reconcile(self.envelope,runtime=SimpleNamespace(read=self.read))
  def failed(_):raise RuntimeError('fictional RPC error')
  with self.assertRaises(RuntimeError):s.public_reconcile(self.envelope,runtime=SimpleNamespace(read=failed))

class InvoiceClaimTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='fictional-invoice-index-');self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve();self.key=bytes(range(32));self.addCleanup(patch.stopall);patch.object(s,'ROOT',self.root).start();patch.object(s.native,'protected_read',lambda p,limit=0:Path(p).read_bytes()).start()
  self.invoice=dict(schema='baink-private-invoice-v1',id='fictional-one-invoice',chainId=s.CHAIN,genesisSha256=s.GENESIS,payer='uain1'+'a'*40,payee='uain1'+'b'*40,amountUnits='26',requestDigest='c'*64)
 def report(self,job,effects='d'*64,expiry='200'):
  return dict(jobId=job,inspection=dict(invoice=copy.deepcopy(self.invoice),context=dict(chain=s.CHAIN,effects=effects,purpose='e'*64,expires=expiry)))
 def directory(self,job):
  path=self.root/job;path.mkdir(mode=0o700,exist_ok=True);return path
 def claim(self,job,effects='d'*64,expiry='200',presence=None):
  return s.invoice_claim(self.directory(job),self.key,job,self.report(job,effects,expiry),presence=presence or (lambda *_:self.fail('First/same-job claim must not ask for reuse')))
 def proof(self,recorded=False,expired=False,height='190'):
  return dict(recorded=recorded,expiredAbsent=expired,proof=dict(chainId=s.CHAIN,genesisSha256=s.GENESIS,height=height,appHash='f'*64,headerTime=datetime.datetime.now(datetime.timezone.utc).isoformat(),recordPresent=recorded))
 def index(self):
  files=list((self.root/'invoices').glob('*.sealed.json'));self.assertEqual(len(files),1);path=files[0];return path,s.unseal(self.key,'invoice-index',path.name.split('.')[0],s.load(path))
 def test_sealed_global_invoice_claim_is_idempotent_and_prevents_second_root_job_before_expiry(self):
  a='1'*32;b='2'*32;self.claim(a);path,first=self.index();self.claim(a);self.assertEqual(self.index()[1],first)
  with self.assertRaises(ValueError):self.claim(b,effects='9'*64,presence=lambda *_:self.proof())
  self.assertEqual(self.index()[1]['jobId'],a);self.assertEqual(list(self.directory(b).iterdir()),[])
  self.assertRegex(path.name,r'^[a-f0-9]{64}\.sealed\.json$')
  for path in self.root.rglob('*.json'):
   raw=path.read_text();self.assertNotIn(self.invoice['id'],raw);self.assertNotIn(self.invoice['payer'],raw)
 def test_refused_or_unrelayed_job_still_blocks_reuse_until_proven_native_expiry(self):
  a='1'*32;b='2'*32;self.claim(a)
  # No finalization, relay or acceptance file exists: absence of those files
  # is NOT evidence that an already consented private approval cannot appear.
  self.assertFalse((self.directory(a)/'finalized.json').exists())
  with self.assertRaises(ValueError):self.claim(b,effects='9'*64,presence=lambda *_:self.proof(expired=False,height='200'))
 def test_expired_absent_claim_moves_only_to_new_effects_and_keeps_original_history(self):
  a='1'*32;b='2'*32;self.claim(a);history=(self.directory(a)/'invoice-claim.sealed.json').read_bytes()
  with self.assertRaises(ValueError):self.claim(b,presence=lambda *_:self.proof(expired=True,height='201'))
  self.claim(b,effects='9'*64,expiry='300',presence=lambda *_:self.proof(expired=True,height='201'));path,index=self.index();self.assertEqual(index['jobId'],b);self.assertEqual(index['previousJob'],a);self.assertEqual((self.directory(a)/'invoice-claim.sealed.json').read_bytes(),history);self.claim(b,effects='9'*64,expiry='300');self.assertEqual(self.index()[1],index)
  with self.assertRaises(ValueError):self.claim(a,presence=lambda *_:self.proof(expired=True,height='301'))
 def test_recorded_invoice_is_permanently_retained_across_jobs_even_after_expiry(self):
  self.claim('1'*32)
  with self.assertRaises(ValueError):self.claim('2'*32,effects='9'*64,presence=lambda *_:self.proof(recorded=True,height='300'))
  self.assertTrue(self.index()[1]['recorded'])
  with self.assertRaises(ValueError):self.claim('3'*32,effects='8'*64,presence=lambda *_:self.fail('A recorded invoice cannot be released by another proof'))
 def test_changed_invoice_or_rpc_failure_cannot_replace_a_claim(self):
  self.claim('1'*32);path,index=self.index();original=path.read_bytes();self.invoice['amountUnits']='27'
  with self.assertRaises(ValueError):self.claim('2'*32,effects='9'*64,presence=lambda *_:self.proof(expired=True,height='301'))
  self.invoice['amountUnits']='26'
  def failed(*_):raise RuntimeError('Fictional RPC unavailable, never an absence proof')
  with self.assertRaises(RuntimeError):self.claim('2'*32,effects='9'*64,presence=failed)
  self.assertEqual(path.read_bytes(),original)
 def test_expiry_replacement_recovers_from_history_written_before_index_replacement(self):
  a='1'*32;b='2'*32;self.claim(a);old=s.admission.atomic
  def failed(*_):raise RuntimeError('Fictional interruption before global index replacement')
  with patch.object(s.admission,'atomic',failed):
   with self.assertRaises(RuntimeError):self.claim(b,effects='9'*64,expiry='300',presence=lambda *_:self.proof(expired=True,height='201'))
  self.claim(b,effects='9'*64,expiry='300',presence=lambda *_:self.proof(expired=True,height='202'));self.assertEqual(self.index()[1]['jobId'],b)
 def test_public_membership_and_absence_require_exact_selection_and_fresh_native_height(self):
  effect='d'*64;state=dict(chain_id=s.CHAIN,app_hash='f'*64,height='201',header_time=datetime.datetime.now(datetime.timezone.utc).isoformat(),records={'private_payment/'+effect:None})
  def read(selection):self.assertEqual(selection,dict(keys=['private_payment/'+effect]));return state
  self.assertTrue(s.payment_presence(effect,'200',runtime=SimpleNamespace(read=read))['expiredAbsent']);state['height']='200';self.assertFalse(s.payment_presence(effect,'200',runtime=SimpleNamespace(read=read))['expiredAbsent'])
  state['height']='201';state['records']['private_payment/'+effect]=dict(bundle='AQ',height='150');self.assertTrue(s.payment_presence(effect,'200',runtime=SimpleNamespace(read=read))['recorded'])
  state['header_time']=(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(seconds=121)).isoformat()
  with self.assertRaises(ValueError):s.payment_presence(effect,'200',runtime=SimpleNamespace(read=read))


class ServerSendTests(unittest.TestCase):
 """Fictional no-install send jobs: no certificate, AI attestation before the one approval."""
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='fictional-server-send-');self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve();self.key=bytes(range(32));self.calls=[]
  self.addCleanup(patch.stopall);patch.object(s,'ROOT',self.root).start();patch.object(s.native,'protected_read',lambda p,limit=0:Path(p).read_bytes()).start()
  self.intent=dict(schema='baink-send-intent-v1',chainId=s.CHAIN,genesisSha256=s.GENESIS,fromAddress='fictional',**{'from':'uain1'+'a'*40,'to':'uain1'+'b'*40,'amountUnits':'5000000','memo':'fictional payment','recipientAddress':'c'*86})
  self.rules=dict(s.SEND_RULES_DEFAULT);self.now=1_800_000_000
  self.send=dict(packet=dict(one_time_viewing_key='fictional-one-time-key'),intent=self.intent,signature='fictional-intent-signature',publicKey='fictional-payer-key',registration=dict(address='fictional'))
  self.presence=lambda *_:self.fail('A first or same-job send claim needs no proof')
 def context(self,effects='a'*64,expires='200'):return dict(version=1,chain=s.CHAIN,expires=expires,licenceRevision='0',effects=effects,purpose='b'*64,reviewer=s.decode(s.REVIEWER_PUBLIC,32).hex())
 def directory(self,job):
  path=self.root/job;path.mkdir(mode=0o700,exist_ok=True);return path
 def act(self,job,action,body=None,context=None,presence=None):
  context=context or self.context()
  rules=self.rules
  def invoke(custody,p,kind,j,**values):
   self.calls.append(kind)
   if kind=='send-inspect':
    self.assertEqual(values['send'],self.send);self.assertEqual(values['context'],context)
    return dict(report=dict(schema='baink-private-service-inspection-v1',jobId=j,inspectionDigest='c'*64,inspection=dict(context=values['context'],invoice=None,operation='server_send'),proof=dict(height='100')))
   if kind=='attest':return dict(decision=dict(class_='neutral'))
   if kind=='send-finalize':
    self.finalize_values=values
    return dict(approval=dict(effects=values['context']['effects'],purpose_commitment=values['context']['purpose'],expires_height=values['context']['expires'],direction='shield',reviewer=s.REVIEWER,signature='fictional-public-approval'),reviewerBinding=None)
   self.fail(kind)
  return s.process(None,{},action,job,body,self.directory(job),self.key,invoke=invoke,send_presence=presence or self.presence,rules=lambda:rules,clock=lambda:self.now)
 def proof(self,recorded=False,expired=False,height='190'):
  return dict(recorded=recorded,expiredAbsent=expired,proof=dict(chainId=s.CHAIN,genesisSha256=s.GENESIS,height=height,appHash='f'*64,headerTime='2026-11-09T00:00:00Z',recordPresent=recorded))
 def approved(self,job,context=None,presence=None):
  context=context or self.context()
  self.act(job,'create',dict(context=context),context);self.act(job,'send-ingest',self.send,context);self.act(job,'inspect',None,context,presence)
  self.act(job,'attest',dict(attestation={},request='fictional-request',response='fictional-response'),context);return self.act(job,'finalize',None,context)
 def test_send_job_signs_once_only_after_attestation_and_never_uses_certificate_or_relay(self):
  job='1'*32;self.act(job,'create',dict(context=self.context()));self.act(job,'send-ingest',self.send)
  for action,body in [('certificate',None),('relay',dict(result={},reviewerBinding={})),('ingest',dict(envelope={},agreedInvoice=None))]:
   with self.assertRaises(ValueError):self.act(job,action,body)
  self.act(job,'inspect')
  with self.assertRaises(Exception):self.act(job,'finalize')
  self.act(job,'attest',dict(attestation={},request='fictional-request',response='fictional-response'));first=self.act(job,'finalize')
  self.assertEqual(first['reviewerBinding'],None);self.assertEqual(self.act(job,'finalize'),first);self.assertEqual(self.calls.count('send-finalize'),1)
  for path in self.root.rglob('*.json'):self.assertNotIn('fictional-one-time-key',path.read_text())
 def test_changed_send_evidence_is_not_silently_replaced(self):
  job='1'*32;self.act(job,'create',dict(context=self.context()));self.act(job,'send-ingest',self.send)
  with self.assertRaises(Exception):self.act(job,'send-ingest',dict(self.send,signature='different'))
  with self.assertRaises(ValueError):self.act(job,'send-ingest',dict(self.send,extra=True))
 def test_one_live_approval_per_intent_until_previous_attempt_proved_unrecorded_after_expiry(self):
  self.approved('1'*32)
  second=self.context(effects='9'*64,expires='300')
  with self.assertRaises(ValueError):self.approved('2'*32,second,presence=lambda *_:self.proof(expired=False,height='200'))
  self.assertEqual(self.calls.count('send-finalize'),1)
  self.approved('3'*32,second,presence=lambda *_:self.proof(expired=True,height='201'));self.assertEqual(self.calls.count('send-finalize'),2)
  with self.assertRaises(ValueError):self.approved('4'*32,self.context(effects='8'*64,expires='400'),presence=lambda *_:self.proof(recorded=True,height='350'))
  with self.assertRaises(ValueError):self.approved('5'*32,self.context(effects='7'*64,expires='500'),presence=lambda *_:self.fail('A recorded intent is never released'))
  self.assertEqual(self.calls.count('send-finalize'),2)
 def test_send_claim_rpc_failure_never_counts_as_absence(self):
  self.approved('1'*32)
  def failed(*_):raise RuntimeError('Fictional RPC unavailable')
  with self.assertRaises(RuntimeError):self.approved('2'*32,self.context(effects='9'*64),presence=failed)
 def test_s7_a_live_earlier_claim_answers_claim_held_with_its_expiry_height(self):
  # S7: BAINK queues on {status:'claim-held', retryAfterHeight} instead of showing a refusal.
  self.approved('1'*32);second=self.context(effects='9'*64,expires='300');job='2'*32
  self.act(job,'create',dict(context=second),second);self.act(job,'send-ingest',self.send,second)
  held=self.act(job,'inspect',None,second,lambda *_:self.proof(expired=False,height='150'))
  self.assertEqual(held,dict(status='claim-held',retryAfterHeight='200'))
  self.assertFalse((self.root/job/'report.sealed.json').exists())
  for action,body in [('attest',dict(attestation={},request='fictional-request',response='fictional-response')),('finalize',None),('finalize-rules',None)]:
   with self.assertRaises(ValueError):self.act(job,action,body,second,lambda *_:self.proof(expired=False,height='150'))
  self.assertEqual(self.calls.count('send-finalize'),1)
  # Past the earlier bundle's expiry, proved absent, the same job takes the claim.
  self.assertEqual(self.act(job,'inspect',None,second,lambda *_:self.proof(expired=True,height='201'))['status'],'inspected')
  # A recorded earlier attempt is never "held": the intent stays paid and inspect refuses.
  job='3'*32;third=self.context(effects='8'*64,expires='400')
  self.act(job,'create',dict(context=third),third);self.act(job,'send-ingest',self.send,third)
  with self.assertRaises(ValueError):self.act(job,'inspect',None,third,lambda *_:self.proof(recorded=True,height='350'))
 def test_expiry_more_than_720_blocks_past_the_proved_height_is_refused_before_any_claim(self):
  for expires,allowed in [('821',False),(str(2**63-1),False),('820',True)]:
   with self.subTest(expires=expires):
    job=('a' if allowed else 'b')+expires[-1]*31;context=self.context(effects=expires[-1]*64,expires=expires)
    self.act(job,'create',dict(context=context),context);self.act(job,'send-ingest',self.send,context)
    if allowed:self.assertEqual(self.act(job,'inspect',None,context)['status'],'inspected')
    else:
     with self.assertRaises(ValueError):self.act(job,'inspect',None,context)
     self.assertFalse((self.root/job/'report.sealed.json').exists())
     self.assertEqual(list((self.root/'sends').glob('*')) if (self.root/'sends').exists() else [],[])

class ServerSendRulesTests(ServerSendTests):
 """P1 (9 Nov 2026): rule checks approve ordinary sends; AI above 10,000 AI$ or when flagged."""
 def routed(self,job,send=None):
  if send:self.send=send
  self.act(job,'create',dict(context=self.context()));self.act(job,'send-ingest',self.send);return self.act(job,'inspect')
 def test_ordinary_send_is_approved_by_rules_without_any_ai_attestation(self):
  r=self.routed('1'*32);self.assertEqual((r['route'],r['reasons']),('rules',[]))
  a=self.act('1'*32,'finalize-rules');self.assertEqual(a['reviewerBinding'],None)
  self.assertEqual((self.finalize_values['audit'],self.finalize_values['rules']),(None,True));self.assertNotIn('attest',self.calls)
  self.assertEqual(self.act('1'*32,'finalize-rules'),a);self.assertEqual(self.calls.count('send-finalize'),1)
  self.assertEqual(len(list((self.root/'send-rules-ledger').iterdir())),1)
 def test_above_ten_thousand_or_flagged_goes_to_the_ai_and_never_through_rules(self):
  big=dict(self.send,intent=dict(self.intent,amountUnits=str(10_000*1_000_000+1)))
  r=self.routed('1'*32,big);self.assertEqual(r['route'],'ai');self.assertIn('amount above 10,000 AI$',r['reasons'])
  with self.assertRaises(ValueError):self.act('1'*32,'finalize-rules')
  self.act('1'*32,'attest',dict(attestation={},request='fictional-request',response='fictional-response'));self.act('1'*32,'finalize');self.assertIsNotNone(self.finalize_values['audit'])
  self.rules=dict(self.rules,flag=[self.intent['to']]);self.send=dict(self.send,intent=dict(self.intent,memo='m'))
  self.assertEqual(self.routed('2'*32,dict(self.send,intent=dict(self.intent,nonce='2')))['route'],'ai')
  self.rules=dict(self.rules,flag=[],flagTerms=['launder']);self.assertIn('memo matches a flag term',self.routed('3'*32,dict(self.send,intent=dict(self.intent,memo='please LAUNDER this',nonce='3')))['reasons'])
 def test_exactly_ten_thousand_is_rules_and_the_refuse_list_refuses(self):
  self.assertEqual(self.routed('1'*32,dict(self.send,intent=dict(self.intent,amountUnits=str(10_000*1_000_000))))['route'],'rules')
  self.rules=dict(self.rules,refuse=[self.intent['from']])
  self.assertEqual(self.routed('2'*32,dict(self.send,intent=dict(self.intent,nonce='x'))),dict(status='refused',reason='member on the refuse list'))
  with self.assertRaises(ValueError):self.act('2'*32,'finalize-rules')
  with self.assertRaises(ValueError):self.act('2'*32,'finalize')
 def test_a_member_refused_after_inspection_is_never_signed_on_either_path(self):
  self.routed('1'*32);self.rules=dict(self.rules,refuse=[self.intent['to']])
  with self.assertRaises(ValueError):self.act('1'*32,'finalize-rules')
  self.act('1'*32,'attest',dict(attestation={},request='fictional-request',response='fictional-response'))
  with self.assertRaises(ValueError):self.act('1'*32,'finalize')
  self.assertEqual(self.calls.count('send-finalize'),0)
 def test_daily_rule_limit_routes_the_rest_to_the_ai(self):
  self.rules=dict(self.rules,perPayerDailyCount=1)
  self.routed('1'*32);self.act('1'*32,'finalize-rules')
  r=self.routed('2'*32,dict(self.send,intent=dict(self.intent,nonce='n2')));self.assertEqual(r['route'],'ai');self.assertIn('payer daily rule limit reached',r['reasons'])
  self.now+=86401;self.assertEqual(self.routed('3'*32,dict(self.send,intent=dict(self.intent,nonce='n3')))['route'],'rules')

class SendRulesL8Tests(ServerSendRulesTests):
 """L8 (security review, 10 Nov 2026): memo bypass, fail-open rules file, no per-payee total."""
 def flagged(self,memo,job,term='launder'):
  self.rules=dict(self.rules,flagTerms=[term])
  return 'memo matches a flag term' in self.routed(job,dict(self.send,intent=dict(self.intent,memo=memo,nonce=job)))['reasons']
 def test_h1_memo_disguises_still_match(self):
  for i,memo in enumerate(['l\u200baunder','l\u200daun\u2060der','\u043baunder'.replace('\u043b','l').replace('a','\u0430',1),
   'LAUNDER','L A U N D E R','l.a.u.n.d.e.r','l-a_u/n\\d e r','\uff4c\uff41\uff55\uff4e\uff44\uff45\uff52','la\u0301under','l\u00e0under','\u0399aunder'.lower().replace('\u03b9','l'),
   'please launder\u00ad this','\U0001d425\U0001d41a\U0001d42e\U0001d427\U0001d41d\U0001d41e\U0001d42b']):
   with self.subTest(memo=memo):self.assertTrue(self.flagged(memo,format(i+1,'x').rjust(32,'a')),memo)
 def test_h2_a_disguised_term_in_the_rules_file_still_matches_plain_memos(self):
  self.assertTrue(self.flagged('please launder this','b'*32,term='LAUN\u200bDER'))
 def test_h3_ordinary_memos_are_not_flagged(self):
  for i,memo in enumerate(['','invoice 42','thanks for the review','laundry money? no: rent']):
   with self.subTest(memo=memo):self.assertFalse(self.flagged(memo,format(i+1,'x').rjust(32,'c'),term='launderer'))
 def test_h9_flag_terms_and_memos_in_any_script_match(self):
  # L8 residual: a term wholly in another script must be configurable and must match.
  self.assertEqual(s.memo_skeleton('洗钱'),'洗钱');self.assertEqual(s.memo_skeleton('Ξέπλυμα'),s.memo_skeleton('ξεπλυμα'))
  for i,(memo,term) in enumerate([('请帮我洗钱','洗钱'),('请帮我洗​钱','洗钱'),('请帮我 洗 钱','洗⁠钱'),('για ΞΕΠΛΥΜΑ χρημάτων','ξέπλυμα'),('اريد غسيل الأموال','غسيل')]):
   with self.subTest(memo=memo):self.assertTrue(self.flagged(memo,format(i+1,'x').rjust(32,'d'),term=term),memo)
  # The earlier ASCII skeleton still applies: letters of another script inside a Latin term hide nothing.
  for i,memo in enumerate(['l中aunder','launشder this','אlaunder']):
   with self.subTest(memo=memo):self.assertTrue(self.flagged(memo,format(i+1,'x').rjust(32,'f')),memo)
  for i,memo in enumerate(['谢谢你的评审','洗衣服的钱','invoice 42']):
   with self.subTest(memo=memo):self.assertFalse(self.flagged(memo,format(i+1,'x').rjust(32,'e'),term='洗钱'),memo)
 def test_h4_a_missing_rules_file_approves_nothing_by_rules(self):
  with tempfile.TemporaryDirectory() as d:rules=s.send_rules(Path(d)/'absent.json')
  self.assertTrue(rules['missing']);self.rules=rules
  r=self.routed('1'*32);self.assertEqual(r['route'],'ai');self.assertIn('send rules file missing',r['reasons'])
  with self.assertRaises(ValueError):self.act('1'*32,'finalize-rules')
  self.act('1'*32,'attest',dict(attestation={},request='fictional-request',response='fictional-response'));self.act('1'*32,'finalize');self.assertEqual(self.calls.count('send-finalize'),1)
 def test_h5_a_present_but_bad_rules_file_refuses_and_v1_files_still_load(self):
  with tempfile.TemporaryDirectory() as d:
   f=Path(d)/'rules.json'
   if os.geteuid()!=0:self.skipTest('rules file must be root-owned')
   for bad in ['{}','[]','not json',json.dumps(dict(s.SEND_RULES_DEFAULT,extra=1)),json.dumps(dict(s.SEND_RULES_DEFAULT,perPayeeDailyCount=0,perPayeeDailyUnits='1')),json.dumps(dict(s.SEND_RULES_DEFAULT,flagTerms=['\u200b']))]:
    f.write_text(bad);os.chmod(f,0o600)
    with self.subTest(bad=bad[:40]),self.assertRaises(Exception):s.send_rules(f)
   f.write_text(json.dumps(s.SEND_RULES_DEFAULT));os.chmod(f,0o600);r=s.send_rules(f)
   self.assertNotIn('missing',r);self.assertEqual(r['perPayeeDailyCount'],96)
   f.write_text(json.dumps(dict(s.SEND_RULES_DEFAULT,perPayeeDailyCount=5,perPayeeDailyUnits='7')));os.chmod(f,0o600);self.assertEqual(s.send_rules(f)['perPayeeDailyCount'],5)
   os.chmod(f,0o622)
   with self.assertRaises(Exception):s.send_rules(f)
 def test_h6_per_payee_total_catches_many_payers_feeding_one_payee(self):
  self.rules=dict(self.rules,perPayeeDailyCount=2)
  for i,payer in enumerate(['uain1'+'1'*40,'uain1'+'2'*40]):
   job=str(i+1)*32;self.routed(job,dict(self.send,intent=dict(self.intent,**{'from':payer},nonce=job)));self.act(job,'finalize-rules')
  rows=[json.loads(f.read_text()) for f in (self.root/'send-rules-ledger').iterdir()];self.assertTrue(all(r['payee']==self.intent['to'] for r in rows))
  r=self.routed('3'*32,dict(self.send,intent=dict(self.intent,**{'from':'uain1'+'3'*40},nonce='3')))
  self.assertEqual(r['route'],'ai');self.assertIn('payee daily rule limit reached',r['reasons']);self.assertNotIn('payer daily rule limit reached',r['reasons'])
  self.now+=86401;self.assertEqual(self.routed('4'*32,dict(self.send,intent=dict(self.intent,**{'from':'uain1'+'4'*40},nonce='4')))['route'],'rules')
 def test_h7_per_payee_units_cap_and_old_ledger_rows_without_payee(self):
  self.rules=dict(self.rules,perPayeeDailyUnits=str(int(self.intent['amountUnits'])*2-1))
  ledger=self.root/'send-rules-ledger';ledger.mkdir(mode=0o700,exist_ok=True)
  (ledger/'old.json').write_text(json.dumps(dict(payer='uain1'+'9'*40,amountUnits=self.intent['amountUnits'],at=self.now)))
  self.assertEqual(self.routed('1'*32)['route'],'rules','a pre-change row has no payee and does not count for one');self.act('1'*32,'finalize-rules')
  r=self.routed('2'*32,dict(self.send,intent=dict(self.intent,**{'from':'uain1'+'8'*40},nonce='2')));self.assertIn('payee daily rule limit reached',r['reasons'])
 def test_h8_refuse_list_still_wins_over_everything(self):
  self.rules=dict(self.rules,missing=True,refuse=[self.intent['to']])
  self.assertEqual(self.routed('1'*32),dict(status='refused',reason='member on the refuse list'))

class SendRulesAddressTests(ServerSendRulesTests):
 """L8 remainder (12 Nov 2026): refuse and flag lists also cover the Orchard receiving
address, because several member ids can register one address (server-send.mjs)."""
 BAD='d'*86
 def via(self,job,to,address,**extra):
  return self.routed(job,dict(self.send,intent=dict(self.intent,to=to,recipientAddress=address,nonce=job,**extra)))
 def test_a1_refused_address_is_refused_under_a_fresh_member_id(self):
  self.rules=dict(self.rules,refuse=[self.BAD])
  self.assertEqual(self.via('1'*32,'uain1'+'e'*40,self.BAD),dict(status='refused',reason='receiving address on the refuse list'))
  with self.assertRaises(ValueError):self.act('1'*32,'finalize-rules')
  self.act('1'*32,'attest',dict(attestation={},request='fictional-request',response='fictional-response'))
  with self.assertRaises(ValueError):self.act('1'*32,'finalize')
  self.assertEqual(self.calls.count('send-finalize'),0)
 def test_a2_flagged_address_goes_to_the_ai(self):
  self.rules=dict(self.rules,flag=[self.BAD])
  r=self.via('1'*32,'uain1'+'e'*40,self.BAD);self.assertEqual(r['route'],'ai');self.assertIn('receiving address on the flag list',r['reasons'])
 def test_a3_other_addresses_are_unaffected(self):
  self.rules=dict(self.rules,refuse=[self.BAD],flag=['e'*86])
  self.assertEqual(self.via('1'*32,'uain1'+'e'*40,'c'*86)['route'],'rules')
 def test_a4_missing_or_malformed_address_never_approves_by_rules(self):
  for i,bad in enumerate([None,'',self.BAD.upper(),self.BAD[:-1],self.BAD+'0',' '+self.BAD[1:],123]):
   job=format(i+1,'x').rjust(32,'f');intent=dict(self.intent,nonce=job)
   if bad is None:intent.pop('recipientAddress')
   else:intent['recipientAddress']=bad
   with self.subTest(address=bad):
    r=self.routed(job,dict(self.send,intent=intent));self.assertEqual(r['route'],'ai');self.assertIn('receiving address missing or invalid',r['reasons'])
 def test_a5_case_or_padding_in_the_rules_file_cannot_hide_an_address(self):
  if os.geteuid()!=0:self.skipTest('rules file must be root-owned')
  with tempfile.TemporaryDirectory() as d:
   f=Path(d)/'r.json'
   for bad in [self.BAD.upper(),self.BAD+' ','x'*86,self.BAD[:85]]:
    f.write_text(json.dumps(dict(s.SEND_RULES_DEFAULT,refuse=[bad])));os.chmod(f,0o600)
    with self.subTest(entry=bad[:12]),self.assertRaises(Exception):s.send_rules(f)
   f.write_text(json.dumps(dict(s.SEND_RULES_DEFAULT,refuse=[self.BAD],flag=['uain1'+'e'*40])));os.chmod(f,0o600);self.assertEqual(s.send_rules(f)['refuse'],[self.BAD])
 def test_a6_payee_totals_follow_the_address_across_member_ids(self):
  self.rules=dict(self.rules,perPayeeDailyCount=2)
  for i in range(2):
   job=str(i+1)*32;self.via(job,'uain1'+str(i+5)*40,self.BAD);self.act(job,'finalize-rules')
  r=self.via('3'*32,'uain1'+'7'*40,self.BAD);self.assertEqual(r['route'],'ai');self.assertIn('payee daily rule limit reached',r['reasons'])
  self.assertEqual(self.via('4'*32,'uain1'+'8'*40,'c'*86)['route'],'rules','a different address is not counted')

if __name__=='__main__':unittest.main()

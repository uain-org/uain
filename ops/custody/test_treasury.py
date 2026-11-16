"""Narrow treasury custody tests; every key/account/transfer is fictional."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('treasury',Path(__file__).with_name('treasury.py'))
t=importlib.util.module_from_spec(spec);spec.loader.exec_module(t)

class TreasuryTests(unittest.TestCase):
 def fixture(self,kind='payout'):
  source='0x'+'1'*40;target='0x'+'2'*40
  p=dict(schema='uain-treasury-native-transfer-v1',intent=kind+'/x',network='ethereum:1',source=source,target=target,amount='70',nonce='3',gas_limit='21000',max_priority_fee_per_gas='2',max_fee_per_gas='10')
  campaign=dict(id='c',network=p['network'],asset='native',escrow=source)
  receipt=dict(id='r',campaign='c',amount='100',source=target,state='confirmed' if kind=='payout' else 'refund_pending')
  if kind=='refund':p['amount']='100'
  intent=dict(id='x',receipt='r',network=p['network'],asset='native',escrow=source,address=target,amount='70',state='pending',member='uain1'+'2'*40)
  if kind=='refund':p['intent']='refund/r';intent=receipt
  escrow=dict(policy='proved-native-treasury-escrow-v1',network=p['network'],address=source,controller=t.GUARDIAN,guardian=t.GUARDIAN,height='10',approved_height='12',expires_height='30')
  liability=dict(network=p['network'],escrow=source,funded='200',paid='0',refunded='0',outstanding='200')
  records={'funding_activation':dict(policy='external-receipts-80-15-5-v1',height='2',observers=['a','b']), 'treasury_escrow/'+p['network']+'/'+source:escrow,'treasury_liability/'+p['network']+'/'+source:liability,'funding_receipt/r':receipt,'funding_campaign/c':campaign,'external_payout/x':intent,'funding_refund_request/r':dict(Member='relay',EvidenceDigest='c'*64,Height=50),'funding_pool/r':dict(funded='100',refunded='0',bounty=dict(available='10' if kind=='payout' else '80',reserved='70' if kind=='payout' else '0',paid='0'),dividend=dict(available='15',reserved='0',paid='0'),operations=dict(available='5',reserved='0',paid='0'),dust='0')}
  state=dict(chain_id=t.CHAIN,height='100',member=dict(id=t.GUARDIAN,licence='active',sequence='5'),records=records)
  raw=json.dumps(p).encode()
  a=dict(schema=t.APPROVAL_SCHEMA,execution='a'*32,plan_sha256=t.sha(raw),genesis_sha256=t.GENESIS,state_binary_sha256='b'*64,signer_binary_sha256='c'*64,rpc_config_sha256='d'*64,intent_sha256=t.record_digest(intent),liability_sha256=t.record_digest(liability),max_fee='210000',expires_at=1500)
  wallets={p['network']:source}
  return p,raw,a,state,wallets
 def test_exact_pending_intent_and_conserved_liabilities(self):
  for kind in ('payout','refund'):
   p,raw,a,s,w=self.fixture(kind);self.assertEqual(t.validate_transfer(raw,a,s,w,now=1000),p)
 def operations_fixture(self):
  p,_,a,state,w=self.fixture();p.update(intent='operations/op',amount='5')
  intent=dict(id='op',receipt='r',guardian=t.GUARDIAN,network=p['network'],asset='native',escrow=p['source'],amount='5',target=p['target'],payee='outside vendor',invoice_digest='e'*64,evidence_digest='f'*64,height='50',state='pending')
  state['records']['operations_intent/op']=intent;state['records']['operations_filing/op']=copy.deepcopy(intent);state['records']['funding_pool/r']['operations']=dict(available='0',reserved='5',paid='0');raw=json.dumps(p).encode();a.update(plan_sha256=t.sha(raw),intent_sha256=t.record_digest(intent))
  return p,raw,a,state,w
 def test_operations_exact_immutable_invoice_and_reserved_bucket(self):
  p,raw,a,state,w=self.operations_fixture();self.assertEqual(t.validate_transfer(raw,a,state,w,now=1000),p)
  for mutate in (lambda s:s['records']['operations_filing/op'].update(payee='other vendor'),lambda s:s['records']['operations_intent/op'].update(target='0x'+'9'*40),lambda s:s['records']['operations_intent/op'].update(state='paid'),lambda s:s['records']['funding_pool/r'].update(operations=dict(available='5',reserved='0',paid='0'))):
   p,raw,a,state,w=self.operations_fixture();mutate(state)
   with self.assertRaises(ValueError):t.validate_transfer(raw,a,state,w,now=1000)
 def test_operations_close_requires_exact_native_quorum_and_liability_effect(self):
  p,_,_,state,_=self.operations_fixture();point=dict(transaction='0x'+'a'*64,index='0',block='20',block_hash='0x'+'b'*64);attestation=dict(**point,receipt='op',kind='operations',amount='5',source=p['source'],target=p['target']);state['records']['operations_intent/op']['state']='paid';state['records']['treasury_effect/operations/op']=dict(kind='operations',id='op',network=p['network'],escrow=p['source'],amount='5');state['records']['operations_quorum/op']=dict(observations=[dict(member='a',attestation=copy.deepcopy(attestation)),dict(member='b',attestation=copy.deepcopy(attestation))])
  t.validate_closed(p,dict(id=point['transaction']),state,point)
 def test_context_drift_fails_before_signing(self):
  mutations=[lambda p,a,s,w:p.update(target='0x'+'3'*40),lambda p,a,s,w:p.update(amount='69'),lambda p,a,s,w:p.update(network='ethereum:8453'),lambda p,a,s,w:s['records']['external_payout/x'].update(state='paid'),lambda p,a,s,w:s['records']['treasury_liability/'+p['network']+'/'+p['source']].update(outstanding='199'),lambda p,a,s,w:w.update({p['network']:'0x'+'4'*40}),lambda p,a,s,w:s['records']['funding_receipt/r'].update(state='refund_pending'),lambda p,a,s,w:a.update(expires_at=999),lambda p,a,s,w:a.update(max_fee='209999')]
  for mutate in mutations:
   p,_,a,s,w=self.fixture();mutate(p,a,s,w);raw=json.dumps(p).encode();a['plan_sha256']=t.sha(raw)
   with self.subTest(p=p,a=a),self.assertRaises(ValueError):t.validate_transfer(raw,a,s,w,now=1000)
 def test_earned_intent_survives_controller_guardian_licence_change(self):
  p,raw,a,s,w=self.fixture();s['member']['licence']='revoked';self.assertEqual(t.validate_transfer(raw,a,s,w,now=1000),p)
 def test_refund_cannot_redirect_or_bypass_consumed_pool(self):
  p,raw,a,s,w=self.fixture('refund');s['records']['funding_pool/r']['bounty']['reserved']='1'
  with self.assertRaises(ValueError):t.validate_transfer(raw,a,s,w,now=1000)
 def test_unsupported_intent_and_key_paths_refused(self):
  for extra in ({'intent':'dividend/not-implemented'},{'key_file':'/tmp/key'},{'rpc':'https://untrusted.invalid'},{'gas_limit':'22000'},{'max_fee_per_gas':'0'},{'schema':'other'}):
   p,_,a,s,w=self.fixture();p.update(extra);raw=json.dumps(p).encode();a['plan_sha256']=t.sha(raw)
   with self.assertRaises(ValueError):t.validate_transfer(raw,a,s,w,now=1000)
 def test_evm_fee_balance_nonce_network_and_code_checks(self):
  p,raw,a,s,w=self.fixture();t.validate_transfer(raw,a,s,w,now=1000)
  values={'eth_chainId':'0x1','eth_getBlockByNumber':dict(timestamp='0x3e8',baseFeePerGas='0x5'),'eth_getCode':'0x','eth_getTransactionCount':'0x3','eth_getBalance':hex(210200)}
  def rpc(method,params):return values[method]
  self.assertEqual(t.check_external(p,a,200,rpc,now=1000),210000)
  for method,value in [('eth_chainId','0x2105'),('eth_getTransactionCount','0x4'),('eth_getCode','0x01'),('eth_getBalance',hex(210199)),('eth_getBlockByNumber',dict(timestamp='0x300',baseFeePerGas='0x5')),('eth_getBlockByNumber',dict(timestamp='0x3e8',baseFeePerGas='0xb'))]:
   old=values[method];values[method]=value
   with self.subTest(method=method),self.assertRaises(ValueError):t.check_external(p,a,200,rpc,now=1000)
   values[method]=old
 def test_exact_numbers_duplicates_and_redirects(self):
  for raw in (b'{"a":1,"a":2}',b'{"a":1.0}',b'{"a":NaN}'):
   with self.assertRaises(ValueError):t.strict_json(raw)
  for url in ('http://example.com','https://user:pass@example.com','https://example.com/#x','file:///tmp/rpc'):
   with self.assertRaises(ValueError):t.rpc_client(url)
 def test_started_journal_prevents_second_signature(self):
  with tempfile.TemporaryDirectory() as d:
   path=Path(d)/'journal.json';t.start_journal(path,{'plan_sha256':'a'*64})
   with self.assertRaises((ValueError,FileExistsError)):t.start_journal(path,{'plan_sha256':'a'*64})
   self.assertEqual(json.loads(path.read_text())['status'],'started')
 def test_solana_fee_message_and_cover_all_liabilities(self):
  p=dict(schema='uain-treasury-native-transfer-v1',intent='payout/x',network='solana:mainnet',source='4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi',target='8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR',amount='70',recent_blockhash='CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8')
  values=dict(getGenesisHash=t.SOLANA_GENESIS,getLatestBlockhash=dict(context=dict(slot=1),value=dict(blockhash=p['recent_blockhash'],lastValidBlockHeight=9)),getBlockTime=1000,getBlockHeight=2,getFeeForMessage=dict(value=5000),getAccountInfo=dict(value=dict(owner='11111111111111111111111111111111',executable=False)),getBalance=dict(value=5200))
  def rpc(method,params):
   if method=='getFeeForMessage':
    import base64
    message=base64.b64decode(params[0]);self.assertEqual(len(message),150);self.assertEqual(message[-8:],(70).to_bytes(8,'little'))
   return values[method]
  self.assertEqual(t.check_external(p,dict(max_fee='5000'),200,rpc,now=1000),5000)
  for method,value in [('getGenesisHash','devnet'),('getBalance',dict(value=5199)),('getFeeForMessage',dict(value=None)),('getAccountInfo',dict(value=dict(owner=p['target'],executable=False))),('getBlockTime',700),('getBlockHeight',10)]:
   old=values[method];values[method]=value
   with self.subTest(method=method),self.assertRaises((ValueError,TypeError)):t.check_external(p,dict(max_fee='5000'),200,rpc,now=1000)
   values[method]=old
 def test_failed_validation_never_decrypts_vault(self):
  from types import SimpleNamespace
  p,raw,a,s,w=self.fixture();s['records']['external_payout/x']['state']='paid';a['expires_at']=int(t.time.time())+100
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);folder=root/a['execution'];folder.mkdir();(folder/'plan.json').write_bytes(raw);(folder/'approval.json').write_text(json.dumps(a));(root/'wallets.json').write_text(json.dumps(dict(schema='uain-dedicated-treasury-wallets-v1',addresses=w)))
   def never(*args):raise AssertionError('vault access before authorization')
   custody=SimpleNamespace(vault=never,attachment=never)
   with patch.object(t,'ROOT',root),patch.object(t,'protected_read',lambda p,limit=65536:Path(p).read_bytes()),patch.object(t,'pinned_binary',return_value=Path('/fictional')),patch.object(t,'transfer_state',return_value=s),patch.object(t.os,'geteuid',return_value=0):
    with self.assertRaises(ValueError):t.sign_approved(custody,a['execution'])
 def test_lost_broadcast_reply_cannot_submit_twice(self):
  p,raw,a,state,wallets=self.fixture();a['expires_at']=int(t.time.time())+100
  with tempfile.TemporaryDirectory() as d:
   directory=Path(d);journal=dict(status='signed');signed=dict(id='0x'+'a'*64,transaction='0x02');(directory/'plan.json').write_bytes(raw)
   lock=directory/('unresolved-'+t.sha((p['network']+'/'+p['source']).encode())+'.json');lock.write_text(json.dumps(dict(execution=a['execution'])));(directory/'wallets.json').write_text(json.dumps(dict(addresses=wallets)))
   calls=[]
   def rpc(method,params):calls.append(method);raise TimeoutError('fictional lost reply')
   with patch.object(t,'ROOT',directory),patch.object(t,'execution_files',side_effect=lambda e:(directory,p,a,signed,journal.copy())),patch.object(t,'protected_read',lambda p,limit=65536:Path(p).read_bytes()),patch.object(t,'transfer_state',return_value=state),patch.object(t,'load_rpc',return_value=rpc),patch.object(t,'check_external',return_value=210000):
    with self.assertRaises(TimeoutError):t.submit(a['execution'])
    self.assertEqual(json.loads((directory/'journal.json').read_text())['status'],'broadcast_started')
    journal.update(status='broadcast_started')
    with self.assertRaises(ValueError):t.submit(a['execution'])
   self.assertEqual(calls,['eth_sendRawTransaction'])
 def test_native_close_requires_exact_effect_and_both_final_observers(self):
  p,_,_,s,_=self.fixture();point=dict(transaction='0x'+'a'*64,index='0',block='20',block_hash='0x'+'b'*64)
  attestation=dict(**point,receipt='x',kind='payout',amount=p['amount'],source=p['source'],target=p['target'])
  s['records']['external_payout/x']['state']='paid';s['records']['treasury_effect/payout/x']=dict(kind='payout',id='x',network=p['network'],escrow=p['source'],amount=p['amount']);s['records']['external_payout_quorum/x']=dict(observations=[dict(member='a',attestation=attestation.copy()),dict(member='b',attestation=attestation.copy())])
  t.validate_closed(p,dict(id=point['transaction']),s,point)
  s['records']['external_payout_quorum/x']['observations'][1]['attestation']['target']='wrong'
  with self.assertRaises(ValueError):t.validate_closed(p,dict(id=point['transaction']),s,point)
 def control_fixture(self):
  p=dict(schema='uain-treasury-escrow-control-v1',chain_id=t.CHAIN,controller=t.GUARDIAN,sequence='5',expires_height='600',network='ethereum:1',address='0x'+'1'*40,evidence_digest='a'*64)
  raw=json.dumps(p).encode();a=dict(schema='uain-treasury-control-approval-v1',execution='e'*32,plan_sha256=t.sha(raw),genesis_sha256=t.GENESIS,state_binary_sha256='b'*64,signer_binary_sha256='c'*64,expires_at=1500)
  state=dict(chain_id=t.CHAIN,height='100',member=dict(id=t.GUARDIAN,licence='active',sequence='5'),records={'guardians':[t.GUARDIAN],'guardian_epoch_current':None,'funding_activation':dict(policy='external-receipts-80-15-5-v1',height='2'),'treasury_escrow/'+p['network']+'/'+p['address']:None,'treasury_escrow_request/'+p['network']+'/'+p['address']:None})
  return p,raw,a,state,{p['network']:p['address']}
 def test_control_requires_current_original_guardian_fresh_seq_and_absence(self):
  p,raw,a,s,w=self.control_fixture();self.assertEqual(t.validate_control(raw,a,s,w,now=1000),p)
  for mutate in (lambda p,a,s,w:p.update(chain_id='wrong'),lambda p,a,s,w:p.update(sequence='6'),lambda p,a,s,w:p.update(expires_height='821'),lambda p,a,s,w:p.update(network='fiat:USD'),lambda p,a,s,w:s['records'].update(guardians=[]),lambda p,a,s,w:s['records'].pop('treasury_escrow/'+p['network']+'/'+p['address']),lambda p,a,s,w:s['member'].update(licence='revoked')):
   p,_,a,s,w=self.control_fixture();mutate(p,a,s,w);raw=json.dumps(p).encode();a['plan_sha256']=t.sha(raw)
   with self.assertRaises(ValueError):t.validate_control(raw,a,s,w,now=1000)
 def test_original_control_requires_proved_epoch_absence(self):
  for missing in (True,False):
   p,raw,a,state,wallets=self.control_fixture()
   if missing:del state['records']['guardian_epoch_current']
   else:state['records']['guardian_epoch_current']='new-consented-epoch'
   with self.assertRaises(ValueError):t.validate_control(raw,a,state,wallets,now=1000)
 def test_control_renewal_only_after_pending_expiry(self):
  p,raw,a,s,w=self.control_fixture();key='treasury_escrow_request/'+p['network']+'/'+p['address'];s['records'][key]=dict(expires_height='99');self.assertEqual(t.validate_control(raw,a,s,w,now=1000),p)
  s['records'][key]['expires_height']='100'
  with self.assertRaises(ValueError):t.validate_control(raw,a,s,w,now=1000)
 def test_interrupted_control_public_artifact_recovers_without_keys(self):
  import base64
  p,raw,a,s,w=self.control_fixture();execution=a['execution'];public,sign=t.native.ed25519(bytes([7]*32));encoded=base64.urlsafe_b64encode(public).decode().rstrip('=')
  common=dict(version=1,chain_id=t.CHAIN,member=t.GUARDIAN,expires_height=p['expires_height'])
  commands=[dict(**common,sequence=p['sequence'],operation='treasury_escrow_bind',payload=dict(network=p['network'],address=p['address'],expires_height=p['expires_height'],signature='a'*86,evidence_digest=p['evidence_digest'])),dict(**common,sequence=str(int(p['sequence'])+1),operation='treasury_escrow_approve',payload=dict(network=p['network'],address=p['address'],controller=t.GUARDIAN,evidence_digest=p['evidence_digest']))]
  envelopes=[dict(command=c,public_key=encoded,signature=base64.urlsafe_b64encode(sign(t.native.signing_bytes(c))).decode().rstrip('=')) for c in commands]
  with tempfile.TemporaryDirectory() as d:
   directory=Path(d);(directory/'plan.json').write_bytes(raw);(directory/'approval.json').write_text(json.dumps(a));(directory/'journal.json').write_text(json.dumps(dict(status='started',execution=execution,plan_sha256=a['plan_sha256'],native_height='100',starting_event='2')))
   signed=dict(schema='uain-treasury-control-envelopes-v1',execution=execution,plan_sha256=a['plan_sha256'],envelopes=envelopes);(directory/'signed.json.pending').write_text(json.dumps(signed))
   with patch.object(t,'GUARDIAN_PUBLIC',encoded),patch.object(t,'protected_read',lambda p,limit=65536:Path(p).read_bytes()):
    result=t.control_public_artifact(directory,execution);self.assertEqual(result[-1]['status'],'signed');self.assertEqual(result[-1]['starting_event'],'2');self.assertTrue((directory/'signed.json').exists());self.assertFalse((directory/'signed.json.pending').exists())
    signed['envelopes'][1]['command']['payload']['address']='0x'+'9'*40;(directory/'signed.json').write_text(json.dumps(signed))
    with self.assertRaises(ValueError):t.control_public_artifact(directory,execution)
 def test_interrupted_control_requires_explicit_same_plan_retry(self):
  from types import SimpleNamespace
  import contextlib,io
  p,raw,a,state,w=self.control_fixture();a['expires_at']=int(t.time.time())+100;state['event_count']='2';reads=[]
  custody=SimpleNamespace(vault=lambda:object(),attachment=lambda kp,name:(reads.append(name) or bytes([1]*32)))
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);directory=root/'control'/a['execution'];directory.mkdir(parents=True);(directory/'plan.json').write_bytes(raw);(directory/'approval.json').write_text(json.dumps(a));(root/'wallets.json').write_text(json.dumps(dict(schema='uain-dedicated-treasury-wallets-v1',addresses=w)))
   with patch.object(t,'ROOT',root),patch.object(t,'protected_read',lambda p,limit=65536:Path(p).read_bytes()),patch.object(t,'pinned_binary',return_value=Path('/fictional')),patch.object(t,'state_read',return_value=state),patch.object(t.os,'geteuid',return_value=0),contextlib.redirect_stdout(io.StringIO()):
    with patch.object(t,'run_signer',side_effect=TimeoutError('fictional lost control reply')):
     with self.assertRaises(TimeoutError):t.control_approved(custody,a['execution'])
     with self.assertRaises(FileNotFoundError):t.control_approved(custody,a['execution'])
    self.assertEqual(len(reads),1)
    (directory/'retry-approval.json').write_text(json.dumps(dict(schema='uain-treasury-control-retry-v1',execution=a['execution'],plan_sha256=a['plan_sha256'],signer_binary_sha256=a['signer_binary_sha256'],expires_at=int(t.time.time())+100)))
    with patch.object(t,'run_signer',return_value=dict(network=p['network'],address=p['address'],signature='a'*86)),patch.object(t,'guardian_envelopes',side_effect=lambda custody,commands:[dict(command=c) for c in commands]):t.control_approved(custody,a['execution'])
    self.assertEqual(json.loads((directory/'journal.json').read_text())['status'],'signed');self.assertEqual(len(reads),2)
 def test_provision_retries_same_encrypted_keys_after_backup_failure(self):
  from types import SimpleNamespace
  import contextlib,io
  files={};saves=[];backups=[]
  def save(value):files.update(value);saves.append(True)
  def backup():
   backups.append(True)
   if len(backups)==1:raise ValueError('fictional backup failure')
  def signer(binary,mode,p,seed):return dict(network=p['network'],address='0x'+t.sha(seed)[:40])
  custody=SimpleNamespace(vault=lambda:object(),verify_vault=lambda kp:0,records=lambda kp:[dict(name=k) for k in files],attachment=lambda kp,k:files[k],save_vault=save,backup=backup)
  with tempfile.TemporaryDirectory() as d,patch.object(t,'ROOT',Path(d)),patch.object(t,'pinned_binary',return_value=Path('/fictional')),patch.object(t,'run_signer',side_effect=signer),patch.object(t.os,'geteuid',return_value=0):
   with self.assertRaises(ValueError):t.provision(custody,'a'*64)
   self.assertFalse((Path(d)/'wallets.json').exists());original={k:files[k] for k in t.SEEDS.values()}
   out=io.StringIO()
   with contextlib.redirect_stdout(out):t.provision(custody,'a'*64)
   self.assertEqual(len(saves),1);self.assertEqual(len(backups),2);self.assertEqual(original,{k:files[k] for k in t.SEEDS.values()});self.assertEqual(len(set(original.values())),3)
   for seed in original.values():self.assertNotIn(seed.hex(),out.getvalue())
   self.assertTrue(json.loads(out.getvalue())['backed_up'])
 def test_evm_actual_finality_exact_effect_and_canonical_inclusion(self):
  p,_,_,_,_=self.fixture();txid='0x'+'a'*64;bh='0x'+'b'*64
  tx=dict(hash=txid,chainId='0x1',type='0x2',nonce='0x3',**{'from':p['source'],'to':p['target']},value=hex(70),input='0x',blockHash=bh,blockNumber='0x10',transactionIndex='0x0')
  receipt=dict(transactionHash=txid,status='0x1',**{'from':p['source'],'to':p['target']},blockHash=bh,blockNumber='0x10',transactionIndex='0x0')
  values=dict(eth_chainId='0x1',eth_getTransactionByHash=tx,eth_getTransactionReceipt=receipt,eth_getBlockByNumber=dict(number='0x10',hash=bh,transactions=[txid]))
  def rpc(method,params):return values[method]
  self.assertEqual(t.final_external(p,dict(id=txid),rpc)['block'],'16')
  for obj,key,value in ((tx,'value','0x45'),(receipt,'status','0x0'),(tx,'input','0x1234'),(tx,'nonce','0x4'),(values['eth_getBlockByNumber'],'transactions',[])):
   old=obj[key];obj[key]=value
   with self.assertRaises((ValueError,IndexError)):t.final_external(p,dict(id=txid),rpc)
   obj[key]=old
 def test_actual_custody_signer_journal_once_and_no_seed_export(self):
  binary=os.environ.get('UAIN_TEST_TREASURY_SIGNER')
  if not binary:self.skipTest('server compiled offline signer required')
  from types import SimpleNamespace
  import contextlib,io
  p,raw,a,state,wallets=self.fixture();source=p['source'];address='0x7e5f4552091a69125d5dfcb7b8c2659029395bdf'
  # Every public reference changes together; actual offline signer independently
  # derives this exact fictional seed1 address instead of trusting metadata.
  p=json.loads(json.dumps(p).replace(source,address));state=json.loads(json.dumps(state).replace(source,address));wallets={p['network']:address};raw=json.dumps(p).encode();a.update(plan_sha256=t.sha(raw),expires_at=int(t.time.time())+100,intent_sha256=t.record_digest(state['records']['external_payout/x']),liability_sha256=t.record_digest(state['records']['treasury_liability/'+p['network']+'/'+address]))
  accesses=[];seed=bytes([0]*31+[1])
  def attachment(kp,name):accesses.append(name);self.assertEqual(name,t.SEEDS[p['network']]);return seed
  custody=SimpleNamespace(vault=lambda:object(),attachment=attachment,records=lambda kp:[dict(name=t.SEEDS[p['network']],bytes=32,sha256=t.sha(seed))])
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);directory=root/a['execution'];directory.mkdir();(directory/'plan.json').write_bytes(raw);(directory/'approval.json').write_text(json.dumps(a));(root/'wallets.json').write_text(json.dumps(dict(schema='uain-dedicated-treasury-wallets-v1',addresses=wallets)))
   with patch.object(t,'ROOT',root),patch.object(t,'protected_read',lambda p,limit=65536:Path(p).read_bytes()),patch.object(t,'pinned_binary',return_value=Path(binary)),patch.object(t,'transfer_state',return_value=state),patch.object(t,'load_rpc',return_value=lambda *args:None),patch.object(t,'check_external',return_value=210000),patch.object(t.os,'geteuid',return_value=0),contextlib.redirect_stdout(io.StringIO()):
    t.sign_approved(custody,a['execution'])
    output=json.loads((directory/'signed.json').read_text());self.assertTrue(output['id'].startswith('0x'));self.assertTrue(output['transaction'].startswith('0x02'));self.assertEqual(json.loads((directory/'journal.json').read_text())['status'],'signed')
    with self.assertRaises(ValueError):t.sign_approved(custody,a['execution'])
   self.assertEqual(accesses,[t.SEEDS[p['network']]])
   for file in root.rglob('*.json'):self.assertNotIn(seed.hex(),file.read_text())
 def test_started_without_key_commit_can_be_retired_without_vault(self):
  p,raw,a,state,w=self.fixture();execution=a['execution'];a['expires_at']=int(t.time.time())+100
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);directory=root/execution;directory.mkdir();(directory/'plan.json').write_bytes(raw);(directory/'approval.json').write_text(json.dumps(a));(directory/'journal.json').write_text(json.dumps(dict(status='started',execution=execution,plan_sha256=a['plan_sha256'])));(directory/'repair-approval.json').write_text(json.dumps(dict(schema='uain-treasury-wire-repair-approval-v1',execution=execution,plan_sha256=a['plan_sha256'],signer_binary_sha256=a['signer_binary_sha256'],seed_sha256='',expires_at=a['expires_at'])));lock=root/('unresolved-'+t.sha((p['network']+'/'+p['source']).encode())+'.json');lock.write_text(json.dumps(dict(execution=execution)))
   from types import SimpleNamespace
   def never(*args):raise AssertionError('pre-key retirement must not access vault')
   with patch.object(t,'ROOT',root),patch.object(t,'protected_read',lambda p,limit=65536:Path(p).read_bytes()),patch.object(t.os,'geteuid',return_value=0):
    import contextlib,io
    with contextlib.redirect_stdout(io.StringIO()):t.repair_approved(SimpleNamespace(vault=never,attachment=never),execution)
   self.assertFalse(lock.exists());self.assertEqual(json.loads((directory/'journal.json').read_text())['status'],'aborted_before_key')
 def test_actual_interrupted_wire_repair_is_identical_and_never_broadcasts(self):
  binary=os.environ.get('UAIN_TEST_TREASURY_SIGNER')
  if not binary:self.skipTest('server compiled offline signer required')
  from types import SimpleNamespace
  import contextlib,io
  p,_,a,state,_=self.fixture();old=p['source'];seed=bytes([0]*31+[1]);address='0x7e5f4552091a69125d5dfcb7b8c2659029395bdf'
  p=json.loads(json.dumps(p).replace(old,address));state=json.loads(json.dumps(state).replace(old,address));raw=json.dumps(p).encode();a.update(plan_sha256=t.sha(raw),expires_at=int(t.time.time())+100,intent_sha256=t.record_digest(state['records']['external_payout/x']),liability_sha256=t.record_digest(state['records']['treasury_liability/'+p['network']+'/'+address]))
  reads=[];inventory=[dict(name=t.SEEDS[p['network']],bytes=32,sha256=t.sha(seed))]
  custody=SimpleNamespace(vault=lambda:object(),records=lambda kp:inventory,attachment=lambda kp,name:(reads.append(name) or seed))
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);directory=root/a['execution'];directory.mkdir();(directory/'plan.json').write_bytes(raw);(directory/'approval.json').write_text(json.dumps(a));(root/'wallets.json').write_text(json.dumps(dict(schema='uain-dedicated-treasury-wallets-v1',addresses={p['network']:address})))
   real_signer=t.run_signer;expected=real_signer(Path(binary),'transfer',p,seed)
   def interrupted(*args):
    self.assertEqual(json.loads((directory/'journal.json').read_text())['status'],'key_committed')
    self.assertEqual(real_signer(Path(binary),'transfer',p,seed),expected)
    raise TimeoutError('fictional lost child reply after deterministic signing')
   with patch.object(t,'ROOT',root),patch.object(t,'protected_read',lambda p,limit=65536:Path(p).read_bytes()),patch.object(t,'pinned_binary',return_value=Path(binary)),patch.object(t,'transfer_state',return_value=state),patch.object(t,'load_rpc',return_value=lambda *args:None),patch.object(t,'check_external',return_value=210000),patch.object(t.os,'geteuid',return_value=0),contextlib.redirect_stdout(io.StringIO()):
    with patch.object(t,'run_signer',side_effect=interrupted):
     with self.assertRaises(TimeoutError):t.sign_approved(custody,a['execution'])
    repair=dict(schema='uain-treasury-wire-repair-approval-v1',execution=a['execution'],plan_sha256=a['plan_sha256'],signer_binary_sha256=a['signer_binary_sha256'],seed_sha256=t.sha(seed),expires_at=int(t.time.time())+100);(directory/'repair-approval.json').write_text(json.dumps(repair))
    # A changed vault inventory is detected before the seed attachment is read.
    inventory[0]['sha256']='f'*64
    with self.assertRaises(ValueError):t.repair_approved(custody,a['execution'])
    self.assertEqual(len(reads),1);inventory[0]['sha256']=t.sha(seed)
    # Rebuild an interrupted signed.json rename; even if settlement is already
    # native-final, only the same immutable previously-approved wire is restored.
    state['records']['external_payout/x']['state']='paid'
    (directory/'signed.json.pending').write_text(json.dumps(dict(schema='uain-treasury-signed-v1',execution=a['execution'],plan_sha256=a['plan_sha256'],**expected)))
    with patch.object(t,'load_rpc',side_effect=AssertionError('repair must not make external calls')):t.repair_approved(custody,a['execution'])
    repaired=json.loads((directory/'signed.json').read_text());self.assertEqual({k:repaired[k] for k in ('id','transaction')},expected)
    self.assertEqual(json.loads((directory/'journal.json').read_text())['status'],'signed');self.assertFalse((directory/'signed.json.pending').exists())
    t.repair_approved(custody,a['execution']);self.assertEqual(len(reads),2)
    self.assertTrue((root/('unresolved-'+t.sha((p['network']+'/'+p['source']).encode())+'.json')).exists())
 def test_pre_journal_lock_and_pending_lock_retire_without_key(self):
  from types import SimpleNamespace
  import contextlib,io
  for pending in (False,True):
   p,raw,a,_,_=self.fixture();execution=a['execution']
   with tempfile.TemporaryDirectory() as d:
    root=Path(d);directory=root/execution;directory.mkdir();(directory/'plan.json').write_bytes(raw);(directory/'approval.json').write_text(json.dumps(a));(directory/'repair-approval.json').write_text(json.dumps(dict(schema='uain-treasury-wire-repair-approval-v1',execution=execution,plan_sha256=a['plan_sha256'],signer_binary_sha256=a['signer_binary_sha256'],seed_sha256='',expires_at=int(t.time.time())+100)))
    lock=root/('unresolved-'+t.sha((p['network']+'/'+p['source']).encode())+'.json');destination=lock.with_name(lock.name+'.pending') if pending else lock;destination.write_text(json.dumps(dict(status='started',execution=execution,intent=p['intent'],plan_sha256=a['plan_sha256'])))
    def never(*args):raise AssertionError('pre-key retirement must not access vault')
    with patch.object(t,'ROOT',root),patch.object(t,'protected_read',lambda p,limit=65536:Path(p).read_bytes()),patch.object(t.os,'geteuid',return_value=0),contextlib.redirect_stdout(io.StringIO()):t.repair_approved(SimpleNamespace(vault=never,attachment=never),execution)
    self.assertFalse(lock.exists());self.assertFalse(destination.exists());self.assertEqual(json.loads((directory/'journal.json').read_text())['status'],'aborted_before_key')
 def test_pending_broadcast_marker_cannot_return_to_signed(self):
  p,raw,a,_,_=self.fixture();execution=a['execution'];signed=dict(schema='uain-treasury-signed-v1',execution=execution,plan_sha256=a['plan_sha256'],id='0x'+'a'*64,transaction='0x02')
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);directory=root/execution;directory.mkdir();(directory/'plan.json').write_bytes(raw);(directory/'approval.json').write_text(json.dumps(a));signed_raw=json.dumps(signed).encode();(directory/'signed.json').write_bytes(signed_raw)
   journal=dict(status='signed',execution=execution,intent=p['intent'],plan_sha256=a['plan_sha256'],signed_sha256=t.sha(signed_raw),transaction_id=signed['id']);(directory/'journal.json').write_text(json.dumps(journal));(directory/'journal.json.pending').write_text(json.dumps(dict(journal,status='broadcast_started',broadcast_at=1000)))
   with patch.object(t,'ROOT',root),patch.object(t,'protected_read',lambda p,limit=65536:Path(p).read_bytes()),patch.object(t.os,'geteuid',return_value=0):
    self.assertEqual(t.execution_files(execution)[-1]['status'],'broadcast_started')
    with self.assertRaises(ValueError):t.submit(execution)
    (directory/'journal.json.pending').write_text(json.dumps(journal))
    with self.assertRaises(ValueError):t.execution_files(execution)
 def test_recovery_refuses_absent_evm_reply_or_successful_payment(self):
  p,_,_,_,_=self.fixture();txid='0x'+'a'*64;bh='0x'+'b'*64
  tx=dict(hash=txid,**{'from':p['source']},nonce='0x3',blockNumber='0x10',blockHash=bh)
  receipt=dict(transactionHash=txid,status='0x0',blockNumber='0x10',blockHash=bh,transactionIndex='0x0')
  block=dict(number='0x10',hash=bh,transactions=[txid],timestamp=hex(int(t.time.time())))
  values=dict(eth_chainId='0x1',eth_getTransactionByHash=tx,eth_getTransactionReceipt=receipt,eth_getBlockByNumber=block,eth_getTransactionCount='0x4')
  rpc=lambda method,params:values[method]
  self.assertEqual(t.failed_external(p,dict(id=txid),{},rpc)['status'],'failed_finalized')
  receipt['status']='0x1'
  with self.assertRaises(ValueError):t.failed_external(p,dict(id=txid),{},rpc)
  values['eth_getTransactionReceipt']=None
  with self.assertRaises((ValueError,TypeError)):t.failed_external(p,dict(id=txid),{},rpc)
 def test_recovery_solana_requires_expiry_history_absence_and_fresh_finality(self):
  p=dict(network='solana:mainnet',source='source',recent_blockhash='blockhash');signed=dict(id='signature',transaction='wire');journal=dict(external_context=dict(solana_last_valid_block_height=9))
  values=dict(getGenesisHash=t.SOLANA_GENESIS,getSlot=100,getBlockTime=int(t.time.time()),getSignatureStatuses=dict(value=[None]),getBlockHeight=10,isBlockhashValid=dict(value=False),getTransaction=None)
  rpc=lambda method,params:values[method]
  self.assertEqual(t.failed_external(p,signed,journal,rpc)['status'],'expired_unbroadcastable')
  for method,value in [('getBlockHeight',9),('isBlockhashValid',dict(value=True)),('getTransaction',{}),('getBlockTime',0),('getGenesisHash','devnet')]:
   old=values[method];values[method]=value
   with self.assertRaises(ValueError):t.failed_external(p,signed,journal,rpc)
   values[method]=old
 def test_recovery_cleanup_repeats_after_journal_write_crash(self):
  p,_,a,_,_=self.fixture();signed=dict(id='0x'+'a'*64);journal=dict(status='failed_finalized');execution=a['execution']
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);lock=root/('unresolved-'+t.sha((p['network']+'/'+p['source']).encode())+'.json');lock.write_text(json.dumps(dict(execution=execution)));(root/'failure-finality.json').write_text(json.dumps(dict(status='failed_finalized',execution=execution,transaction=signed['id'])))
   with patch.object(t,'ROOT',root),patch.object(t,'execution_files',return_value=(root,p,a,signed,journal)),patch.object(t,'protected_read',lambda p,limit=65536:Path(p).read_bytes()):
    import contextlib,io
    with contextlib.redirect_stdout(io.StringIO()):t.recover(execution);t.recover(execution)
   self.assertFalse(lock.exists())
 def test_real_signer_only_receives_fd3(self):
  binary=os.environ.get('UAIN_TEST_TREASURY_SIGNER')
  if not binary:self.skipTest('server compiled offline signer required')
  seed=bytearray([0]*31+[1]);out=t.run_signer(Path(binary),'address',{'schema':'uain-treasury-address-v1','network':'ethereum:1'},seed)
  self.assertEqual(out,dict(network='ethereum:1',address='0x7e5f4552091a69125d5dfcb7b8c2659029395bdf'));self.assertEqual(seed,bytearray([0]*31+[1]))

if __name__=='__main__':unittest.main()

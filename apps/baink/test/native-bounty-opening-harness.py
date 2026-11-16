"""Explicit disposable-chain qualification, never a production operator entry.

Only this process overrides production identity/genesis bindings. Actual native
daemon, signed state proofs, command signing, send-once journals and Go keeper
transitions remain in use. The custody object reads only a newly generated
fictional fixture key file; no key or private artifact is emitted.
"""
import base64,copy,datetime,hashlib,json,os,re,sys,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[3]/'ops/custody'))
import native_bounty_opening as b
import private_payment_service as service

def require(ok):
 if not ok:raise RuntimeError('Disposable bounty qualification refused')
def main():
 require(os.geteuid()==0 and len(sys.argv)==2 and os.environ.get('UAIN_FINANCIAL_BOUNTY_E2E')=='1')
 config_path=Path(sys.argv[1]);require(config_path.resolve()==config_path and str(config_path).startswith('/qualification/baink-fictional-bounty-'))
 config=json.loads(config_path.read_text());root=config_path.parent;require(root.stat().st_mode&0o777==0o700 and root.stat().st_uid==0)
 chain=config['chainId'];require(re.fullmatch(r'baink-fictional-e2e-[a-f0-9]{12}',chain) and re.fullmatch(r'http://127\.0\.0\.1:[1-9][0-9]{0,4}',config['rpc']))
 genesis=root/'genesis.json';require(b.sha(genesis.read_bytes())==config['genesisSha256'] and json.loads(genesis.read_text())['chain_id']==chain)
 # Narrow fixture-only binding override; no source files or production policy
 # are changed. All reads still invoke the pinned original-state SDK.
 b.CHAIN=chain;b.GENESIS=config['genesisSha256'];b.GUARDIAN=config['guardian'];b.PUBLIC=config['guardianPublicKey'];b.PRIVATE_RELAYER=config['relay']
 service.CHAIN=chain;service.GENESIS=config['genesisSha256'];service.ROOT=root/'invoice-index';service.ROOT.mkdir(mode=0o700);service.TEMP=root/'proof-tmp';service.TEMP.mkdir(mode=0o700)
 b.admission.TEMP=service.TEMP
 original_validate=b.admission.validate_policy
 def validate_fixture_policy(p):
  require(p['chain_id']==chain and p['genesis_sha256']==config['genesisSha256'] and p['guardian']==config['guardian'] and p['rpc']==config['rpc'])
  # The production operator policy restricts names to uain-*. This shim only
  # adapts that naming convention; it preserves every other policy check and
  # passes the real unique fixture chain/genesis unchanged to the native SDK.
  shadow=dict(p,chain_id='uain-fictional-'+chain.rsplit('-',1)[1]);original_validate(shadow);return p
 b.admission.validate_policy=validate_fixture_policy
 def policy(a):
  return dict(schema=b.admission.SCHEMA,policy='objective-enrol-v1',chain_id=chain,genesis=str(genesis),genesis_sha256=config['genesisSha256'],state_binary=str(root/'uain-state'),state_sha256='136698192e9e38323a552f1e2da2eea5b9b90e3d6e7de11116d72ee28c826860',rpc=config['rpc'],guardian=config['guardian'],guardian_public_key=config['guardianPublicKey'],guardian_key_attachment='keys/uain-review-key.json',guardian_epoch=None,start_event=a.get('expected_event_count','0'),start_event_digest=a.get('expected_last_command_digest',''),max_events=16,max_approvals=1)
 b.financial.runtime_policy=policy
 daemon_binding=None
 def artifacts(a,e):
  nonlocal daemon_binding
  for path,pin in [(a['state_binary'],a['state_sha256']),(a['genesis'],a['genesis_sha256']),*((v['path'],v['sha256']) for v in e['acceptance'])]:require(b.sha(b.financial.read_public(path,32*1024*1024 if path!=a['state_binary'] else 256*1024*1024))==pin)
  daemon=Path('/tools/uaind');require(a['daemon_binary']==str(daemon) and b.sha(daemon.read_bytes())==a['daemon_sha256'])
  proc=Path('/proc')/str(config['daemonPid']);exe=(proc/'exe').resolve();arguments=(proc/'cmdline').read_bytes().rstrip(b'\0').split(b'\0');status=dict(line.split(':',1) for line in (proc/'status').read_text().splitlines() if ':' in line)
  require(arguments==[b'/tools/uaind',b'start',b'--home',config['daemonHome'].encode()] and int(status['PPid'].strip())==config['daemonParentPid'] and status['Name'].strip()=='uaind')
  # Faithful isolated emulation exception: a separate diagnostic observed the
  # pinned amd64 daemon's /proc/exe as this exact Rosetta interpreter, while
  # command line/known Node child PID and actual native RPC proofs stay intact.
  # Production validate_artifacts is not modified by this test-only branch.
  require(exe==daemon.resolve() or str(exe)=='/run/rosetta/rosetta');daemon_binding='direct-pinned' if exe==daemon.resolve() else 'pinned-daemon-under-observed-rosetta'
 b.financial.validate_artifacts=artifacts
 class FixtureCustody:
  reads=0
  def vault(self):return 'fictional-only'
  def attachment(self,vault,name):
   require(vault=='fictional-only' and name=='keys/uain-review-key.json');self.reads+=1;path=root/'fictional-guardian-key.json';require(path.stat().st_uid==0 and path.stat().st_mode&0o777==0o600);return b.native.protected_read(path,1024)
 custody=FixtureCustody();runtime=b.admission.Runtime(policy({}));baseline=runtime.read(dict(member=b.GUARDIAN,keys=[*b.financial.POLICIES,'guardians','guardian_epoch_current','member/'+b.GUARDIAN,'coin_supply','project/'+b.PROJECT,'task/'+b.TASK,'coin_quote/'+b.TASK,'coin_reservation/'+b.TASK]))
 count=baseline['event_count'];last=runtime.read(dict(keys=[b.admission.event_key(int(count))])) if count!='0' else None
 member=baseline['records']['member/'+b.GUARDIAN];date=datetime.datetime.now(datetime.timezone.utc).isoformat();files=config['artifacts'];release=config['release'];manifest=files['release']['sha256'];materials=files['materials']['sha256']
 criteria=('FICTIONAL isolated known-answer qualification ONLY; this is not production research or a paid result. A real post-opening model would distinguish prior art and known work; independent checkers would verify finite bounds, non-vacuity and any original counterexample. No scientific novelty or independent operators are established. Frozen fictional release '+release+' manifest '+manifest+' materials '+materials)
 evidence=dict(schema=b.EVIDENCE_SCHEMA,authorization='Explicitly fictional disposable qualification of the fixed four prospective opening commands; no production authorization or novel result.',source=dict(release=release,version='fictional-only',manifest_sha256=manifest,package_sha256=files['package']['sha256'],materials_manifest_sha256=materials,access_url='https://baink.money/api/native/earning/materials/'+b.TASK),prior_art=dict(basis='FICTIONAL qualification metadata only; no discoverable-solution or scientific-novelty conclusion is asserted in this disposable chain.',searches=['fictional first prior-art guard query','fictional second prior-art guard query'],reviewed_at=date,reviewer='Fictional fixture only',artifact_sha256=files['prior']['sha256']),criteria=criteria,criteria_sha256=b.sha(criteria.encode()),access=dict(available=True,authenticated=True,verified_at=date,receipt_sha256=files['access']['sha256']),acceptance=list(files.values()),limitations=copy.deepcopy(b.LIMITATIONS),novelty_scope='exact-new-model-or-original-counterexample-only')
 raw=b.canonical(evidence).encode();a=dict(schema=b.APPROVAL_SCHEMA,epoch='a'*32,chain_id=chain,genesis=str(genesis),genesis_sha256=config['genesisSha256'],state_binary=str(root/'uain-state'),state_sha256=policy({})['state_sha256'],daemon_binary='/tools/uaind',daemon_sha256='715a3a6b19c7a844111ba6fe3fd63da97ad8145c386e2b076383fd348a3b5160',guardian_public_key=config['guardianPublicKey'],evidence_sha256=b.sha(raw),starting_sequence=member['sequence'],expected_event_count=count,expected_last_command_digest='' if last is None else last['records'][b.admission.event_key(int(count))]['command_digest'],expires_at=int(time.time())+1800,expires_height=str(int(baseline['height'])+90),guardian_baseline={k:member[k] for k in ('karma','credits','active_projects','creator','default_verifier')},supply_baseline=baseline['records']['coin_supply'])
 # Freeze the event id first, then obtain the exact complete approval-bound
 # selection, including its last-event proof, just as the operator preparer.
 baseline=runtime.read(b.selection(a))
 directory=root/'bounty';directory.mkdir(mode=0o700);b.admission.atomic(directory/'approval.json',a);b.admission.atomic(directory/'evidence.json',evidence)
 preflight=b.sign_once(custody,a,raw,baseline,directory);require(preflight['commands_signed']==0 and custody.reads==0)
 signed=b.sign_once(custody,a,raw,baseline,directory,execute=True);require(signed['commands_signed']==4 and custody.reads==1);require(b.sign_once(custody,a,raw,baseline,directory,execute=True)['status']=='retained' and custody.reads==1)
 batch=b.financial.load(directory/'signed.json');runtime=b.admission.Runtime(policy(a));sends=[];broadcast=runtime.broadcast
 def tracked(envelope):sends.append(envelope['command']['operation']);return broadcast(envelope)
 runtime.broadcast=tracked;deadline=time.monotonic()+110;result=None
 while time.monotonic()<deadline:
  result=b.submit_once(a,raw,batch,directory,runtime)
  if result.get('complete'):break
  time.sleep(0.25)
 require(result and result.get('complete') and sends==['open_project','open_task','coin_quote','coin_reserve']);again=b.submit_once(a,raw,batch,directory,runtime);require(again['complete'] and len(sends)==4)
 final=runtime.read(b.selection(a));require(final['records']['coin_supply']['minted']==a['supply_baseline']['minted'] and int(final['records']['coin_supply']['reserved'])==int(a['supply_baseline']['reserved'])+1000000)
 # Exercise the new global two-job invoice guard against actual pinned native
 # membership/nonmembership proofs, without signing an approval or a payment.
 def presence(effect,expires):return service.payment_presence(effect,expires,runtime=b.admission.Runtime(policy(a)))
 key=os.urandom(32);height=int(final['height']);payer=config['guardian'];invoice=dict(schema='baink-private-invoice-v1',id='fictional-root-index',chainId=chain,genesisSha256=config['genesisSha256'],payer=payer,payee=config['relay'],amountUnits='1',requestDigest='c'*64)
 def claim(job,effect,expiry,identity='fictional-root-index'):
  directory=service.ROOT/job;directory.mkdir(mode=0o700,exist_ok=True);report=dict(inspection=dict(invoice=dict(invoice,id=identity),context=dict(chain=chain,effects=effect,purpose='d'*64,expires=str(expiry))));return service.invoice_claim(directory,key,job,report,presence=presence)
 claim('1'*32,'1'*64,height+90)
 try:claim('2'*32,'2'*64,height+90)
 except ValueError:pass
 else:require(False)
 claim('3'*32,'3'*64,height-1,'fictional-expired-index');claim('4'*32,'4'*64,height+90,'fictional-expired-index');claim('4'*32,'4'*64,height+90,'fictional-expired-index')
 claim('5'*32,config['recordedPaymentEffects'],height-1,'fictional-recorded-index')
 for job in ('6'*32,'7'*32):
  try:claim(job,'5'*64,height+90,'fictional-recorded-index')
  except ValueError:pass
  else:require(False)
 print(json.dumps(dict(fixtureOnly=True,productionWrites=False,realPinnedNativeSDK=True,daemonExecutableBinding=daemon_binding,productionHelperArtifactChecksUnchanged=True,actualFourNativeOperations=sends,exactReceiptRecovery=True,sendAttempts=4,guardianKeyReadsInsideFixtureCustody=1,keysExported=False,mintedUnchanged=True,reservedIncreaseUnits='1000000',nativeBountyFixedScope=True,sourceAccessAlreadyAuthenticated=True,actualTwoJobInvoiceClaimGuard=True,actualExpiredNonmembershipReuse=True,actualRecordedInvoicePermanent=True,realAIInvoked=False,scientificNoveltyClaimed=False,independentProductionOperators=False),separators=(',',':')))
if __name__=='__main__':
 try:main()
 except Exception:
  # Tracebacks contain no key, request body or private artifact. They are kept
  # only in the ignored isolated qualification log, never production output.
  import traceback;traceback.print_exc();sys.exit(1)

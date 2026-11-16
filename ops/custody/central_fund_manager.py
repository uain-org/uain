"""Bounded Fund Manager setup; no release, award, arbitrary governance or key export.
Direct CLI uses only protected root plans and original native proofs. Each retained
envelope is broadcast at most once and then reconciled through read-only receipts.

Guardian boundary (10 November 2026). After the 2-of-3 guardian handover (native
`guardian_epoch_current` set) the old single guardian key is the operator/manager,
not a guardian. The plan, review and decision stages are the Fund Manager's own and
continue. The guardian-gated configure stage is never signed alone: `configure`
then writes the exact quorum batch for `uain-custody propose-guardian-actions` and
the matching reviewed-manifest entry for the second guardian's approver, and
returns `quorum_proposal_prepared`. Later funding rounds (apply and decide) of the
starter organizations run through the manager stage and fleet custody
(services/project-organizations/src/fund-rounds.mjs), not through this tool.
"""
import base64,datetime,hashlib,json,os,re,sys,time,resource,stat,types
from pathlib import Path
# The direct root CLI validates the complete local source closure before any
# application module executes. Deployment creates this protected public manifest;
# its own bytes are not recursively included in its source list.
SOURCE_MANIFEST=Path('/etc/uain-custody/central-fund-manager-sources.json')
SOURCE_NAMES=('native_migration','guardian_quorum','native_admission','holder_release','custody','central_fund_manager')
def source_read(path):
 path=Path(path);require_source(path.resolve()==path)
 for parent in path.parents:
  info=parent.stat();require_source(stat.S_ISDIR(info.st_mode) and info.st_uid==0 and not info.st_mode&0o022)
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  info=os.fstat(fd);require_source(stat.S_ISREG(info.st_mode) and info.st_uid==0 and not info.st_mode&0o022 and info.st_nlink==1 and 0<info.st_size<=1024*1024)
  with os.fdopen(fd,'rb',closefd=False) as stream:raw=stream.read(1024*1024+1)
  after=os.fstat(fd);require_source(len(raw)==info.st_size and (info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns))
  return raw
 finally:os.close(fd)
def require_source(value):
 if not value:raise ValueError('Pinned Fund Manager source refused')
def bootstrap_sources(directory=None,manifest=None):
 require_source(os.geteuid()==0);sys.dont_write_bytecode=True
 directory=Path(__file__).absolute().parent if directory is None else Path(directory)
 manifest=SOURCE_MANIFEST if manifest is None else Path(manifest)
 def unique(pairs):
  value={}
  for key,item in pairs:require_source(key not in value);value[key]=item
  return value
 approved=json.loads(source_read(manifest),object_pairs_hook=unique)
 require_source(type(approved)==dict and set(approved)=={'schema','sha256'} and approved['schema']=='uain-central-fund-manager-sources-v1')
 pins=approved['sha256'];require_source(type(pins)==dict and set(pins)=={name+'.py' for name in SOURCE_NAMES})
 sources={}
 for name in SOURCE_NAMES:
  raw=source_read(directory/(name+'.py'));pin=pins[name+'.py']
  require_source(type(pin)==str and re.fullmatch('[a-f0-9]{64}',pin) and hashlib.sha256(raw).hexdigest()==pin)
  sources[name]=compile(raw,str(directory/(name+'.py')),'exec',dont_inherit=True)
 # Preload in dependency order; Python imports resolve only these reviewed
 # application modules. Installed interpreter/crypto/pykeepass are runtime deps.
 for name in SOURCE_NAMES[:-1]:
  module=types.ModuleType(name);module.__file__=str(directory/(name+'.py'));sys.modules[name]=module
  exec(sources[name],module.__dict__)
 return approved

def disable_core():resource.setrlimit(resource.RLIMIT_CORE,(0,0))
if __name__=='__main__':
 require_source(sys.flags.isolated);disable_core();bootstrap_sources()
import native_migration as native
import native_admission as admission


import contextlib,fcntl,io,secrets
CHAIN=native.CHAIN;GENESIS=native.GENESIS;GUARDIAN=native.GUARDIAN
READER_SHA='136698192e9e38323a552f1e2da2eea5b9b90e3d6e7de11116d72ee28c826860'
PUBLIC='mDuiMoDUKg66PitMD-j1pztm81wOKlYq7nFFCWLXoRI'
RESEARCH_REVIEWER='uain191fcaf2dd9fb46fa23d636c613fff245b9fb3be2'
POLICY='central-earning-five-kpi-fund-v2'
ROOT=Path('/var/lib/uain-custody/central-fund-manager')
KEY='keys/central-fund-manager.json';LOCK=Path('/run/lock/uain-custody.lock')
PROJECT='P-service-integrity-20261105'
HASH=re.compile(r'^[a-f0-9]{64}$');ADDRESS=re.compile(r'^uain1[a-f0-9]{40}$')
OPERATIONS=dict(enrol='enrol',configure='central_fund_configure',plan='central_fund_plan',approve='central_fund_plan_review')
def require(v):
 if not v:raise ValueError('Bounded Fund Manager custody refused')
def sha(raw):return hashlib.sha256(raw).hexdigest()
def b64(raw):return base64.urlsafe_b64encode(raw).decode().rstrip('=')
def exact(v,fields):return type(v)==dict and set(v)==set(fields)
def text(v,low,high):return type(v)==str and low<=len(v.encode())<=high and len(v.strip())>=low and not any(ord(c)<32 and c not in '\n\t' for c in v)
def number(v):return native.decimal(v,2**64-2)
def identity_check(i):
 require(i['schema']=='uain-central-fund-manager-identity-v1' and i['chain_id']==CHAIN and i['genesis_sha256']==GENESIS)
 pub=admission.public_key(i['public_key']);require(i['member']=='uain1'+sha(pub)[:40] and i['member'] not in (GUARDIAN,RESEARCH_REVIEWER))
 require(i['name']=='UAIN Independent Fund Manager' and i['operator']=='United AI Network (Rahul Jalan)' and i['family']=='Independent Fund Manager')
 return i
def validate(i,p,now):
 identity_check(i)
 require(exact(p,{'schema','chain_id','genesis_sha256','project','manager','fund_manager','main_kpi','stages','reason','model_execution','evidence_digest','review_digest','expires_at'}))
 require(p['schema']=='uain-bounded-fund-plan-v1' and p['chain_id']==CHAIN and p['genesis_sha256']==GENESIS and p['project']==PROJECT and p['manager']==GUARDIAN and p['fund_manager']==i['member'])
 require(text(p['main_kpi'],20,4096) and text(p['reason'],10,2048) and type(p['stages'])==list and len(p['stages'])==5)
 for n,s in enumerate(p['stages'],1):require(exact(s,{'round','criteria'}) and type(s['round'])==int and s['round']==n and text(s['criteria'],20,4096))
 require(len(set(s['criteria'] for s in p['stages']))==5)
 e=p['model_execution'];require(exact(e,{'execution_id','input_sha256','output_sha256'}) and text(e['execution_id'],1,96))
 for v in (e['input_sha256'],e['output_sha256'],p['evidence_digest'],p['review_digest']):require(type(v)==str and HASH.fullmatch(v))
 require(type(p['expires_at'])==int and now<p['expires_at']<=now+3600)
 return p
def bind_reports(p,objective,report,review):
 """Root pins public provider output and a separate structural review, never achievement."""
 require(exact(objective,{'schema','project','main_kpi','context'}) and objective['schema']=='uain-fund-objective-v1' and objective['project']==p['project'] and objective['main_kpi']==p['main_kpi'] and text(objective['context'],20,16384))
 require(exact(report,{'schema','execution_id','input','result'}) and report['schema']=='uain-fund-model-report-v1' and report['input']==objective and report['execution_id']==p['model_execution']['execution_id'])
 result=report['result'];require(exact(result,{'main_kpi','stages','reason'}) and all(result[k]==p[k] for k in result))
 require(sha(native.canonical(objective).encode())==p['model_execution']['input_sha256'] and sha(native.canonical(result).encode())==p['model_execution']['output_sha256'] and sha(native.canonical(report).encode())==p['evidence_digest'])
 require(exact(review,{'schema','execution_id','report_digest','verdict','findings'}) and review['schema']=='uain-fund-plan-review-v1' and text(review['execution_id'],1,96) and review['execution_id']!=report['execution_id'] and review['report_digest']==p['evidence_digest'] and review['verdict']=='accept' and type(review['findings'])==list and 1<=len(review['findings'])<=32 and all(text(v,20,4096) for v in review['findings']) and sha(native.canonical(review).encode())==p['review_digest'])
 return True
def proof_policy(p):
 admission.validate_policy(p)
 require(p['chain_id']==CHAIN and p['genesis_sha256']==GENESIS and p['state_sha256']==READER_SHA and p['state_binary']=='/opt/uain-chain/tools/state/'+READER_SHA+'/uain-state' and p['genesis']=='/etc/uain-custody/native-admission-genesis.json' and p['rpc']=='http://127.0.0.1:26667' and p['guardian']==GUARDIAN and p['guardian_public_key']==PUBLIC and p['guardian_key_attachment']=='keys/uain-review-key.json')
 return p
def actor(i,stage):require(stage in OPERATIONS);return GUARDIAN if stage=='configure' else i['member']
def keys(i,p):return ['guardians','guardian_epoch_current','member/'+i['member'],'central_earning_activation','project/'+p['project'],'central_project_budget/'+p['project'],'central_fund_config/'+p['project'],'central_fund_state/'+p['project'],'central_fund_plan/'+p['project']+'/00000000000000000001']
def fresh(s,now):
 require(s['chain_id']==CHAIN and type(s['app_hash'])==str and HASH.fullmatch(s['app_hash']))
 stamp=datetime.datetime.fromisoformat(s['header_time'].replace('Z','+00:00'));require(stamp.tzinfo is not None and -60<=now-stamp.timestamp()<=120)
 h=number(s['height']);require(0<h<9223372036854775707);number(s['event_count']);return h
def enrol_command(i,s):
 identity_check(i);h=fresh(s,time.time());require(s['records'].get('member/'+i['member'],'missing') is None)
 return dict(version=1,chain_id=CHAIN,member=i['member'],sequence='0',expires_height=str(h+100),operation='enrol',payload={k:i[k] for k in ('name','operator','family')})
def command(i,p,s,stage,now=None):
 now=time.time() if now is None else now;require(stage in OPERATIONS);validate(i,p,now)
 if stage=='enrol':return enrol_command(i,s)
 h=fresh(s,now);r=s['records'];member=actor(i,stage);m=s['member'];public=PUBLIC if stage=='configure' else i['public_key']
 require(m['id']==member and m['public_key']==public and m['licence']=='active');number(m['sequence'])
 if r['guardian_epoch_current'] is None:require(GUARDIAN in r['guardians'])
 else:
  # After the 2-of-3 handover this identity is the manager/reviewer, not a
  # guardian: the guardian-gated configuration goes through the quorum batch.
  require(type(r['guardian_epoch_current'])==str and stage!='configure')
 a=r['central_earning_activation'];require(a['policy']==POLICY and a['reviewer']==RESEARCH_REVIEWER and 2<=number(a['height'])<=h)
 b=r['central_project_budget/'+PROJECT];project=r['project/'+PROJECT]
 require(project['id']==PROJECT and project['lead']==p['manager'] and project['state']=='active' and project['safety_halted'] is False and type(b['evidence_digest'])==str and HASH.fullmatch(b['evidence_digest']) and b['project']==PROJECT and b['manager']==p['manager'] and b['policy']==POLICY and type(b['round'])==int and b['round']==1 and b['allocation']=='10000000000' and b['lifetime_ceiling']=='1000000000000000' and b.get('main_kpi_achieved',False) is False and b.get('closed',False) is False and number(a['height'])<=number(b['height'])<=h and number(b['paid'])+number(b['reserved'])<=10000000000)
 fm=r['member/'+i['member']];require(fm['id']==i['member'] and fm['public_key']==i['public_key'] and fm['licence']=='active')
 config=r['central_fund_config/'+PROJECT];state=r['central_fund_state/'+PROJECT];plan=r['central_fund_plan/'+PROJECT+'/00000000000000000001']
 expected=dict(project=PROJECT,revision=1,main_kpi=p['main_kpi'],stages=p['stages'],reason=p['reason'],evidence_digest=p['evidence_digest'])
 if stage=='configure':
  require(config is None and state is None and plan is None);payload=dict(project=PROJECT,evaluator=i['member'],expected_evaluator='',evidence_digest=p['evidence_digest'])
 else:
  require(config['project']==PROJECT and config['evaluator']==i['member'])
  if stage=='plan':require(state is None and plan is None);payload=expected
  else:
   require(exact(state,{'revision','approved_revision','pending','completed'}) and type(state['revision'])==int and state['revision']==1 and state['approved_revision']==0 and state['completed']==0 and state['pending']=='')
   require(all(plan[k]==v for k,v in expected.items()) and plan['manager']==p['manager'] and plan['state']=='proposed' and plan['reviewer']=='')
   payload=dict(project=PROJECT,revision=1,verdict='accept',evidence_digest=p['review_digest'])
 return dict(version=1,chain_id=CHAIN,member=member,sequence=m['sequence'],expires_height=str(h+100),operation=OPERATIONS[stage],payload=payload)
QUORUM_BATCH='uain-guardian-action-batch-v1';QUORUM_MANIFEST='uain-guardian-action-manifest-v1'
OPP_ID=re.compile(r'^OPP-[0-9]{5}$');NATIVE_PROJECT=re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$')
def handed_over(records):
 """Whether the 2-of-3 guardian handover is recorded natively."""
 e=records['guardian_epoch_current'];require(e is None or type(e)==str);return e is not None
def quorum_configure(payload,rule='manifest',context=None):
 """One guardian-gated central_fund_configure as an item of a `propose-guardian-actions`
 batch: rule `manifest` (judged by digest against a reviewed manifest entry) or
 `organizations` with context {project: OPP-xxxxx} (judged against the fleet policy)."""
 require(exact(payload,{'project','evaluator','expected_evaluator','evidence_digest'}) and type(payload['project'])==str and NATIVE_PROJECT.fullmatch(payload['project']) and type(payload['evaluator'])==str and ADDRESS.fullmatch(payload['evaluator']))
 require(payload['expected_evaluator']=='' or (type(payload['expected_evaluator'])==str and ADDRESS.fullmatch(payload['expected_evaluator'])))
 require(payload['expected_evaluator']!=payload['evaluator'] and type(payload['evidence_digest'])==str and HASH.fullmatch(payload['evidence_digest']) and payload['evaluator'] not in (GUARDIAN,RESEARCH_REVIEWER))
 if rule=='organizations':require(exact(context,{'project'}) and type(context['project'])==str and OPP_ID.fullmatch(context['project']) and payload['project']=='P-'+context['project'])
 else:require(rule=='manifest' and context in (None,{}));context={}
 return dict(operation='central_fund_configure',payload=dict(payload),rule=rule,context=dict(context))
def quorum_decision(action):
 """The decision digest guardian_proposer.decision() and the approver's manifest rule use."""
 return sha(native.canonical([action['operation'],action['payload']]).encode())
def configure_proposal(i,p,s,now=None):
 """After the handover: the exact quorum batch and manifest entry that configure this
 plan's evaluator. Pure; nothing is signed, broadcast or written here."""
 now=time.time() if now is None else now;validate(i,p,now);fresh(s,now);r=s['records'];require(handed_over(r))
 a=r['central_earning_activation'];require(a['policy']==POLICY and a['reviewer']==RESEARCH_REVIEWER)
 b=r['central_project_budget/'+PROJECT];project=r['project/'+PROJECT]
 require(project['id']==PROJECT and project['state']=='active' and project['safety_halted'] is False and b['project']==PROJECT and b['manager']==p['manager'] and b['policy']==POLICY and b.get('closed',False) is False)
 fm=r['member/'+i['member']];require(fm['id']==i['member'] and fm['public_key']==i['public_key'] and fm['licence']=='active')
 config=r['central_fund_config/'+PROJECT]
 if type(config)==dict and config.get('evaluator')==i['member']:return dict(status='already_configured',evaluator=i['member'])
 require(config is None or (type(config)==dict and config.get('project')==PROJECT and ADDRESS.fullmatch(config.get('evaluator',''))))
 action=quorum_configure(dict(project=PROJECT,evaluator=i['member'],expected_evaluator=config['evaluator'] if type(config)==dict else '',evidence_digest=p['evidence_digest']))
 entry=dict(operation=action['operation'],payload_sha256=quorum_decision(action),reason='Appoint the UAIN Independent Fund Manager as evaluator of '+PROJECT+' under plan evidence '+p['evidence_digest'][:16]+'.')
 return dict(status='quorum_proposal_prepared',batch=dict(schema=QUORUM_BATCH,actions=[action]),manifest_entry=entry,decision=entry['payload_sha256'])
def subject(c):return c['member'] if c['operation']=='enrol' else c['payload']['project']
def matches(e,c):return type(e)==dict and e.get('member')==c['member'] and e.get('operation')==c['operation'] and e.get('subject')==subject(c) and e.get('command_digest')==sha(native.signing_bytes(c)) and not e.get('instance') and not e.get('origin')
@contextlib.contextmanager
def locked():
 require(os.geteuid()==0)
 from holder_release import trusted
 ROOT.mkdir(mode=0o700,parents=True,exist_ok=True);trusted(ROOT,True);require(not ROOT.stat().st_mode&0o077)
 fd=os.open(LOCK,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
 try:
  info=os.fstat(fd);require(info.st_uid==0 and stat.S_ISREG(info.st_mode) and info.st_nlink==1 and not info.st_mode&0o022)
  fcntl.flock(fd,fcntl.LOCK_EX);yield
 finally:os.close(fd)

def provision(custody,expected_vault_sha256):
 """Generate exactly one Fund Manager key inside encrypted custody, with backups."""
 from holder_release import current,read,write,canonical,backup_proof,keypair
 require(type(expected_vault_sha256)==str and HASH.fullmatch(expected_vault_sha256))
 with locked():
  vault_sha,kp,files=current(custody);require(vault_sha==expected_vault_sha256)
  if KEY not in files:
   backup=ROOT/('before-'+vault_sha+'.kdbx')
   if backup.exists():require(sha(read(backup,64*1024*1024))==vault_sha)
   else:write(backup,read(custody.VAULT,64*1024*1024))
   seed=bytearray(secrets.token_bytes(32))
   try:
    pub,_=native.ed25519(bytes(seed));files[KEY]=canonical(dict(schema='uain-central-fund-manager-key-v1',public_key=b64(pub),private_key=b64(seed),created_at=int(time.time()*1000)))
    with contextlib.redirect_stdout(io.StringIO()):custody.save_vault(files)
   finally:
    for i in range(len(seed)):seed[i]=0
   fd=os.open(custody.VAULT,os.O_RDONLY|os.O_NOFOLLOW)
   try:os.fsync(fd)
   finally:os.close(fd)
   fd=os.open(custody.VAULT.parent,os.O_RDONLY|os.O_DIRECTORY)
   try:os.fsync(fd)
   finally:os.close(fd)
  vault_sha,kp,actual=current(custody);require(actual==files)
  key=native.strict_json(files[KEY]);require(exact(key,{'schema','public_key','private_key','created_at'}) and key['schema']=='uain-central-fund-manager-key-v1' and type(key['created_at'])==int)
  public,_=keypair(files[KEY]);pub=base64.urlsafe_b64decode(public+'=');require(len(pub)==32 and b64(pub)==key['public_key'])
  proof=backup_proof(custody,vault_sha)
  identity=dict(schema='uain-central-fund-manager-identity-v1',chain_id=CHAIN,genesis_sha256=GENESIS,member='uain1'+sha(pub)[:40],public_key=b64(pub),name='UAIN Independent Fund Manager',operator='United AI Network (Rahul Jalan)',family='Independent Fund Manager',vault_sha256=vault_sha,backup_receipt_sha256=proof)
  write(ROOT/'identity.json',canonical(identity));return identity


def sign(custody,c,i):
 identity_check(i);require(os.geteuid()==0 and c['operation'] in OPERATIONS.values())
 guardian=c['operation']=='central_fund_configure';member=GUARDIAN if guardian else i['member'];public=PUBLIC if guardian else i['public_key'];require(c['member']==member and c['chain_id']==CHAIN)
 key=native.strict_json(custody.attachment(custody.vault(),'keys/uain-review-key.json' if guardian else KEY));seed=bytearray(admission.public_key(key['private_key']))
 try:
  pub,signer=native.ed25519(bytes(seed));require(b64(pub)==key['public_key']==public and 'uain1'+sha(pub)[:40]==member)
  e=dict(command=c,public_key=b64(pub),signature=b64(signer(native.signing_bytes(c))));admission.verify_envelope(dict(guardian_public_key=public),e,c);return e
 finally:
  for n in range(len(seed)):seed[n]=0
def process(identity,p,stage,runtime,load,write,signer,now=time.time):
 """The caller holds the global custody lock and supplies protected persistence."""
 # plan.json is immutable operator authority, never a send-once journal.
 # Retain existing enrol/configure/approve journal names for reconciliation.
 path=ROOT/('plan-journal.json' if stage=='plan' else stage+'.json');plan_digest=sha(native.canonical({k:v for k,v in p.items() if k!='expires_at'}).encode());j=load(path)
 if j is None:
  s=runtime.read(dict(member=(GUARDIAN if stage=='enrol' else actor(identity,stage)),keys=keys(identity,p)));c=command(identity,p,s,stage,now=now());e=signer(c)
  admission.verify_envelope(dict(guardian_public_key=(PUBLIC if stage=='configure' else identity['public_key'])),e,c)
  j=dict(schema='uain-central-fund-send-once-v1',stage=stage,plan_digest=plan_digest,envelope=e,after_event=s['event_count'],cursor=s['event_count'],attempted=False)
  write(path,j)
 require(j['schema']=='uain-central-fund-send-once-v1' and j['stage']==stage and j['plan_digest']==plan_digest)
 e=j['envelope'];c=e['command'];admission.verify_envelope(dict(guardian_public_key=(PUBLIC if stage=='configure' else identity['public_key'])),e,c)
 require(c['operation']==OPERATIONS[stage])
 if j.get('receipt') is not None:return dict(status='finalized',receipt=j['receipt'],broadcasts_retried=False)
 if j.get('noninclusion') is not None:
  evidence=j['noninclusion'];require(evidence['command_digest']==sha(native.signing_bytes(c)) and evidence['reader_sha256']==READER_SHA and evidence['genesis_sha256']==GENESIS and number(evidence['height'])>number(c['expires_height']) and evidence['through_event']==j['cursor'])
  return dict(status='expired_not_included',evidence=evidence,broadcasts_retried=False)
 if not j['attempted']:
  s=runtime.read(dict(member=(GUARDIAN if stage=='enrol' else actor(identity,stage)),keys=keys(identity,p)))
  if number(s['height'])<number(c['expires_height']) and (stage=='enrol' or s['member']['sequence']==c['sequence']):
   expected=command(identity,p,s,stage,now=now())
   require({k:v for k,v in c.items() if k!='expires_height'}=={k:v for k,v in expected.items() if k!='expires_height'})
   j['attempted']=True;write(path,j)
   try:j['broadcast_code']=runtime.broadcast(e)
   except Exception:j['broadcast_code']=None
   write(path,j)
  # Expired or superseded signed bytes remain intact and are only scanned;
  # no replacement envelope is authorized by this bounded launch.
 # Recovery deliberately does not revalidate expiring launch authority or
 # pre-send absence: finality must remain discoverable after the action.
 s=runtime.read(dict(member=(GUARDIAN if stage=='enrol' else actor(identity,stage)),keys=[]));cursor=number(j['cursor']);count=number(s['event_count']);require(number(j['after_event'])<=cursor<=count)
 end=min(count,cursor+16);selected=[admission.event_key(n) for n in range(cursor+1,end+1)]
 if selected:
  s=runtime.read(dict(member=(GUARDIAN if stage=='enrol' else actor(identity,stage)),keys=selected))
  for k in selected:
   event=s['records'][k];require(type(event)==dict and admission.event_key(number(event['id']))==k)
   if event.get('command_digest')!=sha(native.signing_bytes(c)):continue
   require(matches(event,c));proved=runtime.read(dict(member=actor(identity,stage),keys=[],receipt=dict(envelope=e,event_id=event['id'])));receipt=proved['receipt']
   require(receipt['authority']=='native' and receipt['finalized'] is True and receipt['chain_id']==CHAIN and receipt['state_height']==proved['height'] and receipt['app_hash']==proved['app_hash'] and receipt['event']==event and number(proved['member']['sequence'])>number(c['sequence']))
   j['receipt']=receipt;write(path,j);return dict(status='finalized',receipt=receipt,broadcasts_retried=False)
 j['scan_digest']=sha((j.get('scan_digest','0'*64)+'\n'+native.canonical(dict(from_event=str(cursor+1),through_event=str(end),height=s['height'],app_hash=s['app_hash'],events=[s['records'][key] for key in selected]))).encode())
 j['cursor']=str(end)
 if end==number(s['event_count']) and number(s['height'])>number(c['expires_height']):
  j['noninclusion']=dict(authority='native',chain_id=CHAIN,genesis_sha256=GENESIS,reader_sha256=READER_SHA,command_digest=sha(native.signing_bytes(c)),after_event=j['after_event'],through_event=str(end),height=s['height'],header_time=s['header_time'],app_hash=s['app_hash'],scan_digest=j['scan_digest'],attempted=j['attempted'])
  write(path,j);return dict(status='expired_not_included',evidence=j['noninclusion'],broadcasts_retried=False)
 write(path,j);return dict(status='pending',broadcasts_retried=False,broadcast_code=j.get('broadcast_code'))


def run(stage):
 require(os.geteuid()==0 and stage in OPERATIONS);disable_core();os.umask(0o077)
 import custody
 admission.ensure_directory(ROOT)
 with locked():
  i=admission.load(ROOT/'identity.json');p=admission.load(ROOT/'plan.json');bind_reports(p,admission.load(ROOT/'objective.json'),admission.load(ROOT/'model-report.json'),admission.load(ROOT/'plan-review.json'));admission.TEMP=ROOT/'proofs';admission.ensure_directory(admission.TEMP)
  runtime=admission.Runtime(proof_policy(admission.load(admission.POLICY)))
  if stage=='configure' and not (ROOT/'configure.json').exists():
   s=runtime.read(dict(member=i['member'],keys=keys(i,p)))
   if handed_over(s['records']):
    # The guardian quorum configures; this identity only prepares its exact proposal.
    proposal=configure_proposal(i,p,s)
    if proposal['status']!='quorum_proposal_prepared':return proposal
    out=dict(status=proposal['status'],decision=proposal['decision'],broadcasts_retried=False)
    for name,value in (('configure-quorum-batch.json',proposal['batch']),('configure-quorum-manifest-entry.json',proposal['manifest_entry'])):
     path=ROOT/name
     if path.exists():require(admission.load(path)==value)
     else:admission.atomic(path,value)
     out[name.split('.')[0].replace('-','_')]=str(path)
    return out
  return process(i,p,stage,runtime,lambda path:admission.load(path) if path.exists() else None,admission.atomic,lambda c:sign(custody,c,i))
if __name__=='__main__':
 try:
  if len(sys.argv)==3 and sys.argv[1]=='provision':
   import custody
   result=provision(custody,sys.argv[2])
  else:require(len(sys.argv)==2);result=run(sys.argv[1])
  print(json.dumps(result,separators=(',',':')))
 except Exception as error:print(json.dumps(dict(status='refused',error_type=type(error).__name__)),file=sys.stderr);sys.exit(1)

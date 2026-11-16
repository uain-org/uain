"""One bounded central earning launch. No award, transfer or general signer.

The root-owned plan is reviewed before use. The runtime obtains its own pinned
proof; callers cannot supply native state. Every send is journaled before I/O,
and later invocations only reconcile that original signed envelope.
"""
import base64,datetime,hashlib,json,os,re,sys,time,resource,stat,types
from pathlib import Path
# The direct root CLI validates the complete local source closure before any
# application module executes. Deployment creates this protected public manifest;
# its own bytes are not recursively included in its source list.
SOURCE_MANIFEST=Path('/etc/uain-custody/central-launch-sources.json')
SOURCE_NAMES=('native_migration','guardian_quorum','native_admission','holder_release','central_reviewer','custody','central_launch')
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
 if not value:raise ValueError('Pinned central launch source refused')
def bootstrap_sources(directory=None,manifest=None):
 require_source(os.geteuid()==0);sys.dont_write_bytecode=True
 directory=Path(__file__).absolute().parent if directory is None else Path(directory)
 manifest=SOURCE_MANIFEST if manifest is None else Path(manifest)
 def unique(pairs):
  value={}
  for key,item in pairs:require_source(key not in value);value[key]=item
  return value
 approved=json.loads(source_read(manifest),object_pairs_hook=unique)
 require_source(type(approved)==dict and set(approved)=={'schema','sha256'} and approved['schema']=='uain-central-launch-sources-v1')
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

CHAIN=native.CHAIN;GENESIS=native.GENESIS;GUARDIAN=native.GUARDIAN
READER_SHA='136698192e9e38323a552f1e2da2eea5b9b90e3d6e7de11116d72ee28c826860'
PUBLIC='mDuiMoDUKg66PitMD-j1pztm81wOKlYq7nFFCWLXoRI'
REVIEWER='uain191fcaf2dd9fb46fa23d636c613fff245b9fb3be2'
POLICY='central-earning-five-kpi-fund-v2'
PROJECT='P-service-integrity-20261105';TASK='T-service-integrity-20261105'
ROOT=Path('/var/lib/uain-custody/central-launch-20261105')
FIELDS={'schema','chain_id','genesis_sha256','reviewer','project','task','title','criteria','prior_art','eligibility','solver_amount','reviewer_amount','evidence_digest','expires_at'}
HASH=re.compile(r'^[a-f0-9]{64}$');UINT=re.compile(r'^(0|[1-9][0-9]{0,19})$')
sha=lambda raw:hashlib.sha256(raw).hexdigest()
def require(v):
 if not v:raise ValueError('Bounded central launch refused')
def exact(v,fields):return type(v)==dict and set(v)==set(fields)
def text(v,low,high):return type(v)==str and low<=len(v.encode())<=high and not any(ord(c)<32 and c not in '\n\t' for c in v)
def number(v):require(type(v)==str and UINT.fullmatch(v));return int(v)
def validate(p,now):
 require(exact(p,FIELDS) and p['schema']=='uain-central-launch-v1' and p['chain_id']==CHAIN and p['genesis_sha256']==GENESIS)
 require(p['reviewer']==REVIEWER and p['project']==PROJECT and p['task']==TASK)
 require(text(p['title'],3,240) and text(p['criteria'],40,4096) and p['eligibility'] in ('hard','new','unresolved'))
 require(type(p['evidence_digest'])==str and HASH.fullmatch(p['evidence_digest']))
 require(0<number(p['solver_amount'])<=1000000 and 0<number(p['reviewer_amount'])<=100000)
 a=p['prior_art'];require(exact(a,{'basis','searches'}) and text(a['basis'],40,4000) and type(a['searches'])==list and 2<=len(a['searches'])<=16 and all(text(v,5,1000) for v in a['searches']) and len(set(a['searches']))==len(a['searches']))
 require(type(p['expires_at'])==int and now<p['expires_at']<=now+3600)
 return p
def proof_policy(p):
 require(p['chain_id']==CHAIN and p['genesis_sha256']==GENESIS and p['state_sha256']==READER_SHA and p['guardian']==GUARDIAN and p['guardian_public_key']==PUBLIC)
 return p
def keys():return ['guardians','guardian_epoch_current','member/'+REVIEWER,'coin_activation','coin_supply','central_earning_activation','project/'+PROJECT,'central_project_budget/'+PROJECT,'central_task/'+TASK,'central_fund_config/'+PROJECT,'central_fund_state/'+PROJECT,'central_fund_plan/'+PROJECT+'/00000000000000000001']
def fresh(s,now):
 require(s['chain_id']==CHAIN and type(s['app_hash'])==str and HASH.fullmatch(s['app_hash']))
 t=datetime.datetime.fromisoformat(s['header_time'].replace('Z','+00:00'));require(t.tzinfo is not None and -60<=now-t.timestamp()<=120)
 h=number(s['height']);require(0<h<9223372036854775707);number(s['event_count'])
 m=s['member'];require(m['id']==GUARDIAN and m['public_key']==PUBLIC and m['licence']=='active' and number(m['sequence'])<18446744073709551615)
 r=s['records'];require(all(k in r for k in keys()) and r['guardian_epoch_current'] is None and GUARDIAN in r['guardians'])
 reviewer=r['member/'+REVIEWER];require(reviewer['id']==REVIEWER and reviewer['licence']=='active')
 c=r['coin_activation'];require(c['policy']=='verified-bounties-108t-micro-v1' and 1<number(c['height'])<=h)
 supply=r['coin_supply'];require(exact(supply,{'minted','reserved','transparent','shielded'}))
 # This is a first-issuance launch. Existing funds/reservations require a new
 # reviewed scope rather than quietly extending this fixed authorization.
 require(all(v=='0' for v in supply.values()))
 return h,r,m
def command(p,s,stage,now=None):
 now=time.time() if now is None else now;validate(p,now);h,r,m=fresh(s,now)
 require(stage in ('activate','project','budget','task'))
 a=r['central_earning_activation']
 if stage=='activate':
  require(a is None);op='central_earning_activate';payload=dict(policy=POLICY,reviewer=REVIEWER,evidence_digest=p['evidence_digest'])
 else:
  require(type(a)==dict and a['policy']==POLICY and a['reviewer']==REVIEWER and 1<number(a['height'])<=h)
  project=r['project/'+PROJECT];budget=r['central_project_budget/'+PROJECT]
  if stage=='project':
   require(project is None and m['creator'] is True);op='open_project';payload=dict(id=PROJECT,title='Earned AI$ peer service integrity research',**{'class':'benevolent'},prior_art=p['prior_art'])
  else:
   require(type(project)==dict and project['id']==PROJECT and project['lead']==GUARDIAN and project['state']=='active' and project['safety_halted'] is False)
   if stage=='budget':
    require(budget is None);op='central_project_start';payload=dict(project=PROJECT,manager=GUARDIAN,evidence_digest=p['evidence_digest'])
   else:
    require(type(budget)==dict and budget['project']==PROJECT and budget['manager']==GUARDIAN and budget['policy']==POLICY and budget['allocation']=='10000000000' and budget['lifetime_ceiling']=='1000000000000000' and type(budget['round'])==int and budget['round']==1 and 0<number(budget['height'])<=h and type(budget['evidence_digest'])==str and HASH.fullmatch(budget['evidence_digest']) and budget['reserved']=='0' and budget['paid']=='0' and r['central_task/'+TASK] is None)
    config=r['central_fund_config/'+PROJECT];state=r['central_fund_state/'+PROJECT];plan=r['central_fund_plan/'+PROJECT+'/00000000000000000001']
    require(type(config)==dict and config.get('project')==PROJECT and type(config.get('evaluator'))==str and re.fullmatch('uain1[a-f0-9]{40}',config['evaluator']) and config['evaluator']!=GUARDIAN)
    require(type(state)==dict and type(state.get('revision'))==int and state['revision']==1 and type(state.get('approved_revision'))==int and state['approved_revision']==1 and state.get('pending')=='' and type(state.get('completed'))==int and state['completed']==0)
    require(type(plan)==dict and plan.get('project')==PROJECT and plan.get('manager')==GUARDIAN and type(plan.get('revision'))==int and plan['revision']==1 and plan.get('state')=='accept' and plan.get('reviewer')==config['evaluator'] and text(plan.get('main_kpi'),20,4096))
    stages=plan.get('stages');require(type(stages)==list and len(stages)==5)
    for n,item in enumerate(stages,1):require(exact(item,{'round','criteria'}) and type(item['round'])==int and item['round']==n and text(item['criteria'],20,4096))
    op='central_task_open';payload=dict(id=TASK,project=PROJECT,title=p['title'],criteria=p['criteria'],acceptance_digest=sha(p['criteria'].encode()),eligibility=p['eligibility'],eligibility_digest=p['evidence_digest'],solver_amount=p['solver_amount'],reviewer_amount=p['reviewer_amount'],evidence_digest=p['evidence_digest'])
 return dict(version=1,chain_id=CHAIN,member=GUARDIAN,sequence=m['sequence'],expires_height=str(h+100),operation=op,payload=payload)
def subject(c):return c['payload']['policy'] if c['operation']=='central_earning_activate' else c['payload'].get('id',c['payload'].get('project'))
def matches(e,c):return type(e)==dict and e.get('member')==GUARDIAN and e.get('operation')==c['operation'] and e.get('subject')==subject(c) and e.get('command_digest')==sha(native.signing_bytes(c)) and not e.get('instance') and not e.get('origin')
def sign(custody,c):
 key=native.strict_json(custody.attachment(custody.vault(),'keys/uain-review-key.json'));seed=bytearray(admission.public_key(key['private_key']))
 try:
  pub,signer=native.ed25519(bytes(seed));public=base64.urlsafe_b64encode(pub).decode().rstrip('=')
  require(public==key['public_key']==PUBLIC and 'uain1'+sha(pub)[:40]==GUARDIAN)
  envelope=dict(command=c,public_key=public,signature=base64.urlsafe_b64encode(signer(native.signing_bytes(c))).decode().rstrip('='))
  admission.verify_envelope(dict(guardian_public_key=PUBLIC),envelope,c);return envelope
 finally:
  for n in range(len(seed)):seed[n]=0

def process(p,stage,runtime,load,write,signer,now=time.time):
 """The caller holds the global custody lock and supplies protected persistence."""
 path=ROOT/(stage+'.json');plan_digest=sha(native.canonical({k:v for k,v in p.items() if k!='expires_at'}).encode());j=load(path)
 if j is None:
  s=runtime.read(dict(member=GUARDIAN,keys=keys()));c=command(p,s,stage,now=now());e=signer(c)
  admission.verify_envelope(dict(guardian_public_key=PUBLIC),e,c)
  j=dict(schema='uain-central-launch-send-once-v1',stage=stage,plan_digest=plan_digest,envelope=e,after_event=s['event_count'],cursor=s['event_count'],attempted=False)
  write(path,j)
 require(j['schema']=='uain-central-launch-send-once-v1' and j['stage']==stage and j['plan_digest']==plan_digest)
 e=j['envelope'];c=e['command'];admission.verify_envelope(dict(guardian_public_key=PUBLIC),e,c)
 require(c['operation']==dict(activate='central_earning_activate',project='open_project',budget='central_project_start',task='central_task_open')[stage])
 if j.get('receipt') is not None:return dict(status='finalized',receipt=j['receipt'],broadcasts_retried=False)
 if j.get('noninclusion') is not None:
  evidence=j['noninclusion'];require(evidence['command_digest']==sha(native.signing_bytes(c)) and evidence['reader_sha256']==READER_SHA and evidence['genesis_sha256']==GENESIS and number(evidence['height'])>number(c['expires_height']) and evidence['through_event']==j['cursor'])
  return dict(status='expired_not_included',evidence=evidence,broadcasts_retried=False)
 if not j['attempted']:
  s=runtime.read(dict(member=GUARDIAN,keys=keys()))
  if number(s['height'])<number(c['expires_height']) and s['member']['sequence']==c['sequence']:
   expected=command(p,s,stage,now=now())
   require({k:v for k,v in c.items() if k!='expires_height'}=={k:v for k,v in expected.items() if k!='expires_height'})
   j['attempted']=True;write(path,j)
   try:j['broadcast_code']=runtime.broadcast(e)
   except Exception:j['broadcast_code']=None
   write(path,j)
  # Expired or superseded signed bytes remain intact and are only scanned;
  # no replacement envelope is authorized by this bounded launch.
 # Recovery deliberately does not revalidate expiring launch authority or
 # pre-send absence: finality must remain discoverable after the action.
 s=runtime.read(dict(member=GUARDIAN,keys=[]));cursor=number(j['cursor']);count=number(s['event_count']);require(number(j['after_event'])<=cursor<=count)
 end=min(count,cursor+16);selected=[admission.event_key(n) for n in range(cursor+1,end+1)]
 if selected:
  s=runtime.read(dict(member=GUARDIAN,keys=selected))
  for k in selected:
   event=s['records'][k];require(type(event)==dict and admission.event_key(number(event['id']))==k)
   if event.get('command_digest')!=sha(native.signing_bytes(c)):continue
   require(matches(event,c));proved=runtime.read(dict(member=GUARDIAN,keys=[],receipt=dict(envelope=e,event_id=event['id'])));receipt=proved['receipt']
   require(receipt['authority']=='native' and receipt['finalized'] is True and receipt['chain_id']==CHAIN and receipt['state_height']==proved['height'] and receipt['app_hash']==proved['app_hash'] and receipt['event']==event and number(proved['member']['sequence'])>number(c['sequence']))
   j['receipt']=receipt;write(path,j);return dict(status='finalized',receipt=receipt,broadcasts_retried=False)
 j['scan_digest']=sha((j.get('scan_digest','0'*64)+'\n'+native.canonical(dict(from_event=str(cursor+1),through_event=str(end),height=s['height'],app_hash=s['app_hash'],events=[s['records'][key] for key in selected]))).encode())
 j['cursor']=str(end)
 if end==number(s['event_count']) and number(s['height'])>number(c['expires_height']):
  j['noninclusion']=dict(authority='native',chain_id=CHAIN,genesis_sha256=GENESIS,reader_sha256=READER_SHA,command_digest=sha(native.signing_bytes(c)),after_event=j['after_event'],through_event=str(end),height=s['height'],header_time=s['header_time'],app_hash=s['app_hash'],scan_digest=j['scan_digest'],attempted=j['attempted'])
  write(path,j);return dict(status='expired_not_included',evidence=j['noninclusion'],broadcasts_retried=False)
 write(path,j);return dict(status='pending',broadcasts_retried=False,broadcast_code=j.get('broadcast_code'))

def run(stage):
 require(os.geteuid()==0 and stage in ('activate','project','budget','task'));disable_core();os.umask(0o077)
 import central_reviewer as locking
 import custody
 admission.ensure_directory(ROOT)
 with locking.locked():
  p=admission.load(ROOT/'plan.json');admission.TEMP=ROOT/'proofs';admission.ensure_directory(admission.TEMP)
  runtime=admission.Runtime(proof_policy(admission.load(admission.POLICY)))
  return process(p,stage,runtime,lambda path:admission.load(path) if path.exists() else None,admission.atomic,lambda c:sign(custody,c))
if __name__=='__main__':
 try:
  require(len(sys.argv)==2);print(json.dumps(run(sys.argv[1]),separators=(',',':')))
 except Exception as error:print(json.dumps(dict(status='refused',error_type=type(error).__name__)),file=sys.stderr);sys.exit(1)

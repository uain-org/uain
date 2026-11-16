"""Bounded S6 evidence-window activation: one guardian command, nothing else.

Policy `central-evidence-window-v1` (chain/federation/central_evidence.go, S6
default of 9 November 2026): after a reviewer's needs_evidence the author may
send one linked revision or ask for one reassessment within `window_blocks`;
after it the request expires and the task reopens. The chain rule waits for a
one-shot guardian record `central_evidence_activation`; this tool signs only
that command, `central_evidence_activate`, with the fixed payload from a plan a
person reviewed: the policy, window_blocks 129600 (72 hours at 2 s blocks) and
the evidence digest. It mints nothing and moves no AI$.

Pattern: karma_launch.py. It runs as root from pinned sources, signs inside the
vault, journals the envelope before broadcasting, builds the command only from
a fresh pinned proof, accepts only the exact proven receipt, and holds the
shared custody lock until the command is included or proved expired, so the
central reviewer and the task-stock tool (same guardian key and sequence) wait.
The chain refuses a second activation, so a retry after proved non-inclusion
is safe. It refuses once a guardian epoch exists or the guardian set is no
longer the single original guardian.

Usage (root, isolated interpreter, pinned sources):
  evidence_window_launch.py status     read-only: proves the activation record (or its absence)
  evidence_window_launch.py activate   the one activation
"""
import base64,hashlib,json,os,re,sys,time,resource,stat,types
from pathlib import Path
SOURCE_MANIFEST=Path('/etc/uain-custody/evidence-window-launch-sources.json')
SOURCE_NAMES=('native_migration','guardian_quorum','native_admission','holder_release','central_reviewer','custody','evidence_window_launch')
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
 if not value:raise ValueError('Pinned evidence-window launch source refused')
def bootstrap_sources(directory=None,manifest=None):
 require_source(os.geteuid()==0);sys.dont_write_bytecode=True
 directory=Path(__file__).absolute().parent if directory is None else Path(directory)
 manifest=SOURCE_MANIFEST if manifest is None else Path(manifest)
 def unique(pairs):
  value={}
  for key,item in pairs:require_source(key not in value);value[key]=item
  return value
 approved=json.loads(source_read(manifest),object_pairs_hook=unique)
 require_source(type(approved)==dict and set(approved)=={'schema','sha256'} and approved['schema']=='uain-evidence-window-launch-sources-v1')
 pins=approved['sha256'];require_source(type(pins)==dict and set(pins)=={name+'.py' for name in SOURCE_NAMES})
 sources={}
 for name in SOURCE_NAMES:
  raw=source_read(directory/(name+'.py'));pin=pins[name+'.py']
  require_source(type(pin)==str and re.fullmatch('[a-f0-9]{64}',pin) and hashlib.sha256(raw).hexdigest()==pin)
  sources[name]=compile(raw,str(directory/(name+'.py')),'exec',dont_inherit=True)
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
POLICY='central-evidence-window-v1'
WINDOW_BLOCKS='129600'
OPERATION='central_evidence_activate'
ROOT=Path('/var/lib/uain-custody/evidence-window-20261110')
HASH=re.compile(r'^[a-f0-9]{64}$');UINT=re.compile(r'^(0|[1-9][0-9]{0,19})$');ADDRESS=re.compile(r'^uain1[a-f0-9]{40}$')
KEYS=['guardians','guardian_epoch_current','central_earning_activation','central_evidence_activation']
BATCH=16
sha=lambda raw:hashlib.sha256(raw).hexdigest()
def require(v):
 if not v:raise ValueError('Bounded evidence-window launch refused')
def exact(v,fields):return type(v)==dict and set(v)==set(fields)
def number(v):require(type(v)==str and UINT.fullmatch(v));return int(v)

def validate(p):
 """plan.json: reviewed by a person before the send."""
 require(exact(p,{'schema','chain_id','genesis_sha256','policy','window_blocks','evidence_digest'}))
 require(p['schema']=='uain-evidence-window-launch-v1' and p['chain_id']==CHAIN and p['genesis_sha256']==GENESIS and p['policy']==POLICY and p['window_blocks']==WINDOW_BLOCKS)
 require(type(p['evidence_digest'])==str and HASH.fullmatch(p['evidence_digest']))
 return p
def proof_policy(p):
 require(p['chain_id']==CHAIN and p['genesis_sha256']==GENESIS and p['state_sha256']==READER_SHA and p['guardian']==GUARDIAN and p['guardian_public_key']==PUBLIC)
 return p
def fresh(s,now):
 require(s['chain_id']==CHAIN and type(s['app_hash'])==str and HASH.fullmatch(s['app_hash']))
 import datetime
 t=datetime.datetime.fromisoformat(s['header_time'].replace('Z','+00:00'));require(t.tzinfo is not None and -60<=now-t.timestamp()<=120)
 h=number(s['height']);require(0<h<9223372036854775707);number(s['event_count'])
 m=s['member'];require(m['id']==GUARDIAN and m['public_key']==PUBLIC and m['licence']=='active' and number(m['sequence'])<18446744073709551615)
 r=s['records'];require('guardians' in r and GUARDIAN in r['guardians'])
 return h,r,m
def activation(r):
 """The proved activation record, strictly shaped, or None."""
 a=r['central_evidence_activation']
 if a is None:return None
 require(exact(a,{'policy','window_blocks','height','approved_by','evidence_digest'}) and a['policy']==POLICY and a['approved_by']==GUARDIAN and HASH.fullmatch(a['evidence_digest']))
 return dict(height=number(a['height']),window_blocks=number(a['window_blocks']),evidence_digest=a['evidence_digest'])

def command(p,s,now=None):
 now=time.time() if now is None else now;validate(p);h,r,m=fresh(s,now)
 # Only while the original guardian alone still governs, central earning is on, and S6 is not yet active.
 require(activation(r) is None and r['guardian_epoch_current'] is None and r['guardians']==[GUARDIAN])
 e=r['central_earning_activation'];require(type(e)==dict and ADDRESS.fullmatch(e.get('reviewer','')) and number(e.get('height'))<=h)
 payload=dict(policy=POLICY,window_blocks=WINDOW_BLOCKS,evidence_digest=p['evidence_digest'])
 return dict(version=1,chain_id=CHAIN,member=GUARDIAN,sequence=m['sequence'],expires_height=str(h+100),operation=OPERATION,payload=payload)
def matches(e,c):return type(e)==dict and e.get('member')==GUARDIAN and e.get('operation')==OPERATION and e.get('subject')==POLICY and e.get('command_digest')==sha(native.signing_bytes(c)) and not e.get('instance') and not e.get('origin')
def sign(custody,c):
 require(c['operation']==OPERATION and c['member']==GUARDIAN)
 key=native.strict_json(custody.attachment(custody.vault(),'keys/uain-review-key.json'));seed=bytearray(admission.public_key(key['private_key']))
 try:
  pub,signer=native.ed25519(bytes(seed));public=base64.urlsafe_b64encode(pub).decode().rstrip('=')
  require(public==key['public_key']==PUBLIC and 'uain1'+sha(pub)[:40]==GUARDIAN)
  envelope=dict(command=c,public_key=public,signature=base64.urlsafe_b64encode(signer(native.signing_bytes(c))).decode().rstrip('='))
  admission.verify_envelope(dict(guardian_public_key=PUBLIC),envelope,c);return envelope
 finally:
  for n in range(len(seed)):seed[n]=0
def plan_digest(p):return sha(native.canonical(validate(p)).encode())

def process(p,runtime,load,write,signer,now=time.time):
 """Send-once. The caller holds the global custody lock."""
 path=ROOT/'journal'/'activate.json';digest=plan_digest(p);j=load(path)
 if j is not None and j.get('noninclusion') is not None:
  # Proven not included and expired; the chain refuses a duplicate, so a new attempt is safe. The old journal is kept.
  attempts=j.get('attempts',1);write(path.with_name('activate.expired-'+str(attempts)+'.json'),j);j=None
 else:attempts=0 if j is None else j.get('attempts',1)
 if j is None:
  s=runtime.read(dict(member=GUARDIAN,keys=KEYS));c=command(p,s,now=now());e=signer(c)
  admission.verify_envelope(dict(guardian_public_key=PUBLIC),e,c)
  j=dict(schema='uain-evidence-window-send-once-v1',plan_digest=digest,envelope=e,after_event=s['event_count'],cursor=s['event_count'],attempted=False,attempts=attempts+1)
  write(path,j)
 require(j['schema']=='uain-evidence-window-send-once-v1' and j['plan_digest']==digest)
 e=j['envelope'];c=e['command'];admission.verify_envelope(dict(guardian_public_key=PUBLIC),e,c);require(c['operation']==OPERATION)
 if j.get('receipt') is not None:return dict(status='finalized',receipt_event=j['receipt']['event']['id'])
 if not j['attempted']:
  s=runtime.read(dict(member=GUARDIAN,keys=KEYS))
  if number(s['height'])<number(c['expires_height']) and s['member']['sequence']==c['sequence']:
   expected=command(p,s,now=now())
   require({k:v for k,v in c.items() if k!='expires_height'}=={k:v for k,v in expected.items() if k!='expires_height'})
   j['attempted']=True;write(path,j)
   try:j['broadcast_code']=runtime.broadcast(e)
   except Exception:j['broadcast_code']=None
   write(path,j)
 s=runtime.read(dict(member=GUARDIAN,keys=[]));cursor=number(j['cursor']);count=number(s['event_count']);require(number(j['after_event'])<=cursor<=count)
 end=min(count,cursor+BATCH);selected=[admission.event_key(n) for n in range(cursor+1,end+1)]
 if selected:
  s=runtime.read(dict(member=GUARDIAN,keys=selected))
  for k in selected:
   event=s['records'][k];require(type(event)==dict and admission.event_key(number(event['id']))==k)
   if event.get('command_digest')!=sha(native.signing_bytes(c)):continue
   require(matches(event,c));proved=runtime.read(dict(member=GUARDIAN,keys=[],receipt=dict(envelope=e,event_id=event['id'])));receipt=proved['receipt']
   require(receipt['authority']=='native' and receipt['finalized'] is True and receipt['chain_id']==CHAIN and receipt['state_height']==proved['height'] and receipt['app_hash']==proved['app_hash'] and receipt['event']==event and number(proved['member']['sequence'])>number(c['sequence']))
   j['receipt']=receipt;write(path,j);return dict(status='finalized',receipt_event=event['id'])
 j['cursor']=str(end)
 if end==number(s['event_count']) and number(s['height'])>number(c['expires_height']):
  j['noninclusion']=dict(command_digest=sha(native.signing_bytes(c)),through_event=str(end),height=s['height'],app_hash=s['app_hash'])
  write(path,j);return dict(status='expired_not_included',broadcast_code=j.get('broadcast_code'))
 write(path,j);return dict(status='pending',broadcast_code=j.get('broadcast_code'))

def run(stage):
 require(os.geteuid()==0 and stage in ('status','activate'));disable_core();os.umask(0o077)
 import central_reviewer as locking
 import custody
 admission.ensure_directory(ROOT);admission.ensure_directory(ROOT/'journal')
 with locking.locked():
  admission.TEMP=ROOT/'proofs';admission.ensure_directory(admission.TEMP);policy=proof_policy(admission.load(admission.POLICY))
  if stage=='status':
   s=admission.Runtime(policy).read(dict(member=GUARDIAN,keys=KEYS));r=s['records']
   return dict(height=s['height'],app_hash=s['app_hash'],activation=activation(r),guardians=r['guardians'],guardian_epoch=r['guardian_epoch_current'])
  p=validate(admission.load(ROOT/'plan.json'))
  journal=lambda path:admission.load(path) if path.exists() else None
  out=process(p,admission.Runtime(policy),journal,admission.atomic,lambda c:sign(custody,c))
  # Keep the custody lock until the command is included or expires, so no other
  # guardian tool reads the same sequence while this one is still in the mempool.
  for _ in range(15):
   if out['status']!='pending':break
   time.sleep(3);out=process(p,admission.Runtime(policy),journal,admission.atomic,lambda c:sign(custody,c))
  return out
if __name__=='__main__':
 try:
  require(len(sys.argv)==2);print(json.dumps(run(sys.argv[1]),separators=(',',':')))
 except Exception as error:print(json.dumps(dict(status='refused',error_type=type(error).__name__)),file=sys.stderr);sys.exit(1)

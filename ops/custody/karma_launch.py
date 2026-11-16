"""Bounded Karma v2 launch: one activation, then the reviewed backfill.

Decisions DEC-TASK-057 and DEC-CHAIN-039 (9 November 2026): Karma never falls,
penalties become strikes, and every accepted AI$ award also gives Karma. The
chain rule is `uain-karma-v2` (chain/federation/karma_policy.go).

This tool signs only three guardian operations, each with a fixed payload
shape: karma_policy_activate, karma_central_backfill and karma_penalty_convert.
It mints nothing and moves no AI$. Every send is journaled before I/O. A
command is only built from a fresh pinned proof, and the chain itself refuses
a second activation, a second backfill of the same award and a second
conversion of the same entry, so a retry after proven non-inclusion is safe.

Usage (root, isolated interpreter, pinned sources):
  karma_launch.py inventory   read-only: proves what the backfill must cover
  karma_launch.py activate    the one activation
  karma_launch.py backfill    the next award in plan.json, or 'done'
  karma_launch.py convert     the next penalty entry in plan.json, or 'done'
  karma_launch.py status      read-only: proves every plan item's marker
"""
import base64,hashlib,json,os,re,sys,time,resource,stat,types
from pathlib import Path
SOURCE_MANIFEST=Path('/etc/uain-custody/karma-launch-sources.json')
SOURCE_NAMES=('native_migration','guardian_quorum','native_admission','holder_release','central_reviewer','custody','karma_launch')
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
 if not value:raise ValueError('Pinned Karma launch source refused')
def bootstrap_sources(directory=None,manifest=None):
 require_source(os.geteuid()==0);sys.dont_write_bytecode=True
 directory=Path(__file__).absolute().parent if directory is None else Path(directory)
 manifest=SOURCE_MANIFEST if manifest is None else Path(manifest)
 def unique(pairs):
  value={}
  for key,item in pairs:require_source(key not in value);value[key]=item
  return value
 approved=json.loads(source_read(manifest),object_pairs_hook=unique)
 require_source(type(approved)==dict and set(approved)=={'schema','sha256'} and approved['schema']=='uain-karma-launch-sources-v1')
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
POLICY='uain-karma-v2'
ROOT=Path('/var/lib/uain-custody/karma-v2-20261110')
OPERATION=dict(activate='karma_policy_activate',backfill='karma_central_backfill',convert='karma_penalty_convert')
HASH=re.compile(r'^[a-f0-9]{64}$');UINT=re.compile(r'^(0|[1-9][0-9]{0,19})$')
ENTRY=re.compile(r'^[0-9]{20}$');SUBMISSION=re.compile(r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
ADDRESS=re.compile(r'^uain1[a-f0-9]{40}$')
BATCH=16
sha=lambda raw:hashlib.sha256(raw).hexdigest()
def require(v):
 if not v:raise ValueError('Bounded Karma launch refused')
def exact(v,fields):return type(v)==dict and set(v)==set(fields)
def number(v):require(type(v)==str and UINT.fullmatch(v));return int(v)
def counter(v):
 if v is None:return 0
 require(type(v)==int and type(v)!=bool and 0<=v<2**64);return v
def entry_key(n):return 'karma/'+str(n).zfill(20)
def award_key(role,submission):return 'central_award/'+role+'/'+submission
def marker_key(stage,item):return 'karma_backfill/central/'+item['role']+'/'+item['submission'] if stage=='backfill' else 'karma_backfill/penalty/'+item['entry']

def validate(p):
 """plan.json: reviewed by a person before any send; built from `inventory`."""
 require(exact(p,{'schema','chain_id','genesis_sha256','policy','evidence_digest','backfill','convert'}))
 require(p['schema']=='uain-karma-launch-v1' and p['chain_id']==CHAIN and p['genesis_sha256']==GENESIS and p['policy']==POLICY)
 require(type(p['evidence_digest'])==str and HASH.fullmatch(p['evidence_digest']))
 require(type(p['backfill'])==list and len(p['backfill'])<=100000 and type(p['convert'])==list and len(p['convert'])<=100000)
 seen=set()
 for item in p['backfill']:
  require(exact(item,{'submission','role'}) and type(item['submission'])==str and SUBMISSION.fullmatch(item['submission']) and item['role'] in ('solver','reviewer'))
  ref=item['role']+'/'+item['submission'];require(ref not in seen);seen.add(ref)
 for item in p['convert']:
  require(exact(item,{'entry'}) and type(item['entry'])==str and ENTRY.fullmatch(item['entry']));require(item['entry'] not in seen);seen.add(item['entry'])
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
 a=r['karma_policy_activation']
 if a is None:return None
 require(exact(a,{'policy','height','approved_by','evidence_digest'}) and a['policy']==POLICY and a['approved_by']==GUARDIAN and HASH.fullmatch(a['evidence_digest']))
 return number(a['height'])
def keys(stage,item=None):
 base=['guardians','guardian_epoch_current','karma_policy_activation']
 if stage=='backfill':return base+[award_key(item['role'],item['submission']),marker_key(stage,item)]
 if stage=='convert':return base+[entry_key(int(item['entry'])),marker_key(stage,item)]
 return base

def command(p,s,stage,item=None,now=None):
 now=time.time() if now is None else now;validate(p);h,r,m=fresh(s,now)
 require(stage in OPERATION);active=activation(r)
 if stage=='activate':
  # First activation, while the original guardian alone still governs.
  require(item is None and active is None and r['guardian_epoch_current'] is None and r['guardians']==[GUARDIAN])
  payload=dict(policy=POLICY,evidence_digest=p['evidence_digest'])
 else:
  # The rule applies from the activation height; the command must land after it.
  require(active is not None and h>=active and r[marker_key(stage,item)] is None)
  if stage=='backfill':
   require(item in p['backfill']);a=r[award_key(item['role'],item['submission'])]
   require(type(a)==dict and a.get('submission')==item['submission'] and a.get('role')==item['role'] and type(a.get('member'))==str and ADDRESS.fullmatch(a['member']))
   number(a.get('amount'));require(number(a.get('height'))<active)
   payload=dict(submission=item['submission'],role=item['role'])
  else:
   require(item in p['convert']);e=r[entry_key(int(item['entry']))]
   require(type(e)==dict and e.get('id')==item['entry'] and type(e.get('delta'))==int and type(e['delta'])!=bool and -2**63<e['delta']<0)
   payload=dict(entry=item['entry'])
 return dict(version=1,chain_id=CHAIN,member=GUARDIAN,sequence=m['sequence'],expires_height=str(h+100),operation=OPERATION[stage],payload=payload)
def subject(c):return c['payload'].get('policy') or c['payload'].get('submission') or c['payload'].get('entry')
def matches(e,c):return type(e)==dict and e.get('member')==GUARDIAN and e.get('operation')==c['operation'] and e.get('subject')==subject(c) and e.get('command_digest')==sha(native.signing_bytes(c)) and not e.get('instance') and not e.get('origin')
def sign(custody,c):
 require(c['operation'] in OPERATION.values() and c['member']==GUARDIAN)
 key=native.strict_json(custody.attachment(custody.vault(),'keys/uain-review-key.json'));seed=bytearray(admission.public_key(key['private_key']))
 try:
  pub,signer=native.ed25519(bytes(seed));public=base64.urlsafe_b64encode(pub).decode().rstrip('=')
  require(public==key['public_key']==PUBLIC and 'uain1'+sha(pub)[:40]==GUARDIAN)
  envelope=dict(command=c,public_key=public,signature=base64.urlsafe_b64encode(signer(native.signing_bytes(c))).decode().rstrip('='))
  admission.verify_envelope(dict(guardian_public_key=PUBLIC),envelope,c);return envelope
 finally:
  for n in range(len(seed)):seed[n]=0

def stage_digest(p,stage):
 # Activation binds only its evidence; the backfill lists are added after it.
 return sha(native.canonical(dict(evidence_digest=p['evidence_digest']) if stage=='activate' else p).encode())
def item_name(stage,item):return 'activate' if stage=='activate' else stage+'-'+(item['role']+'-'+item['submission'] if stage=='backfill' else item['entry'])
def process(p,stage,item,runtime,load,write,signer,now=time.time):
 """Send-once for one item. The caller holds the global custody lock."""
 path=ROOT/'journal'/(item_name(stage,item)+'.json');plan_digest=stage_digest(p,stage);j=load(path)
 if j is not None and j.get('noninclusion') is not None:
  # Proven not included and expired. The chain refuses duplicates, so a new
  # attempt is safe; the old journal is kept beside it.
  attempts=j.get('attempts',1);write(path.with_name(path.stem+'.expired-'+str(attempts)+'.json'),j);j=None
 else:attempts=0 if j is None else j.get('attempts',1)
 if j is None:
  s=runtime.read(dict(member=GUARDIAN,keys=keys(stage,item)));c=command(p,s,stage,item,now=now());e=signer(c)
  admission.verify_envelope(dict(guardian_public_key=PUBLIC),e,c)
  j=dict(schema='uain-karma-launch-send-once-v1',stage=stage,item=item,plan_digest=plan_digest,envelope=e,after_event=s['event_count'],cursor=s['event_count'],attempted=False,attempts=attempts+1)
  write(path,j)
 require(j['schema']=='uain-karma-launch-send-once-v1' and j['stage']==stage and j['item']==item and j['plan_digest']==plan_digest)
 e=j['envelope'];c=e['command'];admission.verify_envelope(dict(guardian_public_key=PUBLIC),e,c);require(c['operation']==OPERATION[stage])
 if j.get('receipt') is not None:return dict(status='finalized',item=item,receipt_event=j['receipt']['event']['id'])
 if not j['attempted']:
  s=runtime.read(dict(member=GUARDIAN,keys=keys(stage,item)))
  if number(s['height'])<number(c['expires_height']) and s['member']['sequence']==c['sequence']:
   expected=command(p,s,stage,item,now=now())
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
   j['receipt']=receipt;write(path,j);return dict(status='finalized',item=item,receipt_event=event['id'])
 j['cursor']=str(end)
 if end==number(s['event_count']) and number(s['height'])>number(c['expires_height']):
  j['noninclusion']=dict(command_digest=sha(native.signing_bytes(c)),through_event=str(end),height=s['height'],app_hash=s['app_hash'])
  write(path,j);return dict(status='expired_not_included',item=item,broadcast_code=j.get('broadcast_code'))
 write(path,j);return dict(status='pending',item=item,broadcast_code=j.get('broadcast_code'))

def next_item(p,stage,read):
 """The first plan item whose chain marker is still absent, proved."""
 items=p[stage]
 for start in range(0,len(items),BATCH):
  chunk=items[start:start+BATCH];s=read([marker_key(stage,i) for i in chunk])
  for i in chunk:
   if s['records'][marker_key(stage,i)] is None:return i
 return None

def scan(read,first,last,key):
 """Proved records for key(n), n in [first,last], in bounded batches."""
 out={}
 for start in range(first,last+1,BATCH):
  ks=[key(n) for n in range(start,min(last,start+BATCH-1)+1)];s=read(ks)
  for k in ks:out[k]=s['records'][k]
 return out
def inventory(read):
 """Read-only. Every award paid before activation and every negative Karma row."""
 s=read(['event_count','karma_count','karma_policy_activation'])
 r=s['records'];active=activation(r);events=number(s['event_count']);rows=counter(r['karma_count'])
 subjects=[]
 for k,event in scan(read,1,events,admission.event_key).items():
  require(type(event)==dict)
  if event.get('operation')=='central_review':subjects.append(event['subject'])
 subjects=sorted(set(subjects));backfill=[];karma_due=0;skipped_after=0
 for start in range(0,len(subjects),BATCH//2):
  chunk=subjects[start:start+BATCH//2];ks=[award_key(role,sub) for sub in chunk for role in ('solver','reviewer')];got=read(ks)['records']
  for sub in chunk:
   for role in ('solver','reviewer'):
    a=got[award_key(role,sub)]
    if a is None:continue
    require(a['submission']==sub and a['role']==role)
    if active is not None and number(a['height'])>=active:skipped_after+=1;continue
    backfill.append(dict(submission=sub,role=role));karma_due+=number(a['amount'])//1000000
 convert=[];restored=0
 for k,e in scan(read,1,rows,entry_key).items():
  require(type(e)==dict and e['id']==k.split('/')[1])
  if e['delta']<0:convert.append(dict(entry=e['id']));restored+=-e['delta']
 return dict(height=s['height'],app_hash=s['app_hash'],activation_height=None if active is None else str(active),events=str(events),karma_rows=str(rows),
  central_review_subjects=len(subjects),backfill=backfill,backfill_karma=karma_due,awards_after_activation=skipped_after,convert=convert,convert_karma=restored)

def run(stage):
 require(os.geteuid()==0 and stage in ('inventory','activate','backfill','convert','status'));disable_core();os.umask(0o077)
 import central_reviewer as locking
 import custody
 admission.ensure_directory(ROOT);admission.ensure_directory(ROOT/'journal')
 with locking.locked():
  admission.TEMP=ROOT/'proofs';admission.ensure_directory(admission.TEMP);policy=proof_policy(admission.load(admission.POLICY))
  def read(ks):return admission.Runtime(policy).read(dict(member=GUARDIAN,keys=list(ks)))
  if stage=='inventory':return inventory(read)
  p=validate(admission.load(ROOT/'plan.json'))
  if stage=='status':
   out={}
   for name in ('backfill','convert'):
    done=0
    for start in range(0,len(p[name]),BATCH):
     chunk=p[name][start:start+BATCH];got=read([marker_key(name,i) for i in chunk])['records'];done+=sum(1 for i in chunk if got[marker_key(name,i)] is not None)
    out[name]=dict(planned=len(p[name]),done=done)
   out['activation_height']=read(['karma_policy_activation'])['records']['karma_policy_activation'];return out
  item=None
  if stage!='activate':
   item=next_item(p,stage,read)
   if item is None:return dict(status='done',stage=stage)
  journal=lambda path:admission.load(path) if path.exists() else None
  out=process(p,stage,item,admission.Runtime(policy),journal,admission.atomic,lambda c:sign(custody,c))
  # Keep the custody lock until the command is included or expires, so no other
  # guardian tool reads the same sequence while this one is still in the mempool.
  for _ in range(15):
   if out['status']!='pending':break
   time.sleep(3);out=process(p,stage,item,admission.Runtime(policy),journal,admission.atomic,lambda c:sign(custody,c))
  return out
if __name__=='__main__':
 try:
  require(len(sys.argv)==2);print(json.dumps(run(sys.argv[1]),separators=(',',':')))
 except Exception as error:print(json.dumps(dict(status='refused',error_type=type(error).__name__)),file=sys.stderr);sys.exit(1)

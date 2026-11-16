"""Fixed two-member identity/role bootstrap; sign-only, preflight by default.

Both identities explicitly belong to one operator. Appointment neither starts a
reviewer service nor establishes independent research review. No broadcast,
Karma, funds, project, task, payment, issuance or arbitrary target is exposed.
"""
import base64,datetime,fcntl,json,os,re,resource,stat,time
from pathlib import Path
import native_migration as native
import native_admission as admission
import native_financial_activation as financial

CHAIN=native.CHAIN
GENESIS=native.GENESIS
ROOT=Path('/var/lib/uain-custody/native-payment-bootstrap')
OPERATOR='United AI Network (Rahul Jalan)'
TARGETS={
 'guardian':dict(member='uain158ac8d0debcf01d43164ef14736597da589d8b54',public_key='mDuiMoDUKg66PitMD-j1pztm81wOKlYq7nFFCWLXoRI',attachment='keys/uain-review-key.json'),
 'claude':dict(member='uain17fae025e2b7492156d438712aab8efcb4113b0fd',public_key='wpwtSOfm7XkVbHxuo5hXx6VOusc_DVFutMfYi8EiiWw',attachment='local/work/prod/claude-lead/key.json'),
}
ACTIVATION_EVIDENCE='c8467e4fd7624d7744f6d44a947513b8e4d94becd6f5a7189ff55648384b6fe4'
POLICIES=financial.POLICIES
PRIVATE_RELAYER='uain1215c651b70db82b70532a496c26fdf424f3bb369'
APPROVAL_SCHEMA='uain-native-payment-bootstrap-approval-v1'
EVIDENCE_SCHEMA='uain-native-payment-bootstrap-readiness-v1'
BATCH_SCHEMA='uain-native-payment-bootstrap-envelopes-v1'
JOURNAL_SCHEMA='uain-native-payment-bootstrap-journal-v1'
CONTROLS=dict(independent_operators=False,service_available_by_appointment=False,karma_change=False,credit_conversion=False,mint=False,payment=False,research_acceptance=False,claude_default_verifier=False)
APPROVAL_FIELDS={'schema','epoch','phase','chain_id','genesis','genesis_sha256','state_binary','state_sha256','daemon_binary','daemon_sha256','evidence_sha256','actors','expected_event_count','expected_last_command_digest','expires_at','expires_height'}
ACTOR_FIELDS={'sequence','karma','credits','creator','default_verifier','identity_sha256','private_reviewer_sha256'}
EVIDENCE_FIELDS={'schema','chain_id','genesis_sha256','state_sha256','daemon_sha256','operator','authorization','controls','reviewer','acceptance'}
HEX=financial.HEX
canonical=native.canonical
sha=native.sha
decimal=native.decimal
event_key=admission.event_key
validate_artifacts=financial.validate_artifacts
load=financial.load

def require(ok):
 if not ok:raise ValueError('Native payment bootstrap authorization refused')
def did(member):return 'did:uain:'+sha(('UAIN ACTOR IDENTITY V1\n'+member+'\n').encode())
def record_hash(record):return None if record is None else sha(canonical(record).encode())
def text(value,minimum=1,maximum=4000):return type(value)==str and minimum<=len(value.encode())<=maximum and not any(ord(c)<32 for c in value)

def approval(a):
 require(type(a)==dict and set(a)==APPROVAL_FIELDS)
 require(a['schema']==APPROVAL_SCHEMA and type(a['epoch'])==str and re.fullmatch(r'[a-f0-9]{32}',a['epoch']) and a['phase'] in ('identity','roles'))
 require(a['chain_id']==CHAIN and a['genesis_sha256']==GENESIS)
 for field in ('genesis','state_binary','daemon_binary'):require(type(a[field])==str and Path(a[field]).is_absolute())
 for field in ('state_sha256','daemon_sha256','evidence_sha256'):require(type(a[field])==str and HEX.fullmatch(a[field]))
 decimal(a['expected_event_count']);decimal(a['expires_height'],2**63-1)
 require(type(a['expires_at'])==int and (a['expected_last_command_digest']=='' if a['expected_event_count']=='0' else type(a['expected_last_command_digest'])==str and HEX.fullmatch(a['expected_last_command_digest'])))
 require(type(a['actors'])==dict and set(a['actors'])==set(TARGETS))
 for name,t in TARGETS.items():
  require('uain1'+sha(admission.public_key(t['public_key']))[:40]==t['member'])
  actor=a['actors'][name];require(type(actor)==dict and set(actor)==ACTOR_FIELDS)
  decimal(actor['sequence']);decimal(actor['credits']);require(type(actor['karma'])==int and -(2**63)<=actor['karma']<2**63)
  require(actor['creator'] is False and actor['default_verifier'] is False)
  for key in ('identity_sha256','private_reviewer_sha256'):require(actor[key] is None or type(actor[key])==str and HEX.fullmatch(actor[key]))
  # Bootstrap is not authority to replace an existing reviewer appointment.
  require(actor['private_reviewer_sha256'] is None)
  if a['phase']=='roles':require(actor['identity_sha256'] is not None)
 require(a['actors']['claude']['karma']>=100)
 return a

def evidence(a,raw):
 require(type(raw)==bytes and 1<=len(raw)<=1024*1024 and sha(raw)==a['evidence_sha256'])
 e=native.strict_json(raw);require(type(e)==dict and set(e)==EVIDENCE_FIELDS and e['schema']==EVIDENCE_SCHEMA)
 for key in ('chain_id','genesis_sha256','state_sha256','daemon_sha256'):require(e[key]==a[key])
 require(e['operator']==OPERATOR and text(e['authorization'],20))
 require(type(e['controls'])==dict and set(e['controls'])==set(CONTROLS) and all(e['controls'][key] is False for key in CONTROLS))
 r=e['reviewer'];require(type(r)==dict and set(r)=={'member','public_key','owned_key_qualified','orchard_qualified','service_available','service_status'})
 require(r['member']==TARGETS['claude']['member'] and r['public_key']==TARGETS['claude']['public_key'] and r['owned_key_qualified'] is True and r['orchard_qualified'] is True and type(r['service_available'])==bool and text(r['service_status'],20))
 require(type(e['acceptance'])==list and 1<=len(e['acceptance'])<=16)
 paths=[]
 for item in e['acceptance']:
  require(type(item)==dict and set(item)=={'path','sha256'} and type(item['path'])==str and Path(item['path']).is_absolute() and type(item['sha256'])==str and HEX.fullmatch(item['sha256']));paths.append(item['path'])
 require(len(set(paths))==len(paths));return e

def commands(a):
 result=[];guardian=TARGETS['guardian']['member']
 if a['phase']=='identity':
  for name,t in TARGETS.items():
   if a['actors'][name]['identity_sha256'] is None:result.append(dict(version=1,chain_id=CHAIN,member=t['member'],sequence=a['actors'][name]['sequence'],expires_height=a['expires_height'],operation='identity_claim',payload=dict(operator=OPERATOR)))
 else:
  for index,(operation,payload) in enumerate([('roles',dict(member=guardian,creator=True,default_verifier=True)),('private_reviewer',dict(member=TARGETS['claude']['member'],active=True))]):
   payload['evidence_digest']=a['evidence_sha256'];result.append(dict(version=1,chain_id=CHAIN,member=guardian,sequence=str(decimal(a['actors']['guardian']['sequence'])+index),expires_height=a['expires_height'],operation=operation,payload=payload))
 return result

def binding(record,reverse,target,count):
 if record is None:require(reverse is None);return
 require(type(record)==dict and set(record)=={'member','did','operator','origin','approved_by','event_id','at'})
 require(record['member']==target['member'] and record['did']==did(target['member']) and record['operator']==OPERATOR and record['origin']=='member-derived' and record['approved_by']==target['member'] and reverse==target['member']+'/')
 require(1<=decimal(record['event_id'])<=count and text(record['at'],20,40))

def _validate(a,state,raw,now):
 approval(a);evidence(a,raw);require(type(now) in (int,float) and now<a['expires_at']<=now+3600)
 require(state['chain_id']==CHAIN and type(state['app_hash'])==str and HEX.fullmatch(state['app_hash']) and type(state['header_time'])==str)
 require(re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})',state['header_time']))
 timestamp=re.sub(r'\.([0-9]{1,9})(?=Z|[+-])',lambda m:'.'+(m.group(1)+'000000')[:6],state['header_time'])
 header=datetime.datetime.fromisoformat(timestamp.replace('Z','+00:00'));require(-60<=now-header.timestamp()<=120)
 height=decimal(state['height'],2**63-1);count=decimal(state['event_count']);require(height>0 and state['event_count']==a['expected_event_count'])
 selected=commands(a);require(height+len(selected)+10<decimal(a['expires_height'],2**63-1)<=height+100)
 records=state['records'];require(type(records)==dict and all(key in records for key in selection(a)['keys']))
 guardian=TARGETS['guardian']['member'];require(records['guardian_epoch_current'] is None and type(records['guardians'])==list and guardian in records['guardians'])
 # The gateway projection stringifies integer counters and hydrates compact
 # metadata; compare authentication fields, then check raw baseline below.
 require(type(state['member'])==dict and type(records['member/'+guardian])==dict)
 for field in ('id','public_key','licence','sequence'):require(state['member'][field]==records['member/'+guardian][field])
 if count:
  last=records[event_key(count)];require(last['id']==str(count) and last['command_digest']==a['expected_last_command_digest'])
 for key,policy in POLICIES.items():
  marker=records[key];require(type(marker)==dict and marker.get('policy')==policy and marker.get('evidence_digest')==ACTIVATION_EVIDENCE)
  if key in ('private_activation','coin_activation'):
   fields={'policy','height','evidence_digest'} | ({'relayer'} if key=='private_activation' else set())
   require(set(marker)==fields and 2<=decimal(marker['height'],2**63-1)<=height)
   if key=='private_activation':require(marker['relayer']==PRIVATE_RELAYER)
  else:require(set(marker)=={'policy','effective_height','approved_by','evidence_digest'} and marker['approved_by']==guardian and 2<=decimal(marker['effective_height'],2**63-1)<=height)
 for name,t in TARGETS.items():
  actor=a['actors'][name];member=records['member/'+t['member']]
  require(type(member)==dict and member['id']==t['member'] and member['public_key']==t['public_key'] and member['licence']=='active')
  for field in ('sequence','karma','credits','creator','default_verifier'):require(type(member[field])==type(actor[field]) and member[field]==actor[field])
  require(decimal(actor['sequence'])+sum(c['member']==t['member'] for c in selected)<=2**64-1)
  identity=records['actor_identity/'+t['member']+'/'];require(record_hash(identity)==actor['identity_sha256'])
  binding(identity,records['actor_did/'+did(t['member'])],t,count)
  require(record_hash(records['private_reviewer/'+t['member']])==actor['private_reviewer_sha256'])
 return selected

def validate(a,state,raw,now=None):
 try:return _validate(a,state,raw,time.time() if now is None else now)
 except (KeyError,TypeError,IndexError,OverflowError,AttributeError):raise ValueError('Malformed bootstrap context refused') from None

def verify_envelope(envelope,command):
 matches=[t for t in TARGETS.values() if t['member']==command['member']];require(len(matches)==1)
 admission.verify_envelope(dict(guardian_public_key=matches[0]['public_key']),envelope,command)

def owned_keys(custody):
 """Derive both actual keys inside custody, never trust public metadata alone."""
 vault=custody.vault();signers={}
 for name,t in TARGETS.items():
  key=native.strict_json(custody.attachment(vault,t['attachment']))
  require(type(key)==dict and key.get('public_key')==t['public_key'] and type(key.get('private_key'))==str)
  seed=bytearray(admission.public_key(key['private_key']))
  try:
   public,sign=native.ed25519(bytes(seed));require(base64.urlsafe_b64encode(public).decode().rstrip('=')==t['public_key'] and 'uain1'+sha(public)[:40]==t['member']);signers[t['member']]=sign
  finally:
   for i in range(len(seed)):seed[i]=0
 return signers

def sign_batch(custody,a,state,raw,now=None):
 selected=validate(a,state,raw,now);signers=owned_keys(custody);validate(a,state,raw,now)
 envelopes=[]
 for command in selected:
  validate(a,state,raw,now)
  target=next(t for t in TARGETS.values() if t['member']==command['member'])
  envelope=dict(command=command,public_key=target['public_key'],signature=base64.urlsafe_b64encode(signers[command['member']](native.signing_bytes(command))).decode().rstrip('='));verify_envelope(envelope,command);envelopes.append(envelope)
 return dict(schema=BATCH_SCHEMA,epoch=a['epoch'],phase=a['phase'],approval_sha256=sha(canonical(a).encode()),evidence_sha256=sha(raw),envelopes=envelopes,private_keys_exported=False,broadcast=False)

def retained(a,raw,batch):
 approval(a);evidence(a,raw)
 require(type(batch)==dict and set(batch)=={'schema','epoch','phase','approval_sha256','evidence_sha256','envelopes','private_keys_exported','broadcast'} and batch['schema']==BATCH_SCHEMA and batch['epoch']==a['epoch'] and batch['phase']==a['phase'] and batch['approval_sha256']==sha(canonical(a).encode()) and batch['evidence_sha256']==sha(raw) and batch['private_keys_exported'] is False and batch['broadcast'] is False)
 selected=commands(a);require(type(batch['envelopes'])==list and len(batch['envelopes'])==len(selected))
 for envelope,command in zip(batch['envelopes'],selected):verify_envelope(envelope,command)
 return batch

def process(custody,a,raw,state,directory,execute=False,load=load,write=admission.atomic,now=None):
 require(type(execute)==bool);approval(a);e=evidence(a,raw);validate_artifacts(a,e)
 directory=Path(directory);approval_hash=sha(canonical(a).encode())
 try:journal=load(directory/'journal.json')
 except FileNotFoundError:journal=None
 if journal is not None:
  require(journal['schema']==JOURNAL_SCHEMA and journal['approval_sha256']==approval_hash)
  try:batch=retained(a,raw,load(directory/'signed.json'))
  except FileNotFoundError:require(False)
  public_hash=sha(canonical(batch).encode())
  if journal['status']=='signed':require(journal['public_envelopes_sha256']==public_hash)
  else:
   require(journal['status']=='signing_started')
   if execute:journal.update(status='signed',public_envelopes_sha256=public_hash);write(directory/'journal.json',journal)
  return dict(status='retained',epoch=a['epoch'],phase=a['phase'],commands_signed=len(batch['envelopes']),public_envelopes_sha256=public_hash,private_keys_exported=False,broadcast=False)
 try:orphan=load(directory/'signed.json')
 except FileNotFoundError:orphan=None
 require(orphan is None)
 selected=validate(a,state,raw,now);owned_keys(custody);validate(a,state,raw,now)
 if not execute:return dict(status='preflight',epoch=a['epoch'],phase=a['phase'],commands=selected,commands_signed=0,private_keys_exported=False,broadcast=False)
 journal=dict(schema=JOURNAL_SCHEMA,status='signing_started',approval_sha256=approval_hash);write(directory/'journal.json',journal)
 batch=sign_batch(custody,a,state,raw,now);write(directory/'signed.json',batch)
 public_hash=sha(canonical(batch).encode());journal.update(status='signed',public_envelopes_sha256=public_hash);write(directory/'journal.json',journal)
 return dict(status='signed',epoch=a['epoch'],phase=a['phase'],commands_signed=len(batch['envelopes']),public_envelopes_sha256=public_hash,private_keys_exported=False,broadcast=False)

def runtime_policy(a):
 t=TARGETS['guardian'];return financial.runtime_policy(dict(a,guardian_public_key=t['public_key']))

def selection(a):
 keys=[*POLICIES,'guardians','guardian_epoch_current']
 for t in TARGETS.values():keys.extend(['member/'+t['member'],'actor_identity/'+t['member']+'/','actor_did/'+did(t['member']),'private_reviewer/'+t['member']])
 if a['expected_event_count']!='0':keys.append(event_key(decimal(a['expected_event_count'])))
 return dict(member=TARGETS['guardian']['member'],keys=keys)

def run(custody,epoch,execute=False):
 require(os.geteuid()==0 and type(epoch)==str and re.fullmatch(r'[a-f0-9]{32}',epoch) and type(execute)==bool)
 resource.setrlimit(resource.RLIMIT_CORE,(0,0));os.umask(0o077)
 directory=ROOT/epoch;admission.ensure_directory(ROOT);admission.ensure_directory(directory);admission.ensure_directory(admission.TEMP)
 fd=os.open(ROOT/'bootstrap.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)
 with os.fdopen(fd,'r+b') as lock:
  info=os.fstat(lock.fileno());require(stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_nlink==1 and not info.st_mode&0o077)
  # Also serialize direct run() callers, not just the custody dispatcher flock.
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  a=load(directory/'approval.json');require(a['epoch']==epoch);approval(a)
  raw=native.protected_read(directory/'evidence.json',1024*1024)
  state=admission.Runtime(runtime_policy(a)).read(selection(a))
  result=process(custody,a,raw,state,directory,execute=execute)
  print(json.dumps(result));return result

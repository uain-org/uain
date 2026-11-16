"""Root-approved prospective financial-policy signing, with no broadcast capability.

No mint, balance conversion, reviewer appointment or arbitrary command is exposed.
Read-only preflight is the default; --execute only retains public signed envelopes.
Transport/receipt orchestration is deliberately a separate non-key consumer.
"""
import base64,datetime,hashlib,json,os,re,resource,time
from pathlib import Path
import native_migration as native
import native_admission as admission

CHAIN=native.CHAIN
GENESIS=native.GENESIS
GUARDIAN=native.GUARDIAN
ROOT=Path('/var/lib/uain-custody/native-financial-activation')
APPROVAL_SCHEMA='uain-native-financial-activation-approval-v1'
EVIDENCE_SCHEMA='uain-native-financial-readiness-v1'
JOURNAL_SCHEMA='uain-native-financial-activation-journal-v1'
BATCH_SCHEMA='uain-native-financial-activation-envelopes-v1'
HEX=re.compile(r'^[a-f0-9]{64}$')
RELAY_BINDINGS={
 'keys/neuroetch-key.json':('uain1215c651b70db82b70532a496c26fdf424f3bb369','UBt1U9QEG12-n2x90HbZ9cMhUKomykucispKe7fHad4'),
 'keys/enlightenment-key.json':('uain132875d759cb1118929204c038bb04512a087f597','YpaVvbEyAjzE7tQIsMDZkrVlcnlKhLiJNFVm483dX8s'),
}
POLICIES={'storage_activation':'compact-state-v1','membership_activation':'project-membership-v1','operator_reward_activation':'pairwise-operator-rewards-v1','private_activation':'orchard-v2-reviewed-otc-v1','coin_activation':'verified-bounties-108t-micro-v1'}
POLICY_KEYS=tuple(POLICIES)+('private_frontier','coin_supply')
PREDECESSORS={'foundation':(),'operators':('storage_activation','membership_activation'),'economy':('storage_activation','membership_activation','operator_reward_activation')}
PHASES={'foundation':(('activate_storage','storage_activation'),('activate_membership','membership_activation')),'operators':(('activate_operator_rewards','operator_reward_activation'),),'economy':(('activate_private_exchange','private_activation'),('activate_coin','coin_activation'))}
LIMITATIONS=dict(premint=False,credit_conversion=False,public_transfer=False,cash_redemption=False,reviewer_appointments=False,independent_operator_claim=False)
APPROVAL_FIELDS={'schema','epoch','phase','chain_id','genesis','genesis_sha256','state_binary','state_sha256','daemon_binary','daemon_sha256','guardian','guardian_public_key','guardian_key_attachment','relayer','relayer_public_key','relayer_key_attachment','evidence_sha256','predecessor_evidence','starting_sequence','expected_event_count','expected_last_command_digest','expires_at','expires_height'}
EVIDENCE_FIELDS={'schema','chain_id','genesis_sha256','state_sha256','daemon_sha256','relayer','relayer_public_key','authorization','orchard_qualified','acceptance','limitations'}
canonical=native.canonical
sha=native.sha
decimal=native.decimal
event_key=admission.event_key

def require(ok):
 if not ok:raise ValueError('Native financial activation authorization refused')
def key_bytes(value):
 try:return admission.public_key(value)
 except Exception:raise ValueError('Invalid public custody binding') from None

def approval(value):
 require(type(value)==dict and set(value)==APPROVAL_FIELDS)
 a=value
 require(a['schema']==APPROVAL_SCHEMA and type(a['epoch'])==str and re.fullmatch(r'[a-f0-9]{32}',a['epoch']) and a['phase'] in PHASES)
 require(a['chain_id']==CHAIN and a['genesis_sha256']==GENESIS)
 for field in ('genesis','state_binary','daemon_binary'):require(type(a[field])==str and Path(a[field]).is_absolute())
 for field in ('state_sha256','daemon_sha256','evidence_sha256'):require(type(a[field])==str and HEX.fullmatch(a[field]))
 require(a['guardian']==GUARDIAN and a['guardian_key_attachment']=='keys/uain-review-key.json' and 'uain1'+sha(key_bytes(a['guardian_public_key']))[:40]==GUARDIAN)
 binding=RELAY_BINDINGS.get(a['relayer_key_attachment']);require(binding is not None and binding==(a['relayer'],a['relayer_public_key']) and a['relayer']!=GUARDIAN and 'uain1'+sha(key_bytes(a['relayer_public_key']))[:40]==a['relayer'])
 require(type(a['predecessor_evidence'])==dict and set(a['predecessor_evidence'])==set(PREDECESSORS[a['phase']]) and all(type(v)==str and HEX.fullmatch(v) for v in a['predecessor_evidence'].values()))
 decimal(a['starting_sequence']);decimal(a['expected_event_count']);decimal(a['expires_height'],2**63-1)
 require(type(a['expires_at'])==int and (a['expected_last_command_digest']=='' if a['expected_event_count']=='0' else type(a['expected_last_command_digest'])==str and HEX.fullmatch(a['expected_last_command_digest'])))
 return a

def evidence(a,raw):
 require(type(raw)==bytes and 1<=len(raw)<=1024*1024 and sha(raw)==a['evidence_sha256'])
 e=native.strict_json(raw);require(type(e)==dict and set(e)==EVIDENCE_FIELDS and e['schema']==EVIDENCE_SCHEMA)
 for field in ('chain_id','genesis_sha256','state_sha256','daemon_sha256','relayer','relayer_public_key'):require(e[field]==a[field])
 require(type(e['authorization'])==str and 10<=len(e['authorization'].encode())<=4000 and not any(ord(c)<32 for c in e['authorization']))
 require(e['orchard_qualified'] is True and type(e['limitations'])==dict and set(e['limitations'])==set(LIMITATIONS) and all(e['limitations'][key] is False for key in LIMITATIONS))
 require(type(e['acceptance'])==list and 1<=len(e['acceptance'])<=16)
 paths=[]
 for item in e['acceptance']:
  require(type(item)==dict and set(item)=={'path','sha256'} and type(item['path'])==str and Path(item['path']).is_absolute() and type(item['sha256'])==str and HEX.fullmatch(item['sha256']));paths.append(item['path'])
 require(len(set(paths))==len(paths))
 return e

def commands(a):
 result=[]
 for index,(operation,key) in enumerate(PHASES[a['phase']]):
  payload=dict(policy=POLICIES[key],evidence_digest=a['evidence_sha256'])
  if operation=='activate_private_exchange':payload['relayer']=a['relayer']
  result.append(dict(version=1,chain_id=CHAIN,member=GUARDIAN,sequence=str(decimal(a['starting_sequence'])+index),expires_height=a['expires_height'],operation=operation,payload=payload))
 return result

def _validate(a,state,raw,now):
 approval(a);evidence(a,raw)
 require(type(now) in (int,float) and now<a['expires_at']<=now+3600)
 require(state['chain_id']==CHAIN and type(state['header_time'])==str and type(state['app_hash'])==str and HEX.fullmatch(state['app_hash']))
 require(re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})',state['header_time']))
 # Go RFC3339Nano emits 1–9 digits; normalize for Python3.9's narrower parser.
 timestamp=re.sub(r'\.([0-9]{1,9})(?=Z|[+-])',lambda match:'.'+(match.group(1)+'000000')[:6],state['header_time'])
 header=datetime.datetime.fromisoformat(timestamp.replace('Z','+00:00'));require(header.tzinfo is not None and -60<=now-header.timestamp()<=120)
 height=decimal(state['height'],2**63-1);count=decimal(state['event_count']);require(height>0 and state['event_count']==a['expected_event_count'])
 guardian=state['member'];require(guardian['id']==GUARDIAN and guardian['public_key']==a['guardian_public_key'] and guardian['licence']=='active' and guardian['sequence']==a['starting_sequence'])
 require(decimal(a['starting_sequence'])+len(PHASES[a['phase']])<=2**64-1 and height+len(PHASES[a['phase']])+10<decimal(a['expires_height'],2**63-1)<=height+100)
 records=state['records'];require(type(records)==dict and all(key in records for key in (*POLICY_KEYS,'guardians','guardian_epoch_current','member/'+a['relayer'])))
 require(records['guardian_epoch_current'] is None and type(records['guardians'])==list and GUARDIAN in records['guardians'])
 if count:
  last=records[event_key(count)];require(last['id']==str(count) and last['command_digest']==a['expected_last_command_digest'])
 relayer=records['member/'+a['relayer']];require(type(relayer)==dict and relayer['id']==a['relayer'] and relayer['public_key']==a['relayer_public_key'] and relayer['licence']=='active')
 for key in POLICY_KEYS:
  if key not in PREDECESSORS[a['phase']]:require(records[key] is None)
 for key in PREDECESSORS[a['phase']]:
  marker=records[key];require(type(marker)==dict and set(marker)=={'policy','effective_height','approved_by','evidence_digest'} and marker['policy']==POLICIES[key] and marker['approved_by']==GUARDIAN and marker['evidence_digest']==a['predecessor_evidence'][key] and 2<=decimal(marker['effective_height'],2**63-1)<=height)
 return commands(a)

def validate(a,state,raw,now=None):
 try:return _validate(a,state,raw,time.time() if now is None else now)
 except (KeyError,TypeError,IndexError,OverflowError,AttributeError):raise ValueError('Malformed financial activation context refused') from None

def verify_envelope(a,envelope,command):
 admission.verify_envelope(a,envelope,command)

def relay_custody(custody,a,vault):
 # These two named existing identities are operator-controlled relay candidates,
 # not new reviewers and not independent operators. Never output key material.
 key=native.strict_json(custody.attachment(vault,a['relayer_key_attachment']))
 require(type(key)==dict and key.get('public_key')==a['relayer_public_key'] and type(key.get('private_key'))==str)
 seed=bytearray(key_bytes(key['private_key']))
 try:
  public,_=native.ed25519(bytes(seed))
  require(base64.urlsafe_b64encode(public).decode().rstrip('=')==a['relayer_public_key'] and 'uain1'+sha(public)[:40]==a['relayer'])
 finally:
  for i in range(len(seed)):seed[i]=0

def sign_batch(custody,a,state,raw,now=None):
 selected=validate(a,state,raw,now=now)
 vault=custody.vault();relay_custody(custody,a,vault)
 key=native.strict_json(custody.attachment(vault,'keys/uain-review-key.json'))
 seed=bytearray(key_bytes(key['private_key']))
 try:
  public,sign=native.ed25519(bytes(seed));encoded=base64.urlsafe_b64encode(public).decode().rstrip('=')
  require(encoded==key['public_key']==a['guardian_public_key'] and 'uain1'+sha(public)[:40]==GUARDIAN)
  envelopes=[]
  for command in selected:
   envelope=dict(command=command,public_key=encoded,signature=base64.urlsafe_b64encode(sign(native.signing_bytes(command))).decode().rstrip('='));verify_envelope(a,envelope,command);envelopes.append(envelope)
  return dict(schema=BATCH_SCHEMA,epoch=a['epoch'],phase=a['phase'],approval_sha256=sha(canonical(a).encode()),evidence_sha256=a['evidence_sha256'],envelopes=envelopes,private_keys_exported=False,broadcast=False)
 finally:
  for i in range(len(seed)):seed[i]=0

def read_public(path,limit):
 import stat
 path=Path(path);require(path.resolve()==path)
 for parent in (path,*path.parents):
  info=parent.stat();require(info.st_uid==0 and not info.st_mode&0o022)
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 with os.fdopen(fd,'rb') as source:
  info=os.fstat(source.fileno());require(stat.S_ISREG(info.st_mode) and info.st_size<=limit and info.st_nlink==1);raw=source.read(limit+1);require(len(raw)<=limit);return raw

def validate_artifacts(a,e):
 import subprocess
 for path,pin,limit in [(a['state_binary'],a['state_sha256'],256*1024*1024),(a['daemon_binary'],a['daemon_sha256'],256*1024*1024),(a['genesis'],a['genesis_sha256'],8*1024*1024),*((item['path'],item['sha256'],32*1024*1024) for item in e['acceptance'])]:require(sha(read_public(path,limit))==pin)
 # Bind reviewed daemon bytes to the process actually running this chain.
 pid=subprocess.check_output(['systemctl','show','--value','--property=MainPID','uain-chain-shadow.service'],timeout=10).decode().strip();require(re.fullmatch(r'[1-9][0-9]*',pid))
 require(Path('/proc/'+pid+'/exe').resolve()==Path(a['daemon_binary']))
 require(native.strict_json(read_public(a['genesis'],8*1024*1024))['chain_id']==CHAIN)

def runtime_policy(a):
 # Reuse the existing hash-checked root-only native reader, never raw RPC JSON.
 return dict(schema=admission.SCHEMA,policy='objective-enrol-v1',chain_id=CHAIN,genesis=a['genesis'],genesis_sha256=GENESIS,state_binary=a['state_binary'],state_sha256=a['state_sha256'],rpc='http://127.0.0.1:26667',guardian=GUARDIAN,guardian_public_key=a['guardian_public_key'],guardian_key_attachment='keys/uain-review-key.json',guardian_epoch=None,start_event=a['expected_event_count'],start_event_digest=a['expected_last_command_digest'],max_events=16,max_approvals=1)

def selection(a):
 keys=[*POLICY_KEYS,'guardians','guardian_epoch_current','member/'+a['relayer']]
 if a['expected_event_count']!='0':keys.append(event_key(decimal(a['expected_event_count'])))
 return dict(member=GUARDIAN,keys=keys)

def load(path):return native.strict_json(native.protected_read(path,1024*1024))

def retained(a,raw,batch):
 require(type(batch)==dict and batch.get('schema')==BATCH_SCHEMA and batch.get('epoch')==a['epoch'] and batch.get('phase')==a['phase'] and batch.get('approval_sha256')==sha(canonical(a).encode()) and batch.get('evidence_sha256')==sha(raw) and batch.get('private_keys_exported') is False and batch.get('broadcast') is False)
 selected=commands(a);require(type(batch.get('envelopes'))==list and len(batch['envelopes'])==len(selected))
 for envelope,command in zip(batch['envelopes'],selected):verify_envelope(a,envelope,command)
 return batch

def process(custody,a,raw,state,directory,execute=False,load=load,write=admission.atomic,now=None):
 """No network writer exists here. An uncertain signing journal never retries."""
 approval(a);e=evidence(a,raw);validate_artifacts(a,e)
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
   if execute:
    journal.update(status='signed',public_envelopes_sha256=public_hash);write(directory/'journal.json',journal)
  return dict(status='retained',epoch=a['epoch'],phase=a['phase'],commands_signed=len(batch['envelopes']),public_envelopes_sha256=public_hash,private_keys_exported=False,broadcast=False)
 try:orphan=load(directory/'signed.json')
 except FileNotFoundError:orphan=None
 require(orphan is None)
 selected=validate(a,state,raw,now=now)
 relay_custody(custody,a,custody.vault())
 if not execute:return dict(status='preflight',epoch=a['epoch'],phase=a['phase'],commands=selected,commands_signed=0,private_keys_exported=False,broadcast=False)
 require(execute is True)
 # Install the marker before touching the guardian secret. A crash after this
 # write requires recovery of retained exact public bytes, never a re-sign.
 journal=dict(schema=JOURNAL_SCHEMA,status='signing_started',approval_sha256=approval_hash);write(directory/'journal.json',journal)
 batch=sign_batch(custody,a,state,raw,now=now);write(directory/'signed.json',batch)
 public_hash=sha(canonical(batch).encode());journal.update(status='signed',public_envelopes_sha256=public_hash);write(directory/'journal.json',journal)
 return dict(status='signed',epoch=a['epoch'],phase=a['phase'],commands_signed=len(batch['envelopes']),public_envelopes_sha256=public_hash,private_keys_exported=False,broadcast=False)

def run(custody,epoch,execute=False):
 require(os.geteuid()==0 and type(epoch)==str and re.fullmatch(r'[a-f0-9]{32}',epoch) and type(execute)==bool)
 resource.setrlimit(resource.RLIMIT_CORE,(0,0));os.umask(0o077)
 directory=ROOT/epoch;admission.ensure_directory(ROOT);admission.ensure_directory(directory);admission.ensure_directory(admission.TEMP)
 a=load(directory/'approval.json');require(a['epoch']==epoch);approval(a)
 raw=native.protected_read(directory/'evidence.json',1024*1024)
 state=admission.Runtime(runtime_policy(a)).read(selection(a))
 result=process(custody,a,raw,state,directory,execute=execute)
 print(json.dumps(result));return result

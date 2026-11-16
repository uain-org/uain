"""Objective automatic admission through existing guardian licence commands.

No member secrets, arbitrary signing operation, roles or financial policy.
The fixed root-owned policy selects independently pinned native proof artifacts.
"""
import base64,hashlib,json,os,re,resource,stat,subprocess,tempfile,time,urllib.request
from pathlib import Path
import native_migration as native
import guardian_quorum as gq
# Generation-2 chains (9 Nov 2026): a guardian alone cannot grant a licence.
# When this root-owned binding exists the worker proposes the licence as a
# guardian action and hands an untrusted hint to the independent second
# signer (guardian_approver.py), which re-runs this same screen.
QUORUM_PATH=Path('/etc/uain-custody/native-admission-quorum.json')
QUORUM=None
POLICY=Path('/etc/uain-custody/native-admission.json')
ROOT=Path('/var/lib/uain-custody/native-admission')
TEMP=Path('/run/uain-native-admission')
SCHEMA='uain-native-admission-policy-v1'
FIELDS={'schema','policy','chain_id','genesis','genesis_sha256','state_binary','state_sha256','rpc','guardian','guardian_public_key','guardian_key_attachment','guardian_epoch','start_event','start_event_digest','max_events','max_approvals'}
HEX=re.compile(r'^[a-f0-9]{64}$');ADDRESS=re.compile(r'^uain1[a-f0-9]{40}$')
require=native.require
canonical=lambda value:native.canonical(value).encode()
digest=lambda raw:hashlib.sha256(raw).hexdigest()
event_key=lambda number:'event/'+str(number).zfill(20)
def decimal(value):return native.decimal(value)
def zero(value):return type(value)==int and value==0 or type(value)==str and value=='0'
def public_key(value):
 require(type(value)==str and re.fullmatch(r'[A-Za-z0-9_-]{43}',value));raw=base64.urlsafe_b64decode(value+'=');require(len(raw)==32 and base64.urlsafe_b64encode(raw).decode().rstrip('=')==value);return raw
def validate_policy(p):
 require(type(p)==dict and set(p)==FIELDS and p['schema']==SCHEMA and p['policy']=='objective-enrol-v1')
 require(type(p['chain_id'])==str and re.fullmatch(r'uain-[a-z0-9][a-z0-9_-]{1,63}',p['chain_id']))
 for k in ('genesis_sha256','state_sha256'):require(type(p[k])==str and HEX.fullmatch(p[k]))
 for k in ('genesis','state_binary'):require(type(p[k])==str and Path(p[k]).is_absolute())
 require(p['rpc']=='http://127.0.0.1:26667' or re.fullmatch(r'http://127\.0\.0\.1:[1-9][0-9]{0,4}',p['rpc']))
 require(type(p['guardian'])==str and ADDRESS.fullmatch(p['guardian']) and p['guardian']=='uain1'+digest(public_key(p['guardian_public_key']))[:40])
 require(type(p['guardian_key_attachment'])==str and re.fullmatch(r'keys/[a-z0-9_-]{1,80}\.json',p['guardian_key_attachment']))
 require(p['guardian_epoch'] is None or type(p['guardian_epoch'])==str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,95}',p['guardian_epoch']));start=decimal(p['start_event']);require(p['start_event_digest']=='' if start==0 else type(p['start_event_digest'])==str and HEX.fullmatch(p['start_event_digest']))
 require(type(p['max_events'])==int and 1<=p['max_events']<=16 and type(p['max_approvals'])==int and 1<=p['max_approvals']<=4)
 return p

def guardian_context(p,state):
 validate_policy(p);require(state['chain_id']==p['chain_id']);height=decimal(state['height']);count=decimal(state['event_count']);require(height>0)
 guardian=state['member'];require(guardian['id']==p['guardian'] and guardian['public_key']==p['guardian_public_key'] and guardian['licence']=='active');decimal(guardian['sequence'])
 records=state['records'];require('guardian_epoch_current' in records and records['guardian_epoch_current']==p['guardian_epoch'])
 if p['guardian_epoch'] is None:guardians=records['guardians']
 else:
  # After the 2-of-3 handover the authority is the pinned epoch, and a
  # licence can only be proposed: refuse to run without the quorum binding.
  require(QUORUM is not None);epoch=records['guardian_epoch/'+p['guardian_epoch']];require(type(epoch)==dict and epoch['id']==p['guardian_epoch']);guardians=epoch['guardians']
 require(type(guardians)==list and 1<=len(guardians)<=20 and len(set(guardians))==len(guardians) and p['guardian'] in guardians and all(type(x)==str and ADDRESS.fullmatch(x) for x in guardians))
 return height,count

class EligibilityRefused(ValueError):
 def __init__(self,reason,context):super().__init__('Automatic admission eligibility refused: '+reason);self.reason=reason;self.context=context

def admission_identity(target,records):
 """Restore only the native compact storage representation, never account roles.
 The pinned reader proves both records. Bind the metadata to its member digest
 using the native MemberMetadata struct field order and Go JSON string rules.
 """
 policy=target.get('account_policy','');metadata_digest=target.get('metadata_digest','')
 if not policy and not metadata_digest:return target
 require(policy=='compact-account-v1' and type(metadata_digest)==str and HEX.fullmatch(metadata_digest))
 require(all(target[field]=='' for field in ('name','operator','family')))
 metadata=records.get('member_metadata/'+target['id'])
 fields=('id','name','operator','family')
 require(type(metadata)==dict and set(metadata)==set(fields) and all(type(metadata[field])==str for field in fields))
 require(metadata['id']==target['id'])
 encoded=('{'+','.join(native.canonical(field)+':'+native.canonical(metadata[field]) for field in fields)+'}').encode()
 require(len(encoded)<=4096 and digest(encoded)==metadata_digest)
 return {**target,**{field:metadata[field] for field in ('name','operator','family')}}

def screen(p,event,state):
 """The proved enrol event means consensus authenticated its original signature.
 No separate terms consent, identity vetting or human review is fabricated."""
 try:
  height,count=guardian_context(p,state);require(type(event)==dict and event['operation']=='enrol' and event['subject']==event['member'] and ADDRESS.fullmatch(event['member']))
  ident=decimal(event['id']);require(1<=ident<=count and 1<=decimal(event['height'])<=height and HEX.fullmatch(event['command_digest']) and not event.get('instance'))
  records=state['records'];require(records[event_key(ident)]==event);target=records['member/'+event['member']]
  require(type(target)==dict and target['id']==event['member'] and target['id']=='uain1'+digest(public_key(target['public_key']))[:40] and target['id']!=p['guardian'])
  def eligible(condition,reason):
   if not condition:raise EligibilityRefused(reason,dict(chain_id=p['chain_id'],height=state['height'],event_count=state['event_count'],member=target))
  require(target['licence'] in ('pending','active','revoked','withdrawn'));decimal(target['sequence'])
  for field in ('karma','active_projects'):require(type(target[field])==int or type(target[field])==str and re.fullmatch(r'0|-?[1-9][0-9]{0,18}',target[field]))
  require(type(target['credits'])==str and re.fullmatch(r'0|[1-9][0-9]{0,199}',target['credits']))
  require(type(target['default_verifier'])==bool and type(target['creator'])==bool and type(target.get('account_policy',''))==str and type(target.get('metadata_digest',''))==str)
  eligible(target['licence']=='pending','licence-not-pending');eligible(target['sequence']=='1','not-new-enrolment')
  eligible(zero(target['karma']) and target['credits']=='0' and zero(target['active_projects']),'nonzero-standing')
  eligible(target['default_verifier'] is False and target['creator'] is False,'role-or-account-override')
  eligible(target.get('account_policy','') in ('','compact-account-v1') and (bool(target.get('account_policy')) or not target.get('metadata_digest')),'role-or-account-override')
  target=admission_identity(target,records)
  for field,maximum,minimum in [('name',120,2),('operator',200,2),('family',100,0)]:
   require(type(target[field])==str);eligible(len(target[field].strip().encode())>=minimum and len(target[field].encode())<=maximum,'identity-'+field+'-bounds')
  evidence=dict(schema='uain-native-automatic-screening-v1',policy=p['policy'],policy_sha256=digest(canonical(p)),chain_id=p['chain_id'],genesis_sha256=p['genesis_sha256'],enrol_event=event,member=target,checks=['finalized-consensus-authenticated-enrol','matching-key-address','bounded-declared-identity','new-pending-zero-standing','no-roles-or-account-overrides'])
  command=dict(version=1,chain_id=p['chain_id'],member=p['guardian'],sequence=state['member']['sequence'],expires_height=str(height+100),operation='licence',payload=dict(member=target['id'],status='active',evidence_digest=digest(canonical(evidence))))
  return evidence,command
 except (KeyError,TypeError,IndexError,OverflowError):raise ValueError('Malformed automatic admission context refused') from None

def atomic(path,value):
 path=Path(path);fd,pending=tempfile.mkstemp(prefix='.'+path.name+'-',dir=path.parent)
 try:
  with os.fdopen(fd,'wb') as output:os.fchmod(output.fileno(),0o600);output.write(canonical(value)+b'\n');output.flush();os.fsync(output.fileno())
  os.replace(pending,path);directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
  try:os.fsync(directory)
  finally:os.close(directory)
 finally:Path(pending).unlink(missing_ok=True)
def load(path):return native.strict_json(native.protected_read(path,1024*1024))
def ensure_directory(path):
 path=Path(path);path.mkdir(mode=0o700,parents=True,exist_ok=True);require(path.resolve()==path)
 for parent in (path,*path.parents):
  s=parent.stat();require(stat.S_ISDIR(s.st_mode) and s.st_uid==0 and not s.st_mode&0o022)
 require(not path.stat().st_mode&0o077)

def verify_envelope(p,envelope,command):
 require(type(envelope)==dict and set(envelope)=={'command','public_key','signature'} and envelope['command']==command and envelope['public_key']==p['guardian_public_key'])
 require(type(envelope['signature'])==str and re.fullmatch(r'[A-Za-z0-9_-]{86}',envelope['signature']));signature=base64.urlsafe_b64decode(envelope['signature']+'==');require(base64.urlsafe_b64encode(signature).decode().rstrip('=')==envelope['signature'])
 try:
  from Cryptodome.Signature import eddsa
 except ImportError:
  from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
  Ed25519PublicKey.from_public_bytes(public_key(p['guardian_public_key'])).verify(signature,native.signing_bytes(command))
 else:eddsa.new(eddsa.import_public_key(public_key(p['guardian_public_key'])),'rfc8032').verify(native.signing_bytes(command),signature)

def sign_guardian(custody,p,event,state):
 # Repeat the complete objective screen before opening the existing vault.
 evidence,command=screen(p,event,state)
 key=native.strict_json(custody.attachment(custody.vault(),p['guardian_key_attachment']))
 seed=bytearray(public_key(key['private_key']))
 try:
  public,sign=native.ed25519(bytes(seed));encoded=base64.urlsafe_b64encode(public).decode().rstrip('=')
  require(encoded==key['public_key']==p['guardian_public_key'] and 'uain1'+digest(public)[:40]==p['guardian'])
  command=wrap(command,state)
  envelope=dict(command=command,public_key=encoded,signature=base64.urlsafe_b64encode(sign(native.signing_bytes(command))).decode().rstrip('='));verify_envelope(p,envelope,command);return evidence,envelope
 finally:
  for i in range(len(seed)):seed[i]=0

def load_quorum(p,path=QUORUM_PATH):
 path=Path(path)
 if not path.exists():return None
 c=load(path);require(type(c)==dict and set(c)=={'schema','quorum','inbox'} and c['schema']=='uain-native-admission-quorum-v1' and type(c['inbox'])==str and Path(c['inbox']).is_absolute())
 q=gq.Quorum(c['quorum']);require(q.chain==p['chain_id'] and q.binding['genesis_sha256']==p['genesis_sha256'] and q.local(p['guardian'])['attachment']==p['guardian_key_attachment'] and q.guardians[p['guardian']]['public_key']==p['guardian_public_key'])
 return dict(q=q,inbox=c['inbox'])
def wrap(command,state):
 """The command actually signed: the licence itself, or its guardian proposal."""
 if QUORUM is None:return command
 return gq.propose_command(QUORUM['q'],command,command['member'],state['member']['sequence'],state['height'])
def licence_of(command):
 if QUORUM is None:return command
 require(command['operation']=='guardian_action_propose' and command['payload']['operation']=='licence');return dict(command,operation='licence',payload=command['payload']['payload'])
def lifetime():return 100 if QUORUM is None else gq.ACTION_WINDOW
def hint(event,command):
 """Untrusted pointer for the second signer; it proves everything itself."""
 inbox=Path(QUORUM['inbox']);ensure_directory(inbox);atomic(inbox/(command['payload']['id']+'.json'),dict(schema='uain-guardian-action-hint-v1',id=command['payload']['id'],rule='admission',context=dict(enrol_event=event['id'])))
def matches_receipt(event,command):
 if QUORUM is not None:return gq.proposal_receipt(event,command)
 return type(event)==dict and event.get('operation')=='licence' and event.get('member')==command['member'] and event.get('subject')==command['payload']['member'] and event.get('command_digest')==digest(native.signing_bytes(command)) and not event.get('instance')

class Runtime:
 def __init__(self,p):self.p=validate_policy(p);self.deadline=time.monotonic()+120
 def remaining(self):
  left=self.deadline-time.monotonic();require(left>0);return left
 def read(self,selection):
  p=self.p;self.remaining()
  # Existing production daemon/genesis are untouched; only public pins are read.
  for path,pin,limit in [(p['state_binary'],p['state_sha256'],256*1024*1024),(p['genesis'],p['genesis_sha256'],8*1024*1024)]:
   file=Path(path);require(file.resolve()==file)
   for parent in (file,*file.parents):
    info=parent.stat();require(info.st_uid==0 and not info.st_mode&0o022)
   info=file.stat();require(stat.S_ISREG(info.st_mode) and info.st_size<=limit and digest(file.read_bytes())==pin)
  require(json.loads(Path(p['genesis']).read_bytes())['chain_id']==p['chain_id'])
  with tempfile.TemporaryDirectory(prefix='uain-admission-proof-',dir=TEMP) as temporary:
   out=Path(temporary)/'state.json';result=subprocess.run([p['state_binary'],'--genesis',p['genesis'],'--genesis-sha256',p['genesis_sha256'],'--rpc',p['rpc'],'--out',str(out),'--max-age','120s'],input=canonical(selection),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=min(20,self.remaining()))
   require(result.returncode==0);state=load(out);require(state['chain_id']==p['chain_id']);return state
 def broadcast(self,envelope):
  raw=canonical(dict(jsonrpc='2.0',id='uain-automatic-admission',method='broadcast_tx_sync',params=dict(tx=base64.b64encode(json.dumps(envelope,separators=(',',':')).encode()).decode())))
  request=urllib.request.Request(self.p['rpc'],data=raw,headers={'Content-Type':'application/json'})
  with urllib.request.urlopen(request,timeout=min(10,self.remaining())) as response:answer=response.read(65537);require(len(answer)<=65536)
  value=native.strict_json(answer);require('error' not in value and type(value['result']['code'])==int and value['result']['hash'].upper()==digest(json.dumps(envelope,separators=(',',':')).encode()).upper());return value['result']['code']

def guardian_keys(p):return ['guardians','guardian_epoch_current',*(['guardian_epoch/'+p['guardian_epoch']] if p['guardian_epoch'] else [])]
def selection(p,event=None,keys=()):return dict(member=p['guardian'],keys=[*guardian_keys(p),*([event_key(decimal(event['id'])),'member/'+event['member'],'member_metadata/'+event['member']] if event else []),*keys])

def retained_command(p,event,journal,evidence):
 require(journal['schema']=='uain-native-admission-journal-v1' and journal['policy_sha256']==digest(canonical(p)) and journal['enrol_event']==event and type(journal['attempt'])==int and journal['attempt']>=1)
 require(evidence['policy_sha256']==digest(canonical(p)) and evidence['chain_id']==p['chain_id'] and evidence['genesis_sha256']==p['genesis_sha256'] and evidence['enrol_event']==event and evidence['member']['id']==event['member'])
 envelope=journal['envelope'];command=envelope['command']
 require(set(command)==native.FIELDS and type(command['version'])==int and command['version']==1 and command['chain_id']==p['chain_id'] and command['member']==p['guardian'])
 inner=licence_of(command);require(inner['operation']=='licence' and inner['payload']==dict(member=event['member'],status='active',evidence_digest=digest(canonical(evidence))))
 decimal(command['sequence']);require(decimal(command['expires_height'])>0 and decimal(journal['receipt_cursor'])>=decimal(journal['after_event'])>=decimal(event['id']))
 verify_envelope(p,envelope,command);return command

def process_enrol(custody,p,event,directory,runtime,read_journal=load,write=atomic):
 """At most one retained envelope is eligible to be in flight. Never resend it."""
 directory=Path(directory);directory.mkdir(mode=0o700,exist_ok=True);journal_path=directory/'journal.json'
 journal=read_journal(journal_path) if journal_path.exists() else None
 if journal is not None:retained_command(p,event,journal,read_journal(directory/'evidence.json'))
 state=runtime.read(selection(p,event));guardian_context(p,state);target=state['records']['member/'+event['member']]
 if journal is None or journal['status']=='expired_or_superseded_nonincluded':
  if journal is not None:
   old=journal['envelope']['command'];require(journal['policy_sha256']==digest(canonical(p)) and journal['enrol_event']==event)
   verify_envelope(p,journal['envelope'],old)
   require(decimal(state['height'])>decimal(old['expires_height']) or decimal(state['member']['sequence'])>decimal(old['sequence']))
   require(decimal(state['event_count'])>=decimal(journal['nonincluded_through']))
  if target is not None and target.get('licence') in ('active','revoked','withdrawn'):return dict(done=True,status='already_'+target['licence'])
  evidence,command=screen(p,event,state);write(directory/'evidence.json',evidence)
  attempt=1 if journal is None else journal['attempt']+1;attempt_path=directory/('attempt-'+str(attempt)+'.json')
  if attempt_path.exists():
   # Crash between retaining signed bytes and installing their journal: adopt
   # those exact bytes, never overwrite or silently sign a replacement.
   candidate=read_journal(attempt_path);require(candidate['status']=='signed' and candidate['policy_sha256']==digest(canonical(p)) and candidate['enrol_event']==event)
   retained=candidate['envelope']['command'];verify_envelope(p,candidate['envelope'],retained)
   require(licence_of(retained)['operation']=='licence' and retained['chain_id']==p['chain_id'] and retained['member']==p['guardian'] and licence_of(retained)['payload']==command['payload'] and decimal(retained['expires_height'])>0 and decimal(retained['expires_height'])<=decimal(state['height'])+lifetime())
   journal=candidate
  else:
   _,envelope=sign_guardian(custody,p,event,state);verify_envelope(p,envelope,wrap(command,state))
   journal=dict(schema='uain-native-admission-journal-v1',policy_sha256=digest(canonical(p)),enrol_event=event,attempt=attempt,status='signed',after_event=state['event_count'],receipt_cursor=state['event_count'],envelope=envelope)
   # Public signed bytes are durable before even the broadcast marker exists.
   write(attempt_path,journal)
  write(journal_path,journal)
 evidence=read_journal(directory/'evidence.json');command=retained_command(p,event,journal,evidence);envelope=journal['envelope']
 if journal['status']=='finalized':
  if QUORUM is None or (target is not None and target.get('licence') in ('active','revoked','withdrawn')):return dict(done=True,status='finalized',event=journal['receipt_event'])
  if decimal(state['height'])>decimal(str(command['payload']['expires_height'])):
   # The proposal expired unapproved; a later run proposes afresh after a full screen.
   journal.update(status='expired_or_superseded_nonincluded',nonincluded_through=state['event_count'],closed_height=state['height']);write(directory/('closed-attempt-'+str(journal['attempt'])+'.json'),journal);write(journal_path,journal);return dict(done=False,status='retry_required')
  hint(event,command);return dict(done=False,status='awaiting_second_guardian')
 require(journal['status'] in ('signed','broadcast_started','nonbroadcast_recovery'))
 if journal['status']=='signed':
  # A restarted signer must not send stale authority or a replaced licence.
  if state['member']['sequence']!=command['sequence'] or decimal(state['height'])>decimal(command['expires_height']):
   journal.update(status='nonbroadcast_recovery',broadcast_skipped='expired_or_sequence_changed');write(journal_path,journal)
  else:
   screen(p,event,state)
   journal['status']='broadcast_started';write(journal_path,journal)
   try:runtime.broadcast(envelope)
   except Exception:return dict(done=False,status='uncertain')
 # Read fresh proved events once per invocation; next timer resumes this cursor.
 state=runtime.read(selection(p,event));height,count=guardian_context(p,state);target=state['records']['member/'+event['member']];cursor=decimal(journal['receipt_cursor']);require(cursor<=count)
 end=min(cursor+16,count);keys=[event_key(n) for n in range(cursor+1,end+1)]
 if keys:
  proved=runtime.read(selection(p,event,keys));height,count=guardian_context(p,proved);state=proved;target=proved['records']['member/'+event['member']]
  for n,key in zip(range(cursor+1,end+1),keys):
   found=proved['records'][key];require(type(found)==dict and found['id']==str(n))
   if matches_receipt(found,command):
    receipt=runtime.read(dict(member=p['guardian'],keys=[*guardian_keys(p),'member/'+event['member']],receipt=dict(envelope=envelope,event_id=found['id'])))
    guardian_context(p,receipt);require(receipt['receipt']['finalized'] is True and receipt['receipt']['event']==found and matches_receipt(receipt['receipt']['event'],command))
    journal.update(status='finalized',receipt_event=found,receipt_height=receipt['height']);write(journal_path,journal)
    if QUORUM is not None:hint(event,command);return dict(done=False,status='awaiting_second_guardian',event=found)
    return dict(done=True,status='finalized',event=found)
  journal['receipt_cursor']=str(end);write(journal_path,journal)
 if end==count and (height>decimal(command['expires_height']) or decimal(state['member']['sequence'])>decimal(command['sequence'])):
  # The old signed command is now incapable of future inclusion. Retain it;
  # a subsequent run may create a fresh attempt after another full screen.
  journal.update(status='expired_or_superseded_nonincluded',nonincluded_through=str(count),closed_height=str(height));write(directory/('closed-attempt-'+str(journal['attempt'])+'.json'),journal);write(journal_path,journal)
  if target is not None and target.get('licence') in ('active','revoked','withdrawn'):return dict(done=True,status='already_'+target['licence'])
  return dict(done=False,status='retry_required')
 return dict(done=False,status='pending_finality')

def check_policy(custody):
 """Preflight custody binding without signing or submitting any command."""
 require(os.geteuid()==0);resource.setrlimit(resource.RLIMIT_CORE,(0,0));os.umask(0o077)
 global QUORUM
 p=validate_policy(load(POLICY));QUORUM=load_quorum(p);ensure_directory(TEMP);state=Runtime(p).read(selection(p));guardian_context(p,state)
 key=native.strict_json(custody.attachment(custody.vault(),p['guardian_key_attachment']));seed=bytearray(public_key(key['private_key']))
 try:
  public,_=native.ed25519(bytes(seed));require(base64.urlsafe_b64encode(public).decode().rstrip('=')==key['public_key']==p['guardian_public_key'] and 'uain1'+digest(public)[:40]==p['guardian'])
 finally:
  for i in range(len(seed)):seed[i]=0
 print(json.dumps(dict(schema='uain-native-admission-preflight-v1',chain_id=p['chain_id'],genesis_sha256=p['genesis_sha256'],guardian=p['guardian'],guardian_public_key=p['guardian_public_key'],height=state['height'],event_count=state['event_count'],private_keys_exported=False,commands_signed=0)))

def run(custody,policy_path=POLICY):
 require(os.geteuid()==0);resource.setrlimit(resource.RLIMIT_CORE,(0,0));os.umask(0o077)
 global QUORUM
 p=validate_policy(load(policy_path));QUORUM=load_quorum(p);ensure_directory(ROOT);ensure_directory(TEMP);directory=ROOT/p['genesis_sha256'];ensure_directory(directory);runtime=Runtime(p);head=runtime.read(selection(p,keys=[event_key(decimal(p['start_event']))] if decimal(p['start_event']) else []));guardian_context(p,head)
 checkpoint=directory/'cursor.json'
 if checkpoint.exists():cursor=load(checkpoint);require(cursor['schema']=='uain-native-admission-cursor-v1' and cursor['policy_sha256']==digest(canonical(p)))
 else:
  require(decimal(p['start_event'])<=decimal(head['event_count']));
  if decimal(p['start_event']):
   captured=head['records'][event_key(decimal(p['start_event']))];require(captured['id']==p['start_event'] and captured['command_digest']==p['start_event_digest'])
  cursor=dict(schema='uain-native-admission-cursor-v1',policy_sha256=digest(canonical(p)),cursor=p['start_event']);atomic(checkpoint,cursor)
 start=decimal(cursor['cursor']);count=decimal(head['event_count']);require(start<=count);end=min(start+p['max_events'],count)
 keys=[event_key(n) for n in range(start+1,end+1)];proof=runtime.read(selection(p,keys=keys)) if keys else head;guardian_context(p,proof);approvals=0;status='current'
 for n,key in zip(range(start+1,end+1),keys):
  runtime.remaining();event=proof['records'][key];require(type(event)==dict and event['id']==str(n))
  if event['operation']=='enrol':
   if approvals>=p['max_approvals']:status='bounded_backlog';break
   path=directory/str(n)
   if (path/'refused.json').exists():
    refused=load(path/'refused.json');require(refused['policy_sha256']==digest(canonical(p)) and refused['enrol_event']==event);result=dict(done=True,status='refused')
   else:
    try:result=process_enrol(custody,p,event,path,runtime)
    except EligibilityRefused as error:
     # Only a proved member's policy eligibility is a durable denial. Broken
     # proofs, authority, pins and persistence still stop the worker safely.
     atomic(path/'refused.json',dict(schema='uain-native-admission-refusal-v1',policy_sha256=digest(canonical(p)),enrol_event=event,reason=error.reason,proved_context=error.context));result=dict(done=True,status='refused')
   status=result['status'];approvals+=1
   if not result['done']:break
  cursor['cursor']=str(n);atomic(checkpoint,cursor)
 print(json.dumps(dict(schema='uain-native-admission-run-v1',status=status,cursor=cursor['cursor'],observed_events=head['event_count'],approvals=approvals,private_keys_exported=False)))

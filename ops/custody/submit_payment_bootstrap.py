"""Root-only consumer of the fixed public payment-bootstrap signed batch.

No vault/key access and no signing. Each retained exact envelope may cross the
network at most once. Reinvocation only reconciles uncertain original receipts.
"""
import datetime,fcntl,json,os,re,stat,sys,time
from pathlib import Path
import native_payment_bootstrap as f

SCHEMA='uain-native-payment-bootstrap-submit-v1'
require=f.require

def command_digest(envelope):return f.sha(f.native.signing_bytes(envelope['command']))
def transaction_hash(envelope):return f.sha(json.dumps(envelope,separators=(',',':')).encode()).upper()
def subject(command):
 require(command['operation'] in ('identity_claim','roles','private_reviewer'))
 return f.did(command['member']) if command['operation']=='identity_claim' else command['payload']['member']

def fresh(a,state,member=None):
 """Only the pinned Runtime may produce this state; never accept raw RPC JSON."""
 require(state['chain_id']==a['chain_id'] and type(state['app_hash'])==str and f.HEX.fullmatch(state['app_hash']))
 value=state['header_time'];require(type(value)==str and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})',value))
 value=re.sub(r'\.([0-9]{1,9})(?=Z|[+-])',lambda m:'.'+(m.group(1)+'000000')[:6],value)
 age=time.time()-datetime.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp();require(-60<=age<=120)
 height=f.decimal(state['height'],2**63-1);count=f.decimal(state['event_count']);require(height>0 and count>=f.decimal(a['expected_event_count']))
 records=state['records'];require(type(records)==dict and all(k in records for k in f.selection(a)['keys']))
 guardian=f.TARGETS['guardian']['member'];require(records['guardian_epoch_current'] is None and type(records['guardians'])==list and guardian in records['guardians'])
 selected=member or state['member']['id'];target=next((t for t in f.TARGETS.values() if t['member']==selected),None);require(target is not None)
 projection=state['member'];raw=records['member/'+selected]
 require(type(projection)==dict and type(raw)==dict)
 for key in ('id','public_key','licence','sequence'):require(projection[key]==raw[key])
 require(raw['id']==selected and raw['public_key']==target['public_key'] and raw['licence']=='active')
 if a['expected_event_count']!='0':
  event=records[f.event_key(f.decimal(a['expected_event_count']))];require(event['id']==a['expected_event_count'] and event['command_digest']==a['expected_last_command_digest'])
 for key,policy in f.POLICIES.items():
  marker=records[key];require(type(marker)==dict and marker.get('policy')==policy and marker.get('evidence_digest')==f.ACTIVATION_EVIDENCE)
  if key in ('coin_activation','private_activation'):
   require(set(marker)=={'policy','height','evidence_digest'}|({'relayer'} if key=='private_activation' else set()))
   require(2<=f.decimal(marker['height'],2**63-1)<=height)
   if key=='private_activation':require(marker['relayer']==f.PRIVATE_RELAYER)
  else:require(set(marker)=={'policy','effective_height','approved_by','evidence_digest'} and marker['approved_by']==guardian and 2<=f.decimal(marker['effective_height'],2**63-1)<=height)
 return height,count

def read(runtime,a,extra=(),receipt=None):
 selection=f.selection(a);selection['keys']=list(dict.fromkeys([*selection['keys'],*extra]));require(len(selection['keys'])<=32)
 if receipt is not None:
  selection['receipt']=receipt
  # Native exact-receipt verification binds the projection to the signer.
  selection['member']=receipt['envelope']['command']['member']
 state=runtime.read(selection);fresh(a,state,selection['member']);require(all(k in state['records'] for k in selection['keys']));return state

def matches(event,envelope):
 command=envelope['command']
 return type(event)==dict and event.get('command_digest')==command_digest(envelope) and event.get('member')==command['member'] and event.get('operation')==command['operation'] and event.get('subject')==subject(command) and not event.get('instance') and not event.get('origin')

def authenticate(runtime,a,envelope,event):
 require(matches(event,envelope));event_id=event['id'];require(f.decimal(event_id)>0)
 state=read(runtime,a,receipt=dict(envelope=envelope,event_id=event_id));receipt=state['receipt']
 require(receipt['authority']=='native' and receipt['finalized'] is True and receipt['chain_id']==a['chain_id'] and receipt['state_height']==state['height'] and receipt['app_hash']==state['app_hash'] and receipt['event']==event and matches(receipt['event'],envelope))
 require(1<=f.decimal(event['height'],2**63-1)<=f.decimal(state['height'],2**63-1) and f.decimal(state['member']['sequence'])>f.decimal(envelope['command']['sequence']))
 return state

def progress(a,state,entries,batch):
 """Permit only changes explained by these exact finalized commands."""
 _,count=fresh(a,state)
 finalized=[(entry,envelope) for entry,envelope in zip(entries,batch['envelopes']) if entry['status']=='finalized']
 require(count==f.decimal(a['expected_event_count'])+len(finalized))
 records=state['records']
 for index,(entry,envelope) in enumerate(finalized):
  event=entry['receipt_event'];require(matches(event,envelope) and f.decimal(event['id'])==f.decimal(a['expected_event_count'])+index+1)
 for name,target in f.TARGETS.items():
  baseline=a['actors'][name];member=records['member/'+target['member']]
  own=[(entry,envelope) for entry,envelope in finalized if envelope['command']['member']==target['member']]
  require(type(member)==dict and member['id']==target['member'] and member['public_key']==target['public_key'] and member['licence']=='active')
  expected=dict(sequence=str(f.decimal(baseline['sequence'])+len(own)),karma=baseline['karma'],credits=baseline['credits'],creator=baseline['creator'],default_verifier=baseline['default_verifier'])
  roles=[entry for entry,envelope in finalized if envelope['command']['operation']=='roles' and envelope['command']['payload']['member']==target['member']]
  if roles:expected.update(creator=True,default_verifier=True)
  for key,value in expected.items():require(type(member[key])==type(value) and member[key]==value)
  identity=records['actor_identity/'+target['member']+'/'];reverse=records['actor_did/'+f.did(target['member'])]
  identity_entries=[entry for entry,envelope in own if envelope['command']['operation']=='identity_claim']
  if identity_entries:
   require(baseline['identity_sha256'] is None);f.binding(identity,reverse,target,count);require(identity['event_id']==identity_entries[0]['receipt_event']['id'])
  else:require(f.record_hash(identity)==baseline['identity_sha256']);f.binding(identity,reverse,target,count)
  reviewer_entries=[entry for entry,envelope in finalized if envelope['command']['operation']=='private_reviewer' and envelope['command']['payload']['member']==target['member']]
  reviewer=records['private_reviewer/'+target['member']]
  if reviewer_entries:require(reviewer==dict(active=True,evidence_digest=a['evidence_sha256']))
  else:require(f.record_hash(reviewer)==baseline['private_reviewer_sha256'])
 return state

def discover(runtime,a,envelope,entry):
 head=read(runtime,a);cursor=f.decimal(entry['scan_cursor']);count=f.decimal(head['event_count']);require(f.decimal(entry['after_event'])<=cursor<=count)
 end=min(cursor+16,count)
 if end==cursor:return None,None,head
 state=read(runtime,a,[f.event_key(n) for n in range(cursor+1,end+1)]);require(f.decimal(state['height'])>=f.decimal(head['height']) and f.decimal(state['event_count'])>=count)
 for n in range(cursor+1,end+1):
  event=state['records'][f.event_key(n)];require(type(event)==dict and event['id']==str(n) and type(event['command_digest'])==str and f.HEX.fullmatch(event['command_digest']))
  if event['command_digest']!=command_digest(envelope):continue
  require(matches(event,envelope));return event,authenticate(runtime,a,envelope,event),state
 entry['scan_cursor']=str(end);return None,None,state

def initial(a,batch):
 return dict(schema=SCHEMA,epoch=a['epoch'],phase=a['phase'],approval_sha256=f.sha(f.canonical(a).encode()),batch_sha256=f.sha(f.canonical(batch).encode()),entries=[dict(index=i,operation=e['command']['operation'],member=e['command']['member'],command_digest=command_digest(e),transaction_hash=transaction_hash(e),status='unattempted',send_attempted_at=None,after_event=None,scan_cursor=None) for i,e in enumerate(batch['envelopes'])])

def journal_binding(a,batch,journal):
 expected=initial(a,batch);require(type(journal)==dict and set(journal)==set(expected) and all(journal[k]==v for k,v in expected.items() if k!='entries') and type(journal['entries'])==list and len(journal['entries'])==len(expected['entries']))
 allowed={'receipt_event','receipt_height','receipt_app_hash','broadcast_code','prevented_reason'}
 for entry,base in zip(journal['entries'],expected['entries']):
  require(type(entry)==dict and set(base)<=set(entry)<=set(base)|allowed and all(entry[k]==base[k] for k in ('index','operation','member','command_digest','transaction_hash')) and entry['status'] in ('unattempted','broadcast_started','accepted','refused','uncertain','finalized','not_broadcast'))
  if entry['send_attempted_at'] is None:require(entry['status']=='unattempted' and entry['after_event'] is None and entry['scan_cursor'] is None)
  else:
   require(type(entry['send_attempted_at'])==str and f.decimal(entry['after_event'])>=f.decimal(a['expected_event_count']) and f.decimal(entry['scan_cursor'])>=f.decimal(entry['after_event']))
   if entry['status']=='finalized':require(type(entry.get('receipt_event'))==dict)
 for index,entry in enumerate(journal['entries']):
  if entry['send_attempted_at']:require(all(previous['status']=='finalized' for previous in journal['entries'][:index]))
 return journal

def send_guard(a,state,envelope):
 fresh(a,state)
 require(time.time()<a['expires_at'] and f.decimal(state['height'])<f.decimal(envelope['command']['expires_height']))
 member=state['records']['member/'+envelope['command']['member']];require(member['sequence']==envelope['command']['sequence'])

def prevented(a,entry,journal,path,state,write):
 if entry['send_attempted_at'] is None:entry.update(send_attempted_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),after_event=state['event_count'],scan_cursor=state['event_count'])
 entry.update(status='not_broadcast',prevented_reason='proof_or_approval_expired_before_send');write(path,journal)
 return dict(status='not_broadcast',complete=False,phase=a['phase'],operation=entry['operation'],broadcasts_retried=False)

def process(a,raw,batch,directory,runtime,load=f.load,write=f.admission.atomic):
 f.approval(a);f.evidence(a,raw);f.retained(a,raw,batch)
 path=Path(directory)/'submit-journal.json'
 try:journal=journal_binding(a,batch,load(path))
 except FileNotFoundError:journal=initial(a,batch);write(path,journal)
 entries=journal['entries']
 for index,(entry,envelope) in enumerate(zip(entries,batch['envelopes'])):
  if entry['status']=='not_broadcast':return dict(status='not_broadcast',complete=False,phase=a['phase'],operation=entry['operation'],broadcasts_retried=False)
  if entry['status']=='finalized':authenticate(runtime,a,envelope,entry['receipt_event']);continue
  if entry['send_attempted_at'] is None:
   state=read(runtime,a)
   if time.time()>=a['expires_at'] or f.decimal(state['height'])>=f.decimal(envelope['command']['expires_height']):return prevented(a,entry,journal,path,state,write)
   if index==0:f.validate(a,state,raw)
   else:
    for previous,previous_envelope in zip(entries[:index],batch['envelopes'][:index]):require(previous['status']=='finalized');authenticate(runtime,a,previous_envelope,previous['receipt_event'])
    state=read(runtime,a)
   progress(a,state,entries,batch)
   try:send_guard(a,state,envelope)
   except Exception:return prevented(a,entry,journal,path,state,write)
   entry.update(status='broadcast_started',send_attempted_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),after_event=state['event_count'],scan_cursor=state['event_count']);write(path,journal)
   # Slow durable persistence must not turn a previously current proof/approval
   # into signing authority. Never retry these retained bytes automatically.
   try:send_guard(a,state,envelope)
   except Exception:return prevented(a,entry,journal,path,state,write)
   try:
    code=runtime.broadcast(envelope);require(type(code)==int and code>=0);entry.update(status='accepted' if code==0 else 'refused',broadcast_code=code)
   except Exception:entry.update(status='uncertain')
   write(path,journal)
  event,final,head=discover(runtime,a,envelope,entry)
  if event is None:
   write(path,journal);return dict(status='refused' if entry['status']=='refused' else 'pending_finality',complete=False,phase=a['phase'],operation=entry['operation'],commands_finalized=sum(e['status']=='finalized' for e in entries),more_events=f.decimal(entry['scan_cursor'])<f.decimal(head['event_count']),broadcasts_retried=False)
  entry.update(status='finalized',receipt_event=event,receipt_height=final['height'],receipt_app_hash=final['app_hash'],scan_cursor=event['id']);write(path,journal)
  progress(a,final,entries,batch)
 state=read(runtime,a);progress(a,state,entries,batch)
 return dict(status='complete',complete=True,phase=a['phase'],commands_finalized=len(entries),height=state['height'],event_count=state['event_count'],operator=f.OPERATOR,independent_operators=False,service_available_by_appointment=False,mint=False,payment=False,karma_change=False,broadcasts_retried=False)

def run(epoch):
 require(os.geteuid()==0 and type(epoch)==str and re.fullmatch(r'[a-f0-9]{32}',epoch))
 directory=f.ROOT/epoch;f.admission.ensure_directory(f.ROOT);f.admission.ensure_directory(directory);f.admission.ensure_directory(f.admission.TEMP)
 fd=os.open(f.ROOT/'bootstrap.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)
 try:
  info=os.fstat(fd);require(stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_nlink==1 and not info.st_mode&0o077);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  a=f.load(directory/'approval.json');require(a['epoch']==epoch);raw=f.native.protected_read(directory/'evidence.json',1024*1024);batch=f.load(directory/'signed.json')
  f.approval(a);e=f.evidence(a,raw);f.validate_artifacts(a,e);f.retained(a,raw,batch)
  runtime=f.admission.Runtime(f.runtime_policy(a));result=process(a,raw,batch,directory,runtime);print(json.dumps(result));return result
 finally:os.close(fd)

if __name__=='__main__':
 try:
  require(len(sys.argv)==2);run(sys.argv[1])
 except Exception as error:
  print(json.dumps(dict(status='refused',error_type=type(error).__name__,broadcasts_retried=False)),file=sys.stderr);sys.exit(1)

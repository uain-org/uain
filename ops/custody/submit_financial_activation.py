"""Submit only an already approved, signed public policy phase; never use keys.

The custody helper owns signing. This separate consumer imports its public
validation routines and invokes only pinned reads plus the bounded local
broadcast transport. Every envelope has a durable send-once marker. Invoke
again to discover exact finalized receipts; pending/uncertain sends never retry.
"""
import datetime,hashlib,json,os,re,sys,time
from pathlib import Path
import native_financial_activation as f

SCHEMA='uain-native-financial-activation-submit-v1'
HEX=re.compile(r'^[a-f0-9]{64}$')
require=f.require

def command_digest(envelope):return f.sha(f.native.signing_bytes(envelope['command']))
def transaction_hash(envelope):return f.sha(json.dumps(envelope,separators=(',',':')).encode()).upper()
def fresh(a,state):
 require(state['chain_id']==a['chain_id'] and HEX.fullmatch(state['app_hash']))
 value=state['header_time'];require(type(value)==str and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})',value))
 value=re.sub(r'\.([0-9]{1,9})(?=Z|[+-])',lambda m:'.'+(m.group(1)+'000000')[:6],value)
 age=time.time()-datetime.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp();require(-60<=age<=120)
 height=f.decimal(state['height'],2**63-1);count=f.decimal(state['event_count']);require(height>0 and count>=f.decimal(a['expected_event_count']))
 member=state['member'];require(member['id']==a['guardian'] and member['public_key']==a['guardian_public_key'] and member['licence']=='active')
 records=state['records'];require(records['guardian_epoch_current'] is None and a['guardian'] in records['guardians'])
 relay=records['member/'+a['relayer']];require(relay['id']==a['relayer'] and relay['public_key']==a['relayer_public_key'] and relay['licence']=='active')
 if a['expected_event_count']!='0':
  last=records[f.event_key(f.decimal(a['expected_event_count']))];require(last['id']==a['expected_event_count'] and last['command_digest']==a['expected_last_command_digest'])
 return height,count

def read(runtime,a,extra=(),receipt=None):
 selection=f.selection(a);selection['keys']+=list(extra)
 if receipt is not None:selection['receipt']=receipt
 state=runtime.read(selection);fresh(a,state);return state

def marker(a,state,key,digest,event=None):
 value=state['records'][key];require(type(value)==dict and value['policy']==f.POLICIES[key] and value['evidence_digest']==digest)
 if key in ('private_activation','coin_activation'):
  fields={'policy','height','evidence_digest'}|({'relayer'} if key=='private_activation' else set())
  require(set(value)==fields)
  if key=='private_activation':require(value['relayer']==a['relayer'])
  effective=f.decimal(value['height'],2**63-1)
 else:
  require(set(value)=={'policy','effective_height','approved_by','evidence_digest'} and value['approved_by']==a['guardian']);effective=f.decimal(value['effective_height'],2**63-1)
 require(effective>=2)
 if event is not None:require(effective==f.decimal(event['height'],2**63-1)+1)
 return effective<=f.decimal(state['height'],2**63-1)

def progress(a,state,entries):
 """Prove resulting phase records, preserving absence of unexecuted targets."""
 ready=True;records=state['records'];done={}
 for key in f.PREDECESSORS[a['phase']]:require(marker(a,state,key,a['predecessor_evidence'][key]))
 for entry,(_,key) in zip(entries,f.PHASES[a['phase']]):
  if entry['status']=='finalized':ready=marker(a,state,key,a['evidence_sha256'],entry['receipt_event']) and ready;done[key]=records[key]
  else:require(records[key] is None)
 for key in f.POLICIES:
  if key not in f.PREDECESSORS[a['phase']] and key not in done:require(records[key] is None)
 if 'private_activation' in done:
  frontier=records['private_frontier'];require(type(frontier)==dict and set(frontier)=={'count','root','nodes'} and frontier['count']=='0' and HEX.fullmatch(frontier['root']) and type(frontier['nodes'])==list and len(frontier['nodes'])==32 and all(n=='' for n in frontier['nodes']))
 else:require(records['private_frontier'] is None)
 if 'coin_activation' in done:require(records['coin_supply']==dict(minted='0',reserved='0',transparent='0',shielded='0'))
 else:require(records['coin_supply'] is None)
 return ready,done

def matches(event,envelope):
 command=envelope['command']
 return type(event)==dict and event.get('command_digest')==command_digest(envelope) and event.get('member')==command['member'] and event.get('operation')==command['operation'] and event.get('subject')==command['payload']['policy'] and not event.get('instance')

def authenticate(runtime,a,envelope,event):
 require(matches(event,envelope));event_id=event['id'];require(f.decimal(event_id)>0)
 state=read(runtime,a,receipt=dict(envelope=envelope,event_id=event_id));receipt=state['receipt']
 require(receipt['authority']=='native' and receipt['finalized'] is True and receipt['chain_id']==a['chain_id'] and receipt['state_height']==state['height'] and receipt['app_hash']==state['app_hash'] and receipt['event']==event and matches(receipt['event'],envelope))
 require(1<=f.decimal(event['height'],2**63-1)<=f.decimal(state['height'],2**63-1) and f.decimal(state['member']['sequence'])>f.decimal(envelope['command']['sequence']))
 return state

def discover(runtime,a,envelope,entry):
 head=read(runtime,a);cursor=f.decimal(entry['scan_cursor']);count=f.decimal(head['event_count']);require(f.decimal(entry['after_event'])<=cursor<=count)
 end=min(cursor+16,count)
 if end==cursor:return None,None,head
 keys=[f.event_key(n) for n in range(cursor+1,end+1)];state=read(runtime,a,keys)
 require(f.decimal(state['height'])>=f.decimal(head['height']) and f.decimal(state['event_count'])>=count)
 for n,key in zip(range(cursor+1,end+1),keys):
  event=state['records'][key];require(type(event)==dict and event['id']==str(n) and HEX.fullmatch(event['command_digest']))
  if event['command_digest']!=command_digest(envelope):continue
  require(matches(event,envelope));return event,authenticate(runtime,a,envelope,event),state
 entry['scan_cursor']=str(end);return None,None,state

def initial(a,batch):
 return dict(schema=SCHEMA,epoch=a['epoch'],phase=a['phase'],approval_sha256=f.sha(f.canonical(a).encode()),batch_sha256=f.sha(f.canonical(batch).encode()),entries=[dict(index=i,operation=envelope['command']['operation'],command_digest=command_digest(envelope),transaction_hash=transaction_hash(envelope),status='unattempted',send_attempted_at=None,after_event=None,scan_cursor=None) for i,envelope in enumerate(batch['envelopes'])])

def journal_binding(a,batch,journal):
 expected=initial(a,batch)
 require(type(journal)==dict and set(journal)==set(expected) and all(journal[key]==expected[key] for key in expected if key!='entries') and type(journal['entries'])==list and len(journal['entries'])==len(expected['entries']))
 for entry,base in zip(journal['entries'],expected['entries']):
  require(type(entry)==dict and all(entry[key]==base[key] for key in ('index','operation','command_digest','transaction_hash')) and entry['status'] in ('unattempted','broadcast_started','accepted','refused','uncertain','finalized'))
  if entry['status']=='unattempted':require(entry['send_attempted_at'] is None and entry['after_event'] is None and entry['scan_cursor'] is None)
  else:
   require(type(entry['send_attempted_at'])==str and f.decimal(entry['after_event'])>=f.decimal(a['expected_event_count']) and f.decimal(entry['scan_cursor'])>=f.decimal(entry['after_event']))
   if entry['status']=='finalized':require('receipt_event' in entry)
 for i,entry in enumerate(journal['entries']):
  if entry['send_attempted_at']:require(all(previous['status']=='finalized' for previous in journal['entries'][:i]))
 return journal

def process(a,raw,batch,directory,runtime,load=f.load,write=f.admission.atomic):
 f.approval(a);f.evidence(a,raw);f.retained(a,raw,batch)
 directory=Path(directory);path=directory/'submit-journal.json'
 try:journal=journal_binding(a,batch,load(path))
 except FileNotFoundError:journal=initial(a,batch);write(path,journal)
 entries=journal['entries'];state=None
 for index,(entry,envelope) in enumerate(zip(entries,batch['envelopes'])):
  if entry['status']=='finalized':
   state=authenticate(runtime,a,envelope,entry['receipt_event']);continue
  if entry['send_attempted_at'] is None:
   state=read(runtime,a)
   require(time.time()<a['expires_at'] and state['member']['sequence']==envelope['command']['sequence'] and f.decimal(state['height'])<f.decimal(envelope['command']['expires_height']))
   if index==0:f.validate(a,state,raw)
   else:
    for previous,previous_envelope in zip(entries[:index],batch['envelopes'][:index]):
     require(previous['status']=='finalized');state=authenticate(runtime,a,previous_envelope,previous['receipt_event'])
    # The second command is allowed only after exact first-command finality,
    # and with all unexecuted policy targets still proven absent.
    progress(a,state,entries)
    state=read(runtime,a);require(state['member']['sequence']==envelope['command']['sequence'] and f.decimal(state['height'])<f.decimal(envelope['command']['expires_height']));progress(a,state,entries)
   # Receipt and proof reads can consume the remaining wall-clock approval.
   require(time.time()<a['expires_at'])
   entry.update(status='broadcast_started',send_attempted_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),after_event=state['event_count'],scan_cursor=state['event_count'])
   # This durable mutation is strictly before the sole possible network send.
   write(path,journal)
   try:
    code=runtime.broadcast(envelope);require(type(code)==int and code>=0);entry.update(status='accepted' if code==0 else 'refused',broadcast_code=code)
   except Exception:entry.update(status='uncertain')
   write(path,journal)
  event,final,head=discover(runtime,a,envelope,entry)
  if event is None:
   write(path,journal)
   return dict(status='refused' if entry['status']=='refused' else 'pending_finality',complete=False,phase=a['phase'],operation=entry['operation'],commands_finalized=sum(e['status']=='finalized' for e in entries),more_events=f.decimal(entry['scan_cursor'])<f.decimal(head['event_count']),send_attempted=True,broadcasts_retried=False)
  entry.update(status='finalized',receipt_event=event,receipt_height=final['height'],receipt_app_hash=final['app_hash'],scan_cursor=event['id'])
  write(path,journal);state=final
 # Re-authenticate current resulting state, including following-height activation.
 state=read(runtime,a);ready,markers=progress(a,state,entries)
 result=dict(status='complete' if ready else 'awaiting_activation_height',complete=ready,phase=a['phase'],commands_finalized=len(entries),height=state['height'],event_count=state['event_count'],markers=markers,broadcasts_retried=False)
 if a['phase']=='economy':result['coin_supply']=state['records']['coin_supply'];result['private_frontier_count']=state['records']['private_frontier']['count']
 return result

def run(epoch):
 import fcntl,stat
 require(os.geteuid()==0 and type(epoch)==str and re.fullmatch(r'[a-f0-9]{32}',epoch))
 directory=f.ROOT/epoch;f.admission.ensure_directory(f.ROOT);f.admission.ensure_directory(directory);f.admission.ensure_directory(f.admission.TEMP)
 fd=os.open(directory/'submit.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
 try:
  info=os.fstat(fd);require(stat.S_ISREG(info.st_mode) and info.st_uid==0 and not info.st_mode&0o077 and info.st_nlink==1);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  a=f.load(directory/'approval.json');require(a['epoch']==epoch);raw=f.native.protected_read(directory/'evidence.json',1024*1024);batch=f.load(directory/'signed.json')
  f.approval(a);e=f.evidence(a,raw);f.validate_artifacts(a,e);f.retained(a,raw,batch)
  runtime=f.admission.Runtime(f.runtime_policy(a));result=process(a,raw,batch,directory,runtime);print(json.dumps(result));return result
 finally:os.close(fd)
if __name__=='__main__':
 try:
  require(len(sys.argv)==2);run(sys.argv[1])
 except Exception as error:
  print(json.dumps(dict(status='refused',error_type=type(error).__name__,broadcasts_retried=False)),file=sys.stderr);sys.exit(1)

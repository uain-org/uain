"""Prepare only the fixed prospective one-AI$ BAINK safety research bounty.

No result, award, mint, claim, identity or independent participant is created.
Four public commands are fixed; source access, prior art and frozen criteria
need reviewed root evidence before signing. Submission is send-once and uses
only pinned native proofs. No production action is performed by importing it.
"""
import base64,datetime,fcntl,json,os,re,resource,stat,sys,time
from pathlib import Path
from urllib.parse import urlparse
import native_migration as native
import native_admission as admission
import native_financial_activation as financial

ROOT=Path('/var/lib/uain-custody/native-bounty-opening')
PROJECT='P-baink-safety-20261104';TASK='T-baink-safety-20261104';AMOUNT='1000000'
GUARDIAN=native.GUARDIAN;CHAIN=native.CHAIN;GENESIS=native.GENESIS
PUBLIC='mDuiMoDUKg66PitMD-j1pztm81wOKlYq7nFFCWLXoRI'
PRIVATE_RELAYER='uain1215c651b70db82b70532a496c26fdf424f3bb369'
PROJECT_TITLE='Original safety research for the frozen BAINK payment and earning release'
TASK_TITLE='New bounded executable safety model or original counterexample for frozen BAINK'
APPROVAL_SCHEMA='uain-baink-safety-bounty-approval-v1';EVIDENCE_SCHEMA='uain-baink-safety-bounty-evidence-v1';BATCH_SCHEMA='uain-baink-safety-bounty-batch-v1'
HEX=financial.HEX;canonical=native.canonical;sha=native.sha;decimal=native.decimal
LIMITATIONS=dict(mint=False,claim=False,result_acceptance=False,independent_operators_established=False,cash_value=False,credit_conversion=False)
FIELDS={'schema','epoch','chain_id','genesis','genesis_sha256','state_binary','state_sha256','daemon_binary','daemon_sha256','guardian_public_key','evidence_sha256','starting_sequence','expected_event_count','expected_last_command_digest','expires_at','expires_height','guardian_baseline','supply_baseline'}
def require(ok):
 if not ok:raise ValueError('Fixed prospective bounty opening refused')
def exact(v,keys):return type(v)==dict and set(v)==set(keys)
def text(v,low,high):return type(v)==str and low<=len(v.encode())<=high and '\x00' not in v
def instant(v):
 require(type(v)==str and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})',v));v=re.sub(r'\.([0-9]{1,9})(?=Z|[+-])',lambda m:'.'+(m.group(1)+'000000')[:6],v);return datetime.datetime.fromisoformat(v.replace('Z','+00:00')).timestamp()
def approval(a):
 require(exact(a,FIELDS) and a['schema']==APPROVAL_SCHEMA and type(a['epoch'])==str and re.fullmatch(r'[a-f0-9]{32}',a['epoch']) and a['chain_id']==CHAIN and a['genesis_sha256']==GENESIS and a['guardian_public_key']==PUBLIC)
 for field in ('genesis','state_binary','daemon_binary'):require(type(a[field])==str and Path(a[field]).is_absolute())
 for field in ('state_sha256','daemon_sha256','evidence_sha256'):require(type(a[field])==str and HEX.fullmatch(a[field]))
 require(a['state_sha256']=='136698192e9e38323a552f1e2da2eea5b9b90e3d6e7de11116d72ee28c826860' and a['daemon_sha256']=='715a3a6b19c7a844111ba6fe3fd63da97ad8145c386e2b076383fd348a3b5160')
 decimal(a['starting_sequence']);count=decimal(a['expected_event_count']);decimal(a['expires_height'],2**63-1);require(type(a['expires_at'])==int and (a['expected_last_command_digest']=='' if count==0 else type(a['expected_last_command_digest'])==str and HEX.fullmatch(a['expected_last_command_digest'])))
 m=a['guardian_baseline'];require(exact(m,['karma','credits','active_projects','creator','default_verifier']) and type(m['karma'])==int and -(2**63)<=m['karma']<2**63 and type(m['active_projects'])==int and 0<=m['active_projects']<2**63-1 and m['creator'] is True and m['default_verifier'] is True);decimal(m['credits'])
 supply=a['supply_baseline'];require(exact(supply,['minted','reserved','transparent','shielded']));values={k:decimal(v,108000000000000000000) for k,v in supply.items()};require(values['transparent']+values['shielded']==values['minted'] and values['minted']+values['reserved']+int(AMOUNT)<=108000000000000000000)
 return a
def evidence(a,raw):
 require(type(raw)==bytes and 1<=len(raw)<=1024*1024 and sha(raw)==a['evidence_sha256']);e=native.strict_json(raw)
 require(exact(e,['schema','authorization','source','prior_art','criteria','criteria_sha256','access','acceptance','limitations','novelty_scope']) and e['schema']==EVIDENCE_SCHEMA and text(e['authorization'],20,4000) and exact(e['limitations'],LIMITATIONS) and all(v is False for v in e['limitations'].values()) and e['novelty_scope']=='exact-new-model-or-original-counterexample-only')
 source=e['source'];require(exact(source,['release','version','manifest_sha256','package_sha256','materials_manifest_sha256','access_url']) and text(source['release'],10,100) and text(source['version'],3,30))
 for k in ('manifest_sha256','package_sha256','materials_manifest_sha256'):require(type(source[k])==str and HEX.fullmatch(source[k]))
 url=urlparse(source['access_url']);require(url.scheme=='https' and url.netloc=='baink.money' and url.path=='/api/native/earning/materials/'+TASK and not url.query and not url.fragment)
 prior=e['prior_art'];require(exact(prior,['basis','searches','reviewed_at','reviewer','artifact_sha256']) and text(prior['basis'],40,4000) and prior['basis']==prior['basis'].strip() and type(prior['searches'])==list and 2<=len(prior['searches'])<=20 and all(text(v,5,1000) and v==v.strip() for v in prior['searches']) and len(set(prior['searches']))==len(prior['searches']) and text(prior['reviewer'],5,200) and HEX.fullmatch(prior['artifact_sha256']));instant(prior['reviewed_at'])
 require(text(e['criteria'],200,4000) and type(e['criteria_sha256'])==str and sha(e['criteria'].encode())==e['criteria_sha256'])
 # The immutable scope itself must be present in the consensus-frozen criteria.
 for value in (source['release'],source['manifest_sha256'],source['materials_manifest_sha256']):require(value in e['criteria'])
 require(all(word in e['criteria'].lower() for word in ('prior art','independent','bounds','non-vacuity','counterexample','known','post-opening')))
 access=e['access'];require(exact(access,['available','authenticated','verified_at','receipt_sha256']) and access['available'] is True and access['authenticated'] is True and HEX.fullmatch(access['receipt_sha256']));instant(access['verified_at'])
 refs=e['acceptance'];require(type(refs)==list and 1<=len(refs)<=16)
 for item in refs:require(exact(item,['path','sha256']) and type(item['path'])==str and Path(item['path']).is_absolute() and HEX.fullmatch(item['sha256']))
 require(len({x['path'] for x in refs})==len(refs) and {prior['artifact_sha256'],access['receipt_sha256'],source['manifest_sha256'],source['package_sha256'],source['materials_manifest_sha256']}<={x['sha256'] for x in refs});return e
def commands(a,e):
 prior={k:e['prior_art'][k] for k in ('basis','searches')};opening=str(decimal(a['expected_event_count'])+2).zfill(20)
 payloads=[('open_project',dict(id=PROJECT,title=PROJECT_TITLE,**{'class':'benevolent'},prior_art=prior)),('open_task',dict(id=TASK,project=PROJECT,title=TASK_TITLE,**{'class':'benevolent'},prior_art=prior,criteria=e['criteria'],kind='instant',karma_reward=1,credit_reward='1',verifiers_required=2)),('coin_quote',dict(task=TASK,open_event=opening,amount=AMOUNT,evidence_digest=a['evidence_sha256'])),('coin_reserve',dict(task=TASK,evidence_digest=a['evidence_sha256']))]
 return[dict(version=1,chain_id=CHAIN,member=GUARDIAN,sequence=str(decimal(a['starting_sequence'])+i),expires_height=a['expires_height'],operation=op,payload=payload) for i,(op,payload) in enumerate(payloads)]
def selection(a,extra=(),receipt=None):
 keys=[*financial.POLICIES,'guardians','guardian_epoch_current','member/'+GUARDIAN,'coin_supply','project/'+PROJECT,'task/'+TASK,'coin_quote/'+TASK,'coin_reservation/'+TASK]
 if a['expected_event_count']!='0':keys.append(admission.event_key(decimal(a['expected_event_count'])))
 result=dict(member=GUARDIAN,keys=list(dict.fromkeys([*keys,*extra])))
 if receipt is not None:result['receipt']=receipt
 return result
def fresh(a,state):
 require(state['chain_id']==CHAIN and type(state['app_hash'])==str and HEX.fullmatch(state['app_hash']) and -60<=time.time()-instant(state['header_time'])<=120);height=decimal(state['height'],2**63-1);require(height>0)
 r=state['records'];require(all(k in r for k in selection(a)['keys']) and r['guardian_epoch_current'] is None and GUARDIAN in r['guardians'])
 for k,p in financial.POLICIES.items():
  marker=r[k];require(type(marker)==dict and marker['policy']==p and marker.get('evidence_digest')=='c8467e4fd7624d7744f6d44a947513b8e4d94becd6f5a7189ff55648384b6fe4')
  if k in ('private_activation','coin_activation'):
   require(exact(marker,{'policy','height','evidence_digest'}|({'relayer'} if k=='private_activation' else set())) and 2<=decimal(marker['height'],2**63-1)<=height)
   if k=='private_activation':require(marker['relayer']==PRIVATE_RELAYER)
  else:require(exact(marker,['policy','effective_height','approved_by','evidence_digest']) and marker['approved_by']==GUARDIAN and 2<=decimal(marker['effective_height'],2**63-1)<=height)
 member=r['member/'+GUARDIAN];require(member['id']==GUARDIAN and member['public_key']==PUBLIC and member['licence']=='active' and member['creator'] is True and member['default_verifier'] is True)
 for field in ('id','public_key','licence','sequence'):require(state['member'][field]==member[field])
 if a['expected_event_count']!='0':require(r[admission.event_key(decimal(a['expected_event_count']))]['command_digest']==a['expected_last_command_digest'])
 return height,decimal(state['event_count'])
def progress(a,state,done):
 height,count=fresh(a,state);r=state['records'];require(count==decimal(a['expected_event_count'])+done);m=r['member/'+GUARDIAN];require(decimal(m['sequence'])==decimal(a['starting_sequence'])+done)
 for k in ('karma','credits','creator','default_verifier'):require(type(m[k])==type(a['guardian_baseline'][k]) and m[k]==a['guardian_baseline'][k])
 require(m['active_projects']==a['guardian_baseline']['active_projects']+(1 if done>=1 else 0))
 p=r['project/'+PROJECT];t=r['task/'+TASK];q=r['coin_quote/'+TASK];v=r['coin_reservation/'+TASK]
 if done<1:require(p is None)
 else:require(type(p)==dict and p['id']==PROJECT and p['lead']==GUARDIAN and p['state']=='active' and p['budget']=='0' and p['storage_policy']==financial.POLICIES['storage_activation'])
 if done<2:require(t is None)
 else:require(type(t)==dict and t['id']==TASK and t['project']==PROJECT and t['state']=='open' and t['karma_reward']==1 and t['credit_reward']=='1' and t['verifiers_required']==2 and t['kind']=='instant' and not t.get('winner') and not t.get('submissions'))
 if done<3:require(q is None)
 else:require(type(q)==dict and q['task']==TASK and q['amount']==AMOUNT and q['manager']==GUARDIAN and q['open_event']==str(decimal(a['expected_event_count'])+2).zfill(20) and q['evidence_digest']==a['evidence_sha256'])
 if done<4:require(v is None)
 else:require(type(v)==dict and v['task']==TASK and v['amount']==AMOUNT and v['state']=='reserved' and v['evidence_digest']==a['evidence_sha256'])
 supply=dict(a['supply_baseline']);supply['reserved']=str(decimal(supply['reserved'])+(int(AMOUNT) if done>=4 else 0));require(r['coin_supply']==supply);return height
def validate(a,raw,state):
 approval(a);e=evidence(a,raw);height=progress(a,state,0);now=time.time();require(now<a['expires_at']<=now+3600 and height+14<decimal(a['expires_height'],2**63-1)<=height+100 and decimal(a['starting_sequence'])+4<=2**64-1 and -60<=now-instant(e['access']['verified_at'])<=3600 and 0<=now-instant(e['prior_art']['reviewed_at'])<=86400*7);return e
def verify_batch(a,raw,batch):
 approval(a);e=evidence(a,raw);require(exact(batch,['schema','epoch','approval_sha256','evidence_sha256','envelopes','private_keys_exported','broadcast']) and batch['schema']==BATCH_SCHEMA and batch['epoch']==a['epoch'] and batch['approval_sha256']==sha(canonical(a).encode()) and batch['evidence_sha256']==a['evidence_sha256'] and batch['private_keys_exported'] is False and batch['broadcast'] is False and len(batch['envelopes'])==4)
 for envelope,command in zip(batch['envelopes'],commands(a,e)):admission.verify_envelope(dict(guardian_public_key=PUBLIC),envelope,command)
 return batch
def sign_batch(custody,a,raw,state):
 e=validate(a,raw,state);value=native.strict_json(custody.attachment(custody.vault(),'keys/uain-review-key.json'));require(value['public_key']==PUBLIC);seed=bytearray(admission.public_key(value['private_key']))
 try:
  public,sign=native.ed25519(bytes(seed));require(base64.urlsafe_b64encode(public).decode().rstrip('=')==PUBLIC);envelopes=[]
  for command in commands(a,e):validate(a,raw,state);envelopes.append(dict(command=command,public_key=PUBLIC,signature=base64.urlsafe_b64encode(sign(native.signing_bytes(command))).decode().rstrip('=')))
 finally:
  for i in range(len(seed)):seed[i]=0
 return dict(schema=BATCH_SCHEMA,epoch=a['epoch'],approval_sha256=sha(canonical(a).encode()),evidence_sha256=a['evidence_sha256'],envelopes=envelopes,private_keys_exported=False,broadcast=False)
def sign_once(custody,a,raw,state,directory,execute=False,load=financial.load,write=admission.atomic):
 require(type(execute)==bool);approval(a);e=evidence(a,raw);financial.validate_artifacts(a,e);directory=Path(directory);path=directory/'signing.json'
 if path.exists():
  journal=load(path);batch=verify_batch(a,raw,load(directory/'signed.json'));require(journal['approval_sha256']==sha(canonical(a).encode()) and journal['status'] in ('signing-started','signed'))
  if journal['status']=='signed':require(journal['batch_sha256']==sha(canonical(batch).encode()))
  return dict(status='retained',commands_signed=4,broadcast=False,private_keys_exported=False)
 selected=validate(a,raw,state)
 if not execute:return dict(status='preflight',commands=commands(a,selected),commands_signed=0,broadcast=False,private_keys_exported=False)
 write(path,dict(status='signing-started',approval_sha256=sha(canonical(a).encode())));batch=sign_batch(custody,a,raw,state);write(directory/'signed.json',batch);write(path,dict(status='signed',approval_sha256=sha(canonical(a).encode()),batch_sha256=sha(canonical(batch).encode())));return dict(status='signed',commands_signed=4,broadcast=False,private_keys_exported=False)
def submit_once(a,raw,batch,directory,runtime,load=financial.load,write=admission.atomic):
 verify_batch(a,raw,batch);directory=Path(directory);path=directory/'submit.json'
 if path.exists():journal=load(path);require(journal['batch_sha256']==sha(canonical(batch).encode()) and len(journal['entries'])==4)
 else:journal=dict(batch_sha256=sha(canonical(batch).encode()),entries=[dict(status='unattempted',digest=sha(native.signing_bytes(e['command']))) for e in batch['envelopes']]);write(path,journal)
 for i,(entry,envelope) in enumerate(zip(journal['entries'],batch['envelopes'])):
  require(entry['digest']==sha(native.signing_bytes(envelope['command'])) and entry['status'] in ('unattempted','broadcast-started','accepted','refused','uncertain','not-broadcast','finalized'))
  if entry['status']=='finalized':continue
  event_id=str(decimal(a['expected_event_count'])+i+1);event_key=admission.event_key(int(event_id));state=runtime.read(selection(a,[event_key]));fresh(a,state)
  if entry['status']=='unattempted':
   height=progress(a,state,i);require(time.time()<a['expires_at'] and height<decimal(a['expires_height'],2**63-1));entry.update(status='broadcast-started',send_attempted_at=int(time.time()));write(path,journal)
   state=runtime.read(selection(a,[event_key]));height=progress(a,state,i)
   if time.time()>=a['expires_at'] or height>=decimal(a['expires_height'],2**63-1):entry['status']='not-broadcast';write(path,journal);return dict(status='not-broadcast',complete=False,broadcasts_retried=False)
   try:code=runtime.broadcast(envelope);require(type(code)==int and code>=0);entry.update(status='accepted' if code==0 else 'refused',code=code)
   except Exception:entry['status']='uncertain'
   write(path,journal);state=runtime.read(selection(a,[event_key]));fresh(a,state)
  event=state['records'][event_key]
  if event is None:return dict(status='pending-finality',complete=False,commands_finalized=i,broadcasts_retried=False)
  command=envelope['command'];subject=PROJECT if i==0 else TASK
  require(event['id']==event_id and event['command_digest']==entry['digest'] and event['member']==GUARDIAN and event['operation']==command['operation'] and event['subject']==subject and not event.get('instance') and not event.get('origin'))
  # The native gateway appends and proves the receipt event key itself; adding
  # it explicitly would duplicate the selection and be correctly refused.
  state=runtime.read(selection(a,receipt=dict(envelope=envelope,event_id=event_id)));fresh(a,state);receipt=state['receipt'];require(receipt['authority']=='native' and receipt['finalized'] is True and receipt['chain_id']==CHAIN and receipt['state_height']==state['height'] and receipt['app_hash']==state['app_hash'] and receipt['event']==event);progress(a,state,i+1)
  entry.update(status='finalized',receipt=receipt);write(path,journal)
 state=runtime.read(selection(a));progress(a,state,4);return dict(status='complete',complete=True,commands_finalized=4,project=PROJECT,task=TASK,reserved_units=AMOUNT,mint=False,claim=False,result_acceptance=False,independent_operators_established=False,broadcasts_retried=False)
def run(mode,epoch,custody=None):
 require(os.geteuid()==0 and mode in ('check','sign','submit') and type(epoch)==str and re.fullmatch(r'[a-f0-9]{32}',epoch));resource.setrlimit(resource.RLIMIT_CORE,(0,0));os.umask(0o077);admission.ensure_directory(ROOT);admission.ensure_directory(admission.TEMP);directory=ROOT/epoch;admission.ensure_directory(directory)
 fd=os.open(ROOT/'bounty.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)
 with os.fdopen(fd,'r+b') as lock:
  s=os.fstat(lock.fileno());require(stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_nlink==1 and not s.st_mode&0o077);fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  a=financial.load(directory/'approval.json');require(a['epoch']==epoch);raw=native.protected_read(directory/'evidence.json',1024*1024);approval(a);e=evidence(a,raw);financial.validate_artifacts(a,e);runtime=admission.Runtime(financial.runtime_policy(a))
  if mode=='submit':return submit_once(a,raw,financial.load(directory/'signed.json'),directory,runtime)
  return sign_once(custody,a,raw,runtime.read(selection(a)),directory,execute=mode=='sign')
if __name__=='__main__':
 try:
  require(len(sys.argv)==3);mode,epoch=sys.argv[1:];custody=None
  if mode=='sign':import custody
  print(json.dumps(run(mode,epoch,custody),separators=(',',':')))
 except Exception as error:print(json.dumps(dict(status='refused',error_type=type(error).__name__,broadcasts_retried=False)),file=sys.stderr);sys.exit(1)

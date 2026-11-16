"""Fixed central research reviewer custody. No generic sign or key export API.

The caller supplies a public decision; the original pinned native reader must
authenticate its exact task, submission and recipient before vault access.
"""
import base64,contextlib,datetime,fcntl,hashlib,io,json,os,re,secrets,stat,time
from pathlib import Path
import native_migration as native

CHAIN=native.CHAIN
GENESIS=native.GENESIS
POLICY='central-earning-five-kpi-fund-v2'
ROOT=Path('/var/lib/uain-custody/central-reviewer')
KEY='keys/central-research-reviewer.json'
LOCK=Path('/run/lock/uain-custody.lock')
ADDRESS=re.compile(r'^uain1[a-f0-9]{40}$')
ID=re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$')
HASH=re.compile(r'^[a-f0-9]{64}$')
ALLOC=10000000000
LIFETIME=1000000000000000
ALLOWANCES=(10000000000,110000000000,1110000000000,11110000000000,111110000000000,1000000000000000)
DECISION={'schema','domain','submission','task','reviewer','execution_id','criteria_digest','evidence_digest','verdict','findings','started_at','completed_at'}
# v2 commits the decision digest (the native verification_digest) to a fleet
# verification statement; the native command payload shape is unchanged.
DECISION_V2=DECISION|{'verification_attestation_digest'}
DECISION_SCHEMAS={'uain-central-research-decision-v1':DECISION,'uain-central-research-decision-v2':DECISION_V2}

def require(v):
 if not v:raise ValueError('Central research custody validation refused')
def sha(raw):return hashlib.sha256(raw).hexdigest()
def b64(raw):return base64.urlsafe_b64encode(raw).decode().rstrip('=')
def exact(value,fields):return type(value)==dict and set(value)==set(fields)
def quantity(value):
 require(type(value)==str and re.fullmatch(r'0|[1-9][0-9]{0,20}',value));return int(value)
def date(value):
 require(type(value)==str)
 try:d=datetime.datetime.fromisoformat(value.replace('Z','+00:00'))
 except (TypeError,ValueError):raise ValueError('Central research timestamp refused') from None
 require(d.tzinfo is not None);return d.timestamp()
def decision_bytes(d):
 require(exact(d,DECISION) or exact(d,DECISION_V2))
 if 'verification_attestation_digest' in d:require(d['schema']=='uain-central-research-decision-v2' and type(d['verification_attestation_digest'])==str and HASH.fullmatch(d['verification_attestation_digest']))
 # JS worker canonical JSON uses sorted fixed ASCII keys, without Go's HTML
 # escaping. The native command uses native.signing_bytes separately.
 native.canonical(d)
 return json.dumps(d,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def decision_digest(d):return sha(b'UAIN/central-research-review/v1\n'+decision_bytes(d))

READER_SHA='136698192e9e38323a552f1e2da2eea5b9b90e3d6e7de11116d72ee28c826860'
GUARDIAN_PUBLIC='mDuiMoDUKg66PitMD-j1pztm81wOKlYq7nFFCWLXoRI'
def proof_policy(p):
 """Shared exact original proof authority, before constructing any runtime."""
 import native_admission as admission
 admission.validate_policy(p)
 require(p['chain_id']==CHAIN and p['genesis_sha256']==GENESIS and p['state_sha256']==READER_SHA and p['state_binary']=='/opt/uain-chain/tools/state/'+READER_SHA+'/uain-state' and p['genesis']=='/etc/uain-custody/native-admission-genesis.json' and p['rpc']=='http://127.0.0.1:26667' and p['guardian']==native.GUARDIAN and p['guardian_public_key']==GUARDIAN_PUBLIC and p['guardian_key_attachment']=='keys/uain-review-key.json')
 return p

def review_command(p,state,d,now=None):
 now=time.time() if now is None else now
 raw=decision_bytes(d);require(len(raw)<=65536 and type(d['schema'])==str and DECISION_SCHEMAS.get(d['schema'])==set(d) and d['domain']=='UAIN/central-research-review/v1')
 require(p['chain_id']==CHAIN and state['chain_id']==CHAIN and ADDRESS.fullmatch(p['reviewer']) and d['reviewer']==p['reviewer'])
 for field in ('submission','task','execution_id'):require(type(d[field])==str and ID.fullmatch(d[field]))
 for field in ('criteria_digest','evidence_digest'):require(type(d[field])==str and HASH.fullmatch(d[field]))
 require(d['verdict'] in ('accept','reject','needs_evidence') and type(d['findings'])==list and 1<=len(d['findings'])<=64 and all(type(x)==str and 0<len(x.encode())<=8192 for x in d['findings']))
 started,completed=date(d['started_at']),date(d['completed_at']);require(started<=completed<=now+60 and completed-started<=600)
 age=now-date(state['header_time']);require(-60<=age<=120)
 height=native.decimal(state['height'],2**63-101);require(height>0)
 m=state['member'];require(m['id']==p['reviewer'] and m['public_key']==p['public_key'] and m['licence']=='active');native.decimal(m['sequence'],2**64-2)
 records=state['records'];a=records['central_earning_activation'];require(a['policy']==POLICY and a['reviewer']==p['reviewer'] and 2<=native.decimal(a['height'])<=height)
 v=records['central_submission/'+d['submission']];t=records['central_task/'+d['task']];b=records['central_project_budget/'+t['project']]
 require(v['id']==d['submission'] and v['task']==d['task'] and v['state']=='under_review' and ADDRESS.fullmatch(v['author']) and v['author']!=p['reviewer'])
 require(type(v['evidence'])==str and 0<len(v['evidence'].encode())<=16384 and sha(v['evidence'].encode())==v['evidence_digest']==d['evidence_digest'])
 require(t['id']==d['task'] and t['pending']==v['id'] and t['state']=='under_review' and type(t['criteria'])==str and 0<len(t['criteria'].encode())<=4096 and sha(t['criteria'].encode())==t['acceptance_digest']==d['criteria_digest'])
 solver,reviewer=quantity(t['solver_amount']),quantity(t['reviewer_amount']);require(solver>0 and reviewer>0 and quantity(t['reserved'])==solver+reviewer)
 require(b['project']==t['project'] and b['policy']==POLICY and type(b['round'])==int and 1<=b['round']<=6 and quantity(b['allocation'])==ALLOWANCES[b['round']-1] and quantity(b['lifetime_ceiling'])==LIFETIME and native.decimal(a['height'])<=native.decimal(b['height'])<=height and type(b['evidence_digest'])==str and HASH.fullmatch(b['evidence_digest']) and quantity(b['reserved'])>=solver+reviewer and quantity(b['paid'])+quantity(b['reserved'])<=quantity(b['allocation']))
 return dict(version=1,chain_id=CHAIN,member=p['reviewer'],sequence=m['sequence'],expires_height=str(height+100),operation='central_review',payload=dict(submission=v['id'],verdict=d['verdict'],criteria_digest=d['criteria_digest'],verification_digest=decision_digest(d),execution_id=d['execution_id'],evidence_digest=d['evidence_digest']))

def matches_receipt(event,command):
 return type(event)==dict and event.get('operation')==command['operation']=='central_review' and event.get('member')==command['member'] and event.get('subject')==command['payload']['submission'] and event.get('command_digest')==sha(native.signing_bytes(command)) and not event.get('instance') and not event.get('origin')

def enrol_command(identity,state):
 require(identity['schema']=='uain-central-reviewer-identity-v1' and identity['chain_id']==state['chain_id']==CHAIN and identity['genesis_sha256']==GENESIS)
 pub=base64.urlsafe_b64decode(identity['public_key']+'=');require(len(pub)==32 and b64(pub)==identity['public_key'] and identity['member']=='uain1'+sha(pub)[:40])
 require(identity['name']=='UAIN Central Research Reviewer' and identity['operator']=='United AI Network (Rahul Jalan)' and identity['family']=='Central research reviewer')
 require(state['records'].get('member/'+identity['member'],'missing') is None and -60<=time.time()-date(state['header_time'])<=120)
 height=native.decimal(state['height'],2**63-101);require(height>0)
 return dict(version=1,chain_id=CHAIN,member=identity['member'],sequence='0',expires_height=str(height+100),operation='enrol',payload={key:identity[key] for key in ('name','operator','family')})

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
 """Generate exactly one reviewer key inside encrypted custody, with backups."""
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
    pub,_=native.ed25519(bytes(seed));files[KEY]=canonical(dict(schema='uain-central-reviewer-key-v1',public_key=b64(pub),private_key=b64(seed),created_at=int(time.time()*1000)))
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
  key=native.strict_json(files[KEY]);require(exact(key,{'schema','public_key','private_key','created_at'}) and key['schema']=='uain-central-reviewer-key-v1' and type(key['created_at'])==int)
  public,_=keypair(files[KEY]);pub=base64.urlsafe_b64decode(public+'=');require(len(pub)==32 and b64(pub)==key['public_key'])
  proof=backup_proof(custody,vault_sha)
  identity=dict(schema='uain-central-reviewer-identity-v1',chain_id=CHAIN,genesis_sha256=GENESIS,member='uain1'+sha(pub)[:40],public_key=b64(pub),name='UAIN Central Research Reviewer',operator='United AI Network (Rahul Jalan)',family='Central research reviewer',vault_sha256=vault_sha,backup_receipt_sha256=proof)
  write(ROOT/'identity.json',canonical(identity));return identity

def _sign(custody,command,member,public_key):
 require(os.geteuid()==0 and command['operation'] in ('enrol','central_review') and command['member']==member)
 key=native.strict_json(custody.attachment(custody.vault(),KEY));seed=bytearray(base64.urlsafe_b64decode(key['private_key']+'='))
 try:
  require(len(seed)==32);pub,sign=native.ed25519(bytes(seed));require(b64(pub)==key['public_key']==public_key and 'uain1'+sha(pub)[:40]==member)
  return dict(command=command,public_key=b64(pub),signature=b64(sign(native.signing_bytes(command))))
 finally:
  for i in range(len(seed)):seed[i]=0

def sign_review(custody,p,state,decision):
 """Internal only; caller holds custody lock and writes a send-once journal."""
 return _sign(custody,review_command(p,state,decision),p['reviewer'],p['public_key'])

def sign_enrol(custody,identity,state):
 """One fixed public identity; caller retains original envelope before sending."""
 return _sign(custody,enrol_command(identity,state),identity['member'],identity['public_key'])

def enrol_once(custody,identity,runtime,read_journal=None,write=None):
 """Fixed enrollment/reconciliation; caller holds the global custody lock.

 Re-entry never signs or broadcasts a retained envelope a second time.
 """
 import native_admission as admission
 read_journal=read_journal or admission.load;write=write or admission.atomic
 path=ROOT/'enrol-journal.json';journal=read_journal(path) if path.exists() else None
 if journal is None:
  state=runtime.read({'keys':['member/'+identity['member']]})
  envelope=sign_enrol(custody,identity,state)
  journal=dict(schema='uain-central-reviewer-enrol-once-v1',member=identity['member'],envelope=envelope,after_event=state['event_count'],receipt_cursor=state['event_count'],send_started=True,broadcasts=1)
  write(path,journal)
  try:journal['check_tx_code']=runtime.broadcast(envelope)
  except Exception:journal['send_outcome']='unknown'
  write(path,journal)
 require(journal['schema']=='uain-central-reviewer-enrol-once-v1' and journal['member']==identity['member'] and journal['broadcasts']==1 and journal['send_started'] is True)
 envelope=journal['envelope'];command=envelope['command'];require(command['operation']=='enrol' and command['member']==identity['member'] and command['chain_id']==CHAIN and command['sequence']=='0' and envelope['public_key']==identity['public_key'] and command['payload']=={key:identity[key] for key in ('name','operator','family')})
 if journal.get('receipt'):return dict(status='finalized',verified=True,member=identity['member'],receipt=journal['receipt'],broadcasts=1)
 head=runtime.read({'keys':[]});cursor=native.decimal(journal['receipt_cursor']);end=min(native.decimal(head['event_count']),cursor+16)
 if end>cursor:
  state=runtime.read({'keys':['event/'+str(i).zfill(20) for i in range(cursor+1,end+1)]})
  for i in range(cursor+1,end+1):
   event=state['records']['event/'+str(i).zfill(20)]
   if type(event)==dict and event.get('operation')=='enrol' and event.get('member')==identity['member'] and event.get('subject')==identity['member'] and event.get('command_digest')==sha(native.signing_bytes(command)):
    proved=runtime.read({'member':identity['member'],'keys':['member/'+identity['member']],'receipt':{'envelope':envelope,'event_id':str(i)}})
    receipt=proved['receipt'];require(receipt['authority']=='native' and receipt['finalized'] is True and receipt['event']==event)
    journal['receipt']=receipt;journal['receipt_cursor']=str(i);write(path,journal)
    return dict(status='finalized',verified=True,member=identity['member'],receipt=receipt,broadcasts=1)
  journal['receipt_cursor']=str(end);write(path,journal)
 return dict(status='pending',verified=False,member=identity['member'],broadcasts=1,receipt_cursor=journal['receipt_cursor'])

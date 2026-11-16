"""Sign only a root-approved complete legacy import batch; never financial policy.

All entry points fail closed. Private material remains inside the custody process;
only public envelopes and a digest journal are written to the server.
"""
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import stat
import subprocess
import tempfile
import time

CHAIN='uain-shadow-20261008-1'
GENESIS='54140a9243c4591ccc9f2e9d49543fc68b87b3e0045416174c232e9dd498f8ff'
GUARDIAN='uain158ac8d0debcf01d43164ef14736597da589d8b54'
PLAN_SCHEMA='uain-native-migration-signing-v1'
APPROVAL_SCHEMA='uain-native-migration-approval-v1'
ROOT=Path('/var/lib/uain-custody/native-migration')
HOME=Path('/var/lib/uain-chain/shadow-20261008-1')
HEX=re.compile(r'^[0-9a-f]{64}$')
DEC=re.compile(r'^(0|[1-9][0-9]*)$')
ADDRESS=re.compile(r'^uain1[0-9a-f]{40}$')
LIMIT=64*1024*1024
FIELDS={'version','chain_id','member','sequence','expires_height','operation','payload'}
APPROVAL_FIELDS={'schema','epoch','plan_sha256','guardian','guardian_public_key','genesis_sha256','state_binary_sha256','source_manifest_digest','records_root','native_checkpoint','expected_event_count','expected_last_command_digest','claim_members','starting_sequence','expires_at'}


def require(condition):
 if not condition:raise ValueError('Approved native migration context refused')


def sha(data):return hashlib.sha256(data).hexdigest()


def canonical(value):
 if value is None:return 'null'
 if type(value)==bool:return 'true' if value else 'false'
 if type(value)==int:require(abs(value)<=9007199254740991);return str(value)
 if type(value)==str:
  require(not any(0xd800<=ord(c)<=0xdfff for c in value))
  text=json.dumps(value,ensure_ascii=False,separators=(',',':'))
  for c in '<>&\u2028\u2029':text=text.replace(c,'\\u'+format(ord(c),'04x'))
  return text
 if type(value)==list:return '['+','.join(canonical(v) for v in value)+']'
 require(type(value)==dict and all(type(k)==str for k in value))
 return '{'+','.join(canonical(k)+':'+canonical(value[k]) for k in sorted(value,key=lambda k:k.encode()))+'}'


def strict_json(raw):
 def pairs(items):
  out={}
  for key,value in items:require(key not in out);out[key]=value
  return out
 def reject(_):raise ValueError('Unsafe JSON number refused')
 value=json.loads(raw,object_pairs_hook=pairs,parse_float=reject,parse_constant=reject)
 canonical(value);return value


def decimal(value,maximum=2**64-1):
 require(type(value)==str and DEC.fullmatch(value) is not None)
 number=int(value);require(number<=maximum);return number


def signing_bytes(c):
 require(type(c)==dict and set(c)==FIELDS and type(c['version'])==int and c['version']==1)
 # The typed command fields retain the exact existing Go/Node signing order.
 order=('version','chain_id','member','sequence','expires_height','operation','payload')
 decimal(c['sequence']);require(1<=decimal(c['expires_height'],2**63-1))
 return ('uain:chain-command:v1\n{'+','.join(canonical(k)+':'+canonical(c[k]) for k in order)+'}').encode()


def record_root(record,index,total):
 require(type(record)==dict and set(record)=={'key','value','proof'})
 require(type(record['key'])==str and 0<len(record['key'].encode())<=512 and type(record['value'])==str and len(record['value'].encode())<=16384)
 # Source values remain opaque signed history, including original decimals and
 # large numeric literals. Never normalize their bytes before authentication.
 proof=record['proof'];depth=(total-1).bit_length()
 require(type(proof)==list and len(proof)==depth and depth<=24)
 value=bytes.fromhex(sha(('uain:legacy-record:v1\n'+str(index)+'\n'+record['key']+'\n'+sha(record['value'].encode())).encode()))
 for sibling in proof:
  require(type(sibling)==str and HEX.fullmatch(sibling));other=bytes.fromhex(sibling)
  value=hashlib.sha256(other+value if index%2 else value+other).digest();index//=2
 return value.hex()


def _validate(raw,a,state,now=None):
 now=time.time() if now is None else now
 require(type(a)==dict and set(a)==APPROVAL_FIELDS and a['schema']==APPROVAL_SCHEMA and a['genesis_sha256']==GENESIS)
 for k in ('plan_sha256','state_binary_sha256','source_manifest_digest','records_root'):require(type(a[k])==str and HEX.fullmatch(a[k]))
 require(type(a['expires_at'])==int and now<a['expires_at']<=now+86400)
 require(len(raw)<=LIMIT and sha(raw)==a['plan_sha256'])
 p=strict_json(raw)
 require(set(p)=={'schema','epoch','commands'} and p['schema']==PLAN_SCHEMA and p['epoch']==a['epoch'] and re.fullmatch(r'[a-f0-9]{32}',p['epoch']))
 commands=p['commands'];require(type(commands)==list and 1<=len(commands)<=1024)
 member=a['guardian'];require(type(member)==str and ADDRESS.fullmatch(member))
 require(state['chain_id']==CHAIN and state['member']['id']==member and state['member']['public_key']==a['guardian_public_key'] and state['member']['licence']=='active')
 require(state['member']['sequence']==a['starting_sequence'] and member in state['records']['guardians'])
 require('guardian_epoch_current' in state['records'] and state['records']['guardian_epoch_current'] is None)
 require('legacy_adoption' in state['records'] and 'legacy_import' in state['records'])
 require(state['event_count']==a['expected_event_count'])
 if decimal(state['event_count'])>0:
  key='event/'+str(decimal(state['event_count'])).zfill(20)
  require(state['records'][key]['command_digest']==a['expected_last_command_digest'])
 else:require(a['expected_last_command_digest']=='')
 start=decimal(a['starting_sequence']);height=decimal(state['height'],2**63-1)
 require(start+len(commands)<=2**64-1)
 expiry=decimal(commands[0]['expires_height'],2**63-1);require(height+len(commands)+10<expiry<=height+720)
 for i,c in enumerate(commands):
  signing_bytes(c)
  require(c['chain_id']==CHAIN and c['member']==member and decimal(c['sequence'])==start+i and decimal(c['expires_height'],2**63-1)==expiry and len(json.dumps(c,ensure_ascii=False).encode())<65000)
 index=0;adopted=state['records']['legacy_adoption']
 base_fields={'manifest_digest','records_root','total_records','accounts','ledger_head','last_event_id'}
 if adopted is None:
  require(commands[0]['operation']=='legacy_adopt' and state['records']['legacy_import'] is None)
  adopted=commands[0]['payload'];index=1
  require(type(adopted)==dict and set(adopted)==base_fields|{'pinned_public_key','native_checkpoint'})
  require(a['expected_event_count']==a['native_checkpoint']['event_count'] and a['expected_last_command_digest']==a['native_checkpoint']['last_command_digest'])
 require(type(adopted)==dict and adopted['manifest_digest']==a['source_manifest_digest'] and adopted['records_root']==a['records_root'] and adopted['native_checkpoint']==a['native_checkpoint'])
 require(type(adopted['ledger_head'])==str and HEX.fullmatch(adopted['ledger_head']) and type(adopted['pinned_public_key'])==str and 20<=len(adopted['pinned_public_key'])<=1024)
 decimal(adopted['last_event_id'],2**63-1);total=decimal(adopted['total_records']);accounts=decimal(adopted['accounts']);require(1<=total<=10000000 and 1<=accounts<=20)
 source_members=a['claim_members'];require(type(source_members)==list and len(source_members)==accounts and len(set(source_members))==accounts and all(type(x)==str and ADDRESS.fullmatch(x) for x in source_members))
 imported=state['records']['legacy_import'];cursor=0;claimed_count=0;phase='importing'
 if imported is None:
  require(index<len(commands) and commands[index]['operation']=='legacy_begin' and commands[index]['payload']=={k:adopted[k] for k in base_fields});index+=1
 else:
  require(imported['manifest_digest']==a['source_manifest_digest'] and imported['records_root']==a['records_root'] and imported['total_records']==adopted['total_records'] and imported['accounts']==adopted['accounts'])
  cursor=decimal(imported['imported']);claimed_count=decimal(imported['claimed_accounts']);phase=imported['status']
  require(cursor<=total and claimed_count<=accounts and phase in ('importing','reconciling_accounts'))
 previous=''
 if phase=='importing':
  require(claimed_count==0)
  while index<len(commands) and commands[index]['operation']=='legacy_page':
   payload=commands[index]['payload'];require(type(payload)==dict and set(payload)=={'start','records'} and decimal(payload['start'])==cursor)
   rows=payload['records'];require(type(rows)==list and 1<=len(rows)<=16 and sum(len(row['value'].encode()) for row in rows)<=24*1024 and len(json.dumps(payload,ensure_ascii=False).encode())<=48*1024)
   for row in rows:
    require(cursor<total and row['key']>previous and record_root(row,cursor,total)==a['records_root']);previous=row['key'];cursor+=1
   index+=1
  require(cursor==total and index<len(commands) and commands[index]['operation']=='legacy_finish' and commands[index]['payload']=={});index+=1
 else:require(cursor==total)
 remaining=set()
 for account in source_members:
  key='legacy_account_claimed/'+account;require(key in state['records'])
  if state['records'][key] is None:remaining.add(account)
 require(len(remaining)==accounts-claimed_count)
 claimed=set()
 for c in commands[index:]:
  require(c['operation']=='legacy_claim_account' and type(c['payload'])==dict and set(c['payload'])=={'member'})
  account=c['payload']['member'];require(account in remaining and account not in claimed);claimed.add(account)
 require(claimed==remaining)
 return commands


def validate(raw,a,state,now=None):
 try:return _validate(raw,a,state,now)
 except (KeyError,TypeError,IndexError,OverflowError):raise ValueError('Malformed migration authorization refused') from None


def protected_read(path,limit=LIMIT):
 path=Path(path);require(path.resolve()==path)
 for parent in path.parents:
  info=parent.stat();require(info.st_uid==0 and not info.st_mode&0o022)
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 with os.fdopen(fd,'rb') as stream:
  info=os.fstat(stream.fileno());require(stat.S_ISREG(info.st_mode) and info.st_uid==0 and not info.st_mode&0o077 and info.st_nlink==1 and info.st_size<=limit)
  data=stream.read(limit+1);require(len(data)<=limit);return data


def adopt_pending(pending,expected):
 """T4: True when a stale .pending left by a crash holds exactly `expected` (it may then
 replace its target, as treasury.atomic does); False when there is none. Different bytes,
 a link or any other kind of file are refused, so it still never silently changes."""
 try:fd=os.open(pending,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 except FileNotFoundError:return False
 except OSError:require(False)
 try:
  info=os.fstat(fd);require(stat.S_ISREG(info.st_mode) and info.st_uid==os.geteuid() and info.st_nlink==1 and not info.st_mode&0o022 and info.st_size==len(expected))
  with os.fdopen(fd,'rb',closefd=False) as stream:require(stream.read(len(expected)+1)==expected)
  return True
 finally:os.close(fd)


def atomic(path,value):
 path=Path(path);temporary=path.with_name(path.name+'.pending')
 raw=(json.dumps(value,ensure_ascii=False,separators=(',',':'))+'\n').encode()
 if not adopt_pending(temporary,raw):
  with temporary.open('xb') as output:
   os.chmod(temporary,0o600);output.write(raw);output.flush();os.fsync(output.fileno())
 os.replace(temporary,path)
 fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)


def ed25519(seed):
 # Production custody already uses pycryptodomex through pykeepass. The
 # isolated CI runtime provides the independent system cryptography backend.
 # Both produce the same standard pure-Ed25519 bytes, checked with Node/OpenSSL.
 try:
  from Cryptodome.Signature import eddsa
 except ImportError:
  from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
  from cryptography.hazmat.primitives.serialization import Encoding,PublicFormat
  key=Ed25519PrivateKey.from_private_bytes(seed)
  return key.public_key().public_bytes(Encoding.Raw,PublicFormat.Raw),key.sign
 key=eddsa.import_private_key(seed)
 return key.public_key().export_key(format='raw'),eddsa.new(key,'rfc8032').sign


def live_state(a):
 binary=Path('/opt/uain-chain/tools/state')/a['state_binary_sha256']/'uain-state'
 require(binary.resolve()==binary and binary.stat().st_uid==0 and not binary.stat().st_mode&0o022 and binary.stat().st_size<256*1024*1024)
 require(sha(binary.read_bytes())==a['state_binary_sha256'])
 genesis=HOME/'config/genesis.json';require(sha(genesis.read_bytes())==GENESIS)
 keys=['guardians','guardian_epoch_current','legacy_adoption','legacy_import']
 keys.extend('legacy_account_claimed/'+member for member in a['claim_members'])
 count=decimal(a['expected_event_count'])
 if count:keys.append('event/'+str(count).zfill(20))
 with tempfile.TemporaryDirectory(prefix='uain-native-custody-',dir='/run') as tmp:
  out=Path(tmp)/'state.json'
  result=subprocess.run([str(binary),'--genesis',str(genesis),'--genesis-sha256',GENESIS,'--rpc','http://127.0.0.1:26667','--out',str(out),'--max-age','120s'],input=json.dumps({'member':a['guardian'],'keys':keys}).encode(),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=65)
  require(result.returncode==0);return strict_json(protected_read(out,8*1024*1024))


def sign_approved(custody,epoch):
 require(os.geteuid()==0 and re.fullmatch(r'[a-f0-9]{32}',epoch) is not None)
 resource.setrlimit(resource.RLIMIT_CORE,(0,0));os.umask(0o077)
 directory=ROOT/epoch;a=strict_json(protected_read(directory/'approval.json',16384));raw=protected_read(directory/'plan.json')
 require(type(a)==dict and set(a)==APPROVAL_FIELDS and a['schema']==APPROVAL_SCHEMA and a['guardian']==GUARDIAN and a['epoch']==epoch and a['genesis_sha256']==GENESIS)
 require(type(a['state_binary_sha256'])==str and HEX.fullmatch(a['state_binary_sha256']))
 journal=directory/'journal.json';output=directory/'signed.json'
 require(not journal.exists() and not output.exists())
 commands=validate(raw,a,live_state(a))
 atomic(journal,{'status':'started','plan_sha256':a['plan_sha256'],'epoch':epoch,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()})
 # Decrypt only this attachment inside custody. Never stage any plaintext key.
 key=strict_json(custody.attachment(custody.vault(),'keys/uain-review-key.json'))
 def decode(text):
  require(type(text)==str and re.fullmatch(r'[A-Za-z0-9_-]{43}',text) is not None)
  raw=base64.urlsafe_b64decode(text+'=');require(len(raw)==32);return raw
 seed=decode(key['private_key']);public,sign=ed25519(seed)
 encoded=base64.urlsafe_b64encode(public).decode().rstrip('=')
 require(encoded==key['public_key']==a['guardian_public_key'] and 'uain1'+sha(public)[:40]==GUARDIAN)
 envelopes=[{'command':c,'public_key':encoded,'signature':base64.urlsafe_b64encode(sign(signing_bytes(c))).decode().rstrip('=')} for c in commands]
 atomic(output,{'schema':'uain-native-migration-envelopes-v1','epoch':epoch,'plan_sha256':a['plan_sha256'],'envelopes':envelopes})
 receipt={'status':'signed','epoch':epoch,'plan_sha256':a['plan_sha256'],'public_envelopes_sha256':sha(protected_read(output)),'commands':len(commands),'guardian':GUARDIAN,'private_keys_exported':False}
 atomic(journal,receipt);print(json.dumps(receipt))

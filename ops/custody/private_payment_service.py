"""Root-only fixed reviewer/relay service. No broadcasts, arbitrary keys or ops.

Private envelopes, reports, X25519 keys and model audit are AES-GCM sealed using
a domain-separated key derived inside custody. Signing phases retain immutable
once journals. This module never prints a vault attachment or plaintext key.
"""
import base64,datetime,fcntl,hashlib,json,os,re,resource,stat,subprocess,sys,time,unicodedata
from pathlib import Path
try:
 from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except ImportError:
 # Production pykeepass already provides pycryptodomex. Keep identical AES-GCM
 # framing when the optional independent cryptography backend is unavailable.
 from Cryptodome.Cipher import AES
 class AESGCM:
  def __init__(self,key):self.key=key
  def encrypt(self,nonce,plain,aad):
   cipher=AES.new(self.key,AES.MODE_GCM,nonce=nonce);cipher.update(aad);body,tag=cipher.encrypt_and_digest(plain);return body+tag
  def decrypt(self,nonce,wire,aad):
   cipher=AES.new(self.key,AES.MODE_GCM,nonce=nonce);cipher.update(aad);return cipher.decrypt_and_verify(wire[:-16],wire[-16:])
import native_migration as native
import native_admission as admission

ROOT=Path('/var/lib/uain-custody/private-payment-service')
POLICY=Path('/etc/uain-custody/private-payment-service.json')
TEMP=Path('/run/uain-private-payment-service')
NODE='/opt/uain-review-runtime/node-v22.22.0-linux-x64/bin/node'
CHAIN=native.CHAIN;GENESIS=native.GENESIS
REVIEWER='uain17fae025e2b7492156d438712aab8efcb4113b0fd'
REVIEWER_PUBLIC='wpwtSOfm7XkVbHxuo5hXx6VOusc_DVFutMfYi8EiiWw'
RELAY='uain1215c651b70db82b70532a496c26fdf424f3bb369'
ATTACHMENTS={REVIEWER:'local/work/prod/claude-lead/key.json',RELAY:'keys/neuroetch-key.json'}
SOURCE_FILES={'apps/baink/review-broker/reviewer-worker.mjs','apps/baink/server/server-send-check.mjs','apps/baink/server/native-payments.mjs','apps/baink/server/native-pilot-sequence.mjs','apps/baink/server/native-financial-command.mjs','chain/client/signing.mjs','chain/client/private-state.mjs','chain/client/private-review.mjs','chain/client/private-workflow.mjs','chain/client/coin-boundary.mjs'}
PINS={'private-state':'45ffaaf1e85cb3d30e01f8ef8c38b75fa6ecb0169f9ecda9a3b22b7ae6286ddb','coin-wallet':'cb847c04647292220f90cdd2be31765cdf0e42733682c4f1244f28348dda9859','private-wallet':'b0a3b9ebc22ae09d99a770c4f070b114d4c4fa6730c7b99e4ba3dccce8fc3584'}
HEX=re.compile(r'^[a-f0-9]{64}$');JOB=re.compile(r'^[a-f0-9]{32}$');LIMIT=2*1024*1024
canonical=native.canonical
def require(value):
 if not value:raise ValueError('Private payment service refused')
def sha(data):return hashlib.sha256(data).hexdigest()
def exact(value,fields):return type(value)==dict and set(value)==set(fields)
def decode(value,length):
 require(type(value)==str);raw=base64.urlsafe_b64decode(value+'===');require(len(raw)==length and base64.urlsafe_b64encode(raw).decode().rstrip('=')==value);return raw
def bytes_json(value):return canonical(value).encode()
# The longest approval BAINK accepts: expires_height <= proved height + 720 (native-payments.mjs).
EXPIRY_BLOCKS=720
def validate_context(value,height=None):
 require(exact(value,['version','chain','expires','licenceRevision','effects','purpose','reviewer']) and type(value['version'])==int and value['version']==1 and value['chain']==CHAIN and value['reviewer']==decode(REVIEWER_PUBLIC,32).hex())
 require(1<=native.decimal(value['expires'],2**63-1) and native.decimal(value['licenceRevision'])<=2**64-1 and type(value['effects'])==str and HEX.fullmatch(value['effects']) and type(value['purpose'])==str and HEX.fullmatch(value['purpose']))
 # Once a proved native height is known (the inspection report), the expiry has an upper bound,
 # so no claim or approval can be held for longer than BAINK itself would ever ask.
 if height is not None:require(native.decimal(value['expires'],2**63-1)<=native.decimal(height,2**63-1)+EXPIRY_BLOCKS)
 return value
def report_height(report):
 require(type(report)==dict and type(report.get('proof'))==dict);return report['proof'].get('height')
def seal(key,job,name,value):
 nonce=os.urandom(12);aad=('BAINK/private-service/v1\n'+job+'\n'+name).encode();wire=AESGCM(key).encrypt(nonce,bytes_json(value),aad)
 return dict(schema='baink-private-service-sealed-v1',nonce=nonce.hex(),ciphertext=base64.b64encode(wire).decode())
def unseal(key,job,name,value):
 require(exact(value,['schema','nonce','ciphertext']) and value['schema']=='baink-private-service-sealed-v1' and type(value['nonce'])==str and re.fullmatch(r'[a-f0-9]{24}',value['nonce']))
 wire=base64.b64decode(value['ciphertext'],validate=True);require(len(wire)<=LIMIT+16)
 return native.strict_json(AESGCM(key).decrypt(bytes.fromhex(value['nonce']),wire,('BAINK/private-service/v1\n'+job+'\n'+name).encode()))
def write_once(path,value):
 raw=bytes_json(value)+b'\n';require(len(raw)<=4*1024*1024)
 try:fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 except FileExistsError:require(native.strict_json(native.protected_read(path,4*1024*1024))==value);return
 with os.fdopen(fd,'wb') as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
 fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)
def load(path):return native.strict_json(native.protected_read(path,4*1024*1024))
def sealed_write(directory,key,job,name,value):
 path=directory/(name+'.sealed.json')
 if path.exists():require(unseal(key,job,name,load(path))==value);return
 write_once(path,seal(key,job,name,value))
def sealed_read(directory,key,job,name):return unseal(key,job,name,load(directory/(name+'.sealed.json')))
def artifact(path,pin):
 path=Path(path);require(path.is_absolute() and path.resolve()==path and HEX.fullmatch(pin))
 for parent in path.parents:
  s=parent.stat();require(s.st_uid==0 and not s.st_mode&0o022)
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 with os.fdopen(fd,'rb') as f:
  s=os.fstat(f.fileno());require(stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_nlink==1 and not s.st_mode&0o022 and s.st_size<=256*1024*1024);require(sha(f.read(256*1024*1024+1))==pin)
def validate_policy(p,check_files=True):
 require(exact(p,['schema','source','source_sha256','node','node_sha256','reader','tools','decisionPublicKey']) and p['schema']=='baink-private-payment-service-policy-v1' and p['node']==NODE and type(p['node_sha256'])==str and HEX.fullmatch(p['node_sha256']))
 decode(p['decisionPublicKey'],32);require(type(p['source_sha256'])==dict and set(p['source_sha256'])==SOURCE_FILES and all(type(v)==str and HEX.fullmatch(v) for v in p['source_sha256'].values()))
 source=Path(p['source']);require(str(source.parent)=='/opt/uain-private-payment-service/releases' and source.name==sha(bytes_json(p['source_sha256'])))
 r=p['reader'];require(exact(r,['executable','executableSha256','genesis','genesisSha256','rpc','maxAgeSeconds']) and r['executableSha256']==PINS['private-state'] and r['genesisSha256']==GENESIS and r['rpc']=='http://127.0.0.1:26667' and r['maxAgeSeconds']==120)
 require(exact(p['tools'],['coinWallet','privateWallet']))
 for name,pin in [('coinWallet',PINS['coin-wallet']),('privateWallet',PINS['private-wallet'])]:require(exact(p['tools'][name],['executable','executableSha256']) and p['tools'][name]['executableSha256']==pin)
 if check_files:
  artifact(p['node'],p['node_sha256']);artifact(r['executable'],r['executableSha256']);artifact(r['genesis'],GENESIS)
  for tool in p['tools'].values():artifact(tool['executable'],tool['executableSha256'])
  for name,pin in p['source_sha256'].items():artifact(source/name,pin)
 return dict(pins=dict(chainId=CHAIN,genesisSha256=GENESIS),reader=r,tools=p['tools'],reviewer=REVIEWER,reviewerPublicKey=REVIEWER_PUBLIC,relay=RELAY,healthOwner=native.GUARDIAN,decisionPublicKey=p['decisionPublicKey'])
def seed(custody,member):
 value=native.strict_json(custody.attachment(custody.vault(),ATTACHMENTS[member]));require(type(value)==dict)
 b=decode(value['private_key'],32);public,_=native.ed25519(b);require('uain1'+sha(public)[:40]==member and base64.urlsafe_b64encode(public).decode().rstrip('=')==value['public_key'])
 if member==REVIEWER:require(value['public_key']==REVIEWER_PUBLIC)
 return value['private_key']
def worker(custody,p,action,job,**values):
 profile=validate_policy(p);data=dict(action=action,jobId=job,profile=profile,**values)
 if action not in ('attest','reconcile','send-inspect'):data['reviewerSeed']=seed(custody,REVIEWER)
 if action in ('relay','health'):data['relaySeed']=seed(custody,RELAY)
 result=subprocess.run([p['node'],str(Path(p['source'])/'apps/baink/review-broker/reviewer-worker.mjs')],input=bytes_json(data),stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,cwd=p['source'],env=dict(PATH=str(Path(NODE).parent)+':/usr/bin:/bin',HOME='/nonexistent',TMPDIR=str(TEMP)),timeout=60,check=True)
 require(len(result.stdout)<=LIMIT);return native.strict_json(result.stdout)
def payment_presence(effects,expires_height,runtime=None,now=None,prefix='private_payment/'):
 """Read exact native membership/nonmembership before invoice-claim reuse."""
 require(prefix in ('private_payment/','private_boundary/') and type(effects)==str and HEX.fullmatch(effects));expiry=native.decimal(expires_height,2**63-1);require(expiry>0)
 if runtime is None:
  policy=admission.load(admission.POLICY);admission.validate_policy(policy);require(policy['chain_id']==CHAIN and policy['genesis_sha256']==GENESIS and policy['state_sha256']=='136698192e9e38323a552f1e2da2eea5b9b90e3d6e7de11116d72ee28c826860' and policy['rpc']=='http://127.0.0.1:26667');runtime=admission.Runtime(policy)
 key=prefix+effects;old_temp=admission.TEMP;admission.TEMP=TEMP
 try:state=runtime.read(dict(keys=[key]))
 finally:admission.TEMP=old_temp
 require(state['chain_id']==CHAIN and type(state['app_hash'])==str and HEX.fullmatch(state['app_hash']) and key in state['records'])
 value=state['header_time'];require(type(value)==str and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})',value));value=re.sub(r'\.([0-9]{1,9})(?=Z|[+-])',lambda m:'.'+(m.group(1)+'000000')[:6],value);age=(time.time() if now is None else now)-datetime.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp();require(-60<=age<=120)
 height=native.decimal(state['height'],2**63-1);require(height>0);record=state['records'][key]
 if record is not None:require(type(record)==dict and 1<=native.decimal(record['height'],2**63-1)<=height and (prefix!='private_payment/' or type(record.get('bundle'))==str))
 return dict(recorded=record is not None,expiredAbsent=record is None and height>expiry,proof=dict(chainId=CHAIN,genesisSha256=GENESIS,height=state['height'],appHash=state['app_hash'],headerTime=state['header_time'],recordPresent=record is not None))
def invoice_claim(directory,key,job,report,presence=payment_presence):
 """Globally serialize one immutable invoice across contexts and root jobs.

The caller holds service.lock. A recorded claim is permanent. An unrecorded
claim can move to a new context only after original native expiry AND a fresh
authenticated nonmembership proof; per-job history is never overwritten.
"""
 inspection=report['inspection'];invoice=inspection.get('invoice')
 if invoice is None:return
 require(type(invoice)==dict and invoice['chainId']==CHAIN and invoice['genesisSha256']==GENESIS and type(invoice['id'])==str and type(invoice['payer'])==str)
 context=inspection['context'];require(context['chain']==CHAIN and HEX.fullmatch(context['effects']) and HEX.fullmatch(context['purpose']));native.decimal(context['expires'],2**63-1)
 invoice_key=sha(bytes_json(dict(chainId=CHAIN,genesisSha256=GENESIS,id=invoice['id'],payer=invoice['payer'])))
 claim=dict(schema='baink-private-invoice-claim-v1',invoiceKey=invoice_key,invoiceDigest=sha(bytes_json(invoice)),jobId=job,effects=context['effects'],purposeCommitment=context['purpose'],expiresHeight=context['expires'],recorded=False)
 history_path=directory/'invoice-claim.sealed.json';history=sealed_read(directory,key,job,'invoice-claim') if history_path.exists() else None
 if history is not None:require(type(history)==dict and all(history.get(k)==v for k,v in claim.items()))
 root=ROOT/'invoices';root.mkdir(mode=0o700,exist_ok=True);info=root.lstat();require(root.resolve()==root and stat.S_ISDIR(info.st_mode) and info.st_uid==os.geteuid() and not info.st_mode&0o077)
 path=root/(invoice_key+'.sealed.json');old=None
 if path.exists():old=unseal(key,'invoice-index',invoice_key,load(path))
 if old is not None:
  require(type(old)==dict and old.get('schema')==claim['schema'] and old.get('invoiceKey')==invoice_key and old.get('invoiceDigest')==claim['invoiceDigest'] and type(old.get('recorded'))==bool)
  if old['jobId']==job:
   require(all(old.get(k)==v for k,v in claim.items() if k!='recorded'))
   if history is None:sealed_write(directory,key,job,'invoice-claim',claim)
   return
  require(old['recorded'] is False)
  proved=presence(old['effects'],old['expiresHeight']);require(type(proved)==dict and type(proved.get('recorded'))==bool and type(proved.get('expiredAbsent'))==bool and type(proved.get('proof'))==dict)
  if proved['recorded']:
   old.update(recorded=True,recordedProof=proved['proof']);admission.atomic(path,seal(key,'invoice-index',invoice_key,old));require(False)
  require(proved['expiredAbsent'] is True and proved['proof'].get('recordPresent') is False and proved['proof'].get('chainId')==CHAIN and proved['proof'].get('genesisSha256')==GENESIS and native.decimal(proved['proof']['height'],2**63-1)>native.decimal(old['expiresHeight'],2**63-1))
  # The same effects cannot become a second root job; retries retain their
  # original job and journal. Only a new context/effects may replace expiry.
  require(claim['effects']!=old['effects'])
  if history is not None:require(history.get('previousJob')==old['jobId']);claim=history
  else:claim['previousJob']=old['jobId'];claim['expiredPreviousProof']=proved['proof']
 elif history is not None:claim=history
 sealed_write(directory,key,job,'invoice-claim',claim)
 admission.atomic(path,seal(key,'invoice-index',invoice_key,claim))
def boundary_presence(effects,expires_height):return payment_presence(effects,expires_height,prefix='private_boundary/')
SEND_INPUT={'packet','intent','signature','publicKey','registration'}
# P1 (Rahul, 9 Nov 2026, DEC-TRADE-011): automatic rule checks approve ordinary
# sends; the AI checker reviews only sends above 10,000 AI$ or any a rule flags.
# No human approves. Rules custody applies itself, never trusting BAINK:
# signatures, balance, outputs (send-inspect), the refuse and flag lists and
# per-payer daily limits from root-only send-rules.json (optional; defaults below).
SEND_AI_ABOVE_UNITS=10_000*1_000_000
SEND_RULES=Path('/etc/uain-custody/send-rules.json')
SEND_RULES_DEFAULT=dict(schema='uain-send-rules-v1',refuse=[],flag=[],flagTerms=[],perPayerDailyUnits=str(SEND_AI_ABOVE_UNITS),perPayerDailyCount=48)
# L8 (security review, 10 Nov 2026): optional per-payee totals; a v1 file without them still loads.
SEND_RULES_PAYEE_DEFAULT=dict(perPayeeDailyUnits=str(SEND_AI_ABOVE_UNITS),perPayeeDailyCount=96)
def send_rules(path=SEND_RULES):
 # Fail closed (L8): with no rules file, custody approves nothing by rules; every
 # send goes to the AI checker with the reason. It never fails open to defaults.
 if not path.exists():return dict(SEND_RULES_DEFAULT,**SEND_RULES_PAYEE_DEFAULT,missing=True)
 s=path.lstat();require(stat.S_ISREG(s.st_mode) and s.st_uid==0 and not s.st_mode&0o022)
 r=load(path);require(type(r)==dict and (exact(r,list(SEND_RULES_DEFAULT)) or exact(r,list(SEND_RULES_DEFAULT)+list(SEND_RULES_PAYEE_DEFAULT))) and r['schema']=='uain-send-rules-v1')
 r={**SEND_RULES_PAYEE_DEFAULT,**r}
 require(all(type(a)==str and (re.fullmatch(r'uain1[a-f0-9]{40}',a) or ORCHARD_ADDRESS.fullmatch(a)) for a in r['refuse']+r['flag']) and all(type(t)==str and 1<=len(t)<=64 and memo_skeleton(t) for t in r['flagTerms']))
 for units,count in (('perPayerDailyUnits','perPayerDailyCount'),('perPayeeDailyUnits','perPayeeDailyCount')):
  require(type(r[units])==str and re.fullmatch(r'[1-9][0-9]{0,18}',r[units]) and type(r[count])==int and 1<=r[count]<=10000)
 return r
# A refuse or flag entry is a member id (uain1…) or an Orchard receiving address. Several
# member ids can register one receiving address, so the address is where coins land.
ORCHARD_ADDRESS=re.compile(r'[a-f0-9]{86}')
# Latin look-alikes from Cyrillic and Greek, so "lаunder" (Cyrillic а) matches "launder".
CONFUSABLE=str.maketrans({'а':'a','в':'b','е':'e','ё':'e','к':'k','м':'m','н':'h','о':'o','р':'p','с':'c','т':'t','у':'y','х':'x','ѕ':'s','і':'i','ї':'i','ј':'j','ԁ':'d','ԛ':'q','ԝ':'w','ӏ':'l','ɡ':'g',
 'α':'a','β':'b','ε':'e','η':'n','ι':'i','κ':'k','ν':'v','ο':'o','ρ':'p','τ':'t','υ':'u','χ':'x','ϲ':'c','ı':'i'})
def memo_skeleton(text,ascii_only=False):
 """Case-folded letters and digits only, after compatibility folding, removing
format characters (zero-width), combining marks and separators, and mapping
look-alike letters. 'L A U N D E R', 'l\u200baunder' and 'lаunder' all give 'launder'."""
 t=unicodedata.normalize('NFKD',str(text)).casefold().translate(CONFUSABLE)
 t=unicodedata.normalize('NFKD',t)
 # Letters and digits of every script (L8 residual, 13 Nov 2026): a flag term written
 # wholly in another script is configurable and matches. Combining marks are not alnum.
 # ascii_only keeps the earlier skeleton, which drops every other character.
 return ''.join(c for c in t if c.isalnum() and (c.isascii() or not ascii_only))
def memo_flagged(term,memo):
 """A term matches on the ASCII skeleton (the earlier rule, so letters of another script
inserted into a Latin term hide nothing) or on the skeleton of every script."""
 return any((k:=memo_skeleton(term,a)) and k in memo_skeleton(memo,a) for a in (True,False))
def send_rules_today(payer,now,ledger=None,payee=None,address=None):
 count=units=payee_count=payee_units=0;ledger=ledger or ROOT/'send-rules-ledger'
 if ledger.exists():
  for f in ledger.iterdir():
   if not f.name.endswith('.json'):continue
   row=load(f)
   if now-row['at']>86400:continue
   if row['payer']==payer:count+=1;units+=int(row['amountUnits'])
   # Rows written before 12 Nov 2026 have no payee and count for the payer only.
   if payee is not None and (row.get('payee')==payee or address is not None and row.get('recipientAddress')==address):payee_count+=1;payee_units+=int(row['amountUnits'])
 return (count,units) if payee is None else (count,units,payee_count,payee_units)
def send_route(send,rules,now,ledger=None):
 """('refuse'|'ai'|'rules', reasons). Custody's own decision, from signed fields."""
 intent=send['intent'];payer,payee,amount=intent['from'],intent['to'],int(intent['amountUnits'])
 address=intent.get('recipientAddress');address=address if type(address)==str and ORCHARD_ADDRESS.fullmatch(address) else None
 if payer in rules['refuse'] or payee in rules['refuse']:return 'refuse',['member on the refuse list']
 if address is not None and address in rules['refuse']:return 'refuse',['receiving address on the refuse list']
 reasons=[]
 if address is None:reasons.append('receiving address missing or invalid')
 if rules.get('missing'):reasons.append('send rules file missing')
 if amount>SEND_AI_ABOVE_UNITS:reasons.append('amount above 10,000 AI$')
 if payer in rules['flag'] or payee in rules['flag']:reasons.append('member on the flag list')
 if address is not None and address in rules['flag']:reasons.append('receiving address on the flag list')
 memo=intent.get('memo','')
 if any(memo_flagged(t,memo) for t in rules['flagTerms']):reasons.append('memo matches a flag term')
 count,units,payee_count,payee_units=send_rules_today(payer,now,ledger,payee=payee,address=address)
 if count>=rules['perPayerDailyCount'] or units+amount>int(rules['perPayerDailyUnits']):reasons.append('payer daily rule limit reached')
 payee_limits=rules.get('perPayeeDailyCount',SEND_RULES_PAYEE_DEFAULT['perPayeeDailyCount']),int(rules.get('perPayeeDailyUnits',SEND_RULES_PAYEE_DEFAULT['perPayeeDailyUnits']))
 if payee_count>=payee_limits[0] or payee_units+amount>payee_limits[1]:reasons.append('payee daily rule limit reached')
 return ('ai' if reasons else 'rules'),reasons
def send_intent_id(intent):return sha(b'BAINK/send-intent/v1\0'+bytes_json(intent))
def send_claim(directory,key,job,context,send,presence=boundary_presence):
 """One live boundary approval per signed send intent, across root jobs.

The caller holds service.lock. A new attempt (new effects) for the same intent
is allowed only after the previous attempt's coin_shield is proved unrecorded
past its expiry; a recorded attempt keeps the intent paid forever, so a
compromised BAINK server cannot obtain a second approval for one intent.
Returns None once this job holds the claim. While an earlier unrecorded attempt
is proved still live (not past its expiry), returns {status:'claim-held',
retryAfterHeight} so BAINK queues the send (S7); nothing is written then.
"""
 intent_id=send_intent_id(send['intent']);require(HEX.fullmatch(intent_id))
 claim=dict(schema='baink-server-send-claim-v1',intentId=intent_id,jobId=job,effects=context['effects'],expiresHeight=context['expires'],recorded=False)
 root=ROOT/'sends';root.mkdir(mode=0o700,exist_ok=True);info=root.lstat();require(root.resolve()==root and stat.S_ISDIR(info.st_mode) and info.st_uid==os.geteuid() and not info.st_mode&0o077)
 path=root/(intent_id+'.sealed.json')
 if path.exists():
  old=unseal(key,'send-index',intent_id,load(path));require(type(old)==dict and old.get('schema')==claim['schema'] and old.get('intentId')==intent_id and old.get('recorded') is False)
  if old['jobId']==job:require(old['effects']==claim['effects'] and old['expiresHeight']==claim['expiresHeight']);return
  require(old['effects']!=claim['effects'])
  proved=presence(old['effects'],old['expiresHeight']);require(type(proved)==dict and type(proved.get('recorded'))==bool and type(proved.get('expiredAbsent'))==bool and type(proved.get('proof'))==dict)
  if proved['recorded']:
   old.update(recorded=True,recordedProof=proved['proof']);admission.atomic(path,seal(key,'send-index',intent_id,old));require(False)
  require(proved['proof'].get('recordPresent') is False)
  if proved['expiredAbsent'] is False and native.decimal(proved['proof']['height'],2**63-1)<=native.decimal(old['expiresHeight'],2**63-1):
   # Proved unrecorded but not yet past its expiry: a hold, not a refusal.
   return dict(status='claim-held',retryAfterHeight=old['expiresHeight'])
  require(proved['expiredAbsent'] is True and native.decimal(proved['proof']['height'],2**63-1)>native.decimal(old['expiresHeight'],2**63-1))
  claim['previousJob']=old['jobId'];claim['expiredPreviousProof']=proved['proof']
 admission.atomic(path,seal(key,'send-index',intent_id,claim))
def public_reconcile(envelope,runtime=None,now=None):
 """Pinned native public nonmembership proof, never RPC-error inference."""
 command=envelope['command'];require(command['chain_id']==CHAIN and command['member']==RELAY and command['operation']=='private_payment' and 'uain1'+sha(decode(envelope['public_key'],32))[:40]==RELAY)
 admission.verify_envelope(dict(guardian_public_key=envelope['public_key']),envelope,command)
 effects=command['payload']['approval']['effects'];require(type(effects)==str and HEX.fullmatch(effects));record_key='private_payment/'+effects
 if runtime is None:
  policy=admission.load(admission.POLICY);admission.validate_policy(policy);require(policy['chain_id']==CHAIN and policy['genesis_sha256']==GENESIS and policy['state_sha256']=='136698192e9e38323a552f1e2da2eea5b9b90e3d6e7de11116d72ee28c826860' and policy['rpc']=='http://127.0.0.1:26667');runtime=admission.Runtime(policy)
 old_temp=admission.TEMP;admission.TEMP=TEMP
 try:state=runtime.read(dict(member=RELAY,keys=[record_key,'member/'+RELAY]))
 finally:admission.TEMP=old_temp
 require(state['chain_id']==CHAIN and type(state['app_hash'])==str and HEX.fullmatch(state['app_hash']))
 text=state['header_time'];require(type(text)==str and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})',text))
 text=re.sub(r'\.([0-9]{1,9})(?=Z|[+-])',lambda m:'.'+(m.group(1)+'000000')[:6],text);age=(time.time() if now is None else now)-datetime.datetime.fromisoformat(text.replace('Z','+00:00')).timestamp();require(-60<=age<=120)
 height=native.decimal(state['height'],2**63-1);sequence=native.decimal(command['sequence']);expiry=native.decimal(command['expires_height'],2**63-1);records=state['records'];require(record_key in records and 'member/'+RELAY in records)
 member=records['member/'+RELAY];require(member['id']==RELAY and member['public_key']==envelope['public_key'] and state['member']['sequence']==member['sequence']);current=native.decimal(member['sequence']);record=records[record_key]
 if record is None:require(height>expiry and current==sequence);status='expired-unused'
 else:require(current>sequence and type(record)==dict and record.get('bundle')==command['payload']['bundle'] and 1<=native.decimal(record['height'],2**63-1)<=height);status='recorded'
 return dict(status=status,effects=effects,height=state['height'],transactionHash=sha(json.dumps(envelope,separators=(',',':')).encode()).upper(),transactionInclusionVerified=False,paid=False)
def process(custody,p,action,job,body,directory,key,invoke=worker,reconcile=public_reconcile,presence=payment_presence,send_presence=boundary_presence,rules=send_rules,ledger=None,clock=time.time):
 require(JOB.fullmatch(job) and action in ('create','certificate','ingest','send-ingest','inspect','report','attest','finalize','finalize-rules','relay','reconcile','health'))
 if action=='health':require(body is None and job=='0'*32);return invoke(custody,p,'health',job)
 def get(name):return sealed_read(directory,key,job,name)
 def put(name,value):return sealed_write(directory,key,job,name,value)
 def call(kind,**values):return invoke(custody,p,kind,job,**values)
 if action=='create':
  require(exact(body,['context']));validate_context(body['context']);write_once(directory/'context.json',body);return dict(status='created',jobId=job)
 context=load(directory/'context.json')['context']
 if action=='send-ingest' or (directory/'send-input.sealed.json').exists():
  # Server-built no-install send: no certificate, no invoice, no relay. One
  # approval: by custody's rule checks (finalize-rules) or, above 10,000 AI$ or
  # when a rule flags it, after the AI attestation (finalize). P1, 9 Nov 2026.
  require(not (directory/'certificate-started.json').exists() and action in ('send-ingest','inspect','report','attest','finalize','finalize-rules'))
  if action=='send-ingest':
   require(type(body)==dict and set(body)==SEND_INPUT and type(body['intent'])==dict);put('send-input',body);return dict(status='ingested')
  send=get('send-input')
  if action=='inspect':
   require(body is None)
   if (directory/'report.sealed.json').exists():report=get('report')
   else:
    report=call('send-inspect',context=context,send=send)['report'];require(type(report)==dict and report.get('jobId')==job and report['inspection']['context']==context and report['inspection'].get('invoice') is None)
   validate_context(context,report_height(report))
   held=send_claim(directory,key,job,context,send,presence=send_presence)
   if held is not None:return held
   put('report',report)
   route,reasons=send_route(send,rules(),clock(),ledger)
   # A rule refusal is a decision, not a fault: BAINK shows the reason to the payer.
   if route=='refuse':return dict(status='refused',reason='; '.join(reasons))
   return dict(status='inspected',inspectionDigest=report['inspectionDigest'],route=route,reasons=reasons)
  # Only an inspection that took the claim stores the report (a held one stores nothing).
  require((directory/'report.sealed.json').exists());report=get('report')
  if action=='report':require(body is None);return report
  if action=='attest':
   require(exact(body,['attestation','request','response']));call('attest',audit=body,report=report);put('audit',body);return dict(status='attested')
  require(body is None);require(send_claim(directory,key,job,context,send,presence=send_presence) is None)
  if (directory/'finalized.json').exists():return load(directory/'finalized.json')
  require(not (directory/'finalize-started.json').exists())
  # Neither path signs for a member on the refuse list, whatever BAINK asks.
  require(send_route(send,rules(),clock(),ledger)[0]!='refuse')
  if action=='finalize-rules':
   # Recomputed now from custody's own state: a send the rules route to the AI never gets here.
   now=clock();ledger=ledger or ROOT/'send-rules-ledger';route,_=send_route(send,rules(),now,ledger);require(route=='rules')
   write_once(directory/'finalize-started.json',dict(inspectionDigest=report['inspectionDigest'],route='rules'))
   ledger.mkdir(mode=0o700,exist_ok=True);write_once(ledger/(job+'.json'),dict(payer=send['intent']['from'],payee=send['intent']['to'],recipientAddress=send['intent'].get('recipientAddress'),amountUnits=send['intent']['amountUnits'],at=int(now)))
   value=call('send-finalize',context=context,send=send,report=report,audit=None,rules=True)
  else:
   write_once(directory/'finalize-started.json',dict(inspectionDigest=report['inspectionDigest'],auditDigest=sha(bytes_json(get('audit')))))
   value=call('send-finalize',context=context,send=send,report=report,audit=get('audit'))
  require(exact(value,['approval','reviewerBinding']) and value['reviewerBinding'] is None)
  a=value['approval'];require(type(a)==dict and a.get('effects')==context['effects'] and a.get('purpose_commitment')==context['purpose'] and a.get('expires_height')==context['expires'] and a.get('direction')=='shield' and a.get('reviewer')==REVIEWER)
  write_once(directory/'finalized.json',value);return load(directory/'finalized.json')
 if action=='certificate':
  require(body is None)
  if (directory/'certificate.json').exists():return load(directory/'certificate.json')
  require(not (directory/'certificate-started.json').exists());write_once(directory/'certificate-started.json',dict(contextDigest=sha(bytes_json(context))))
  value=call('certificate',context=context);require(exact(value,['certificate','encryptionPrivateKey']) and value['certificate']['context']==context);put('encryption-key',dict(encryptionPrivateKey=value['encryptionPrivateKey']));result=dict(certificate=value['certificate']);write_once(directory/'certificate.json',result);return load(directory/'certificate.json')
 certificate=load(directory/'certificate.json')['certificate']
 if action=='ingest':
  require(type(body)==dict and set(body) in ({'envelope','agreedInvoice'},{'envelope','agreedInvoice','purposeEvidence'}) and body['envelope']['certificate']==certificate);value=dict(envelope=body['envelope'],agreedInvoice=body['agreedInvoice'],purposeEvidence=body.get('purposeEvidence'));put('input',value);return dict(status='ingested')
 values=dict(certificate=certificate,**get('encryption-key'),**get('input'))
 if action=='inspect':
  require(body is None)
  if (directory/'report.sealed.json').exists():report=get('report')
  else:report=call('inspect',**values)['report']
  validate_context(context,report_height(report))
  invoice_claim(directory,key,job,report,presence=presence);put('report',report)
  return dict(status='inspected',inspectionDigest=report['inspectionDigest'])
 report=get('report')
 if action=='report':require(body is None);return report
 if action=='attest':
  require(exact(body,['attestation','request','response']));invoice_claim(directory,key,job,report,presence=presence);call('attest',audit=body,report=report);put('audit',body);return dict(status='attested')
 if action=='finalize':
  require(body is None)
  invoice_claim(directory,key,job,report,presence=presence)
  if (directory/'finalized.json').exists():return load(directory/'finalized.json')
  require(not (directory/'finalize-started.json').exists());write_once(directory/'finalize-started.json',dict(inspectionDigest=report['inspectionDigest'],auditDigest=sha(bytes_json(get('audit')))))
  value=call('finalize',**values,report=report,audit=get('audit'));require(exact(value,['approval','reviewerBinding']));write_once(directory/'finalized.json',value);return load(directory/'finalized.json')
 if action=='relay':
  require(exact(body,['result','reviewerBinding']));invoice_claim(directory,key,job,report,presence=presence);finalized=load(directory/'finalized.json');require(finalized['reviewerBinding'] is not None)
  request_digest=sha(bytes_json(body));path=directory/'relay.json'
  if path.exists():value=load(path);require(value['requestDigest']==request_digest);return dict(envelope=value['envelope'])
  require(not (directory/'relay-started.json').exists());inflight=ROOT/'relay-inflight.json'
  if inflight.exists():require(load(inflight)['jobId']==job)
  else:write_once(inflight,dict(jobId=job,requestDigest=request_digest))
  write_once(directory/'relay-started.json',dict(requestDigest=request_digest));value=call('relay',**body,finalized=finalized);require(exact(value,['envelope']));write_once(path,dict(requestDigest=request_digest,envelope=value['envelope']));return dict(envelope=load(path)['envelope'])
 require(action=='reconcile' and body is None)
 relay=load(directory/'relay.json');envelope=relay['envelope'];transaction_hash=sha(json.dumps(envelope,separators=(',',':')).encode()).upper()
 def release_own():
  inflight=ROOT/'relay-inflight.json'
  if inflight.exists():
   marker=load(inflight)
   if marker['jobId']==job:
    require(marker['requestDigest']==relay['requestDigest']);inflight.unlink();fd=os.open(ROOT,os.O_RDONLY|os.O_DIRECTORY);os.fsync(fd);os.close(fd)
 for name,status in [('relay-recorded.json','recorded'),('relay-expired.json','expired-unused')]:
  path=directory/name
  if path.exists():
   value=load(path);require(value.get('status')==status and value.get('transactionHash')==transaction_hash and value.get('paid') is False and value.get('transactionInclusionVerified') is False);release_own();return value
 try:value=reconcile(envelope);require(value.get('status') in ('recorded','expired-unused') and value.get('transactionHash')==transaction_hash and value.get('paid') is False and value.get('transactionInclusionVerified') is False)
 except Exception:return dict(status='unknown',paid=False,transactionInclusionVerified=False)
 # Keep the first exact historical proof before releasing the global nonce.
 # A later tip or another job's inflight marker must never replace that proof.
 write_once(directory/('relay-recorded.json' if value['status']=='recorded' else 'relay-expired.json'),value);release_own();return value
def run(custody,action,job,body=None):
 require(os.geteuid()==0 and type(job)==str and JOB.fullmatch(job));resource.setrlimit(resource.RLIMIT_CORE,(0,0));os.umask(0o077)
 admission.ensure_directory(ROOT);admission.ensure_directory(TEMP);p=load(POLICY);validate_policy(p)
 if action=='health':require(body is None and job=='0'*32);return worker(custody,p,'health',job)
 directory=ROOT/job;admission.ensure_directory(directory);key=hashlib.sha256(b'BAINK/private-service/sealing/v1\0'+custody.password().encode()).digest()
 fd=os.open(ROOT/'service.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)
 with os.fdopen(fd,'r+b') as lock:
  s=os.fstat(lock.fileno());require(stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_nlink==1 and not s.st_mode&0o077);fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  return process(custody,p,action,job,body,directory,key)
if __name__=='__main__':
 try:
  require(len(sys.argv)==3);action,job=sys.argv[1:];body=None
  if action in ('create','ingest','send-ingest','attest','relay'):
   raw=sys.stdin.buffer.read(LIMIT+1);require(1<=len(raw)<=LIMIT);body=native.strict_json(raw)
  import custody
  print(json.dumps(run(custody,action,job,body),separators=(',',':')))
 except Exception:
  print('Private payment service refused.',file=sys.stderr);sys.exit(1)

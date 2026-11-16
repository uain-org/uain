"""Fixed-purpose treasury custody. No key export, arbitrary command or calldata.

Root-approved public plans are rechecked against fresh original-genesis IAVL
state and independent external RPC before any dedicated vault seed is read.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import stat
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

import native_migration as native

CHAIN=native.CHAIN
GENESIS=native.GENESIS
GUARDIAN=native.GUARDIAN
GUARDIAN_PUBLIC='mDuiMoDUKg66PitMD-j1pztm81wOKlYq7nFFCWLXoRI'
ROOT=Path('/var/lib/uain-custody/treasury')
RPC_CONFIG=Path('/etc/uain-custody/treasury-rpc.json')
NETWORKS=('ethereum:1','ethereum:8453','solana:mainnet')
SEEDS={n:'keys/treasury-'+n.replace(':','-')+'.seed' for n in NETWORKS}
WALLETS='treasury/wallets.json'
APPROVAL_SCHEMA='uain-treasury-execution-approval-v1'
APPROVAL_FIELDS={'schema','execution','plan_sha256','genesis_sha256','state_binary_sha256','signer_binary_sha256','rpc_config_sha256','intent_sha256','liability_sha256','max_fee','expires_at'}
TRANSFER_BASE={'schema','intent','network','source','target','amount'}
HEX=re.compile(r'^[0-9a-f]{64}$')
ID=re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$')
DEC=re.compile(r'^(0|[1-9][0-9]{0,77})$')
SOLANA_GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
require=native.require
sha=native.sha
strict_json=native.strict_json
protected_read=native.protected_read

def atomic(path,value):
 path=Path(path);pending=path.with_name(path.name+'.pending')
 if pending.exists():
  require(strict_json(protected_read(pending,8*1024*1024))==value)
  os.replace(pending,path);directory_sync(path.parent);return
 native.atomic(path,value)


def number(value,maximum=2**256-1):
 require(type(value)==str and DEC.fullmatch(value));n=int(value);require(n<=maximum);return n


def record_digest(record):return sha(native.canonical(record).encode())


def public_plan(raw):
 require(len(raw)<=65536);p=strict_json(raw)
 require(type(p)==dict and p.get('schema')=='uain-treasury-native-transfer-v1' and p.get('network') in NETWORKS)
 network=p['network'];expected=TRANSFER_BASE|({'nonce','gas_limit','max_priority_fee_per_gas','max_fee_per_gas'} if network.startswith('ethereum:') else {'recent_blockhash'})
 require(set(p)==expected and all(type(v)==str for v in p.values()))
 kind,separator,ident=p['intent'].partition('/');require(separator and kind in ('payout','refund','operations') and ID.fullmatch(ident))
 require(p['source']!=p['target'] and number(p['amount'],2**64-1 if network=='solana:mainnet' else 2**256-1)>0)
 if network.startswith('ethereum:'):
  for field in ('source','target'):require(re.fullmatch(r'0x[0-9a-f]{40}',p[field]) and p[field]!='0x'+'0'*40)
  require(p['gas_limit']=='21000');number(p['nonce'],2**64-1);number(p['max_priority_fee_per_gas']);number(p['max_fee_per_gas'])
  require(0<number(p['max_fee_per_gas']) and number(p['max_priority_fee_per_gas'])<=number(p['max_fee_per_gas']))
 else:
  for field in ('source','target','recent_blockhash'):base58_bytes(p[field],32)
 return p


def intent_record_key(kind,ident):
 require(kind in ('payout','refund','operations'));return {'payout':'external_payout/','refund':'funding_receipt/','operations':'operations_intent/'}[kind]+ident


def quorum_record_key(kind,ident):
 require(kind in ('payout','refund','operations'));return {'payout':'external_payout_quorum/','refund':'funding_quorum/','operations':'operations_quorum/'}[kind]+ident+('/refund' if kind=='refund' else '')


def intent_selection(p,state=None):
 kind,ident=p['intent'].split('/');intent_key=intent_record_key(kind,ident)
 keys=['funding_activation','treasury_escrow/'+p['network']+'/'+p['source'],'treasury_liability/'+p['network']+'/'+p['source'],intent_key]
 if state is not None:
  intent=state['records'][intent_key];require(type(intent)==dict)
  receipt_id=intent['receipt'] if kind!='refund' else ident
  require(ID.fullmatch(receipt_id));keys.append('funding_receipt/'+receipt_id)
  receipt=state['records'].get('funding_receipt/'+receipt_id)
  if receipt is not None:
   require(ID.fullmatch(receipt['campaign']));keys.extend(['funding_campaign/'+receipt['campaign'],'funding_pool/'+receipt_id])
  if kind=='refund':keys.append('funding_refund_request/'+ident)
  if kind=='operations':keys.append('operations_filing/'+ident)
 return list(dict.fromkeys(keys))


def validate_approval(raw,a,now):
 require(type(a)==dict and set(a)==APPROVAL_FIELDS and a['schema']==APPROVAL_SCHEMA and a['genesis_sha256']==GENESIS and re.fullmatch(r'[a-f0-9]{32}',a['execution']))
 for field in ('plan_sha256','state_binary_sha256','signer_binary_sha256','rpc_config_sha256','intent_sha256','liability_sha256'):require(type(a[field])==str and HEX.fullmatch(a[field]))
 require(type(a['expires_at'])==int and now<a['expires_at']<=now+3600 and sha(raw)==a['plan_sha256']);number(a['max_fee'])


def pool_valid(pool):
 require(type(pool)==dict and set(pool)=={'funded','refunded','bounty','dividend','operations','dust'})
 total=number(pool['refunded'])+number(pool['dust'])
 for field in ('bounty','dividend','operations'):
  bucket=pool[field];require(type(bucket)==dict and set(bucket)=={'available','reserved','paid'})
  total+=sum(number(bucket[k]) for k in bucket)
 require(total==number(pool['funded']))


def _validate_transfer(raw,a,state,wallets,now=None):
 now=time.time() if now is None else now;validate_approval(raw,a,now);p=public_plan(raw)
 require(state['chain_id']==CHAIN and state['member']['id']==GUARDIAN)
 height=number(state['height'],2**63-1);records=state['records'];activation=records['funding_activation']
 require(activation['policy']=='external-receipts-80-15-5-v1' and 2<=number(activation['height'],2**63-1)<=height and 2<=len(activation['observers'])<=20)
 require(wallets[p['network']]==p['source'])
 escrow=records['treasury_escrow/'+p['network']+'/'+p['source']]
 require(escrow['policy']=='proved-native-treasury-escrow-v1' and escrow['network']==p['network'] and escrow['address']==p['source'] and escrow['controller']==GUARDIAN)
 require(1<=number(escrow['height'])<=number(escrow['approved_height'])<=number(escrow['expires_height']))
 liability=records['treasury_liability/'+p['network']+'/'+p['source']]
 require(record_digest(liability)==a['liability_sha256'] and liability['network']==p['network'] and liability['escrow']==p['source'])
 outstanding=number(liability['outstanding'],2**64-1 if p['network']=='solana:mainnet' else 2**256-1)
 require(number(liability['funded'])==number(liability['paid'])+number(liability['refunded'])+outstanding and outstanding>=number(p['amount']))
 kind,ident=p['intent'].split('/');key=intent_record_key(kind,ident);intent=records[key]
 require(record_digest(intent)==a['intent_sha256'] and intent['id']==ident)
 receipt=records['funding_receipt/'+(intent['receipt'] if kind!='refund' else ident)];campaign=records['funding_campaign/'+receipt['campaign']]
 require(campaign['id']==receipt['campaign'] and campaign['network']==p['network'] and campaign['asset']=='native' and campaign['escrow']==p['source'])
 pool=records['funding_pool/'+receipt['id']];pool_valid(pool)
 if kind in ('payout','operations'):
  require(receipt['id']==intent['receipt'] and number(pool['funded'])==number(receipt['amount']))
  require(receipt['state']=='confirmed' and intent['state']=='pending' and intent['network']==p['network'] and intent['asset']=='native' and intent['escrow']==p['source'] and intent['address' if kind=='payout' else 'target']==p['target'] and intent['amount']==p['amount'])
  require(number(pool['bounty' if kind=='payout' else 'operations']['reserved'])>=number(p['amount']))
  if kind=='operations':require(records['operations_filing/'+ident]==intent)
 else:
  require(receipt['state']=='refund_pending' and receipt['source']==p['target'] and receipt['amount']==p['amount'] and type(records['funding_refund_request/'+ident])==dict)
  require(number(pool['funded'])==number(receipt['amount']) and number(pool['refunded'])==0 and all(number(pool[b][f])==0 for b in ('bounty','dividend','operations') for f in ('reserved','paid')))
 if p['network'].startswith('ethereum:'):require(21000*number(p['max_fee_per_gas'])<=number(a['max_fee']) and outstanding+21000*number(p['max_fee_per_gas'])<=2**256-1)
 return p


def validate_transfer(raw,a,state,wallets,now=None):
 try:return _validate_transfer(raw,a,state,wallets,now)
 except (KeyError,TypeError,IndexError,OverflowError):raise ValueError('Malformed treasury context refused') from None


def pinned_binary(kind,digest):
 require(type(digest)==str and HEX.fullmatch(digest));base=Path('/opt/uain-chain/tools')/kind/digest;binary=base/('uain-treasury-sign' if kind=='treasury' else 'uain-state')
 require(binary.resolve()==binary)
 for path in (binary,*binary.parents):
  info=path.stat();require(info.st_uid==0 and not info.st_mode&0o022)
 require(binary.is_file() and binary.stat().st_size<256*1024*1024 and sha(binary.read_bytes())==digest)
 return binary


def state_read(a,keys):
 binary=pinned_binary('state',a['state_binary_sha256']);genesis=native.HOME/'config/genesis.json';require(sha(genesis.read_bytes())==GENESIS)
 with tempfile.TemporaryDirectory(prefix='uain-treasury-state-',dir='/run') as tmp:
  out=Path(tmp)/'state.json'
  result=subprocess.run([str(binary),'--genesis',str(genesis),'--genesis-sha256',GENESIS,'--rpc','http://127.0.0.1:26667','--out',str(out),'--max-age','120s'],input=json.dumps({'member':GUARDIAN,'keys':keys}).encode(),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=65)
  require(result.returncode==0);return strict_json(protected_read(out,8*1024*1024))


def transfer_state(a,p):
 # Discovery reads never authorize a payment. Reprove the entire derived bounded
 # key set at ONE fresh finalized height and refuse any discovery-context drift.
 state=state_read(a,intent_selection(p));keys=intent_selection(p,state)
 if not p['intent'].startswith('refund/'):
  state=state_read(a,keys);keys=intent_selection(p,state)
 state=state_read(a,keys)
 require(set(keys)<=set(state['records']));return state


def run_signer(binary,mode,plan,seed):
 require(mode in ('address','control','transfer') and len(seed)==32)
 raw=json.dumps(plan,separators=(',',':')).encode();require(len(raw)<=65536)
 readfd,writefd=os.pipe()
 try:
  os.write(writefd,seed);os.close(writefd);writefd=-1
  # FD setup occurs only in an isolated child, never clobbering parent FD3.
  bootstrap='import os,sys,resource; resource.setrlimit(resource.RLIMIT_CORE,(0,0)); f=int(sys.argv[1]); os.dup2(f,3); os.set_inheritable(3,True); os.close(f) if f!=3 else None; os.chdir("/"); os.execve(sys.argv[2],[sys.argv[2],sys.argv[3]],{"PATH":"/usr/bin:/bin","LANG":"C"})'
  result=subprocess.run([sys.executable,'-I','-S','-c',bootstrap,str(readfd),str(binary),mode],pass_fds=(readfd,),input=raw,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=20,env={'PATH':'/usr/bin:/bin','LANG':'C'})
  require(result.returncode==0 and len(result.stdout)<=65536);return strict_json(result.stdout)
 finally:
  os.close(readfd)
  if writefd!=-1:os.close(writefd)


def provision(custody,signer_sha):
 require(os.geteuid()==0);resource.setrlimit(resource.RLIMIT_CORE,(0,0));binary=pinned_binary('treasury',signer_sha)
 kp=custody.vault();custody.verify_vault(kp);files={item['name']:custody.attachment(kp,item['name']) for item in custody.records(kp)}
 existing=[name in files for name in (*SEEDS.values(),WALLETS)];require(all(existing) or not any(existing));addresses={}
 for network in NETWORKS:
  seed=bytearray(files[SEEDS[network]] if all(existing) else os.urandom(32))
  try:
   result=run_signer(binary,'address',dict(schema='uain-treasury-address-v1',network=network),seed)
   require(set(result)=={'network','address'} and result['network']==network);addresses[network]=result['address']
   if not all(existing):files[SEEDS[network]]=bytes(seed)
  finally:
   for i in range(len(seed)):seed[i]=0
 require(len(set(addresses.values()))==3)
 if all(existing):require(strict_json(files[WALLETS])==dict(schema='uain-dedicated-treasury-wallets-v1',addresses=addresses))
 else:
  files[WALLETS]=json.dumps(dict(schema='uain-dedicated-treasury-wallets-v1',addresses=addresses),sort_keys=True).encode();custody.save_vault(files)
 # Authenticated cross-host AND offsite restore verification precedes advertising
 # addresses as usable. Failure retains encrypted keys, so retry reuses them.
 custody.backup();ROOT.mkdir(mode=0o700,parents=True,exist_ok=True);atomic(ROOT/'wallets.json',dict(schema='uain-dedicated-treasury-wallets-v1',addresses=addresses));print(json.dumps(dict(schema='uain-dedicated-treasury-wallets-v1',addresses=addresses,backed_up=True,registered=False)))


def base58_bytes(text,length):
 alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';require(type(text)==str and 1<=len(text)<=88 and all(c in alphabet for c in text))
 n=0
 for c in text:n=n*58+alphabet.index(c)
 raw=(n.to_bytes((n.bit_length()+7)//8,'big') if n else b'');raw=b'\0'*(len(text)-len(text.lstrip('1')))+raw
 require(len(raw)==length and any(raw));return raw


def hex_number(value):
 require(type(value)==str and re.fullmatch(r'0x(0|[1-9a-f][0-9a-f]{0,63})',value));return int(value,16)


def check_external(p,a,outstanding,rpc,now=None,context=None):
 now=time.time() if now is None else now
 if p['network'].startswith('ethereum:'):
  require(hex_number(rpc('eth_chainId',[]))==int(p['network'].split(':')[1]))
  block=rpc('eth_getBlockByNumber',['latest',False]);require(abs(now-hex_number(block['timestamp']))<=120)
  fee=21000*number(p['max_fee_per_gas']);require(fee<=number(a['max_fee']) and number(p['max_fee_per_gas'])>=hex_number(block['baseFeePerGas'])+number(p['max_priority_fee_per_gas']))
  for who in ('source','target'):
   for point in ('latest','finalized'):require(rpc('eth_getCode',[p[who],point])=='0x')
  for point in ('latest','pending'):require(hex_number(rpc('eth_getTransactionCount',[p['source'],point]))==number(p['nonce'],2**64-1))
  require(hex_number(rpc('eth_getBalance',[p['source'],'latest']))>=outstanding+fee);return fee
 require(rpc('getGenesisHash',[])==SOLANA_GENESIS)
 latest=rpc('getLatestBlockhash',[{'commitment':'finalized'}]);require(latest['value']['blockhash']==p['recent_blockhash'])
 slot=latest['context']['slot'];require(type(slot)==int and slot>=0 and abs(now-rpc('getBlockTime',[slot]))<=120)
 require(type(latest['value']['lastValidBlockHeight'])==int and latest['value']['lastValidBlockHeight']>=rpc('getBlockHeight',[{'commitment':'finalized'}]))
 if context is not None:context['solana_last_valid_block_height']=latest['value']['lastValidBlockHeight']
 # Legacy message of the exact one-instruction transfer. Fee simulation uses no
 # seed/signature and cannot substitute arbitrary instructions.
 message=b'\x01\x00\x01\x03'+base58_bytes(p['source'],32)+base58_bytes(p['target'],32)+bytes(32)+base58_bytes(p['recent_blockhash'],32)+b'\x01\x02\x02\x00\x01\x0c\x02\x00\x00\x00'+number(p['amount'],2**64-1).to_bytes(8,'little')
 fee=rpc('getFeeForMessage',[base64.b64encode(message).decode(),{'commitment':'finalized'}])['value'];require(type(fee)==int and 0<fee<=number(a['max_fee'],2**64-1))
 for who in ('source','target'):
  info=rpc('getAccountInfo',[p[who],{'commitment':'finalized','encoding':'base64'}])['value']
  require(info is not None or who=='target')
  if info is not None:require(info['owner']=='11111111111111111111111111111111' and info['executable'] is False)
 balance=rpc('getBalance',[p['source'],{'commitment':'finalized'}])['value'];require(type(balance)==int and outstanding+fee<=balance<=2**64-1)
 return fee


class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):raise ValueError('RPC redirect refused')


def rpc_client(endpoint):
 url=urllib.parse.urlsplit(endpoint);require(url.scheme=='https' or url.scheme=='http' and url.hostname in ('127.0.0.1','::1'))
 require(url.hostname and not url.username and not url.password and not url.fragment)
 opener=urllib.request.build_opener(NoRedirect());deadline=time.monotonic()+120
 def rpc(method,params):
  require(time.monotonic()<deadline);frame=json.dumps(dict(jsonrpc='2.0',id='uain-treasury',method=method,params=params)).encode()
  with opener.open(urllib.request.Request(endpoint,data=frame,headers={'Content-Type':'application/json'}),timeout=10) as response:
   raw=response.read(1048577);require(len(raw)<=1048576)
  def pairs(items):
   out={}
   for key,value in items:require(key not in out);out[key]=value
   return out
  def reject(_):raise ValueError('Inexact RPC number refused')
  result=json.loads(raw,object_pairs_hook=pairs,parse_float=reject,parse_constant=reject)
  require(type(result)==dict and result.get('jsonrpc')=='2.0' and result.get('id')=='uain-treasury' and 'result' in result and 'error' not in result)
  return result['result']
 return rpc


def load_rpc(a,p):
 raw=protected_read(RPC_CONFIG,16384);require(sha(raw)==a['rpc_config_sha256']);config=strict_json(raw)
 require(set(config)=={'schema','endpoints'} and config['schema']=='uain-treasury-rpc-v1' and set(config['endpoints'])==set(NETWORKS))
 return rpc_client(config['endpoints'][p['network']])


def start_journal(path,value):
 require(not Path(path).exists());atomic(path,dict(value,status='started'))


def seed_record(custody,kp,network):
 items=[v for v in custody.records(kp) if v['name']==SEEDS[network]]
 require(len(items)==1 and items[0]['bytes']==32 and type(items[0]['sha256'])==str and HEX.fullmatch(items[0]['sha256']))
 return items[0]['sha256']


def transfer_output(output,p):
 require(type(output)==dict and set(output)=={'id','transaction'} and all(type(v)==str for v in output.values()))
 if p['network'].startswith('ethereum:'):require(re.fullmatch(r'0x[0-9a-f]{64}',output['id']) and re.fullmatch(r'0x[0-9a-f]{2,4096}',output['transaction']))
 else:base58_bytes(output['id'],64);require(len(base64.b64decode(output['transaction'],validate=True))==215)
 return output


def directory_sync(path):
 fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)


def retain_signed(directory,a,output):
 value=dict(schema='uain-treasury-signed-v1',execution=a['execution'],plan_sha256=a['plan_sha256'],**output)
 path=directory/'signed.json';pending=directory/'signed.json.pending'
 # A repair may finish an interrupted atomic rename, never replace a different
 # retained wire. Every comparison is of exact signed transaction bytes.
 for existing in (path,pending):
  if existing.exists():require(strict_json(protected_read(existing,65536))==value)
 if pending.exists():
  if path.exists():pending.unlink()
  else:os.replace(pending,path)
  directory_sync(directory)
 if not path.exists():atomic(path,value)
 return sha(protected_read(path,65536))


def sign_approved(custody,execution):
 require(os.geteuid()==0 and re.fullmatch(r'[a-f0-9]{32}',execution));os.umask(0o077);resource.setrlimit(resource.RLIMIT_CORE,(0,0))
 directory=ROOT/execution;raw=protected_read(directory/'plan.json',65536);a=strict_json(protected_read(directory/'approval.json',16384));validate_approval(raw,a,time.time());require(a['execution']==execution)
 p=public_plan(raw);binary=pinned_binary('treasury',a['signer_binary_sha256']);state=transfer_state(a,p)
 # Public address metadata is root protected outside the encrypted vault.
 # No vault is opened until every authorization/RPC check passes.
 wallets=strict_json(protected_read(ROOT/'wallets.json',16384));require(wallets['schema']=='uain-dedicated-treasury-wallets-v1')
 p=validate_transfer(raw,a,state,wallets['addresses']);outstanding=number(state['records']['treasury_liability/'+p['network']+'/'+p['source']]['outstanding']);context={};fee=check_external(p,a,outstanding,load_rpc(a,p),context=context)
 lock=ROOT/('unresolved-'+sha((p['network']+'/'+p['source']).encode())+'.json')
 # Reprove all mutable native context after bounded external reads.
 state=transfer_state(a,p);validate_transfer(raw,a,state,wallets['addresses'])
 start_journal(lock,dict(execution=execution,intent=p['intent'],plan_sha256=a['plan_sha256']))
 start_journal(directory/'journal.json',dict(execution=execution,intent=p['intent'],plan_sha256=a['plan_sha256'],fee=str(fee),external_context=context,native_height=state['height']))
 kp=custody.vault();seed_sha=seed_record(custody,kp,p['network'])
 receipt=dict(status='key_committed',execution=execution,intent=p['intent'],plan_sha256=a['plan_sha256'],signer_binary_sha256=a['signer_binary_sha256'],seed_sha256=seed_sha,fee=str(fee),external_context=context,native_height=state['height'],private_keys_exported=False)
 # This fsynced commitment MUST precede reading the seed. It permits only
 # deterministic reconstruction of the same wire after a process/power loss.
 atomic(directory/'journal.json',receipt)
 seed=bytearray(custody.attachment(kp,SEEDS[p['network']]))
 try:
  require(len(seed)==32 and sha(seed)==seed_sha);output=run_signer(binary,'transfer',p,seed)
 finally:
  for i in range(len(seed)):seed[i]=0
 transfer_output(output,p);digest=retain_signed(directory,a,output)
 receipt.update(status='signed',signed_sha256=digest,transaction_id=output['id'])
 atomic(directory/'journal.json',receipt);print(json.dumps(receipt))


def repair_approved(custody,execution):
 """Retire a pre-key attempt or reconstruct ONLY its exact deterministic wire.

 No broadcast, changed nonce/blockhash/fee or new payment is permitted here.
 Root supplies a fresh narrow approval after inspecting the public journals.
 """
 require(os.geteuid()==0 and re.fullmatch(r'[a-f0-9]{32}',execution));os.umask(0o077);resource.setrlimit(resource.RLIMIT_CORE,(0,0))
 directory=ROOT/execution;raw=protected_read(directory/'plan.json',65536);p=public_plan(raw);a=strict_json(protected_read(directory/'approval.json',16384));r=strict_json(protected_read(directory/'repair-approval.json',16384))
 require(set(r)=={'schema','execution','plan_sha256','signer_binary_sha256','seed_sha256','expires_at'} and r['schema']=='uain-treasury-wire-repair-approval-v1' and r['execution']==a['execution']==execution and r['plan_sha256']==a['plan_sha256']==sha(raw) and r['signer_binary_sha256']==a['signer_binary_sha256'])
 require(set(a)==APPROVAL_FIELDS and a['schema']==APPROVAL_SCHEMA and a['genesis_sha256']==GENESIS and type(r['expires_at'])==int and time.time()<r['expires_at']<=time.time()+3600)
 path=directory/'journal.json';pending=directory/'journal.json.pending'
 lock=ROOT/('unresolved-'+sha((p['network']+'/'+p['source']).encode())+'.json');lock_pending=lock.with_name(lock.name+'.pending')
 if lock_pending.exists():
  candidate=strict_json(protected_read(lock_pending,16384));require(candidate.get('execution')==execution and candidate.get('intent')==p['intent'] and candidate.get('plan_sha256')==sha(raw) and candidate.get('status')=='started')
  require(not lock.exists());os.replace(lock_pending,lock);directory_sync(ROOT)
 if not path.exists() and not pending.exists():
  require(r['seed_sha256']=='' and not (directory/'signed.json').exists() and not (directory/'signed.json.pending').exists())
  candidate=strict_json(protected_read(lock,16384));require(candidate.get('execution')==execution and candidate.get('intent')==p['intent'] and candidate.get('plan_sha256')==sha(raw) and candidate.get('status')=='started')
  journal=dict(status='aborted_before_key',execution=execution,intent=p['intent'],plan_sha256=sha(raw));atomic(path,journal);release_lock(p,execution);print(json.dumps(journal));return
 journal=strict_json(protected_read(path if path.exists() else pending,16384))
 require(journal['execution']==execution and journal['plan_sha256']==sha(raw) and journal['status'] in ('started','key_committed','signed','aborted_before_key'))
 if journal['status']=='aborted_before_key':
  require(r['seed_sha256']=='');release_lock(p,execution,True);print(json.dumps(journal));return
 require(strict_json(protected_read(lock,16384))['execution']==execution)
 if pending.exists():
  candidate=strict_json(protected_read(pending,16384))
  require(candidate['execution']==execution and candidate['plan_sha256']==sha(raw) and candidate['status'] in ('started','key_committed','signed','aborted_before_key'))
  require(candidate['status']==journal['status'] or (journal['status'],candidate['status']) in (('started','key_committed'),('key_committed','signed'),('started','aborted_before_key')))
  for key in ('intent','fee','external_context','native_height','seed_sha256','signer_binary_sha256'):
   if key in journal:require(candidate.get(key)==journal[key])
  journal=candidate
  # Finish only a validated monotonic public journal update.
  os.replace(pending,path);directory_sync(directory)
 if journal['status']=='aborted_before_key':
  require(r['seed_sha256']=='' and not (directory/'signed.json').exists() and not (directory/'signed.json.pending').exists());release_lock(p,execution,True);print(json.dumps(journal));return
 if journal['status']=='started':
  require(r['seed_sha256']=='' and not (directory/'signed.json').exists() and not (directory/'signed.json.pending').exists())
  journal.update(status='aborted_before_key');atomic(path,journal);release_lock(p,execution);print(json.dumps(journal));return
 require(journal['seed_sha256']==r['seed_sha256'] and HEX.fullmatch(r['seed_sha256']) and journal['signer_binary_sha256']==r['signer_binary_sha256'] and journal['intent']==p['intent'])
 if journal['status']=='signed':
  execution_files(execution);print(json.dumps(journal));return
 binary=pinned_binary('treasury',r['signer_binary_sha256']);state=transfer_state(a,p);wallets=strict_json(protected_read(ROOT/'wallets.json',16384))
 require(state['chain_id']==CHAIN and state['member']['id']==GUARDIAN and wallets['schema']=='uain-dedicated-treasury-wallets-v1' and wallets['addresses'][p['network']]==p['source'])
 kind,ident=p['intent'].split('/');key=intent_record_key(kind,ident);intent=dict(state['records'][key])
 # Native settlement may have completed before the operator recovered the
 # public wire. Normalize only its terminal state when checking frozen identity.
 require(intent['state'] in (('pending','paid') if kind!='refund' else ('refund_pending','refunded')))
 intent['state']='pending' if kind!='refund' else 'refund_pending';require(record_digest(intent)==a['intent_sha256'])
 if kind=='operations':require(state['records']['operations_filing/'+ident]==intent)
 escrow=state['records']['treasury_escrow/'+p['network']+'/'+p['source']]
 require(escrow['network']==p['network'] and escrow['address']==p['source'] and escrow['controller']==GUARDIAN and escrow['policy']=='proved-native-treasury-escrow-v1')
 kp=custody.vault();require(seed_record(custody,kp,p['network'])==r['seed_sha256']);seed=bytearray(custody.attachment(kp,SEEDS[p['network']]))
 try:
  require(len(seed)==32 and sha(seed)==r['seed_sha256']);output=transfer_output(run_signer(binary,'transfer',p,seed),p)
 finally:
  for i in range(len(seed)):seed[i]=0
 digest=retain_signed(directory,a,output);journal.update(status='signed',signed_sha256=digest,transaction_id=output['id'],wire_repaired_at=int(time.time()))
 atomic(path,journal);print(json.dumps(journal))


def final_external(p,signed,rpc):
 """Trusted-RPC finalized observation of EXACT already-signed bytes/effect."""
 txid=signed['id']
 if p['network'].startswith('ethereum:'):
  chain=int(p['network'].split(':')[1]);require(hex_number(rpc('eth_chainId',[]))==chain)
  tx=rpc('eth_getTransactionByHash',[txid]);receipt=rpc('eth_getTransactionReceipt',[txid])
  require(type(tx)==dict and type(receipt)==dict and tx['hash']==receipt['transactionHash']==txid and hex_number(receipt['status'])==1)
  require(hex_number(tx['chainId'])==chain and hex_number(tx['type'])==2 and hex_number(tx['nonce'])==number(p['nonce']))
  require(tx['from'].lower()==receipt['from'].lower()==p['source'] and tx['to'].lower()==receipt['to'].lower()==p['target'] and hex_number(tx['value'])==number(p['amount']) and tx['input']=='0x')
  require(tx['blockHash']==receipt['blockHash'] and tx['blockNumber']==receipt['blockNumber'] and tx['transactionIndex']==receipt['transactionIndex'])
  finalized=rpc('eth_getBlockByNumber',['finalized',False]);require(hex_number(finalized['number'])>=hex_number(receipt['blockNumber']))
  for _ in range(2):
   block=rpc('eth_getBlockByNumber',[receipt['blockNumber'],False]);require(block['hash']==receipt['blockHash'] and block['number']==receipt['blockNumber'] and block['transactions'][hex_number(receipt['transactionIndex'])]==txid)
  require(rpc('eth_getTransactionReceipt',[txid])==receipt and hex_number(rpc('eth_chainId',[]))==chain)
  return dict(transaction=txid,index='0',block=str(hex_number(receipt['blockNumber'])),block_hash=receipt['blockHash'])
 require(rpc('getGenesisHash',[])==SOLANA_GENESIS)
 status=rpc('getSignatureStatuses',[[txid],{'searchTransactionHistory':True}])['value'][0]
 require(type(status)==dict and status['err'] is None and status['confirmationStatus']=='finalized' and type(status['slot'])==int)
 slot=status['slot'];require(rpc('getSlot',[{'commitment':'finalized'}])>=slot)
 tx=rpc('getTransaction',[txid,{'commitment':'finalized','encoding':'base64','maxSupportedTransactionVersion':1}])
 require(tx['slot']==slot and tx['meta']['err'] is None and tx['transaction']==[signed['transaction'],'base64'] and tx['version']=='legacy')
 params=[slot,{'commitment':'finalized','transactionDetails':'signatures','rewards':False,'maxSupportedTransactionVersion':1}]
 block=rpc('getBlock',params);base58_bytes(block['blockhash'],32);require(txid in block['signatures'])
 again=rpc('getBlock',params);require(again['blockhash']==block['blockhash'] and txid in again['signatures'])
 again=rpc('getSignatureStatuses',[[txid],{'searchTransactionHistory':True}])['value'][0]
 require(again['err'] is None and again['confirmationStatus']=='finalized' and again['slot']==slot and rpc('getGenesisHash',[])==SOLANA_GENESIS)
 return dict(transaction=txid,index='0',block=str(slot),block_hash=block['blockhash'])


def execution_files(execution):
 require(os.geteuid()==0 and re.fullmatch(r'[a-f0-9]{32}',execution));directory=ROOT/execution
 raw=protected_read(directory/'plan.json',65536);p=public_plan(raw);a=strict_json(protected_read(directory/'approval.json',16384));signed_raw=protected_read(directory/'signed.json',65536);signed=strict_json(signed_raw);journal=strict_json(protected_read(directory/'journal.json',16384))
 pending=directory/'journal.json.pending'
 if pending.exists():
  candidate=strict_json(protected_read(pending,16384));old=journal['status'];new=candidate['status']
  require(all(candidate.get(k)==v for k,v in journal.items() if k!='status'))
  allowed={'key_committed':('signed',),'signed':('broadcast_started','external_finalized','failed_finalized','expired_unbroadcastable'),'broadcast_started':('broadcast_submitted','external_finalized','failed_finalized','expired_unbroadcastable'),'broadcast_submitted':('external_finalized','failed_finalized','expired_unbroadcastable'),'external_finalized':('settled',),'settled':(),'failed_finalized':(),'expired_unbroadcastable':()}
  require(new==old or new in allowed.get(old,()))
  require(candidate.get('signed_sha256')==sha(signed_raw) and candidate.get('transaction_id')==signed['id'] and candidate.get('execution')==execution and candidate.get('plan_sha256')==sha(raw))
  # Complete a durable monotonic marker before deciding whether any broadcast
  # is allowed. In particular broadcast_started NEVER becomes signed again.
  os.replace(pending,directory/'journal.json');directory_sync(directory);journal=candidate
 require(a['execution']==execution and a['genesis_sha256']==GENESIS and a['plan_sha256']==sha(raw)==signed['plan_sha256']==journal['plan_sha256'] and signed['execution']==execution and signed['schema']=='uain-treasury-signed-v1' and sha(signed_raw)==journal['signed_sha256'] and signed['id']==journal['transaction_id'])
 return directory,p,a,signed,journal


def submit(execution):
 """Public bytes only; durable broadcast marker makes retries read-only."""
 directory,p,a,signed,journal=execution_files(execution)
 require(journal['status']=='signed' and time.time()<a['expires_at']);lock=ROOT/('unresolved-'+sha((p['network']+'/'+p['source']).encode())+'.json');require(strict_json(protected_read(lock,16384))['execution']==execution)
 # Recheck current intent, liability, nonce and fresh RPC even after signing.
 raw=protected_read(directory/'plan.json',65536);wallets=strict_json(protected_read(ROOT/'wallets.json',16384))['addresses'];state=transfer_state(a,p);validate_transfer(raw,a,state,wallets)
 rpc=load_rpc(a,p);check_external(p,a,number(state['records']['treasury_liability/'+p['network']+'/'+p['source']]['outstanding']),rpc)
 journal.update(status='broadcast_started',broadcast_at=int(time.time()));atomic(directory/'journal.json',journal)
 if p['network'].startswith('ethereum:'):txid=rpc('eth_sendRawTransaction',[signed['transaction']])
 else:txid=rpc('sendTransaction',[signed['transaction'],{'encoding':'base64','skipPreflight':False,'preflightCommitment':'finalized','maxRetries':0}])
 require(txid==signed['id']);journal.update(status='broadcast_submitted');atomic(directory/'journal.json',journal);print(json.dumps(dict(status=journal['status'],execution=execution,transaction_id=txid)))


def validate_closed(p,signed,state,point):
 records=state['records'];require(state['chain_id']==CHAIN);kind,ident=p['intent'].split('/')
 effect=records['treasury_effect/'+kind+'/'+ident]
 require(effect==dict(kind=kind,id=ident,network=p['network'],escrow=p['source'],amount=p['amount']))
 intent=records[intent_record_key(kind,ident)]
 require(intent['state']==('paid' if kind!='refund' else 'refunded'))
 quorum=records[quorum_record_key(kind,ident)]
 require(len(quorum['observations'])==2 and len({x['member'] for x in quorum['observations']})==2)
 for observation in quorum['observations']:
  actual=observation['attestation'];require(all(actual[k]==v for k,v in {**point,'receipt':ident,'kind':kind,'amount':p['amount'],'source':p['source'],'target':p['target']}.items()))


def release_lock(p,execution,allow_closed=False):
 lock=ROOT/('unresolved-'+sha((p['network']+'/'+p['source']).encode())+'.json')
 if not lock.exists():require(allow_closed);return
 if strict_json(protected_read(lock,16384))['execution']!=execution:require(allow_closed);return
 lock.unlink();fd=os.open(ROOT,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)


def reconcile(execution):
 """Never re-sign or re-broadcast. Close only after actual external AND native finality."""
 directory,p,a,signed,journal=execution_files(execution);require(journal['status'] in ('signed','broadcast_started','broadcast_submitted','external_finalized','settled'))
 point=final_external(p,signed,load_rpc(a,p));atomic(directory/'external-finality.json',dict(schema='uain-treasury-finality-v1',execution=execution,**point,assurance='trusted-rpc-observation'))
 if journal['status']=='settled':
  release_lock(p,execution,True)
  print(json.dumps(dict(status='settled',execution=execution,transaction_id=signed['id'])));return
 journal.update(status='external_finalized');atomic(directory/'journal.json',journal)
 kind,ident=p['intent'].split('/');keys=[intent_record_key(kind,ident),'treasury_effect/'+kind+'/'+ident,quorum_record_key(kind,ident)]
 state=state_read(a,keys)
 if state['records']['treasury_effect/'+kind+'/'+ident] is None:
  print(json.dumps(dict(status='external_finalized',execution=execution,transaction_id=signed['id'],native_settlement_pending=True)));return
 validate_closed(p,signed,state,point);journal.update(status='settled',native_settlement_height=state['height']);atomic(directory/'journal.json',journal)
 release_lock(p,execution)
 print(json.dumps(dict(status='settled',execution=execution,transaction_id=signed['id'],native_height=state['height'])))


CONTROL_FIELDS={'schema','execution','plan_sha256','genesis_sha256','state_binary_sha256','signer_binary_sha256','expires_at'}


def _validate_control(raw,a,state,wallets,now=None):
 now=time.time() if now is None else now
 require(type(a)==dict and set(a)==CONTROL_FIELDS and a['schema']=='uain-treasury-control-approval-v1' and a['genesis_sha256']==GENESIS and re.fullmatch(r'[a-f0-9]{32}',a['execution']))
 for field in ('plan_sha256','state_binary_sha256','signer_binary_sha256'):require(type(a[field])==str and HEX.fullmatch(a[field]))
 require(type(a['expires_at'])==int and now<a['expires_at']<=now+3600 and sha(raw)==a['plan_sha256'])
 p=strict_json(raw);require(set(p)=={'schema','chain_id','controller','sequence','expires_height','network','address','evidence_digest'} and p['schema']=='uain-treasury-escrow-control-v1' and p['chain_id']==CHAIN and p['controller']==GUARDIAN and p['network'] in NETWORKS and HEX.fullmatch(p['evidence_digest']))
 require(wallets[p['network']]==p['address'] and state['chain_id']==CHAIN and state['member']['id']==GUARDIAN and state['member']['licence']=='active' and state['member']['sequence']==p['sequence'] and GUARDIAN in state['records']['guardians'])
 require('guardian_epoch_current' in state['records'] and state['records']['guardian_epoch_current'] is None)
 height=number(state['height'],2**63-1);expires=number(p['expires_height'],2**63-1);require(height+10<expires<=height+720 and number(p['sequence'],2**64-1)<=2**64-3)
 activation=state['records']['funding_activation'];require(activation['policy']=='external-receipts-80-15-5-v1' and 2<=number(activation['height'])<=height)
 prefix=p['network']+'/'+p['address'];require('treasury_escrow/'+prefix in state['records'] and state['records']['treasury_escrow/'+prefix] is None)
 request=state['records']['treasury_escrow_request/'+prefix];require(request is None or number(request['expires_height'])<height)
 return p


def validate_control(raw,a,state,wallets,now=None):
 try:return _validate_control(raw,a,state,wallets,now)
 except (KeyError,TypeError,IndexError,OverflowError):raise ValueError('Malformed treasury control refused') from None


def guardian_envelopes(custody,commands):
 require(len(commands)==2 and [c['operation'] for c in commands]==['treasury_escrow_bind','treasury_escrow_approve'])
 for c in commands:require(c['member']==GUARDIAN and c['chain_id']==CHAIN and set(c)==native.FIELDS)
 require(number(commands[1]['sequence'])==number(commands[0]['sequence'])+1 and commands[0]['expires_height']==commands[1]['expires_height'])
 key=strict_json(custody.attachment(custody.vault(),'keys/uain-review-key.json'))
 require(type(key.get('private_key'))==str and re.fullmatch(r'[A-Za-z0-9_-]{43}',key['private_key']))
 seed=bytearray(base64.urlsafe_b64decode(key['private_key']+'='))
 try:
  public,sign=native.ed25519(bytes(seed));encoded=base64.urlsafe_b64encode(public).decode().rstrip('=')
  require(encoded==key['public_key']==GUARDIAN_PUBLIC and 'uain1'+sha(public)[:40]==GUARDIAN)
  return [dict(command=c,public_key=encoded,signature=base64.urlsafe_b64encode(sign(native.signing_bytes(c))).decode().rstrip('=')) for c in commands]
 finally:
  for i in range(len(seed)):seed[i]=0


def control_approved(custody,execution):
 require(os.geteuid()==0 and re.fullmatch(r'[a-f0-9]{32}',execution));os.umask(0o077);resource.setrlimit(resource.RLIMIT_CORE,(0,0))
 directory=ROOT/'control'/execution;raw=protected_read(directory/'plan.json',16384);a=strict_json(protected_read(directory/'approval.json',16384));require(a['execution']==execution)
 # No request field chooses a native member, key, executable or RPC destination.
 p=strict_json(raw);require(p.get('network') in NETWORKS and type(p.get('address'))==str and len(p['address'])<=44)
 prefix=p['network']+'/'+p['address'];keys=['guardians','guardian_epoch_current','funding_activation','treasury_escrow/'+prefix,'treasury_escrow_request/'+prefix]
 state=state_read(a,keys);wallets=strict_json(protected_read(ROOT/'wallets.json',16384));require(wallets['schema']=='uain-dedicated-treasury-wallets-v1')
 p=validate_control(raw,a,state,wallets['addresses']);binary=pinned_binary('treasury',a['signer_binary_sha256'])
 jpath=directory/'journal.json';jpending=directory/'journal.json.pending'
 if jpath.exists() or jpending.exists():
  # An unknown external control signature cannot transfer funds. Reconstruct
  # only the same native sequence/consent after explicit fresh root approval;
  # native absence, current guardian and external key ownership are rechecked.
  retry=strict_json(protected_read(directory/'retry-approval.json',16384))
  require(set(retry)=={'schema','execution','plan_sha256','signer_binary_sha256','expires_at'} and retry['schema']=='uain-treasury-control-retry-v1' and retry['execution']==execution and retry['plan_sha256']==sha(raw) and retry['signer_binary_sha256']==a['signer_binary_sha256'] and type(retry['expires_at'])==int and time.time()<retry['expires_at']<=time.time()+3600)
  require(not (directory/'signed.json').exists() and not (directory/'signed.json.pending').exists())
  previous=strict_json(protected_read(jpath if jpath.exists() else jpending,16384));require(previous['status']=='started' and previous['execution']==execution and previous['plan_sha256']==sha(raw))
  if jpending.exists():
   require(strict_json(protected_read(jpending,16384))==previous);os.replace(jpending,jpath);directory_sync(directory)
 else:start_journal(jpath,dict(execution=execution,plan_sha256=a['plan_sha256'],native_height=state['height'],starting_event=state['event_count']))
 initial=strict_json(protected_read(jpath,16384))
 seed=bytearray(custody.attachment(custody.vault(),SEEDS[p['network']]))
 try:signed=run_signer(binary,'control',p,seed)
 finally:
  for i in range(len(seed)):seed[i]=0
 require(signed['network']==p['network'] and signed['address']==p['address'] and set(signed)=={'network','address','signature'})
 common=dict(version=1,chain_id=CHAIN,member=GUARDIAN,expires_height=p['expires_height'])
 bind=dict(**common,sequence=p['sequence'],operation='treasury_escrow_bind',payload=dict(network=p['network'],address=p['address'],expires_height=p['expires_height'],signature=signed['signature'],evidence_digest=p['evidence_digest']))
 approve=dict(**common,sequence=str(number(p['sequence'])+1),operation='treasury_escrow_approve',payload=dict(network=p['network'],address=p['address'],controller=GUARDIAN,evidence_digest=p['evidence_digest']))
 envelopes=guardian_envelopes(custody,[bind,approve]);atomic(directory/'signed.json',dict(schema='uain-treasury-control-envelopes-v1',execution=execution,plan_sha256=a['plan_sha256'],envelopes=envelopes))
 receipt=dict(status='signed',execution=execution,plan_sha256=a['plan_sha256'],signed_sha256=sha(protected_read(directory/'signed.json',16384)),starting_event=initial['starting_event'],native_height=initial['native_height'],private_keys_exported=False)
 atomic(directory/'journal.json',receipt);print(json.dumps(receipt))


def verify_control_envelopes(p,signed):
 require(type(signed)==dict and set(signed)=={'schema','execution','plan_sha256','envelopes'} and type(signed['envelopes'])==list and len(signed['envelopes'])==2)
 common=dict(version=1,chain_id=CHAIN,member=GUARDIAN,expires_height=p['expires_height'])
 external=signed['envelopes'][0]['command']['payload']['signature'];require(type(external)==str and 64<=len(external)<=132)
 commands=[dict(**common,sequence=p['sequence'],operation='treasury_escrow_bind',payload=dict(network=p['network'],address=p['address'],expires_height=p['expires_height'],signature=external,evidence_digest=p['evidence_digest'])),dict(**common,sequence=str(number(p['sequence'])+1),operation='treasury_escrow_approve',payload=dict(network=p['network'],address=p['address'],controller=GUARDIAN,evidence_digest=p['evidence_digest']))]
 public=base64.urlsafe_b64decode(GUARDIAN_PUBLIC+'=')
 for envelope,command in zip(signed['envelopes'],commands):
  require(type(envelope)==dict and set(envelope)=={'command','public_key','signature'} and envelope['command']==command and envelope['public_key']==GUARDIAN_PUBLIC and type(envelope['signature'])==str and re.fullmatch(r'[A-Za-z0-9_-]{86}',envelope['signature']))
  signature=base64.urlsafe_b64decode(envelope['signature']+'==');require(base64.urlsafe_b64encode(signature).decode().rstrip('=')==envelope['signature'])
  try:
   from Cryptodome.Signature import eddsa
  except ImportError:
   from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
   Ed25519PublicKey.from_public_bytes(public).verify(signature,native.signing_bytes(command))
  else:eddsa.new(eddsa.import_public_key(public),'rfc8032').verify(native.signing_bytes(command),signature)


def control_public_artifact(directory,execution):
 raw=protected_read(directory/'plan.json',16384);p=strict_json(raw);a=strict_json(protected_read(directory/'approval.json',16384));path=directory/'signed.json';pending=directory/'signed.json.pending'
 signed_raw=protected_read(path if path.exists() else pending,16384);signed=strict_json(signed_raw)
 require(a['genesis_sha256']==GENESIS and signed['execution']==a['execution']==execution and sha(raw)==a['plan_sha256']==signed['plan_sha256'] and signed['schema']=='uain-treasury-control-envelopes-v1')
 require(p['chain_id']==CHAIN and p['controller']==GUARDIAN and p['schema']=='uain-treasury-escrow-control-v1' and p['network'] in NETWORKS)
 verify_control_envelopes(p,signed)
 if pending.exists():
  require(strict_json(protected_read(pending,16384))==signed)
  if path.exists():pending.unlink()
  else:os.replace(pending,path)
  directory_sync(directory)
 signed_raw=protected_read(path,16384);jpath=directory/'journal.json';jpending=directory/'journal.json.pending';journal=strict_json(protected_read(jpath if jpath.exists() else jpending,16384))
 if jpending.exists():
  candidate=strict_json(protected_read(jpending,16384));require(candidate['execution']==execution and candidate['plan_sha256']==a['plan_sha256'])
  for field in ('starting_event','native_height'):require(candidate[field]==journal[field])
  require(candidate['status']==journal['status'] or (journal['status'],candidate['status']) in (('started','signed'),('signed','registration_started'),('registration_started','registration_started'),('registration_started','registered'),('signed','registered')))
  if candidate['status']!='started':require(candidate['signed_sha256']==sha(signed_raw))
  os.replace(jpending,jpath);directory_sync(directory);journal=candidate
 require(journal['execution']==execution and journal['plan_sha256']==a['plan_sha256'])
 if journal['status']=='started':
  journal.update(status='signed',signed_sha256=sha(signed_raw),private_keys_exported=False,public_artifact_repaired_at=int(time.time()));atomic(jpath,journal)
 require(journal['status'] in ('signed','registration_started','registered'))
 return raw,p,a,signed_raw,signed,journal


def register(execution):
 require(os.geteuid()==0 and re.fullmatch(r'[a-f0-9]{32}',execution));directory=ROOT/'control'/execution
 raw,p,a,signed_raw,signed,journal=control_public_artifact(directory,execution)
 require(signed['schema']=='uain-treasury-control-envelopes-v1' and signed['execution']==a['execution']==execution and sha(raw)==a['plan_sha256']==signed['plan_sha256']==journal['plan_sha256'] and sha(signed_raw)==journal['signed_sha256'] and len(signed['envelopes'])==2)
 prefix=p['network']+'/'+p['address'];keys=['guardians','guardian_epoch_current','treasury_escrow/'+prefix,'treasury_escrow_request/'+prefix];rpc=rpc_client('http://127.0.0.1:26667')
 def matches(record,approved=False):
  require(type(record)==dict and record['network']==p['network'] and record['address']==p['address'] and record['controller']==GUARDIAN and record['sequence']==p['sequence'] and record['expires_height']==p['expires_height'] and record['evidence_digest']==p['evidence_digest'] and record['signature']==signed['envelopes'][0]['command']['payload']['signature'])
  if approved:require(record['guardian']==GUARDIAN and record['approval_evidence']==p['evidence_digest'])
 for i,envelope in enumerate(signed['envelopes']):
  state=state_read(a,keys);require('guardian_epoch_current' in state['records'] and state['records']['guardian_epoch_current'] is None);record=state['records']['treasury_escrow/'+prefix]
  if record is not None:matches(record,True);break
  request=state['records']['treasury_escrow_request/'+prefix]
  if i==0 and request is not None and request.get('sequence')==p['sequence']:matches(request);continue
  if i==1:matches(request)
  require(state['chain_id']==CHAIN and state['member']['id']==GUARDIAN and state['member']['licence']=='active' and GUARDIAN in state['records']['guardians'] and state['member']['sequence']==envelope['command']['sequence'] and number(state['height'])<number(p['expires_height']))
  journal.update(status='registration_started',next_command=i);atomic(directory/'journal.json',journal)
  result=rpc('broadcast_tx_commit',{'tx':base64.b64encode(json.dumps(envelope,separators=(',',':')).encode()).decode()})
  require(result['check_tx']['code']==0 and result.get('tx_result',result.get('deliver_tx',{})).get('code')==0)
 state=state_read(a,keys);matches(state['records']['treasury_escrow/'+prefix],True);journal.update(status='registered',native_height=state['height']);atomic(directory/'journal.json',journal)
 print(json.dumps(dict(status='registered',execution=execution,network=p['network'],address=p['address'],native_height=state['height'])))


def failed_external(p,signed,journal,rpc):
 """Prove the retained signed transaction cannot subsequently move value."""
 txid=signed['id']
 if p['network'].startswith('ethereum:'):
  require(hex_number(rpc('eth_chainId',[]))==int(p['network'].split(':')[1]))
  tx=rpc('eth_getTransactionByHash',[txid]);receipt=rpc('eth_getTransactionReceipt',[txid])
  require(tx['hash']==receipt['transactionHash']==txid and tx['from'].lower()==p['source'] and hex_number(tx['nonce'])==number(p['nonce']) and hex_number(receipt['status'])==0)
  require(tx['blockNumber']==receipt['blockNumber'] and tx['blockHash']==receipt['blockHash'])
  head=rpc('eth_getBlockByNumber',['finalized',False]);require(hex_number(head['number'])>=hex_number(receipt['blockNumber']) and abs(time.time()-hex_number(head['timestamp']))<=120)
  for _ in range(2):
   block=rpc('eth_getBlockByNumber',[receipt['blockNumber'],False]);require(block['hash']==receipt['blockHash'] and block['transactions'][hex_number(receipt['transactionIndex'])]==txid)
  require(rpc('eth_getTransactionReceipt',[txid])==receipt and hex_number(rpc('eth_getTransactionCount',[p['source'],'finalized']))>number(p['nonce']) and hex_number(rpc('eth_chainId',[]))==int(p['network'].split(':')[1]))
  return dict(status='failed_finalized',transaction=txid,block=str(hex_number(receipt['blockNumber'])),block_hash=receipt['blockHash'])
 require(rpc('getGenesisHash',[])==SOLANA_GENESIS)
 slot=rpc('getSlot',[{'commitment':'finalized'}]);require(type(slot)==int and abs(time.time()-rpc('getBlockTime',[slot]))<=120)
 status=rpc('getSignatureStatuses',[[txid],{'searchTransactionHistory':True}])['value'][0]
 if status is not None:
  require(status['err'] is not None and status['confirmationStatus']=='finalized' and type(status['slot'])==int and slot>=status['slot'])
  tx=rpc('getTransaction',[txid,{'commitment':'finalized','encoding':'base64','maxSupportedTransactionVersion':1}]);require(tx['meta']['err'] is not None and tx['slot']==status['slot'] and tx['transaction']==[signed['transaction'],'base64'])
  params=[status['slot'],{'commitment':'finalized','transactionDetails':'signatures','rewards':False,'maxSupportedTransactionVersion':1}];block=rpc('getBlock',params);require(txid in block['signatures'])
  again=rpc('getBlock',params);require(again['blockhash']==block['blockhash'] and txid in again['signatures'])
  final=rpc('getSignatureStatuses',[[txid],{'searchTransactionHistory':True}])['value'][0];require(final['err'] is not None and final['confirmationStatus']=='finalized' and final['slot']==status['slot'])
  return dict(status='failed_finalized',transaction=txid,block=str(status['slot']),block_hash=block['blockhash'])
 last=journal['external_context']['solana_last_valid_block_height'];require(type(last)==int and last>=0)
 require(rpc('getBlockHeight',[{'commitment':'finalized'}])>last and rpc('isBlockhashValid',[p['recent_blockhash'],{'commitment':'finalized'}])['value'] is False)
 require(rpc('getTransaction',[txid,{'commitment':'finalized','encoding':'base64','maxSupportedTransactionVersion':1}]) is None)
 require(rpc('getSignatureStatuses',[[txid],{'searchTransactionHistory':True}])['value'][0] is None and rpc('getGenesisHash',[])==SOLANA_GENESIS)
 return dict(status='expired_unbroadcastable',transaction=txid,expired_after_block_height=str(last))


def recover(execution):
 """Fresh root-approved recovery only after finalized failure/expired SOL wire.

A missing EVM reply/transaction is NEVER sufficient. No cancellation transaction,
new signature, liability debit, fee deduction from beneficiaries or broadcast.
"""
 directory,p,a,signed,journal=execution_files(execution)
 if journal['status'] in ('failed_finalized','expired_unbroadcastable'):
  point=strict_json(protected_read(directory/'failure-finality.json',16384));require(point['execution']==execution and point['transaction']==signed['id'] and point['status']==journal['status'])
  release_lock(p,execution,True);print(json.dumps(dict(status=journal['status'],execution=execution,transaction_id=signed['id'],intent_unchanged=True,liability_debited=False)));return
 require(journal['status'] in ('signed','broadcast_started','broadcast_submitted'))
 r=strict_json(protected_read(directory/'recovery-approval.json',16384));fields={'schema','execution','plan_sha256','signed_sha256','intent_sha256','liability_sha256','expires_at'}
 require(set(r)==fields and r['schema']=='uain-treasury-recovery-approval-v1' and r['execution']==execution and r['plan_sha256']==a['plan_sha256'] and r['signed_sha256']==journal['signed_sha256'] and r['intent_sha256']==a['intent_sha256'] and HEX.fullmatch(r['liability_sha256']))
 require(type(r['expires_at'])==int and time.time()<r['expires_at']<=time.time()+3600)
 # This renewed approval authorizes only lock release for a still-identical
 # pending native intent. It cannot authorize signing or extend the old wire.
 fresh=dict(a,expires_at=r['expires_at'],liability_sha256=r['liability_sha256']);raw=protected_read(directory/'plan.json',65536);wallets=strict_json(protected_read(ROOT/'wallets.json',16384))['addresses'];state=transfer_state(a,p);validate_transfer(raw,fresh,state,wallets)
 point=failed_external(p,signed,journal,load_rpc(a,p));state=transfer_state(a,p);validate_transfer(raw,fresh,state,wallets)
 atomic(directory/'failure-finality.json',dict(schema='uain-treasury-no-effect-recovery-v1',execution=execution,**point,assurance='trusted-rpc-observation',native_height=state['height']))
 journal.update(status=point['status'],native_recovery_height=state['height']);atomic(directory/'journal.json',journal)
 release_lock(p,execution)
 print(json.dumps(dict(status=point['status'],execution=execution,transaction_id=signed['id'],intent_unchanged=True,liability_debited=False)))

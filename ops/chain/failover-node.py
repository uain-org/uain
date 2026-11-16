#!/usr/bin/python3 -I
"""Fixed-profile stopped signer recovery. Never unfences the source signer."""
import datetime
import hashlib
import importlib.util
import json
import os
import pwd
import grp
from pathlib import Path
import re
import resource
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('uain_failover_crypto',HERE.parent/'reset/archive.py')
crypto=importlib.util.module_from_spec(spec);spec.loader.exec_module(crypto)
crypto.MAGIC=b'UAINFAILOVER01'
HEX=re.compile(r'^[a-f0-9]{64}$')
FIELDS={'host','unit','unit_sha256','home','binary','binary_sha256','genesis_sha256','chain_id','rpc_port','p2p_port','p2p_ip','root','service_user','service_group'}


def sha(path):
 h=hashlib.sha256()
 with Path(path).open('rb') as stream:
  while value:=stream.read(1024*1024):h.update(value)
 return h.hexdigest()


def atomic(path,value):
 path=Path(path);temporary=path.with_name(path.name+'.pending-'+uuid.uuid4().hex)
 with temporary.open('x') as output:
  os.chmod(temporary,0o600);json.dump(value,output,sort_keys=True);output.write('\n');output.flush();os.fsync(output.fileno())
 os.replace(temporary,path);fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)


def sync_directory(path):
 fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)


def tree(root):
 root=Path(root);h=hashlib.sha256();size=0;count=0
 for path in sorted(root.rglob('*')):
  if path.is_symlink() or not(path.is_dir() or path.is_file()):raise ValueError('Unsafe node state entry')
  h.update((str(path.relative_to(root))+'\0'+str(path.stat().st_mode&0o777)+'\0').encode())
  if path.is_file():
   if path.stat().st_nlink!=1:raise ValueError('Hardlinked node state refused')
   count+=1;size+=path.stat().st_size;h.update(bytes.fromhex(sha(path)))
 return dict(sha256=h.hexdigest(),files=count,bytes=size)


def validate_profile(p):
 if set(p)!=FIELDS:raise ValueError('Exact reviewed failover profile required')
 if p['host'] not in ('uain-app-1','uain-db-1') or p['p2p_ip']!={'uain-app-1':'10.98.0.1','uain-db-1':'10.98.0.2'}[p['host']]:raise ValueError('Reviewed private host required')
 for name in ('unit_sha256','binary_sha256','genesis_sha256'):
  if not isinstance(p[name],str) or not HEX.fullmatch(p[name]):raise ValueError('Exact artifact pins required')
 if p['service_user']!='uain-chain' or p['service_group']!='uain-chain':raise ValueError('Exact unprivileged node service identity required')
 fixture=p['unit']=='uain-failover-fixture-20261012.service'
 if fixture:
  if p['chain_id']!='uain-failover-fixture-20261012' or p['home']!='/opt/uain-test/failover-20261012/node' or p['binary']!='/opt/uain-test/failover-20261012/uaind' or p['root']!='/opt/uain-test/failover-20261012/evidence' or (p['rpc_port'],p['p2p_port'])!=(38657,38656):raise ValueError('Exact fictional fixture scope required')
 else:
  if p['unit']!='uain-chain-shadow.service' or not re.fullmatch(r'/var/lib/uain-chain/[a-z0-9_-]{1,64}',p['home']) or p['binary']!='/opt/uain-chain/releases/'+p['binary_sha256']+'/uaind' or p['root']!='/var/lib/uain-failover' or p['chain_id']!='uain-shadow-20261008-1' or (p['rpc_port'],p['p2p_port'])!=(26667,26666):raise ValueError('Exact original-node scope required')
 return p


def check_checkpoint(expected,actual):
 if set(expected)!={'chain_id','height','block_hash','app_hash','genesis_sha256'} or expected!=actual or type(expected['height'])!=int or expected['height']<1:raise ValueError('Exact finalized checkpoint required')


def require_live_fence(proof,manifest,now=None):
 now=time.time() if now is None else now
 if not isinstance(proof,dict) or proof.get('fenced') is not True:raise ValueError('Reachable persistently fenced source required; provider recovery requires separate review')
 if type(proof.get('observed_at')) not in (int,float) or not 0<=now-proof['observed_at']<=60:raise ValueError('Fresh source fencing proof required')
 for field in ('source_host','fence_id','tree','signing_state','inventory','checkpoint'):
  if proof.get(field)!=manifest.get(field):raise ValueError('Source fencing proof differs from stopped capsule')


class Node:
 def __init__(self,profile):
  path=Path(profile)
  if os.geteuid()!=0 or path.is_symlink() or path.resolve()!=path or path.stat().st_uid!=0 or path.stat().st_mode&0o077:raise ValueError('Root-owned private profile required')
  self.profile=path
  self.p=validate_profile(json.loads(path.read_text()))
  if socket.gethostname().split('.')[0]!=self.p['host']:raise ValueError('Wrong failover host')
  self.home=Path(self.p['home']);self.root=Path(self.p['root']);self.unit_file=Path('/etc/systemd/system')/self.p['unit']
  if self.home.resolve()!=self.home or Path(self.p['binary']).resolve()!=Path(self.p['binary']):raise ValueError('Redirected node scope')
  self.root.mkdir(mode=0o700,parents=True,exist_ok=True)
  if self.root.resolve()!=self.root or self.root.stat().st_uid!=0 or self.root.stat().st_mode&0o077:raise ValueError('Private failover evidence directory required')
  self.original_unit=self.root/'original-unit.service'
  if sha(self.p['binary'])!=self.p['binary_sha256']:raise ValueError('Daemon pin differs')

 def run(self,args):
  result=subprocess.run(args,capture_output=True,timeout=180)
  if result.returncode:raise ValueError('Fixed-scope operation failed')
  return result.stdout.decode().strip()

 def system_state(self):
  values=self.run(['systemctl','show',self.p['unit'],'-p','MainPID','-p','ActiveState'])
  result=dict(line.split('=',1) for line in values.splitlines());return dict(active=result['ActiveState'],pid=int(result['MainPID']))

 def matching_processes(self):
  found=[]
  for path in Path('/proc').glob('[0-9]*/cmdline'):
   try:args=path.read_bytes().split(b'\0')
   except (FileNotFoundError,PermissionError,ProcessLookupError):continue
   home=self.p['home'].encode()
   if home in args or b'--home='+home in args:found.append(int(path.parent.name))
  return found

 def listening_ports(self):
  values=self.run(['ss','-H','-lntup']);return [port for port in (self.p['rpc_port'],self.p['p2p_port']) if re.search(r':'+str(port)+r'(?:\s|$)',values)]

 def assert_fenced(self):
  if not self.unit_file.is_symlink() or os.readlink(self.unit_file)!='/dev/null':raise ValueError('Persistent source mask required')
  state=self.system_state()
  if state['active'] not in ('inactive','failed') or state['pid']!=0 or self.matching_processes() or self.listening_ports():raise ValueError('Signer PID/process/ports not fenced')

 def inventory(self):
  unit=self.original_unit if self.unit_file.is_symlink() and os.readlink(self.unit_file)=='/dev/null' else self.unit_file
  if unit.is_symlink() or sha(unit)!=self.p['unit_sha256']:raise ValueError('Reviewed service pin differs')
  text=unit.read_text()
  if not re.search(r'^User='+re.escape(self.p['service_user'])+r'$',text,re.M) or not re.search(r'^Group='+re.escape(self.p['service_group'])+r'$',text,re.M):raise ValueError('Exact unprivileged service identity required')
  if not re.search(r'^ExecStart='+re.escape(self.p['binary'])+r' start --home '+re.escape(str(self.home))+r'$',text,re.M) or not re.search(r'^WorkingDirectory='+re.escape(str(self.home))+r'$',text,re.M):raise ValueError('Reviewed daemon/home service required')
  genesis=self.home/'config/genesis.json'
  if sha(genesis)!=self.p['genesis_sha256'] or json.loads(genesis.read_text())['chain_id']!=self.p['chain_id']:raise ValueError('Genesis pin differs')
  return dict(profile_sha256=sha(self.profile),**{name:self.p[name] for name in ('host','unit','home','binary_sha256','unit_sha256','genesis_sha256','chain_id','service_user','service_group')})

 def rpc(self,method,params=None):
  request=urllib.request.Request('http://127.0.0.1:'+str(self.p['rpc_port']),data=json.dumps(dict(jsonrpc='2.0',id=1,method=method,params=params or {})).encode(),headers={'Content-Type':'application/json'})
  with urllib.request.urlopen(request,timeout=5) as response:value=json.load(response)
  if 'error' in value:raise ValueError('Node RPC refused checkpoint')
  return value['result']

 def checkpoint(self,height=None):
  if height is None:height=int(self.rpc('status')['sync_info']['latest_block_height'])
  if type(height)!=int or height<1:raise ValueError('Committed block checkpoint required')
  block=self.rpc('block',dict(height=str(height)));header=block['block']['header']
  if header['chain_id']!=self.p['chain_id'] or int(header['height'])!=height:raise ValueError('Checkpoint chain/height differs')
  return dict(chain_id=header['chain_id'],height=height,block_hash=block['block_id']['hash'].lower(),app_hash=header['app_hash'].lower(),genesis_sha256=self.p['genesis_sha256'])

 def require_single_signer(self,home,signer):
  genesis=json.loads((Path(home)/'config/genesis.json').read_text());validators=genesis.get('validators',[])
  own=json.loads((Path(home)/'config/priv_validator_key.json').read_text())['address'].lower()
  if len(validators)!=1 or (own==validators[0]['address'].lower())!=signer:raise ValueError('Reviewed one-validator/source and nonvalidator/destination roles required')

 def signing_state(self):
  path=self.home/'data/priv_validator_state.json';state=json.loads(path.read_text());height=int(state['height'])
  if height<0:raise ValueError('Invalid signing state')
  return dict(sha256=sha(path),height=height,round=int(state['round']),step=int(state['step']))

 def preview(self):return dict(inventory=self.inventory(),checkpoint=self.checkpoint(),will_stop=self.p['unit'],will_persistently_mask=True,source_will_not_restart=True)

 def mask(self):
  self.run(['systemctl','stop',self.p['unit']])
  if not self.unit_file.is_symlink():
   if self.original_unit.exists() or sha(self.unit_file)!=self.p['unit_sha256']:raise ValueError('Original unit already retained or changed')
   os.replace(self.unit_file,self.original_unit);os.symlink('/dev/null',self.unit_file)
  if os.readlink(self.unit_file)!='/dev/null':raise ValueError('Unexpected unit redirect')
  sync_directory(self.root);sync_directory(self.unit_file.parent)
  self.run(['systemctl','daemon-reload']);self.assert_fenced()

 def fence(self,checkpoint):
  self.inventory();self.require_single_signer(self.home,True);check_checkpoint(checkpoint,self.checkpoint(checkpoint['height']))
  if (self.root/'fence.json').exists():raise ValueError('Source already fenced; use retained proof')
  self.mask();self.inventory()
  receipt=dict(fenced=True,source_host=self.p['host'],fence_id=uuid.uuid4().hex,checkpoint=checkpoint,inventory=self.inventory(),tree=tree(self.home),signing_state=self.signing_state(),created_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
  atomic(self.root/'fence.json',receipt);return self.fence_proof()

 def fence_proof(self):
  self.assert_fenced();self.inventory();receipt=json.loads((self.root/'fence.json').read_text())
  if tree(self.home)!=receipt['tree'] or self.signing_state()!=receipt['signing_state']:raise ValueError('Stopped signer state changed')
  return {**receipt,'observed_at':time.time()}

 def archive_path(self,name):
  if not re.fullmatch(r'failover-[a-f0-9]{32}\.nodebk',name):raise ValueError('Exact failover capsule name required')
  path=self.root/name
  if path.is_symlink():raise ValueError('Redirected failover capsule')
  return path

 def export(self,key):
  crypto.key_bytes(key);receipt=self.fence_proof();name='failover-'+receipt['fence_id']+'.nodebk';path=self.archive_path(name)
  if path.exists():raise ValueError('Immutable failover capsule already exists')
  with tempfile.TemporaryDirectory(prefix='capsule-',dir=self.root) as tmp:
   manifest=Path(tmp)/'manifest.json';atomic(manifest,receipt)
   process=subprocess.Popen(['tar','--one-file-system','-czf','-','-C',str(self.home.parent),self.home.name,'-C',tmp,'manifest.json'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
   try:
    result=crypto.seal(process.stdout,path,key)
    if process.wait()!=0 or self.fence_proof()['tree']!=receipt['tree']:raise ValueError('Stopped capture changed')
   except BaseException:path.unlink(missing_ok=True);raise
   finally:
    if process.poll() is None:process.kill();process.wait()
    process.stdout.close()
  result.update(name=name,source=receipt);atomic(path.with_suffix('.json'),result);return result

 def restore(self,name,key,expected_sha256):
  path=self.archive_path(name)
  if sha(path)!=expected_sha256:raise ValueError('Capsule ciphertext differs')
  receipt=crypto.verify(path,key)
  if (self.root/'restore.json').exists():raise ValueError('Destination already restored')
  # Authenticate and validate in a fresh private directory before stopping or
  # replacing any existing destination. No unauthenticated bytes are extracted.
  with tempfile.TemporaryDirectory(prefix='restore-',dir=self.root) as tmp:
   unpacked=Path(tmp)/'unpacked';crypto.unpack(path,key,unpacked)
   source=json.loads((unpacked/'manifest.json').read_text());source_home=Path(source['inventory']['home'])
   if set(p.name for p in unpacked.iterdir())!={source_home.name,'manifest.json'} or source['source_host']==self.p['host'] or source['source_host'] not in ('uain-app-1','uain-db-1') or source['inventory']['binary_sha256']!=self.p['binary_sha256'] or source['inventory']['genesis_sha256']!=self.p['genesis_sha256'] or source['checkpoint']['chain_id']!=self.p['chain_id'] or name!='failover-'+source['fence_id']+'.nodebk':raise ValueError('Wrong source recovery capsule')
   restored=unpacked/source_home.name
   if tree(restored)!=source['tree'] or sha(restored/'data/priv_validator_state.json')!=source['signing_state']['sha256']:raise ValueError('Restored highest signing state/tree differs')
   self.require_single_signer(restored,True);self.require_single_signer(self.home,False)
   self.inventory();self.mask()
   previous=self.root/'previous-fullnode'
   if previous.exists():raise ValueError('Previous destination already retained')
   os.replace(self.home,previous);os.replace(restored,self.home)
   # The complete original tree was checked above. Only network transport
   # bindings change; key/signing state, ledger, database and WAL stay intact.
   config=self.home/'config/config.toml';text=config.read_text()
   text=re.sub(r'^laddr = "tcp://[^\"]+:([0-9]+)"$',lambda m:'laddr = "tcp://'+('127.0.0.1:'+str(self.p['rpc_port']) if int(m[1])==self.p['rpc_port'] else self.p['p2p_ip']+':'+str(self.p['p2p_port']))+'"',text,flags=re.M)
   text=re.sub(r'^persistent_peers = .*$', 'persistent_peers = ""',text,flags=re.M);config.write_text(text)
   owner=self.apply_destination_owner()
   result=dict(owner=owner,name=name,ciphertext_sha256=receipt['ciphertext_sha256'],source=source,restored_tree=tree(self.home),signing_state=self.signing_state(),destination=self.p['host'],promoted=False)
   if result['signing_state']!=source['signing_state']:raise ValueError('Restored signer state changed')
   atomic(self.root/'restore.json',result);return result

 def apply_destination_owner(self):
  uid=pwd.getpwnam(self.p['service_user']).pw_uid;gid=grp.getgrnam(self.p['service_group']).gr_gid
  if uid==0 or gid==0:raise ValueError('Unprivileged destination owner required')
  for path in [self.home,*self.home.rglob('*')]:
   if path.is_symlink():raise ValueError('Redirected restored owner entry')
   os.chown(path,uid,gid,follow_symlinks=False)
  return dict(user=self.p['service_user'],group=self.p['service_group'],uid=uid,gid=gid)

 def serve_fence(self,request):
  if not re.fullmatch(r'[a-f0-9]{64}',request['nonce']) or not re.fullmatch(r'[a-f0-9]{32}',request['fence_id']) or not HEX.fullmatch(request['sha256']):raise ValueError('Exact fresh fencing challenge required')
  proof=self.fence_proof();path=self.archive_path('failover-'+request['fence_id']+'.nodebk')
  if proof['fence_id']!=request['fence_id'] or sha(path)!=request['sha256']:raise ValueError('Live source capsule differs')
  return {**proof,'nonce':request['nonce'],'ciphertext_sha256':request['sha256']}

 def live_fence(self,source,ciphertext_sha256):
  source_host=source['source_host']
  if source_host==self.p['host'] or source_host not in ('uain-app-1','uain-db-1'):raise ValueError('Distinct authenticated source host required')
  fixture=self.p['unit']=='uain-failover-fixture-20261012.service'
  credentials=Path('/opt/uain-test/failover-20261012') if fixture else Path('/etc/uain-failover')
  key=credentials/(source_host+'_ed25519');known=credentials/'known_hosts'
  for path in (key,known):
   if path.is_symlink() or path.stat().st_uid!=0 or path.stat().st_mode&0o077:raise ValueError('Root-owned fixed SSH capability required')
  nonce=os.urandom(32).hex();request=dict(nonce=nonce,fence_id=source['fence_id'],sha256=ciphertext_sha256)
  ip={'uain-app-1':'10.98.0.1','uain-db-1':'10.98.0.2'}[source_host]
  command=['ssh','-F','/dev/null','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+str(known),'-o','ConnectTimeout=10','-i',str(key),'root@'+ip,'serve-fence']
  result=subprocess.run(command,input=json.dumps(request).encode(),capture_output=True,timeout=30)
  if result.returncode or len(result.stdout)>131072:raise ValueError('Live authenticated source fencing endpoint unavailable')
  proof=json.loads(result.stdout)
  if proof.get('nonce')!=nonce or proof.get('ciphertext_sha256')!=ciphertext_sha256:raise ValueError('Source fencing challenge replay or capsule mismatch')
  require_live_fence(proof,source);return proof

 def promote(self):
  self.assert_fenced();receipt=json.loads((self.root/'restore.json').read_text())
  source_proof=self.live_fence(receipt['source'],receipt['ciphertext_sha256'])
  if receipt['promoted'] or tree(self.home)!=receipt['restored_tree'] or self.signing_state()!=receipt['signing_state']:raise ValueError('Restored state changed or already promoted')
  self.inventory()
  marker=self.root/'promotion-started.json'
  if marker.exists():raise ValueError('Interrupted or previous promotion requires operator reconciliation')
  atomic(marker,dict(source_nonce=source_proof['nonce'],source_fence_id=source_proof['fence_id'],ciphertext_sha256=receipt['ciphertext_sha256'],destination=self.p['host'],started_at=datetime.datetime.now(datetime.timezone.utc).isoformat()))
  # The retained unit is immutable; removing only the destination mask is the
  # final activation boundary. A startup/checkpoint failure re-masks it.
  self.unit_file.unlink();shutil.copy2(self.original_unit,self.unit_file);sync_directory(self.unit_file.parent)
  self.run(['systemctl','daemon-reload'])
  try:
   self.run(['systemctl','start',self.p['unit']])
   deadline=time.monotonic()+90
   while time.monotonic()<deadline:
    try:
     after=self.checkpoint()
     if after['height']>max(receipt['source']['checkpoint']['height'],receipt['signing_state']['height']):break
    except Exception:pass
    time.sleep(.5)
   else:raise ValueError('Restored validator failed to continue')
   check_checkpoint(receipt['source']['checkpoint'],self.checkpoint(receipt['source']['checkpoint']['height']))
  except BaseException:
   # mask() refuses to overwrite the retained original. Put the exact reviewed
   # unit aside before reinstalling the persistent destination mask on failure.
   self.run(['systemctl','stop',self.p['unit']]);self.unit_file.unlink(missing_ok=True);os.symlink('/dev/null',self.unit_file);sync_directory(self.unit_file.parent);self.run(['systemctl','daemon-reload']);raise
  receipt.update(promoted=True,after_checkpoint=after);atomic(self.root/'restore.json',receipt);return receipt


def main():
 os.umask(0o077);resource.setrlimit(resource.RLIMIT_CORE,(0,0))
 if len(sys.argv)!=3:raise ValueError('Profile and fixed action required')
 node=Node(sys.argv[1]);action=sys.argv[2];raw=sys.stdin.buffer.read(131073)
 if len(raw)>131072:raise ValueError('Oversized request')
 p=json.loads(raw or b'{}')
 fields={'preview':set(),'fence':{'checkpoint'},'fence-proof':set(),'export':{'key'},'restore':{'name','key','sha256'},'promote':set(),'serve-fence':{'nonce','fence_id','sha256'}}
 if action not in fields or set(p)!=fields[action]:raise ValueError('Exact fixed action fields required')
 if action=='preview':result=node.preview()
 elif action=='fence':result=node.fence(p['checkpoint'])
 elif action=='fence-proof':result=node.fence_proof()
 elif action=='export':result=node.export(p['key'])
 elif action=='restore':result=node.restore(p['name'],p['key'],p['sha256'])
 elif action=='serve-fence':result=node.serve_fence(p)
 else:result=node.promote()
 print(json.dumps(result))

if __name__=='__main__':
 try:main()
 except Exception:
  print('Fixed-scope failover refused or failed; retained fences stay in place.',file=sys.stderr);sys.exit(1)

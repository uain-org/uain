#!/usr/bin/python3 -I
"""Stopped original-node 0.3.7→0.3.8 unit/profile transition; never starts nodes."""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import resource
import socket
import subprocess
import sys
import time
import types

HERE=Path(__file__).resolve().parent
sys.dont_write_bytecode=True
# Verify reviewed dependencies BEFORE executing their module bodies as root.
DEPENDENCIES={'failover-install.py':'caa2d1a26e435bc3c8d125bfd6c0c3d62628b1b41be05f491bce932626952d59','failover-node.py':'2d915f33205debbadc1e6f2e1b5e1314b408db8206864e83d34dd27a155a324e','../reset/archive.py':'e9feb4979478019ce3acbc754540ce0233f8af278eee1e9755a5fc71e762f972'}
for name,pin in DEPENDENCIES.items():
 dependency=(HERE/name).absolute();resolved=dependency.resolve()
 if os.geteuid()!=0 or dependency.parent.resolve()/dependency.name!=resolved:raise ValueError('Pinned root upgrade dependency refused')
 for path in (resolved,*resolved.parents):
  metadata=path.stat()
  if metadata.st_uid!=0 or metadata.st_mode&0o022:raise ValueError('Pinned root upgrade dependency refused')
 if resolved.stat().st_nlink!=1 or hashlib.sha256(resolved.read_bytes()).hexdigest()!=pin:raise ValueError('Pinned root upgrade dependency refused')
 # The pinned node's nested archive loader must also see only source. Root-owned
 # staging directories exclude nonroot replacement between this check and import.
 cache=resolved.parent/'__pycache__';legacy=resolved.with_suffix('.pyc')
 if cache.is_symlink() or legacy.exists() or legacy.is_symlink() or (cache.exists() and any(cache.glob(resolved.stem+'.*.pyc'))):raise ValueError('Pinned dependency bytecode cache refused')
def source_module(name,path):
 module=types.ModuleType(name);module.__file__=str(path)
 exec(compile(path.read_bytes(),str(path),'exec'),module.__dict__)
 return module
i=source_module('installed_failover',HERE/'failover-install.py')
f=source_module('failover_node',HERE/'failover-node.py')
PROFILE=Path('/etc/uain-failover/node.json');APPROVAL=Path('/etc/uain-failover/upgrade-0.3.8.json')
UNIT=Path('/etc/systemd/system/uain-chain-shadow.service');ROOT=Path('/var/lib/uain-failover-upgrade/0.3.8');EVIDENCE=Path('/var/lib/uain-failover')
MARKER=Path('/run/uain-node-backup-restart.json');CUSTODY=Path('/run/lock/uain-custody.lock');CAPTURE=Path('/run/lock/uain-node-backup-capture.lock')
OLD_DAEMON=i.DAEMON;GENESIS=i.GENESIS
FIELDS={'schema','release','old_binary_sha256','binary_sha256','genesis_sha256','helper_sha256','unit_sha256','installation_acceptance_sha256','expires_at'}
require=i.require;encode=i.encoded

def digest(raw):return hashlib.sha256(raw).hexdigest()
def read(path,private=False):
 raw=i.protected(path,256*1024*1024)
 if private:require(not Path(path).stat().st_mode&0o077)
 return raw

def sync(path):i.sync(path)
def atomic(path,data,mode=0o600):
 path=Path(path);pending=path.with_name(path.name+'.upgrade-pending')
 if pending.exists():require(read(pending)==data)
 else:
  with pending.open('xb') as stream:os.chmod(pending,mode);stream.write(data);stream.flush();os.fsync(stream.fileno())
 os.replace(pending,path);sync(path.parent)

def immutable(path,data,mode=0o600):
 if Path(path).exists():require(read(path)==data)
 else:atomic(path,data,mode)

def run(args):
 result=subprocess.run(args,capture_output=True,timeout=180);require(result.returncode==0);return result.stdout.decode().strip()

def approval():
 raw=read(APPROVAL,True);a=json.loads(raw);now=time.time()
 require(set(a)==FIELDS and a['schema']=='uain-stopped-node-upgrade-v1' and a['release']=='0.3.8' and a['old_binary_sha256']==OLD_DAEMON and a['genesis_sha256']==GENESIS)
 require(type(a['expires_at']) in (int,float) and now<a['expires_at']<=now+3600)
 require(a['helper_sha256']==digest(read(Path(__file__).resolve())))
 require(type(a['binary_sha256'])==str and i.HEX.fullmatch(a['binary_sha256']) and a['binary_sha256']!=OLD_DAEMON)
 require(type(a['unit_sha256'])==dict and set(a['unit_sha256'])==set(i.HOSTS) and all(type(v)==str and i.HEX.fullmatch(v) for v in a['unit_sha256'].values()))
 require(type(a['installation_acceptance_sha256'])==str and i.HEX.fullmatch(a['installation_acceptance_sha256']))
 plan={k:v for k,v in a.items() if k!='expires_at'};return a,plan,raw

def assert_artifacts_absent():
 require(not MARKER.exists() and not MARKER.is_symlink())
 require(EVIDENCE.is_dir() and EVIDENCE.resolve()==EVIDENCE)
 for path in EVIDENCE.iterdir():
  name=path.name
  require(not(name.startswith(('fence.json','restore.json','promotion-started.json','original-unit.service','failover-'))))

def check_install(host,old,a):
 record=i.journal();require(record['host']==host and record['profile']==old and record['profile_sha256']==digest(encode(old)))
 require(record['phase']==('accepted' if host=='uain-app-1' else 'verified'))
 if host=='uain-app-1':require(record['acceptance_sha256']==a['installation_acceptance_sha256'])
 i.installed_files(record)

def stopped_node(profile):
 # Scope/profile/genesis are independently pinned by transition. Stop proof
 # must remain available when rolling back a damaged NEW executable.
 node=f.Node.__new__(f.Node);node.p=profile;node.home=Path(profile['home']);node.unit_file=UNIT
 return node

def assert_stopped(profile):
 node=stopped_node(profile);require(node.p==profile and not node.unit_file.is_symlink())
 state=node.system_state();require(state['active']=='inactive' and state['pid']==0 and not node.matching_processes() and not node.listening_ports())
 # Only the original one-validator/source and nonvalidator/peer roles qualify.
 node.require_single_signer(node.home,profile['host']=='uain-app-1')

def assert_drained(host):
 units=['uain-node-backup-capture.service']
 if host=='uain-app-1':units+=list(i.TIMERS)+['uain-node-backup.service']
 for unit in units:
  state=dict(line.split('=',1) for line in run(['systemctl','show',unit,'-p','ActiveState','-p','MainPID']).splitlines())
  require(state.get('ActiveState')=='inactive')
  if unit.endswith('.service'):require(state.get('MainPID')=='0')

def stopped_tree(profile):return f.tree(Path(profile['home']))

def check_binary(profile):
 require(profile['binary']=='/opt/uain-chain/releases/'+profile['binary_sha256']+'/uaind')
 require(digest(read(profile['binary']))==profile['binary_sha256'] and Path(profile['binary']).stat().st_mode&0o777==0o755)

def check_genesis(profile):
 path=Path(profile['home'])/'config/genesis.json';require(path.resolve()==path and digest(path.read_bytes())==GENESIS and json.loads(path.read_bytes())['chain_id']==profile['chain_id'])

@contextlib.contextmanager
def locked():
 with CUSTODY.open('a') as custody,CAPTURE.open('a') as capture:
  for stream in (custody,capture):
   path=Path(stream.name);s=path.stat();require(path.resolve()==path and s.st_uid==0 and not s.st_mode&0o022 and s.st_nlink==1)
   fcntl.flock(stream,fcntl.LOCK_EX|fcntl.LOCK_NB)
  yield

def journal(expected):
 path=ROOT/'journal.json';pending=path.with_name(path.name+'.upgrade-pending')
 if not path.exists() and not pending.exists():return None
 value=json.loads(read(path if path.exists() else pending,True))
 def valid(v):require(set(v)==set(expected)|{'phase'} and all(v[k]==x for k,x in expected.items()) and v['phase'] in ('prepared','applied','rolled_back'))
 valid(value)
 if pending.exists():
  candidate=json.loads(read(pending,True));valid(candidate)
  require(candidate['phase']==value['phase'] or (value['phase'],candidate['phase']) in (('prepared','applied'),('prepared','rolled_back'),('applied','rolled_back')))
  os.replace(pending,path);sync(ROOT);value=candidate
 return value

def reconcile_pending(path,allowed):
 pending=path.with_name(path.name+'.upgrade-pending')
 if pending.exists():
  require(read(pending) in allowed)
  # The journal fixes both permissible byte sets. The selected transition will
  # write its exact target afresh; unknown bytes are never removed or replaced.
  pending.unlink();sync(path.parent)

def transition(host,action):
 require(os.geteuid()==0 and host in i.HOSTS and action in ('preview','apply','rollback'))
 with locked():
  a,plan,raw=approval();assert_artifacts_absent();assert_drained(host)
  current_raw=read(PROFILE,True);current=json.loads(current_raw);old=i.profile(host)
  check_install(host,old,a)
  old_raw=read(ROOT/'old-profile.json',True) if (ROOT/'old-profile.json').exists() else current_raw
  require(json.loads(old_raw)==old)
  old_unit=read(ROOT/'old-unit.service',True) if (ROOT/'old-unit.service').exists() else read(UNIT)
  require(digest(old_unit)==old['unit_sha256'])
  new=dict(old,binary='/opt/uain-chain/releases/'+a['binary_sha256']+'/uaind',binary_sha256=a['binary_sha256'],unit_sha256=a['unit_sha256'][host]);new_raw=encode(new)
  require(old_unit.count(old['binary'].encode())==1)
  new_unit=old_unit.replace(old['binary'].encode(),new['binary'].encode());require(digest(new_unit)==new['unit_sha256'])
  require(current_raw in (old_raw,new_raw) and read(UNIT) in (old_unit,new_unit))
  assert_stopped(current);check_genesis(old);check_binary(old)
  if action!='rollback':check_binary(new)
  current_tree=stopped_tree(old);state_raw=read(ROOT/'old-state.json',True) if (ROOT/'old-state.json').exists() else encode(current_tree)
  require(json.loads(state_raw)==current_tree)
  expected=dict(schema='uain-stopped-node-upgrade-journal-v1',host=host,plan_sha256=digest(encode(plan)),old_profile_sha256=digest(old_raw),new_profile_sha256=digest(new_raw),old_unit_sha256=digest(old_unit),new_unit_sha256=digest(new_unit),stopped_state_sha256=digest(state_raw))
  record=journal(expected) if ROOT.exists() else None
  if record is None:require(current_raw==old_raw and read(UNIT)==old_unit and action!='rollback')
  else:require(current_raw in (old_raw,new_raw) and read(UNIT) in (old_unit,new_unit))
  # A mixed pair is acceptable ONLY during this already-journaled stopped
  # transaction. Neither backup nor source challenge can use a mixed inventory.
  for path,allowed in ((UNIT,(old_unit,new_unit)),(PROFILE,(old_raw,new_raw))):
   pending=path.with_name(path.name+'.upgrade-pending')
   if pending.exists():require(record is not None and read(pending) in allowed)
  if action=='preview':return dict(changed=False,host=host,old_profile=old,new_profile=new,plan_sha256=expected['plan_sha256'],phase=record['phase'] if record else 'not_started',will_start=False)
  if record is not None and record['phase']=='rolled_back':
   require(action=='rollback' and current_raw==old_raw and read(UNIT)==old_unit)
   require(not any(path.with_name(path.name+'.upgrade-pending').exists() for path in (UNIT,PROFILE)))
   return dict(changed=False,phase='rolled_back',will_start=False)
  ROOT.mkdir(mode=0o700,parents=True,exist_ok=True);require(ROOT.resolve()==ROOT and ROOT.stat().st_uid==0 and not ROOT.stat().st_mode&0o077)
  immutable(ROOT/'old-state.json',state_raw);immutable(ROOT/'old-profile.json',old_raw);immutable(ROOT/'old-unit.service',old_unit);immutable(ROOT/'plan.json',encode(plan));immutable(ROOT/('approval-'+digest(raw)+'.json'),raw)
  if record is None:record=dict(expected,phase='prepared');atomic(ROOT/'journal.json',encode(record))
  for path,allowed in ((UNIT,(old_unit,new_unit)),(PROFILE,(old_raw,new_raw))):reconcile_pending(path,allowed)
  target_unit,target_profile=(new_unit,new_raw) if action=='apply' else (old_unit,old_raw)
  atomic(UNIT,target_unit,0o644);atomic(PROFILE,target_profile)
  require(read(UNIT)==target_unit and read(PROFILE,True)==target_profile)
  assert_artifacts_absent();assert_drained(host);assert_stopped(json.loads(target_profile));require(stopped_tree(old)==current_tree)
  run(['systemd-analyze','verify',str(UNIT)]);run(['systemctl','daemon-reload'])
  record['phase']='applied' if action=='apply' else 'rolled_back';atomic(ROOT/'journal.json',encode(record))
  return dict(changed=True,host=host,phase=record['phase'],profile_sha256=digest(target_profile),unit_sha256=digest(target_unit),will_start=False)

def main():
 os.umask(0o077);resource.setrlimit(resource.RLIMIT_CORE,(0,0));require(len(sys.argv)==2)
 print(json.dumps(transition(socket.gethostname().split('.')[0],sys.argv[1])))

if __name__=='__main__':
 try:main()
 except Exception:print('Stopped pinned unit/profile transition refused; keep both nodes and backup timers stopped.',file=sys.stderr);sys.exit(1)

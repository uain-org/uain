#!/usr/bin/python3 -I
"""Pinned replacement of the installed role-backup helper files.

It replaces only the files named in a root approval, each from exact reviewed
bytes, on a host whose canonical failover installation is already accepted. It
never stops, starts, fences, restores or promotes a node, never touches a node
home, key, profile, unit, SSH authority or timer, and never reads the vault.

What it may replace (and nothing else):

  ops/chain/failover-backup.py      /opt/uain-failover/ops/chain/failover-backup.py
  ops/node-backup/entry.py          /opt/uain-node-backup/entry.py
  ops/node-backup/uain-node-backup  /usr/local/sbin/uain-node-backup (app only)

With them it rewrites the three records that pin those bytes, so the forced SSH
probe and every later pinned profile upgrade still accept the installation:
/opt/uain-failover/install-files.json, the install journal's bundle digest
(and its entry.py digest) and /opt/uain-node-backup/manifest.sha256.

  upgrade-failover-helper.py preview|apply|rollback|probe <id>

The operator drains the two app backup timers first and restarts them after;
this tool refuses while a backup, a capture, a restart marker or any fence,
restore or promotion record exists. See docs/chain/failover-helper-upgrade.md.
"""
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import socket
import subprocess
import sys
import time
import types

HERE=Path(__file__).resolve().parent;BUNDLE=HERE.parents[1]
sys.dont_write_bytecode=True
# Verify the reviewed dependency BEFORE executing its module body as root.
DEPENDENCIES={'failover-install.py':'caa2d1a26e435bc3c8d125bfd6c0c3d62628b1b41be05f491bce932626952d59'}
for name,pin in DEPENDENCIES.items():
 dependency=(HERE/name).absolute();resolved=dependency.resolve()
 if os.geteuid()!=0 or dependency.parent.resolve()/dependency.name!=resolved:raise ValueError('Pinned root upgrade dependency refused')
 for path in (resolved,*resolved.parents):
  metadata=path.stat()
  if metadata.st_uid!=0 or metadata.st_mode&0o022:raise ValueError('Pinned root upgrade dependency refused')
 if resolved.stat().st_nlink!=1 or hashlib.sha256(resolved.read_bytes()).hexdigest()!=pin:raise ValueError('Pinned root upgrade dependency refused')
def source_module(name,path):
 module=types.ModuleType(name);module.__file__=str(path)
 exec(compile(path.read_bytes(),str(path),'exec'),module.__dict__)
 return module
i=source_module('installed_failover',HERE/'failover-install.py')

CONFIG=Path('/etc/uain-failover');UPGRADES=Path('/var/lib/uain-failover-upgrade');EVIDENCE=Path('/var/lib/uain-failover')
WRAPPER=Path('/usr/local/sbin/uain-node-backup')
MARKER=Path('/run/uain-node-backup-restart.json')
CUSTODY=Path('/run/lock/uain-custody.lock');CAPTURE=Path('/run/lock/uain-node-backup-capture.lock');RUN=Path('/run/lock/uain-node-backup-run.lock')
CUSTODY_WAIT_SECONDS=30
ID=re.compile(r'^[0-9]{8}-[a-z0-9][a-z0-9-]{0,39}$')
FIELDS={'schema','id','helper_sha256','files','old_bundle_sha256','bundle_sha256','expires_at'}
SCHEMA='uain-failover-helper-upgrade-v1';JOURNAL_SCHEMA='uain-failover-helper-upgrade-journal-v1'
HELPER='ops/chain/failover-backup.py';ENTRY='ops/node-backup/entry.py';WRAP='ops/node-backup/uain-node-backup'
REPLACEABLE=(HELPER,ENTRY,WRAP)
ROLES={'uain-app-1':'original_validator','uain-db-1':'original_fullnode'}
require=i.require;encode=i.encoded

def digest(raw):return hashlib.sha256(raw).hexdigest()

def read(path,private=False,limit=16*1024*1024):
 raw=i.protected(path,limit)
 if private:require(not Path(path).stat().st_mode&0o077)
 return raw

def targets(host):
 """Fixed installed path and mode of every file this tool may replace here."""
 out={HELPER:(i.CODE/HELPER,0o600),ENTRY:(i.BACKUP/'entry.py',0o600)}
 if host=='uain-app-1':out[WRAP]=(WRAPPER,0o700)
 return out

def atomic(path,data,mode,own=False):
 path=Path(path);pending=path.with_name(path.name+'.helper-upgrade-pending')
 # In this upgrade's own archive a torn pending file is simply written again.
 if own:pending.unlink(missing_ok=True)
 with pending.open('xb') as stream:
  os.chmod(pending,mode);stream.write(data);stream.flush();os.fsync(stream.fileno())
 os.replace(pending,path);i.sync(path.parent)

def immutable(path,data):
 if Path(path).exists():require(read(path,True)==data)
 else:atomic(path,data,0o600,own=True)

def reconcile_pending(path,allowed):
 """A pending file left by an interrupted write holds known bytes or refuses."""
 pending=Path(path).with_name(Path(path).name+'.helper-upgrade-pending')
 if pending.exists() or pending.is_symlink():
  require(not pending.is_symlink() and pending.read_bytes() in allowed)
  pending.unlink();i.sync(pending.parent)

def run(args,stdin=b'',timeout=180):
 result=subprocess.run(args,input=stdin,capture_output=True,timeout=timeout);require(result.returncode==0);return result.stdout.decode().strip()

def approval(ident):
 raw=read(CONFIG/('upgrade-helper-'+ident+'.json'),True,65536);a=json.loads(raw);now=time.time()
 require(type(a)==dict and set(a)==FIELDS and a['schema']==SCHEMA and a['id']==ident)
 require(type(a['expires_at']) in (int,float) and now<a['expires_at']<=now+3600)
 require(a['helper_sha256']==digest(read(Path(__file__).resolve())))
 for field in ('old_bundle_sha256','bundle_sha256'):require(type(a[field])==str and i.HEX.fullmatch(a[field]))
 files=a['files'];require(type(files)==dict and files and set(files)<=set(REPLACEABLE))
 for pins in files.values():
  require(type(pins)==dict and set(pins)=={'old','new'} and all(type(v)==str and i.HEX.fullmatch(v) for v in pins.values()) and pins['old']!=pins['new'])
 # The bundle digest changes exactly when a file the bundle pins changes.
 require((a['old_bundle_sha256']!=a['bundle_sha256'])==(HELPER in files))
 plan={k:v for k,v in a.items() if k!='expires_at'};return a,plan,raw

def assert_artifacts_absent():
 require(not MARKER.exists() and not MARKER.is_symlink())
 require(EVIDENCE.is_dir() and EVIDENCE.resolve()==EVIDENCE)
 for path in EVIDENCE.iterdir():
  require(not path.name.startswith(('fence.json','restore.json','promotion-started.json','original-unit.service','failover-')))

def assert_drained(host):
 units=['uain-node-backup-capture.service']
 if host=='uain-app-1':units+=list(i.TIMERS)+['uain-node-backup.service','uain-node-backup-check.service']
 for unit in units:
  state=dict(line.split('=',1) for line in run(['systemctl','show',unit,'-p','ActiveState','-p','MainPID']).splitlines())
  require(state.get('ActiveState')=='inactive')
  if unit.endswith('.service'):require(state.get('MainPID')=='0')

@contextlib.contextmanager
def locked():
 """The custody lock is waited for briefly (a review holds it for a second or
 two); the capture and run locks mean a backup is in flight and never wait."""
 with CUSTODY.open('a') as custody,CAPTURE.open('a') as capture,RUN.open('a') as running:
  for stream in (custody,capture,running):
   path=Path(stream.name);s=path.stat();require(path.resolve()==path and s.st_uid==0 and not s.st_mode&0o022 and s.st_nlink==1)
  fcntl.flock(capture,fcntl.LOCK_EX|fcntl.LOCK_NB);fcntl.flock(running,fcntl.LOCK_EX|fcntl.LOCK_NB)
  deadline=time.monotonic()+CUSTODY_WAIT_SECONDS
  while True:
   try:fcntl.flock(custody,fcntl.LOCK_EX|fcntl.LOCK_NB);break
   except BlockingIOError:
    require(time.monotonic()<deadline);time.sleep(0.25)
  yield

def manifest_lines(raw,name,value):
 """/opt/uain-node-backup/manifest.sha256 with exactly one file's digest changed."""
 target=str(i.BACKUP/name);lines=raw.decode().splitlines();found=0;out=[]
 for line in lines:
  parts=line.split('  ',1);require(len(parts)==2 and i.HEX.fullmatch(parts[0]))
  if parts[1]==target:found+=1;out.append(value+'  '+target)
  else:out.append(line)
 require(found==1);return ('\n'.join(out)+'\n').encode()

def preview_check(host):
 """The installed helper, run as the backup runs it, still names this host's
 original role. It reads the fixed profile and changes nothing."""
 out=run(['/usr/bin/python3','-I','-B',str(i.CODE/HELPER),'preview'],timeout=120);value=json.loads(out)
 require(value['node_role']=={'name':ROLES[host],'binding':None} and value['inventory']['host']==host)
 return value['node_role']['name']

def syntax_check(name,data):
 if name.endswith('.py'):compile(data,name,'exec',dont_inherit=True)
 else:require(subprocess.run(['/bin/sh','-n'],input=data,capture_output=True,timeout=30).returncode==0)

def drop_bytecode(path):
 cache=Path(path).parent/'__pycache__'
 if cache.is_dir() and not cache.is_symlink():
  for stale in cache.glob(Path(path).stem+'.*.pyc'):stale.unlink()

def state(host,ident):
 """Everything apply or rollback writes, as exact old and new bytes. Old bytes
 come from this upgrade's own archive once it exists, never from a guess."""
 a,plan,raw=approval(ident);root=UPGRADES/('helper-'+ident);started=root.exists()
 if started:require(root.resolve()==root and root.stat().st_uid==0 and not root.stat().st_mode&0o077)
 where=targets(host);names=[n for n in REPLACEABLE if n in a['files'] and n in where]
 require(names)
 items={}
 def item(key,path,mode,new):
  saved=root/'old'/key
  old=read(saved,True) if started and saved.exists() else read(path,True)
  items[key]=dict(path=Path(path),mode=mode,old=old,new=new)
 for name in names:
  path,mode=where[name];new=read(BUNDLE/name);require(digest(new)==a['files'][name]['new']);syntax_check(name,new)
  item(name.replace('/','__'),path,mode,new)
  require(digest(items[name.replace('/','__')]['old'])==a['files'][name]['old'])
 record_raw=read(i.JOURNAL,True);record=json.loads(record_raw)
 saved=root/'old'/'install-journal.json'
 if started and saved.exists():record_raw=read(saved,True);record=json.loads(record_raw)
 require(record['host']==host and record['phase']==('accepted' if host=='uain-app-1' else 'verified') and record['bundle_sha256']==a['old_bundle_sha256'])
 changed=dict(record)
 if HELPER in names:
  bundle=read(BUNDLE/'ops/chain/failover-install-files.json');values=json.loads(bundle)
  require(digest(bundle)==a['bundle_sha256'] and set(values)==i.FILES and values[HELPER]==a['files'][HELPER]['new'])
  item('install-files.json',i.CODE/'install-files.json',0o600,bundle)
  require(digest(items['install-files.json']['old'])==a['old_bundle_sha256'])
  before=json.loads(items['install-files.json']['old']);require(set(before)==i.FILES)
  # Only the helper's pin may differ: every other installed file is unchanged.
  require({k:v for k,v in values.items() if k!=HELPER}=={k:v for k,v in before.items() if k!=HELPER} and before[HELPER]==a['files'][HELPER]['old'])
  changed['bundle_sha256']=a['bundle_sha256']
 if ENTRY in names:
  require(record['candidate_backup_hashes']['entry.py']==a['files'][ENTRY]['old'])
  changed['candidate_backup_hashes']=dict(record['candidate_backup_hashes'],**{'entry.py':a['files'][ENTRY]['new']})
  manifest=i.BACKUP/'manifest.sha256';saved=root/'old'/'manifest.sha256'
  old=read(saved,True) if started and saved.exists() else read(manifest,True)
  items['manifest.sha256']=dict(path=manifest,mode=0o600,old=old,new=manifest_lines(old,'entry.py',a['files'][ENTRY]['new']))
 entry=dict(id=ident,plan_sha256=digest(encode(plan)),old_bundle_sha256=a['old_bundle_sha256'],bundle_sha256=a['bundle_sha256'],files={n:a['files'][n] for n in names})
 saved=root/'new-install-journal.json'
 if started and saved.exists():new_record=read(saved,True)
 else:new_record=encode(dict(changed,helper_upgrades=list(record.get('helper_upgrades',[]))+[dict(entry,applied_at=datetime.datetime.now(datetime.timezone.utc).isoformat())]))
 items['install-journal.json']=dict(path=i.JOURNAL,mode=0o600,old=record_raw,new=new_record)
 expected=dict(schema=JOURNAL_SCHEMA,host=host,id=ident,plan_sha256=digest(encode(plan)),files={key:dict(old=digest(v['old']),new=digest(v['new'])) for key,v in sorted(items.items())})
 return a,plan,raw,root,items,expected

def journal(root,expected):
 path=root/'journal.json'
 # A journal write that did not finish is repeated from the files themselves.
 path.with_name(path.name+'.helper-upgrade-pending').unlink(missing_ok=True)
 if not path.exists():return None
 value=json.loads(read(path,True));require({k:v for k,v in value.items() if k!='phase'}==expected and value['phase'] in ('prepared','applied','rolled_back'))
 return value

def write_all(items,side):
 for key,item in items.items():
  reconcile_pending(item['path'],(item['old'],item['new']))
  if item['path'].read_bytes()!=item[side]:atomic(item['path'],item[side],item['mode'])
  if item['path'].suffix=='.py':drop_bytecode(item['path'])
 for item in items.values():require(read(item['path'],True)==item[side] and item['path'].stat().st_mode&0o777==item['mode'])

def transition(host,action,ident):
 require(os.geteuid()==0 and host in i.HOSTS and action in ('preview','apply','rollback') and type(ident)==str and ID.fullmatch(ident))
 with locked():
  assert_artifacts_absent();assert_drained(host)
  a,plan,raw,root,items,expected=state(host,ident)
  record=journal(root,expected) if root.exists() else None
  current={key:item['path'].read_bytes() for key,item in items.items()}
  # Unknown bytes anywhere refuse: only exact old or exact new may be present.
  require(all(current[key] in (item['old'],item['new']) for key,item in items.items()))
  if record is None:require(action!='rollback' and all(current[key]==item['old'] for key,item in items.items()))
  if action=='preview':
   return dict(changed=False,host=host,id=ident,phase=record['phase'] if record else 'not_started',plan_sha256=expected['plan_sha256'],files=expected['files'],will_start_or_stop_any_unit=False)
  if record is not None and record['phase']=='rolled_back':
   # Terminal: a rolled-back upgrade is repeated under a new id and approval.
   require(action=='rollback' and all(current[key]==item['old'] for key,item in items.items()))
   return dict(changed=False,host=host,id=ident,phase='rolled_back')
  if record is None:
   UPGRADES.mkdir(mode=0o700,parents=True,exist_ok=True);root.mkdir(mode=0o700,exist_ok=True);(root/'old').mkdir(mode=0o700,exist_ok=True)
   require(root.resolve()==root and root.stat().st_uid==0 and not root.stat().st_mode&0o077)
   for key,item in items.items():immutable(root/'old'/key,item['old'])
   immutable(root/'new-install-journal.json',items['install-journal.json']['new'])
   immutable(root/'plan.json',encode(plan))
   record=dict(expected,phase='prepared');atomic(root/'journal.json',encode(record),0o600,own=True)
  immutable(root/('approval-'+digest(raw)+'.json'),raw)
  if action=='apply':
   try:
    write_all(items,'new')
    # The pinned installer's own check, which every later profile upgrade and
    # the forced SSH probe repeat, must accept the new installation.
    i.installed_files(i.journal());role=preview_check(host)
   except Exception:
    # A refused or failed step puts every byte back before reporting it.
    write_all(items,'old');i.installed_files(i.journal())
    record['phase']='rolled_back';atomic(root/'journal.json',encode(record),0o600,own=True)
    raise
   record['phase']='applied';atomic(root/'journal.json',encode(record),0o600,own=True)
   return dict(changed=any(current[key]!=item['new'] for key,item in items.items()),host=host,id=ident,phase='applied',bundle_sha256=a['bundle_sha256'],files={key:digest(item['new']) for key,item in sorted(items.items())},role=role,timers_left_stopped=host=='uain-app-1')
  write_all(items,'old');i.installed_files(i.journal())
  record['phase']='rolled_back';atomic(root/'journal.json',encode(record),0o600,own=True)
  return dict(changed=any(current[key]!=item['old'] for key,item in items.items()),host=host,id=ident,phase='rolled_back',bundle_sha256=a['old_bundle_sha256'],timers_left_stopped=host=='uain-app-1')

def probe(host):
 """Fresh nonce over the fixed forced SSH capability: the peer's installed
 bundle and inventory, as its own endpoint reports them. Read-only."""
 require(os.geteuid()==0 and host in i.HOSTS)
 record=i.journal();i.installed_files(record)
 peer=next(x for x in i.HOSTS if x!=host);nonce=os.urandom(32).hex()
 command=['ssh','-F','/dev/null','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+str(CONFIG/'known_hosts'),'-o','ConnectTimeout=10','-i',str(CONFIG/(peer+'_ed25519')),'root@'+i.HOSTS[peer]['ip'],'failover-probe']
 p=subprocess.run(command,input=json.dumps(dict(nonce=nonce)).encode(),capture_output=True,timeout=60);require(p.returncode==0 and len(p.stdout)<=131072);reply=json.loads(p.stdout)
 require(reply.get('nonce')==nonce and reply['inventory']['host']==peer)
 return dict(host=host,peer=peer,own_bundle_sha256=record['bundle_sha256'],peer_bundle_sha256=reply['bundle_sha256'],bundles_match=reply['bundle_sha256']==record['bundle_sha256'],peer_binary_sha256=reply['inventory']['binary_sha256'])

def main():
 os.umask(0o077);resource.setrlimit(resource.RLIMIT_CORE,(0,0));require(len(sys.argv) in (2,3))
 host=socket.gethostname().split('.')[0]
 if sys.argv[1]=='probe':require(len(sys.argv)==2);print(json.dumps(probe(host)));return
 require(len(sys.argv)==3);print(json.dumps(transition(host,sys.argv[1],sys.argv[2])))

if __name__=='__main__':
 try:main()
 except Exception:print('Pinned helper replacement refused or rolled back; keep the backup timers stopped and review the journal.',file=sys.stderr);sys.exit(1)

#!/usr/bin/python3 -I
"""Fixed-profile role-aware capture. A frozen source is never restarted.

An active validator is copied while it runs into a private staging tree, then
stopped only for a bounded final synchronisation and a stat-only proof that the
staged copy equals the stopped tree (STOPPED_COPY_DEADLINE_SECONDS). It restarts
through the guarded recovery hook before the full content hash, compression,
sealing and restore verification, which read only the immutable staged copy.

The stopped window no longer reads unchanged file content (10 November 2026),
so it stays inside the deadline as the node home grows past about 6 GB. Every
staged file records the source fingerprint taken before it was read: device,
inode, size, mtime, ctime, mode, owner and group. The node's unprivileged user
cannot set ctime, so any write, truncate, rename-over, utime or chmod after the
read changes the fingerprint and the file is copied again while stopped. A
file whose ctime is within RACY_MARGIN_NS of the walk that read it may have
been written in the same timestamp tick, so it is never trusted and is always
copied again while stopped. The stopped pass then re-walks the stopped tree and
requires every fingerprint and the exact entry set to match the staged record. Native proofs older than 120 s are refused, so a pause
over PAUSE_LIMIT_SECONDS discards the candidate and fails the capture loudly.

Locks (10 November 2026). The daily coordinator used to hold the custody lock
for its whole run, about 24 minutes, and every custody signer waited behind it.
Now three locks each cover what they protect:
- RUN_LOCK: one coordinator run at a time, held by the wrapper for the whole
  run. A fence, restore or promotion takes it without waiting, so an in-flight
  coordinator still excludes every transition, exactly as the custody lock did.
- CAPTURE_LOCK: one local capture at a time (unchanged).
- CUSTODY_LOCK: taken by the capture only from just before the stop until the
  restarted node answers again, so no custody signer reads or broadcasts into
  a stopped node, and none waits for the copy, hash, seal or transfers."""
import contextlib
import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import resource
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

HERE=Path(__file__).resolve().parent
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
f=load('uain_failover',HERE/'failover-node.py')
backup_path=HERE.parent/'node-backup/node.py'
if not backup_path.exists():backup_path=Path('/opt/uain-node-backup/node.py')
b=load('uain_role_backup',backup_path)
PROFILE=Path('/etc/uain-failover/node.json')
CUSTODY_LOCK=Path('/run/lock/uain-custody.lock')
RUN_LOCK=Path('/run/lock/uain-node-backup-run.lock')
# As long as the wrapper used to wait for the custody lock before any work.
CUSTODY_WAIT_SECONDS=120
# A wait this long lets the staged copy fall behind: refresh it before stopping.
RESYNC_AFTER_WAIT_SECONDS=5
SERVING_WAIT_SECONDS=20
PROOF_AGE_GATE_SECONDS=120
STOPPED_COPY_DEADLINE_SECONDS=30
PAUSE_LIMIT_SECONDS=60
PRECOPY_DEADLINE_SECONDS=300
# A source file changed this close to the walk that read it is "racy": its
# ctime tick may also cover a later write, so its staged copy is never trusted
# and it is copied again while the node is stopped (as git does for its index).
RACY_MARGIN_NS=2*10**9
RECEIPT_VERSION=3
monotonic=time.monotonic
sleep=time.sleep

class DeadlineExceeded(ValueError):pass

class Deadline:
 def __init__(self,seconds,label):self.label=label;self.end=monotonic()+seconds
 def check(self):
  if monotonic()>self.end:raise DeadlineExceeded(self.label+' deadline exceeded')

def walk(root):
 """Sorted relative entries; links, devices, FIFOs and hardlinks are refused."""
 root=Path(root);out=[]
 for directory,dirs,files in os.walk(root,followlinks=False):
  dirs.sort();base=Path(directory)
  for name in sorted(dirs)+sorted(files):
   path=base/name;info=path.lstat()
   if stat.S_ISDIR(info.st_mode):out.append((path.relative_to(root),info))
   elif stat.S_ISREG(info.st_mode):
    if info.st_nlink!=1:raise ValueError('Hardlinked node state refused')
    out.append((path.relative_to(root),info))
   else:raise ValueError('Unsafe node state entry')
 return out

def copy_file(source,target,info,deadline):
 pending=target.with_name(target.name+'.copy-'+uuid.uuid4().hex)
 try:
  with open(source,'rb') as src,open(pending,'xb') as dst:
   while chunk:=src.read(4*1024*1024):
    dst.write(chunk)
    if deadline:deadline.check()
   dst.flush();os.fsync(dst.fileno())
  # The stat taken BEFORE reading is recorded, so a file that changed while it
  # was being read no longer matches and is copied again by the stopped pass.
  os.chmod(pending,stat.S_IMODE(info.st_mode))
  if os.geteuid()==0:os.chown(pending,info.st_uid,info.st_gid)
  os.utime(pending,ns=(info.st_atime_ns,info.st_mtime_ns));os.replace(pending,target)
 finally:pending.unlink(missing_ok=True)

def fingerprint(info):
 """Source identity that any content, metadata or replacement change alters."""
 kind='dir' if stat.S_ISDIR(info.st_mode) else 'file'
 return (kind,stat.S_IMODE(info.st_mode),info.st_uid,info.st_gid)+((info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns) if kind=='file' else ())

def sync_tree(source,target,deadline=None,record=None,quiescent=False):
 """Incremental one-way copy. Reads the source only and never links to it.

 With a record (relative path -> fingerprint before the read), a file is
 skipped only when its fingerprint is unchanged since the staged copy was read,
 and racy files are left out of the record unless the source is quiescent
 (stopped, so nothing can write in the same tick)."""
 source=Path(source);target=Path(target);target.mkdir(mode=0o700,exist_ok=True);changes=0;seen=set()
 walked_at=time.time_ns();entries=walk(source)
 for relative,info in entries:
  if deadline:deadline.check()
  seen.add(relative);destination=target/relative
  if destination.is_symlink():raise ValueError('Unsafe staging entry')
  if stat.S_ISDIR(info.st_mode):
   if destination.exists() and not destination.is_dir():raise ValueError('Unsafe staging entry')
   destination.mkdir(mode=0o700,exist_ok=True)
   if record is not None:record[relative]=fingerprint(info)
   continue
  if destination.is_dir():raise ValueError('Unsafe staging entry')
  if record is not None:
   if destination.exists() and record.get(relative)==fingerprint(info):continue
   record.pop(relative,None)
  elif destination.exists():
   have=destination.lstat()
   if have.st_size==info.st_size and have.st_mtime_ns==info.st_mtime_ns and stat.S_IMODE(have.st_mode)==stat.S_IMODE(info.st_mode):continue
  copy_file(source/relative,destination,info,deadline);changes+=1
  if record is not None and (quiescent or info.st_ctime_ns<walked_at-RACY_MARGIN_NS):record[relative]=fingerprint(info)
 for relative,info in reversed(walk(target)):
  if relative in seen:continue
  path=target/relative
  if stat.S_ISDIR(info.st_mode):path.rmdir()
  else:path.unlink()
  if record is not None:record.pop(relative,None)
  changes+=1
 for relative,info in [(Path('.'),source.lstat())]+[x for x in entries if stat.S_ISDIR(x[1].st_mode)]:
  os.chmod(target/relative,stat.S_IMODE(info.st_mode))
  if os.geteuid()==0:os.chown(target/relative,info.st_uid,info.st_gid)
 return changes

def require_unchanged(source,record,deadline):
 """Stat-only proof, while stopped, that the source equals the staged record:
 the same entry set and every fingerprint unchanged since its staged read."""
 current={}
 for relative,info in walk(source):
  deadline.check();current[relative]=fingerprint(info)
 if current!=record:raise ValueError('Stopped tree differs from staged copy')
 return len(current)

def tree(root,deadline=None):
 """The failover-node.tree digest, interruptible at a fixed deadline."""
 root=Path(root);h=hashlib.sha256();size=0;count=0
 for path in sorted(root.rglob('*')):
  if deadline:deadline.check()
  if path.is_symlink() or not(path.is_dir() or path.is_file()):raise ValueError('Unsafe node state entry')
  h.update((str(path.relative_to(root))+'\0'+str(path.stat().st_mode&0o777)+'\0').encode())
  if path.is_file():
   if path.stat().st_nlink!=1:raise ValueError('Hardlinked node state refused')
   value=hashlib.sha256()
   with path.open('rb') as source:
    while chunk:=source.read(4*1024*1024):
     value.update(chunk)
     if deadline:deadline.check()
   count+=1;size+=path.stat().st_size;h.update(value.digest())
 return dict(sha256=h.hexdigest(),files=count,bytes=size)

@contextlib.contextmanager
def custody_quiet(timing):
 """Hold the lock every custody signer on this host shares, for the stopped
 window only. Waits up to CUSTODY_WAIT_SECONDS for a signer or vault consumer
 in flight; a longer wait refuses the capture with the node still running."""
 asked=monotonic()
 with CUSTODY_LOCK.open('a') as lock:
  while True:
   try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);break
   except BlockingIOError:
    if monotonic()-asked>=CUSTODY_WAIT_SECONDS:raise ValueError('Custody lock busy; node left running')
    sleep(0.25)
  held=monotonic();timing['custody_lock_wait_seconds']=held-asked
  try:yield held-asked
  finally:timing['custody_lock_held_seconds']=monotonic()-held

def wait_serving(node,since):
 """Seconds from the stop until the restarted node's RPC answers again, or
 None if it did not within SERVING_WAIT_SECONDS. It never raises: the capture's
 own checks decide success. Custody stays quiet until this returns."""
 end=monotonic()+SERVING_WAIT_SECONDS
 while True:
  try:node.rpc('status');return monotonic()-since
  except AttributeError:return None
  except Exception:pass
  if monotonic()>=end:return None
  sleep(0.25)

def staging_root():
 """Private root-only directory beside the archives (same filesystem, 0700)."""
 parent=b.ROOT
 if parent.resolve()!=parent or not parent.is_dir() or parent.stat().st_uid!=os.geteuid() or parent.stat().st_mode&0o077:raise ValueError('Unsafe backup directory')
 return Path(tempfile.mkdtemp(prefix='.staging-',dir=parent))

def private_json(path):
 path=Path(path)
 if path.is_symlink() or path.stat().st_uid!=0 or path.stat().st_mode&0o077:raise ValueError('Private root-owned role receipt required')
 return json.loads(path.read_text())

def state_position(state):return tuple(state[x] for x in ('height','round','step'))

def binding(source,ciphertext_sha256):
 return dict(source_host=source['source_host'],fence_id=source['fence_id'],ciphertext_sha256=ciphertext_sha256,
             checkpoint=source['checkpoint'],source_inventory=source['inventory'],signing_floor=source['signing_state'])

def role(node,stopped=False):
 inventory=node.inventory();fence=node.root/'fence.json';restore=node.root/'restore.json';started=node.root/'promotion-started.json'
 if fence.exists():
  if restore.exists() or started.exists():raise ValueError('Conflicting source and destination roles')
  proof=node.fence_proof()
  if proof['inventory']!=inventory:raise ValueError('Frozen source profile changed')
  capsule=node.archive_path('failover-'+proof['fence_id']+'.nodebk')
  return dict(name='fenced_source',binding=binding(proof,f.sha(capsule)))
 if restore.exists() or started.exists():
  receipt=private_json(restore);marker=private_json(started)
  if receipt.get('promoted') is not True or marker.get('destination')!=node.p['host'] or marker.get('source_fence_id')!=receipt['source']['fence_id'] or marker.get('ciphertext_sha256')!=receipt['ciphertext_sha256']:raise ValueError('Incomplete or inconsistent promotion requires reconciliation')
  # A retained archive is not a source-reachability substitute. Each capture
  # and each recovery independently checks the actual source fence endpoint.
  node.live_fence(receipt['source'],receipt['ciphertext_sha256'])
  node.require_single_signer(node.home,True)
  if state_position(node.signing_state())<state_position(receipt['signing_state']):raise ValueError('Promoted signing state rolled back')
  if not stopped:
   f.check_checkpoint(receipt['source']['checkpoint'],node.checkpoint(receipt['source']['checkpoint']['height']))
   if node.checkpoint()['height']<receipt['after_checkpoint']['height']:raise ValueError('Promoted history rolled back')
  return dict(name='promoted_validator',binding=binding(receipt['source'],receipt['ciphertext_sha256']))
 if node.unit_file.is_symlink():raise ValueError('Unexplained masked or redirected node')
 genesis=json.loads((node.home/'config/genesis.json').read_text());validators=genesis.get('validators',[])
 if len(validators)!=1:raise ValueError('Exact one-validator backup policy required')
 own=json.loads((node.home/'config/priv_validator_key.json').read_text())['address'].lower()
 return dict(name='original_validator' if own==validators[0]['address'].lower() else 'original_fullnode',binding=None)

def paired(backups):
 if len(backups)!=2 or {x['manifest']['host'] for x in backups}!=set(b.HOSTS):raise ValueError('Both fixed host backups required')
 manifests=[x['manifest'] for x in backups]
 if len({(x['chain_id'],x['genesis_sha256']) for x in manifests})!=1:raise ValueError('Paired chain/genesis differs')
 roles=[x['node_role'] for x in manifests];names={x['name'] for x in roles}
 if names=={'original_validator','original_fullnode'}:
  if any(x['binding'] is not None for x in roles):raise ValueError('Unexpected original role binding')
 elif names=={'fenced_source','promoted_validator'}:
  if roles[0]['binding']!=roles[1]['binding']:raise ValueError('Paired promotion capsules differ')
  source=next(x for x in manifests if x['node_role']['name']=='fenced_source')
  if source['node_role']['binding']['source_host']!=source['host'] or source['signing_state']!=source['node_role']['binding']['signing_floor']:raise ValueError('Frozen source identity/state differs')
 else:raise ValueError('Exactly one active signer and its reviewed peer role required')
 return True

def inventory(node):
 i=node.inventory()
 return dict(host=i['host'],home=i['home'],binary=node.p['binary'],binary_sha256=i['binary_sha256'],unit_sha256=i['unit_sha256'],genesis_sha256=i['genesis_sha256'],chain_id=i['chain_id'])

def recover(node):
 if not b.MARKER.exists():return
 expected=private_json(b.MARKER)
 current_role=role(node,stopped=True)
 if current_role['name']=='fenced_source' or expected.get('node_role')!=current_role or expected.get('inventory')!=inventory(node):raise ValueError('Never restart fenced, changed or unexplained backup role')
 if node.unit_file.is_symlink():raise ValueError('Backup cannot unmask a signer')
 if node.system_state()['active']!='active':node.run(['systemctl','start',node.p['unit']])
 if node.system_state()['active']!='active':raise ValueError('Reviewed node restart failed')
 b.MARKER.unlink();b.sync_directory(b.MARKER.parent)

def stopped_proof(node):
 if node.system_state()['active'] not in ('inactive','failed') or node.system_state()['pid'] or node.matching_processes() or node.listening_ports():raise ValueError('Stopped PID/process/ports proof required')

def seal(source_home,node,before,manifest,temporary,key,frozen):
 with tempfile.TemporaryDirectory(prefix='uain-role-capsule-',dir=b.CAPSULE_TMP) as work:
  work=Path(work);b.atomic_json(work/'manifest.json',manifest)
  # Store the reviewed real unit, never the source's /dev/null mask link.
  unit=node.original_unit if frozen else node.unit_file
  shutil.copyfile(unit,work/b.UNIT);(work/b.UNIT).chmod(0o600)
  process=subprocess.Popen(['tar','--one-file-system','-czf','-','-C',str(source_home.parent),source_home.name,'-C',str(Path(before['binary']).parent),'uaind','-C',str(work),b.UNIT,'manifest.json'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
  try:
   b.crypto.seal(process.stdout,temporary,key)
   if process.wait()!=0:raise ValueError('Capsule compression failed')
  finally:
   if process.poll() is None:process.kill();process.wait()
   process.stdout.close()

def publish(path,temporary,key,fields,legacy_from,verify_from=None):
 try:
  os.link(temporary,path);temporary.unlink();receipt=b.verify_restore(path,key)
  if verify_from is not None:fields['post_restart_seal_verify_seconds']=monotonic()-verify_from
  # capture_pause_seconds keeps its historical meaning: from the stop (or the
  # frozen capture start) to restore verified. It is NOT the validator stop
  # duration; validator_stop_seconds is (receipt_version 2).
  receipt.update(fields,name=path.name,capture_pause_seconds=(datetime.datetime.now(datetime.timezone.utc)-legacy_from).total_seconds())
  b.atomic_json(path.with_suffix('.json'),receipt);return receipt
 finally:temporary.unlink(missing_ok=True)

def failure_receipt(path,fields):
 """A private, loud record of a refused capture. Never mistaken for a backup."""
 b.atomic_json(path.with_name(path.name[:-len('.nodebk')]+'.failed.json'),dict(fields,name=path.name,published=False))

def capture(node,key,stamp):
 b.crypto.key_bytes(key)
 with b.CAPTURE_LOCK.open('a') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  if b.MARKER.exists():recover(node)
  before=inventory(node);node_role=role(node);frozen=node_role['name']=='fenced_source'
  if not frozen and node.system_state()['active']!='active':raise ValueError('Active-role capture requires an already running node')
  path=b.archive_path(b.filename(before['host'],stamp))
  if path.exists():raise ValueError('Immutable backup already exists')
  # Interrupted earlier captures leave only private staging; it is never published.
  for stale in b.ROOT.glob('.staging-*'):
   if stale.is_dir() and not stale.is_symlink():shutil.rmtree(stale)
  size=sum(p.stat().st_size for p in node.home.rglob('*') if p.is_file())
  # Staged copy, archive and restore verification.
  if shutil.disk_usage(b.ROOT).free<max(2*1024**3,5*(size+Path(before['binary']).stat().st_size)):raise ValueError('Insufficient restore verification space')
  temporary=path.with_name(path.name+'.pending-'+uuid.uuid4().hex)
  timing=dict(receipt_version=RECEIPT_VERSION,proof_age_gate_seconds=PROOF_AGE_GATE_SECONDS,stopped_copy_deadline_seconds=STOPPED_COPY_DEADLINE_SECONDS,pause_limit_seconds=PAUSE_LIMIT_SECONDS,
              precopy_seconds=None,validator_stop_seconds=None,stopped_copy_seconds=None,post_restart_seal_verify_seconds=None,validator_stopped_at=None,validator_restarted_at=None,final_sync_changes=None,
              custody_lock_wait_seconds=None,custody_lock_held_seconds=None,validator_serving_seconds=None)
  if frozen:
   # A fenced source is already stopped and is never started: capture in place.
   started=datetime.datetime.now(datetime.timezone.utc);stopped_proof(node)
   manifest=dict(before,created_at=started.isoformat(),tree=f.tree(node.home),backup_name=path.name,format='UAINNODE01',restore_requires_signer_fencing=True,node_role=node_role,signing_state=node.signing_state())
   try:
    seal(node.home,node,before,manifest,temporary,key,True)
    if f.tree(node.home)!=manifest['tree'] or node.signing_state()!=manifest['signing_state'] or role(node,stopped=True)!=node_role:raise ValueError('Stopped capture changed')
   except BaseException:temporary.unlink(missing_ok=True);raise
   return publish(path,temporary,key,dict(timing,node_restarted=False,source_remains_fenced=True),started)
  staging=staging_root();stop_wall=None;restarted=None
  try:
   staged_home=staging/node.home.name
   record={}
   t0=monotonic();sync_tree(node.home,staged_home,Deadline(PRECOPY_DEADLINE_SECONDS,'precopy'),record);timing['precopy_seconds']=monotonic()-t0
   # Custody is quiet from here until the restarted node answers again, and
   # for no longer: the hash, seal, restore check and transfers run unlocked.
   with custody_quiet(timing) as waited:
    if waited>RESYNC_AFTER_WAIT_SECONDS:sync_tree(node.home,staged_home,Deadline(PRECOPY_DEADLINE_SECONDS,'precopy'),record)
    # Revalidate immediately before the stop; the restart marker is durable first.
    if inventory(node)!=before or role(node)!=node_role or node.system_state()['active']!='active':raise ValueError('Backup role changed before stop')
    b.atomic_json(b.MARKER,dict(inventory=before,node_role=node_role))
    stop_started=monotonic();stop_wall=datetime.datetime.now(datetime.timezone.utc);timing['validator_stopped_at']=stop_wall.isoformat()
    try:
     deadline=Deadline(STOPPED_COPY_DEADLINE_SECONDS,'stopped copy')
     node.run(['systemctl','stop',node.p['unit']])
     stopped_proof(node)
     if inventory(node)!=before or role(node,stopped=True)!=node_role:raise ValueError('Backup role changed during stop')
     deadline.check()
     timing['final_sync_changes']=sync_tree(node.home,staged_home,deadline,record,quiescent=True)
     require_unchanged(node.home,record,deadline);state=node.signing_state()
     timing['stopped_copy_seconds']=monotonic()-stop_started
    finally:
     # The guarded hook revalidates marker, role and fence before any start.
     try:recover(node)
     finally:
      restarted=monotonic();timing['validator_restarted_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();timing['validator_stop_seconds']=restarted-stop_started
     # Reached only when the node was started again: keep custody quiet until
     # it answers, so the first signer after the pause does not meet a refusal.
     timing['validator_serving_seconds']=wait_serving(node,stop_started)
   if timing['validator_stop_seconds']>PAUSE_LIMIT_SECONDS:raise DeadlineExceeded('Validator pause exceeded limit')
   # The staged tree is private and no longer written, and the stopped proof
   # showed it equals the stopped live tree: its full content hash, taken after
   # the restart, is the captured tree digest.
   live=tree(staged_home)
   manifest=dict(before,created_at=stop_wall.isoformat(),tree=live,backup_name=path.name,format='UAINNODE01',restore_requires_signer_fencing=True,node_role=node_role,signing_state=state)
   seal(staged_home,node,before,manifest,temporary,key,False)
   if tree(staged_home)!=live:raise ValueError('Staged tree changed during sealing')
  except BaseException as error:
   temporary.unlink(missing_ok=True)
   if isinstance(error,Exception):
    try:failure_receipt(path,dict(timing,error=type(error).__name__,deadline_exceeded=isinstance(error,DeadlineExceeded),node_restarted=node.system_state()['active']=='active'))
    except Exception:pass
   raise
  finally:shutil.rmtree(staging,ignore_errors=True)
  # Restore verification reads the immutable capsule; the validator is running.
  return publish(path,temporary,key,dict(timing,node_restarted=node.system_state()['active']=='active',source_remains_fenced=False),stop_wall,verify_from=restarted)

def transition(node,action,request):
 # All three locks are nonblocking. An in-flight daily coordinator (run lock,
 # held by its wrapper from start to finish) or local capture must finish
 # first; no transition can race its finally/restart hook. The coordinator no
 # longer holds the custody lock throughout, so the run lock is what excludes it.
 with RUN_LOCK.open('a') as run_lock,CUSTODY_LOCK.open('a') as custody,b.CAPTURE_LOCK.open('a') as capture_lock:
  fcntl.flock(run_lock,fcntl.LOCK_EX|fcntl.LOCK_NB);fcntl.flock(custody,fcntl.LOCK_EX|fcntl.LOCK_NB);fcntl.flock(capture_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  if b.MARKER.exists():raise ValueError('Unresolved backup restart marker requires reconciliation')
  fields={'fence':{'checkpoint'},'restore':{'name','key','sha256'},'promote':set()}
  if action not in fields or set(request)!=fields[action]:raise ValueError('Exact transition action required')
  if action=='fence':return node.fence(request['checkpoint'])
  if action=='restore':return node.restore(request['name'],request['key'],request['sha256'])
  return node.promote()

def main():
 os.umask(0o077);resource.setrlimit(resource.RLIMIT_CORE,(0,0))
 if os.geteuid()!=0 or len(sys.argv)!=2:raise ValueError('Fixed root role-backup action required')
 node=f.Node(PROFILE);action=sys.argv[1]
 if action=='recover':recover(node);return
 raw=sys.stdin.buffer.read(131073)
 if len(raw)>131072:raise ValueError('Oversized role-backup request')
 request=json.loads(raw or b'{}')
 if action=='capture':
  if set(request)!={'key','stamp'}:raise ValueError('Exact capture fields required')
  result=capture(node,request['key'],request['stamp'])
 elif action=='preview':
  if request:raise ValueError('Empty preview required')
  result=dict(inventory=inventory(node),node_role=role(node),canonical_install=False)
 else:result=transition(node,action,request)
 print(json.dumps(result))

if __name__=='__main__':
 def interrupted(signum,frame):raise SystemExit(1)
 signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGINT,interrupted)
 try:main()
 except Exception:print('Role-aware backup or transition refused; source fence retained.',file=sys.stderr);sys.exit(1)

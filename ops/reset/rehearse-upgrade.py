#!/usr/bin/python3 -I
"""Real server qualification in private mount/UTS namespaces; never live install."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid
sys.excepthook=sys.__excepthook__

STAGE=Path('/opt/uain-test/reset-installer-qualification-20261012')
PUBLIC_STATE=Path('/opt/uain-test/human-funding-20261012/src/chain/bin/uain-state-latest')
PUBLIC_CHECKPOINT=Path('/opt/uain-test/integration-final-878f7c5-20261012/uain-reset-checkpoint')
PUBLIC_PROOF=Path('/opt/uain-reset/uain-proof')
ARCHIVE_SHA='e9feb4979478019ce3acbc754540ce0233f8af278eee1e9755a5fc71e762f972'

def run(argv,*,data=None,ok=True):
 result=subprocess.run(argv,input=data,capture_output=True,timeout=120)
 if ok and result.returncode:raise RuntimeError('Isolated qualification command refused: '+Path(argv[0]).name+' '+str(result.returncode)+' '+result.stderr.decode(errors='replace')[:1000])
 return result

def write(path,raw,mode=0o600):
 path=Path(path);path.parent.mkdir(parents=True,mode=0o700,exist_ok=True);path.write_bytes(raw);path.chmod(mode)

def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def inside(base,role):
 # Sources mount before /opt is hidden. Mount propagation is private; none of
 # the fixed production directories is replaced in the host's namespace.
 run(['/usr/bin/mount','--make-rprivate','/'])
 for source,target in [(base/'etc/uain-reset','/etc/uain-reset'),(base/'var/lib','/var/lib'),(base/'run/lock','/run/lock'),(base/'usr/local/sbin','/usr/local/sbin'),(base/'root/.ssh','/root/.ssh'),(base/'opt','/opt')]:run(['/usr/bin/mount','--bind',str(source),target])
 run(['/usr/bin/hostname','uain-app-1' if role=='app' else 'uain-db-1'])
 sys.dont_write_bytecode=True;sys.path.insert(0,'/opt/source')
 import upgrade
 binaries={'uain-state':Path('/opt/public/uain-state'),'uain-reset-checkpoint':Path('/opt/public/uain-reset-checkpoint')}
 if role=='app':binaries['uain-proof']=Path('/opt/public/uain-proof')
 original_key=Path('/etc/uain-reset/db_ed25519').stat();authorized=Path('/root/.ssh/authorized_keys').read_bytes();epoch=Path('/var/lib/uain-reset/retained.json').read_bytes()
 prefix=['/usr/bin/python3','-I','-B','/opt/source/upgrade.py'];common=[role,'--source','/opt/source','--state',str(binaries['uain-state']),'--checkpoint',str(binaries['uain-reset-checkpoint'])]
 if role=='app':common+=['--proof',str(binaries['uain-proof'])]
 def approve():
  public=json.loads(run(prefix+['plan',*common,'--source-revision','a'*40]).stdout);public['expires_at']=int(time.time())+1800
  write('/opt/approval.json',json.dumps(public).encode());return public
 approval=approve()
 def interrupt(phase):
  if phase=='retired':raise RuntimeError('intentional isolated interruption')
 try:upgrade.install('/opt/approval.json',Path('/opt/source'),binaries,after=interrupt)
 except RuntimeError as error:
  if str(error)!='intentional isolated interruption':raise
 else:raise AssertionError('Interruption was not exercised')
 assert not Path('/opt/uain-reset').exists()
 receipt=json.loads(run(prefix+['apply',*common,'--approval','/opt/approval.json']).stdout)
 assert receipt==json.loads(run(prefix+['apply',*common,'--approval','/opt/approval.json']).stdout)
 assert digest('/opt/uain-reset/archive.py')==ARCHIVE_SHA
 assert Path('/etc/uain-reset/db_ed25519').stat().st_ino==original_key.st_ino
 assert Path('/root/.ssh/authorized_keys').read_bytes()==authorized and Path('/var/lib/uain-reset/retained.json').read_bytes()==epoch
 sshd=None
 try:
  if role=='app':
   def capability():return run(['/usr/local/sbin/uain-system-reset','capability'],ok=False)
  else:
   sshd=subprocess.Popen(['/usr/sbin/sshd','-D','-e','-f','/opt/sshd_config'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   ssh=['/usr/bin/ssh','-F','/dev/null','-b','10.98.0.1','-p','22262','-o','BatchMode=yes','-o','ConnectTimeout=3','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile=/etc/uain-reset/db_known_hosts','-i','/etc/uain-reset/db_ed25519','root@10.98.0.1']
   def capability():return run([*ssh,'uain-reset-node'],data=b'{"action":"capability"}\n',ok=False)
  for attempt in range(30):
   actual=capability()
   if actual.returncode==0:break
   if role=='app':break
   time.sleep(.1)
  assert actual.returncode==0,actual.stderr.decode(errors='replace')[:1000]
  cap=json.loads(actual.stdout);assert cap['release_digest']==receipt['release_digest'] and cap['role']==role and cap['archive_sha256']==ARCHIVE_SHA and cap['reset_performed'] is False
  if role=='database':
   assert run([*ssh,'uname -a'],data=b'{}\n',ok=False).returncode!=0
   for invalid in [{'action':'fetch','epoch':'20261012_010203','file':'../../secret'},{'action':'stage-db','epoch':'20261012_010203','database':{'database':'postgres','epoch':'20261012_010203','target':'uain_reset_20261012_010203'}}]:
    assert run([*ssh,'uain-reset-node'],data=json.dumps(invalid).encode()+b'\n',ok=False).returncode!=0
  # A valid timestamp pyc executes even with -B unless the bootstrap compiles
  # protected source directly. The marker must never execute before rejection.
  import importlib.util,marshal,struct
  file=Path('/opt/uain-reset/installed.py');info=file.stat();cache=Path(importlib.util.cache_from_source(str(file)))
  write(cache,importlib.util.MAGIC_NUMBER+struct.pack('<III',0,int(info.st_mtime),info.st_size)+marshal.dumps(compile("open('/opt/forged-bytecode-executed','w').write('fixture')",str(file),'exec')))
  assert capability().returncode!=0
  assert not Path('/opt/forged-bytecode-executed').exists(),'Forged verifier pyc executed before source guard'
  shutil.rmtree(cache.parent)
  if role=='database':
   write('/opt/injected/pathlib.py',b"open('/opt/environment-shadow-executed','w').write('fixture')\n")
   isolated=subprocess.run(['/usr/bin/python3','/opt/uain-reset/node_main.py'],input=b'{"action":"capability"}\n',capture_output=True,env={**os.environ,'PYTHONPATH':'/opt/injected','SSH_ORIGINAL_COMMAND':'uain-reset-node'},timeout=30)
   assert isolated.returncode==0 and not Path('/opt/environment-shadow-executed').exists(),'Forced bootstrap loaded inherited module path'
  file=Path('/opt/uain-reset/native.py');before=file.read_bytes();file.write_bytes(b"from pathlib import Path\nPath('/opt/unverified-module-executed').write_text('fixture marker')\n")
  assert capability().returncode!=0
  assert not Path('/opt/unverified-module-executed').exists(),'Unverified operational module executed before manifest guard'
  file.write_bytes(before)
  old=Path('/opt/uain-reset').resolve();source=Path('/opt/source/native.py');source.write_bytes(source.read_bytes()+b'\n# Isolated second approved fixture release.\n')
  next_approval=approve();second=json.loads(run(prefix+['apply',*common,'--approval','/opt/approval.json']).stdout)
  assert second['release_digest']!=receipt['release_digest'] and old.is_dir()
  assert json.loads(capability().stdout)['release_digest']==second['release_digest']
  assert Path('/etc/uain-reset/db_ed25519').stat().st_ino==original_key.st_ino and Path('/root/.ssh/authorized_keys').read_bytes()==authorized and Path('/var/lib/uain-reset/retained.json').read_bytes()==epoch
  write('/opt/qualification-receipt.json',json.dumps({'role':role,'first_release':receipt['release_digest'],'second_release':second['release_digest'],'interrupted_after_legacy_retirement':True,'forward_recovery_and_repeat_identical':True,'fixed_runtime_dispatch':True,'manifest_tamper_refused':True,'forged_verifier_bytecode_refused_before_execution':True,'forced_ssh':role=='database','forced_from':'10.98.0.1' if role=='database' else None,'shell_and_other_scope_refused':role=='database','config_keys_authorized_epochs_preserved':True,'archive_sha256':ARCHIVE_SHA,'reset_performed':False},sort_keys=True,indent=2).encode()+b'\n')
 finally:
  if sshd:
   sshd.terminate()
   try:sshd.wait(timeout=10)
   except subprocess.TimeoutExpired:sshd.kill();sshd.wait()

def outside():
 if os.geteuid()!=0:raise ValueError('Root isolated app-server qualification only')
 source=Path(__file__).resolve().parent;receipts=[]
 for role in ('app','database'):
  base=STAGE/('lab-'+role+'-'+uuid.uuid4().hex);base.mkdir(mode=0o700,parents=True)
  try:
   for name in ('opt/source','opt/public','opt/uain-reset','opt/uain-reset-releases','etc/uain-reset','var/lib/uain-reset','run/lock','usr/local/sbin','root/.ssh'): (base/name).mkdir(parents=True,mode=0o700,exist_ok=True)
   (base/'run/lock').chmod(0o1777)
   for name in ('archive.py','checkpoint.py','custody_entry.py','database.py','health.py','native.py','node_main.py','node.py','pins.py','runtime.py','stack.py','system.py','installed.py','upgrade.py','uain-system-reset'):write(base/'opt/source'/name,(source/name).read_bytes())
   write(base/'opt/uain-reset/original.py',b'original isolated capability\n');write(base/'opt/uain-reset/archive.py',(source/'archive.py').read_bytes())
   if role=='app':write(base/'usr/local/sbin/uain-system-reset',b'#!/bin/sh\nexit 99\n',0o700)
   for path,name in [(PUBLIC_STATE,'uain-state'),(PUBLIC_CHECKPOINT,'uain-reset-checkpoint'),(PUBLIC_PROOF,'uain-proof')]:shutil.copyfile(path,base/'opt/public'/name);(base/'opt/public'/name).chmod(0o700)
   (base/'opt/uain-custody/venv/bin').mkdir(parents=True,mode=0o700);(base/'opt/uain-custody/venv/bin/python').symlink_to('/usr/bin/python3')
   run(['/usr/bin/ssh-keygen','-q','-t','ed25519','-N','','-f',str(base/'etc/uain-reset/db_ed25519')]);run(['/usr/bin/ssh-keygen','-q','-t','ed25519','-N','','-f',str(base/'opt/host_key')])
   pub=(base/'etc/uain-reset/db_ed25519.pub').read_text().strip();host=' '.join((base/'opt/host_key.pub').read_text().split()[:2])
   write(base/'root/.ssh/authorized_keys',('from="10.98.0.1",restrict,command="/usr/bin/python3 /opt/uain-reset/node_main.py" '+pub+'\n').encode())
   write(base/'etc/uain-reset/db_known_hosts',('[10.98.0.1]:22262 '+host+'\n').encode())
   write(base/'var/lib/uain-reset/retained.json',b'{"fixture":"original epoch journal"}\n')
   write(base/'opt/sshd_config',b'Port 22262\nListenAddress 10.98.0.1\nHostKey /opt/host_key\nPidFile /opt/sshd.pid\nAuthorizedKeysFile /root/.ssh/authorized_keys\nPermitRootLogin prohibit-password\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nStrictModes yes\nAllowTcpForwarding no\nAllowAgentForwarding no\nX11Forwarding no\nPermitTunnel no\n')
   run(['/usr/bin/unshare','--mount','--uts','--fork','/usr/bin/python3','-I','-B',str(Path(__file__).resolve()),'--inside',str(base),'--role',role])
   receipts.append(json.loads((base/'opt/qualification-receipt.json').read_text()))
  finally:shutil.rmtree(base)
 result={'schema':'uain-reset-versioned-upgrade-qualification-v1','date':'2026-10-12','fixture':'private mount/UTS namespaces on app host; fixed production paths mapped exclusively to disposable directories; real SSH source10.98.0.1; public binaries; fictional isolated SSH credentials; fictional aaaa source revision in fixture approvals','production_installation':False,'production_reset':False,'roles':receipts,'public_binary_sha256':{'uain-state':digest(PUBLIC_STATE),'uain-reset-checkpoint':digest(PUBLIC_CHECKPOINT),'uain-proof':digest(PUBLIC_PROOF)},'source_sha256':{name:digest(source/name) for name in ('installed.py','upgrade.py','node_main.py','node.py','custody_entry.py','system.py','uain-system-reset','install.sh','test_upgrade.py','rehearse-upgrade.py')}}
 write(STAGE/'upgrade-rehearsal-receipt.json',json.dumps(result,sort_keys=True,indent=2).encode()+b'\n');print(json.dumps(result,sort_keys=True))

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--inside');parser.add_argument('--role',choices=('app','database'));args=parser.parse_args()
 if args.inside:inside(Path(args.inside),args.role)
 else:outside()

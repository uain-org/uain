#!/usr/bin/python3 -I
"""Reviewed canonical installation only. Contains no promotion action."""
import contextlib
import ctypes
import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

HERE=Path(__file__).resolve().parent;BUNDLE=HERE.parents[1]
CODE=Path('/opt/uain-failover');CONFIG=Path('/etc/uain-failover');EVIDENCE=Path('/var/lib/uain-failover')
ROOT=Path('/var/lib/uain-failover-install');JOURNAL=ROOT/'install.json'
BACKUP=Path('/opt/uain-node-backup');OLD=Path('/opt/uain-node-backup.pre-failover-20261012');PENDING=Path('/opt/uain-node-backup.pending-failover-20261012')
AUTHORIZED=Path('/root/.ssh/authorized_keys');MARKER=Path('/run/uain-node-backup-restart.json')
CUSTODY=Path('/run/lock/uain-custody.lock');CAPTURE=Path('/run/lock/uain-node-backup-capture.lock')
UNIT=Path('/etc/systemd/system/uain-chain-shadow.service');HOME=Path('/var/lib/uain-chain/shadow-20261008-1')
TIMERS=('uain-node-backup.timer','uain-node-backup-check.timer')
DAEMON='de321b8e229753aec0257415597789a6eb2254ba3e71e12e9e70f652374b3ea1';GENESIS='54140a9243c4591ccc9f2e9d49543fc68b87b3e0045416174c232e9dd498f8ff'
HOSTS={'uain-app-1':dict(ip='10.98.0.1',unit='1226b61700c114af499d9f9645c0f88209090989eaf8b8c3eb5e9fd9c87201a1',ssh='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKxI09GPRB92g3MKldfEeRhwIwcysZBtkQM2CwSdTYtp'),
       'uain-db-1':dict(ip='10.98.0.2',unit='2f0f0c5116f9292b59a36bb0f2d6336aefa22bdeac9d857f6ccf7dcf53b19fa6',ssh='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICz/fQATTDwaDJxNxY1OBCIBsPYelX0s/mHGPEgGRi/L')}
BASELINE={'archive.py':'e9feb4979478019ce3acbc754540ce0233f8af278eee1e9755a5fc71e762f972','coordinator.py':'ad61c25656085530c90683047c09bef0305795fb91defe00aa7ed258778ebeae','entry.py':'6bf562934cd4478e5d03d19d0244e4fd4abafe92ca3016ddb70482d314121ce4','node.py':'cbc10999915151ca3d145f1f70f938ed4dd245f2b2e93df9d22ec5a341db27e5','receive.py':'70a04c14db9a5ea3d9341b4be8f07076aba3f3bd0f92b2556e4d3f27f2b2d98b','rehearse.py':'df7ddf1eac45065469e54013b96fc8b09bbdee7aaf85c63eeec3ed7fe5cc5c92','test_backup.py':'de2df8910104e07ef1a0f413bf36d24920931a398fc75b42cdc3de8d6a3d36af'}
FILES={'ops/chain/'+name for name in ('failover-node.py','failover-backup.py','failover-ssh.py','failover-install.py')}|{'ops/node-backup/node.py','ops/node-backup/coordinator.py','ops/reset/archive.py'}
HEX=re.compile(r'^[a-f0-9]{64}$');PUB=re.compile(r'^ssh-ed25519 [A-Za-z0-9+/]{68}(?: [A-Za-z0-9._@-]{1,100})?$')

def require(ok):
 if not ok:raise ValueError('Pinned failover installation precondition refused')

def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def protected(path,limit=1024*1024):
 path=Path(path);require(path.resolve()==path)
 for parent in path.parents:
  s=parent.stat();require(s.st_uid==0 and not s.st_mode&0o022)
 s=path.stat();require(path.is_file() and s.st_uid==0 and not s.st_mode&0o022 and s.st_nlink==1 and s.st_size<=limit)
 return path.read_bytes()

def atomic(path,data,mode=0o600):
 path=Path(path);pending=path.with_name(path.name+'.install-pending')
 with pending.open('xb') as out:os.chmod(pending,mode);out.write(data);out.flush();os.fsync(out.fileno())
 os.replace(pending,path);sync(path.parent)

def sync(path):
 fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)

def encoded(value):return (json.dumps(value,sort_keys=True)+'\n').encode()
def write_journal(value):atomic(JOURNAL,encoded(value))
def journal():return json.loads(protected(JOURNAL))

def run(args,timeout=180):
 p=subprocess.run(args,capture_output=True,timeout=timeout);require(p.returncode==0);return p.stdout.decode().strip()

def flag(verb,unit):
 p=subprocess.run(['systemctl',verb,unit],capture_output=True,timeout=10)
 value=p.stdout.decode().strip();require(value in ('active','activating','deactivating','inactive','failed','enabled','disabled'));return value

def profile(host):
 require(host in HOSTS)
 return dict(host=host,unit='uain-chain-shadow.service',unit_sha256=HOSTS[host]['unit'],home=str(HOME),binary='/opt/uain-chain/releases/'+DAEMON+'/uaind',binary_sha256=DAEMON,genesis_sha256=GENESIS,chain_id='uain-shadow-20261008-1',rpc_port=26667,p2p_port=26666,p2p_ip=HOSTS[host]['ip'],root=str(EVIDENCE),service_user='uain-chain',service_group='uain-chain')

def bundle():
 raw=protected(BUNDLE/'ops/chain/failover-install-files.json');value=json.loads(raw);require(set(value)==FILES)
 for name,digest in value.items():require(type(digest)==str and HEX.fullmatch(digest) and sha(BUNDLE/name)==digest);protected(BUNDLE/name)
 return value,hashlib.sha256(raw).hexdigest()

def original_metadata(host):
 p=profile(host);require(HOME.resolve()==HOME and UNIT.resolve()==UNIT and sha(UNIT)==p['unit_sha256'] and sha(HOME/'config/genesis.json')==GENESIS and hashlib.sha256(protected(p['binary'],256*1024*1024)).hexdigest()==DAEMON)
 public=run(['cat','/etc/ssh/ssh_host_ed25519_key.pub']).split();require(' '.join(public[:2])==HOSTS[host]['ssh'])
 state=dict(line.split('=',1) for line in run(['systemctl','show',p['unit'],'-p','ActiveState','-p','MainPID','-p','WorkingDirectory']).splitlines())
 require(state['ActiveState']=='active' and int(state['MainPID'])>0 and state['WorkingDirectory']==str(HOME))
 with urllib.request.urlopen('http://127.0.0.1:26667/status',timeout=5) as response:status=json.load(response)['result']
 genesis=json.loads((HOME/'config/genesis.json').read_text());require(genesis['chain_id']==p['chain_id'] and len(genesis['validators'])==1)
 own=status['validator_info']['address'].lower();validator=genesis['validators'][0]['address'].lower()
 require((own==validator)==(host=='uain-app-1') and status['node_info']['network']==p['chain_id'])
 return p

def backup_hashes(directory):return {name:sha(directory/name) for name in BASELINE}

def preflight(host):
 values,digest=bundle();p=original_metadata(host)
 require(not MARKER.exists() and not OLD.exists() and not PENDING.exists() and not JOURNAL.exists())
 require(all(not x.exists() and not x.is_symlink() for x in (CODE,CONFIG,EVIDENCE)))
 require(backup_hashes(BACKUP)==BASELINE)
 for name in BASELINE:protected(BACKUP/name)
 protected(AUTHORIZED)
 if host=='uain-app-1':
  require(sha('/usr/local/sbin/uain-node-backup')=='fe74e69a7ed3035e9c1d665455546429b433f2d320538c1f76517e10d4bd2db0')
  require(sha('/etc/systemd/system/uain-node-backup.service')=='24cfcbe1644c393c944d9321d607fcc99241fb239b962d7393c7b8e6b5d6f7ea')
  run(['/usr/bin/python3',str(BACKUP/'coordinator.py'),'check'])
 return dict(host=host,profile=p,profile_sha256=hashlib.sha256(encoded(p)).hexdigest(),bundle_sha256=digest,backup_baseline=BASELINE,timers={u:dict(enabled=flag('is-enabled',u),active=flag('is-active',u)) for u in TIMERS} if host=='uain-app-1' else {},canonical_changed=False)

@contextlib.contextmanager
def locked():
 with CUSTODY.open('a') as custody,CAPTURE.open('a') as capture:
  fcntl.flock(custody,fcntl.LOCK_EX|fcntl.LOCK_NB);fcntl.flock(capture,fcntl.LOCK_EX|fcntl.LOCK_NB);require(not MARKER.exists());yield

def drain(host):
 if host=='uain-app-1':
  for unit in TIMERS:run(['systemctl','stop',unit])
  deadline=time.monotonic()+3050
  while flag('is-active','uain-node-backup.service') in ('active','activating','deactivating'):
   require(time.monotonic()<deadline);time.sleep(2)
  require(flag('is-active','uain-node-backup-capture.service') not in ('active','activating','deactivating'))

def exchange(left,right):
 # Linux atomic directory exchange: the installed endpoint never disappears.
 libc=ctypes.CDLL(None,use_errno=True);call=libc.renameat2;call.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint];call.restype=ctypes.c_int
 require(call(-100,os.fsencode(left),-100,os.fsencode(right),2)==0);sync(Path(left).parent);sync(Path(right).parent)

def prepare(host):
 before=preflight(host);drain(host)
 ROOT.mkdir(mode=0o700,parents=True,exist_ok=True);require(ROOT.resolve()==ROOT and ROOT.stat().st_uid==0 and not ROOT.stat().st_mode&0o077)
 with locked():
  require(backup_hashes(BACKUP)==BASELINE and original_metadata(host)==before['profile']);values,digest=bundle()
  record=dict(before,phase='preparing',prepared_at=datetime.datetime.now(datetime.timezone.utc).isoformat());write_journal(record)
  # On interruption the journal and stopped timers remain for reconciliation.
  # Neither this installer nor rollback changes the node service or its home.
  CODE.mkdir(mode=0o700);CONFIG.mkdir(mode=0o700)
  for name in FILES:
   if name.startswith('ops/node-backup/'):continue
   target=CODE/name;target.parent.mkdir(mode=0o700,parents=True,exist_ok=True);atomic(target,protected(BUNDLE/name))
  atomic(CODE/'install-files.json',protected(BUNDLE/'ops/chain/failover-install-files.json'));atomic(CONFIG/'node.json',encoded(before['profile']))
  peer=next(x for x in HOSTS if x!=host)
  run(['ssh-keygen','-q','-t','ed25519','-N','','-C','uain-failover-challenge-20261012-'+host,'-f',str(CONFIG/(peer+'_ed25519'))])
  atomic(CONFIG/'known_hosts',(HOSTS[peer]['ip']+' '+HOSTS[peer]['ssh']+'\n').encode())
  shutil.copytree(BACKUP,PENDING,ignore=shutil.ignore_patterns('__pycache__'))
  for name in ('node.py','coordinator.py'):atomic(PENDING/name,protected(BUNDLE/('ops/node-backup/'+name)))
  hashes=backup_hashes(PENDING);atomic(PENDING/'manifest.sha256',(''.join(v+'  '+str(BACKUP/k)+'\n' for k,v in sorted(hashes.items()))).encode())
  # Persist intent first: interrupted atomic exchange is reconciled from exact
  # hashes, not repeated blindly and accidentally swapped back.
  record.update(phase='exchange_started',candidate_backup_hashes=hashes);write_journal(record)
  exchange(BACKUP,PENDING);os.replace(PENDING,OLD);sync(OLD.parent)
  require(backup_hashes(BACKUP)==hashes and backup_hashes(OLD)==BASELINE)
  record['phase']='prepared';write_journal(record);return public(host)

def public(host):
 record=journal();require(record['host']==host and record['phase'] in ('prepared','authorized','verified','accepted'))
 peer=next(x for x in HOSTS if x!=host);key=protected(CONFIG/(peer+'_ed25519.pub')).decode().strip();require(PUB.fullmatch(key))
 return dict(host=host,profile_sha256=record['profile_sha256'],bundle_sha256=record['bundle_sha256'],challenge_public_key=key,ssh_host_key=HOSTS[host]['ssh'])

def authorize(host,peer_public):
 peer=next(x for x in HOSTS if x!=host);record=journal()
 require(set(peer_public)=={'host','profile_sha256','bundle_sha256','challenge_public_key','ssh_host_key'} and peer_public['host']==peer and peer_public['ssh_host_key']==HOSTS[peer]['ssh'] and peer_public['bundle_sha256']==record['bundle_sha256'] and peer_public['profile_sha256']==hashlib.sha256(encoded(profile(peer))).hexdigest())
 key=peer_public['challenge_public_key'];require(type(key)==str and PUB.fullmatch(key))
 line='from="'+HOSTS[peer]['ip']+'",restrict,command="/usr/bin/python3 -I /opt/uain-failover/ops/chain/failover-ssh.py" '+key
 with locked():
  require(record['phase']=='prepared');record.update(phase='authorizing',authorized_line=line);write_journal(record)
  old=protected(AUTHORIZED);require(line.encode() not in old.splitlines());atomic(AUTHORIZED,old.rstrip(b'\n')+b'\n'+line.encode()+b'\n')
  record['phase']='authorized';write_journal(record)
 return dict(host=host,peer=peer,authority='public probe and live source fence only')

def load_roles():
 path=CODE/'ops/chain/failover-backup.py';spec=importlib.util.spec_from_file_location('installed_roles',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def installed_files(record):
 raw=protected(CODE/'install-files.json');values=json.loads(raw);require(set(values)==FILES and hashlib.sha256(raw).hexdigest()==record['bundle_sha256'])
 for name,digest in values.items():
  target=BACKUP/Path(name).name if name.startswith('ops/node-backup/') else CODE/name
  require(type(digest)==str and HEX.fullmatch(digest) and hashlib.sha256(protected(target)).hexdigest()==digest)
 return values

def verify(host):
 record=journal();require(record['phase'] in ('authorized','verified','accepted'));require(backup_hashes(BACKUP)==record['candidate_backup_hashes']);installed_files(record)
 original_metadata(host);roles=load_roles();node=roles.f.Node(CONFIG/'node.json');actual=roles.role(node);require(actual['name']==('original_validator' if host=='uain-app-1' else 'original_fullnode'))
 peer=next(x for x in HOSTS if x!=host);nonce=os.urandom(32).hex()
 command=['ssh','-F','/dev/null','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+str(CONFIG/'known_hosts'),'-o','ConnectTimeout=10','-i',str(CONFIG/(peer+'_ed25519')),'root@'+HOSTS[peer]['ip'],'failover-probe']
 p=subprocess.run(command,input=json.dumps(dict(nonce=nonce)).encode(),capture_output=True,timeout=30);require(p.returncode==0 and len(p.stdout)<=131072);reply=json.loads(p.stdout)
 expected={k:v for k,v in profile(peer).items() if k in ('host','unit','home','binary_sha256','unit_sha256','genesis_sha256','chain_id','service_user','service_group')};expected['profile_sha256']=hashlib.sha256(encoded(profile(peer))).hexdigest()
 require(reply.get('nonce')==nonce and reply.get('inventory')==expected and reply.get('bundle_sha256')==record['bundle_sha256'] and reply.get('backup_node_sha256')==record['candidate_backup_hashes']['node.py'] and reply.get('backup_coordinator_sha256')==record['candidate_backup_hashes']['coordinator.py'])
 if record['phase']!='accepted':record['phase']='verified';write_journal(record)
 return dict(host=host,peer=peer,public_probe_verified=True,original_role=actual['name'])

def accepted_receipt(receipt,record,roles=True):
 require(receipt.get('cross_host_readback_verified') is True and receipt.get('offsite_verified') is True and receipt.get('signer_restores_started') is False)
 require(datetime.datetime.fromisoformat(receipt['created_at'])>=datetime.datetime.fromisoformat(record['prepared_at']))
 backups=receipt['backups'];require(len(backups)==2 and {x['manifest']['host'] for x in backups}==set(HOSTS))
 for item in backups:
  m=item['manifest'];require(item.get('full_tree_restore_verified') is True and item.get('restored_signer_started') is False and item.get('node_restarted') is True and m['binary_sha256']==DAEMON and m['genesis_sha256']==GENESIS and m['unit_sha256']==HOSTS[m['host']]['unit'])
  if roles:require(m['node_role']['name']==('original_validator' if m['host']=='uain-app-1' else 'original_fullnode') and m['node_role']['binding'] is None)
  name=item['name'];archive=[x for x in receipt['offsite'] if x['uri']=='s3://uain/node-backups/'+name];metadata=[x for x in receipt['offsite'] if x['uri']=='s3://uain/node-backups/'+Path(name).with_suffix('.json').name]
  require(len(archive)==1 and len(metadata)==1 and archive[0]['sha256']==item['ciphertext_sha256'] and all(x.get('readback_verified') is True for x in archive+metadata))

def timers(record):
 for unit,state in record['timers'].items():
  run(['systemctl','enable' if state['enabled']=='enabled' else 'disable',unit])
  if state['active']=='active':run(['systemctl','start',unit])

def accept(host,rollback=False):
 require(host=='uain-app-1');record=journal();done='rollback_accepted' if rollback else 'accepted';require(record['phase'] in (('rolled_back',done) if rollback else ('verified',done)))
 if not rollback:verify(host)
 else:require(backup_hashes(BACKUP)==BASELINE and not CONFIG.exists())
 # Do not hold custody lock: the unchanged service's vault wrapper owns it.
 if record['phase']!=done:
  require(all(flag('is-active',u) not in ('active','activating','deactivating') for u in TIMERS));run(['systemctl','start','uain-node-backup.service'],timeout=3100)
  require(run(['systemctl','show','uain-node-backup.service','-p','Result','--value'])=='success')
 receipt=json.loads(protected('/var/lib/uain-node-backups/last-success.json'));accepted_receipt(receipt,record,roles=not rollback)
 if not rollback:load_roles().paired(receipt['backups'])
 run(['/usr/bin/python3',str(BACKUP/'coordinator.py'),'check']);record.update(phase=done,acceptance_sha256=hashlib.sha256(encoded(receipt)).hexdigest());write_journal(record);timers(record)
 return dict(host=host,phase=record['phase'],fresh_paired_offsite_readback_verified=True,timers_restored=True)

def rollback(host):
 record=journal();require(record['host']==host and record['phase'] in ('preparing','exchange_started','prepared','authorized','verified','accepted','authorizing','rollback_exchange_started'))
 require(not any((EVIDENCE/name).exists() for name in ('fence.json','restore.json','promotion-started.json')));original_metadata(host);drain(host)
 with locked():
  current=backup_hashes(BACKUP);candidate=record.get('candidate_backup_hashes')
  # Reconcile either side of an interrupted atomic exchange from exact hashes.
  # Never blindly repeat an exchange and accidentally reinstall the candidate.
  if current==BASELINE:
   if PENDING.exists():
    if candidate is None:require(record['phase']=='preparing' and PENDING.resolve()==PENDING and PENDING.stat().st_uid==0 and not PENDING.stat().st_mode&0o077)
    else:require(backup_hashes(PENDING)==candidate)
    os.replace(PENDING,ROOT/'candidate-before-rollback')
   elif OLD.exists():require(candidate is not None and backup_hashes(OLD)==candidate)
   else:require(record['phase']=='preparing')
  else:
   require(candidate is not None and current==candidate)
   if PENDING.exists():require(not OLD.exists() and backup_hashes(PENDING)==BASELINE);os.replace(PENDING,OLD)
   require(OLD.exists() and backup_hashes(OLD)==BASELINE)
  if record.get('authorized_line'):
   old=protected(AUTHORIZED);line=record['authorized_line'].encode();atomic(AUTHORIZED,b'\n'.join(x for x in old.splitlines() if x!=line)+b'\n')
  record['phase']='rollback_exchange_started';write_journal(record)
  if current!=BASELINE:exchange(BACKUP,OLD)
  require(backup_hashes(BACKUP)==BASELINE)
  if EVIDENCE.exists():require(not any(EVIDENCE.iterdir()));EVIDENCE.rmdir()
  # These exact trees were created by this installer. Retain the code/keys for
  # interrupted-operation forensics rather than recursively deleting them.
  if CONFIG.exists():os.replace(CONFIG,ROOT/'configuration-before-rollback')
  if CODE.exists():os.replace(CODE,ROOT/'code-before-rollback')
  record['phase']='rolled_back';write_journal(record)
 return dict(host=host,phase='rolled_back',node_home_unchanged=True,timers_remain_drained=host=='uain-app-1')

def main():
 os.umask(0o077);resource.setrlimit(resource.RLIMIT_CORE,(0,0));host=socket.gethostname().split('.')[0]
 require(os.geteuid()==0 and host in HOSTS and len(sys.argv)==2);action=sys.argv[1]
 require(action in ('preflight','prepare','public','authorize','verify','accept','rollback','rollback-accept'))
 if action=='authorize':
  raw=sys.stdin.buffer.read(16385);require(len(raw)<=16384);result=authorize(host,json.loads(raw))
 elif action=='rollback-accept':result=accept(host,True)
 else:result=globals()[action](host)
 print(json.dumps(result))

if __name__=='__main__':
 try:main()
 except Exception:print('Pinned canonical installation refused or failed; drained timers and journal require review.',file=sys.stderr);sys.exit(1)

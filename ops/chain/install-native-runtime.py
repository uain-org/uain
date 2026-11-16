#!/usr/bin/python3 -I
"""Install public verifier/genesis and a keyless local socket service on app host.

No authority flag, database, node unit, signing identity or original genesis is
changed. A reset must supply and prove its new public epoch before repinning.
"""
import fcntl,hashlib,json,os,re,socket,stat,subprocess,sys,tempfile,time
from pathlib import Path

HERE=Path(__file__).resolve().parent
PUBLIC=Path('/opt/uain-chain/public-runtime')
CONFIG=Path('/etc/uain-native-rpc')
CODE=Path('/opt/uain-chain/native-rpc')
UNIT=Path('/etc/systemd/system/uain-native-rpc.service')
PUBLICATIONS=Path('/var/lib/uain-native/publications')
NODE='/opt/uain-review-runtime/node-v22.22.0-linux-x64/bin/node'
FIELDS={'schema','state_binary','state_sha256','genesis','genesis_sha256','chain_id','transport_sha256','source_revision','expires_at'}

def require(value):
 if not value:raise ValueError('Reviewed public native runtime precondition refused')
def digest(raw):return hashlib.sha256(raw).hexdigest()
def encoded(v):return (json.dumps(v,sort_keys=True)+'\n').encode()
def protected(path,limit=256*1024*1024):
 path=Path(path);require(path.is_absolute() and path.resolve()==path)
 for p in (path,*path.parents):
  s=p.stat();require(s.st_uid==0 and not s.st_mode&0o022)
 s=path.stat();require(path.is_file() and s.st_nlink==1 and s.st_size<=limit)
 return path.read_bytes()
def atomic(path,raw,mode):
 path=Path(path);fd,pending=tempfile.mkstemp(prefix='.'+path.name+'-',dir=path.parent)
 try:
  with os.fdopen(fd,'wb') as out:os.fchmod(out.fileno(),mode);out.write(raw);out.flush();os.fsync(out.fileno())
  os.replace(pending,path);fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
  try:os.fsync(fd)
  finally:os.close(fd)
 finally:Path(pending).unlink(missing_ok=True)
def public_directory(path,root):
 path=Path(path);root=Path(root);require(path==root or root in path.parents)
 # Only explicitly managed public directories may be made traversable. Never
 # chmod an existing system ancestor or follow a symlink into another tree.
 parent=root.parent;require(parent.resolve()==parent)
 for p in (parent,*parent.parents):
  s=p.stat();require(p.is_dir() and s.st_uid==0 and not s.st_mode&0o022 and s.st_mode&0o005==0o005)
 current=root
 for part in (None,*path.relative_to(root).parts):
  if part is not None:current=current/part
  if not current.exists():current.mkdir(mode=0o755)
  require(current.resolve()==current and current.is_dir())
  s=current.stat();require(s.st_uid==0 and not s.st_mode&0o022)
  os.chmod(current,0o755)
def immutable(path,raw,mode):
 path=Path(path)
 if path.exists():require(protected(path)==raw and path.stat().st_mode&0o777==mode)
 else:atomic(path,raw,mode)
def plan(approval_path):
 approval=Path(approval_path);raw=protected(approval,65536);require(not approval.stat().st_mode&0o077)
 a=json.loads(raw);require(type(a)==dict and set(a)==FIELDS and a['schema']=='uain-native-runtime-install-v1')
 require(type(a['expires_at'])==int and time.time()<a['expires_at']<=time.time()+3600)
 for key in ('state_sha256','genesis_sha256','transport_sha256'):require(type(a[key])==str and re.fullmatch('[a-f0-9]{64}',a[key]))
 require(type(a['source_revision'])==str and re.fullmatch('[a-f0-9]{40}',a['source_revision']))
 require(type(a['chain_id'])==str and re.fullmatch('uain-[a-z0-9][a-z0-9_-]{1,63}',a['chain_id']))
 state=protected(a['state_binary']);genesis=protected(a['genesis'],8*1024*1024);transport=protected(HERE/'native-rpc-transport.mjs',1024*1024)
 require(state.startswith(b'\x7fELF') and digest(state)==a['state_sha256'] and digest(genesis)==a['genesis_sha256'] and digest(transport)==a['transport_sha256'])
 require(json.loads(genesis)['chain_id']==a['chain_id'])
 config={'UAIN_AUTHORITY':'pilot','UAIN_NATIVE_PROJECTION':'1','UAIN_NATIVE_STATE_BINARY':'/opt/uain-native/public/state/'+a['state_sha256']+'/uain-state','UAIN_NATIVE_STATE_SHA256':a['state_sha256'],'UAIN_NATIVE_GENESIS':'/opt/uain-native/public/genesis/'+a['genesis_sha256']+'/genesis.json','UAIN_NATIVE_GENESIS_SHA256':a['genesis_sha256'],'UAIN_NATIVE_RPC':'http://127.0.0.1:26667','UAIN_NATIVE_PUBLICATION_DIR':str(PUBLICATIONS),'UAIN_NATIVE_CHAIN_ID':a['chain_id']}
 return a,state,genesis,transport,config
def prove(a,genesis):
 with tempfile.TemporaryDirectory(prefix='uain-public-runtime-',dir='/run') as temporary:
  root=Path(temporary);pin=root/'genesis.json';pin.write_bytes(genesis);os.chmod(pin,0o600);out=root/'proof.json'
  command=[a['state_binary'],'--genesis',str(pin),'--genesis-sha256',a['genesis_sha256'],'--rpc','http://127.0.0.1:26667','--out',str(out),'--max-age','120s']
  result=subprocess.run(command,input=encoded({'keys':['guardians','legacy','guardian_epoch_current']}),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=70)
  require(result.returncode==0);context=json.loads(out.read_bytes());require(context['chain_id']==a['chain_id'] and int(context['height'])>0)
  return {'height':context['height'],'app_hash':context['app_hash'],'chain_id':context['chain_id']}
def service(transport_sha):
 return f'''[Unit]
Description=UAIN keyless local public RPC capability
After=network-online.target uain-chain-shadow.service
[Service]
User=uain-native-rpc
Group=1000
RuntimeDirectory=uain-native-rpc
RuntimeDirectoryMode=0750
RuntimeDirectoryPreserve=yes
EnvironmentFile=/etc/uain-native-rpc/runtime.conf
ExecStartPre=/usr/bin/rm -f /run/uain-native-rpc/gateway.sock
ExecStart={NODE} {CODE}/{transport_sha}/native-rpc-transport.mjs host
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
RestrictAddressFamilies=AF_UNIX AF_INET
IPAddressDeny=any
IPAddressAllow=localhost
MemoryMax=256M
CPUQuota=50%
TasksMax=64
[Install]
WantedBy=multi-user.target
'''.encode()
def run(args):
 result=subprocess.run(args,capture_output=True,timeout=60);require(result.returncode==0);return result.stdout
def publish(record,unit,runtime):
 prior=CONFIG/'installed.json';pending=CONFIG/'pending.json'
 paths={'unit':UNIT,'runtime':CONFIG/'runtime.conf','receipt':prior}
 new={'unit':digest(unit),'runtime':digest(runtime),'receipt':digest(encoded(record))}
 if pending.exists():
  transaction=json.loads(protected(pending,65536));require(set(transaction)=={'old','next'})
  previous=transaction['next']
  require({k:v for k,v in previous.items() if k!='checkpoint'}=={k:v for k,v in record.items() if k!='checkpoint'})
  record=previous;new['receipt']=digest(encoded(record))
  require(set(transaction['old'])==set(paths))
  for key,path in paths.items():
   actual=digest(protected(path)) if path.exists() else None
   require(actual in (transaction['old'][key],new[key]))
 else:
  if prior.exists():
   previous=json.loads(protected(prior,65536));require(digest(protected(UNIT))==previous['unit_sha256'] and digest(protected(CONFIG/'runtime.conf'))==previous['runtime_config_sha256'])
  else:require(not UNIT.exists() and not (CONFIG/'runtime.conf').exists())
  transaction={'old':{key:digest(protected(path)) if path.exists() else None for key,path in paths.items()},'next':record}
  atomic(pending,encoded(transaction),0o600)
 # An interruption is completed forward only for the exact approved public
 # configuration. Mixed or unknown bytes never trigger a blind overwrite.
 atomic(CONFIG/'runtime.conf',runtime,0o600);atomic(UNIT,unit,0o644);atomic(prior,encoded(record),0o600)
 return record
def install(approval_path):
 require(os.geteuid()==0 and socket.gethostname().split('.')[0]=='uain-app-1')
 a,state,genesis,transport,config=plan(approval_path);checkpoint=prove(a,genesis)
 CONFIG.mkdir(mode=0o700,parents=True,exist_ok=True);require(CONFIG.resolve()==CONFIG and CONFIG.stat().st_uid==0 and CONFIG.stat().st_mode&0o777==0o700)
 public_directory(PUBLIC/'state'/a['state_sha256'],PUBLIC)
 public_directory(PUBLIC/'genesis'/a['genesis_sha256'],PUBLIC)
 public_directory(CODE/a['transport_sha256'],CODE)
 immutable(PUBLIC/'state'/a['state_sha256']/'uain-state',state,0o555)
 immutable(PUBLIC/'genesis'/a['genesis_sha256']/'genesis.json',genesis,0o444)
 immutable(CODE/a['transport_sha256']/'native-rpc-transport.mjs',transport,0o444)
 public_directory(PUBLICATIONS.parent,PUBLICATIONS.parent)
 if PUBLICATIONS.exists():
  require(PUBLICATIONS.resolve()==PUBLICATIONS and PUBLICATIONS.is_dir() and PUBLICATIONS.stat().st_uid==1000 and PUBLICATIONS.stat().st_mode&0o777==0o700)
 else:PUBLICATIONS.mkdir(mode=0o700);os.chown(PUBLICATIONS,1000,1000)
 unit=service(a['transport_sha256']);runtime=('UAIN_NATIVE_CHAIN_ID='+a['chain_id']+'\n').encode()
 with tempfile.TemporaryDirectory(prefix='uain-unit-',dir='/run') as temporary:
  candidate=Path(temporary)/'uain-native-rpc.service';candidate.write_bytes(unit);run(['systemd-analyze','verify',str(candidate)])
 # All code/configuration is public; no member or validator key is mounted.
 if subprocess.run(['getent','passwd','uain-native-rpc'],stdout=subprocess.DEVNULL).returncode:
  run(['useradd','--system','--user-group','--no-create-home','--shell','/usr/sbin/nologin','uain-native-rpc'])
 record={'schema':'uain-public-native-runtime-v1','source_revision':a['source_revision'],'transport_sha256':a['transport_sha256'],'state_sha256':a['state_sha256'],'genesis_sha256':a['genesis_sha256'],'chain_id':a['chain_id'],'unit_sha256':digest(unit),'runtime_config_sha256':digest(runtime),'checkpoint':checkpoint}
 record=publish(record,unit,runtime)
 run(['systemctl','daemon-reload']);run(['systemctl','enable','uain-native-rpc.service']);run(['systemctl','restart','uain-native-rpc.service'])
 run(['systemctl','is-active','--quiet','uain-native-rpc.service'])
 (CONFIG/'pending.json').unlink();fd=os.open(CONFIG,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)
 return {'runtime':record,'configmap':{'apiVersion':'v1','kind':'ConfigMap','metadata':{'name':'uain-native-config','namespace':'uain'},'data':config},'authority_selected':False}
if __name__=='__main__':
 try:
  os.umask(0o077);require(len(sys.argv)==2)
  fd=os.open('/run/lock/uain-native-runtime.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
  with os.fdopen(fd,'r+') as lock:
   info=os.fstat(lock.fileno());require(stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_nlink==1 and not info.st_mode&0o077)
   fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);print(json.dumps(install(sys.argv[1])))
 except Exception:print('Public native runtime installation refused; authority and original node are unchanged.',file=sys.stderr);sys.exit(1)

"""Repin the reviewed public runtime before resuming a fresh operating epoch."""
import hashlib,json,os,re,subprocess,time,uuid
from pathlib import Path

HELPER=Path('/opt/uain-native-runtime/ops/chain/install-native-runtime.py')
INSTALLED=Path('/etc/uain-native-rpc/installed.json')
PUBLIC=Path('/opt/uain-chain/public-runtime')
FIELDS={'UAIN_AUTHORITY','UAIN_NATIVE_PROJECTION','UAIN_NATIVE_STATE_BINARY','UAIN_NATIVE_STATE_SHA256','UAIN_NATIVE_GENESIS','UAIN_NATIVE_GENESIS_SHA256','UAIN_NATIVE_RPC','UAIN_NATIVE_PUBLICATION_DIR','UAIN_NATIVE_CHAIN_ID'}
def sha(raw):return hashlib.sha256(raw).hexdigest()
def protected(path,limit=65536):
 path=Path(path);info=path.stat()
 if path.resolve()!=path or not path.is_file() or info.st_uid!=0 or info.st_nlink!=1 or info.st_mode&0o022 or info.st_size>limit:raise ValueError('Reviewed root-owned native runtime artifact required')
 return path.read_bytes()
def configuration(record,authority):
 for key in ['state_sha256','genesis_sha256','transport_sha256']:
  if not re.fullmatch('[a-f0-9]{64}',record.get(key,'')):raise ValueError('Exact public runtime SHA required')
 if not re.fullmatch('[a-f0-9]{40}',record.get('source_revision','')) or not re.fullmatch('uain-[a-z0-9][a-z0-9_-]{1,63}',record.get('chain_id','')) or authority not in ['pilot','native']:raise ValueError('Exact reviewed runtime identity required')
 return {'UAIN_AUTHORITY':authority,'UAIN_NATIVE_PROJECTION':'1','UAIN_NATIVE_STATE_BINARY':'/opt/uain-native/public/state/'+record['state_sha256']+'/uain-state','UAIN_NATIVE_STATE_SHA256':record['state_sha256'],'UAIN_NATIVE_GENESIS':'/opt/uain-native/public/genesis/'+record['genesis_sha256']+'/genesis.json','UAIN_NATIVE_GENESIS_SHA256':record['genesis_sha256'],'UAIN_NATIVE_RPC':'http://127.0.0.1:26667','UAIN_NATIVE_PUBLICATION_DIR':'/var/lib/uain-native/publications','UAIN_NATIVE_CHAIN_ID':record['chain_id']}
def validate(saved):
 data=saved['data'];record=saved['runtime']
 if set(data)!=FIELDS or data!=configuration(record,data.get('UAIN_AUTHORITY')) or not re.fullmatch('[a-f0-9]{64}',saved.get('helper_sha256','')):raise ValueError('Mixed or unreviewed public runtime configuration')
 return data,record
def next_configuration(saved,genesis_sha256,chain_id):
 data,record=validate(saved)
 if not re.fullmatch('[a-f0-9]{64}',genesis_sha256) or not re.fullmatch('uain-reset-[0-9]{8}_[0-9]{6}',chain_id):raise ValueError('Fresh exact reset genesis required')
 return configuration({**record,'genesis_sha256':genesis_sha256,'chain_id':chain_id},data['UAIN_AUTHORITY'])
def check_current(saved,target,current):
 if current!=saved['data'] and current!=target:raise ValueError('Public native configuration changed outside the reviewed reset')
def capture():
 import runtime
 obj=json.loads(runtime.kube('get','configmap','uain-native-config','-o','json'))
 if obj.get('kind')!='ConfigMap' or obj.get('metadata',{}).get('name')!='uain-native-config':raise ValueError('Explicit public native ConfigMap required')
 saved={'data':obj['data'],'runtime':json.loads(protected(INSTALLED)),'helper_sha256':sha(protected(HELPER,1024*1024))}
 validate(saved)
 if sha(protected(HELPER.with_name('native-rpc-transport.mjs'),1024*1024))!=saved['runtime']['transport_sha256']:raise ValueError('Reviewed installed transport changed')
 return saved
def repin(epoch,staged,saved):
 import runtime,stack
 data=next_configuration(saved,staged['genesis_sha256'],staged['genesis']['chain_id'])
 check_current(saved,data,json.loads(runtime.kube('get','configmap','uain-native-config','-o','json')).get('data'))
 if sha(protected(HELPER,1024*1024))!=saved['helper_sha256'] or sha(protected(HELPER.with_name('native-rpc-transport.mjs'),1024*1024))!=saved['runtime']['transport_sha256']:raise ValueError('Reviewed native runtime helper changed')
 # The staged node genesis is owned by its service account. Copy only these
 # reviewed public bytes into the root-owned plan directory for the installer.
 source=Path(staged['home'])/'config/genesis.json'
 if source.resolve()!=source or not source.is_file() or source.stat().st_size>8*1024*1024:raise ValueError('Bounded regular staged public genesis required')
 raw=source.read_bytes()
 if sha(raw)!=staged['genesis_sha256'] or json.loads(raw)!=staged['genesis']:raise ValueError('Staged public reset genesis changed')
 directory=stack.epoch_dir(epoch);genesis=directory/'public-runtime-genesis.json'
 if genesis.exists():
  if protected(genesis,8*1024*1024)!=raw:raise ValueError('Immutable reset public genesis differs')
 else:
  with genesis.open('xb') as out:os.fchmod(out.fileno(),0o600);out.write(raw);out.flush();os.fsync(out.fileno())
 record=saved['runtime'];approval={'schema':'uain-native-runtime-install-v1','state_binary':str(PUBLIC/'state'/record['state_sha256']/'uain-state'),'state_sha256':record['state_sha256'],'genesis':str(genesis),'genesis_sha256':staged['genesis_sha256'],'chain_id':staged['genesis']['chain_id'],'transport_sha256':record['transport_sha256'],'source_revision':record['source_revision'],'expires_at':int(time.time())+1800}
 path=directory/('public-runtime-approval-'+uuid.uuid4().hex+'.json')
 with path.open('x') as out:os.fchmod(out.fileno(),0o600);json.dump(approval,out,sort_keys=True);out.flush();os.fsync(out.fileno())
 result=subprocess.run(['/usr/bin/python3','-I',str(HELPER),str(path)],capture_output=True,timeout=120)
 if result.returncode or len(result.stdout)>1024*1024:raise ValueError('Reviewed native public runtime repin failed')
 receipt=json.loads(result.stdout);obj=receipt['configmap'];expected={**data,'UAIN_AUTHORITY':'pilot'}
 if obj.get('kind')!='ConfigMap' or obj.get('metadata',{}).get('name')!='uain-native-config' or obj.get('data')!=expected or receipt.get('authority_selected') is not False:raise ValueError('Public runtime installer receipt differs')
 current=receipt['runtime']
 if any(current.get(k)!=approval[k] for k in ['state_sha256','genesis_sha256','chain_id','transport_sha256','source_revision']):raise ValueError('Installed runtime identity differs from reset approval')
 check_current(saved,data,json.loads(runtime.kube('get','configmap','uain-native-config','-o','json')).get('data'))
 obj={'apiVersion':'v1','kind':'ConfigMap','metadata':{'name':'uain-native-config','namespace':runtime.NAMESPACE},'data':data}
 runtime.kube('apply','-f','-',input=json.dumps(obj).encode())
 actual=json.loads(runtime.kube('get','configmap','uain-native-config','-o','json'))
 if actual.get('data')!=data:raise ValueError('Fresh native ConfigMap differs after apply')
 return {'chain_id':approval['chain_id'],'genesis_sha256':approval['genesis_sha256'],'authority':data['UAIN_AUTHORITY'],'helper_sha256':saved['helper_sha256'],'runtime':current}

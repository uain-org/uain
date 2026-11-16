#!/usr/bin/python3
"""Approved full SQL cutoff backup. Keys only flow from custody memory to stdin.

This module never starts a server or restores signer files. Production invocation
is solely through the serialized custody launcher and an exact root approval.
"""
import contextlib,hashlib,json,os,re,secrets,socket,stat,subprocess,threading,time
from pathlib import Path
from urllib.parse import urlsplit,unquote

POSTGRES='pgvector/pgvector:0.8.7-pg17@sha256:cd4ccfdaf62cbfeb5c6ee19ef0dd663406d4ed740c320b324d016a90e85385b3'
ROOT=Path('/var/lib/uain-custody/sql-cutoff')
LIMIT=128*1024*1024+36
PUBLIC_LIMIT=64*1024*1024
SOURCE_FILES={'chain/migration/'+name for name in ['capture.mjs','snapshot.mjs','public-policy.mjs','capsules.mjs','schema.mjs']}|{'ops/backup/capture-cutoff.mjs'}
FIELDS={'schema','epoch','source_revision','source_root','source_files','pilot_image','postgres_image','backup_cli_sha256','ledger_public_key','guardian','public_policy','source_manifest_digest','records_root','stopped_units','expires_at'}
HEX=re.compile(r'^[0-9a-f]{64}$')
SNAPSHOT=re.compile(rb'^snapshot ([0-9A-F]+-[0-9A-F]+-[0-9]+)\n$')
CLI='/app/dist/src/operations/backup-cli.js'

def require(ok):
 if not ok:raise ValueError('Approved SQL cutoff context refused')
def sha(data):return hashlib.sha256(data).hexdigest()
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def strict_json(raw,allow_floats=False):
 def pairs(items):
  out={}
  for k,v in items:require(k not in out);out[k]=v
  return out
 def reject(_):raise ValueError('Unsafe JSON refused')
 return json.loads(raw,object_pairs_hook=pairs,parse_constant=reject,**({} if allow_floats else {'parse_float':reject}))
def bounded(stream,limit):
 parts=[];n=0
 while True:
  chunk=stream.read(min(1024*1024,limit+1-n))
  if not chunk:break
  n+=len(chunk);require(n<=limit);parts.append(chunk)
 return b''.join(parts)
def protected_read(path,limit=PUBLIC_LIMIT):
 path=Path(path);require(path.is_absolute() and path.resolve()==path)
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  st=os.fstat(fd);require(stat.S_ISREG(st.st_mode) and st.st_uid==0 and stat.S_IMODE(st.st_mode)==0o600 and st.st_nlink==1 and st.st_size<=limit)
  with os.fdopen(fd,'rb',closefd=False) as src:data=bounded(src,limit)
  require((lambda q:(q.st_dev,q.st_ino,q.st_size,q.st_mtime_ns,q.st_uid,q.st_mode,q.st_nlink))(os.fstat(fd))==(st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_uid,st.st_mode,st.st_nlink));return data
 finally:os.close(fd)
def protected_tree(path):
 path=Path(path);require(path.is_absolute() and path.resolve()==path)
 for p in (path,*path.parents):
  st=p.lstat();require(stat.S_ISDIR(st.st_mode) and st.st_uid==0 and not st.st_mode&0o022)
def source_read(path):
 path=Path(path);protected_tree(path.parent)
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  st=os.fstat(fd);require(stat.S_ISREG(st.st_mode) and st.st_uid==0 and not st.st_mode&0o022 and st.st_nlink==1 and st.st_size<=PUBLIC_LIMIT)
  with os.fdopen(fd,'rb',closefd=False) as src:data=bounded(src,PUBLIC_LIMIT)
  require((lambda q:(q.st_dev,q.st_ino,q.st_size,q.st_mtime_ns,q.st_uid,q.st_mode,q.st_nlink))(os.fstat(fd))==(st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_uid,st.st_mode,st.st_nlink));return data
 finally:os.close(fd)
def save(path,data):
 path=Path(path);fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as out:out.write(data);out.flush();os.fsync(out.fileno())
def validate_approval(v,now=None):
 require(type(v)==dict and set(v)==FIELDS and v['schema']=='uain-sql-cutoff-approval-v1')
 require(re.fullmatch(r'20[0-9]{6}_[0-9]{6}',v['epoch']) and re.fullmatch('[a-f0-9]{40}',v['source_revision']))
 require(type(v['expires_at'])==int and (now or int(time.time()))<v['expires_at']<=(now or int(time.time()))+3600)
 require(re.fullmatch(r'/opt/[a-zA-Z0-9_./-]+',v['source_root']) and '..' not in Path(v['source_root']).parts)
 require(re.fullmatch(r'10\.98\.0\.1:5000/uain/pilot@sha256:[a-f0-9]{64}',v['pilot_image']) and v['postgres_image']==POSTGRES)
 for field in ('backup_cli_sha256','source_manifest_digest','records_root'):require(type(v[field])==str and HEX.fullmatch(v[field]))
 require(type(v['ledger_public_key'])==str and 0<len(v['ledger_public_key'])<=1024 and re.fullmatch('uain1[0-9a-f]{40}',v['guardian']))
 require(type(v['source_files'])==dict and 0<len(v['source_files'])<=32)
 for name,digest in v['source_files'].items():require(re.fullmatch(r'(chain/migration|ops/backup)/[a-zA-Z0-9_.-]+\.mjs',name) and HEX.fullmatch(digest))
 require(set(v['source_files'])==SOURCE_FILES)
 require(type(v['stopped_units'])==list and 0<len(v['stopped_units'])<=16 and len(set(v['stopped_units']))==len(v['stopped_units']))
 for unit in v['stopped_units']:require(re.fullmatch(r'uain[-a-zA-Z0-9_@.]*\.service',unit))
 p=v['public_policy'];require(type(p)==dict and set(p)=={'version','daily_credit_cap','bootstrap_operators'} and type(p['version'])==int and p['version']==1 and re.fullmatch('[1-9][0-9]*',p['daily_credit_cap']) and type(p['bootstrap_operators'])==int and 0<=p['bootstrap_operators']<=100)
 return v

def exact_snapshot(expected,actual):
 # Stricter than the rolling backup comparator: cutoff sequences may not advance.
 require(type(expected)==dict and set(expected)=={'tables','sequences'})
 require(canonical(expected)==canonical(actual))

def exact_cutoff(expected,actual):
 exact_snapshot(expected['full'],actual['full'])
 require(canonical(expected['sequence_state'])==canonical(actual['sequence_state']))

SEQUENCE_QUERY="""CREATE TEMP TABLE cutoff_sequence_state(sequencename text,last_value text,is_called boolean);
DO $$ DECLARE item record; BEGIN
 FOR item IN SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename LOOP
  EXECUTE format('INSERT INTO cutoff_sequence_state SELECT %L,last_value::text,is_called FROM %I.%I',item.sequencename,'public',item.sequencename);
 END LOOP;
END $$;
SELECT coalesce(json_agg(json_build_object('sequencename',sequencename,'last_value',last_value,'is_called',is_called) ORDER BY sequencename),'[]') FROM cutoff_sequence_state;"""

def sealer_pod(a,name):
 return {'apiVersion':'v1','kind':'Pod','metadata':{'name':name,'labels':{'app':'uain-cutoff-backup'}},'spec':{'nodeName':'uain-app-1','restartPolicy':'Never','activeDeadlineSeconds':1800,'automountServiceAccountToken':False,'securityContext':{'runAsUser':1000,'runAsGroup':1000,'fsGroup':1000},'containers':[{'name':'sealer','image':a['pilot_image'],'imagePullPolicy':'IfNotPresent','command':['node','-e','setInterval(()=>{},1000)'],'env':[{'name':'UAIN_PG_PASSWORD','valueFrom':{'secretKeyRef':{'name':'uain-env','key':'UAIN_PG_PASSWORD'}}},{'name':'UAIN_AUTHORITY','value':'native'},{'name':'DATABASE_URL','value':'postgres://uain:$(UAIN_PG_PASSWORD)@10.98.0.2:5432/uain'},{'name':'UAIN_DATA_DIR','value':'/var/lib/uain-pilot'}],'resources':{'requests':{'cpu':'100m','memory':'128Mi'},'limits':{'cpu':'2','memory':'3Gi'}},'securityContext':{'readOnlyRootFilesystem':True,'allowPrivilegeEscalation':False,'capabilities':{'drop':['ALL']}},'volumeMounts':[{'name':'ledger','mountPath':'/var/lib/uain-pilot','readOnly':True},{'name':'reviewed','mountPath':'/reviewed','readOnly':True}]}],'volumes':[{'name':'ledger','secret':{'secretName':'uain-ledger','defaultMode':0o440}},{'name':'reviewed','hostPath':{'path':a['source_root'],'type':'Directory'}}]}}
def cli_command(pod,command,name=None):
 require(command in {'seal','verify','dump','compare'})
 if command=='verify':require(type(name)==str and re.fullmatch('[a-zA-Z0-9_.-]{1,128}',name))
 else:require(name is None)
 return ['k3s','kubectl','-n','uain','exec','-i',pod,'-c','sealer','--','node',CLI,command]+([name] if name else [])
def network_command(name):return ['docker','network','create','--internal',name]
def restore_container(a,name,network):
 return ['docker','run','--detach','--name',name,'--network',network,'--read-only','--cpus=2','--memory=2g','--pids-limit=256','--security-opt=no-new-privileges','--tmpfs','/var/lib/postgresql/data:rw,size=2g,mode=0700','--tmpfs','/var/run/postgresql:rw,size=16m','--tmpfs','/tmp:rw,size=16m','-e','POSTGRES_HOST_AUTH_METHOD=trust',a['postgres_image']]

def execute(cmd,data=None,limit=PUBLIC_LIMIT,timeout=180,env=None):
 # Never return raw stderr: errors can include private SQL contents/connection data.
 p=subprocess.Popen(cmd,stdin=subprocess.PIPE if data is not None else subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=env)
 timer=threading.Timer(timeout,p.kill);timer.start();errors=[]
 def feed():
  try:p.stdin.write(data);p.stdin.close()
  except (OSError,ValueError) as error:errors.append(error)
 writer=threading.Thread(target=feed) if data is not None else None
 if writer:writer.start()
 try:
  result=bounded(p.stdout,limit);require(p.wait()==0)
  if writer:writer.join();require(not errors)
  return result
 except Exception:p.kill();p.wait();raise
 finally:
  timer.cancel()
  if writer:writer.join()

def capture(a,pod,snapshot='fresh'):
 context=canonical({'ledger_public_key':a['ledger_public_key'],'public_policy':a['public_policy']}).decode()
 raw=execute(['k3s','kubectl','-n','uain','exec',pod,'-c','sealer','--','node','/reviewed/ops/backup/capture-cutoff.mjs',snapshot,context])
 value=strict_json(raw);require(set(value)=={'migration_json','full','sequence_state'} and type(value['migration_json'])==str)
 value['migration_bytes']=value.pop('migration_json').encode();value['migration']=strict_json(value['migration_bytes'],allow_floats=True)
 require(value['migration']['manifest_digest']==a['source_manifest_digest'] and value['migration']['records_root']==a['records_root'])
 require(any(m['id']==a['guardian'] and m['licence']=='active' for m in value['migration']['reconciliation']['members']))
 return value

def check_drained(a):
 d=strict_json(execute(['k3s','kubectl','-n','uain','get','deployment','pilot','-o','json']))
 require(d['spec']['replicas']==0 and d.get('status',{}).get('replicas',0)==0)
 for resource in ['hpa','cronjobs','pods']:
  items=strict_json(execute(['k3s','kubectl','-n','uain','get',resource,'-o','json']))['items']
  if resource=='hpa':require(not any(i['spec']['scaleTargetRef'].get('name')=='pilot' for i in items))
  elif resource=='cronjobs':require(all(i['spec'].get('suspend') is True for i in items))
  else:require(not any(i['metadata'].get('labels',{}).get('app')=='pilot' and i.get('status',{}).get('phase') not in ('Succeeded','Failed') for i in items))
 for unit in a['stopped_units']:
  p=subprocess.run(['systemctl','is-active','--quiet',unit],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);require(p.returncode==3)

def pg_env(custody):
 # Read credentials solely inside custody; only named env fields reach pg_dump.
 environment=custody.kubernetes_secret('uain-env')
 url=urlsplit(environment['DATABASE_URL'].decode()) if 'DATABASE_URL' in environment else urlsplit('postgres://uain@10.98.0.2:5432/uain')
 password=unquote(url.password) if url.password else environment['UAIN_PG_PASSWORD'].decode()
 require(url.scheme in ('postgres','postgresql') and url.hostname=='10.98.0.2' and url.port in (None,5432) and url.username=='uain' and url.path=='/uain' and password and not url.query and not url.fragment)
 return {**os.environ,'PGHOST':url.hostname,'PGPORT':str(url.port or 5432),'PGUSER':unquote(url.username),'PGPASSWORD':password,'PGDATABASE':unquote(url.path[1:])}

def seal(a,pod,key,custody):
 p=subprocess.Popen(cli_command(pod,'seal'),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
 timer=threading.Timer(600,p.kill);timer.start();reader=None;chunks=[];errors=[]
 try:
  p.stdin.write(key+b'\n');p.stdin.flush()
  line=p.stdout.readline(129);matched=SNAPSHOT.fullmatch(line);require(matched is not None)
  snapshot=matched[1].decode();shared=capture(a,pod,snapshot)
  def drain():
   try:chunks.append(bounded(p.stdout,LIMIT))
   except Exception as e:errors.append(e);p.kill()
  reader=threading.Thread(target=drain);reader.start()
  cmd=['docker','run','--rm','-i','--network','host','--read-only','--cpus=2','--memory=2g','--pids-limit=256']
  for field in ['PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE']:cmd+=['-e',field]
  cmd+=[a['postgres_image'],'pg_dump','--format=custom','--no-owner','--no-privileges','--lock-wait-timeout=5000','--snapshot='+snapshot]
  dump=subprocess.Popen(cmd,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=pg_env(custody))
  dump_timer=threading.Timer(600,dump.kill);dump_timer.start()
  try:
   total=0
   while True:
    part=dump.stdout.read(1024*1024)
    if not part:break
    total+=len(part);require(total<=LIMIT-36);p.stdin.write(part)
   require(dump.wait()==0)
  finally:
   dump_timer.cancel()
   if dump.poll() is None:dump.kill();dump.wait()
  p.stdin.close();reader.join();require(not errors and p.wait()==0 and len(chunks)==1 and chunks[0].startswith(b'UAINBK01'))
  return chunks[0],shared,snapshot
 except Exception:p.kill();p.wait();raise
 finally:
  timer.cancel()
  if reader:reader.join()

def restore(a,blob,key,expected,network,name,sequence_state):
 execute(network_command(network));execute(restore_container(a,name,network))
 for _ in range(60):
  p=subprocess.run(['docker','exec',name,'pg_isready','-U','postgres'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10)
  if p.returncode==0:break
  time.sleep(1)
 else:raise ValueError('Disposable PostgreSQL did not become ready')
 # The decryptor has no mounted ledger, native homes or host paths. Plaintext
 # passes directly from its stdout to pg_restore, never a file or terminal.
 base=['docker','run','--rm','-i','--network',network,'--read-only','--cpus=2','--memory=2g','--pids-limit=256','--cap-drop=ALL','--security-opt=no-new-privileges','-e','UAIN_AUTHORITY=native','-e','DATABASE_URL=postgres://postgres@'+name+'/postgres','--entrypoint','node',a['pilot_image']]
 decoder=subprocess.Popen(base+[CLI,'dump'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
 target=subprocess.Popen(['docker','exec','-i',name,'pg_restore','-U','postgres','-d','postgres','--exit-on-error','--single-transaction','--no-owner','--no-privileges'],stdin=decoder.stdout,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 decoder.stdout.close()
 def stop_restore():
  for child in (decoder,target):
   if child.poll() is None:child.kill()
 restore_timer=threading.Timer(180,stop_restore);restore_timer.start()
 try:
  decoder.stdin.write(key+b'\n'+blob);decoder.stdin.close();require(decoder.wait(timeout=180)==0 and target.wait(timeout=180)==0)
 except Exception:stop_restore();decoder.wait();target.wait();raise
 finally:restore_timer.cancel()
 result=strict_json(execute(base+[CLI,'compare'],key+b'\n'+blob));require(result['status']=='match' and result['differences']==[])
 # The public rolling-backup snapshot is unchanged. The independent physical
 # census also catches setval(v,false), whose catalog last_value stays NULL.
 sequences=strict_json(execute(['docker','exec',name,'psql','-X','-q','-U','postgres','-d','postgres','-At','-v','ON_ERROR_STOP=1','-c',SEQUENCE_QUERY]))
 require(canonical(sequences)==canonical(sequence_state))
 return result

def backup_key(custody):
 kp=custody.vault();custody.verify_vault(kp)
 key=custody.attachment(kp,'keys/backup-key.txt').strip()
 require(re.fullmatch(rb'[a-fA-F0-9]{64}',key));return key

def run_approved(custody,approval_path):
 require(os.geteuid()==0 and socket.gethostname()=='uain-app-1')
 raw=protected_read(approval_path,1024*1024);a=validate_approval(strict_json(raw));protected_tree(a['source_root']);require(stat.S_IMODE(Path(a['source_root']).stat().st_mode)==0o755)
 # Explicit census covers every transitively imported public migration module.
 files={str(p.relative_to(a['source_root'])) for p in Path(a['source_root']).rglob('*') if not p.is_dir()}
 require(files==SOURCE_FILES)
 for p in Path(a['source_root']).rglob('*'):
  require(not p.is_symlink() and stat.S_IMODE(p.stat().st_mode)==(0o755 if p.is_dir() else 0o644))
 for name,digest in a['source_files'].items():require(sha(source_read(Path(a['source_root'])/name))==digest)
 # Serialized custody owns the lock; this module never supplies broad key access.
 check_drained(a);ROOT.mkdir(mode=0o700,parents=True,exist_ok=True);protected_tree(ROOT)
 root=ROOT/a['epoch'];root.mkdir(mode=0o700);protected_tree(root)
 receipt=None
 ident='uain-cutoff-'+sha(raw)[:12]+'-'+secrets.token_hex(4);pod=ident;network=ident;db=ident+'-db';name='uain-cutoff-'+a['epoch']+'.uainbk'
 try:
  execute(['k3s','kubectl','-n','uain','create','-f','-'],canonical(sealer_pod(a,pod)))
  execute(['k3s','kubectl','-n','uain','wait','--for=condition=Ready','pod/'+pod,'--timeout=120s'])
  got=execute(['k3s','kubectl','-n','uain','exec',pod,'-c','sealer','--','node','-e',"const f=require('node:fs'),c=require('node:crypto');console.log(c.createHash('sha256').update(f.readFileSync('"+CLI+"')).digest('hex'))"]).decode().strip();require(got==a['backup_cli_sha256'])
  before=capture(a,pod)
  key=backup_key(custody)
  blob,shared,snapshot=seal(a,pod,key,custody);exact_cutoff(before,shared)
  manifest=strict_json(execute(cli_command(pod,'verify',name),key+b'\n'+blob))
  require(manifest['sealed_sha256']==sha(blob) and manifest['sealed_bytes']==len(blob) and manifest['ledger_public_key']==a['ledger_public_key'])
  exact_snapshot(shared['full'],manifest['snapshot']);exact_cutoff(shared,capture(a,pod));check_drained(a)
  save(root/name,blob);save(root/'manifest.json',canonical(manifest)+b'\n');save(root/'source-snapshot.json',shared['migration_bytes']);save(root/'source-sequences.json',canonical(shared['sequence_state'])+b'\n')
  client=custody.s3();object_key='backups/cutoff/'+a['epoch']+'/'+name
  # Never replace historical ciphertext. A partial attempt gets a new epoch.
  objects=client.list_objects_v2(Bucket='uain',Prefix=object_key,MaxKeys=1);require(not objects.get('Contents'))
  client.put_object(Bucket='uain',Key=object_key,Body=blob,ContentType='application/octet-stream',IfNoneMatch='*')
  response=client.get_object(Bucket='uain',Key=object_key);require(response['ContentLength']==len(blob));downloaded=bounded(response['Body'],LIMIT);require(sha(downloaded)==sha(blob))
  verified=strict_json(execute(cli_command(pod,'verify',name),key+b'\n'+downloaded));require(canonical(verified)==canonical(manifest))
  compared=restore(a,downloaded,key,shared['full'],network,db,shared['sequence_state'])
  final=capture(a,pod);exact_cutoff(shared,final);check_drained(a)
  receipt={'schema':'uain-sql-cutoff-receipt-v1','epoch':a['epoch'],'approval_sha256':sha(raw),'source_revision':a['source_revision'],'pilot_image':a['pilot_image'],'postgres_image':a['postgres_image'],'backup_cli_sha256':a['backup_cli_sha256'],'source_manifest_digest':a['source_manifest_digest'],'records_root':a['records_root'],'source_snapshot_sha256':sha(shared['migration_bytes']),'backup_sha256':sha(blob),'backup_bytes':len(blob),'offsite_object':object_key,'same_exported_snapshot':snapshot,'full_snapshot_sha256':sha(canonical(shared['full'])),'tables':compared['tables'],'rows':compared['rows'],'sequences':compared['sequences'],'physical_sequence_state_sha256':sha(canonical(shared['sequence_state'])),'exact_sequences':True,'source_unchanged_through_restore':True,'restored_signer_files':False,'restored_server_started':False,'production_reset':False,'completed_at':int(time.time())}
 finally:
  # Identifiers are generated here; never remove anything outside this attempt.
  cleanup_failed=False
  for cmd in [['k3s','kubectl','-n','uain','delete','pod',pod,'--ignore-not-found=true','--wait=true'],['docker','rm','--force',db],['docker','network','rm',network]]:
   try:
    cleaned=subprocess.run(cmd,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=120)
    cleanup_failed=cleanup_failed or cleaned.returncode!=0
   except (OSError,subprocess.TimeoutExpired):
    cleanup_failed=True
  if receipt is not None and cleanup_failed:raise ValueError('Cutoff disposable cleanup failed')
 save(root/'receipt.json',canonical(receipt)+b'\n');print(json.dumps(receipt));return receipt

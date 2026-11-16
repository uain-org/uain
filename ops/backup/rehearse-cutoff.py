#!/usr/bin/python3
"""Real isolated qualification. Uses fictional keys/namespace, never production."""
import base64,hashlib,importlib.util,json,os,secrets,shutil,subprocess,sys,time
from pathlib import Path
STAGE=Path('/opt/uain-test/sql-cutoff-20261012')
sys.path.insert(0,str(STAGE/'src/ops/custody'))
import sql_cutoff as m
NAMESPACE='uain-cutoff-qualification'
IMAGE='10.98.0.1:5000/uain/pilot@sha256:2143ea2ff22433218ed8bb8bf6e91232fdeabecbf417bd826fd3f6b7038d182d'
def k(*args,data=None):return m.execute(['k3s','kubectl','-n',NAMESPACE,*args],data)
def create(value):return k('create','-f','-',data=m.canonical(value))
original_execute=m.execute
unit='uain-cutoff-qualification-writer.service'
unit_path=Path('/etc/systemd/system')/unit
public=STAGE/'public-source';data=STAGE/'fictional-ledger'
assert STAGE.is_dir() and os.geteuid()==0
assert not public.exists() and not data.exists() and not unit_path.exists()
for folder in [public,public/'chain',public/'chain/migration',public/'ops',public/'ops/backup']:
 folder.mkdir();folder.chmod(0o755)
for name in m.SOURCE_FILES:
 target=public/name;target.write_bytes((STAGE/'src'/name).read_bytes());target.chmod(0o644)
data.mkdir(mode=0o700);os.chown(data,1000,1000)
unit_path.write_text('[Unit]\nDescription=Isolated cutoff fixture\n[Service]\nType=oneshot\nExecStart=/bin/true\n');unit_path.chmod(0o644)
subprocess.run(['systemctl','daemon-reload'],check=True)
key=secrets.token_hex(32).encode();events=[];observed={}
try:
 m.execute(['k3s','kubectl','create','namespace',NAMESPACE])
 create({'apiVersion':'v1','kind':'Pod','metadata':{'name':'source-pg'},'spec':{'restartPolicy':'Never','automountServiceAccountToken':False,'containers':[{'name':'pg','image':m.POSTGRES,'env':[{'name':'POSTGRES_HOST_AUTH_METHOD','value':'trust'}],'resources':{'limits':{'cpu':'2','memory':'2Gi'}},'securityContext':{'readOnlyRootFilesystem':True},'volumeMounts':[{'name':'data','mountPath':'/var/lib/postgresql/data'},{'name':'run','mountPath':'/var/run/postgresql'},{'name':'tmp','mountPath':'/tmp'}]}],'volumes':[{'name':n,'emptyDir':{'medium':'Memory','sizeLimit':sz}} for n,sz in [('data','2Gi'),('run','16Mi'),('tmp','16Mi')]]}})
 create({'apiVersion':'v1','kind':'Service','metadata':{'name':'source-pg'},'spec':{'selector':{'fixture':'cutoff-pg'},'ports':[{'port':5432,'targetPort':5432}]}})
 k('label','pod','source-pg','fixture=cutoff-pg');k('wait','--for=condition=Ready','pod/source-pg','--timeout=120s')
 for _ in range(40):
  try:k('exec','source-pg','--','pg_isready','-U','postgres');break
  except Exception:time.sleep(1)
 else:raise ValueError('Fixture source PG not ready')
 host=k('get','service','source-pg','-o','jsonpath={.spec.clusterIP}').decode()
 url='postgres://postgres@'+host+':5432/postgres'
 env={**os.environ,'DATABASE_URL':url,'UAIN_AUTHORITY':'pilot','UAIN_DATA_DIR':'/fixture-data','UAIN_REQUIRE_PRIOR_ART':'0','UAIN_REQUIRE_BENEVOLENCE':'0','UAIN_REQUIRE_VERIFICATION_PLAN':'0','UAIN_REQUIRE_BOUND_PROOFS':'0'}
 initializer="""import{createRequire}from'node:module';import{newKey,proveWith}from'/fixture-key.mjs';const pg=createRequire('/app/package.json')('pg');let client=new pg.Client({connectionString:process.env.DATABASE_URL});await client.connect();await client.query('CREATE EXTENSION vector');await client.end();const db=await import('/app/dist/src/application/db.js');const result=await db.enrol({name:'Cutoff fixture',operator:'Isolated qualification',model:'fixture',proof:proveWith(newKey(),'enrol')});if(result.error)throw Error(result.error);await db.flushLog();await db.flushSeen();const store=await import('/app/dist/src/storage/store.js');const{NATIVE_SCHEMA}=await import('/app/dist/src/native/schema.js');await store.pool.query(NATIVE_SCHEMA);await store.pool.query(`CREATE TABLE cutoff_private_fixture(value text); INSERT INTO cutoff_private_fixture VALUES('private-fixture-only'); CREATE TABLE cutoff_vector_fixture(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,embedding vector(3),body jsonb); INSERT INTO cutoff_vector_fixture(embedding,body) VALUES('[0.25,0.5,1]','{\"fraction\":0.25}'); CREATE SEQUENCE cutoff_unused_sequence; INSERT INTO native_epochs(epoch,chain_id,genesis_sha256,retired_at) VALUES(repeat('a',64),'fictional-retired',repeat('a',64),now()); INSERT INTO native_publications(epoch,id,member,instance,evidence_digest,canonical_body,body,receipt,replica_digest) VALUES(repeat('a',64),'fictional-publication','fictional-member','fictional-instance',repeat('b',64),'{\"title\":\"fixture\"}','{\"title\":\"fixture\"}','{\"synthetic\":true}',repeat('c',64))`);const ledger=await import('/app/dist/src/ledger/ledger.js');await store.close();console.log(JSON.stringify({member:result.member.address,pem:ledger.publicKeyInfo().pem}));process.exit(0);"""
 cmd=['docker','run','--rm','--network','host','--cpus=2','--memory=2g','--pids-limit=256','--entrypoint','node','-v',str(data)+':/fixture-data','-v',str(STAGE/'src/public/worker/uain-key.mjs')+':/fixture-key.mjs:ro']
 for name in ['DATABASE_URL','UAIN_AUTHORITY','UAIN_DATA_DIR','UAIN_REQUIRE_PRIOR_ART','UAIN_REQUIRE_BENEVOLENCE','UAIN_REQUIRE_VERIFICATION_PLAN','UAIN_REQUIRE_BOUND_PROOFS']:cmd+=['-e',name]
 info=json.loads(m.execute(cmd+[IMAGE,'--input-type=module','-e',initializer],env=env).splitlines()[-1])
 create({'apiVersion':'v1','kind':'Secret','metadata':{'name':'uain-env'},'stringData':{'DATABASE_URL':url,'UAIN_PG_PASSWORD':'fictional-only'}})
 create({'apiVersion':'v1','kind':'Secret','metadata':{'name':'uain-ledger'},'data':{name:base64.b64encode((data/name).read_bytes()).decode() for name in ['ledger.key','log.salt']}})
 create({'apiVersion':'apps/v1','kind':'Deployment','metadata':{'name':'pilot'},'spec':{'replicas':0,'selector':{'matchLabels':{'app':'pilot'}},'template':{'metadata':{'labels':{'app':'pilot'}},'spec':{'containers':[{'name':'pilot','image':IMAGE}]}}}})
 a={'schema':'uain-sql-cutoff-approval-v1','epoch':time.strftime('%Y%m%d_%H%M%S',time.gmtime()),'source_revision':'a'*40,'source_root':str(public),'source_files':{name:m.sha((public/name).read_bytes()) for name in m.SOURCE_FILES},'pilot_image':IMAGE,'postgres_image':m.POSTGRES,'backup_cli_sha256':'0'*64,'ledger_public_key':info['pem'],'guardian':info['member'],'public_policy':{'version':1,'daily_credit_cap':'10000','bootstrap_operators':3},'source_manifest_digest':'0'*64,'records_root':'0'*64,'stopped_units':[unit],'expires_at':int(time.time())+1800}
 pod_builder=m.sealer_pod
 def fixture_pod(a,name):
  value=pod_builder(a,name)
  for item in value['spec']['containers'][0]['env']:
   if item['name']=='DATABASE_URL':item.pop('value');item['valueFrom']={'secretKeyRef':{'name':'uain-env','key':'DATABASE_URL'}}
  return value
 def routed(cmd,*args,**kwargs):
  cmd=list(cmd)
  if cmd[:4]==['k3s','kubectl','-n','uain']:cmd[3]=NAMESPACE
  if observed.get('mutate_unused') and cmd[:3]==['docker','exec',observed['mutate_unused']] and cmd[3]=='psql':
   observed['mutate_unused']=False
   original_execute(['docker','exec',cmd[2],'psql','-X','-U','postgres','-d','postgres','-At','-c',"SELECT setval('cutoff_unused_sequence',73,false)"])
   raw=original_execute(['docker','exec',cmd[2],'psql','-X','-U','postgres','-d','postgres','-At','-c',"SELECT last_value IS NULL FROM pg_sequences WHERE sequencename='cutoff_unused_sequence'"])
   assert raw.strip()==b't';observed['unused_mutated_with_catalog_null']=True
  if cmd[:2]==['docker','exec'] and len(cmd)>3 and cmd[3]=='psql':observed['restore_sequence_query']=True
  return original_execute(cmd,*args,**kwargs)
 m.execute=routed;m.sealer_pod=fixture_pod;m.ROOT=STAGE/'encrypted-results'
 m.pg_env=lambda custody:{**os.environ,'PGHOST':host,'PGPORT':'5432','PGUSER':'postgres','PGPASSWORD':'','PGDATABASE':'postgres'}
 # check_drained runs systemctl directly (real fixture inactive unit), kubectl
 # paths in process-cleanup and streaming CLI need the same namespace adapter.
 cli_builder=m.cli_command
 m.cli_command=lambda *args,**kwargs:[NAMESPACE if i==3 else v for i,v in enumerate(cli_builder(*args,**kwargs))]
 bootstrap='uain-cutoff-bootstrap';create(fixture_pod(a,bootstrap));k('wait','--for=condition=Ready','pod/'+bootstrap,'--timeout=120s')
 a['backup_cli_sha256']=k('exec',bootstrap,'--','node','-e',"const f=require('node:fs'),c=require('node:crypto');console.log(c.createHash('sha256').update(f.readFileSync('"+m.CLI+"')).digest('hex'))").decode().strip()
 context=m.canonical({'ledger_public_key':a['ledger_public_key'],'public_policy':a['public_policy']}).decode()
 k('exec','source-pg','--','psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-c','CREATE SCHEMA cutoff_unsupported; CREATE SEQUENCE cutoff_unsupported.untracked')
 try:
  try:k('exec',bootstrap,'--','node','/reviewed/ops/backup/capture-cutoff.mjs','fresh',context);raise AssertionError('untracked nonpublic sequence accepted')
  except ValueError:events.append('nonpublic-sequence-refused')
 finally:k('exec','source-pg','--','psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-c','DROP SCHEMA cutoff_unsupported CASCADE')
 original=json.loads(k('exec',bootstrap,'--','node','/reviewed/ops/backup/capture-cutoff.mjs','fresh',context));original['migration']=json.loads(original['migration_json'])
 a['source_manifest_digest']=original['migration']['manifest_digest'];a['records_root']=original['migration']['records_root'];k('delete','pod',bootstrap,'--wait=true')
 class Body:
  def __init__(self,blob):import io;self.stream=io.BytesIO(blob)
  def read(self,n):return self.stream.read(n)
 class Offsite:
  def __init__(self):self.objects={};self.tamper=False
  def list_objects_v2(self,**kw):return {'Contents':[]}
  def put_object(self,**kw):self.objects[kw['Key']]=kw['Body']
  def get_object(self,**kw):
   blob=self.objects[kw['Key']]
   if self.tamper:observed['offsite_tamper']=True;blob=blob[:-1]+bytes([blob[-1]^1])
   return {'ContentLength':len(blob),'Body':Body(blob)}
 class Custody:
  def __init__(self):self.store=Offsite()
  def vault(self):self.verified=False;return None
  def verify_vault(self,kp):assert kp is None;self.verified=True
  def attachment(self,kp,name):assert self.verified and name=='keys/backup-key.txt';return key
  def s3(self):return self.store
 custody=Custody();approval=STAGE/'fictional-approval.json';m.save(approval,m.canonical(a))
 # Silence only the generated namespace-scoped cleanup's direct subprocess;
 # keep production module exact and test transport adapter explicit in receipt.
 actual_run=m.subprocess.run
 def run(cmd,*args,**kwargs):
  if list(cmd)[:4]==['k3s','kubectl','-n','uain']:cmd=list(cmd);cmd[3]=NAMESPACE
  return actual_run(cmd,*args,**kwargs)
 m.subprocess.run=run
 receipt=m.run_approved(custody,approval)
 assert receipt['source_unchanged_through_restore'] and receipt['exact_sequences']
 assert not list(data.parent.glob('encrypted-results/**/ledger.key'))
 # Rolling backup compare permits sequence-ahead. Exercise the stricter
 # cutoff guard against real restored sequence values, after real compare.
 import copy
 blob=next(iter(custody.store.objects.values()));wrong=copy.deepcopy(original['sequence_state'])
 position=next(q for q in wrong if q['is_called']);position['last_value']=str(int(position['last_value'])+1)
 network='uain-cutoff-sequence-'+secrets.token_hex(4);database=network+'-db'
 observed['restore_sequence_query']=False
 try:
  try:m.restore(a,blob,key,original['full'],network,database,wrong);raise AssertionError('sequence mismatch accepted')
  except ValueError:
   assert observed['restore_sequence_query'];events.append('real-restored-sequence-mismatch-refused')
 finally:
  subprocess.run(['docker','rm','--force',database],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);subprocess.run(['docker','network','rm',network],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 network='uain-cutoff-unused-'+secrets.token_hex(4);database=network+'-db'
 assert next(q for q in original['full']['sequences'] if q['sequencename']=='cutoff_unused_sequence')['last_value'] is None
 observed['mutate_unused']=database
 try:
  try:m.restore(a,blob,key,original['full'],network,database,original['sequence_state']);raise AssertionError('physical unused sequence mismatch accepted despite catalog NULL')
  except ValueError:
   assert observed.get('unused_mutated_with_catalog_null');events.append('physical-unused-sequence-mismatch-refused-with-catalog-null')
 finally:
  subprocess.run(['docker','rm','--force',database],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);subprocess.run(['docker','network','rm',network],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 def next_approval(label):
  time.sleep(1);a['epoch']=time.strftime('%Y%m%d_%H%M%S',time.gmtime());path=STAGE/('fictional-'+label+'-approval.json');m.save(path,m.canonical(a));return path
 # Offsite object replacement is detected before any restore.
 custody.store.tamper=True
 try:m.run_approved(custody,next_approval('tamper'));raise AssertionError('tampered offsite ciphertext accepted')
 except ValueError:
  assert observed.get('offsite_tamper');events.append('offsite-ciphertext-replacement-refused')
 assert not (m.ROOT/a['epoch']/'receipt.json').exists();custody.store.tamper=False
 # Mutation in a nonpublished/private table after real restore must fail the
 # final source freeze check even though the migration manifest is unchanged.
 actual_restore=m.restore
 def mutate_after_restore(*args,**kwargs):
  value=actual_restore(*args,**kwargs)
  k('exec','source-pg','--','psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-c',"UPDATE cutoff_private_fixture SET value='changed-private-fixture'")
  observed['private_source_mutated_after_restore']=True
  return value
 m.restore=mutate_after_restore
 try:m.run_approved(custody,next_approval('drift'));raise AssertionError('private source drift accepted')
 except ValueError:
  assert observed.get('private_source_mutated_after_restore');events.append('actual-private-table-drift-after-restore-refused')
 finally:m.restore=actual_restore
 assert not (m.ROOT/a['epoch']/'receipt.json').exists()
 proof={'schema':'uain-sql-cutoff-qualification-v1','date':'2026-10-12','fixture':'isolated Kubernetes namespace, pgvector17 memory source; standalone pinned pilot image; fictional member/ledger/backup keys; mocked in-memory offsite byte transport; real internal Docker tmpfs restore; namespace/DB transport adapters only','production_data_read':False,'production_writes':False,'real_offsite_restore':False,'source_sha256':{name:m.sha((STAGE/'src'/name).read_bytes()) for name in ['ops/custody/sql_cutoff.py','ops/custody/test_sql_cutoff.py','ops/backup/capture-cutoff.mjs','ops/backup/rehearse-cutoff.py','chain/migration/capture.mjs','chain/migration/capture-snapshot.test.mjs']},'result':receipt,'additional_checks':events}
 (STAGE/'qualification-receipt.json').write_text(json.dumps(proof,indent=2,sort_keys=True)+'\n')
 print('SQL cutoff full shared-snapshot encryption/download/restore/exact comparison PASS; production and actual offsite untouched')
finally:
 # All these names/paths belong exclusively to this fixture invocation.
 subprocess.run(['k3s','kubectl','delete','namespace',NAMESPACE,'--ignore-not-found=true','--wait=true'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 unit_path.unlink(missing_ok=True);subprocess.run(['systemctl','daemon-reload'],stdout=subprocess.DEVNULL)
 shutil.rmtree(data,ignore_errors=True)

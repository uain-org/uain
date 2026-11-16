#!/usr/bin/env python3
"""Public-only artifact backup; custody supplies encryption/S3 secrets internally."""
import argparse,hashlib,json,os,re,subprocess,tempfile,types
from pathlib import Path
def source_module(name,path):
 # These source bytes are pinned by custody before secrets reach this child.
 # Compile the exact source, ignoring all unpinned checkout bytecode caches.
 path=Path(path);module=types.ModuleType(name);module.__file__=str(path)
 exec(compile(path.read_bytes(),str(path),'exec'),module.__dict__);return module
store=source_module('evidence_store',Path(__file__).resolve().parent/'store.py')
crypto=source_module('evidence_crypto',Path(__file__).resolve().parent.parent/'reset/archive.py');crypto.MAGIC=b'UAINEVIDENCE01'
IMAGE='rclone/rclone:1.75.1@sha256:45401ad7410db1d67ffdb58e19059ad20b0d8e0285a60e38bbec55cc1019c7a5'
def prepare(root,plan,destination,key):
 root=store.checked_root(root);destination=store.checked_root(destination);census=store.verify(root,plan['objects'])
 commitment={'plan_sha256':store.digest(root/'plan.json')[0],'objects':[{'sha256':i['sha256'],'bytes':i['bytes']} for i in census['verified']]}
 identity=hashlib.sha256(json.dumps(commitment,sort_keys=True,separators=(',',':')).encode()).hexdigest();name='uain-evidence-'+identity;target=destination/(name+'.evidencebk');manifest=destination/(name+'.json')
 if target.exists():
  receipt=json.loads(manifest.read_text());verified=crypto.verify(target,key)
  if receipt['commitment']!=commitment or receipt['encrypted']!=verified:raise ValueError('immutable existing evidence backup differs')
  return receipt
 with tempfile.TemporaryDirectory(prefix='.public-pack-',dir=destination) as scratch:
  packed=Path(scratch)/'public.tar';bundle=store.pack(root,packed,plan)
  with packed.open('rb') as stream:encrypted=crypto.seal(stream,target,key)
  restored_tar=Path(scratch)/'restored.tar'
  with restored_tar.open('xb') as output:crypto.open_verified(target,key,output)
  restored=store.restore(restored_tar,Path(scratch)/'restored',bundle['sha256'],bundle['plan_sha256'])
  if restored['available']!=census['available'] or restored['bytes']!=census['bytes'] or restored['missing']!=census['missing']:raise ValueError('public evidence restore census differs')
 receipt={'version':1,'kind':'uain-public-evidence-backup-v1','name':name,'commitment':commitment,'bundle':bundle,'encrypted':encrypted,'available':census['available'],'bytes':census['bytes'],'missing':census['missing'],'historical_unhosted_labels':len(plan['unavailable']),'local_restore_verified':True,'offsite_verified':False}
 store.immutable_json(manifest,receipt);return receipt

def remote_settings(env):
 required=['UAIN_BACKUP_S3_ENDPOINT','UAIN_BACKUP_S3_BUCKET','UAIN_BACKUP_S3_ACCESS_KEY_ID','UAIN_BACKUP_S3_SECRET_ACCESS_KEY']
 if any(not env.get(k) for k in required):raise ValueError('custody offsite configuration required')
 store.public_target(env['UAIN_BACKUP_S3_ENDPOINT'])
 bucket=env['UAIN_BACKUP_S3_BUCKET'];prefix=env.get('UAIN_BACKUP_S3_PREFIX','').strip('/')
 if not re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,62}',bucket) or prefix and (not re.fullmatch(r'[A-Za-z0-9_./-]{1,200}',prefix) or '..' in prefix.split('/')):raise ValueError('fixed offsite evidence destination required')
 mapped={'RCLONE_CONFIG_OFFSITE_TYPE':'s3','RCLONE_CONFIG_OFFSITE_PROVIDER':'Other','RCLONE_CONFIG_OFFSITE_ENDPOINT':env['UAIN_BACKUP_S3_ENDPOINT'],'RCLONE_CONFIG_OFFSITE_REGION':env.get('UAIN_BACKUP_S3_REGION',''),'RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID':env['UAIN_BACKUP_S3_ACCESS_KEY_ID'],'RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY':env['UAIN_BACKUP_S3_SECRET_ACCESS_KEY']}
 return 'offsite:'+bucket+'/'+(prefix+'/' if prefix else '')+'evidence/',mapped

def offsite(receipt,destination,key,env):
 destination=store.checked_root(destination);remote,mapped=remote_settings(env);name=receipt['name'];archive=destination/(name+'.evidencebk')
 if crypto.verify(archive,key)!=receipt['encrypted']:raise ValueError('evidence backup differs before offsite copy')
 # Binary readback goes to the verifier, never Docker logs / Promtail / Loki.
 base=['docker','run','--rm','--log-driver=none','--read-only','--tmpfs','/tmp','--cap-drop','ALL','--security-opt','no-new-privileges','--cpus','2','--memory','3g','--pids-limit','256']
 for field in mapped:base+=['-e',field]
 base+=['-v',str(destination)+':/backups:ro',IMAGE,'--config','']
 child_env={'PATH':os.defpath,'LANG':'C.UTF-8',**mapped}
 def run(args,output=subprocess.DEVNULL):
  result=subprocess.run(base+args,env=child_env,stdout=output,stderr=subprocess.DEVNULL,timeout=1800)
  if result.returncode:raise ValueError('offsite public evidence operation refused')
 for suffix in ['.evidencebk','.json']:run(['copyto','/backups/'+name+suffix,remote+name+suffix,'--immutable','--s3-no-check-bucket','--no-traverse','--retries','3'])
 with tempfile.TemporaryDirectory(prefix='.offsite-restore-',dir=destination) as scratch:
  downloaded=Path(scratch)/'remote.evidencebk'
  with downloaded.open('xb') as output:run(['cat',remote+name+'.evidencebk'],output)
  if crypto.verify(downloaded,key)!=receipt['encrypted']:raise ValueError('offsite evidence readback differs')
  restored_tar=Path(scratch)/'public.tar'
  with restored_tar.open('xb') as output:crypto.open_verified(downloaded,key,output)
  checked=store.restore(restored_tar,Path(scratch)/'restored',receipt['bundle']['sha256'],receipt['bundle']['plan_sha256'])
  if checked['available']!=receipt['available'] or checked['bytes']!=receipt['bytes'] or checked['missing']!=receipt['missing']:raise ValueError('offsite restored evidence census differs')
 final={**receipt,'offsite_verified':True,'offsite_restore_verified':True};store.immutable_json(destination/(name+'.offsite.json'),final)
 run(['copyto','/backups/'+name+'.offsite.json',remote+name+'.offsite.json','--immutable','--s3-no-check-bucket','--no-traverse'])
 return final

if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--root',required=True);parser.add_argument('--plan',required=True);parser.add_argument('--plan-sha256',required=True);parser.add_argument('--destination',required=True);args=parser.parse_args()
 if os.geteuid()!=0 or not str(Path(args.root)).startswith('/var/lib/uain-evidence/') or Path(args.destination)!=Path('/var/lib/uain-evidence-backups'):raise ValueError('root-owned fixed public evidence scope required')
 if store.digest(args.plan)[0]!=args.plan_sha256:raise ValueError('reviewed public evidence plan differs')
 plan=json.loads(Path(args.plan).read_text());key=os.environ.pop('UAIN_BACKUP_KEY','');crypto.key_bytes(key)
 result=offsite(prepare(args.root,plan,args.destination,key),args.destination,key,os.environ)
 print(json.dumps({k:result[k] for k in ['name','available','bytes','missing','historical_unhosted_labels','local_restore_verified','offsite_verified','offsite_restore_verified']},sort_keys=True))

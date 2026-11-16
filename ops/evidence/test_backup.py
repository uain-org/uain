import hashlib,importlib.util,io,json,marshal,os,shutil,struct,subprocess,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
import store,backup
class BackupTest(unittest.TestCase):
 def test_custody_helper_ignores_unpinned_dependency_bytecode_caches(self):
  for relative in ['ops/evidence/store.py','ops/reset/archive.py']:
   with tempfile.TemporaryDirectory() as temporary:
    root=Path(temporary);helpers=root/'ops/evidence';helpers.mkdir(parents=True);reset=root/'ops/reset';reset.mkdir()
    for name in ['backup.sh','backup.py','store.py']:shutil.copyfile(Path(__file__).parent/name,helpers/name)
    shutil.copyfile(Path(__file__).resolve().parent.parent/'reset/archive.py',reset/'archive.py')
    source=root/relative;metadata=source.stat();cache=Path(importlib.util.cache_from_source(str(source)));cache.parent.mkdir()
    marker=root/'bytecode-ran';code=compile("import os\nopen(os.environ['UAIN_SHADOW_CANARY'],'w').write('untrusted bytecode executed')\n",str(source),'exec')
    cache.write_bytes(importlib.util.MAGIC_NUMBER+struct.pack('<III',0,int(metadata.st_mtime),metadata.st_size)+marshal.dumps(code))
    result=subprocess.run(['/usr/bin/bash',str(helpers/'backup.sh'),'--help'],env={**os.environ,'UAIN_BACKUP_KEY':'11'*32,'UAIN_SHADOW_CANARY':str(marker)},capture_output=True)
    self.assertFalse(marker.exists(),'unpinned dependency bytecode ran with custody environment');self.assertEqual(result.returncode,0,result.stderr.decode())
 def test_custody_helper_ignores_unpinned_stdlib_shadow_with_key_environment(self):
  with tempfile.TemporaryDirectory() as temporary:
   root=Path(temporary);helpers=root/'ops/evidence';helpers.mkdir(parents=True);reset=root/'ops/reset';reset.mkdir()
   for name in ['backup.sh','backup.py','store.py']:shutil.copyfile(Path(__file__).parent/name,helpers/name)
   shutil.copyfile(Path(__file__).resolve().parent.parent/'reset/archive.py',reset/'archive.py')
   marker=root/'shadow-ran';(helpers/'json.py').write_text("import os\nopen(os.environ['UAIN_SHADOW_CANARY'],'w').write('untrusted shadow executed')\nraise RuntimeError('untrusted helper shadow')\n")
   result=subprocess.run(['/usr/bin/bash',str(helpers/'backup.sh'),'--help'],env={**os.environ,'UAIN_BACKUP_KEY':'11'*32,'UAIN_SHADOW_CANARY':str(marker)},capture_output=True)
   self.assertFalse(marker.exists(),'unpinned checkout module ran with custody environment');self.assertEqual(result.returncode,0,result.stderr.decode())
 def fixture(self,parent):
  root=parent/'store';root.mkdir(mode=0o700);out=parent/'backups';out.mkdir(mode=0o700)
  data=b'public original artifact';item={'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)};plan={'objects':[item],'unavailable':[{'label':'historical unknown'}],'records_root':'original-root','manifest_digest':'original-manifest'}
  store.retain(root,item,io.BytesIO(data));store.immutable_json(root/'plan.json',plan);return root,out,plan,'11'*32
 def test_encrypted_original_bundle_restores_and_replays_without_replacement(self):
  with tempfile.TemporaryDirectory() as directory:
   root,out,plan,key=self.fixture(Path(directory));receipt=backup.prepare(root,plan,out,key)
   self.assertTrue(receipt['local_restore_verified']);self.assertFalse(receipt['offsite_verified']);self.assertNotIn(key,json.dumps(receipt));self.assertEqual(receipt['available'],1)
   self.assertEqual(backup.prepare(root,plan,out,key),receipt)
   path=out/(receipt['name']+'.evidencebk');raw=bytearray(path.read_bytes());raw[-1]^=1;path.write_bytes(raw)
   with self.assertRaises(Exception):backup.prepare(root,plan,out,key)
 def test_offsite_claim_requires_actual_readback_and_exact_restored_objects(self):
  with tempfile.TemporaryDirectory() as directory:
   parent=Path(directory);root,out,plan,key=self.fixture(parent);receipt=backup.prepare(root,plan,out,key);remote={};corrupt=False
   env={'UAIN_BACKUP_S3_ENDPOINT':'https://example.org','UAIN_BACKUP_S3_BUCKET':'synthetic-only','UAIN_BACKUP_S3_ACCESS_KEY_ID':'synthetic-access','UAIN_BACKUP_S3_SECRET_ACCESS_KEY':'synthetic-secret'}
   def run(args,**kwargs):
    self.assertNotIn(key,repr(args));self.assertNotIn('synthetic-secret',repr(args));self.assertNotIn('UAIN_BACKUP_KEY',kwargs['env'])
    # The readback is the whole archive on stdout: it must never reach Docker's
    # logs (and from there Promtail and Loki). A host-only fix of 20 October 2026.
    self.assertIn('--log-driver=none',args[:args.index('--config')])
    command=args[args.index('--config')+2:]
    if command[0]=='copyto':remote[command[2]]=(out/Path(command[1]).name).read_bytes()
    elif command[0]=='cat':kwargs['stdout'].write((b'changed' if corrupt else remote[command[1]]))
    return SimpleNamespace(returncode=0)
   with patch.object(backup.subprocess,'run',run):
    final=backup.offsite(receipt,out,key,env);self.assertTrue(final['offsite_restore_verified']);self.assertTrue(final['offsite_verified'])
    corrupt=True
    with self.assertRaises(Exception):backup.offsite(receipt,out,key,env)
   with self.assertRaises(ValueError):backup.remote_settings({})
if __name__=='__main__':unittest.main()

import hashlib,io,json,os,tarfile,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import store
class EvidenceTest(unittest.TestCase):
 def test_store_refuses_foreign_owner_even_when_private_and_not_symlinked(self):
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory)
   with patch.object(store.os,'geteuid',return_value=root.stat().st_uid+1):
    with self.assertRaises(ValueError):store.checked_root(root)
 def test_exact_content_only_immutable_and_restore(self):
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory);data=b'public artifact';item={'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)}
   store.retain(root,item,io.BytesIO(data));store.retain(root,item,io.BytesIO(data))
   self.assertEqual((root/(item['sha256']+'.blob')).read_bytes(),data)
   self.assertEqual(store.verify(root,[item])['available'],1)
   with self.assertRaises(ValueError):store.retain(root,item,io.BytesIO(b'changed'))
   (root/(item['sha256']+'.blob')).write_bytes(b'changed')
   with self.assertRaises(ValueError):store.verify(root,[item])
 def test_public_backup_restore_and_recovery_exclude_secret_paths(self):
  with tempfile.TemporaryDirectory() as directory:
   parent=Path(directory);root=parent/'store';root.mkdir(mode=0o700);research=parent/'research';research.mkdir();secret=research/'.codex';secret.mkdir()
   data=b'public exact artifact';item={'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)};plan={'objects':[item]}
   (secret/'private.json').write_bytes(data);(research/'member-key.json').write_bytes(data);(research/'raw_ctgov.json').write_bytes(data)
   recovery=store.recover(root,plan,[str(research)])
   self.assertEqual([r['path'] for r in recovery['matched']],[str(research/'raw_ctgov.json')])
   store.immutable_json(root/'plan.json',plan);backup=parent/'public.tar';receipt=store.pack(root,backup,plan)
   restored=parent/'restored';self.assertEqual(store.restore(backup,restored,receipt['sha256'],receipt['plan_sha256'])['available'],1)
   self.assertEqual((restored/(item['sha256']+'.blob')).read_bytes(),data)
   (root/'plan.json').write_text('{}')
   with self.assertRaises(ValueError):store.pack(root,parent/'tampered.tar',plan)
   with self.assertRaises(ValueError):store.restore(backup,parent/'changed','0'*64,receipt['plan_sha256'])
   with self.assertRaises(FileExistsError):store.restore(backup,restored,receipt['sha256'],receipt['plan_sha256'])
 def test_capture_reports_only_verified_original_bytes_and_preserves_unavailable_labels(self):
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory);data=b'original public source';item={'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'references':[{'manifest':{'uri':'https://example.org/original'}}]};wrong={**item,'sha256':'0'*64}
   plan={'objects':[item,wrong],'records_root':'root','manifest_digest':'manifest','unavailable':[{'label':'original unhosted'}]}
   class Connection:
    def close(self):pass
   with patch.object(store,'retrieve',lambda uri:(io.BytesIO(data),Connection())):receipt=store.capture(root,plan)
   self.assertEqual(receipt['available'],1);self.assertEqual(receipt['missing'],['0'*64]);self.assertEqual(receipt['historical_unhosted_labels'],1)
   with self.assertRaises(ValueError):store.capture(root,plan,['f'*64])
 def test_public_https_and_declared_size_bound(self):
  for uri in ['http://example.org/data','https://user:secret@example.org/data','https://127.0.0.1/data','https://[fd00::1]/data','https://[::ffff:127.0.0.1]/data','https://example.org/data (saved locally)']:
   with self.assertRaises(ValueError):store.public_target(uri)
 def test_restore_refuses_unmanifested_blob_even_with_exact_archive_digest(self):
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory);plan=b'{"objects":[]}\n';archive=root/'extra.tar'
   with tarfile.open(archive,'w') as output:
    for name,data in [('plan.json',plan),('a'*64+'.blob',b'not in original public plan')]:
     entry=tarfile.TarInfo(name);entry.size=len(data);output.addfile(entry,io.BytesIO(data))
   with self.assertRaises(ValueError):store.restore(archive,root/'restored',store.digest(archive)[0],hashlib.sha256(plan).hexdigest())
if __name__=='__main__':unittest.main()

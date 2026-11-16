"""Memory-only keys and mock custody. Never opens a real vault."""
import base64
import contextlib
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import time
import types
import unittest
from unittest.mock import patch
import holder_release as h

@unittest.skipUnless(os.geteuid()==0,'Actual protected ancestor checks require a root-owned fixture tree')
class RealTrustedPathTest(unittest.TestCase):
 def test_real_protected_file_and_ancestors_without_replacing_trusted(self):
  with tempfile.TemporaryDirectory(dir='/root',prefix='holder-release-path-test-') as name:
   folder=Path(name);file=folder/'public-fixture';file.write_bytes(b'public fixture');file.chmod(0o600)
   self.assertEqual(h.read(file),b'public fixture')
   alias=folder/'alias';alias.symlink_to(file)
   with self.assertRaises(ValueError):h.read(alias)
   alias.unlink();os.link(file,alias)
   with self.assertRaises(ValueError):h.read(file)
   alias.unlink();file.chmod(0o666)
   with self.assertRaises(ValueError):h.read(file)

class HolderReleaseTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.files={};self.calls=[]
  self.old_trusted=h.trusted
  def fixture_trusted(path,directory=False):
   p=Path(path);self.assertTrue(p.is_absolute());self.assertTrue(p.is_relative_to(self.root))
   for x in [p,*p.parents]:
    if not x.is_relative_to(self.root):break
    s=x.lstat();h.require(not stat.S_ISLNK(s.st_mode) and not s.st_mode&0o022)
    if x!=p or directory:h.require(stat.S_ISDIR(s.st_mode))
   if not directory:h.require(stat.S_ISREG(p.stat().st_mode) and p.stat().st_nlink==1)
   return p
  self.patches=[patch.object(h,'ROOT',self.root/'holder'),patch.object(h,'LOCK',self.root/'lock'),patch.object(h,'UID',os.geteuid()),patch.object(h,'trusted',fixture_trusted)]
  for p in self.patches:p.start()
  self.c=types.SimpleNamespace(ROOT=self.root,VAULT=self.root/'uain.kdbx')
  def save(files):
   self.calls.append('save');self.files=dict(files);self.c.VAULT.write_bytes(b'ENCRYPTED-FIXTURE:'+h.canonical({k:h.sha(v) for k,v in files.items()}));self.c.VAULT.chmod(0o600)
  self.c.save_vault=save;self.c.vault=lambda:None;self.c.verify_vault=lambda kp:len(self.files);self.c.records=lambda kp:[{'name':k,'sha256':h.sha(v),'bytes':len(v)} for k,v in self.files.items()];self.c.attachment=lambda kp,name:self.files[name]
  self.c.backup=self.backup
  seed=os.urandom(32);pub,_=h.native.ed25519(seed);self.release_pub=h.b64(pub)
  self.release_patch=patch.object(h,'RELEASE_PUBLIC',self.release_pub);self.release_patch.start()
  save({'keys/release-key.json':h.canonical({'public_key':self.release_pub,'private_key':h.b64(seed)}),'unrelated':b'preserved'})
 def tearDown(self):
  self.release_patch.stop()
  for p in reversed(self.patches):p.stop()
  self.tmp.cleanup()
 def backup(self):
  self.calls.append('backup');package=io.BytesIO();raw=self.c.VAULT.read_bytes()
  with h.tarfile.open(fileobj=package,mode='w') as t:
   for name,data in [('uain.kdbx',raw),('manifest.json',h.canonical({'sha256':{'uain.kdbx':h.sha(raw)}}))]:
    info=h.tarfile.TarInfo(name);info.size=len(data);t.addfile(info,io.BytesIO(data))
  name='uain-custody-20261105T010101Z.tar';folder=self.root/'backups';folder.mkdir(exist_ok=True);(folder/name).write_bytes(package.getvalue())
  (self.root/'last-backup.json').write_bytes(h.canonical({'backup':name,'sha256':h.sha(package.getvalue()),'spaces':'s3://uain/custody/'+name,'database':'10.98.0.2:/var/backups/uain-custody/'+name,'readback':'byte-identical, authenticated vault and every attachment verified'}))
 def provision(self):return h.provision(self.c,h.sha(self.c.VAULT.read_bytes()))
 def bundle(self):
  self.provision();now=int(time.time()*1000);art=self.root/'art';art.mkdir();(art/'tools').mkdir()
  pins={};items=[]
  # Fixture tool bytes are explicitly substituted constants, never production tools.
  for name in h.TOOLS:
   data=('fixture-'+name).encode();(art/'tools'/name).write_bytes(data);pins[name]=h.sha(data);items.append({'path':'tools/'+name,'sha256':h.sha(data),'size':len(data)})
  gen=b'fixture-genesis';(art/'tools/native-admission-genesis.json').write_bytes(gen)
  fixed=dict(h.PINS,genesisSha256=h.sha(gen));items.append({'path':'tools/native-admission-genesis.json','sha256':h.sha(gen),'size':len(gen)})
  self.tool_patch=patch.object(h,'TOOLS',pins);self.tool_patch.start();self.addCleanup(self.tool_patch.stop)
  self.pin_patch=patch.object(h,'PINS',fixed);self.pin_patch.start();self.addCleanup(self.pin_patch.stop)
  m={'schema':'baink-holder-release-v1','sequence':1,'issuedAt':now-1000,'expiresAt':now+86400000,'platform':'linux/amd64','image':'baink.money/baink-holder@sha256:'+'d'*64,'pins':fixed,'files':items}
  manifest=self.root/'manifest.json';manifest.write_bytes(h.canonical(m));bootstrap=self.root/'bootstrap.mjs';bootstrap.write_bytes(b'// reviewed bootstrap\nconst installed = true;\n')
  install=self.root/'install';install.mkdir();entry=install/'entry.mjs';entry.write_bytes(b'// reviewed installer\n');inv=[{'path':'entry.mjs','sha256':h.sha(entry.read_bytes()),'size':entry.stat().st_size}]
  p={'schema':'baink-holder-release-approval-v1','expectedVaultSha256':h.sha(self.c.VAULT.read_bytes()),'manifestPath':str(manifest),'manifestSha256':h.sha(manifest.read_bytes()),'artifactsDirectory':str(art),'bootstrapPath':str(bootstrap),'bootstrapSha256':h.sha(bootstrap.read_bytes()),'installerDirectory':str(install),'installerFiles':inv,'installerInventorySha256':h.sha(h.canonical(inv)),'installerEntry':'entry.mjs','installerBaseURL':'https://baink.money/wallet/installer/','releaseBaseURL':'https://baink.money/wallet/releases/','minimumSequence':0,'issuedAt':now-1000,'expiresAt':now+86400000}
  profile=self.root/'profile.json';profile.write_bytes(h.canonical(p));return profile,p,m
 def test_provision_preserves_inventory_and_never_prints_seed(self):
  old=self.files.copy();out=io.StringIO()
  with contextlib.redirect_stdout(out):result=self.provision()
  self.assertEqual(out.getvalue(),'');self.assertEqual(set(result),{'publicKey'});self.assertEqual({k:self.files[k] for k in old},old)
  self.assertEqual(self.calls[-2:],['save','backup']);self.assertTrue((h.ROOT/'provision.json').exists())
  seed=h.native.strict_json(self.files[h.KEY])['private_key'];self.assertNotIn(seed,json.dumps(result));self.assertTrue(list(h.ROOT.glob('before-*.kdbx')))
 def test_wrong_global_vault_digest_refuses_mutation(self):
  with self.assertRaises(ValueError):h.provision(self.c,'0'*64)
  self.assertNotIn(h.KEY,self.files)
 def test_backup_failure_retains_same_key_and_blocks_signing(self):
  self.c.backup=lambda:(_ for _ in ()).throw(RuntimeError('offsite unavailable'))
  with self.assertRaises(RuntimeError):self.provision()
  key=self.files[h.KEY];self.assertFalse((h.ROOT/'provision.json').exists())
  self.c.backup=self.backup;self.provision();self.assertEqual(self.files[h.KEY],key)
 def test_actual_ed25519_signatures_and_idempotent_sequence(self):
  profile,p,m=self.bundle();result=h.sign_public_bundle(self.c,profile)
  try:
   from Cryptodome.Signature import eddsa
   verify=lambda public,message,signature:eddsa.new(eddsa.import_public_key(public),'rfc8032').verify(message,signature)
  except ImportError:
   from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
   verify=lambda public,message,signature:Ed25519PublicKey.from_public_bytes(public).verify(signature,message)
  decode=lambda s:base64.urlsafe_b64decode(s+'='*((-len(s))%4))
  verify(decode(result['authority']['payload']['holderPublicKey']),Path(p['manifestPath']).read_bytes(),decode(result['manifestSignature']))
  verify(decode(self.release_pub),Path(p['bootstrapPath']).read_bytes(),decode(result['bootstrapSignature']))
  verify(decode(self.release_pub),b'UAIN/holder-release-authority/v1\n'+h.canonical(result['authority']['payload']),decode(result['authority']['signature']))
  self.assertEqual(h.sign_public_bundle(self.c,profile),result)
 def test_versioned_installer_scope_is_closed_and_sequence_bound(self):
  profile,p,m=self.bundle();folder=Path(p['installerDirectory']);(folder/'entry.mjs').unlink()
  names=['application.mjs','cli.mjs','filesystem.mjs','module-references.mjs','release.mjs'];items=[]
  for name in names:
   raw=('// fixture '+name).encode();(folder/name).write_bytes(raw);items.append({'path':name,'size':len(raw),'sha256':h.sha(raw)})
  base='https://baink.money/wallet/installers/1-'+'a'*40+'/'
  p.update(installerEntry='cli.mjs',installerFiles=items,installerInventorySha256=h.sha(h.canonical(items)),installerBaseURL=base)
  profile.write_bytes(h.canonical(p));self.assertEqual(h.validate(profile)[1]['installerBaseURL'],base)
  for bad in [base.replace('https:','http:'),base.replace('baink.money','evil.test'),base.replace('baink.money','user@baink.money'),base.replace('baink.money','baink.money:443'),base+'?x=1',base+'#x',base+'\n',base+' ',base.replace('https:','HTTPS:'),base+'extra/',base.replace('/1-','/01-'),base.replace('/1-','/2-'),base.replace('a'*40,'A'*40),base.replace('a'*40,'a'*8),base.replace('/installers/','/installers/../installers/'),base.replace('/1-','/%31-')]:
   profile.write_bytes(h.canonical(dict(p,installerBaseURL=bad)))
   with self.assertRaises(ValueError,msg=bad):h.validate(profile)
  profile.write_bytes(h.canonical(dict(p,installerEntry='application.mjs')))
  with self.assertRaises(ValueError):h.validate(profile)
  profile.write_bytes(h.canonical(dict(p,installerFiles=items[:-1],installerInventorySha256=h.sha(h.canonical(items[:-1])))))
  with self.assertRaises(ValueError):h.validate(profile)

 def test_changed_review_pins_bootstrap_inventory_and_unknown_fields_refused(self):
  profile,p,m=self.bundle()
  for update in [{'extra':True},{'bootstrapSha256':'0'*64},{'installerInventorySha256':'0'*64},{'releaseBaseURL':'https://evil.invalid/'}]:
   profile.write_bytes(h.canonical(dict(p,**update)))
   with self.assertRaises(ValueError):h.sign_public_bundle(self.c,profile)
  profile.write_bytes(h.canonical(p));m['pins']=dict(m['pins'],reviewer='wrong');Path(p['manifestPath']).write_bytes(h.canonical(m));p['manifestSha256']=h.sha(h.canonical(m));profile.write_bytes(h.canonical(p))
  with self.assertRaises(ValueError):h.sign_public_bundle(self.c,profile)
 def test_json_bootstrap_and_symlinks_extra_artifacts_refused(self):
  profile,p,m=self.bundle();Path(p['bootstrapPath']).write_bytes(b'{"malicious":true}');p['bootstrapSha256']=h.sha(Path(p['bootstrapPath']).read_bytes());profile.write_bytes(h.canonical(p))
  with self.assertRaises(ValueError):h.sign_public_bundle(self.c,profile)
  for path in ['../escape','wallet/secret.json','.env','tool/private.key']:
   with self.assertRaises(ValueError):h.path_name(path)
  folder=Path(p['installerDirectory']);(folder/'extra').write_bytes(b'no')
  with self.assertRaises(ValueError):h.inventory(p['installerFiles'],folder)
  (folder/'extra').unlink();entry=folder/'entry.mjs';entry.unlink();entry.symlink_to(profile)
  with self.assertRaises(ValueError):h.inventory(p['installerFiles'],folder)
 def test_replaced_backup_receipt_blocks_signing(self):
  profile,p,m=self.bundle();(self.root/'last-backup.json').write_bytes(b'{}')
  with self.assertRaises(ValueError):h.sign_public_bundle(self.c,profile)
 def test_same_sequence_changed_profile_and_rollback_refused(self):
  profile,p,m=self.bundle();h.sign_public_bundle(self.c,profile)
  p['expiresAt']+=1000;profile.write_bytes(h.canonical(p))
  with self.assertRaises(ValueError):h.sign_public_bundle(self.c,profile)
  p['expiresAt']-=1000;m['sequence']=0;Path(p['manifestPath']).write_bytes(h.canonical(m));p['manifestSha256']=h.sha(h.canonical(m));profile.write_bytes(h.canonical(p))
  with self.assertRaises(ValueError):h.sign_public_bundle(self.c,profile)
 def test_future_expired_and_overlong_approval_refused(self):
  profile,p,m=self.bundle();now=int(time.time()*1000)
  for issued,expires in [(now+10000,now+20000),(now-20000,now-10000),(now-1000,now+366*86400000)]:
   profile.write_bytes(h.canonical(dict(p,issuedAt=issued,expiresAt=expires)))
   with self.assertRaises(ValueError):h.sign_public_bundle(self.c,profile)
 def test_artifact_mutation_and_unbacked_ciphertext_refused(self):
  profile,p,m=self.bundle();tool=Path(p['artifactsDirectory'])/m['files'][0]['path'];tool.write_bytes(b'mutated')
  with self.assertRaises(ValueError):h.sign_public_bundle(self.c,profile)
 def test_file_open_rejects_hardlinks_and_group_writes(self):
  file=self.root/'input';file.write_bytes(b'public');file.chmod(0o660)
  with self.assertRaises(ValueError):h.read(file)
  file.chmod(0o600);os.link(file,self.root/'linked')
  with self.assertRaises(ValueError):h.read(file)
 def test_real_trusted_rejects_world_writable_ancestor(self):
  with self.assertRaises(ValueError):self.old_trusted('/tmp',True)
 def test_t4_a_stale_identical_pending_file_is_adopted_and_a_different_one_refused(self):
  folder=self.root/'pending-fixture';folder.mkdir(mode=0o700);target=folder/'state.json';pending=folder/'state.json.pending'
  pending.write_bytes(b'same bytes');pending.chmod(0o600);h.write(target,b'same bytes')
  self.assertEqual(target.read_bytes(),b'same bytes');self.assertFalse(pending.exists())
  pending.write_bytes(b'other bytes');pending.chmod(0o600)
  with self.assertRaises(ValueError):h.write(target,b'new bytes')
  self.assertEqual(target.read_bytes(),b'same bytes');self.assertEqual(pending.read_bytes(),b'other bytes')
  pending.unlink();outside=self.root/'outside';outside.write_bytes(b'new bytes');outside.chmod(0o600);pending.symlink_to(outside)
  with self.assertRaises(ValueError):h.write(target,b'new bytes')
  self.assertEqual(target.read_bytes(),b'same bytes')

class QualifiedDaemonPinTest(unittest.TestCase):
 def test_central_replay_daemon_and_original_proof_reader_pins(self):
  self.assertEqual(h.TOOLS['uaind'],'1604415b7302bf70236d50e6c999b7ab95d3029da697090f6bac08cddaee91a6')
  self.assertEqual(h.TOOLS['uain-state'],'136698192e9e38323a552f1e2da2eea5b9b90e3d6e7de11116d72ee28c826860')
  self.assertEqual(h.PINS['genesisSha256'],'54140a9243c4591ccc9f2e9d49543fc68b87b3e0045416174c232e9dd498f8ff')

if __name__=='__main__':unittest.main()

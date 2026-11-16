import importlib.util
import io
import json
import tempfile
from pathlib import Path
import unittest
from types import SimpleNamespace
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('failover',Path(__file__).with_name('failover-node.py'))
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)

class FailoverTest(unittest.TestCase):
 def test_profile_rejects_arbitrary_host_unit_home_and_ports(self):
  base=dict(host='uain-app-1',unit='uain-failover-fixture-20261012.service',unit_sha256='c'*64,home='/opt/uain-test/failover-20261012/node',binary='/opt/uain-test/failover-20261012/uaind',binary_sha256='a'*64,genesis_sha256='b'*64,chain_id='uain-failover-fixture-20261012',rpc_port=38657,p2p_port=38656,p2p_ip='10.98.0.1',root='/opt/uain-test/failover-20261012/evidence',service_user='uain-chain',service_group='uain-chain')
  f.validate_profile(base)
  for field,value in [('host','elsewhere'),('unit','ssh.service'),('home','/root'),('binary','/bin/sh'),('rpc_port',22),('p2p_ip','0.0.0.0'),('root','/etc'),('service_user','nobody'),('service_group','nogroup')]:
   with self.subTest(field=field),self.assertRaises(ValueError):f.validate_profile({**base,field:value})
  with self.assertRaises(ValueError):f.validate_profile({**base,'unknown':True})
 def test_checkpoint_exact_and_source_reachability_required(self):
  checkpoint=dict(chain_id='fixture',height=17,block_hash='a'*64,app_hash='b'*64,genesis_sha256='c'*64)
  f.check_checkpoint(checkpoint,checkpoint)
  for field in checkpoint:
   with self.subTest(field=field),self.assertRaises(ValueError):f.check_checkpoint(checkpoint,{**checkpoint,field:'changed'})
  with self.assertRaises(ValueError):f.require_live_fence(None,{})
 def test_fence_proof_is_fresh_and_bound_to_stopped_snapshot(self):
  proof=dict(fenced=True,source_host='uain-app-1',fence_id='a'*32,tree={'sha256':'b'*64},signing_state={'sha256':'c'*64,'height':18},inventory={'profile_sha256':'d'*64},checkpoint={'height':17},observed_at=100)
  f.require_live_fence(proof,proof,now=120)
  for changed in [{'fenced':False},{'source_host':'uain-db-1'},{'fence_id':'d'*32},{'tree':{}},{'signing_state':{}},{'observed_at':1},{'observed_at':125}]:
   with self.subTest(changed=changed),self.assertRaises(ValueError):f.require_live_fence({**proof,**changed},proof,now=120)
 def test_tree_rejects_symlinks_and_preserves_modes(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);p=root/'state';p.write_bytes(b'stopped state');a=f.tree(root);p.chmod(0o600);b=f.tree(root)
   self.assertNotEqual(a,b);(root/'private').symlink_to('/root')
   with self.assertRaises(ValueError):f.tree(root)
 def test_archive_authentication_and_traversal_before_restore(self):
  import tarfile
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);payload=io.BytesIO()
   with tarfile.open(fileobj=payload,mode='w:gz') as archive:
    info=tarfile.TarInfo('../escape');info.size=3;archive.addfile(info,io.BytesIO(b'bad'))
   payload.seek(0);path=root/'capsule';f.crypto.seal(payload,path,'ab'*32)
   with self.assertRaises(Exception):f.crypto.unpack(path,'cd'*32,root/'wrong-key')
   self.assertFalse((root/'wrong-key').exists())
   with self.assertRaises(ValueError):f.crypto.unpack(path,'ab'*32,root/'traversal')
   self.assertFalse((root/'traversal').exists());self.assertFalse((root.parent/'escape').exists())
 def test_persistent_mask_requires_zero_pid_processes_and_ports(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);unit=root/'fixture.service';unit.symlink_to('/dev/null')
   node=f.Node.__new__(f.Node);node.p={'unit':'fixture.service','home':'/fictional/node','rpc_port':38657,'p2p_port':38656};node.unit_file=unit
   with patch.object(node,'system_state',return_value={'active':'inactive','pid':0}),patch.object(node,'matching_processes',return_value=[]),patch.object(node,'listening_ports',return_value=[]):node.assert_fenced()
   for state,processes,ports in [({'active':'inactive','pid':123},[],[]),({'active':'active','pid':0},[],[]),({'active':'inactive','pid':0},[234],[]),({'active':'inactive','pid':0},[],[38657])]:
    with patch.object(node,'system_state',return_value=state),patch.object(node,'matching_processes',return_value=processes),patch.object(node,'listening_ports',return_value=ports),self.assertRaises(ValueError):node.assert_fenced()
   unit.unlink();unit.write_text('unmasked')
   with self.assertRaises(ValueError):node.assert_fenced()

 def test_restored_keys_get_exact_unprivileged_destination_owner(self):
  import pwd,grp
  user=pwd.getpwnam('nobody');group=grp.getgrgid(user.pw_gid)
  with tempfile.TemporaryDirectory() as tmp:
   node=f.Node.__new__(f.Node);node.home=Path(tmp);node.p=dict(service_user=user.pw_name,service_group=group.gr_name)
   key=node.home/'fixture-key';key.write_text('fictional key');key.chmod(0o600)
   # CI drops CAP_CHOWN and does not provision a production service account.
   # Verify the exact no-follow syscall contract here; the real two-host
   # rehearsal verifies resulting kernel ownership as uain-chain.
   with patch.object(f.os,'chown') as chown:owner=node.apply_destination_owner()
   self.assertNotEqual(owner['uid'],0);self.assertNotEqual(owner['gid'],0)
   self.assertEqual(owner['uid'],user.pw_uid);self.assertEqual(owner['gid'],group.gr_gid)
   self.assertEqual(chown.call_args_list,[unittest.mock.call(node.home,user.pw_uid,group.gr_gid,follow_symlinks=False),unittest.mock.call(key,user.pw_uid,group.gr_gid,follow_symlinks=False)])
   self.assertEqual(key.stat().st_mode&0o777,0o600)
 def test_authenticated_source_unreachable_and_nonce_replay_are_refused(self):
  node=f.Node.__new__(f.Node);node.p=dict(host='uain-db-1',unit='uain-failover-fixture-20261012.service')
  source=dict(source_host='uain-app-1',fence_id='a'*32)
  with patch.object(Path,'is_symlink',return_value=False),patch.object(Path,'stat',return_value=SimpleNamespace(st_uid=0,st_mode=0o600)):
   with patch.object(f.subprocess,'run',return_value=SimpleNamespace(returncode=255,stdout=b'')),self.assertRaises(ValueError):node.live_fence(source,'b'*64)
   copied=dict(fenced=True,source_host='uain-app-1',fence_id='a'*32,observed_at=f.time.time(),nonce='copied-old-nonce',ciphertext_sha256='b'*64)
   with patch.object(f.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=json.dumps(copied).encode())),self.assertRaises(ValueError):node.live_fence(source,'b'*64)
 def test_arbitrary_caller_json_cannot_override_source_challenge(self):
  node=f.Node.__new__(f.Node)
  with self.assertRaises(TypeError):node.promote(source_proof=dict(fenced=True,observed_at=f.time.time()))

if __name__=='__main__':unittest.main()

import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('installer',HERE/'failover-install.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
spec=importlib.util.spec_from_file_location('endpoint',HERE/'failover-ssh.py');e=importlib.util.module_from_spec(spec);spec.loader.exec_module(e)

class InstallerTest(unittest.TestCase):
 def setUp(self):
  base=HERE.parents[1]/'installer-test-tmp';base.mkdir(mode=0o700,exist_ok=True)
  self.tmp=tempfile.TemporaryDirectory(dir=base);self.root=Path(self.tmp.name);self.patches=[]
  for name,path in dict(BUNDLE='bundle',CODE='code',CONFIG='config',EVIDENCE='evidence',ROOT='state',JOURNAL='state/install.json',BACKUP='backup',OLD='old',PENDING='pending',AUTHORIZED='authorized_keys',MARKER='restart',CUSTODY='custody.lock',CAPTURE='capture.lock').items():
   self.patches.append(patch.object(m,name,self.root/path))
  for p in self.patches:p.start()
  m.BACKUP.mkdir(mode=0o700);m.BUNDLE.mkdir(mode=0o700);m.AUTHORIZED.write_text('ssh-ed25519 EXISTING-PUBLIC-AUTHORITY\n');m.AUTHORIZED.chmod(0o600)
  baseline={}
  for name in m.BASELINE:
   p=m.BACKUP/name;p.write_text('old '+name);p.chmod(0o600);baseline[name]=m.sha(p)
  self.patches.append(patch.object(m,'BASELINE',baseline));self.patches[-1].start()
  values={}
  for name in m.FILES:
   p=m.BUNDLE/name;p.parent.mkdir(mode=0o700,parents=True,exist_ok=True);p.write_text('reviewed '+name);p.chmod(0o600);values[name]=m.sha(p)
  (m.BUNDLE/'ops/chain/failover-install-files.json').write_bytes(m.encoded(values));(m.BUNDLE/'ops/chain/failover-install-files.json').chmod(0o600)
  self.before=dict(host='uain-app-1',profile=m.profile('uain-app-1'),profile_sha256=m.hashlib.sha256(m.encoded(m.profile('uain-app-1'))).hexdigest(),bundle_sha256=m.bundle()[1],backup_baseline=baseline,timers={u:dict(enabled='enabled',active='active') for u in m.TIMERS},canonical_changed=False)
  def run(args,**kwargs):
   if args[0]=='ssh-keygen':
    target=Path(args[-1]);target.write_text('FICTIONAL TEST PRIVATE KEY');target.chmod(0o600);target.with_suffix('.pub').write_text(m.HOSTS['uain-app-1']['ssh']+' fixture');target.with_suffix('.pub').chmod(0o644)
   return ''
  self.run=run
 def tearDown(self):
  for p in reversed(self.patches):p.stop()
  self.tmp.cleanup()
 def prepare(self):
  with patch.object(m,'preflight',return_value=self.before),patch.object(m,'drain'),patch.object(m,'original_metadata',return_value=self.before['profile']),patch.object(m,'run',side_effect=self.run):return m.prepare('uain-app-1')
 def test_profile_pins_exact_original_scope(self):
  p=m.profile('uain-app-1');self.assertEqual(p['binary_sha256'],m.DAEMON);self.assertEqual(p['genesis_sha256'],m.GENESIS);self.assertEqual(p['service_user'],'uain-chain')
  with self.assertRaises(ValueError):m.profile('arbitrary-host')
 def test_atomic_directory_exchange_never_removes_installed_path(self):
  a=self.root/'a';b=self.root/'b';a.mkdir();b.mkdir();(a/'tag').write_text('old');(b/'tag').write_text('new');m.exchange(a,b)
  self.assertEqual((a/'tag').read_text(),'new');self.assertEqual((b/'tag').read_text(),'old')
 def test_timer_drain_waits_for_activating_oneshot_and_never_stops_node(self):
  phases=iter(['activating','active','deactivating','inactive'])
  def flag(verb,unit):return next(phases) if unit=='uain-node-backup.service' else 'inactive'
  with patch.object(m,'flag',side_effect=flag),patch.object(m,'run') as run,patch.object(m.time,'sleep'):
   m.drain('uain-app-1')
   self.assertEqual([call.args[0] for call in run.call_args_list],[['systemctl','stop',x] for x in m.TIMERS])
 def test_installer_has_no_promotion_or_arbitrary_action(self):
  with patch.object(m.sys,'argv',['installer','promote']),patch.object(m.socket,'gethostname',return_value='uain-app-1'),self.assertRaises(ValueError):m.main()
 def test_bundle_tamper_is_refused_before_mutation(self):
  (m.BUNDLE/'ops/node-backup/node.py').write_text('tampered')
  with self.assertRaises(ValueError):m.bundle()
  self.assertFalse(m.JOURNAL.exists());self.assertFalse(m.CONFIG.exists())
 def test_database_preflight_does_not_require_app_only_wrapper(self):
  with patch.object(m,'original_metadata',return_value=m.profile('uain-db-1')),patch.object(m,'protected',return_value=b'public'),patch.object(m,'sha',return_value='not-the-app-wrapper'),patch.object(m,'bundle',return_value=({},'a'*64)),patch.object(m,'backup_hashes',return_value=m.BASELINE):
   self.assertFalse(m.preflight('uain-db-1')['canonical_changed'])
 def test_prepare_keeps_private_capability_on_server_and_swaps_only_backup_code(self):
  result=self.prepare();self.assertNotIn('FICTIONAL TEST PRIVATE KEY',json.dumps(result));self.assertEqual(m.backup_hashes(m.OLD),m.BASELINE)
  self.assertEqual(m.journal()['phase'],'prepared');self.assertEqual(m.CONFIG.stat().st_mode&0o777,0o700)
  key=m.CONFIG/'uain-db-1_ed25519';self.assertEqual(key.stat().st_mode&0o777,0o600)
 def test_rollback_restores_exact_old_code_and_preserves_other_authorities(self):
  self.prepare();record=m.journal();line='ssh-ed25519 JUST-INSTALLED-PUBLIC';record.update(phase='authorized',authorized_line=line);m.write_journal(record);m.AUTHORIZED.write_text(m.AUTHORIZED.read_text()+line+'\nssh-ed25519 CONCURRENT-PUBLIC\n')
  with patch.object(m,'original_metadata'),patch.object(m,'drain'):m.rollback('uain-app-1')
  self.assertEqual(m.backup_hashes(m.BACKUP),m.BASELINE);self.assertNotIn(line,m.AUTHORIZED.read_text());self.assertIn('CONCURRENT-PUBLIC',m.AUTHORIZED.read_text());self.assertFalse(m.CONFIG.exists());self.assertEqual(m.journal()['phase'],'rolled_back')
 def test_interrupted_before_exchange_can_roll_back_without_swapping_old_code(self):
  with patch.object(m,'exchange',side_effect=RuntimeError('before exchange')):
   with self.assertRaises(RuntimeError):self.prepare()
  with patch.object(m,'original_metadata'),patch.object(m,'drain'):m.rollback('uain-app-1')
  self.assertEqual(m.backup_hashes(m.BACKUP),m.BASELINE);self.assertEqual(m.journal()['phase'],'rolled_back')
 def test_interrupted_after_exchange_can_restore_highest_current_node_unchanged(self):
  exchange=m.exchange
  def interrupted(a,b):exchange(a,b);raise RuntimeError('after exchange')
  with patch.object(m,'exchange',side_effect=interrupted):
   with self.assertRaises(RuntimeError):self.prepare()
  with patch.object(m,'original_metadata'),patch.object(m,'drain'):m.rollback('uain-app-1')
  self.assertEqual(m.backup_hashes(m.BACKUP),m.BASELINE);self.assertEqual(m.journal()['phase'],'rolled_back')
 def test_rollback_refuses_any_fence_or_promotion_receipt(self):
  self.prepare();m.EVIDENCE.mkdir();(m.EVIDENCE/'fence.json').write_text('{}')
  with patch.object(m,'original_metadata'),patch.object(m,'drain'),self.assertRaises(ValueError):m.rollback('uain-app-1')
  self.assertEqual(m.backup_hashes(m.OLD),m.BASELINE)
 def test_peer_authority_requires_exact_bundle_profile_and_hostkey(self):
  self.prepare();peer=dict(host='uain-db-1',profile_sha256=m.hashlib.sha256(m.encoded(m.profile('uain-db-1'))).hexdigest(),bundle_sha256=m.journal()['bundle_sha256'],challenge_public_key=m.HOSTS['uain-db-1']['ssh']+' fixture',ssh_host_key=m.HOSTS['uain-db-1']['ssh'])
  for changes in [dict(host='elsewhere'),dict(bundle_sha256='b'*64),dict(profile_sha256='b'*64),dict(ssh_host_key=m.HOSTS['uain-app-1']['ssh']),dict(challenge_public_key='ssh-rsa arbitrary')]:
   with self.subTest(changes=changes),self.assertRaises(ValueError):m.authorize('uain-app-1',{**peer,**changes})
  m.authorize('uain-app-1',peer);line=m.journal()['authorized_line'];self.assertIn('from="10.98.0.2",restrict,command="/usr/bin/python3 -I /opt/uain-failover/ops/chain/failover-ssh.py"',line)
 def receipt(self):
  items=[];offsite=[]
  for host in m.HOSTS:
   name='uain-node-'+host+'-20261012T010101Z.nodebk';digest='a'*64
   items.append(dict(name=name,ciphertext_sha256=digest,full_tree_restore_verified=True,restored_signer_started=False,node_restarted=True,manifest=dict(host=host,binary_sha256=m.DAEMON,genesis_sha256=m.GENESIS,unit_sha256=m.HOSTS[host]['unit'],node_role=dict(name='original_validator' if host=='uain-app-1' else 'original_fullnode',binding=None))))
   offsite.extend(dict(uri='s3://uain/node-backups/'+n,sha256=digest,readback_verified=True) for n in (name,Path(name).with_suffix('.json').name))
  return dict(created_at='2026-10-12T01:01:01+00:00',cross_host_readback_verified=True,offsite_verified=True,signer_restores_started=False,backups=items,offsite=offsite)
 def test_first_acceptance_requires_fresh_original_pair_and_offsite_readback(self):
  receipt=self.receipt();record=dict(prepared_at='2026-10-12T01:00:00+00:00');m.accepted_receipt(receipt,record)
  for mutate in [lambda v:v.update(offsite_verified=False),lambda v:v.update(created_at='2026-10-11T01:00:00+00:00'),lambda v:v['offsite'][0].update(readback_verified=False),lambda v:v['offsite'][0].update(sha256='c'*64),lambda v:v['backups'][0]['manifest']['node_role'].update(name='promoted_validator'),lambda v:v['backups'][0].update(node_restarted=False)]:
   changed=copy.deepcopy(receipt);mutate(changed)
   with self.assertRaises(ValueError):m.accepted_receipt(changed,record)
 def test_forced_endpoint_has_no_shell_export_or_promotion_action(self):
  class Node:
   def serve_fence(self,p):return dict(fenced=True,**p)
  node=Node();self.assertTrue(e.respond(node,'serve-fence',dict(nonce='a'*64,fence_id='b'*32,sha256='c'*64))['fenced'])
  for command,request in [('sh',{}),('promote',{}),('serve-fence',dict(nonce='a'*64,extra='bad')),('failover-probe',dict(nonce='bad'))]:
   with self.subTest(command=command),self.assertRaises(ValueError):e.respond(node,command,request)

if __name__=='__main__':unittest.main()

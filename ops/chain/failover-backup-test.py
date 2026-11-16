import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('role_backup',Path(__file__).with_name('failover-backup.py'));r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
REAL_VERIFY=r.b.verify_restore

class RoleBackupTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.home=self.root/'node';self.home.mkdir();(self.home/'config').mkdir();(self.home/'data').mkdir()
  (self.home/'config/genesis.json').write_text(json.dumps(dict(validators=[dict(address='abc')],chain_id='fixture')))
  (self.home/'config/priv_validator_key.json').write_text(json.dumps(dict(address='abc',private='FICTIONAL TEST SECRET')))
  (self.home/'data/priv_validator_state.json').write_text(json.dumps(dict(height='8',round=0,step=3)))
  self.binary=self.root/'uaind';self.binary.write_text('fictional public daemon')
  self.unit=self.root/'unit';self.unit.write_text('fictional reviewed service')
  self.store=self.root/'archives';self.store.mkdir(mode=0o700)
  self.inv=dict(host='uain-app-1',home=str(self.home),binary_sha256=r.f.sha(self.binary),unit_sha256=r.f.sha(self.unit),genesis_sha256=r.f.sha(self.home/'config/genesis.json'),chain_id='fixture')
  self.state=dict(height=8,round=0,step=3,sha256=r.f.sha(self.home/'data/priv_validator_state.json'))
  self.running=True;self.actions=[]
  def run(args):
   self.actions.append(args)
   if args[1]=='stop':self.running=False
   elif args[1]=='start':self.running=True
  self.node=SimpleNamespace(root=self.root/'evidence',home=self.home,p=dict(host='uain-app-1',unit=r.b.UNIT,binary=str(self.binary)),unit_file=self.unit,original_unit=self.unit,
   inventory=lambda:self.inv,signing_state=lambda:self.state,run=run,system_state=lambda:dict(active='active' if self.running else 'inactive',pid=99 if self.running else 0),matching_processes=lambda:[],listening_ports=lambda:[],require_single_signer=lambda *args:None)
  self.node.root.mkdir(mode=0o700)
  self.patches=[patch.object(r.b,'ROOT',self.store),patch.object(r.b,'HOME_BASE',self.root),patch.object(r.b,'MARKER',self.root/'restart.json'),patch.object(r.b,'CAPTURE_LOCK',self.root/'capture.lock'),patch.object(r.b,'CAPSULE_TMP',self.root),patch.object(r,'CUSTODY_LOCK',self.root/'custody.lock'),patch.object(r,'RUN_LOCK',self.root/'run.lock')]
  for p in self.patches:p.start()
 def tearDown(self):
  for p in reversed(self.patches):p.stop()
  self.tmp.cleanup()
 def test_active_capture_restarts_original_and_authenticates_role_signing_state(self):
  receipt=r.capture(self.node,'ab'*32,'20261012T010101Z')
  self.assertTrue(self.running);self.assertEqual([x[1] for x in self.actions],['stop','start'])
  self.assertEqual(receipt['manifest']['node_role']['name'],'original_validator');self.assertEqual(receipt['manifest']['signing_state'],self.state)
  self.assertNotIn(b'FICTIONAL TEST SECRET',(self.store/receipt['name']).read_bytes());self.assertFalse(r.b.MARKER.exists())
 def failed(self,stamp):
  path=self.store/('uain-node-uain-app-1-'+stamp+'.failed.json')
  return json.loads(path.read_text()) if path.exists() else None
 def test_short_pause_receipt_records_explicit_intervals_and_removes_staging(self):
  receipt=r.capture(self.node,'ab'*32,'20261109T031112Z')
  self.assertEqual(receipt['receipt_version'],3)
  for field in ('precopy_seconds','validator_stop_seconds','stopped_copy_seconds','post_restart_seal_verify_seconds'):
   self.assertIsInstance(receipt[field],float);self.assertGreaterEqual(receipt[field],0)
  self.assertLessEqual(receipt['stopped_copy_seconds'],receipt['validator_stop_seconds'])
  self.assertLessEqual(receipt['validator_stop_seconds'],r.PAUSE_LIMIT_SECONDS)
  self.assertEqual(receipt['stopped_copy_deadline_seconds'],30);self.assertEqual(receipt['proof_age_gate_seconds'],120)
  self.assertIn('capture_pause_seconds',receipt);self.assertEqual(receipt['manifest']['tree'],r.f.tree(self.home))
  self.assertEqual(list(self.store.glob('.staging-*')),[]);self.assertIsNone(self.failed('20261109T031112Z'))
 def test_mutation_after_precopy_is_captured_from_stopped_tree_and_source_untouched(self):
  (self.home/'data/old.log').write_text('deleted later');(self.home/'data/wal').write_text('first')
  original=self.node.run
  def run(args):
   if args[1]=='stop':
    # Writes between the running precopy and the stop: append, add, delete.
    with (self.home/'data/wal').open('a') as out:out.write(' appended while running')
    (self.home/'data/new.sst').write_text('new table');(self.home/'data/old.log').unlink()
    self.state={**self.state,'height':9}
   original(args)
  self.node.run=run
  receipt=r.capture(self.node,'ab'*32,'20261109T031113Z')
  self.assertEqual(receipt['manifest']['tree'],r.f.tree(self.home));self.assertEqual(receipt['manifest']['signing_state']['height'],9)
  self.assertGreaterEqual(receipt['final_sync_changes'],3);self.assertTrue(receipt['full_tree_restore_verified'])
  self.assertEqual((self.home/'data/wal').read_text(),'first appended while running')
 def test_stopped_copy_deadline_restarts_original_and_publishes_nothing(self):
  with patch.object(r,'STOPPED_COPY_DEADLINE_SECONDS',-1):
   with self.assertRaises(r.DeadlineExceeded):r.capture(self.node,'ab'*32,'20261109T031114Z')
  self.assertTrue(self.running);self.assertEqual([x[1] for x in self.actions],['stop','start']);self.assertFalse(r.b.MARKER.exists())
  self.assertEqual([p.name for p in self.store.iterdir()],['uain-node-uain-app-1-20261109T031114Z.failed.json'])
  failure=self.failed('20261109T031114Z');self.assertTrue(failure['deadline_exceeded']);self.assertTrue(failure['node_restarted']);self.assertFalse(failure['published'])
 def test_pause_over_limit_fails_loudly_after_restart(self):
  with patch.object(r,'PAUSE_LIMIT_SECONDS',-1):
   with self.assertRaises(r.DeadlineExceeded):r.capture(self.node,'ab'*32,'20261109T031115Z')
  self.assertTrue(self.running);self.assertIsNotNone(self.failed('20261109T031115Z')['validator_stop_seconds'])
  self.assertFalse((self.store/'uain-node-uain-app-1-20261109T031115Z.nodebk').exists())
 def test_restart_failure_retains_marker_and_records_stopped_node(self):
  original=self.node.run
  def run(args):
   if args[1]=='start':self.actions.append(args);return
   original(args)
  self.node.run=run
  with self.assertRaisesRegex(ValueError,'restart failed'):r.capture(self.node,'ab'*32,'20261109T031116Z')
  self.assertFalse(self.running);self.assertTrue(r.b.MARKER.exists())
  failure=self.failed('20261109T031116Z');self.assertFalse(failure['node_restarted']);self.assertFalse(failure['deadline_exceeded'])
  self.assertFalse((self.store/'uain-node-uain-app-1-20261109T031116Z.nodebk').exists())
 def test_role_change_before_stop_never_stops(self):
  calls=[0];real=r.role
  def changing(node,stopped=False):
   calls[0]+=1
   if calls[0]>1:return dict(name='promoted_validator',binding={})
   return real(node,stopped)
  with patch.object(r,'role',side_effect=changing):
   with self.assertRaises(ValueError):r.capture(self.node,'ab'*32,'20261109T031117Z')
  self.assertEqual(self.actions,[]);self.assertFalse(r.b.MARKER.exists())
 def test_stale_staging_is_removed_and_never_published(self):
  stale=self.store/'.staging-old';(stale/'node').mkdir(parents=True)
  r.capture(self.node,'ab'*32,'20261109T031118Z');self.assertFalse(stale.exists())
 def test_sync_tree_refuses_links_and_specials_and_matches_tree_digest(self):
  target=self.root/'staged';changes=r.sync_tree(self.home,target)
  self.assertGreater(changes,0);self.assertEqual(r.tree(target),r.f.tree(self.home));self.assertEqual(r.sync_tree(self.home,target),0)
  (self.home/'data/link').symlink_to(self.home/'config/genesis.json')
  with self.assertRaises(ValueError):r.sync_tree(self.home,target)
  (self.home/'data/link').unlink();os.mkfifo(self.home/'data/fifo')
  with self.assertRaises(ValueError):r.sync_tree(self.home,target)
  (self.home/'data/fifo').unlink();os.link(self.home/'config/genesis.json',self.home/'data/hard')
  with self.assertRaises(ValueError):r.sync_tree(self.home,target)
 def phased(self):
  """Logs every file content read by phase: running precopy, stopped, restarted."""
  phase=['running'];reads=[];original=self.node.run;copy=r.copy_file;tree=r.tree
  def run(args):
   original(args);phase[0]={'stop':'stopped','start':'restarted'}.get(args[1],phase[0])
  def copy_file(source,target,info,deadline):
   reads.append((phase[0],'copy',Path(source).relative_to(self.home).as_posix()));return copy(source,target,info,deadline)
  def hashed(root,deadline=None):
   reads.append((phase[0],'tree',Path(root).name));return tree(root,deadline)
  self.node.run=run
  return reads,[patch.object(r,'copy_file',copy_file),patch.object(r,'tree',hashed),patch.object(r.f,'tree',hashed)]
 def test_stopped_window_reads_only_changed_files_never_a_full_hash(self):
  # Above about 6 GB a full stopped-tree hash would exceed the 30 s deadline;
  # the stopped window must read only files changed since their staged read.
  (self.home/'data/blockstore.db').write_bytes(os.urandom(1<<20));(self.home/'data/wal').write_text('first')
  time.sleep(0.05);reads,patches=self.phased();original=self.node.run
  def run(args):
   if args[1]=='stop':
    with (self.home/'data/wal').open('a') as out:out.write(' appended while running')
   original(args)
  self.node.run=run
  with patch.object(r,'RACY_MARGIN_NS',0),patches[0],patches[1],patches[2]:receipt=r.capture(self.node,'ab'*32,'20261110T010101Z')
  stopped=[x for x in reads if x[0]=='stopped']
  self.assertEqual(stopped,[('stopped','copy','data/wal')])
  self.assertIn(('restarted','tree','node'),reads)
  self.assertEqual(receipt['manifest']['tree'],r.f.tree(self.home));self.assertEqual(receipt['final_sync_changes'],1)
 def test_same_size_rewrite_with_restored_mtime_is_detected_by_ctime(self):
  # Size and mtime alone would miss this; ctime cannot be set by the node user.
  (self.home/'data/state.db').write_bytes(b'A'*4096);time.sleep(0.05);reads,patches=self.phased();original=self.node.run
  def run(args):
   if args[1]=='stop':
    path=self.home/'data/state.db';before=path.stat();time.sleep(0.05)
    path.write_bytes(b'B'*4096);os.utime(path,ns=(before.st_atime_ns,before.st_mtime_ns))
   original(args)
  self.node.run=run
  with patch.object(r,'RACY_MARGIN_NS',0),patches[0],patches[1],patches[2]:receipt=r.capture(self.node,'ab'*32,'20261110T010102Z')
  self.assertIn(('stopped','copy','data/state.db'),reads)
  self.assertEqual(receipt['manifest']['tree'],r.f.tree(self.home))
 def test_racy_files_are_never_trusted_and_copied_again_while_stopped(self):
  # Written within the margin of the walk that read them: same-tick writes are
  # possible, so the default margin forces a stopped copy even when unchanged.
  (self.home/'data/fresh.db').write_text('just written');reads,patches=self.phased()
  with patches[0],patches[1],patches[2]:r.capture(self.node,'ab'*32,'20261110T010103Z')
  self.assertIn(('stopped','copy','data/fresh.db'),reads)
 def test_stopped_proof_refuses_any_change_after_the_final_sync(self):
  record={};target=self.root/'staged';(self.home/'data/state.db').write_bytes(b'A'*64);time.sleep(0.05)
  with patch.object(r,'RACY_MARGIN_NS',0):r.sync_tree(self.home,target,record=record)
  deadline=r.Deadline(30,'fixture');self.assertGreater(r.require_unchanged(self.home,record,deadline),0)
  path=self.home/'data/state.db';before=path.stat();time.sleep(0.05);path.write_bytes(b'B'*64);os.utime(path,ns=(before.st_atime_ns,before.st_mtime_ns))
  with self.assertRaisesRegex(ValueError,'differs'):r.require_unchanged(self.home,record,deadline)
  with patch.object(r,'RACY_MARGIN_NS',0):r.sync_tree(self.home,target,record=record,quiescent=True)
  r.require_unchanged(self.home,record,deadline);self.assertEqual(r.tree(target),r.f.tree(self.home))
  for change in (lambda:(self.home/'data/extra').write_text('x'),lambda:(self.home/'data/extra').unlink(),lambda:os.chmod(self.home/'data',0o750)):
   change()
   with self.assertRaisesRegex(ValueError,'differs'):r.require_unchanged(self.home,record,deadline)
   r.sync_tree(self.home,target,record=record,quiescent=True);r.require_unchanged(self.home,record,deadline)
  self.assertEqual(r.tree(target),r.f.tree(self.home))
 def test_stopped_proof_is_bounded_by_the_stopped_deadline(self):
  record={};r.sync_tree(self.home,self.root/'staged',record=record,quiescent=True)
  clock=iter(range(0,1000,50))
  with patch.object(r,'monotonic',side_effect=lambda:next(clock)):
   deadline=r.Deadline(30,'fixture')
   with self.assertRaises(r.DeadlineExceeded):r.require_unchanged(self.home,record,deadline)
 def test_deadline_interrupts_hashing(self):
  clock=iter(range(0,1000,50))
  with patch.object(r,'monotonic',side_effect=lambda:next(clock)):
   deadline=r.Deadline(30,'fixture')
   with self.assertRaises(r.DeadlineExceeded):r.tree(self.home,deadline)
 def test_frozen_capture_never_starts_or_creates_restart_marker(self):
  self.running=False;role=dict(name='fenced_source',binding=dict(fence_id='a'*32))
  with patch.object(r,'role',return_value=role):receipt=r.capture(self.node,'ab'*32,'20261012T010102Z')
  self.assertEqual(self.actions,[]);self.assertFalse(self.running);self.assertFalse(r.b.MARKER.exists());self.assertTrue(receipt['source_remains_fenced']);self.assertFalse(receipt['node_restarted'])
 def test_frozen_capture_failure_never_starts_source(self):
  self.running=False
  with patch.object(r,'role',return_value=dict(name='fenced_source',binding={})),patch.object(r.b.crypto,'seal',side_effect=RuntimeError('fixture')):
   with self.assertRaises(RuntimeError):r.capture(self.node,'ab'*32,'20261012T010103Z')
  self.assertEqual(self.actions,[]);self.assertFalse(r.b.MARKER.exists());self.assertEqual(list(self.store.iterdir()),[])
 def test_legacy_restart_marker_and_source_role_never_restart(self):
  self.running=False;r.b.atomic_json(r.b.MARKER,dict(inventory=r.inventory(self.node)))
  with self.assertRaises(ValueError):r.recover(self.node)
  with patch.object(r,'role',return_value=dict(name='fenced_source',binding={})):
   with self.assertRaises(ValueError):r.recover(self.node)
  self.assertEqual(self.actions,[]);self.assertTrue(r.b.MARKER.exists())
 def test_failed_active_capture_resumes_only_unchanged_role(self):
  with patch.object(r.b.crypto,'seal',side_effect=RuntimeError('fixture')):
   with self.assertRaises(RuntimeError):r.capture(self.node,'ab'*32,'20261012T010104Z')
  self.assertTrue(self.running);self.assertEqual([x[1] for x in self.actions],['stop','start'])
 def test_source_becoming_unreachable_never_starts_destination(self):
  self.running=False;reviewed=dict(name='promoted_validator',binding={});r.b.atomic_json(r.b.MARKER,dict(inventory=r.inventory(self.node),node_role=reviewed))
  with patch.object(r,'role',side_effect=ValueError('unreachable')):
   with self.assertRaises(ValueError):r.recover(self.node)
  self.assertEqual(self.actions,[]);self.assertTrue(r.b.MARKER.exists())
 def promotion(self):
  source=dict(source_host='uain-db-1',fence_id='a'*32,checkpoint=dict(height=7),inventory={},signing_state=self.state)
  receipt=dict(promoted=True,source=source,ciphertext_sha256='b'*64,signing_state=self.state,after_checkpoint=dict(height=8))
  r.b.atomic_json(self.node.root/'restore.json',receipt);r.b.atomic_json(self.node.root/'promotion-started.json',dict(destination='uain-app-1',source_fence_id='a'*32,ciphertext_sha256='b'*64))
  self.node.live_fence=lambda *args:{}
  return receipt
 def test_promoted_stopped_role_checks_live_source_and_signing_floor(self):
  receipt=self.promotion();self.assertEqual(r.role(self.node,stopped=True)['name'],'promoted_validator')
  self.state={**self.state,'height':7}
  with self.assertRaises(ValueError):r.role(self.node,stopped=True)
  self.state=receipt['signing_state'];self.node.live_fence=lambda *args:(_ for _ in ()).throw(ValueError('unreachable'))
  with self.assertRaises(ValueError):r.role(self.node,stopped=True)
 def test_interrupted_or_conflicting_promotion_is_refused(self):
  self.promotion();r.b.atomic_json(self.node.root/'restore.json',dict(promoted=False))
  with self.assertRaises(ValueError):r.role(self.node,stopped=True)
  r.b.atomic_json(self.node.root/'fence.json',{})
  with self.assertRaises(ValueError):r.role(self.node,stopped=True)
 def test_transitions_refuse_pending_restart_and_held_capture_lock(self):
  called=[];self.node.promote=lambda:called.append(True)
  r.b.atomic_json(r.b.MARKER,{})
  with self.assertRaises(ValueError):r.transition(self.node,'promote',{})
  r.b.MARKER.unlink()
  with r.b.CAPTURE_LOCK.open('a') as lock:
   r.fcntl.flock(lock,r.fcntl.LOCK_EX|r.fcntl.LOCK_NB)
   with self.assertRaises(BlockingIOError):r.transition(self.node,'promote',{})
  self.assertEqual(called,[])
 def test_in_flight_coordinator_run_or_custody_consumer_excludes_every_transition(self):
  # The coordinator holds the run lock from start to finish; it no longer
  # holds the custody lock throughout, so the run lock must exclude transitions.
  called=[];self.node.promote=lambda:called.append('promote');self.node.fence=lambda checkpoint:called.append('fence')
  for lock in (r.RUN_LOCK,r.CUSTODY_LOCK):
   with lock.open('a') as held:
    r.fcntl.flock(held,r.fcntl.LOCK_EX|r.fcntl.LOCK_NB)
    for action,request in (('promote',{}),('fence',dict(checkpoint={}))):
     with self.subTest(lock=lock.name,action=action),self.assertRaises(BlockingIOError):r.transition(self.node,action,request)
  self.assertEqual(called,[])
  r.transition(self.node,'promote',{});self.assertEqual(called,['promote'])
 def held(self,lock):
  with lock.open('a') as probe:
   try:r.fcntl.flock(probe,r.fcntl.LOCK_EX|r.fcntl.LOCK_NB)
   except BlockingIOError:return True
   r.fcntl.flock(probe,r.fcntl.LOCK_UN);return False
 def test_custody_lock_covers_only_the_stopped_window_until_the_node_answers(self):
  seen={};original=self.node.run;answers=[ConnectionRefusedError(),ConnectionRefusedError(),dict(sync_info={})]
  def run(args):
   seen[args[1]]=self.held(r.CUSTODY_LOCK);return original(args)
  def rpc(method):
   seen.setdefault('rpc',[]).append(self.held(r.CUSTODY_LOCK));answer=answers.pop(0)
   if isinstance(answer,Exception):raise answer
   return answer
  self.node.run=run;self.node.rpc=rpc
  real_sync=r.sync_tree;real_tree=r.tree;real_seal=r.seal
  def sync(*args,**kwargs):seen.setdefault('sync',[]).append((self.held(r.CUSTODY_LOCK),kwargs.get('quiescent',False)));return real_sync(*args,**kwargs)
  def tree(*args,**kwargs):seen.setdefault('tree',[]).append(self.held(r.CUSTODY_LOCK));return real_tree(*args,**kwargs)
  def seal(*args,**kwargs):seen['seal']=self.held(r.CUSTODY_LOCK);return real_seal(*args,**kwargs)
  with patch.object(r,'sync_tree',side_effect=sync),patch.object(r,'tree',side_effect=tree),patch.object(r,'seal',side_effect=seal),patch.object(r.b,'verify_restore',side_effect=lambda *a:(seen.__setitem__('verify',self.held(r.CUSTODY_LOCK)),REAL_VERIFY(*a))[1]):
   receipt=r.capture(self.node,'ab'*32,'20261110T120000Z')
  # Held for the stop, the stopped copy, the restart and until the RPC answers.
  self.assertEqual((seen['stop'],seen['start'],seen['rpc']),(True,True,[True,True,True]))
  self.assertEqual(seen['sync'],[(False,False),(True,True)])
  # Free for the precopy, the full hash, the seal and the restore check.
  self.assertEqual((seen['tree'],seen['seal'],seen['verify']),([False,False],False,False));self.assertFalse(self.held(r.CUSTODY_LOCK))
  for field in ('custody_lock_wait_seconds','custody_lock_held_seconds','validator_serving_seconds'):self.assertIsInstance(receipt[field],float)
  self.assertGreaterEqual(receipt['validator_serving_seconds'],receipt['validator_stop_seconds']);self.assertGreaterEqual(receipt['custody_lock_held_seconds'],receipt['validator_stop_seconds'])
 def test_busy_custody_lock_refuses_the_capture_with_the_node_still_running(self):
  with r.CUSTODY_LOCK.open('a') as held,patch.object(r,'CUSTODY_WAIT_SECONDS',0.3):
   r.fcntl.flock(held,r.fcntl.LOCK_EX)
   with self.assertRaisesRegex(ValueError,'Custody lock busy'):r.capture(self.node,'ab'*32,'20261110T120001Z')
  self.assertTrue(self.running);self.assertEqual(self.actions,[]);self.assertFalse(r.b.MARKER.exists())
  self.assertEqual(list(self.store.glob('*.nodebk')),[]);self.assertEqual(list(self.store.glob('.staging-*')),[])
  failed=self.failed('20261110T120001Z');self.assertFalse(failed['published']);self.assertTrue(failed['node_restarted']);self.assertIsNone(failed['validator_stopped_at'])
 def test_capture_waits_for_a_custody_signer_and_refreshes_its_copy_first(self):
  calls=[];real_sync=r.sync_tree
  def sync(*args,**kwargs):calls.append(kwargs.get('quiescent',False));return real_sync(*args,**kwargs)
  with r.CUSTODY_LOCK.open('a') as held,patch.object(r,'RESYNC_AFTER_WAIT_SECONDS',0.1),patch.object(r,'sync_tree',side_effect=sync):
   r.fcntl.flock(held,r.fcntl.LOCK_EX)
   def finish():
    (self.home/'data/written-while-waiting').write_text('a signer finished');r.fcntl.flock(held,r.fcntl.LOCK_UN)
   timer=__import__('threading').Timer(0.4,finish);timer.start()
   receipt=r.capture(self.node,'ab'*32,'20261110T120002Z');timer.join()
  # Precopy, a second running pass after the wait, then the stopped pass.
  self.assertEqual(calls,[False,False,True]);self.assertGreaterEqual(receipt['custody_lock_wait_seconds'],0.3)
  self.assertEqual(receipt['manifest']['tree'],r.f.tree(self.home));self.assertEqual([x[1] for x in self.actions],['stop','start'])
 def test_node_that_never_answers_releases_custody_after_the_bounded_wait(self):
  def rpc(method):raise ConnectionRefusedError()
  self.node.rpc=rpc
  with patch.object(r,'SERVING_WAIT_SECONDS',0.3):receipt=r.capture(self.node,'ab'*32,'20261110T120003Z')
  self.assertIsNone(receipt['validator_serving_seconds']);self.assertTrue(receipt['full_tree_restore_verified']);self.assertFalse(self.held(r.CUSTODY_LOCK))
 def test_failed_stopped_copy_still_restarts_and_releases_custody(self):
  self.node.rpc=lambda method:dict(sync_info={})
  with patch.object(r,'require_unchanged',side_effect=ValueError('Stopped tree differs from staged copy')),self.assertRaises(ValueError):r.capture(self.node,'ab'*32,'20261110T120004Z')
  self.assertTrue(self.running);self.assertFalse(r.b.MARKER.exists());self.assertFalse(self.held(r.CUSTODY_LOCK))
  self.assertIsInstance(self.failed('20261110T120004Z')['validator_serving_seconds'],float)
 def test_paired_receipts_require_same_promotion_and_exact_single_signer(self):
  binding=dict(source_host='uain-app-1',fence_id='a'*32,signing_floor=self.state)
  manifests=[dict(host='uain-app-1',chain_id='fixture',genesis_sha256='c'*64,signing_state=self.state,node_role=dict(name='fenced_source',binding=binding)),dict(host='uain-db-1',chain_id='fixture',genesis_sha256='c'*64,signing_state={**self.state,'height':9},node_role=dict(name='promoted_validator',binding=binding))]
  r.paired([dict(manifest=x) for x in manifests])
  for changed in [dict(name='original_validator',binding=None),dict(name='promoted_validator',binding={**binding,'fence_id':'d'*32}),dict(name='fenced_source',binding=binding)]:
   with self.subTest(changed=changed),self.assertRaises(ValueError):r.paired([dict(manifest=manifests[0]),dict(manifest={**manifests[1],'node_role':changed})])
 def test_original_pair_remains_valid_and_foreign_chain_is_refused(self):
  rows=[dict(manifest=dict(host=host,chain_id='fixture',genesis_sha256='c'*64,node_role=dict(name=name,binding=None))) for host,name in [('uain-app-1','original_validator'),('uain-db-1','original_fullnode')]]
  self.assertTrue(r.paired(rows));rows[1]['manifest']['genesis_sha256']='d'*64
  with self.assertRaises(ValueError):r.paired(rows)
 def test_capture_dispatches_to_same_role_aware_capture_and_recovery(self):
  with patch.object(r.b,'role_enabled',return_value=True),patch.object(r.b,'role_helper') as helper,patch.object(r.b.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=b'{}')) as run:
   r.b.run_capture('ab'*32,'20261012T010105Z');args=run.call_args.args[0]
   self.assertIn('/opt/uain-failover/ops/chain/failover-backup.py',args)
   self.assertIn('--property=ExecStopPost=/usr/bin/python3 /opt/uain-failover/ops/chain/failover-backup.py recover',args)
   self.assertNotIn('ab'*32,' '.join(args));self.assertEqual(json.loads(run.call_args.kwargs['input'])['key'],'ab'*32);helper.assert_called_once()
 def test_present_invalid_role_helper_never_falls_back_or_receives_key(self):
  with patch.object(r.b,'role_enabled',return_value=True),patch.object(r.b,'role_helper',side_effect=ValueError('invalid')),patch.object(r.b.subprocess,'run') as run:
   with self.assertRaises(ValueError):r.b.run_capture('ab'*32,'20261012T010106Z')
   run.assert_not_called()
 def test_enabled_role_pair_validation_is_mandatory(self):
  with patch.object(r.b,'role_enabled',return_value=True),patch.object(r.b,'role_helper',return_value=SimpleNamespace(paired=lambda rows:(_ for _ in ()).throw(ValueError('conflicting pair')))):
   with self.assertRaises(ValueError):r.b.require_role_pair([])
 def test_outer_service_recovery_cannot_bypass_role_source_challenge(self):
  from unittest.mock import Mock
  self.running=False;r.b.atomic_json(r.b.MARKER,dict(inventory=r.inventory(self.node),node_role=dict(name='promoted_validator',binding={})))
  recover=Mock(side_effect=ValueError('source challenge unavailable'))
  helper=SimpleNamespace(f=SimpleNamespace(Node=lambda profile:self.node),PROFILE=Path('/etc/uain-failover/node.json'),recover=recover)
  with patch.object(r.b,'role_enabled',return_value=True),patch.object(r.b,'role_helper',return_value=helper),patch.object(r.b,'inventory',return_value=r.inventory(self.node)),patch.object(r.b,'active',return_value=False),patch.object(r.b,'run') as run:
   with self.assertRaisesRegex(ValueError,'source challenge unavailable'):r.b.recover()
   recover.assert_called_once_with(self.node);run.assert_not_called()
 def test_broken_profile_symlink_still_enables_fail_closed_roles(self):
  path=self.root/'profile';path.symlink_to(self.root/'missing')
  with patch.object(r.b,'ROLE_PROFILE',path):self.assertTrue(r.b.role_enabled())

if __name__=='__main__':unittest.main()

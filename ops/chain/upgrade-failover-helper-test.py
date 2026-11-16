"""Pinned helper replacement: exact bytes, exact records, exact rollback. FIXTURE."""
import fcntl
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch, Mock

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('helper_upgrade',HERE/'upgrade-failover-helper.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
ASSERT_DRAINED=m.assert_drained;PREVIEW_CHECK=m.preview_check
IDENT='20261110-fixture'

class Killed(BaseException):
 """Stands for the process dying: nothing may catch it and tidy up."""

def sha(raw):return hashlib.sha256(raw).hexdigest()

class HelperUpgradeTest(unittest.TestCase):
 host='uain-app-1'
 def setUp(self):
  base=HERE.parents[1]/'upgrade-helper-test-tmp';base.mkdir(mode=0o700,exist_ok=True)
  self.tmp=tempfile.TemporaryDirectory(dir=base);self.root=Path(self.tmp.name);r=self.root
  self.patches=[patch.object(m,name,value) for name,value in dict(CONFIG=r/'config',UPGRADES=r/'upgrades',EVIDENCE=r/'evidence',WRAPPER=r/'sbin/uain-node-backup',MARKER=r/'restart.json',CUSTODY=r/'custody.lock',CAPTURE=r/'capture.lock',RUN=r/'run.lock',BUNDLE=r/'bundle',CUSTODY_WAIT_SECONDS=0.4).items()]
  self.patches+=[patch.object(m.i,name,value) for name,value in dict(CODE=r/'code',BACKUP=r/'backup',JOURNAL=r/'state/install.json').items()]
  self.patches+=[patch.object(m,'assert_drained'),patch.object(m,'preview_check',side_effect=lambda host:m.ROLES[host])]
  for p in self.patches:p.start()
  for d in (m.CONFIG,m.EVIDENCE,m.WRAPPER.parent,m.i.CODE/'ops/chain',m.i.CODE/'ops/reset',m.i.BACKUP,m.i.JOURNAL.parent,m.BUNDLE/'ops/chain',m.BUNDLE/'ops/node-backup'):d.mkdir(mode=0o700,parents=True)
  self.installed={}
  for name in sorted(m.i.FILES):
   target=m.i.BACKUP/Path(name).name if name.startswith('ops/node-backup/') else m.i.CODE/name
   data=('# installed '+name+'\n').encode();target.write_bytes(data);target.chmod(0o600);self.installed[name]=data
  self.old_entry=b'# installed entry\n';(m.i.BACKUP/'entry.py').write_bytes(self.old_entry);(m.i.BACKUP/'entry.py').chmod(0o600)
  for extra in ('archive.py','receive.py','rehearse.py','test_backup.py'):(m.i.BACKUP/extra).write_bytes(b'# other\n');(m.i.BACKUP/extra).chmod(0o600)
  self.old_wrapper=b'#!/bin/sh\nexec old "$@"\n';m.WRAPPER.write_bytes(self.old_wrapper);m.WRAPPER.chmod(0o700)
  self.old_bundle=m.encode({name:sha(data) for name,data in self.installed.items()});(m.i.CODE/'install-files.json').write_bytes(self.old_bundle);(m.i.CODE/'install-files.json').chmod(0o600)
  hashes={name:sha((m.i.BACKUP/name).read_bytes()) for name in m.i.BASELINE}
  self.old_manifest=''.join(v+'  '+str(m.i.BACKUP/k)+'\n' for k,v in sorted(hashes.items())).encode();(m.i.BACKUP/'manifest.sha256').write_bytes(self.old_manifest);(m.i.BACKUP/'manifest.sha256').chmod(0o600)
  self.record=dict(host=self.host,phase='accepted' if self.host=='uain-app-1' else 'verified',bundle_sha256=sha(self.old_bundle),candidate_backup_hashes=hashes,profile=dict(host=self.host),profile_sha256='e'*64,acceptance_sha256='d'*64)
  m.i.JOURNAL.write_bytes(m.encode(self.record));m.i.JOURNAL.chmod(0o600)
  self.new_helper=b'# reviewed short-pause helper\nVALUE=1\n';self.new_entry=b'# reviewed entry\nVALUE=2\n';self.new_wrapper=b'#!/bin/sh\nexec new "$@"\n'
  for name,data in ((m.HELPER,self.new_helper),(m.ENTRY,self.new_entry),(m.WRAP,self.new_wrapper)):(m.BUNDLE/name).write_bytes(data)
  self.new_bundle=m.encode(dict({name:sha(data) for name,data in self.installed.items()},**{m.HELPER:sha(self.new_helper)}))
  (m.BUNDLE/'ops/chain/failover-install-files.json').write_bytes(self.new_bundle)
  self.files={m.HELPER:dict(old=sha(self.installed[m.HELPER]),new=sha(self.new_helper)),m.ENTRY:dict(old=sha(self.old_entry),new=sha(self.new_entry)),m.WRAP:dict(old=sha(self.old_wrapper),new=sha(self.new_wrapper))}
  self.approve()
 def tearDown(self):
  for p in reversed(self.patches):p.stop()
  self.tmp.cleanup()
 def approve(self,ident=IDENT,**changes):
  value=dict(schema=m.SCHEMA,id=ident,helper_sha256=sha(Path(m.__file__).read_bytes()),files=self.files,old_bundle_sha256=sha(self.old_bundle),bundle_sha256=sha(self.new_bundle),expires_at=time.time()+600);value.update(changes)
  path=m.CONFIG/('upgrade-helper-'+ident+'.json');path.write_bytes(m.encode(value));path.chmod(0o600);return value
 def apply(self):return m.transition(self.host,'apply',IDENT)
 def rollback(self):return m.transition(self.host,'rollback',IDENT)
 def paths(self):
  return {m.i.CODE/m.HELPER:(self.installed[m.HELPER],self.new_helper),m.i.BACKUP/'entry.py':(self.old_entry,self.new_entry),m.WRAPPER:(self.old_wrapper,self.new_wrapper),m.i.CODE/'install-files.json':(self.old_bundle,self.new_bundle)}
 def assert_side(self,side):
  for path,pair in self.paths().items():
   if path==m.WRAPPER and self.host!='uain-app-1':self.assertEqual(path.read_bytes(),pair[0]);continue
   self.assertEqual(path.read_bytes(),pair[side],path)
  self.assertEqual(json.loads(m.i.JOURNAL.read_bytes())['bundle_sha256'],sha((self.old_bundle,self.new_bundle)[side]))
  self.assertEqual((m.i.BACKUP/'manifest.sha256').read_bytes()==self.old_manifest,side==0)
  m.i.installed_files(m.i.journal())
 def untouched(self):
  self.assert_side(0);self.assertEqual(m.i.JOURNAL.read_bytes(),m.encode(self.record));self.assertFalse(m.UPGRADES.exists())

 def test_preview_changes_nothing(self):
  result=m.transition(self.host,'preview',IDENT);self.assertFalse(result['changed']);self.assertEqual(result['phase'],'not_started');self.untouched()
 def test_apply_replaces_exactly_the_approved_bytes_and_every_record_that_pins_them(self):
  result=self.apply();self.assertEqual(result['phase'],'applied');self.assert_side(1)
  self.assertEqual((m.i.CODE/m.HELPER).stat().st_mode&0o777,0o600);self.assertEqual(m.WRAPPER.stat().st_mode&0o777,0o700)
  # Unapproved installed files keep their bytes.
  for name,data in self.installed.items():
   if name!=m.HELPER:self.assertEqual((m.i.BACKUP/Path(name).name if name.startswith('ops/node-backup/') else m.i.CODE/name).read_bytes(),data)
  record=json.loads(m.i.JOURNAL.read_bytes())
  # Only the two digests and the appended upgrade entry differ in the journal.
  self.assertEqual({k:v for k,v in record.items() if k not in ('bundle_sha256','candidate_backup_hashes','helper_upgrades')},{k:v for k,v in self.record.items() if k not in ('bundle_sha256','candidate_backup_hashes')})
  self.assertEqual(record['candidate_backup_hashes'],dict(self.record['candidate_backup_hashes'],**{'entry.py':sha(self.new_entry)}))
  self.assertEqual([x['id'] for x in record['helper_upgrades']],[IDENT]);self.assertEqual(record['helper_upgrades'][0]['bundle_sha256'],sha(self.new_bundle))
  self.assertIn((sha(self.new_entry)+'  '+str(m.i.BACKUP/'entry.py')).encode(),(m.i.BACKUP/'manifest.sha256').read_bytes().splitlines())
  self.assertEqual(len((m.i.BACKUP/'manifest.sha256').read_bytes().splitlines()),len(self.old_manifest.splitlines()))
  root=m.UPGRADES/('helper-'+IDENT)
  self.assertEqual((root/'old'/'ops__chain__failover-backup.py').read_bytes(),self.installed[m.HELPER]);self.assertEqual((root/'old'/'install-journal.json').read_bytes(),m.encode(self.record))
  self.assertEqual(json.loads((root/'journal.json').read_bytes())['phase'],'applied')
 def test_apply_is_repeatable_and_rollback_restores_every_exact_byte(self):
  self.apply();again=self.apply();self.assertEqual(again['phase'],'applied');self.assert_side(1)
  self.assertEqual(len(json.loads(m.i.JOURNAL.read_bytes())['helper_upgrades']),1)
  result=self.rollback();self.assertEqual(result['phase'],'rolled_back');self.assert_side(0);self.assertEqual(m.i.JOURNAL.read_bytes(),m.encode(self.record))
  # Terminal: the same approval cannot reinstall after a rollback.
  with self.assertRaises(ValueError):self.apply()
  self.assert_side(0);self.assertFalse(self.rollback()['changed'])
 def test_refuses_bad_approvals_before_any_change(self):
  for changes in [dict(expires_at=0),dict(expires_at=time.time()+4000),dict(helper_sha256='f'*64),dict(schema='other'),dict(id='20261110-other'),dict(unexpected=True),dict(files={}),
                  dict(files=dict(self.files,**{'ops/chain/failover-node.py':dict(old='a'*64,new='b'*64)})),dict(files={m.HELPER:dict(old='a'*64,new=sha(self.new_helper))}),
                  dict(files={m.HELPER:dict(old=sha(self.installed[m.HELPER]),new='b'*64)}),dict(old_bundle_sha256='a'*64),dict(bundle_sha256='a'*64),dict(bundle_sha256=sha(self.old_bundle)),
                  dict(files={m.ENTRY:self.files[m.ENTRY]})]:
   self.approve(**changes)
   with self.subTest(changes=changes),self.assertRaises((ValueError,KeyError)):self.apply()
   self.untouched()
 def test_entry_only_upgrade_keeps_the_bundle_digest(self):
  self.approve(files={m.ENTRY:self.files[m.ENTRY]},bundle_sha256=sha(self.old_bundle))
  self.apply();self.assertEqual((m.i.CODE/m.HELPER).read_bytes(),self.installed[m.HELPER]);self.assertEqual((m.i.BACKUP/'entry.py').read_bytes(),self.new_entry)
  self.assertEqual(json.loads(m.i.JOURNAL.read_bytes())['bundle_sha256'],sha(self.old_bundle));m.i.installed_files(m.i.journal())
 def test_refuses_changed_installed_or_staged_bytes_before_any_change(self):
  cases=[(m.i.CODE/m.HELPER,b'# someone else changed this\n'),(m.BUNDLE/m.HELPER,b'# not the reviewed bytes\n'),(m.BUNDLE/m.ENTRY,b'def broken(:\n'),(m.i.BACKUP/'entry.py',b'# drifted\n'),
         (m.BUNDLE/'ops/chain/failover-install-files.json',m.encode(dict(json.loads(self.new_bundle),**{'ops/chain/failover-node.py':'a'*64})))]
  if self.host=='uain-app-1':cases.append((m.WRAPPER,b'#!/bin/sh\n# drifted\n'))
  for path,data in cases:
   before=path.read_bytes();path.write_bytes(data)
   with self.subTest(path=path),self.assertRaises((ValueError,SyntaxError)):self.apply()
   path.write_bytes(before);path.chmod(0o700 if path==m.WRAPPER else 0o600);self.untouched()
 def test_staged_syntax_errors_are_refused(self):
  bad=b'def broken(:\n';(m.BUNDLE/m.ENTRY).write_bytes(bad);self.files[m.ENTRY]=dict(old=sha(self.old_entry),new=sha(bad));self.approve()
  with self.assertRaises(SyntaxError):self.apply()
  self.untouched()
  if self.host!='uain-app-1':return
  bad=b'#!/bin/sh\nif then fi (\n';(m.BUNDLE/m.WRAP).write_bytes(bad);(m.BUNDLE/m.ENTRY).write_bytes(self.new_entry);self.files[m.ENTRY]=dict(old=sha(self.old_entry),new=sha(self.new_entry));self.files[m.WRAP]=dict(old=sha(self.old_wrapper),new=sha(bad));self.approve()
  with self.assertRaises(ValueError):self.apply()
  self.untouched()
 def test_refuses_marker_fence_restore_promotion_and_undrained_backup(self):
  for name in ['fence.json','restore.json','promotion-started.json','original-unit.service','fence.json.pending-1','failover-'+'a'*32+'.nodebk']:
   (m.EVIDENCE/name).write_bytes(b'{}')
   with self.subTest(name=name),self.assertRaises(ValueError):self.apply()
   (m.EVIDENCE/name).unlink();self.untouched()
  m.MARKER.write_bytes(b'{}')
  with self.assertRaises(ValueError):self.apply()
  m.MARKER.unlink();self.untouched()
  with patch.object(m,'assert_drained',side_effect=ValueError('backup running')),self.assertRaises(ValueError):self.apply()
  self.untouched()
 def test_wrong_install_phase_host_or_bundle_is_refused(self):
  other=next(h for h in m.i.HOSTS if h!=self.host)
  for changes in [dict(phase='prepared'),dict(phase='accepted' if self.host=='uain-db-1' else 'verified'),dict(host=other),dict(bundle_sha256='a'*64)]:
   m.i.JOURNAL.write_bytes(m.encode(dict(self.record,**changes)))
   with self.subTest(changes=changes),self.assertRaises(ValueError):self.apply()
   m.i.JOURNAL.write_bytes(m.encode(self.record));self.untouched()
 def test_in_flight_capture_or_run_refuses_at_once_and_custody_is_waited_for_briefly(self):
  for lock in (m.CAPTURE,m.RUN):
   with lock.open('a') as held:
    fcntl.flock(held,fcntl.LOCK_EX);started=time.monotonic()
    with self.subTest(lock=lock),self.assertRaises(BlockingIOError):self.apply()
    self.assertLess(time.monotonic()-started,0.3)
   self.untouched()
  with m.CUSTODY.open('a') as held:
   fcntl.flock(held,fcntl.LOCK_EX)
   with self.assertRaises(ValueError):self.apply()
   self.untouched()
   # A custody consumer that finishes within the wait does not refuse the upgrade.
   threading.Timer(0.15,lambda:fcntl.flock(held,fcntl.LOCK_UN)).start()
   self.assertEqual(self.apply()['phase'],'applied')
  self.assert_side(1)
 def test_death_at_any_write_leaves_only_known_bytes_and_both_ways_out(self):
  writes=6 if self.host=='uain-app-1' else 5 # helper, entry, (wrapper,) bundle pins, manifest, install journal
  for way in ('apply','rollback'):
   for death in range(writes):
    with self.subTest(way=way,death=death):
     self.tearDown();self.setUp()
     real=m.atomic;count=[0]
     def dying(path,data,mode,own=False):
      if not own:
       if count[0]==death:raise Killed()
       count[0]+=1
      return real(path,data,mode,own)
     with patch.object(m,'atomic',side_effect=dying),self.assertRaises(Killed):self.apply()
     root=m.UPGRADES/('helper-'+IDENT);self.assertEqual(json.loads((root/'journal.json').read_bytes())['phase'],'prepared')
     for path,pair in self.paths().items():self.assertIn(path.read_bytes(),pair)
     self.assertEqual(m.transition(self.host,way,IDENT)['phase'],'applied' if way=='apply' else 'rolled_back')
     self.assert_side(1 if way=='apply' else 0)
     if way=='rollback':self.assertEqual(m.i.JOURNAL.read_bytes(),m.encode(self.record))
 def test_torn_pending_file_beside_an_installed_file_refuses(self):
  pending=(m.i.CODE/m.HELPER).with_name('failover-backup.py.helper-upgrade-pending');pending.write_bytes(b'# half a fi')
  with self.assertRaises(ValueError):self.apply()
  self.assertTrue(pending.exists());self.assertEqual((m.i.CODE/m.HELPER).read_bytes(),self.installed[m.HELPER])
 def test_failed_check_after_the_write_puts_every_byte_back(self):
  for broken in ('preview_check','installed'):
   with self.subTest(broken=broken):
    self.tearDown();self.setUp()
    target=patch.object(m,'preview_check',side_effect=ValueError('role refused')) if broken=='preview_check' else patch.object(m.i,'installed_files',side_effect=[ValueError('pin differs'),None])
    with target,self.assertRaises(ValueError):self.apply()
    self.assert_side(0);self.assertEqual(m.i.JOURNAL.read_bytes(),m.encode(self.record))
    self.assertEqual(json.loads((m.UPGRADES/('helper-'+IDENT)/'journal.json').read_bytes())['phase'],'rolled_back')
 def test_unknown_bytes_after_the_upgrade_refuse_apply_and_rollback(self):
  self.apply();(m.i.CODE/m.HELPER).write_bytes(b'# edited by hand afterwards\n')
  for action in ('preview','apply','rollback'):
   with self.subTest(action=action),self.assertRaises(ValueError):m.transition(self.host,action,IDENT)
  self.assertEqual((m.i.CODE/m.HELPER).read_bytes(),b'# edited by hand afterwards\n')
 def test_stale_bytecode_of_a_replaced_module_is_removed(self):
  cache=m.i.CODE/'ops/chain/__pycache__';cache.mkdir();(cache/'failover-backup.cpython-312.pyc').write_bytes(b'old');(cache/'failover-node.cpython-312.pyc').write_bytes(b'keep')
  self.apply();self.assertFalse((cache/'failover-backup.cpython-312.pyc').exists());self.assertTrue((cache/'failover-node.cpython-312.pyc').exists())
 def test_drained_means_every_backup_unit_inactive(self):
  def show(args):return 'ActiveState=inactive' if args[2].endswith('.timer') else 'ActiveState=inactive\nMainPID=0'
  with patch.object(m,'run',side_effect=show) as run:ASSERT_DRAINED('uain-app-1');self.assertEqual(run.call_count,5)
  with patch.object(m,'run',side_effect=show) as run:ASSERT_DRAINED('uain-db-1');self.assertEqual(run.call_count,1)
  for target,answer in [('uain-node-backup.timer','ActiveState=active'),('uain-node-backup.service','ActiveState=activating\nMainPID=7'),('uain-node-backup.service','ActiveState=failed\nMainPID=0'),('uain-node-backup-capture.service','ActiveState=active\nMainPID=9')]:
   def busy(args,target=target,answer=answer):return answer if args[2]==target else show(args)
   with self.subTest(target=target,answer=answer),patch.object(m,'run',side_effect=busy),self.assertRaises(ValueError):ASSERT_DRAINED('uain-app-1')
 def test_installed_helper_must_name_this_hosts_original_role(self):
  good=json.dumps(dict(inventory=dict(host='uain-app-1'),node_role=dict(name='original_validator',binding=None),canonical_install=False))
  with patch.object(m,'run',return_value=good) as run:
   self.assertEqual(PREVIEW_CHECK('uain-app-1'),'original_validator');self.assertEqual(run.call_args[0][0][-1],'preview')
   with self.assertRaises(ValueError):PREVIEW_CHECK('uain-db-1')
  for bad in [dict(inventory=dict(host='uain-app-1'),node_role=dict(name='fenced_source',binding={})),dict(inventory=dict(host='uain-app-1'),node_role=dict(name='original_validator',binding={}))]:
   with patch.object(m,'run',return_value=json.dumps(bad)),self.assertRaises(ValueError):PREVIEW_CHECK('uain-app-1')
 def test_manifest_changes_exactly_one_line(self):
  changed=m.manifest_lines(self.old_manifest,'entry.py','9'*64).splitlines();old=self.old_manifest.splitlines()
  self.assertEqual(len(changed),len(old));self.assertEqual(sum(a!=b for a,b in zip(changed,old)),1)
  with self.assertRaises(ValueError):m.manifest_lines(self.old_manifest,'missing.py','9'*64)
  with self.assertRaises(ValueError):m.manifest_lines(self.old_manifest+self.old_manifest,'entry.py','9'*64)
 def test_probe_requires_the_fresh_nonce_and_reports_both_bundles(self):
  def answer(bundle,nonce=None,host='uain-db-1'):
   def call(command,input=None,**kwargs):
    self.assertEqual(command[-1],'failover-probe');self.assertIn('StrictHostKeyChecking=yes',command)
    sent=json.loads(input)['nonce'];return Mock(returncode=0,stdout=json.dumps(dict(nonce=nonce or sent,inventory=dict(host=host,binary_sha256='b'*64),bundle_sha256=bundle)).encode())
   return call
  with patch.object(m.subprocess,'run',side_effect=answer(sha(self.old_bundle))):self.assertTrue(m.probe('uain-app-1')['bundles_match'])
  with patch.object(m.subprocess,'run',side_effect=answer('a'*64)):self.assertFalse(m.probe('uain-app-1')['bundles_match'])
  for bad in (answer(sha(self.old_bundle),nonce='0'*64),answer(sha(self.old_bundle),host='uain-app-1')):
   with patch.object(m.subprocess,'run',side_effect=bad),self.assertRaises(ValueError):m.probe('uain-app-1')
 def test_repository_pin_file_matches_the_repository_sources(self):
  # The bundle manifest went stale once (#402 changed the helper, not its pin).
  values=json.loads((HERE/'failover-install-files.json').read_bytes());self.assertEqual(set(values),set(m.i.FILES))
  for name,pin in values.items():self.assertEqual(sha((HERE.parents[1]/name).read_bytes()),pin,name)

class DatabaseHostTest(HelperUpgradeTest):
 host='uain-db-1'
 def test_database_host_has_no_wrapper_and_requires_a_verified_install(self):
  result=self.apply();self.assertEqual(result['phase'],'applied');self.assertEqual(m.WRAPPER.read_bytes(),self.old_wrapper)
  self.assertNotIn('ops__node-backup__uain-node-backup',result['files']);self.assertFalse(result['timers_left_stopped'])
  self.assertEqual(set(json.loads(m.i.JOURNAL.read_bytes())['helper_upgrades'][0]['files']),{m.HELPER,m.ENTRY})

if __name__=='__main__':unittest.main()

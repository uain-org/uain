import copy
import hashlib
import importlib.util
import importlib._bootstrap_external
import shutil
import json
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch, Mock

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('upgrade',HERE/'upgrade-consensus-v2-profile.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
ASSERT_STOPPED=m.assert_stopped;ASSERT_DRAINED=m.assert_drained;CHECK_INSTALL=m.check_install;CHECK_PRIOR=m.check_prior;CURRENT_PROFILE=m.current_profile

class UpgradeTest(unittest.TestCase):
 def setUp(self):
  base=HERE.parents[1]/'upgrade-profile-test-tmp';base.mkdir(mode=0o700,exist_ok=True)
  self.tmp=tempfile.TemporaryDirectory(dir=base);self.root=Path(self.tmp.name);self.patches=[]
  for name,value in {'PROFILE':self.root/'config/node.json','APPROVAL':self.root/'config/upgrade-0.4.1.json','UNIT':self.root/'unit.service','ROOT':self.root/'upgrade','EVIDENCE':self.root/'evidence','MARKER':self.root/'restart','CUSTODY':self.root/'custody.lock','CAPTURE':self.root/'capture.lock','PRIOR':self.root/'prior.json'}.items():
   self.patches.append(patch.object(m,name,value));self.patches[-1].start()
  m.PROFILE.parent.mkdir(mode=0o700);m.EVIDENCE.mkdir(mode=0o700)
  for lock in (m.CUSTODY,m.CAPTURE):lock.touch(mode=0o600)
  self.original=m.i.profile('uain-app-1');self.old=dict(self.original,binary='/opt/uain-chain/releases/'+m.OLD_DAEMON+'/uaind',binary_sha256=m.OLD_DAEMON);self.old_unit=('User=uain-chain\nGroup=uain-chain\nWorkingDirectory='+self.old['home']+'\nExecStart='+self.old['binary']+' start --home '+self.old['home']+'\n').encode()
  self.old['unit_sha256']=m.digest(self.old_unit)
  m.PROFILE.write_bytes(m.encode(self.old));m.PROFILE.chmod(0o600);m.UNIT.write_bytes(self.old_unit);m.UNIT.chmod(0o644)
  self.new_sha=m.NEW_DAEMON;self.new_unit=self.old_unit.replace(self.old['binary'].encode(),('/opt/uain-chain/releases/'+self.new_sha+'/uaind').encode())
  self.approval={'schema':'uain-stopped-node-upgrade-v1','release':'0.4.1','old_binary_sha256':m.OLD_DAEMON,'binary_sha256':self.new_sha,'genesis_sha256':m.GENESIS,'helper_sha256':m.digest(Path(m.__file__).read_bytes()),'unit_sha256':{h:(m.digest(self.new_unit) if h=='uain-app-1' else 'c'*64) for h in m.i.HOSTS},'installation_acceptance_sha256':'d'*64,'expires_at':m.time.time()+600}
  m.APPROVAL.write_bytes(m.encode(self.approval));m.APPROVAL.chmod(0o600)
  self.patches.extend([patch.object(m.i,'profile',side_effect=lambda h:dict(self.old,host=h)),patch.object(m,'assert_stopped'),patch.object(m,'assert_drained'),patch.object(m,'check_binary'),patch.object(m,'check_genesis'),patch.object(m,'check_install'),patch.object(m,'stopped_tree',return_value={'sha256':'a'*64,'files':3,'bytes':9}),patch.object(m,'run',return_value='')])
  for p in self.patches[9:]:p.start()
  self.patches.extend([patch.object(m,'current_profile',side_effect=lambda h:dict(self.old,host=h)),patch.object(m,'NEW_UNITS',self.approval['unit_sha256']),patch.object(m,'check_prior'),patch.object(m,'old_profile_digest',side_effect=lambda host:m.digest(m.encode(self.old)))])
  for p in self.patches[-4:]:p.start()
 def tearDown(self):
  for p in reversed(self.patches):p.stop()
  self.tmp.cleanup()
 def apply(self):return m.transition('uain-app-1','apply')
 def test_profile_preserves_every_nonrelease_field_and_archives_exact_bytes(self):
  before=m.PROFILE.read_bytes();self.apply();after=json.loads(m.PROFILE.read_bytes())
  self.assertEqual({k:v for k,v in after.items() if k not in ('binary','binary_sha256','unit_sha256')},{k:v for k,v in self.old.items() if k not in ('binary','binary_sha256','unit_sha256')})
  self.assertEqual((m.ROOT/'old-profile.json').read_bytes(),before);self.assertEqual((m.ROOT/'old-unit.service').read_bytes(),self.old_unit);self.assertEqual(m.UNIT.read_bytes(),self.new_unit)
  self.assertEqual(after['binary_sha256'],self.new_sha);self.assertEqual(after['unit_sha256'],m.digest(self.new_unit))
 def test_preview_changes_nothing(self):
  self.assertFalse(m.transition('uain-app-1','preview')['changed']);self.assertFalse(m.ROOT.exists());self.assertEqual(m.UNIT.read_bytes(),self.old_unit)
 def test_rejects_changed_profile_scope_before_mutation(self):
  for key,value in {'home':'/other','host':'uain-db-1','rpc_port':1,'p2p_ip':'127.0.0.1','service_user':'root','unit_sha256':'f'*64}.items():
   m.PROFILE.write_bytes(m.encode(dict(self.old,**{key:value})))
   with self.subTest(key=key),self.assertRaises(ValueError):self.apply()
   self.assertFalse(m.ROOT.exists())
 def test_rejects_expired_wrong_release_helper_and_approval_fields(self):
  for changed in [{'expires_at':0},{'expires_at':m.time.time()+4000},{'release':'0.3.9'},{'old_binary_sha256':'f'*64},{'helper_sha256':'f'*64},{'genesis_sha256':'f'*64},{'unexpected':True}]:
   m.APPROVAL.write_bytes(m.encode(dict(self.approval,**changed)))
   with self.subTest(changed=changed),self.assertRaises(ValueError):self.apply()
   self.assertFalse(m.ROOT.exists())
 def test_rejects_fence_restore_promotion_pending_and_backup_restart(self):
  for name in ['fence.json','restore.json','promotion-started.json','original-unit.service','fence.json.pending-123','failover-'+('a'*32)+'.nodebk']:
   path=m.EVIDENCE/name;path.write_bytes(b'{}')
   with self.subTest(name=name),self.assertRaises(ValueError):self.apply()
   path.unlink();self.assertFalse(m.ROOT.exists())
  m.MARKER.write_bytes(b'{}')
  with self.assertRaises(ValueError):self.apply()
 def test_running_process_ports_or_timers_refuse_before_mutation(self):
  for check in ['assert_stopped','assert_drained']:
   with self.subTest(check=check),patch.object(m,check,side_effect=ValueError('not stopped')),self.assertRaises(ValueError):self.apply()
   self.assertFalse(m.ROOT.exists())
 def test_drained_timers_have_no_systemd_mainpid_property(self):
  def show(args):return 'ActiveState=inactive' if args[2].endswith('.timer') else 'ActiveState=inactive\nMainPID=0'
  with patch.object(m,'run',side_effect=show):ASSERT_DRAINED('uain-app-1')
 def test_active_timer_and_missing_service_pid_are_refused(self):
  for target in ('uain-node-backup.timer','uain-node-backup.service'):
   def show(args):
    if args[2]==target:return 'ActiveState=active' if target.endswith('.timer') else 'ActiveState=inactive'
    return 'ActiveState=inactive' if args[2].endswith('.timer') else 'ActiveState=inactive\nMainPID=0'
   with self.subTest(target=target),patch.object(m,'run',side_effect=show),self.assertRaises(ValueError):ASSERT_DRAINED('uain-app-1')
 def test_changed_unit_or_new_unit_digest_is_refused(self):
  m.UNIT.write_bytes(self.old_unit+b'# changed')
  with self.assertRaises(ValueError):self.apply()
  m.UNIT.write_bytes(self.old_unit);self.approval['unit_sha256']['uain-app-1']='d'*64;m.APPROVAL.write_bytes(m.encode(self.approval))
  with self.assertRaises(ValueError):self.apply()
 def test_interrupted_each_atomic_replacement_resumes_exact_pair(self):
  atomic=m.atomic
  for point in [m.UNIT,m.PROFILE,m.ROOT/'journal.json']:
   self.tmp.cleanup();self.tearDown();self.setUp();atomic=m.atomic;fired=False
   def interrupted(path,data,mode=0o600):
    nonlocal fired
    atomic(path,data,mode)
    if Path(path)==point and not fired:fired=True;raise RuntimeError('power loss')
   # Rebind point after recreating its private temporary directory.
   point={'unit.service':m.UNIT,'node.json':m.PROFILE,'journal.json':m.ROOT/'journal.json'}[point.name]
   with self.subTest(point=point.name),patch.object(m,'atomic',side_effect=interrupted),self.assertRaises(RuntimeError):self.apply()
   self.apply();self.assertEqual(m.UNIT.read_bytes(),self.new_unit);self.assertEqual(json.loads(m.PROFILE.read_bytes())['unit_sha256'],m.digest(self.new_unit))
 def test_rollback_restores_both_pins_before_reload_and_never_starts(self):
  self.apply()
  with patch.object(m,'run',return_value='') as run:m.transition('uain-app-1','rollback')
  self.assertEqual(m.UNIT.read_bytes(),self.old_unit);self.assertEqual(json.loads(m.PROFILE.read_bytes()),self.old)
  self.assertFalse(any('start' in c.args[0] or 'unmask' in c.args[0] for c in run.call_args_list))
  self.assertEqual(json.loads((m.ROOT/'journal.json').read_bytes())['phase'],'rolled_back')
  with self.assertRaises(ValueError):self.apply()
 def test_rollback_interrupted_profile_update_is_recoverable(self):
  self.apply();atomic=m.atomic
  def interrupted(path,data,mode=0o600):
   atomic(path,data,mode)
   if Path(path)==m.UNIT:raise RuntimeError('power loss')
  with patch.object(m,'atomic',side_effect=interrupted),self.assertRaises(RuntimeError):m.transition('uain-app-1','rollback')
  m.transition('uain-app-1','rollback');self.assertEqual(m.UNIT.read_bytes(),self.old_unit);self.assertEqual(json.loads(m.PROFILE.read_bytes()),self.old)
 def test_unrecognized_pending_or_current_state_cannot_be_overwritten(self):
  self.apply();m.PROFILE.with_name(m.PROFILE.name+'.upgrade-pending').write_bytes(b'{}')
  with self.assertRaises(ValueError):m.transition('uain-app-1','rollback')
  self.assertEqual(m.UNIT.read_bytes(),self.new_unit)
 def test_completed_rollback_refuses_later_new_or_mixed_pair(self):
  self.apply();m.transition('uain-app-1','rollback');m.UNIT.write_bytes(self.new_unit)
  with self.assertRaises(ValueError):m.transition('uain-app-1','rollback')
 def test_recognized_pending_profile_only_resumes_journaled_transaction(self):
  atomic=m.atomic
  def interrupted(path,data,mode=0o600):
   atomic(path,data,mode)
   if Path(path)==m.UNIT:raise RuntimeError('power loss')
  with patch.object(m,'atomic',side_effect=interrupted),self.assertRaises(RuntimeError):self.apply()
  new=dict(self.old,binary='/opt/uain-chain/releases/'+self.new_sha+'/uaind',binary_sha256=self.new_sha,unit_sha256=m.digest(self.new_unit))
  m.PROFILE.with_name(m.PROFILE.name+'.upgrade-pending').write_bytes(m.encode(new))
  self.apply();self.assertEqual(json.loads(m.PROFILE.read_bytes()),new)
 def test_fresh_approval_can_extend_only_identical_pinned_plan(self):
  self.apply();self.approval['expires_at']=m.time.time()+700;m.APPROVAL.write_bytes(m.encode(self.approval));self.apply()
  self.approval['binary_sha256']='e'*64;m.APPROVAL.write_bytes(m.encode(self.approval))
  with self.assertRaises(ValueError):self.apply()
 def test_untrusted_dependency_is_rejected_before_its_code_executes(self):
  directory=self.root/'untrusted';directory.mkdir();helper=directory/'upgrade-consensus-v2-profile.py';helper.write_bytes(Path(m.__file__).read_bytes())
  (directory/'failover-install.py').write_text("raise RuntimeError('UNTRUSTED MODULE EXECUTED')\n")
  result=subprocess.run(['/usr/bin/python3','-I',str(helper),'preview'],capture_output=True)
  self.assertNotEqual(result.returncode,0);self.assertIn(b'Pinned root upgrade dependency refused',result.stderr);self.assertNotIn(b'UNTRUSTED MODULE EXECUTED',result.stderr)
 def forged_cache_is_rejected(self,name):
  directory=self.root/('forged-'+Path(name).stem);chain=directory/'ops/chain';chain.mkdir(parents=True)
  helper=chain/'upgrade-consensus-v2-profile.py';helper.write_bytes(Path(m.__file__).read_bytes())
  for dependency in m.DEPENDENCIES:
   target=chain/dependency;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(HERE/dependency,target)
  source=chain/name;metadata=source.stat();cache=Path(importlib.util.cache_from_source(str(source)));cache.parent.mkdir(exist_ok=True)
  code=compile("raise RuntimeError('FORGED VALID BYTECODE EXECUTED')\n",str(source),'exec')
  cache.write_bytes(importlib._bootstrap_external._code_to_timestamp_pyc(code,int(metadata.st_mtime),metadata.st_size))
  result=subprocess.run(['/usr/bin/python3','-I',str(helper),'preview'],capture_output=True)
  self.assertNotEqual(result.returncode,0);self.assertNotIn(b'FORGED VALID BYTECODE EXECUTED',result.stderr);self.assertIn(b'Pinned dependency bytecode cache refused',result.stderr)
 def test_forged_installer_valid_bytecode_is_refused(self):self.forged_cache_is_rejected('failover-install.py')
 def test_forged_node_valid_bytecode_is_refused(self):self.forged_cache_is_rejected('failover-node.py')
 def test_forged_archive_valid_bytecode_is_refused(self):self.forged_cache_is_rejected('../reset/archive.py')
 def test_database_transition_preserves_original_fullnode_scope(self):
  self.old.update(host='uain-db-1',p2p_ip='10.98.0.2');m.PROFILE.write_bytes(m.encode(self.old));self.approval['unit_sha256']['uain-db-1']=m.digest(self.new_unit);m.APPROVAL.write_bytes(m.encode(self.approval))
  m.transition('uain-db-1','apply');after=json.loads(m.PROFILE.read_bytes());self.assertEqual(after['host'],'uain-db-1');self.assertEqual(after['p2p_ip'],'10.98.0.2')
 def test_local_stopped_proof_rejects_pid_processes_ports_and_wrong_role(self):
  node=Mock();node.p=self.old;node.unit_file=m.UNIT;node.home=Path(self.old['home']);node.system_state.return_value={'active':'inactive','pid':0};node.matching_processes.return_value=[];node.listening_ports.return_value=[]
  with patch.object(m,'stopped_node',return_value=node):
   ASSERT_STOPPED(self.old);node.require_single_signer.assert_called_with(node.home,True)
   for state,processes,ports in [({'active':'active','pid':1},[],[]),({'active':'inactive','pid':1},[],[]),({'active':'inactive','pid':0},[42],[]),({'active':'inactive','pid':0},[],[26667])]:
    node.system_state.return_value=state;node.matching_processes.return_value=processes;node.listening_ports.return_value=ports
    with self.assertRaises(ValueError):ASSERT_STOPPED(self.old)
   node.listening_ports.return_value=[];node.require_single_signer.side_effect=ValueError('wrong signer')
   with self.assertRaises(ValueError):ASSERT_STOPPED(self.old)
 def test_timer_and_capture_drain_is_checked_without_stopping_anything(self):
  with patch.object(m,'run',return_value='ActiveState=inactive\nMainPID=0') as run:ASSERT_DRAINED('uain-app-1');self.assertEqual(len(run.call_args_list),4)
  for state in ['ActiveState=active\nMainPID=1','ActiveState=inactive\nMainPID=1','ActiveState=activating\nMainPID=0']:
   with patch.object(m,'run',return_value=state),self.assertRaises(ValueError):ASSERT_DRAINED('uain-app-1')
 def test_install_acceptance_precedes_upgrade_and_binds_first_paired_receipt(self):
  record=dict(host='uain-app-1',profile=self.original,profile_sha256=m.digest(m.encode(self.original)),phase='accepted',acceptance_sha256=self.approval['installation_acceptance_sha256'])
  with patch.object(m.i,'journal',return_value=record),patch.object(m.i,'profile',return_value=self.original),patch.object(m.i,'installed_files') as files:
   CHECK_INSTALL('uain-app-1',self.old,self.approval);files.assert_called_once()
   for changes in [{'phase':'verified'},{'phase':'prepared'},{'acceptance_sha256':'f'*64},{'profile_sha256':'f'*64}]:
    with patch.object(m.i,'journal',return_value=dict(record,**changes)),self.assertRaises(ValueError):CHECK_INSTALL('uain-app-1',self.old,self.approval)
 def test_rollback_verifies_only_old_executable_and_never_executes_new_daemon(self):
  self.apply()
  with patch.object(m,'check_binary') as check:m.transition('uain-app-1','rollback');check.assert_called_once_with(self.old)
 def test_changed_highest_node_state_refuses_replay_and_rollback(self):
  self.apply()
  for action in ['apply','rollback']:
   with self.subTest(action=action),patch.object(m,'stopped_tree',return_value={'sha256':'f'*64,'files':3,'bytes':9}),self.assertRaises(ValueError):m.transition('uain-app-1',action)
   self.assertEqual(m.UNIT.read_bytes(),self.new_unit)
 def test_unknown_action_has_no_arbitrary_execution(self):
  for action in ['start','promote','unmask','release','install']:
   with self.subTest(action=action),self.assertRaises(ValueError):m.transition('uain-app-1',action)

 def test_current_profile_binds_exact_current_old_release_and_profile(self):
  with patch.object(m.i,'profile',return_value=self.original):
   p=CURRENT_PROFILE('uain-app-1')
   self.assertEqual(p['binary_sha256'],m.OLD_DAEMON)
   self.assertEqual(m.digest(m.encode(p)),m.CURRENT['uain-app-1']['profile'])
 def test_prior_journal_digest_and_applied_original_to_current_links(self):
  old=self.original;current=self.old
  prior=dict(schema='uain-stopped-node-upgrade-journal-v1',host='uain-app-1',phase='applied',plan_sha256=m.PRIOR_PLAN,old_profile_sha256=m.digest(m.encode(old)),new_profile_sha256=m.digest(m.encode(current)),old_unit_sha256=old['unit_sha256'],new_unit_sha256=current['unit_sha256'],stopped_state_sha256='a'*64)
  def write(value):m.PRIOR.write_bytes(m.encode(value));m.PRIOR.chmod(0o600)
  write(prior)
  pins=copy.deepcopy(m.CURRENT);pins['uain-app-1']['journal']=m.digest(m.encode(prior))
  with patch.object(m,'CURRENT',pins):
   CHECK_PRIOR('uain-app-1',old,current)
   for changes in ({'phase':'prepared'},{'new_profile_sha256':'f'*64},{'new_unit_sha256':'f'*64},{'plan_sha256':'f'*64}):
    write(dict(prior,**changes))
    pins['uain-app-1']['journal']=m.digest(m.PRIOR.read_bytes())
    with self.subTest(changes=changes),self.assertRaises(ValueError):CHECK_PRIOR('uain-app-1',old,current)
   write(prior);pins['uain-app-1']['journal']='0'*64
   with self.assertRaises(ValueError):CHECK_PRIOR('uain-app-1',old,current)
  m.PRIOR.unlink()
  with self.assertRaises(FileNotFoundError):CHECK_PRIOR('uain-app-1',old,current)
 def test_new_binary_and_all_host_unit_pins_are_fixed(self):
  for changes in ({'binary_sha256':'1604415b7302bf70236d50e6c999b7ab95d3029da697090f6bac08cddaee91a6'},{'binary_sha256':'a556673e557b6fdf57a18cae4e8bba2983dd1b9a05c83b16f4cc1fb081cc5e32'},{'binary_sha256':'f'*64},{'unit_sha256':dict(self.approval['unit_sha256'],**{'uain-db-1':'f'*64})}):
   m.APPROVAL.write_bytes(m.encode(dict(self.approval,**changes)))
   with self.assertRaises(ValueError):self.apply()
  m.APPROVAL.write_bytes(m.encode(dict(self.approval,binary_sha256='b525c808aa017865ec798869f2d72f5ba5ce0e6fb432cb7700bb8a2a29260024')))
  self.assertEqual(self.apply()['phase'],'applied')
 def test_original_037_or_wrong_038_profile_is_refused(self):
  for value in (self.original,dict(self.old,binary_sha256='f'*64)):
   m.PROFILE.write_bytes(m.encode(value))
   with self.assertRaises(ValueError):self.apply()
 def test_preview_never_reconciles_pending_journal(self):
  self.apply();path=m.ROOT/'journal.json';pending=path.with_name(path.name+'.upgrade-pending')
  candidate=json.loads(path.read_bytes());candidate['phase']='rolled_back';pending.write_bytes(m.encode(candidate));pending.chmod(0o600)
  before={p:p.read_bytes() for p in (path,pending,m.UNIT,m.PROFILE)}
  m.transition('uain-app-1','preview')
  self.assertEqual(before,{p:p.read_bytes() for p in before})

 def test_preview_does_not_create_lock_or_any_other_file(self):
  m.CUSTODY.unlink();m.CAPTURE.unlink()
  before={str(p.relative_to(self.root)):p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
  with self.assertRaises(FileNotFoundError):m.transition('uain-app-1','preview')
  self.assertEqual(before,{str(p.relative_to(self.root)):p.read_bytes() for p in self.root.rglob('*') if p.is_file()})

 def test_semantically_equal_old_profile_whitespace_drift_is_refused(self):
  m.PROFILE.write_bytes(m.encode(self.old)+b'\n')
  with self.assertRaises(ValueError):self.apply()
  self.assertFalse(m.ROOT.exists());self.assertEqual(m.UNIT.read_bytes(),self.old_unit)

if __name__=='__main__':unittest.main()

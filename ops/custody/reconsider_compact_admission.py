"""One-event recovery for the documented compact-account screening refusal.

Run only as root under the existing custody flock. No arbitrary CLI arguments,
cursor rewinds, refusal deletion, or new signing protocol are exposed.
"""
import fcntl,json,os,resource,sys
from pathlib import Path
import native_admission as admission

HELPER_SHA='b35c7e254fe3e5f61b9c4eac4176d634486339a535bfe63e40489e7037f6c270'
CHAIN='uain-shadow-20261008-1'
GENESIS='54140a9243c4591ccc9f2e9d49543fc68b87b3e0045416174c232e9dd498f8ff'
MEMBER='uain177fec24b184d1eddcce88c86deeab0d7367b675b'
EVENT=dict(id='481',height='1214880',member=MEMBER,subject=MEMBER,operation='enrol',command_digest='560822ace325f15112c6cb9f06072c2fc58fc6d37ec138ae6b46b5b01c6f5a30')
METADATA='b9ecfd60bf30cbaf1b28798f37186c8baf1a66a5e454f96c68d21730d85b1263'
require=admission.require

def run(custody,p,directory,runtime):
 """Dependency-injected core; the executable enforces root, lock and paths."""
 admission.validate_policy(p)
 require(p['chain_id']==CHAIN and p['genesis_sha256']==GENESIS)
 helper=admission.native.protected_read(Path(admission.__file__),1024*1024)
 require(admission.digest(helper)==HELPER_SHA)
 directory=Path(directory)
 original=admission.native.protected_read(directory/'refused.json',1024*1024)
 refusal=admission.native.strict_json(original)
 policy_digest=admission.digest(admission.canonical(p))
 require(type(refusal)==dict and set(refusal)=={'schema','policy_sha256','enrol_event','reason','proved_context'})
 require(refusal['schema']=='uain-native-admission-refusal-v1' and refusal['policy_sha256']==policy_digest and refusal['enrol_event']==EVENT and refusal['reason']=='role-or-account-override')
 old=refusal['proved_context']
 require(type(old)==dict and set(old)=={'chain_id','height','event_count','member'} and old['chain_id']==CHAIN and old['height']=='1214882' and old['event_count']=='481')
 target=old['member']
 require(type(target)==dict and target.get('id')==MEMBER and target.get('account_policy')=='compact-account-v1' and target.get('metadata_digest')==METADATA)
 require(target.get('name')==target.get('operator')==target.get('family')=='' and target.get('licence')=='pending' and target.get('sequence')=='1')
 require(target.get('creator') is False and target.get('default_verifier') is False and admission.zero(target.get('karma')) and target.get('credits')=='0' and admission.zero(target.get('active_projects')))
 require(target.get('id')=='uain1'+admission.digest(admission.public_key(target.get('public_key')))[:40])
 audit=dict(schema='uain-compact-admission-reconsideration-v1',enrol_event=EVENT,chain_id=CHAIN,genesis_sha256=GENESIS,policy_sha256=policy_digest,refusal_sha256=admission.digest(original),helper_sha256=HELPER_SHA,recovery_sha256=admission.digest(admission.native.protected_read(Path(__file__),1024*1024)))
 audit_path=directory/'reconsideration.json'
 retained=audit_path.exists()
 if retained:require(admission.load(audit_path)==audit)
 else:
  # An unexplained retained attempt must never be adopted by a new recovery.
  require(not any(directory.glob('attempt-*.json')) and not (directory/'journal.json').exists() and not (directory/'evidence.json').exists())
 state=runtime.read(admission.selection(p,EVENT))
 admission.guardian_context(p,state)
 require(state['records'][admission.event_key(481)]==EVENT)
 current=state['records']['member/'+MEMBER]
 require(type(current)==dict and current.get('public_key')==target['public_key'] and current.get('id')==MEMBER and current.get('account_policy')=='compact-account-v1' and current.get('metadata_digest')==METADATA)
 require(current.get('licence') in ('pending','active') and current.get('sequence')=='1' and current.get('creator') is False and current.get('default_verifier') is False and admission.zero(current.get('karma')) and current.get('credits')=='0' and admission.zero(current.get('active_projects')))
 admission.admission_identity(current,state['records'])
 if not retained or not (directory/'journal.json').exists():admission.screen(p,EVENT,state)
 if not retained:admission.atomic(audit_path,audit)
 result=admission.process_enrol(custody,p,EVENT,directory,runtime)
 require(admission.native.protected_read(directory/'refused.json',1024*1024)==original)
 return dict(schema='uain-compact-admission-reconsideration-result-v1',status=result['status'],done=result['done'],private_keys_exported=False)

def main():
 require(len(sys.argv)==1 and os.geteuid()==0)
 resource.setrlimit(resource.RLIMIT_CORE,(0,0));os.umask(0o077)
 fd=os.open('/run/lock/uain-custody.lock',os.O_RDONLY|os.O_NOFOLLOW)
 try:
  # Same lock as /usr/local/sbin/uain-custody. Refuse rather than run unlocked.
  fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  import custody
  p=admission.validate_policy(admission.load(admission.POLICY))
  admission.ensure_directory(admission.ROOT);admission.ensure_directory(admission.TEMP)
  directory=admission.ROOT/GENESIS/'481';admission.ensure_directory(directory)
  print(json.dumps(run(custody,p,directory,admission.Runtime(p))))
 finally:os.close(fd)

if __name__=='__main__':main()

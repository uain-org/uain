"""Root-only fixed Unix research-review signer/once-only relay. No TCP or caller state."""
import base64,hashlib,json,os,socket,socketserver,stat,struct,sys,re,time,types,resource
from pathlib import Path
from http.server import BaseHTTPRequestHandler
# The direct root CLI validates the complete local source closure before any
# application module executes. Deployment creates this protected public manifest;
# its own bytes are not recursively included in its source list.
SOURCE_MANIFEST=Path('/etc/uain-custody/central-reviewer-sources.json')
SOURCE_NAMES=('native_migration','guardian_quorum','native_admission','holder_release','central_reviewer','custody','fleet_attestation','central_reviewer_server')
def source_read(path):
 path=Path(path);require_source(path.resolve()==path)
 for parent in path.parents:
  info=parent.stat();require_source(stat.S_ISDIR(info.st_mode) and info.st_uid==0 and not info.st_mode&0o022)
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  info=os.fstat(fd);require_source(stat.S_ISREG(info.st_mode) and info.st_uid==0 and not info.st_mode&0o022 and info.st_nlink==1 and 0<info.st_size<=1024*1024)
  with os.fdopen(fd,'rb',closefd=False) as stream:raw=stream.read(1024*1024+1)
  after=os.fstat(fd);require_source(len(raw)==info.st_size and (info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns))
  return raw
 finally:os.close(fd)
def require_source(value):
 if not value:raise ValueError('Pinned central reviewer source refused')
def bootstrap_sources(directory=None,manifest=None):
 require_source(os.geteuid()==0);sys.dont_write_bytecode=True
 directory=Path(__file__).absolute().parent if directory is None else Path(directory)
 manifest=SOURCE_MANIFEST if manifest is None else Path(manifest)
 def unique(pairs):
  value={}
  for key,item in pairs:require_source(key not in value);value[key]=item
  return value
 approved=json.loads(source_read(manifest),object_pairs_hook=unique)
 require_source(type(approved)==dict and set(approved)=={'schema','sha256'} and approved['schema']=='uain-central-reviewer-sources-v1')
 pins=approved['sha256'];require_source(type(pins)==dict and set(pins)=={name+'.py' for name in SOURCE_NAMES})
 sources={}
 for name in SOURCE_NAMES:
  raw=source_read(directory/(name+'.py'));pin=pins[name+'.py']
  require_source(type(pin)==str and re.fullmatch('[a-f0-9]{64}',pin) and hashlib.sha256(raw).hexdigest()==pin)
  sources[name]=compile(raw,str(directory/(name+'.py')),'exec',dont_inherit=True)
 # Preload in dependency order; Python imports resolve only these reviewed
 # application modules. Installed interpreter/crypto/pykeepass are runtime deps.
 for name in SOURCE_NAMES[:-1]:
  module=types.ModuleType(name);module.__file__=str(directory/(name+'.py'));sys.modules[name]=module
  exec(sources[name],module.__dict__)
 return approved

def disable_core():resource.setrlimit(resource.RLIMIT_CORE,(0,0))
LOADED_SOURCE_PINS=None
if __name__=='__main__':
 require_source(sys.flags.isolated);disable_core();LOADED_SOURCE_PINS=bootstrap_sources()
import central_reviewer as r
import native_admission as admission
import native_migration as native
import fleet_attestation as fa
from holder_release import read as protected_read,write as protected_write
PROFILE=Path('/etc/uain-custody/central-reviewer.json')
IDENTITY=Path('/var/lib/uain-custody/central-reviewer/identity.json')
SOCKET=Path('/run/uain-central-reviewer/custody.sock')
NATIVE_TEMP=Path('/run/uain-central-reviewer/native-proof')
def runtime_for_request():
 admission.TEMP=NATIVE_TEMP;admission.ensure_directory(NATIVE_TEMP)
 return admission.Runtime(r.proof_policy(admission.load('/etc/uain-custody/native-admission.json')))
FIELDS={'schema','chain_id','genesis_sha256','reviewer','public_key','peer_uid','socket_gid','socket_path'}
OPTIONAL={'acceptance_attestations','fleet_attestations','fleet_attestation_parts'}
# Signed fleet verification envelopes custody stores per submission (fleet_attestation.attest output).
FLEET_ROOT=r.ROOT/'fleet-attestations'
FLEET_RULE={'policy_path','policy_digest','criteria_digest','attestation_public_key','environment'}
# One root-owned rule for every survey part (9 November 2026: 150+ small parts, and project agents
# add more). It pins what a per-task rule pins except the per-task bytes: the policy folder, the fixed
# prior-art-survey driver hash and the production attestation key. Each part's own root-owned policy
# must name exactly that task, its native acceptance digest, the prior_art_survey class and that driver.
PART_TASK=re.compile(r'^T-OPP-[0-9]{5}-1-prior-art-survey-r[2-9]-p[1-9][0-9]?$')
PART_RULE={'policy_dir','driver_sha256','attestation_public_key','environment'}
def require(ok):r.require(ok)
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def worker_command(d):return dict(operation='central_review',payload=dict(submission=d['submission'],verdict=d['verdict'],criteria_digest=d['criteria_digest'],verification_digest=r.decision_digest(d),execution_id=d['execution_id'],evidence_digest=d['evidence_digest']))
def validate_profile(p,identity):
 require(type(p)==dict and FIELDS<=set(p)<=FIELDS|OPTIONAL and p['schema']=='uain-central-reviewer-server-v1' and p['chain_id']==r.CHAIN and p['genesis_sha256']==r.GENESIS and p['socket_path']==str(SOCKET))
 require(type(p['peer_uid'])==int and p['peer_uid']>0 and type(p['socket_gid'])==int and p['socket_gid']>0)
 require(identity['schema']=='uain-central-reviewer-identity-v1' and identity['chain_id']==r.CHAIN and identity['genesis_sha256']==r.GENESIS and identity['member']==p['reviewer'] and identity['public_key']==p['public_key'])
 validate_attestation_rules(p.get('acceptance_attestations',{}));validate_fleet_rules(p.get('fleet_attestations',{}))
 if 'fleet_attestation_parts' in p:validate_part_rule(p['fleet_attestation_parts'])
 # One task has exactly one acceptance basis: source reproduction or fleet verification, never both.
 require(not set(p.get('acceptance_attestations',{}))&set(p.get('fleet_attestations',{})))
 public=admission.public_key(p['public_key']);require('uain1'+r.sha(public)[:40]==p['reviewer']);return p

def validate_attestation_rules(rules):
 require(type(rules)==dict and len(rules)<=64)
 for task,rule in rules.items():
  require(type(task)==str and r.ID.fullmatch(task) and r.exact(rule,{'criteria_digest','live_source_path','live_source_sha256','evidence_root','not_before','native_binary_sha256'}))
  require(all(type(rule[k])==str for k in rule) and r.HASH.fullmatch(rule['criteria_digest']) and r.HASH.fullmatch(rule['live_source_sha256']) and r.HASH.fullmatch(rule['native_binary_sha256']) and Path(rule['live_source_path']).is_absolute() and Path(rule['evidence_root']).is_relative_to(r.ROOT/'independent-reproductions') and '..' not in Path(rule['evidence_root']).parts and '..' not in Path(rule['live_source_path']).parts)
  require(str(Path(rule['evidence_root']))==rule['evidence_root'] and Path(rule['evidence_root']).resolve()==Path(rule['evidence_root']) and str(Path(rule['live_source_path']))==rule['live_source_path'] and Path(rule['live_source_path']).resolve()==Path(rule['live_source_path']));r.date(rule['not_before'])
 return rules

def attestation_key(value):
 """Raw 32-byte Ed25519 key from its strict standard base64 form (the envelope's publicKey form)."""
 require(type(value)==str and re.fullmatch(r'[A-Za-z0-9+/]{43}=',value));raw=base64.b64decode(value,validate=True);require(len(raw)==32 and base64.b64encode(raw).decode()==value);return raw

def validate_fleet_rules(rules):
 """Root-owned per-task fleet verification rules: the task policy file and its digest, the
 criteria digest and the one custody attestation key, which must be a production key."""
 require(type(rules)==dict and len(rules)<=64)
 for task,rule in rules.items():
  require(type(task)==str and r.ID.fullmatch(task) and type(rule)==dict and set(rule) in (FLEET_RULE,FLEET_RULE|{'allowedVersions'}) and all(type(rule[k])==str for k in FLEET_RULE))
  fa.validate_versions(rule.get('allowedVersions',[1]))
  require(r.HASH.fullmatch(rule['policy_digest']) and r.HASH.fullmatch(rule['criteria_digest']) and rule['environment']=='production');attestation_key(rule['attestation_public_key'])
  path=Path(rule['policy_path']);require(path.is_absolute() and str(path)==rule['policy_path'] and path.resolve()==path and '..' not in path.parts)
 return rules

def validate_part_rule(rule):
 require(type(rule)==dict and set(rule) in (PART_RULE,PART_RULE|{'allowedVersions'}) and all(type(rule[k])==str for k in PART_RULE))
 # Parts use version-1 statements; version 2 stays per task (its producer selection binds a task).
 require(fa.validate_versions(rule.get('allowedVersions',[1]))==(1,))
 require(r.HASH.fullmatch(rule['driver_sha256']) and rule['environment']=='production');attestation_key(rule['attestation_public_key'])
 path=Path(rule['policy_dir']);require(path.is_absolute() and str(path)==rule['policy_dir'] and path.resolve()==path and '..' not in path.parts)
 return rule

def fleet_rule(profile,task_id):
 """The fleet rule for a task: its own per-task rule, else the survey-part class rule for a part id
 that has no source-reproduction rule. The class rule's policy digest is bound when the policy is read."""
 rules=profile.get('fleet_attestations',{})
 if task_id in rules:return rules[task_id]
 part=profile.get('fleet_attestation_parts')
 if part is None or type(task_id)!=str or not PART_TASK.fullmatch(task_id) or task_id in profile.get('acceptance_attestations',{}):return None
 return dict(policy_path=str(Path(part['policy_dir'])/(task_id+'.json')),policy_digest=None,criteria_digest=None,attestation_public_key=part['attestation_public_key'],environment=part['environment'],allowedVersions=[1],part_driver_sha256=part['driver_sha256'])

class ProtectedArtifacts:
 """Retain every fd until the complete attestation snapshot is rechecked."""
 def __init__(self):self.opened=[]
 def read(self,path,limit):
  from holder_release import trusted
  path=trusted(path);fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
  try:
   info=os.fstat(fd);require(stat.S_ISREG(info.st_mode) and info.st_uid==0 and not info.st_mode&0o022 and info.st_nlink==1 and info.st_size<=limit)
   with os.fdopen(fd,'rb',closefd=False) as stream:raw=stream.read(limit+1)
   require(len(raw)==info.st_size and len(raw)<=limit);self.opened.append((path,fd,info));fd=None;return raw
  finally:
   if fd is not None:os.close(fd)
 def verify(self):
  from holder_release import trusted
  for path,fd,before in self.opened:
   after=os.fstat(fd);current=trusted(path).lstat();fields=lambda x:(x.st_dev,x.st_ino,x.st_size,x.st_mtime_ns,x.st_ctime_ns,x.st_mode,x.st_uid,x.st_nlink)
   require(fields(before)==fields(after)==fields(current) and stat.S_ISREG(current.st_mode) and current.st_nlink==1)
 def close(self):
  for path,fd,info in self.opened:os.close(fd)
  self.opened=[]

def independent_attestation(profile,task,answer,reader=None,include_summary=False):
 if reader is not None:
  result=_independent_attestation(profile,task,answer,reader);return result if include_summary else result['digest'] if result else None
 snapshot=ProtectedArtifacts()
 try:
  result=_independent_attestation(profile,task,answer,snapshot.read);snapshot.verify();return result if include_summary else result['digest'] if result else None
 finally:snapshot.close()

def _independent_attestation(profile,task,answer,reader):
 rule=profile.get('acceptance_attestations',{}).get(task['id'])
 if rule is None:return None
 require(task['acceptance_digest']==rule['criteria_digest']);root=Path(rule['evidence_root'])
 def artifact(value,limit=1024*1024):
  require(r.exact(value,{'path','sha256'}) and r.HASH.fullmatch(value['sha256']));path=Path(value['path']);require(path.is_absolute() and path.is_relative_to(root) and '..' not in path.parts);raw=reader(path,limit);require(r.sha(raw)==value['sha256']);return raw
 require(r.sha(reader(Path(rule['live_source_path']),1024*1024))==rule['live_source_sha256'])
 raw=reader(root/(r.sha(answer['id'].encode())+'.json'),65536);a=native.strict_json(raw)
 require(r.exact(a,{'schema','chain_id','genesis_sha256','task','submission','author','criteria_digest','evidence_digest','live_source_sha256','corrected_source','reproducer','before','after','reviewed_uid','reviewed_by','reviewed_at','review_notes'}))
 require(a['schema']=='uain-independent-reproduction-v1' and a['chain_id']==r.CHAIN and a['genesis_sha256']==r.GENESIS and a['task']==task['id'] and a['submission']==answer['id'] and a['author']==answer['author'] and a['criteria_digest']==task['acceptance_digest'] and a['evidence_digest']==answer['evidence_digest'] and a['live_source_sha256']==rule['live_source_sha256'])
 require(type(a['reviewed_uid'])==int and a['reviewed_uid']==0 and type(a['reviewed_by'])==str and 1<=len(a['reviewed_by'])<=240 and type(a['review_notes'])==str and 1<=len(a['review_notes'])<=4096)
 artifact(a['reproducer']);artifact(a['corrected_source']);require(a['corrected_source']['sha256']!=rule['live_source_sha256']);before=native.strict_json(artifact(a['before']));after=native.strict_json(artifact(a['after']));normalized_commands=[]
 for report,outcome,source_hash in [(before,'failed',rule['live_source_sha256']),(after,'passed',a['corrected_source']['sha256'])]:
  require(r.exact(report,{'schema','task','submission','criteria_digest','evidence_digest','source_sha256','reproducer_sha256','native_binary_sha256','fixture_genesis_sha256','command','command_digest','output','outcome','exit_code','started_at','completed_at'}))
  require(report['schema']=='uain-native-reproduction-run-v1' and report['task']==task['id'] and report['submission']==answer['id'] and report['criteria_digest']==task['acceptance_digest'] and report['evidence_digest']==answer['evidence_digest'] and report['source_sha256']==source_hash and report['reproducer_sha256']==a['reproducer']['sha256'] and report['outcome']==outcome)
  command=report['command'];require(r.exact(command,{'executable_sha256','argv','source_arg_index'}) and type(command['executable_sha256'])==str and r.HASH.fullmatch(command['executable_sha256']) and type(command['argv'])==list and 1<=len(command['argv'])<=64 and all(type(x)==str and 0<len(x)<=4096 for x in command['argv']) and type(command['source_arg_index'])==int and 0<=command['source_arg_index']<len(command['argv']))
  expected_source=rule['live_source_path'] if outcome=='failed' else a['corrected_source']['path'];require(command['argv'][command['source_arg_index']]==expected_source and a['reproducer']['path'] in command['argv'] and report['command_digest']==r.sha(canonical(command)))
  normalized={**command,'argv':list(command['argv'])};normalized['argv'][command['source_arg_index']]='{SOURCE}';normalized_commands.append(normalized)
  require(all(type(report[k])==str and r.HASH.fullmatch(report[k]) for k in ['native_binary_sha256','fixture_genesis_sha256','command_digest']) and type(report['exit_code'])==int and (report['exit_code']!=0 if outcome=='failed' else report['exit_code']==0));artifact(report['output'])
  require(r.date(rule['not_before'])<=r.date(report['started_at'])<=r.date(report['completed_at']))
 require(normalized_commands[0]==normalized_commands[1])
 require(before['native_binary_sha256']==after['native_binary_sha256']==rule['native_binary_sha256'] and before['fixture_genesis_sha256']==after['fixture_genesis_sha256'] and before['fixture_genesis_sha256']!=r.GENESIS and r.date(before['completed_at'])<=r.date(after['started_at'])<=r.date(after['completed_at'])<=r.date(a['reviewed_at'])<=__import__('time').time()+60)
 return dict(schema='uain-trusted-reproduction-v1',digest=r.sha(raw),native_binary_sha256=before['native_binary_sha256'],live_source_sha256=a['live_source_sha256'],corrected_source_sha256=a['corrected_source']['sha256'],reproducer_sha256=a['reproducer']['sha256'],before_outcome='failed',after_outcome='passed',reviewed_at=a['reviewed_at'],review_notes=a['review_notes'])

def fleet_verification(profile,task,answer,reader=None,network=None):
 """The stored fleet verification envelope for this submission, rechecked against the
 root-owned rule, the current root-owned task policy and the native records custody read."""
 if fleet_rule(profile,task['id']) is None:return None
 if reader is not None:return _fleet_verification(profile,task,answer,reader,network)
 snapshot=ProtectedArtifacts()
 try:
  result=_fleet_verification(profile,task,answer,snapshot.read,network);snapshot.verify();return result
 finally:snapshot.close()

def _fleet_verification(profile,task,answer,reader,network):
 rule=dict(fleet_rule(profile,task['id']))
 policy=fa.parse_policy(reader(Path(rule['policy_path']),fa.POLICY_LIMIT))
 if 'part_driver_sha256' in rule:
  require(policy['class']=='prior_art_survey' and policy['taskId']==task['id'] and policy['criteriaDigest']==task['acceptance_digest']
          and policy['projectId']==task['project'] and policy['driver']['sha256']==rule.pop('part_driver_sha256'))
  rule.update(policy_digest=fa.js_digest(policy),criteria_digest=task['acceptance_digest'])
 require(rule['environment']=='production' and task['acceptance_digest']==rule['criteria_digest'])
 # Source-code reproduction keeps its own protected acceptance_attestations path.
 require(fa.js_digest(policy)==rule['policy_digest'] and policy['class']!='source_code_reproduction')
 raw=reader(FLEET_ROOT/(r.sha(answer['id'].encode())+'.json'),65536);envelope=fa.strict_json(raw)
 statement=fa.check_review_bindings(envelope,attestation_key(rule['attestation_public_key']),'production',policy,task,answer,allowed_versions=rule.get('allowedVersions',[1]),network=network)
 return dict(statement=statement,statementDigest=envelope['statementDigest'],envelopeSha256=r.sha(raw),rule=rule)

# Signed reasons companion of a fail (10 November 2026; ops/custody/survey_attester.py reasons_envelope,
# golden values fixtures/contracts/survey-checker-reasons.json). Optional: any fault means no reasons, never a
# refusal, and the reasons never change a verdict. The worker turns the codes into plain words for the member.
REASONS_SCHEMA='uain-fleet-verification-reasons-v1';REASONS_DOMAIN='UAIN/fleet-verification-reasons/v1'
REASON_CODE=re.compile(r'[a-z][a-z0-9_]{0,63}(?::[A-Za-z0-9._/()-]{1,160}){0,3}')
def check_reasons(envelope,public_key,statement_digest,submission):
 require(type(envelope)==dict and set(envelope)=={'body','publicKey','signature'});body=envelope['body']
 require(type(body)==dict and set(body)=={'schema','domain','statementDigest','submission','verdict','reasons'} and body['schema']==REASONS_SCHEMA and body['domain']==REASONS_DOMAIN and body['verdict']=='fail')
 require(body['statementDigest']==statement_digest and body['submission']==submission and type(body['reasons'])==list and len(body['reasons'])<=16)
 require(all(type(c)==str and len(c.encode())<=256 and REASON_CODE.fullmatch(c) for c in body['reasons']) and len(set(body['reasons']))==len(body['reasons']))
 require(envelope['publicKey']==base64.b64encode(public_key).decode())
 fa.ed25519_verify(public_key,fa.strict_base64(envelope['signature'],64,'attestation_signature_invalid'),(REASONS_DOMAIN+'\n'+fa.js_canonical(body)).encode('utf-8'))
 return dict(schema=REASONS_SCHEMA,statementDigest=statement_digest,reasons=list(body['reasons']))
def fleet_reasons(verified,answer,reader=None):
 try:
  if verified['statement']['verdict']!='fail':return None
  path=FLEET_ROOT/(r.sha(answer['id'].encode())+'.reasons.json')
  if reader is None:
   if not path.exists():return None
   snapshot=ProtectedArtifacts()
   try:raw=snapshot.read(path,16384);snapshot.verify()
   finally:snapshot.close()
  else:raw=reader(path,16384)
  return check_reasons(fa.strict_json(raw),attestation_key(verified['rule']['attestation_public_key']),verified['statementDigest'],answer['id'])
 except Exception:return None

class Engine:
 def __init__(self,profile,runtime,custody,root=None,read=None,write=None,sign=None,locker=None,attestation_read=None):
  self.p=profile;self.runtime=runtime;self.custody=custody;self.root=Path(root or r.ROOT/'reviews');self.read=read or (lambda p:admission.load(p) if p.exists() else None);self.write=write or (lambda p,v:protected_write(p,canonical(v)));self.sign=sign or r.sign_review;self.locker=locker or r.locked;self.attestation_read=attestation_read
 def path(self,execution):require(type(execution)==str and r.ID.fullmatch(execution));return self.root/(r.sha(execution.encode())+'.json')
 def snapshot(self,d):
  keys=['central_submission/'+d['submission'],'central_task/'+d['task']];first=self.runtime.read({'member':self.p['reviewer'],'keys':keys});t=first['records'][keys[1]];require(type(t)==dict and r.ID.fullmatch(t['project']))
  final=self.runtime.read({'member':self.p['reviewer'],'keys':keys+['central_earning_activation','central_project_budget/'+t['project'],'project/'+t['project']]});project=final['records']['project/'+t['project']];require(project['id']==t['project'] and project['state']=='active' and project.get('safety_halted') is False);return final
 def retained(self,job,execution):
  require(job['schema']=='uain-central-review-once-v1' and job['executionId']==execution and job['reviewer']==self.p['reviewer'] and job['decisionDigest']==r.decision_digest(job['decision']) and job['commandDigest']==r.sha(canonical(worker_command(job['decision']))))
  if job.get('envelope'):
   c=job['envelope']['command'];require(c['operation']=='central_review' and c['chain_id']==r.CHAIN and c['member']==self.p['reviewer'] and job['envelope']['public_key']==self.p['public_key'] and c['payload']==worker_command(job['decision'])['payload'] and job['nativeCommandDigest']==r.sha(native.signing_bytes(c)))
 def result(self,job):
  if not job.get('receipt'):return {'status':'unknown'}
  receipt=job['receipt'];require(receipt['authority']=='native' and receipt['finalized'] is True and receipt['chain_id']==r.CHAIN and r.matches_receipt(receipt['event'],job['envelope']['command']))
  return {**{k:job[k] for k in ('executionId','commandDigest','decisionDigest','nativeCommandDigest')},'status':'finalized','verified':True,'receipt':job['receipt'],'awards':job['awards'],'paid':bool(job['awards'])}
 def readiness(self,body):
  require(r.exact(body,{'submission'}) and type(body['submission'])==str and r.ID.fullmatch(body['submission']))
  first=self.runtime.read({'keys':['central_submission/'+body['submission']]});answer=first['records']['central_submission/'+body['submission']];require(type(answer)==dict and r.ID.fullmatch(answer['task']))
  state=self.snapshot({'submission':answer['id'],'task':answer['task']});answer=state['records']['central_submission/'+body['submission']];task=state['records']['central_task/'+answer['task']]
  require(answer['state']=='under_review' and task['state']=='under_review' and task['pending']==answer['id'] and answer['author']!=self.p['reviewer'])
  fleet=fleet_rule(self.p,task['id']) is not None
  result=dict(submission=answer['id'],criteriaDigest=task['acceptance_digest'],evidenceDigest=answer['evidence_digest'],required=task['id'] in self.p.get('acceptance_attestations',{}) or fleet)
  if fleet:
   try:verified=fleet_verification(self.p,task,answer,self.attestation_read,network=dict(chainId=state['chain_id'],genesisSha256=self.p.get('genesis_sha256')))
   except Exception:return {**result,'ready':False,'reason':'fleet_verification_required'}
   reasons=fleet_reasons(verified,answer,self.attestation_read)
   return {**result,'ready':True,'attestationDigest':verified['statementDigest'],'trusted_verification':verified['statement'],**({'verification_reasons':reasons} if reasons else {})}
  try:attestation=independent_attestation(self.p,task,answer,self.attestation_read,include_summary=True)
  except Exception:return {**result,'ready':False,'reason':'independent_reproduction_required'}
  return {**result,'ready':True,'attestationDigest':attestation['digest'] if attestation else None,**({'trusted_reproduction':attestation} if attestation else {})}
 def review(self,body):
  require(r.exact(body,{'executionId','decision'}) and body['executionId']==body['decision'].get('execution_id'));execution=body['executionId'];path=self.path(execution);d=body['decision'];r.decision_bytes(d);require(d['reviewer']==self.p['reviewer']);require(all(type(d[k])==str and r.ID.fullmatch(d[k]) for k in ('submission','task','execution_id')))
  with self.locker():
   job=self.read(path)
   if job is not None:self.retained(job,execution);require(job['decisionDigest']==r.decision_digest(d));return self.reconcile(job,path)
   state=self.snapshot(d);command=r.review_command(self.p,state,d);task=state['records']['central_task/'+d['task']];answer=state['records']['central_submission/'+d['submission']]
   attestation_digest=None;verified=None
   blocked=lambda reason:dict(status='blocked',stage='pre_sign',reason=reason,executionId=execution,decisionDigest=r.decision_digest(d),commandDigest=r.sha(canonical(worker_command(d))))
   fleet=fleet_rule(self.p,task['id']) is not None;v2=d['schema']=='uain-central-research-decision-v2'
   require(fleet or not v2) # A v2 decision names a fleet statement, so only a fleet task can carry one.
   if fleet and (v2 or d['verdict']!='needs_evidence'):
    if not v2:return blocked('fleet_verification_required')
    try:verified=fleet_verification(self.p,task,answer,self.attestation_read,network=dict(chainId=state['chain_id'],genesisSha256=self.p.get('genesis_sha256')))
    except Exception:return blocked('fleet_verification_required')
    # The decision commits to exactly this statement. A driver pass is necessary
    # for accept, not sufficient: the reviewer may reject or ask for evidence on a
    # pass, and can never accept a fail.
    require(d['verification_attestation_digest']==verified['statementDigest'])
    require(d['verdict']!='accept' or verified['statement']['verdict']=='pass')
   elif d['verdict']=='accept':
    try:attestation_digest=independent_attestation(self.p,task,answer,self.attestation_read)
    except Exception:return blocked('independent_reproduction_required')
   job=dict(schema='uain-central-review-once-v1',executionId=execution,reviewer=self.p['reviewer'],decision=d,decisionDigest=r.decision_digest(d),commandDigest=r.sha(canonical(worker_command(d))),phase='sign_started',after_event=state['event_count'],cursor=state['event_count'],context=dict(task=task['id'],project=task['project'],submission=answer['id'],author=answer['author'],solver_amount=task['solver_amount'],reviewer_amount=task['reviewer_amount']))
   if attestation_digest is not None:
    rule=self.p['acceptance_attestations'][task['id']];job['context']['independent_reproduction']=dict(attestation_sha256=attestation_digest,criteria_digest=rule['criteria_digest'],live_source_sha256=rule['live_source_sha256'],evidence_root=rule['evidence_root'],verified_at=int(__import__('time').time()))
   if verified is not None:
    rule=verified['rule'];statement=verified['statement']
    job['context']['fleet_verification']=dict(statement_digest=verified['statementDigest'],envelope_sha256=verified['envelopeSha256'],policy_path=rule['policy_path'],policy_digest=rule['policy_digest'],criteria_digest=rule['criteria_digest'],attestation_public_key=rule['attestation_public_key'],environment=statement['environment'],evidence_class=statement['evidenceClass'],driver=dict(statement['driver']),verdict=statement['verdict'],task_verification_digest=statement['verificationDigest'],attested_at=statement['attestedAt'],verified_at=int(time.time()))
    if statement['schema']==fa.SCHEMA_V2:job['context']['fleet_verification'].update(attestation_version=2,native_evidence_digest=statement['evidenceDigest'],canonical_artifact_digest=statement['canonicalArtifactDigest'],chain_id=statement['chainId'],genesis_sha256=statement['genesisSha256'])
   self.write(path,job) # A crash after this marker never signs again.
   envelope=self.sign(self.custody,self.p,state,d);require(envelope['command']==command and envelope['public_key']==self.p['public_key']);job.update(envelope=envelope,nativeCommandDigest=r.sha(native.signing_bytes(command)),phase='send_started');self.write(path,job) # Durable BEFORE only broadcast.
   try:job['check_tx_code']=self.runtime.broadcast(envelope)
   except Exception:job['send_outcome']='unknown'
   self.write(path,job);return self.reconcile(job,path)
 def receipt(self,body):
  require(r.exact(body,{'executionId','commandDigest','decisionDigest'}) and r.HASH.fullmatch(body['commandDigest']) and r.HASH.fullmatch(body['decisionDigest']));path=self.path(body['executionId'])
  with self.locker():
   job=self.read(path)
   if job is None:return {'status':'unknown'}
   self.retained(job,body['executionId']);require(all(job[k]==body[k] for k in body));return self.reconcile(job,path)
 def reconcile(self,job,path):
  if job.get('receipt'):return self.result(job)
  if not job.get('envelope'):return {'status':'unknown'}
  head=self.runtime.read({'keys':[]});cursor=native.decimal(job['cursor']);count=native.decimal(head['event_count']);require(cursor<=count);end=min(cursor+16,count)
  if end==cursor:return {'status':'unknown'}
  keys=['event/'+str(i).zfill(20) for i in range(cursor+1,end+1)];proved=self.runtime.read({'keys':keys});command=job['envelope']['command']
  for n,key in zip(range(cursor+1,end+1),keys):
   event=proved['records'][key];require(type(event)==dict and event['id']==str(n))
   if not r.matches_receipt(event,command):continue
   c=job['context'];award_keys=['central_award/solver/'+c['submission'],'central_award/reviewer/'+c['submission']];review_key='central_review/'+c['submission']+'/'+r.sha(job['executionId'].encode())
   final=self.runtime.read({'member':self.p['reviewer'],'keys':award_keys+[review_key],'receipt':{'envelope':job['envelope'],'event_id':event['id']}});receipt=final['receipt'];require(receipt['authority']=='native' and receipt['finalized'] is True and receipt['chain_id']==r.CHAIN and receipt['event']==event and r.matches_receipt(receipt['event'],command))
   record=final['records'][review_key];require(type(record)==dict and all(record.get(k)==v for k,v in command['payload'].items()) and record['reviewer']==self.p['reviewer'] and record['height']==event['height'])
   awards=[]
   for role,member,amount in [('solver',c['author'],c['solver_amount']),('reviewer',self.p['reviewer'],c['reviewer_amount'])]:
    award=final['records']['central_award/'+role+'/'+c['submission']];expected_paid=job['decision']['verdict']=='accept' or role=='reviewer' and job['decision']['verdict']=='reject'
    if not expected_paid:
     if job['decision']['verdict']=='needs_evidence':
      require(award is None or type(award)==dict and native.decimal(award['height'])>native.decimal(event['height']))
     else:require(award is None)
     continue
    require(type(award)==dict and award==dict(submission=c['submission'],task=c['task'],project=c['project'],member=member,role=role,amount=amount,height=event['height']));awards.append(award)
   job.update(receipt=receipt,awards=awards,phase='finalized',cursor=str(n));self.write(path,job);return self.result(job)
  job['cursor']=str(end);self.write(path,job);return {'status':'unknown'}
FEEDBACK_SCHEMA='uain-central-review-feedback-v1'
FEEDBACK_LIMIT=73728
FEEDBACK_JOBS=Path('/var/lib/uain-central-reviewer/jobs.json')
FEEDBACK_REVIEW={'submission','execution_id','criteria_digest','evidence_digest','verification_digest','reviewer','height','verdict'}
def feedback_request(body):
 require(r.exact(body,{'submission','executionId'}) and type(body['submission'])==str and r.ID.fullmatch(body['submission']) and (body['executionId'] is None or type(body['executionId'])==str and r.ID.fullmatch(body['executionId'])) and len(canonical(body))<=512)
 return dict(body)
def feedback_locator(profile,submission):
 """Fixed private job file is ONLY a locator, never feedback/proof authority."""
 require(type(submission)==str and r.ID.fullmatch(submission));owner=profile['peer_uid'];require(type(owner)==int and owner>0)
 path=FEEDBACK_JOBS
 for parent in path.parents:
  info=parent.lstat();require(stat.S_ISDIR(info.st_mode) and info.st_uid in (0,owner) and not info.st_mode&0o022)
 initial=path.lstat();fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 def fields(v):return(v.st_dev,v.st_ino,v.st_size,v.st_mtime_ns,v.st_ctime_ns,v.st_uid,v.st_gid,v.st_mode,v.st_nlink)
 try:
  info=os.fstat(fd);require(fields(initial)==fields(info) and stat.S_ISREG(info.st_mode) and info.st_uid==owner and info.st_nlink==1 and stat.S_IMODE(info.st_mode)==0o600 and 0<info.st_size<=64*1024*1024)
  with os.fdopen(fd,'rb',closefd=False) as stream:raw=stream.read(64*1024*1024+1)
  require(len(raw)==info.st_size and fields(info)==fields(os.fstat(fd))==fields(path.lstat()))
 finally:os.close(fd)
 def unique(pairs):
  out={}
  for key,value in pairs:require(key not in out);out[key]=value
  return out
 def reject(_):raise ValueError('Non-integer locator JSON')
 value=json.loads(raw.decode('utf-8'),object_pairs_hook=unique,parse_float=reject,parse_constant=reject)
 pending=[(iter((value,)),0)]
 while pending:
  iterator,depth=pending[-1]
  try:item=next(iterator)
  except StopIteration:pending.pop();continue
  require(depth<=64)
  if type(item)==dict:pending.append((iter(item.values()),depth+1))
  elif type(item)==list:pending.append((iter(item),depth+1))
 require(type(value)==dict and type(value.get('version'))==int and value.get('version')==1 and type(value.get('jobs'))==dict and len(value['jobs'])<=10000)
 job=value['jobs'].get(submission);require(type(job)==dict and job.get('submission')==submission and type(job.get('execution_id'))==str and r.ID.fullmatch(job['execution_id']))
 return job['execution_id']

def feedback_projection(profile,body,runtime,reader,now=time.time,locator=None):
 """Project only a finalized public decision bound to a fresh proved native review.
 No signer/vault/Engine is constructed; no job-store path is accepted or read.
 """
 body=feedback_request(body);require(profile['chain_id']==r.CHAIN and profile['genesis_sha256']==r.GENESIS)
 sid,execution=body['submission'],body['executionId']
 if execution is None:execution=(locator or feedback_locator)(profile,sid)
 require(type(execution)==str and r.ID.fullmatch(execution));path=r.ROOT/'reviews'/(r.sha(execution.encode())+'.json')
 job=native.strict_json(reader(path,2*1024*1024));require(type(job)==dict and job.get('schema')=='uain-central-review-once-v1' and job.get('phase')=='finalized' and job.get('executionId')==execution and job.get('reviewer')==profile['reviewer'])
 d=job.get('decision');require(type(d)==dict and r.DECISION_SCHEMAS.get(d.get('schema'))==set(d) and d.get('domain')=='UAIN/central-research-review/v1')
 raw=r.decision_bytes(d);require(len(raw)<=65536 and all(type(d[k])==str and r.ID.fullmatch(d[k]) for k in ('submission','task','execution_id')) and d['submission']==sid and d['execution_id']==execution and d['reviewer']==profile['reviewer'])
 require(all(type(d[k])==str and r.HASH.fullmatch(d[k]) for k in ('criteria_digest','evidence_digest')) and d['verdict'] in ('accept','reject','needs_evidence') and type(d['findings'])==list and 1<=len(d['findings'])<=64 and all(type(v)==str and 0<len(v.encode())<=8192 for v in d['findings']))
 require(r.date(d['started_at'])<=r.date(d['completed_at'])<=now()+60 and r.date(d['completed_at'])-r.date(d['started_at'])<=600)
 require(job.get('decisionDigest')==r.decision_digest(d) and job.get('commandDigest')==r.sha(canonical(worker_command(d))))
 envelope=job.get('envelope');require(type(envelope)==dict and type(envelope.get('command'))==dict);command=envelope['command']
 require(command.get('operation')=='central_review' and command.get('chain_id')==r.CHAIN and command.get('member')==profile['reviewer'] and command.get('payload')==worker_command(d)['payload'] and envelope.get('public_key')==profile['public_key'] and job.get('nativeCommandDigest')==r.sha(native.signing_bytes(command)))
 receipt=job.get('receipt');require(type(receipt)==dict and receipt.get('authority')=='native' and receipt.get('finalized') is True and receipt.get('chain_id')==r.CHAIN and r.matches_receipt(receipt.get('event'),command))
 key='central_review/'+sid+'/'+r.sha(execution.encode());keys=['central_submission/'+sid,'central_task/'+d['task'],key]
 state=runtime.read({'member':profile['reviewer'],'keys':keys});require(state['chain_id']==r.CHAIN and -60<=now()-r.date(state['header_time'])<=120 and native.decimal(state['height'])>0 and type(state['app_hash'])==str and r.HASH.fullmatch(state['app_hash']))
 records=state['records'];answer,task,review=(records[k] for k in keys)
 require(type(answer)==dict and answer.get('id')==sid and answer.get('task')==d['task'] and type(answer.get('author'))==str and r.ADDRESS.fullmatch(answer['author']) and answer['author']!=d['reviewer'] and answer.get('evidence_digest')==d['evidence_digest'])
 require(type(task)==dict and task.get('id')==d['task'] and type(task.get('project'))==str and r.ID.fullmatch(task['project']) and task.get('acceptance_digest')==d['criteria_digest'])
 require(r.exact(review,FEEDBACK_REVIEW) and all(review[k]==d[k] for k in ('submission','execution_id','criteria_digest','evidence_digest','reviewer','verdict')) and review['verification_digest']==job['decisionDigest'] and 0<native.decimal(review['height'])<=native.decimal(state['height']) and str(receipt['event']['height'])==review['height'])
 result=dict(schema=FEEDBACK_SCHEMA,submission=sid,executionId=execution,author=answer['author'],task=d['task'],project=task['project'],chainId=r.CHAIN,genesisSha256=r.GENESIS,nativeReview=review,decision=d,native=dict(height=state['height'],appHash=state['app_hash'],headerTime=state['header_time'],verifierSha256=r.READER_SHA))
 require(len(canonical(result))<=FEEDBACK_LIMIT);return result

def read_feedback(profile,body):
 feedback_request(body)
 snapshot=ProtectedArtifacts()
 try:
  runtime=runtime_for_request();runtime.deadline=min(runtime.deadline,time.monotonic()+5.5)
  result=feedback_projection(profile,body,runtime,snapshot.read);snapshot.verify();return result
 finally:snapshot.close()

def loaded_attestation_admission(profile,body,source_pins):
 """Read-only admission from this process's loaded profile/bootstrap, never disk claims."""
 require(r.exact(body,{'task'}) and type(body['task'])==str and r.ID.fullmatch(body['task']))
 rules=validate_fleet_rules(profile.get('fleet_attestations',{}));require(body['task'] in rules)
 require(type(source_pins)==dict and set(source_pins)=={'schema','sha256'} and source_pins['schema']=='uain-central-reviewer-sources-v1')
 require(type(source_pins['sha256'])==dict and set(source_pins['sha256'])=={n+'.py' for n in SOURCE_NAMES}
         and all(type(v)==str and r.HASH.fullmatch(v) for v in source_pins['sha256'].values()))
 rule=rules[body['task']]
 network=fa.validate_network(dict(chainId=profile.get('chain_id'),genesisSha256=profile.get('genesis_sha256')))
 return dict(schema='uain-fleet-attestation-admission-v1',taskId=body['task'],policyDigest=rule['policy_digest'],criteriaDigest=rule['criteria_digest'],
             allowedVersions=list(fa.validate_versions(rule.get('allowedVersions',[1]))),supportedVersions=[1,2],profileDigest=fa.js_digest(profile),sourcePinsDigest=fa.js_digest(source_pins),**network)

def peer_credentials(connection):
 return struct.unpack('3i',connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1]
REFUSED=canonical({'error':'central_review_refused_or_uncertain'})
class Handler(BaseHTTPRequestHandler):
 # CU-5: setup() applies this before the request line is read, so one idle peer
 # cannot hold the single-threaded server; the connection is dropped instead.
 timeout=10
 def log_message(self,*args):pass
 def handle(self):
  # A peer that is neither root nor the reviewer worker is refused before anything is read.
  try:uid=peer_credentials(self.connection)
  except Exception:uid=None
  if uid is None or uid not in (0,self.server.peer_uid):
   try:
    self.wfile.write(b'HTTP/1.0 409 Conflict\r\nContent-Type: application/json\r\nContent-Length: '+str(len(REFUSED)).encode()+b'\r\n\r\n'+REFUSED)
    self.wfile.flush();self.connection.shutdown(socket.SHUT_WR)
    # Discard what the peer already sent (bounded: 1 s, 80 KiB) so closing does not reset
    # its read of the answer; nothing of it is parsed.
    self.connection.settimeout(1);left=80*1024
    while left>0:
     part=self.connection.recv(min(left,16384))
     if not part:break
     left-=len(part)
   except OSError:pass
   return
  super().handle()
 def do_POST(self):
  try:
   self.connection.settimeout(10);uid=peer_credentials(self.connection)
   metadata=self.path=='/attestation-admission';feedback=self.path=='/feedback'
   require(uid==0 if metadata or feedback else uid==self.server.peer_uid)
   require(self.path in ('/review','/receipt','/readiness','/attestation-admission','/feedback') and self.headers.get('Transfer-Encoding') is None and self.headers.get('Content-Type')=='application/json');length=self.headers.get('Content-Length');require(length is not None and length.isdecimal() and 0<int(length)<=65536);raw=self.rfile.read(int(length));require(len(raw)==int(length));body=native.strict_json(raw)
   if metadata:answer=self.server.loaded_admission(body)
   elif feedback:answer=self.server.loaded_feedback(body)
   else:
    engine=self.server.engine_factory();answer=engine.review(body) if self.path=='/review' else engine.receipt(body) if self.path=='/receipt' else engine.readiness(body)
   status=200
  except Exception:answer={'error':'central_review_refused_or_uncertain'};status=409
  raw=canonical(answer);self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
class Server(socketserver.UnixStreamServer):allow_reuse_address=False

def serve():
 require(os.geteuid()==0);p=validate_profile(admission.load(PROFILE),admission.load(IDENTITY));admission.ensure_directory(r.ROOT/'reviews');admission.TEMP=NATIVE_TEMP;admission.ensure_directory(NATIVE_TEMP)
 parent=SOCKET.parent;parent.mkdir(mode=0o750,parents=True,exist_ok=True);info=parent.lstat();require(info.st_uid==0 and stat.S_ISDIR(info.st_mode) and not info.st_mode&0o027);os.chown(parent,0,p['socket_gid']);os.chmod(parent,0o750)
 require(not SOCKET.exists()) # Stale socket removal requires explicit operator audit.
 def factory():
  import custody
  return Engine(p,runtime_for_request(),custody)
 with Server(str(SOCKET),Handler) as server:
  os.chown(SOCKET,0,p['socket_gid']);os.chmod(SOCKET,0o660);server.peer_uid=p['peer_uid'];server.engine_factory=factory;server.loaded_admission=lambda body:loaded_attestation_admission(p,body,LOADED_SOURCE_PINS);server.loaded_feedback=lambda body:read_feedback(p,body);server.serve_forever()
if __name__=='__main__':serve()

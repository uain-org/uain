"""Restricted SSH entrypoint. It never accepts AI attestations or broadcasts."""
import hashlib, json, os, re, shlex, signal, subprocess, sys, time, contextlib, stat, socket, struct, http.client, datetime
from pathlib import Path

SERVICE = Path('/opt/uain-custody/private_payment_service.py')
SERVICE_SHA = '33c4108c9a7fa82b49a7f89a8e8a5d2d38ba9c9b11e7f94367e1d5ec94ebaef1'
PYTHON = '/opt/uain-custody/venv/bin/python'
LIMIT = 128 * 1024
ACTIONS = {'health', 'create', 'certificate', 'ingest', 'send-ingest', 'inspect', 'finalize', 'finalize-rules', 'relay', 'reconcile', 'retained-relay', 'public-state', 'public-state-batch', 'central-feedback'}
BODY_ACTIONS = {'create', 'ingest', 'send-ingest', 'relay', 'retained-relay', 'public-state', 'public-state-batch', 'central-feedback'}
RETAINED_ROOT = Path('/var/lib/uain-custody/private-payment-service')

def parse_command(command):
    fields = shlex.split(command)
    if len(fields) != 3 or fields[0] != 'baink-private-review' or fields[1] not in ACTIONS or not re.fullmatch('[a-f0-9]{32}', fields[2]):
        raise ValueError('Restricted review command refused')
    if fields[1] in {'health','public-state','public-state-batch'} and fields[2] != '0' * 32:
        raise ValueError('Restricted health identity refused')
    return fields[1], fields[2]

def validate_input(action, raw):
    if len(raw) > LIMIT or (action in BODY_ACTIONS) != bool(raw):
        raise ValueError('Restricted review input refused')
    if raw:
        def pairs(items):
            out = {}
            for key, value in items:
                if key in out: raise ValueError('Duplicate input key')
                out[key] = value
            return out
        value = json.loads(raw, object_pairs_hook=pairs)
        if not isinstance(value, dict): raise ValueError('Object required')

def retained_relay(job, raw):
    # No custody import, password, service invocation, signing or broadcasting.
    import native_migration as native
    value = native.strict_json(raw)
    if type(value) != dict or set(value) != {'requestDigest'} or not isinstance(value['requestDigest'], str) or not re.fullmatch('[a-f0-9]{64}', value['requestDigest']):
        raise ValueError('Retained relay binding refused')
    directory = RETAINED_ROOT / job
    for path in [directory, *directory.parents]:
        if not path.exists():
            if path == directory: continue
            raise ValueError('Retained relay root missing')
        info = path.lstat()
        if path.is_symlink() or not path.is_dir() or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Retained relay root refused')
    path = directory / 'relay.json'
    if not path.exists() and not path.is_symlink():
        return json.dumps({'status':'unknown', 'requestDigest':value['requestDigest']}, separators=(',',':')).encode()
    retained = native.strict_json(native.protected_read(path, 2 * 1024 * 1024))
    if type(retained) != dict or set(retained) != {'requestDigest','envelope'} or retained['requestDigest'] != value['requestDigest'] or type(retained['envelope']) != dict:
        raise ValueError('Retained relay result refused')
    result = {'status':'retained', 'requestDigest':value['requestDigest'], 'envelope':retained['envelope']}
    encoded = json.dumps(result, separators=(',',':')).encode()
    if len(encoded) > 2 * 1024 * 1024: raise ValueError('Retained relay size refused')
    return encoded

STATE_BINARY=Path('/opt/uain-chain/tools/state/136698192e9e38323a552f1e2da2eea5b9b90e3d6e7de11116d72ee28c826860/uain-state')
STATE_SHA='136698192e9e38323a552f1e2da2eea5b9b90e3d6e7de11116d72ee28c826860'
STATE_GENESIS=Path('/opt/uain-custody/public-state/genesis.json')
STATE_GENESIS_SHA='54140a9243c4591ccc9f2e9d49543fc68b87b3e0045416174c232e9dd498f8ff'
STATE_CHAIN='uain-shadow-20261008-1'
STATE_TEMP=Path('/run/uain-public-state')

def public_selection(raw):
    import native_migration as native
    if not 0 < len(raw) <= 65536: raise ValueError('Public selection bound refused')
    value=native.strict_json(raw)
    if type(value)!=dict or not set(value)<= {'member','keys','receipt'}: raise ValueError('Public selection fields refused')
    if 'member' in value and (type(value['member'])!=str or not re.fullmatch('uain1[a-f0-9]{40}',value['member'])): raise ValueError('Public member refused')
    if 'keys' in value and (type(value['keys'])!=list or len(value['keys'])>32 or any(type(k)!=str or not re.fullmatch('[A-Za-z0-9_./:-]{1,512}',k) for k in value['keys'])): raise ValueError('Public keys refused')
    if 'receipt' in value:
        r=value['receipt']
        if type(r)!=dict or set(r)!={'envelope','event_id'} or type(r['event_id'])!=str or not re.fullmatch('[1-9][0-9]{0,19}',r['event_id']) or int(r['event_id'])>18446744073709551615: raise ValueError('Receipt cursor refused')
        e=r['envelope']
        if type(e)!=dict or set(e)!={'command','public_key','signature'} or type(e['command'])!=dict: raise ValueError('Receipt envelope refused')
        c=e['command']
        if not {'version','chain_id','member','sequence','expires_height','operation','payload'}<=set(c)<= {'version','chain_id','member','sequence','expires_height','operation','payload','instance'} or type(c['version'])!=int or c['version']!=1 or c['chain_id']!=STATE_CHAIN or type(c['member'])!=str or not re.fullmatch('uain1[a-f0-9]{40}',c['member']): raise ValueError('Receipt chain refused')
        if any(type(c[k])!=str or not re.fullmatch('(0|[1-9][0-9]{0,19})',c[k]) for k in ['sequence','expires_height']) or type(c['operation'])!=str or not re.fullmatch('[a-z_]{1,64}',c['operation']) or type(c['payload'])!=dict: raise ValueError('Receipt command refused')
        if type(e['public_key'])!=str or not re.fullmatch('[A-Za-z0-9_-]{43}',e['public_key']) or type(e['signature'])!=str or not re.fullmatch('[A-Za-z0-9_-]{86}',e['signature']): raise ValueError('Receipt public signature refused')
    return value

def pinned_state_artifact(path,pin,limit):
    import stat
    if path.resolve()!=path: raise ValueError('Public artifact path refused')
    for parent in path.parents:
        s=parent.lstat()
        if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022: raise ValueError('Public artifact ancestor refused')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as file:
        s=os.fstat(file.fileno())
        if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_nlink!=1 or s.st_mode&0o022 or not 0<s.st_size<=limit: raise ValueError('Public artifact file refused')
        h=hashlib.sha256()
        for chunk in iter(lambda:file.read(1024*1024),b''):h.update(chunk)
        if h.hexdigest()!=pin: raise ValueError('Public artifact pin refused')

def public_environment():
    import stat
    import native_migration as native
    pinned_state_artifact(STATE_BINARY,STATE_SHA,256*1024*1024);pinned_state_artifact(STATE_GENESIS,STATE_GENESIS_SHA,8*1024*1024)
    if native.strict_json(STATE_GENESIS.read_bytes()).get('chain_id')!=STATE_CHAIN: raise ValueError('Public chain refused')
    STATE_TEMP.mkdir(mode=0o700,exist_ok=True)
    st=STATE_TEMP.lstat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid!=0 or st.st_mode&0o077: raise ValueError('Public temp refused')

@contextlib.contextmanager
def public_slot():
    import fcntl,stat
    slot=None
    for n in range(2):
        fd=os.open(STATE_TEMP/('slot-'+str(n)+'.lock'),os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)
        st=os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_nlink!=1 or st.st_mode&0o077: os.close(fd);raise ValueError('Public slot refused')
        try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);slot=fd;break
        except BlockingIOError:os.close(fd)
    if slot is None:raise ValueError('Public proof capacity unavailable')
    try:yield
    finally:os.close(slot)

def run_public_selection(value,directory,deadline):
    import native_migration as native
    remaining=deadline-time.monotonic()
    if remaining<=0:raise TimeoutError('Public proof deadline')
    output=Path(directory)/'state.json';output.unlink(missing_ok=True);child=None
    try:
        child=subprocess.Popen([str(STATE_BINARY),'--genesis',str(STATE_GENESIS),'--genesis-sha256',STATE_GENESIS_SHA,'--rpc','http://127.0.0.1:26667','--out',str(output),'--max-age','120s'],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True,env={'PATH':'/usr/bin:/bin','HOME':'/nonexistent','GOMAXPROCS':'2'})
        child.communicate(native.canonical(value).encode(),timeout=remaining)
        if child.returncode: raise ValueError('Public verifier refused')
        data=native.protected_read(output,2*1024*1024);native.strict_json(data)
        return data
    finally:
        if child is not None and child.poll() is None:
            os.killpg(child.pid,signal.SIGKILL);child.wait()

def public_state(raw):
    import tempfile
    value=public_selection(raw);deadline=time.monotonic()+7;public_environment()
    with public_slot(),tempfile.TemporaryDirectory(prefix='proof-',dir=STATE_TEMP) as directory:
        return run_public_selection(value,directory,deadline)

BATCH_SCHEMA='baink-native-public-state-batch-v1'
def project_public_absence(state,member):
    # 136 build a929441: Keeper.Member requires the physical member key;
    # metadata/legacy records alone cannot create semantic membership. Only a
    # Go-authenticated EMPTY raw query permits this negative-only projection.
    import base64,binascii
    if type(state)!=dict or state.get('member') is not None or type(state.get('records'))!=dict or type(state.get('queries'))!=list:return None
    records=state['records'];own=['coin_activation','coin_supply','private_activation','member/'+member,'coin_balance/'+member,'legacy_import']
    if any(k not in records for k in own) or records['member/'+member] is not None:return None
    required=set(own)|{'guardians','event_count'};queries={}
    try:
        for query in state['queries']:
            if type(query)!=dict or type(query.get('key'))!=str:return None
            raw=base64.b64decode(query['key'],validate=True)
            if base64.b64encode(raw).decode()!=query['key']:return None
            key=raw.decode('utf-8')
            if key in queries:return None
            queries[key]=query
    except (ValueError,UnicodeError,binascii.Error):return None
    if not required<=set(queries):return None
    value=queries['member/'+member].get('value')
    if value is not None and (type(value)!=str or value!=''):return None
    projected={k:state[k] for k in ['chain_id','epoch','height','header_time','app_hash','signed_header','event_count'] if k in state}
    projected['records']={k:records[k] for k in own}
    projected['queries']=[q for k,q in queries.items() if k in required]
    return projected

def public_state_batch(raw):
    import tempfile
    import native_migration as native
    deadline=time.monotonic()+7
    if not 0<len(raw)<=65536:raise ValueError('Public batch bound refused')
    value=native.strict_json(raw)
    if type(value)!=dict or set(value)!={'members'} or type(value['members'])!=list or not 1<=len(value['members'])<=30 or any(type(m)!=str or not re.fullmatch('uain1[a-f0-9]{40}',m) for m in value['members']) or len(set(value['members']))!=len(value['members']):raise ValueError('Public batch members refused')
    public_environment();results=[];total=0;prefetched={}
    with public_slot(),tempfile.TemporaryDirectory(prefix='batch-',dir=STATE_TEMP) as directory:
        # At most31 explicit keys: three globals and two exact keys per member.
        # Present or malformed members always retain the original semantic CLI.
        for offset in range(0,len(value['members']),14):
            if deadline-time.monotonic()<=0.01:break
            group=value['members'][offset:offset+14]
            keys=['coin_activation','coin_supply','private_activation']+[k for m in group for k in ['member/'+m,'coin_balance/'+m]]
            try:
                state=native.strict_json(run_public_selection({'keys':keys},directory,deadline))
                for member in group:
                    projected=project_public_absence(state,member)
                    if projected is not None:prefetched[member]=projected
            except (ValueError,TimeoutError,subprocess.TimeoutExpired):pass
        for member in value['members']:
            keys=['coin_activation','coin_supply','private_activation','member/'+member,'coin_balance/'+member]
            result={'member':member,'mode':'unavailable'}
            if member in prefetched:result={'member':member,'mode':'absence','state':prefetched[member]}
            else:
                for mode,selection in [('member',{'member':member,'keys':keys}),('absence',{'keys':keys})]:
                    if deadline-time.monotonic()<=0.01:break
                    try:
                        data=run_public_selection(selection,directory,deadline);state=native.strict_json(data)
                        if mode=='member' and state.get('member',{}).get('id')!=member:raise ValueError('Public batch member mismatch')
                        if mode=='absence' and (state.get('member') is not None or state.get('records',{}).get('member/'+member,'missing') is not None):raise ValueError('Public batch absence missing')
                        result={'member':member,'mode':mode,'state':state};break
                    except (ValueError,TimeoutError,subprocess.TimeoutExpired):continue
            if 'state' in result:
                total+=len(native.canonical(result['state']).encode())
                if total>2*1024*1024:raise RuntimeError('Public batch output bound')
            results.append(result)
    response={'schema':BATCH_SCHEMA,'requestDigest':hashlib.sha256(native.canonical(value).encode()).hexdigest(),'results':results}
    encoded=native.canonical(response).encode()
    if len(encoded)>2*1024*1024:raise ValueError('Public batch output bound')
    return encoded

BROKER_PUBLIC = 'imXvi5XRE9i3LNfAFfagRPz0F0Dl0tB1rfArCEUYgJ0'

def load_service():
    import types, stat
    info = SERVICE.lstat()
    if not SERVICE.is_file() or SERVICE.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022 or hashlib.sha256(SERVICE.read_bytes()).hexdigest() != SERVICE_SHA:
        raise ValueError('Custody service changed')
    for parent in SERVICE.parents:
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022: raise ValueError('Custody service ancestor refused')
    fd = os.open(SERVICE,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o022 or info.st_size > 1024*1024: raise ValueError('Custody service file refused')
        source = stream.read(1024*1024+1)
    if hashlib.sha256(source).hexdigest() != SERVICE_SHA: raise ValueError('Custody service changed')
    service = types.ModuleType('_retained_review_service');service.__file__=str(SERVICE)
    exec(compile(source,str(SERVICE),'exec'),service.__dict__)
    return service

def retained_decision(job, raw, custody=None):
    # Root-only recovery of a retained, independently signed audit. The sealing
    # password is used internally; vault attachments and signing keys are never
    # loaded. No report text or model response is returned.
    import base64
    import native_migration as native
    if not re.fullmatch('[a-f0-9]{32}', job) or not 0 < len(raw) <= LIMIT:
        raise ValueError('Retained decision input refused')
    b = native.strict_json(raw)
    require = lambda ok: None if ok else (_ for _ in ()).throw(ValueError('Retained decision binding refused'))
    require(type(b) == dict and set(b) == {'custodyJobId','owner','publicKey','contextDigest','inspectionDigest'} and b['custodyJobId'] == job)
    require(all(isinstance(b[k],str) and re.fullmatch('[a-f0-9]{64}',b[k]) for k in ['contextDigest','inspectionDigest']))
    require(isinstance(b['publicKey'],str) and re.fullmatch('[A-Za-z0-9_-]{43}',b['publicKey']))
    owner_key = base64.urlsafe_b64decode(b['publicKey']+'=')
    require(base64.urlsafe_b64encode(owner_key).decode().rstrip('=') == b['publicKey'] and b['owner'] == 'uain1'+hashlib.sha256(owner_key).hexdigest()[:40])
    service = load_service()
    policy = service.load(service.POLICY);service.validate_policy(policy,check_files=False)
    require(policy['decisionPublicKey'] == BROKER_PUBLIC)
    directory = RETAINED_ROOT / job
    result = {'status':'unknown','inspectionDigest':b['inspectionDigest']}
    context_path = directory / 'context.json'
    if not context_path.exists():return result
    context = service.load(context_path)['context']
    require(hashlib.sha256(service.bytes_json(context)).hexdigest() == b['contextDigest'])
    paths = [directory / (name+'.sealed.json') for name in ['report','audit']]
    if not all(path.exists() for path in paths):return result
    if custody is None:
        import custody
    key = hashlib.sha256(b'BAINK/private-service/sealing/v1\0'+custody.password().encode()).digest()
    report = service.sealed_read(directory,key,job,'report');audit = service.sealed_read(directory,key,job,'audit')
    require(type(report) == dict and report.get('schema') == 'baink-private-service-inspection-v1' and report.get('jobId') == job and report.get('inspectionDigest') == b['inspectionDigest'])
    inspection = report['inspection'];require(hashlib.sha256(service.bytes_json(inspection)).hexdigest() == b['inspectionDigest'] and inspection['context'] == context)
    require(inspection['parties'][0]['member'] == b['owner'] and inspection['parties'][0]['publicKey'] == b['publicKey'])
    require(type(audit) == dict and set(audit) == {'attestation','request','response'} and type(audit['request']) == str and type(audit['response']) == str)
    request = native.strict_json(audit['request'].encode())
    require(type(request) == dict and set(request) == {'schema','jobId','inspectionDigest','report'} and request['schema'] == 'baink-private-ai-request-v1' and request['jobId'] == job and request['inspectionDigest'] == b['inspectionDigest'] and request['report'] == report)
    attestation = audit['attestation'];require(type(attestation) == dict and set(attestation) == {'payload','signature'})
    payload = attestation['payload']
    require(type(payload) == dict and set(payload) == {'schema','jobId','inspectionDigest','provider','model','completedAt','requestSha256','responseSha256','decision'} and payload['schema'] == 'baink-private-ai-decision-v1' and payload['jobId'] == job and payload['inspectionDigest'] == b['inspectionDigest'] and payload['provider'] == 'claude-code' and payload['model'] in ('claude-sonnet-5-5','claude-opus-5-5'))
    require(payload['requestSha256'] == hashlib.sha256(audit['request'].encode()).hexdigest() and payload['responseSha256'] == hashlib.sha256(audit['response'].encode()).hexdigest())
    decision = payload['decision'];require(type(decision) == dict and set(decision) == {'class','statement','checkedPurpose','ownerLicenceChecked','bothLicencesChecked'} and decision['class'] in ['neutral','benevolent','refuse'] and decision['checkedPurpose'] == context['purpose'])
    require(type(decision['statement']) == str and 20 <= len(decision['statement']) <= 2000 and type(decision['ownerLicenceChecked']) == bool and type(decision['bothLicencesChecked']) == bool)
    pub = base64.urlsafe_b64decode(BROKER_PUBLIC+'=');signature = service.decode(attestation['signature'],64)
    message = b'BAINK/private-ai-decision/v1\n'+service.bytes_json(payload)
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        Ed25519PublicKey.from_public_bytes(pub).verify(signature,message)
    except ImportError:
        from Cryptodome.Signature import eddsa
        eddsa.new(eddsa.import_public_key(pub),'rfc8032').verify(message,signature)
    return {'status':'refused' if decision['class'] == 'refuse' else 'attested','inspectionDigest':b['inspectionDigest']}

FEEDBACK_SOCKET=Path('/run/uain-central-reviewer/custody.sock')
FEEDBACK_LIMIT=73728
FEEDBACK_ID=re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,95}')
def feedback_json(raw,limit):
 if type(raw)!=bytes or not 0<len(raw)<=limit:raise ValueError('Feedback bytes refused')
 def pairs(items):
  out={}
  for key,value in items:
   if key in out:raise ValueError('Duplicate feedback field')
   out[key]=value
  return out
 def reject(_):raise ValueError('Unsafe feedback number')
 return json.loads(raw.decode('utf-8'),object_pairs_hook=pairs,parse_float=reject,parse_constant=reject)
def feedback_request(value):
 if type(value)!=dict or set(value)!={'submission','executionId'} or type(value['submission'])!=str or not FEEDBACK_ID.fullmatch(value['submission']) or not(value['executionId'] is None or type(value['executionId'])==str and FEEDBACK_ID.fullmatch(value['executionId'])):raise ValueError('Feedback request refused')
 return value
def feedback_canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def feedback_job_id(value):return hashlib.sha256(b'UAIN/central-review-feedback-request/v1\n'+feedback_canonical(feedback_request(value))).hexdigest()[:32]
def feedback_packet(raw,request):
 v=feedback_json(raw,FEEDBACK_LIMIT);fields={'schema','submission','executionId','author','task','project','chainId','genesisSha256','nativeReview','decision','native'}
 def require(x):
  if not x:raise ValueError('Public feedback projection refused')
 require(type(v)==dict and set(v)==fields and v['schema']=='uain-central-review-feedback-v1' and v['submission']==request['submission'] and type(v['executionId'])==str and FEEDBACK_ID.fullmatch(v['executionId']) and(request['executionId'] is None or v['executionId']==request['executionId']))
 require(v['chainId']==STATE_CHAIN and v['genesisSha256']==STATE_GENESIS_SHA and all(type(v[k])==str and FEEDBACK_ID.fullmatch(v[k]) for k in ('task','project')) and type(v['author'])==str and re.fullmatch('uain1[a-f0-9]{40}',v['author']))
 d=v['decision'];base={'schema','domain','submission','task','reviewer','execution_id','criteria_digest','evidence_digest','verdict','findings','started_at','completed_at'}
 require(type(d)==dict and((d.get('schema')=='uain-central-research-decision-v1' and set(d)==base) or(d.get('schema')=='uain-central-research-decision-v2' and set(d)==base|{'verification_attestation_digest'} and type(d['verification_attestation_digest'])==str and re.fullmatch('[a-f0-9]{64}',d['verification_attestation_digest']))) and d['domain']=='UAIN/central-research-review/v1')
 require(d['submission']==v['submission'] and d['task']==v['task'] and d['execution_id']==v['executionId'] and type(d['reviewer'])==str and re.fullmatch('uain1[a-f0-9]{40}',d['reviewer']) and d['reviewer']!=v['author'] and d['verdict'] in ('accept','reject','needs_evidence') and all(type(d[k])==str and re.fullmatch('[a-f0-9]{64}',d[k]) for k in ('criteria_digest','evidence_digest')))
 require(type(d['findings'])==list and 1<=len(d['findings'])<=64 and all(type(x)==str and 0<len(x.encode())<=8192 for x in d['findings']) and len(feedback_canonical(d))<=65536)
 r=v['nativeReview'];require(type(r)==dict and set(r)=={'submission','execution_id','criteria_digest','evidence_digest','verification_digest','reviewer','height','verdict'} and all(r[k]==d[k] for k in ('submission','execution_id','criteria_digest','evidence_digest','reviewer','verdict')) and r['verification_digest']==hashlib.sha256(b'UAIN/central-research-review/v1\n'+feedback_canonical(d)).hexdigest())
 n=v['native'];require(type(n)==dict and set(n)=={'height','appHash','headerTime','verifierSha256'} and n['verifierSha256']==STATE_SHA and type(n['appHash'])==str and re.fullmatch('[a-f0-9]{64}',n['appHash']))
 require(all(type(x)==str and re.fullmatch('[1-9][0-9]{0,18}',x) and int(x)<=2**63-1 for x in (r['height'],n['height'])) and int(r['height'])<=int(n['height']))
 def stamp(x):
  require(type(x)==str and len(x)<=64);return datetime.datetime.fromisoformat(x.replace('Z','+00:00')).timestamp()
 require(stamp(d['started_at'])<=stamp(d['completed_at']) and stamp(d['completed_at'])-stamp(d['started_at'])<=600 and -60<=time.time()-stamp(n['headerTime'])<=120)
 return feedback_canonical(v)
def feedback_http(body):
 for parent in FEEDBACK_SOCKET.parents:
  s=parent.lstat()
  if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022:raise ValueError('Feedback socket parent refused')
 s=FEEDBACK_SOCKET.lstat()
 if not stat.S_ISSOCK(s.st_mode) or s.st_uid!=0 or s.st_nlink!=1 or s.st_mode&0o007:raise ValueError('Feedback socket refused')
 class Connection(http.client.HTTPConnection):
  def connect(self):
   self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.settimeout(6.5);self.sock.connect(str(FEEDBACK_SOCKET));peer=struct.unpack('3i',self.sock.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
   if peer[1]!=0:raise ValueError('Feedback socket peer refused')
 c=Connection('localhost',timeout=6.5)
 try:
  c.request('POST','/feedback',body=feedback_canonical(body),headers={'Content-Type':'application/json'});response=c.getresponse();raw=response.read(FEEDBACK_LIMIT+1)
  if response.status!=200 or len(raw)>FEEDBACK_LIMIT:raise ValueError('Feedback unavailable')
  return raw
 finally:c.close()
def central_feedback(job,raw,request=None):
 value=feedback_request(feedback_json(raw,512))
 if feedback_job_id(value)!=job:raise ValueError('Feedback purpose binding refused')
 return feedback_packet((request or feedback_http)(value),value)

def dispatch(command, raw, invoke=None,feedback=None):
    action, job = parse_command(command)
    validate_input(action, raw)
    if action == 'central-feedback':return central_feedback(job,raw,request=feedback)
    if action == 'retained-relay': return retained_relay(job, raw)
    if action == 'public-state': return public_state(raw)
    if action == 'public-state-batch': return public_state_batch(raw)
    info = SERVICE.lstat()
    if not SERVICE.is_file() or SERVICE.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022 or hashlib.sha256(SERVICE.read_bytes()).hexdigest() != SERVICE_SHA:
        raise ValueError('Custody service changed')
    if invoke:
        return invoke([PYTHON, str(SERVICE), action, job], raw)
    child = subprocess.Popen([PYTHON, str(SERVICE), action, job], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             env={'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent'}, start_new_session=True)
    try:
        output, _ = child.communicate(raw, timeout=85)
        if child.returncode or len(output) > 2 * 1024 * 1024: raise ValueError('Custody action refused')
        return output
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()

if __name__ == '__main__':
    try:
        if os.geteuid() != 0: raise ValueError('Root required')
        local = len(sys.argv) == 3 and sys.argv[1] == 'retained-decision' and re.fullmatch('[a-f0-9]{32}',sys.argv[2])
        if len(sys.argv) != 1 and not local: raise ValueError('Root command refused')
        signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError('Input deadline')))
        signal.alarm(10)
        raw = sys.stdin.buffer.read(LIMIT + 1)
        signal.alarm(0)
        if not local and parse_command(os.environ.get('SSH_ORIGINAL_COMMAND',''))[0] in {'public-state','public-state-batch'}:
            for sig in [signal.SIGHUP,signal.SIGTERM]:signal.signal(sig,lambda *_:(_ for _ in ()).throw(InterruptedError('Public read interrupted')))
        result = json.dumps(retained_decision(sys.argv[2], raw),separators=(',',':')).encode() if local else dispatch(os.environ.get('SSH_ORIGINAL_COMMAND', ''), raw)
        sys.stdout.buffer.write(result)
    except Exception:
        print('Restricted review action refused.', file=sys.stderr)
        sys.exit(1)

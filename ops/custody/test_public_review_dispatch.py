import unittest
import json, os, tempfile
from pathlib import Path
from unittest.mock import patch
import public_review_dispatch as d

class DispatchTests(unittest.TestCase):
    def test_only_fixed_non_attesting_non_broadcasting_actions(self):
        for action in d.ACTIONS:
            self.assertEqual(d.parse_command('baink-private-review '+action+' '+'0'*32), (action,'0'*32))
        for command in ['bash', 'baink-private-review attest '+'a'*32, 'baink-private-review report '+'a'*32, 'baink-private-review broadcast '+'a'*32,
                        'baink-private-review health '+'a'*32, 'baink-private-review create '+'a'*32+'; id',
                        'baink-private-review create ../../etc/passwd', 'baink-private-review create '+'a'*32+' extra']:
            with self.assertRaises(ValueError): d.parse_command(command)

    def test_body_bound_and_method_binding(self):
        d.validate_input('create', b'{"context":{}}')
        d.validate_input('health', b'')
        for action, raw in [('report',b'{}'),('create',b''),('create',b'[]'),('ingest',b'{"a":1,"a":2}'),('relay',b'x'*(d.LIMIT+1))]:
            with self.assertRaises((ValueError,TypeError)): d.validate_input(action,raw)

@unittest.skipUnless(os.geteuid() == 0, 'root ownership fixture requires isolated Linux root test')
class RetainedRelayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path.home())
        self.root = Path(self.temp.name)
        self.override = patch.object(d, 'RETAINED_ROOT', self.root)
        self.override.start()
        self.job = 'a' * 32
        self.directory = self.root / self.job
        self.directory.mkdir(mode=0o700)
        self.path = self.directory / 'relay.json'
        self.digest = 'b' * 64
        self.raw = json.dumps({'requestDigest':self.digest}).encode()
    def tearDown(self):
        self.override.stop()
        self.temp.cleanup()
    def write(self, value):
        self.path.write_text(json.dumps(value));self.path.chmod(0o600)
    def call(self, raw=None):
        return json.loads(d.dispatch('baink-private-review retained-relay '+self.job, self.raw if raw is None else raw,
            invoke=lambda *_:self.fail('read-only recovery invoked a signing service')))
    def test_retained_binding_no_signing_and_byte_stable_file(self):
        self.write({'requestDigest':self.digest,'envelope':{'fixture':True}})
        before = self.path.read_bytes()
        self.assertEqual(self.call(), {'status':'retained','requestDigest':self.digest,'envelope':{'fixture':True}})
        self.assertEqual(self.path.read_bytes(), before)
    def test_missing_result_unknown_not_recreated(self):
        self.assertEqual(self.call(), {'status':'unknown','requestDigest':self.digest})
        self.assertFalse(self.path.exists())
    def test_changed_binding_malformed_input_extra_fields_refused(self):
        self.write({'requestDigest':'c'*64,'envelope':{}})
        with self.assertRaises(ValueError):self.call()
        for raw in [b'{}', b'{"requestDigest":"bad"}', b'{"requestDigest":"'+self.digest.encode()+b'","extra":true}', b'{"requestDigest":"'+self.digest.encode()+b'","requestDigest":"'+self.digest.encode()+b'"}']:
            with self.assertRaises(ValueError):self.call(raw)
    def test_symlink_hardlink_and_loose_permissions_refused(self):
        target = self.root / 'target';target.write_text('{}');target.chmod(0o600)
        self.path.symlink_to(target)
        with self.assertRaises(ValueError):self.call()
        self.path.unlink();self.write({'requestDigest':self.digest,'envelope':{}})
        os.link(self.path,self.directory/'linked')
        with self.assertRaises(ValueError):self.call()
        (self.directory/'linked').unlink();self.path.chmod(0o644)
        with self.assertRaises(ValueError):self.call()


@unittest.skipUnless(os.geteuid() == 0, 'protected root fixture')
class RetainedDecisionTests(unittest.TestCase):
    def setUp(self):
        import types, base64, hashlib
        import native_migration as native
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        self.temp=tempfile.TemporaryDirectory(dir=Path.home());self.root=Path(self.temp.name);self.job='a'*32;self.directory=self.root/self.job;self.directory.mkdir(mode=0o700)
        seed=os.urandom(32);pub,self.sign=native.ed25519(seed);self.public=base64.urlsafe_b64encode(pub).decode().rstrip('=')
        owner_pub=base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip('=');owner='uain1'+hashlib.sha256(base64.urlsafe_b64decode(owner_pub+'=')).hexdigest()[:40]
        canonical=lambda v:native.canonical(v).encode()
        self.canonical=canonical;self.hash=lambda v:hashlib.sha256(v).hexdigest();self.key=hashlib.sha256(b'BAINK/private-service/sealing/v1\0fixture-password').digest()
        self.context={'purpose':'b'*64};inspection={'context':self.context,'parties':[{'member':owner,'publicKey':owner_pub}]}
        self.binding={'custodyJobId':self.job,'owner':owner,'publicKey':owner_pub,'contextDigest':self.hash(canonical(self.context)),'inspectionDigest':self.hash(canonical(inspection))}
        self.report={'schema':'baink-private-service-inspection-v1','jobId':self.job,'inspectionDigest':self.binding['inspectionDigest'],'inspection':inspection}
        self.request=json.dumps({'schema':'baink-private-ai-request-v1','jobId':self.job,'inspectionDigest':self.binding['inspectionDigest'],'report':self.report},separators=(',',':'));self.response='fixture-response'
        self.payload={'schema':'baink-private-ai-decision-v1','jobId':self.job,'inspectionDigest':self.binding['inspectionDigest'],'provider':'claude-code','model':'claude-sonnet-5-5','completedAt':'2026-11-05T00:00:00Z','requestSha256':self.hash(self.request.encode()),'responseSha256':self.hash(self.response.encode()),'decision':{'class':'refuse','statement':'Insufficient fixture purpose evidence','checkedPurpose':'b'*64,'ownerLicenceChecked':True,'bothLicencesChecked':True}}
        self.aes=AESGCM
        def decode(s,n):
            raw=base64.urlsafe_b64decode(s+'='*((-len(s))%4))
            if len(raw)!=n or base64.urlsafe_b64encode(raw).decode().rstrip('=')!=s:raise ValueError('decode')
            return raw
        load=lambda p:native.strict_json(native.protected_read(p,4*1024*1024))
        def sealed(directory,key,job,name):
            frame=load(directory/(name+'.sealed.json'))
            return native.strict_json(AESGCM(key).decrypt(bytes.fromhex(frame['nonce']),base64.b64decode(frame['ciphertext']),('BAINK/private-service/v1\n'+job+'\n'+name).encode()))
        self.policy=self.root/'policy.json';self.write(self.policy,{'decisionPublicKey':self.public})
        self.service=types.SimpleNamespace(POLICY=self.policy,load=load,validate_policy=lambda p,check_files:None,sealed_read=sealed,bytes_json=canonical,decode=decode)
        self.patches=[patch.object(d,'RETAINED_ROOT',self.root),patch.object(d,'BROKER_PUBLIC',self.public),patch.object(d,'load_service',lambda:self.service)]
        for p in self.patches:p.start()
        self.password_calls=0
        def password():self.password_calls+=1;return 'fixture-password'
        self.custody=types.SimpleNamespace(password=password,vault=lambda:self.fail('vault accessed'),attachment=lambda *_:self.fail('private attachment accessed'))
        self.write(self.directory/'context.json',{'context':self.context});self.seal('report',self.report);self.audit()
    def tearDown(self):
        for p in reversed(self.patches):p.stop()
        self.temp.cleanup()
    def write(self,path,v):path.write_bytes(self.canonical(v));path.chmod(0o600)
    def seal(self,name,v):
        import base64
        nonce=os.urandom(12);wire=self.aes(self.key).encrypt(nonce,self.canonical(v),('BAINK/private-service/v1\n'+self.job+'\n'+name).encode())
        self.write(self.directory/(name+'.sealed.json'),{'schema':'baink-private-service-sealed-v1','nonce':nonce.hex(),'ciphertext':base64.b64encode(wire).decode()})
    def audit(self):
        import base64
        signature=base64.urlsafe_b64encode(self.sign(b'BAINK/private-ai-decision/v1\n'+self.canonical(self.payload))).decode().rstrip('=')
        self.seal('audit',{'attestation':{'payload':self.payload,'signature':signature},'request':self.request,'response':self.response})
    def call(self,b=None):return d.retained_decision(self.job,self.canonical(self.binding if b is None else b),self.custody)
    def test_retained_refusal_and_positive_verify_without_any_signing_key_access(self):
        self.assertEqual(self.call(),{'status':'refused','inspectionDigest':self.binding['inspectionDigest']})
        self.payload['decision']['class']='neutral';self.audit();self.assertEqual(self.call()['status'],'attested')
    def test_missing_audit_unknown_without_sealing_password(self):
        (self.directory/'audit.sealed.json').unlink();self.assertEqual(self.call()['status'],'unknown');self.assertEqual(self.password_calls,0)
    def test_policy_substitution_and_changed_binding_refused(self):
        self.write(self.policy,{'decisionPublicKey':'a'*43})
        with self.assertRaises(ValueError):self.call()
        self.assertEqual(self.password_calls,0);self.write(self.policy,{'decisionPublicKey':self.public})
        for field,value in [('inspectionDigest','c'*64),('contextDigest','c'*64),('owner','uain1'+'c'*40),('custodyJobId','c'*32)]:
            with self.assertRaises(ValueError):self.call(dict(self.binding,**{field:value}))
    def test_forged_signed_payload_response_and_cross_job_ciphertext_refused(self):
        self.payload['decision']['class']='benevolent'
        # Change payload while preserving its old signature in authenticated storage.
        import base64
        old_signature=base64.urlsafe_b64encode(self.sign(b'not-the-payload')).decode().rstrip('=')
        self.seal('audit',{'attestation':{'payload':self.payload,'signature':old_signature},'request':self.request,'response':self.response})
        with self.assertRaises(Exception):self.call()
        self.audit();self.response='changed';self.audit()
        with self.assertRaises(ValueError):self.call()
    def test_forced_ssh_cannot_request_root_only_retained_decision(self):
        with self.assertRaises(ValueError):d.parse_command('baink-private-review retained-decision '+self.job)

@unittest.skipUnless(os.geteuid() == 0, 'protected root fixture')
class ServiceLoaderTests(unittest.TestCase):
    def test_real_root_owned_source_pin_and_rejection_without_importing_custody(self):
        import hashlib
        with tempfile.TemporaryDirectory(dir=Path.home()) as folder:
            source=Path(folder)/'service.py';source.write_bytes(b'FIXTURE_ONLY = True\n');source.chmod(0o600)
            with patch.object(d,'SERVICE',source),patch.object(d,'SERVICE_SHA',hashlib.sha256(source.read_bytes()).hexdigest()):
                self.assertTrue(d.load_service().FIXTURE_ONLY)
                source.write_bytes(b'FIXTURE_ONLY = False\n')
                with self.assertRaises(ValueError):d.load_service()



@unittest.skipUnless(os.geteuid()==0,'root native artifact fixture')
class PublicStateTests(unittest.TestCase):
    def setUp(self):
        import hashlib
        self.temp=tempfile.TemporaryDirectory(dir=Path.home());self.root=Path(self.temp.name);self.binary=self.root/'state';self.genesis=self.root/'genesis.json';self.genesis.write_text('{"chain_id":"fixture-public-state"}');self.genesis.chmod(0o600)
        script=b'#!/usr/bin/python3\nimport os,sys,json\na=sys.argv;out=a[a.index("--out")+1];v=json.load(sys.stdin);fd=os.open(out,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.write(fd,json.dumps({"fixture":True,"selection":v}).encode());os.close(fd)\n'
        self.binary.write_bytes(script);self.binary.chmod(0o700)
        self.patches=[patch.object(d,'STATE_BINARY',self.binary),patch.object(d,'STATE_SHA',hashlib.sha256(script).hexdigest()),patch.object(d,'STATE_GENESIS',self.genesis),patch.object(d,'STATE_GENESIS_SHA',hashlib.sha256(self.genesis.read_bytes()).hexdigest()),patch.object(d,'STATE_CHAIN','fixture-public-state'),patch.object(d,'STATE_TEMP',self.root/'runtime')]
        for p in self.patches:p.start()
    def tearDown(self):
        for p in reversed(self.patches):p.stop()
        self.temp.cleanup()
    def test_exact_read_action_does_not_invoke_service_or_vault_and_cleans_temp(self):
        value=json.loads(d.dispatch('baink-private-review public-state '+'0'*32,b'{"keys":["coin_supply"]}',invoke=lambda *_:self.fail('signing service invoked')))
        self.assertEqual(value,{'fixture':True,'selection':{'keys':['coin_supply']}});self.assertEqual([p.name for p in d.STATE_TEMP.iterdir()],['slot-0.lock'])
    def test_unknown_fields_duplicate_input_wrong_job_and_unsafe_keys_refused(self):
        for raw in [b'{"rpc":"http://evil"}',b'{"method":"broadcast_tx_sync"}',b'{"private_key":"bad"}',b'{"keys":[],"keys":[]}',b'{"member":"bad"}',json.dumps({'keys':['x']*33}).encode(),b'{"receipt":{}}']:
            with self.assertRaises(ValueError):d.public_state(raw)
        with self.assertRaises(ValueError):d.parse_command('baink-private-review public-state '+'a'*32)
    def test_changed_binary_pin_genesis_and_symlink_refused(self):
        self.binary.write_bytes(b'changed')
        with self.assertRaises(ValueError):d.public_state(b'{}')
        self.binary.unlink();self.binary.symlink_to(self.genesis)
        with self.assertRaises(ValueError):d.public_state(b'{}')
    def test_two_global_slots_refuse_third_without_spawning(self):
        import fcntl
        d.STATE_TEMP.mkdir(mode=0o700)
        files=[]
        try:
            for n in range(2):
                fd=os.open(d.STATE_TEMP/('slot-'+str(n)+'.lock'),os.O_RDWR|os.O_CREAT,0o600);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);files.append(fd)
            with patch.object(d.subprocess,'Popen',side_effect=AssertionError('must not spawn')):
                with self.assertRaisesRegex(ValueError,'capacity'):d.public_state(b'{}')
        finally:
            for fd in files:os.close(fd)
    def test_oversized_or_non_json_output_refused_and_cleaned(self):
        import hashlib
        for body in [b'not JSON',b'x'*(2*1024*1024+1)]:
            script=b'#!/usr/bin/python3\nimport os,sys\na=sys.argv;fd=os.open(a[a.index("--out")+1],os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.write(fd,'+repr(body).encode()+b');os.close(fd)\n'
            self.binary.write_bytes(script)
            with patch.object(d,'STATE_SHA',hashlib.sha256(script).hexdigest()):
                with self.assertRaises(ValueError):d.public_state(b'{}')
            self.assertFalse(any(p.is_dir() for p in d.STATE_TEMP.iterdir()))
    def test_batch_fixed_semantic_selections_request_binding_and_negative_fallback(self):
        import hashlib
        members=['uain1'+str(i)*40 for i in range(2)];calls=[]
        def run(value,directory,deadline):
            calls.append(value)
            if 'member' not in value and len(value['keys'])>5:
                state=self.prefetch_snapshot(members);state['records']['member/'+members[0]]={'id':members[0]};return json.dumps(state).encode()
            member=value.get('member') or value['keys'][3].split('/',1)[1]
            if member==members[1] and 'member' in value:raise ValueError('member absent')
            state={'records':{'member/'+member:None if member==members[1] else {'id':member}}}
            if 'member' in value:state['member']={'id':member}
            return json.dumps(state).encode()
        raw=json.dumps({'members':members},separators=(',',':')).encode()
        with patch.object(d,'run_public_selection',side_effect=run):value=json.loads(d.dispatch('baink-private-review public-state-batch '+'0'*32,raw))
        self.assertEqual([r['mode'] for r in value['results']],['member','absence']);self.assertEqual(value['requestDigest'],hashlib.sha256(raw).hexdigest());self.assertEqual(len(calls),2)
        for call in calls:self.assertEqual(call['keys'][:3],['coin_activation','coin_supply','private_activation']);self.assertLessEqual(len(call['keys']),31)
        self.assertFalse(any(p.is_dir() for p in d.STATE_TEMP.iterdir()))
    def test_batch_unavailable_first_member_preserves_second_valid_result(self):
        members=['uain1'+'a'*40,'uain1'+'b'*40];calls=[]
        def run(value,directory,deadline):
            calls.append(value)
            if 'member' not in value and len(value['keys'])>5:
                state=self.prefetch_snapshot(members)
                for m in members:state['records']['member/'+m]={'id':m}
                return json.dumps(state).encode()
            member=value.get('member') or value['keys'][3].split('/',1)[1]
            if member==members[0]:raise ValueError('fixture unavailable, not absence')
            return json.dumps({'member':{'id':member},'records':{'member/'+member:{'id':member}}}).encode()
        with patch.object(d,'run_public_selection',side_effect=run):value=json.loads(d.public_state_batch(json.dumps({'members':members}).encode()))
        self.assertEqual(value['results'][0],{'member':members[0],'mode':'unavailable'});self.assertEqual(value['results'][1]['mode'],'member');self.assertEqual(value['results'][1]['state']['member']['id'],members[1]);self.assertEqual(len(calls),4)
    def prefetch_snapshot(self,members):
        import base64
        keys=['guardians','legacy_import','event_count','coin_activation','coin_supply','private_activation']+[k for m in members for k in ['member/'+m,'coin_balance/'+m]]
        return {'chain_id':'fixture-public-state','height':'100','header_time':'2026-11-04T00:00:00Z','app_hash':'a'*64,'signed_header':{'fixture':True},'event_count':'0','records':{k:None for k in keys},'queries':[{'key':base64.b64encode(k.encode()).decode(),'value':None} for k in keys]}
    def test_prefetch_only_explicit_authenticated_raw_absence_projects_own_records(self):
        import copy,base64
        members=['uain1'+'a'*40,'uain1'+'b'*40];state=self.prefetch_snapshot(members);state['records']['member/'+members[1]]={'id':members[1]}
        projected=d.project_public_absence(state,members[0]);self.assertIsNotNone(projected);expected={'coin_activation','coin_supply','private_activation','legacy_import','member/'+members[0],'coin_balance/'+members[0]};self.assertEqual(set(projected['records']),expected);self.assertEqual(projected['signed_header'],state['signed_header']);self.assertEqual(projected['height'],state['height']);self.assertNotIn('member/'+members[1],projected['records']);self.assertIsNone(d.project_public_absence(state,members[1]))
        for mutate in ['missing','wrong-query','nonnull-bytes','duplicate-query','malformed-policy']:
            changed=copy.deepcopy(state);key='member/'+members[0]
            if mutate=='missing':del changed['records'][key]
            if mutate=='wrong-query':changed['queries']=[q for q in changed['queries'] if base64.b64decode(q['key']).decode()!=key]
            if mutate=='nonnull-bytes':next(q for q in changed['queries'] if base64.b64decode(q['key']).decode()==key)['value']=base64.b64encode(b'null').decode()
            if mutate=='duplicate-query':changed['queries'].append(next(q for q in changed['queries'] if base64.b64decode(q['key']).decode()==key))
            if mutate=='malformed-policy':changed['records'][key]={'id':members[0],'account_policy':'malformed'}
            self.assertIsNone(d.project_public_absence(changed,members[0]),mutate)
    def test_batch_prefetch_thirty_absences_uses_three_original_generic_verifier_calls(self):
        members=['uain1'+format(i,'040x') for i in range(30)];calls=[]
        def run(value,directory,deadline):
            self.assertNotIn('member',value);calls.append(value);group=[value['keys'][i].split('/',1)[1] for i in range(3,len(value['keys']),2)];return json.dumps(self.prefetch_snapshot(group)).encode()
        with patch.object(d,'run_public_selection',side_effect=run):result=json.loads(d.public_state_batch(json.dumps({'members':members}).encode()))
        self.assertEqual([len(c['keys']) for c in calls],[31,31,7]);self.assertTrue(all(r['mode']=='absence' for r in result['results']))
        for row in result['results']:self.assertEqual(set(row['state']['records']),{'coin_activation','coin_supply','private_activation','legacy_import','member/'+row['member'],'coin_balance/'+row['member']})
    def test_prefetch_present_and_malformed_compact_members_still_use_original_semantics(self):
        members=['uain1'+str(i)*40 for i in range(3)];semantic=[];calls=[]
        def run(value,directory,deadline):
            calls.append(value)
            if 'member' not in value and len(value['keys'])>5:
                state=self.prefetch_snapshot(members)
                state['records']['member/'+members[0]]={'id':members[0],'account_policy':'malformed'};state['records']['member/'+members[1]]={'id':members[1]};return json.dumps(state).encode()
            member=value.get('member') or value['keys'][3].split('/',1)[1]
            if 'member' in value:semantic.append(member)
            if member==members[0]:raise ValueError('original semantic verifier refuses malformed compact member')
            return json.dumps({'member':{'id':member},'records':{'member/'+member:{'id':member}}}).encode()
        with patch.object(d,'run_public_selection',side_effect=run):result=json.loads(d.public_state_batch(json.dumps({'members':members}).encode()))
        self.assertEqual(semantic,members[:2]);self.assertEqual([r['mode'] for r in result['results']],['unavailable','member','absence']);self.assertEqual(len(calls),4)
    def test_batch_input_closed_bounded_and_zero_job(self):
        member='uain1'+'a'*40
        for value in [{'members':[]},{'members':[member]*2},{'members':['bad']},{'members':[member],'rpc':'http://evil'},{'members':['uain1'+format(i,'040x') for i in range(31)]}]:
            with self.assertRaises(ValueError):d.public_state_batch(json.dumps(value).encode())
        with self.assertRaises(ValueError):d.parse_command('baink-private-review public-state-batch '+'a'*32)
    def test_batch_aggregate_deadline_does_not_start_more_verifiers(self):
        clock=[0];calls=[];members=['uain1'+'a'*40,'uain1'+'b'*40]
        def run(*args):calls.append(None);clock[0]=8;raise TimeoutError('fixture aggregate deadline')
        with patch.object(d.time,'monotonic',side_effect=lambda:clock[0]),patch.object(d,'run_public_selection',side_effect=run):value=json.loads(d.public_state_batch(json.dumps({'members':members}).encode()))
        self.assertEqual(len(calls),1);self.assertTrue(all(r['mode']=='unavailable' for r in value['results']))
    def test_batch_shares_both_global_slots_and_never_exceeds_output_bound(self):
        import fcntl
        d.STATE_TEMP.mkdir(mode=0o700);files=[]
        try:
            for n in range(2):
                fd=os.open(d.STATE_TEMP/('slot-'+str(n)+'.lock'),os.O_RDWR|os.O_CREAT,0o600);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);files.append(fd)
            with patch.object(d,'run_public_selection',side_effect=AssertionError('no verifier')):
                with self.assertRaisesRegex(ValueError,'capacity'):d.public_state_batch(json.dumps({'members':['uain1'+'a'*40]}).encode())
        finally:
            for fd in files:os.close(fd)
        member='uain1'+'a'*40;oversized=json.dumps({'member':{'id':member},'padding':'x'*(2*1024*1024)}).encode()
        with patch.object(d,'run_public_selection',return_value=oversized):
            with self.assertRaisesRegex(RuntimeError,'output bound'):d.public_state_batch(json.dumps({'members':[member]}).encode())
    def test_timeout_kills_process_group_and_removes_output_directory(self):
        from unittest.mock import MagicMock
        import subprocess
        child=MagicMock();child.pid=99999999;child.poll.return_value=None;child.communicate.side_effect=subprocess.TimeoutExpired('fixture',7)
        with patch.object(d.subprocess,'Popen',return_value=child),patch.object(d.os,'killpg') as kill:
            with self.assertRaises(subprocess.TimeoutExpired):d.public_state(b'{}')
            kill.assert_called_once_with(child.pid,d.signal.SIGKILL);child.wait.assert_called_once()
        self.assertFalse(any(p.is_dir() for p in d.STATE_TEMP.iterdir()))

if __name__ == '__main__': unittest.main()

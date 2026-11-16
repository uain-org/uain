"""Pure correction codec fixtures; ephemeral test keys, no native/runtime calls."""
import unittest,json,hashlib,base64,types,copy
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding,PublicFormat
try:import survey_correction as m
except ModuleNotFoundError as e:
 if e.name!='survey_correction':raise
 m=types.SimpleNamespace()
def canonical(v):
 if type(v)==dict:return '{'+','.join(json.dumps(k,ensure_ascii=False)+':'+canonical(v[k])for k in sorted(v,key=lambda s:s.encode('utf-16-be'))) +'}'
 if type(v)==list:return '['+','.join(canonical(x)for x in v)+']'
 return json.dumps(v,ensure_ascii=False,separators=(',',':'))
def digest(v):return hashlib.sha256(v if type(v)==bytes else v.encode()).hexdigest()
def fixture():
 key=Ed25519PrivateKey.generate();pub=key.public_key().public_bytes(Encoding.Raw,PublicFormat.Raw);member='uain1'+digest(pub)[:40];h='a'*64
 body=dict(schema='uain-survey-author-correction-v1',chainId='fixture-chain',genesisSha256=h,author=dict(member=member,instance=None),projectId='project-1',taskId='task-1',submissionId='submission-1',original=dict(nativeEvidenceDigest=h,canonicalArtifactDigest=h,criteriaDigest=h,policyDigest=h,attestationDigest=h),priorReview=dict(executionId='review-1',verificationDigest=h,reviewRecordDigest=h,feedbackDecisionDigest=h),correctionIndex=1,previousCorrectionDigest=None,edits=[dict(kind='doi',id='10.1234/fictional',oldNoteSha256=h,newNote='A corrected fictional note with no achievement claim.',sourceRefs=[dict(kind='doi',id='10.1234/fictional')])],correctedArtifactDigest=h,consent=dict(nonce='b'*32,issuedAt='2026-11-09T00:00:00.000Z',expiresAt='2026-11-09T00:10:00.000Z'))
 envelope=dict(schema='uain-survey-author-envelope-v1',body=body,publicKey=base64.urlsafe_b64encode(pub).decode().rstrip('='),signature=base64.urlsafe_b64encode(key.sign(('UAIN/central-survey-correction/author/v1\n'+canonical(body)).encode())).decode().rstrip('='))
 expected={k:copy.deepcopy(body[k])for k in ['chainId','genesisSha256','author','projectId','taskId','submissionId','original','priorReview']};expected['author']['publicKey']=envelope['publicKey'];expected['priorReview'].update(verdict='needs_evidence',finalized=True);expected['chainHead']=None
 return envelope,expected,key
class Correction(unittest.TestCase):
 def test_canonical_author_wire_and_closed_schema(self):
  envelope,_,_=fixture();self.assertTrue(callable(getattr(m,'parse_author_envelope',None)),'author wire codec missing');self.assertEqual(m.parse_author_envelope(canonical(envelope).encode()),envelope)
  for raw in [canonical(envelope)+'\n',canonical(envelope).replace('"schema":','"schema":"duplicate","schema":'),canonical({**envelope,'privatePrompt':'refused'})]:
   with self.assertRaises(ValueError):m.parse_author_envelope(raw.encode())
 def test_real_fixture_signature_and_native_context_binding(self):
  e,x,_=fixture();self.assertTrue(callable(getattr(m,'validate_author_correction',None)),'signature validator missing');self.assertEqual(m.validate_author_correction(e,x,now=lambda:1794182700000),e)
  x['author']['instance']='foreign-instance'
  with self.assertRaises(ValueError):m.validate_author_correction(e,x,now=lambda:1794182700000)
 def test_expiry_boundary_and_strict_wire_timestamp(self):
  e,x,_=fixture();self.assertTrue(callable(getattr(m,'validate_author_correction',None)),'signature validator missing')
  with self.assertRaises(ValueError):m.validate_author_correction(e,x,now=lambda:1794183000000)
  e['body']['consent']['issuedAt']='2026-11-09T00:00:00Z'
  with self.assertRaises(ValueError):m.parse_author_envelope(canonical(e).encode())
def chain_fixture():
 e,x,key=fixture();artifact=dict(schema='uain-evidence-artifact-v1',taskId='task-1',submissionId='submission-1',author=e['body']['author']['member'],metadata={'\ue000':'BMP','\U00010000':'astral'},survey=dict(mainKpi='Fictional research goal',asOf='2026-11-09',items=[dict(kind='doi',id='10.1234/fictional',title='Fictional primary record',relation='partial',note='Original fictional note about the record.')],conclusion=dict(meetsMainKpi=False,gaps=['No scientific achievement is claimed by this fixture.'])))
 raw=json.dumps(artifact,indent=2).encode();e['body']['original']['nativeEvidenceDigest']=digest(raw);e['body']['original']['canonicalArtifactDigest']=digest(canonical(artifact));e['body']['edits'][0]['oldNoteSha256']=digest(artifact['survey']['items'][0]['note']);first=copy.deepcopy(artifact);first['survey']['items'][0]['note']=e['body']['edits'][0]['newNote'];e['body']['correctedArtifactDigest']=digest(canonical(first))
 def resign(value):
  value=copy.deepcopy(value);value['signature']=base64.urlsafe_b64encode(key.sign(('UAIN/central-survey-correction/author/v1\n'+canonical(value['body'])).encode())).decode().rstrip('=');return value
 previous=resign(e);current=copy.deepcopy(previous);b=current['body'];b['correctionIndex']=2;b['previousCorrectionDigest']=digest('UAIN/central-survey-correction/author-envelope/v1\n'+canonical(previous));b['priorReview'].update(executionId='review-after-correction-1',verificationDigest='c'*64,feedbackDecisionDigest='c'*64,reviewRecordDigest='d'*64);b['consent']=dict(nonce='e'*32,issuedAt='2026-11-09T00:20:00.000Z',expiresAt='2026-11-09T00:30:00.000Z');b['edits'][0]['oldNoteSha256']=digest(first['survey']['items'][0]['note']);b['edits'][0]['newNote']='A second corrected fictional note answering the next finding.';second=copy.deepcopy(first);second['survey']['items'][0]['note']=b['edits'][0]['newNote'];b['correctedArtifactDigest']=digest(canonical(second));current=resign(current);x.update(original=copy.deepcopy(b['original']),priorReview={**b['priorReview'],'verdict':'needs_evidence','finalized':True},chainHead=dict(index=1,authorEnvelopeDigest=b['previousCorrectionDigest'],correctedArtifactDigest=previous['body']['correctedArtifactDigest'],reviewExecutionId=b['priorReview']['executionId'],reviewVerificationDigest='c'*64,status='finalized-needs-evidence'))
 return raw,previous,current,x,second,resign
class ChainCorrection(unittest.TestCase):
 def test_complete_historical_chain_uses_prior_note_without_rewriting_pretty_original(self):
  raw,previous,current,x,second,_=chain_fixture();self.assertTrue(callable(getattr(m,'derive_corrected_artifact',None)),'chain derivation missing');before=bytes(raw);result=m.derive_corrected_artifact(raw,current,previous_envelopes=[previous]);self.assertEqual(result['artifact'],second);self.assertEqual(result['correctedArtifactDigest'],digest(canonical(second)));self.assertEqual(raw,before);self.assertEqual(m.validate_author_correction(current,x,now=lambda:1794183900000),current)
 def test_missing_chain_and_wrong_previous_note_are_refused(self):
  raw,previous,current,_,_,resign=chain_fixture();self.assertTrue(callable(getattr(m,'derive_corrected_artifact',None)),'chain derivation missing')
  with self.assertRaises(ValueError):m.derive_corrected_artifact(raw,current)
  current['body']['edits'][0]['oldNoteSha256']=previous['body']['edits'][0]['oldNoteSha256']
  with self.assertRaises(ValueError):m.derive_corrected_artifact(raw,resign(current),previous_envelopes=[previous])
class CrossLanguage(unittest.TestCase):
 def test_python_fixture_signatures_full_chain_and_utf16_keys_verify_in_real_node(self):
  import subprocess,shutil,os
  raw,previous,current,expected,second,_=chain_fixture();module=(__import__('pathlib').Path(__file__).resolve().parents[2]/'apps/baink/shared/survey-correction.mjs').as_uri();node=shutil.which('node');self.assertIsNotNone(node,'real Node runtime required, not skipped')
  code='import * as c from '+json.dumps(module)+';let s="";for await(const b of process.stdin)s+=b;const x=JSON.parse(s);const e=c.parseAuthorEnvelope(new TextEncoder().encode(x.wire));await c.validateAuthorCorrection(e,x.expected,{now:()=>1794183900000});const result=await c.deriveCorrectedArtifact(x.raw,e,{previousEnvelopes:x.previous});console.log(JSON.stringify({result,bodyDigest:await c.authorBodyDigest(e.body),envelopeDigest:await c.authorCorrectionDigest(e)}));'
  data=dict(raw=raw.decode(),wire=canonical(current),expected=expected,previous=[previous]);r=subprocess.run([node,'--input-type=module','-e',code],input=json.dumps(data),capture_output=True,encoding='utf-8',timeout=15,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','HOME':'/nonexistent'});self.assertEqual(r.returncode,0,r.stderr);value=json.loads(r.stdout);self.assertEqual(value['result'],m.derive_corrected_artifact(raw,current,previous_envelopes=[previous]));self.assertEqual(value['result']['artifact'],second);self.assertEqual(value['bodyDigest'],digest('UAIN/central-survey-correction/author/v1\n'+canonical(current['body'])));self.assertEqual(value['envelopeDigest'],digest('UAIN/central-survey-correction/author-envelope/v1\n'+canonical(current)))
 def test_unicode_driver_byte_bound_and_exact_instance_are_preserved(self):
  e,x,key=fixture();e['body']['author']['instance']='fixture-instance';e['body']['edits'][0]['newNote']='😀😀😀';x['author']['instance']='fixture-instance';e['signature']=base64.urlsafe_b64encode(key.sign(('UAIN/central-survey-correction/author/v1\n'+canonical(e['body'])).encode())).decode().rstrip('=');self.assertEqual(m.validate_author_correction(e,x,now=lambda:1794182700000)['body']['author']['instance'],'fixture-instance')
  for note in ['  A padded fictional note.','A carriage\rreturn is not allowed.','😀😀']:
   bad=copy.deepcopy(e);bad['body']['edits'][0]['newNote']=note
   with self.assertRaises(ValueError):m.parse_author_envelope(canonical(bad).encode())
class Commitments(unittest.TestCase):
 def test_prior_native_record_hash_is_complete_and_domain_separated(self):
  r=dict(submission='submission-1',execution_id='review-1',criteria_digest='a'*64,evidence_digest='a'*64,verification_digest='b'*64,reviewer='uain1'+'c'*40,height='123',verdict='needs_evidence');self.assertTrue(callable(getattr(m,'prior_review_record_digest',None)),'native record commitment missing');self.assertEqual(m.prior_review_record_digest(r),digest('UAIN/central-survey-correction/prior-native-record/v1\n'+canonical(r)))
  with self.assertRaises(ValueError):m.prior_review_record_digest({**r,'privatePrompt':'refused'})
 def test_noncallable_clock_cannot_fall_back_to_wall_time(self):
  from unittest.mock import patch
  e,x,_=fixture()
  with patch.object(m.time,'time_ns',return_value=1794182700000*1000000):
   with self.assertRaises(ValueError):m.validate_author_correction(e,x,now=False)

class TypedRefusals(unittest.TestCase):
 def test_malformed_wire_has_fixed_refusal_and_scalar_kind(self):
  for raw in [b'never-returned-sensitive-body', b'\xff']:
   with self.assertRaises(m.Refused) as caught:m.parse_author_envelope(raw)
   self.assertEqual(str(caught.exception),'survey_correction_refused')
  e,_,_=fixture();e['body']['edits'][0]['kind']=['doi']
  with self.assertRaises(m.Refused):m.parse_author_envelope(canonical(e))
class WireBoundaries(unittest.TestCase):
 def test_calendar_utf8_and_duplicate_boundaries(self):
  e,_,_=fixture()
  for timestamp in ['2026-02-29T00:00:00.000Z','2026-11-09T00:00:60.000Z','0000-11-09T00:00:00.000Z','2026-11-09T00:00:00.000+00:00','2026-11-09T00:00:00.000z']:
   bad=copy.deepcopy(e);bad['body']['consent']['issuedAt']=timestamp
   with self.assertRaises(m.Refused):m.parse_author_envelope(canonical(bad))
  for note,accepted in [('😀'*100,True),('😀'*101,False),('A tab\tand newline\ninside a note.',True)]:
   bad=copy.deepcopy(e);bad['body']['edits'][0]['newNote']=note
   if accepted:m.parse_author_envelope(canonical(bad))
   else:
    with self.assertRaises(m.Refused):m.parse_author_envelope(canonical(bad))
  wire=canonical(e)
  for raw in [wire.replace('"schema":','"\\u0073chema":"shadow","schema":'),wire.replace('"correctionIndex":1','"correctionIndex":9007199254740992'),wire.replace('"newNote":','"newNote":"\\ud800","removed":')]:
   with self.assertRaises(m.Refused):m.parse_author_envelope(raw)
 def test_snapshot_rejects_subclasses_without_invoking_hooks(self):
  class Hook(dict):
   def items(self):raise AssertionError('hook must not execute')
  with self.assertRaises(m.Refused):m.author_correction_digest(Hook())

if __name__=='__main__':unittest.main()

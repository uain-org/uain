"""Pure author correction codec/verification; no custody, I/O or execution authority."""
import base64,datetime,hashlib,json,re,time
MAX_ENVELOPE_BYTES=24576
ORIGINAL=('nativeEvidenceDigest','canonicalArtifactDigest','criteriaDigest','policyDigest','attestationDigest')
PRIOR=('executionId','verificationDigest','reviewRecordDigest','feedbackDecisionDigest')
BODY=('schema','chainId','genesisSha256','author','projectId','taskId','submissionId','original','priorReview','correctionIndex','previousCorrectionDigest','edits','correctedArtifactDigest','consent')
AUTHOR_DOMAIN='UAIN/central-survey-correction/author/v1'
ENVELOPE_DOMAIN='UAIN/central-survey-correction/author-envelope/v1'
JS_SPACE='\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
PATTERNS={'doi':r'10\.[0-9]{4,9}/[-._;()/:a-z0-9<>\[\]]{1,200}','arxiv':r'(?:[0-9]{4}\.[0-9]{4,5}|[a-z-]{2,20}(?:\.[a-z]{2})?/[0-9]{7})','github':r'[a-z0-9](?:[a-z0-9-]{0,38})/[a-z0-9._-]{1,100}','pubmed':r'[1-9][0-9]{0,9}','nct':r'NCT[0-9]{8}','wikidata':r'Q[1-9][0-9]{0,11}'}
class Refused(ValueError):pass
def require(value):
 if not value:raise Refused('survey_correction_refused')
def match(pattern,value):return type(value)==str and re.fullmatch(pattern,value) is not None
def sha(raw):return hashlib.sha256(raw).hexdigest()
def snapshot(value,depth=0):
 require(depth<=64)
 if value is None or type(value)==bool:return value
 if type(value)==str:value.encode('utf-8');return value
 if type(value)==int:require(abs(value)<=9007199254740991);return value
 if type(value)==list:return[snapshot(x,depth+1)for x in value]
 require(type(value)==dict and all(type(k)==str for k in value));return{snapshot(k):snapshot(v,depth+1)for k,v in value.items()}
def canonical(value):
 if type(value)==dict:return '{'+','.join(json.dumps(k,ensure_ascii=False)+':'+canonical(value[k])for k in sorted(value,key=lambda k:k.encode('utf-16-be'))) +'}'
 if type(value)==list:return '['+','.join(canonical(x)for x in value)+']'
 return json.dumps(value,ensure_ascii=False,separators=(',',':'))
def exact(value,keys):require(type(value)==dict and set(value)==set(keys))
def integer(raw):require(raw!='-0');value=int(raw);require(abs(value)<=9007199254740991);return value
def refuse_number(_):raise Refused('survey_correction_refused')
def unique(pairs):
 result={}
 for k,v in pairs:require(k not in result);result[k]=v
 return result
def strict_json(text):return snapshot(json.loads(text,object_pairs_hook=unique,parse_int=integer,parse_float=refuse_number,parse_constant=refuse_number))
def stamp(value):
 require(match(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z',value) and int(value[:4])>=1)
 try:
  d=datetime.datetime.fromisoformat(value[:-1]+'+00:00');require(d.isoformat(timespec='milliseconds').replace('+00:00','Z')==value);delta=d-datetime.datetime(1970,1,1,tzinfo=datetime.timezone.utc);return delta.days*86400000+delta.seconds*1000+delta.microseconds//1000
 except (ValueError,OverflowError):raise Refused('survey_correction_refused')from None
def bytes64(value,size):
 require(match(r'[A-Za-z0-9_-]+',value))
 try:raw=base64.urlsafe_b64decode(value+'='*((4-len(value)%4)%4))
 except ValueError:raise Refused('survey_correction_refused')from None
 require(len(raw)==size and base64.urlsafe_b64encode(raw).decode().rstrip('=')==value);return raw
def identifier(kind,value):require(type(kind)==str and kind in PATTERNS and match(PATTERNS[kind],value) and not(kind=='github' and value.endswith('.git')))
def body_shape(b):
 exact(b,BODY);require(b['schema']=='uain-survey-author-correction-v1' and match(r'[A-Za-z0-9._-]{1,96}',b['chainId']) and match(r'[a-f0-9]{64}',b['genesisSha256']))
 exact(b['author'],('member','instance'));require(match(r'uain1[a-f0-9]{40}',b['author']['member']) and(b['author']['instance']is None or match(r'[A-Za-z0-9][A-Za-z0-9._-]{0,95}',b['author']['instance'])))
 for k in ('projectId','taskId','submissionId'):require(match(r'[A-Za-z0-9][A-Za-z0-9._-]{0,95}',b[k]))
 exact(b['original'],ORIGINAL)
 for k in ORIGINAL:require(match(r'[a-f0-9]{64}',b['original'][k]))
 exact(b['priorReview'],PRIOR);require(match(r'[A-Za-z0-9][A-Za-z0-9._-]{0,95}',b['priorReview']['executionId']))
 for k in PRIOR[1:]:require(match(r'[a-f0-9]{64}',b['priorReview'][k]))
 require(b['priorReview']['verificationDigest']==b['priorReview']['feedbackDecisionDigest'] and type(b['correctionIndex'])==int and 1<=b['correctionIndex']<=32 and(b['previousCorrectionDigest']is None if b['correctionIndex']==1 else match(r'[a-f0-9]{64}',b['previousCorrectionDigest'])) and match(r'[a-f0-9]{64}',b['correctedArtifactDigest']))
 require(type(b['edits'])==list and 1<=len(b['edits'])<=2);seen=set();references=set()
 for e in b['edits']:
  exact(e,('kind','id','oldNoteSha256','newNote','sourceRefs'));identifier(e['kind'],e['id']);pair=(e['kind'],e['id']);require(pair not in seen);seen.add(pair);note=e['newNote'];require(match(r'[a-f0-9]{64}',e['oldNoteSha256']) and type(note)==str and note==note.strip(JS_SPACE) and 10<=len(note.encode())<=400 and re.search(r'[\x00-\x08\x0b-\x1f\x7f]',note)is None and type(e['sourceRefs'])==list and 1<=len(e['sourceRefs'])<=2);local=set()
  for ref in e['sourceRefs']:
   exact(ref,('kind','id'));require(ref['kind']in('doi','nct'));identifier(ref['kind'],ref['id']);key=(ref['kind'],ref['id']);require(key not in local);local.add(key);references.add(key)
 require(len(references)<=4);exact(b['consent'],('nonce','issuedAt','expiresAt'));require(match(r'[a-f0-9]{32}',b['consent']['nonce']));start=stamp(b['consent']['issuedAt']);end=stamp(b['consent']['expiresAt']);require(0<end-start<=600000)
def envelope_shape(value):
 exact(value,('schema','body','publicKey','signature'));require(value['schema']=='uain-survey-author-envelope-v1');body_shape(value['body']);bytes64(value['publicKey'],32);bytes64(value['signature'],64);return value
def validated_envelope(value):
 result=envelope_shape(snapshot(value));require(len(canonical(result).encode())<=MAX_ENVELOPE_BYTES);return result
def parse_author_envelope(raw):
 require(type(raw)in(bytes,bytearray,str))
 try:
  raw=raw.encode()if type(raw)==str else bytes(raw);require(0<len(raw)<=MAX_ENVELOPE_BYTES and not raw.startswith(b'\xef\xbb\xbf'));text=raw.decode('utf-8');value=strict_json(text)
 except (UnicodeError,json.JSONDecodeError,RecursionError):raise Refused('survey_correction_refused') from None
 require(canonical(value)==text);return envelope_shape(value)
def author_correction_signing_bytes(body):
 value=snapshot(body);body_shape(value);return(AUTHOR_DOMAIN+'\n'+canonical(value)).encode()
def author_body_digest(body):return sha(author_correction_signing_bytes(body))
def author_correction_digest(envelope):return sha((ENVELOPE_DOMAIN+'\n'+canonical(validated_envelope(envelope))).encode())
def verify_envelope_signature(e):
 pub=bytes64(e['publicKey'],32);sig=bytes64(e['signature'],64);message=author_correction_signing_bytes(e['body']);require(e['body']['author']['member']=='uain1'+sha(pub)[:40])
 try:
  try:from Cryptodome.Signature import eddsa
  except ImportError:
   from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
   Ed25519PublicKey.from_public_bytes(pub).verify(sig,message)
  else:eddsa.new(eddsa.import_public_key(pub),'rfc8032').verify(message,sig)
 except Exception:raise Refused('survey_correction_refused')from None
def consent_now(consent,now):require(type(now)==int and now>=0 and stamp(consent['issuedAt'])<=now+30000 and now<stamp(consent['expiresAt']))
def validate_author_correction(value,context,now=None):
 e=validated_envelope(value);x=snapshot(context);b=e['body'];now=(lambda:time.time_ns()//1000000)if now is None else now;require(callable(now));exact(x,('chainId','genesisSha256','author','projectId','taskId','submissionId','original','priorReview','chainHead'));exact(x['author'],('member','instance','publicKey'));exact(x['original'],ORIGINAL);exact(x['priorReview'],(*PRIOR,'verdict','finalized'));require(x['author']['publicKey']==e['publicKey'] and x['author']['member']==b['author']['member'] and x['author']['instance']==b['author']['instance'] and x['priorReview']['verdict']=='needs_evidence' and x['priorReview']['finalized']is True)
 for k in ('chainId','genesisSha256','projectId','taskId','submissionId'):require(b[k]==x[k])
 require(b['original']==x['original'])
 for k in PRIOR:require(b['priorReview'][k]==x['priorReview'][k])
 if b['correctionIndex']==1:require(x['chainHead']is None)
 else:
  h=x['chainHead'];exact(h,('index','authorEnvelopeDigest','correctedArtifactDigest','reviewExecutionId','reviewVerificationDigest','status'));require(type(h['index'])==int and 1<=h['index']<32 and b['correctionIndex']==h['index']+1 and b['previousCorrectionDigest']==h['authorEnvelopeDigest'] and match(r'[a-f0-9]{64}',h['authorEnvelopeDigest']) and match(r'[a-f0-9]{64}',h['correctedArtifactDigest']) and h['status']=='finalized-needs-evidence' and h['reviewExecutionId']==b['priorReview']['executionId'] and h['reviewVerificationDigest']==b['priorReview']['verificationDigest'])
 consent_now(b['consent'],now());verify_envelope_signature(e);consent_now(b['consent'],now());return e
def original_artifact(raw):
 require(type(raw)in(bytes,bytearray,str));raw=raw.encode()if type(raw)==str else bytes(raw);require(0<len(raw)<=16384);value=strict_json(raw.decode());require(type(value)==dict and value.get('schema')=='uain-evidence-artifact-v1' and all(k in value for k in ('taskId','submissionId','author','survey')));exact(value['survey'],('mainKpi','asOf','items','conclusion'));items=value['survey']['items'];require(type(items)==list and 1<=len(items)<=60);seen=set()
 for item in items:
  exact(item,('kind','id','title','relation','note'));identifier(item['kind'],item['id']);require(type(item['note'])==str);pair=(item['kind'],item['id']);require(pair not in seen);seen.add(pair)
 return raw,value,seen
def derive_corrected_artifact(raw_original,current,previous_envelopes=None):
 envelope=validated_envelope(current);previous=snapshot(previous_envelopes if previous_envelopes is not None else[]);require(type(previous)==list and len(previous)==envelope['body']['correctionIndex']-1 and len(previous)<=31);chain=[validated_envelope(e)for e in previous]+[envelope];require(len(canonical(chain).encode())<=786432);raw,artifact,identifiers=original_artifact(raw_original);body=envelope['body'];require(artifact['author']==body['author']['member'] and artifact['taskId']==body['taskId'] and artifact['submissionId']==body['submissionId'] and sha(raw)==body['original']['nativeEvidenceDigest'] and sha(canonical(artifact).encode())==body['original']['canonicalArtifactDigest']);view=snapshot(artifact);nonces=set();reviews=set();parent=None
 for i,e in enumerate(chain):
  b=e['body'];require(b['correctionIndex']==i+1 and b['previousCorrectionDigest']==(author_correction_digest(parent)if parent else None) and e['publicKey']==envelope['publicKey'] and b['author']==body['author'] and b['original']==body['original'])
  for k in('chainId','genesisSha256','projectId','taskId','submissionId'):require(b[k]==body[k])
  require(b['consent']['nonce']not in nonces and b['priorReview']['executionId']not in reviews);nonces.add(b['consent']['nonce']);reviews.add(b['priorReview']['executionId']);verify_envelope_signature(e)
  for edit in b['edits']:
   target=next((x for x in view['survey']['items']if x['kind']==edit['kind'] and x['id']==edit['id']),None);require(target is not None and target['note']!=edit['newNote'] and sha(target['note'].encode())==edit['oldNoteSha256'] and all((ref['kind'],ref['id'])in identifiers for ref in edit['sourceRefs']));target['note']=edit['newNote']
  encoded=canonical(view).encode();require(len(encoded)<=16384 and sha(encoded)==b['correctedArtifactDigest']);parent=e
 encoded=canonical(view);return dict(artifact=view,canonicalArtifact=encoded,correctedArtifactDigest=sha(encoded.encode()),chainDigest=sha(('UAIN/central-survey-correction/author-chain/v1\n'+canonical(chain)).encode()))
def prior_review_record_digest(record):
 v=snapshot(record);exact(v,('submission','execution_id','criteria_digest','evidence_digest','verification_digest','reviewer','height','verdict'));require(match(r'[A-Za-z0-9][A-Za-z0-9._-]{0,95}',v['submission']) and match(r'[A-Za-z0-9][A-Za-z0-9._-]{0,95}',v['execution_id']) and match(r'uain1[a-f0-9]{40}',v['reviewer']) and v['verdict']in('accept','reject','needs_evidence'))
 for k in('criteria_digest','evidence_digest','verification_digest'):require(match(r'[a-f0-9]{64}',v[k]))
 require(match(r'[1-9][0-9]{0,18}',v['height']) and int(v['height'])<=9223372036854775807);return sha(('UAIN/central-survey-correction/prior-native-record/v1\n'+canonical(v)).encode())

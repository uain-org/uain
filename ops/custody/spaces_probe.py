"""One fixed-purpose conditional-create probe. Credentials stay in custody.

Only root's reviewed launcher may call run; pure probe accepts a client
for fictional tests. No caller chooses the bucket, object key or bytes.
"""
import hashlib,json,os,secrets,signal,socket,time

ENDPOINT='https://nyc3.digitaloceanspaces.com'
BUCKET='uain'
PREFIX='custody-probes/conditional-put/'

class ProbeRefused(ValueError):pass

def require(ok,reason):
 if not ok:raise ProbeRefused(reason)
def status(response):
 return response.get('ResponseMetadata',{}).get('HTTPStatusCode') if type(response)==dict else None
def error_matches(error,http,codes):
 response=getattr(error,'response',None)
 return type(response)==dict and status(response)==http and response.get('Error',{}).get('Code') in codes
def absent(client,key):
 try:client.head_object(Bucket=BUCKET,Key=key)
 except Exception as error:
  require(error_matches(error,404,{'404','NotFound','NoSuchKey'}),'Probe absence was not authenticated as HTTP404')
  return
 raise ProbeRefused('Generated probe object already exists')
def read_exact(client,key,expected):
 response=client.get_object(Bucket=BUCKET,Key=key)
 body=response['Body']
 try:
  require(status(response)==200 and response.get('ContentLength')==len(expected),'Probe read metadata differs')
  data=bytearray()
  while True:
   chunk=body.read(len(expected)+1-len(data))
   if not chunk:break
   data.extend(chunk);require(len(data)<=len(expected),'Probe read exceeds its fixed bound')
  require(bytes(data)==expected,'Probe original bytes changed')
 finally:body.close()

def probe(client):
 require(client.meta.endpoint_url==ENDPOINT,'Unexpected Spaces endpoint')
 key=PREFIX+secrets.token_hex(32);first=secrets.token_bytes(32)
 replacement=first[:-1]+bytes([first[-1]^1]);created=False;failure=None
 try:
  absent(client,key)
  # An ambiguous first PUT may have succeeded: cleanup starts before its call.
  created=True
  require(status(client.put_object(Bucket=BUCKET,Key=key,Body=first,ContentType='application/octet-stream',IfNoneMatch='*')) in {200,201},'Initial conditional create did not succeed')
  read_exact(client,key,first)
  try:client.put_object(Bucket=BUCKET,Key=key,Body=replacement,ContentType='application/octet-stream',IfNoneMatch='*')
  except Exception as error:
   require(error_matches(error,412,{'PreconditionFailed'}),'Replacement was not rejected specifically as HTTP412 PreconditionFailed')
  else:raise ProbeRefused('Spaces accepted a conditional replacement')
  read_exact(client,key,first)
 except Exception as error:
  failure=error if isinstance(error,ProbeRefused) else ProbeRefused('Spaces conditional probe failed')
 finally:
  if created:
   try:
    require(status(client.delete_object(Bucket=BUCKET,Key=key)) in {200,204},'Probe cleanup did not succeed')
    absent(client,key)
   except Exception:
    # Do not expose raw provider diagnostics, credential context or HTTP bodies.
    failure=ProbeRefused('Generated probe object cleanup could not be confirmed')
 if failure is not None:raise failure from None
 return {'schema':'uain-spaces-conditional-create-probe-v1','endpoint':ENDPOINT,'bucket':BUCKET,'object_key':key,'bytes':len(first),'original_sha256':hashlib.sha256(first).hexdigest(),'replacement_rejected_http':412,'replacement_error_code':'PreconditionFailed','original_bytes_unchanged':True,'current_probe_object_deleted':True,'production_writers_changed':False,'completed_at':int(time.time())}

def run(custody):
 require(os.geteuid()==0 and socket.gethostname()=='uain-app-1','Root app custody execution required')
 require(signal.getitimer(signal.ITIMER_REAL)==(0.0,0.0),'Existing custody deadline must not be replaced')
 def deadline(signum,frame):raise ProbeRefused('Spaces probe exceeded its fixed deadline')
 previous=signal.signal(signal.SIGALRM,deadline);signal.setitimer(signal.ITIMER_REAL,90)
 try:
  # The existing custody factory consumes only its internal storage secret.
  # One attempt per request bounds retries; no secret values enter argv/output.
  from botocore.config import Config
  client=custody.s3(config=Config(connect_timeout=5,read_timeout=10,retries={'total_max_attempts':1}))
  result=probe(client)
 finally:
  signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,previous)
 print(json.dumps(result,sort_keys=True));return result

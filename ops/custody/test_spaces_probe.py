"""Fictional object store, no credentials or provider writes."""
import io,sys,unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parent))
import spaces_probe as m

def reply(code,**kw):return {'ResponseMetadata':{'HTTPStatusCode':code},**kw}
class ProviderError(Exception):
 def __init__(self,code,name):self.response=reply(code,Error={'Code':name})
class Store:
 def __init__(self,mode='honor'):
  self.meta=SimpleNamespace(endpoint_url=m.ENDPOINT);self.mode=mode;self.objects={};self.calls=[];self.puts=0;self.bodies=[]
 def head_object(self,**kw):
  self.calls.append(('head',kw));key=kw['Key']
  if self.mode=='head403':raise ProviderError(403,'AccessDenied')
  if key not in self.objects:raise ProviderError(404,'NoSuchKey')
  return reply(200,ContentLength=len(self.objects[key]))
 def put_object(self,**kw):
  self.calls.append(('put',kw));self.puts+=1;key=kw['Key'];self.assert_public(kw)
  if self.puts==2 and self.mode in ('honor','changed','cleanup','oversize','length'):
   if self.mode=='changed':self.objects[key]=b'X'*32
   raise ProviderError(412,'PreconditionFailed')
  if self.puts==2 and self.mode=='denied':raise ProviderError(403,'AccessDenied')
  if self.puts==2 and self.mode=='conflict':raise ProviderError(409,'ConditionalRequestConflict')
  if self.puts==2 and self.mode=='timeout':raise TimeoutError('Fictional private provider diagnostic')
  self.objects[key]=kw['Body']
  if self.mode=='first_timeout':raise TimeoutError('Fictional ambiguous create')
  return reply(200)
 def assert_public(self,kw):
  assert kw['Bucket']==m.BUCKET and kw['Key'].startswith(m.PREFIX) and len(kw['Key'])==len(m.PREFIX)+64
  assert kw['IfNoneMatch']=='*' and len(kw['Body'])==32
 def get_object(self,**kw):
  self.calls.append(('get',kw));data=self.objects[kw['Key']]
  body=io.BytesIO(data+(b'X' if self.mode=='oversize' else b''));self.bodies.append(body)
  return reply(200,ContentLength=len(data)-(1 if self.mode=='length' else 0),Body=body)
 def delete_object(self,**kw):
  self.calls.append(('delete',kw))
  if self.mode=='cleanup':raise ProviderError(503,'FictionalFailure')
  del self.objects[kw['Key']];return reply(204)
class ProbeTests(unittest.TestCase):
 def test_actual_conditional_semantics_original_readback_and_cleanup_required(self):
  store=Store();result=m.probe(store)
  self.assertEqual(result['replacement_rejected_http'],412);self.assertTrue(result['original_bytes_unchanged']);self.assertFalse(store.objects)
  self.assertEqual([kind for kind,_ in store.calls],['head','put','get','put','get','delete','head'])
  self.assertEqual(store.calls[1][1]['Key'],store.calls[3][1]['Key']);self.assertNotEqual(store.calls[1][1]['Body'],store.calls[3][1]['Body'])
  self.assertTrue(all(body.closed for body in store.bodies))
 def test_ignored_conditional_and_other_rejections_cannot_qualify(self):
  for mode in ('ignore','denied','conflict','timeout','changed','oversize','length'):
   with self.subTest(mode=mode):
    store=Store(mode)
    with self.assertRaises(m.ProbeRefused):m.probe(store)
    self.assertFalse(store.objects);self.assertTrue(all(body.closed for body in store.bodies))
 def test_ambiguous_initial_write_still_cleans_only_generated_object(self):
  store=Store('first_timeout');store.objects['backups/do-not-touch']=b'historical'
  with self.assertRaises(m.ProbeRefused):m.probe(store)
  self.assertEqual(store.objects,{'backups/do-not-touch':b'historical'})
 def test_absence_must_be_404_before_any_write(self):
  store=Store('head403')
  with self.assertRaises(m.ProbeRefused):m.probe(store)
  self.assertEqual([kind for kind,_ in store.calls],['head'])
 def test_cleanup_failure_refuses_success_receipt(self):
  store=Store('cleanup')
  with self.assertRaisesRegex(m.ProbeRefused,'cleanup'):m.probe(store)
  self.assertEqual(store.puts,2)
 def test_root_entry_binds_timeouts_retries_and_restores_deadline(self):
  import contextlib
  from unittest.mock import patch
  options=[];timers=[];handlers=[];client=Store()
  def config(**kw):options.append(kw);return kw
  def factory(**kw):self.assertEqual(kw,{'config':options[-1]});return client
  with patch.dict(sys.modules,{'botocore':SimpleNamespace(),'botocore.config':SimpleNamespace(Config=config)}),patch.object(m.os,'geteuid',return_value=0),patch.object(m.socket,'gethostname',return_value='uain-app-1'),patch.object(m.signal,'getitimer',return_value=(0.0,0.0)),patch.object(m.signal,'signal',side_effect=lambda *args:handlers.append(args) or 'previous'),patch.object(m.signal,'setitimer',side_effect=lambda *args:timers.append(args)),contextlib.redirect_stdout(io.StringIO()):
   self.assertTrue(m.run(SimpleNamespace(s3=factory))['current_probe_object_deleted'])
  self.assertEqual(options,[{'connect_timeout':5,'read_timeout':10,'retries':{'total_max_attempts':1}}]);self.assertEqual(timers,[(m.signal.ITIMER_REAL,90),(m.signal.ITIMER_REAL,0)]);self.assertEqual(handlers[-1],(m.signal.SIGALRM,'previous'))
 def test_active_deadline_refused_before_client_creation(self):
  from unittest.mock import patch
  with patch.object(m.os,'geteuid',return_value=0),patch.object(m.socket,'gethostname',return_value='uain-app-1'),patch.object(m.signal,'getitimer',return_value=(30.0,0.0)):
   with self.assertRaises(m.ProbeRefused):m.run(SimpleNamespace(s3=lambda **kw:self.fail('No client may be created')))
 def test_wrong_endpoint_refused_before_requests(self):
  store=Store();store.meta.endpoint_url='https://unreviewed.invalid'
  with self.assertRaises(m.ProbeRefused):m.probe(store)
  self.assertFalse(store.calls)
if __name__=='__main__':unittest.main()

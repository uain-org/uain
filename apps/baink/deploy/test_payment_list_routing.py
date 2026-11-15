"""Guarded fixtures and real isolated Nginx HTTP: no production writes/reloads."""
import importlib.util,unittest,tempfile,subprocess,shutil,json,os,threading,time,http.client,socket,contextlib,io
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('payment_list_routing',Path(__file__).with_name('fix-payment-list-routing.py'))
try:m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
except FileNotFoundError:m=None
fixture_spec=importlib.util.spec_from_file_location('nginx_fixture_isolation',Path(__file__).with_name('nginx-fixture-isolation.py'))
fixture=importlib.util.module_from_spec(fixture_spec);fixture_spec.loader.exec_module(fixture)
PRIMARY=b'server {\n    location ^~ /api/native/payments/ {\n        client_max_body_size 16k;\n        proxy_pass http://127.0.0.1:8798;\n    }\n    location ^~ /api/ { return 418; }\n}\n'
PREVIEW=PRIMARY.replace(b'/api/',b'/baink/api/')
class PaymentListRouting(unittest.TestCase):
 def test_exact_list_proxy_insertion_preserves_other_bytes_and_bounds(self):
  self.assertIsNotNone(m,'payment-list routing repair missing')
  for old,preview in [(PRIMARY,False),(PREVIEW,True)]:
   new=m.transform(old,preview);prefix=b'/baink' if preview else b'';marker=b'    location ^~ '+prefix+b'/api/native/payments/ {';added=m.exact_block('/baink' if preview else '')
   self.assertEqual(new.replace(added,b'',1),old);self.assertIn(b'location = '+prefix+b'/api/native/payments {',added);self.assertLess(new.index(added),new.index(marker));self.assertEqual(added.count(b'client_max_body_size 16k;'),1);self.assertEqual(added.count(b'limit_req zone=baink_api burst=30 nodelay;'),1);self.assertIn(b'proxy_read_timeout 150s;',added)
   self.assertEqual(added.count(b'rewrite ^/baink(/api/.*)$ $1 break;'),int(preview))
 def test_duplicate_or_absent_marker_refused(self):
  self.assertIsNotNone(m)
  for old in [b'',PRIMARY+PRIMARY,m.transform(PRIMARY)]:
   with self.assertRaises(ValueError):m.transform(old)
 def test_guards_fail_before_mutation(self):
  self.assertIsNotNone(m)
  for args in [[],['wrong',m.PRIMARY_SHA,m.PREVIEW_SHA],[m.EXPECTED_RELEASE,'0'*64,m.PREVIEW_SHA]]:
   with patch.object(m,'replace_config',side_effect=AssertionError('mutation')):
    with self.assertRaises(ValueError):m.main(args)
 def test_reload_failure_restores_owned_bytes_and_retains_both_backups(self):
  self.assertIsNotNone(m)
  if os.geteuid()!=0:self.skipTest('root-only isolated file fixture')
  with tempfile.TemporaryDirectory(dir=Path.home()) as name:
   root=Path(name);configs=root/'configs';configs.mkdir();releases=root/'releases';releases.mkdir();target=releases/m.EXPECTED_RELEASE;target.mkdir();current=root/'current';current.symlink_to(target);backups=root/'backups';backups.mkdir();paths=[configs/'baink.money.conf',configs/'aidollar.money.conf']
   for p,b in zip(paths,[PRIMARY,PREVIEW]):p.write_bytes(b)
   with contextlib.ExitStack() as stack:
    for key,value in [('CONFIG_ROOT',configs),('RELEASE_ROOT',releases),('CURRENT',current),('LOCK_PATH',root/'lock'),('BACKUP_ROOT',backups),('PRIMARY_SHA',m.digest(PRIMARY)),('PREVIEW_SHA',m.digest(PREVIEW))]:stack.enter_context(patch.object(m,key,value))
    reload=stack.enter_context(patch.object(m,'test_and_reload',side_effect=[RuntimeError('fixture parser refused'),None]))
    with self.assertRaisesRegex(RuntimeError,'fixture parser refused'):m.main([m.EXPECTED_RELEASE,m.PRIMARY_SHA,m.PREVIEW_SHA])
    self.assertEqual(reload.call_count,2)
   self.assertEqual([p.read_bytes() for p in paths],[PRIMARY,PREVIEW]);self.assertEqual([(backups/m.EXPECTED_RELEASE/'payment-list-routing'/p.name).read_bytes() for p in paths],[PRIMARY,PREVIEW])
 def test_real_nginx_wire_primary_and_preview_no_redirect_auth_401(self):
  self.assertIsNotNone(m)
  nginx=shutil.which('nginx')
  if not nginx:self.skipTest('server actual Nginx binary required')
  global_paths=fixture.snapshot_default_paths(nginx)
  observed=[]
  class Auth(BaseHTTPRequestHandler):
   def do_GET(self):
    observed.append(self.path);body=b'{"error":"authentication_required"}';self.send_response(401);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
   def log_message(self,*args):pass
  upstream=ThreadingHTTPServer(('127.0.0.1',0),Auth);thread=threading.Thread(target=upstream.serve_forever,daemon=True);thread.start()
  try:
   results=[]
   for repaired in [False,True]:
    with tempfile.TemporaryDirectory() as name:
     root=Path(name).resolve();sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close();servers=[]
     for old,preview in [(PRIMARY,False),(PREVIEW,True)]:
      text=m.transform(old,preview) if repaired else old;text=text.replace(b'127.0.0.1:8798',('127.0.0.1:'+str(upstream.server_port)).encode());servers.append(text)
     # A single isolated server exercises both independent prefix locations.
     locations=servers[0].split(b'server {\n',1)[1].rsplit(b'}',1)[0]+servers[1].split(b'server {\n',1)[1].rsplit(b'}',1)[0]
     config=root/'nginx.conf';config.write_bytes(('daemon off; master_process off; pid '+str(root/'nginx.pid')+'; error_log '+str(root/'error.log')+'; events { worker_connections 64; } http { access_log off;\n').encode()+fixture.temp_directives(root)+('limit_req_zone $binary_remote_addr zone=baink_api:1m rate=100r/s; server { listen 127.0.0.1:'+str(port)+';\n').encode()+locations+b'} }\n')
     syntax=fixture.syntax_check(nginx,config,root);self.assertEqual(syntax.returncode,0,syntax.stderr.decode())
     process=fixture.start(nginx,config,root)
     try:
      for attempt in range(100):
       try:
        s=socket.create_connection(('127.0.0.1',port),timeout=.2);s.close();break
       except OSError:time.sleep(.02)
      for path in ['/api/native/payments','/baink/api/native/payments']:
       conn=http.client.HTTPConnection('127.0.0.1',port,timeout=3);conn.request('GET',path);response=conn.getresponse();body=response.read();results.append({'repaired':repaired,'path':path,'status':response.status,'location':response.getheader('Location')});self.assertEqual(response.status,401 if repaired else 301,body);self.assertEqual(response.getheader('Location') is None,repaired);conn.close()
       if repaired:
        bounded=http.client.HTTPConnection('127.0.0.1',port,timeout=3);bounded.request('GET',path,body=b'x'*16385);reply=bounded.getresponse();reply.read();self.assertEqual(reply.status,413,'exact route retains16KiB body bound');bounded.close()
     finally:process.terminate();process.communicate(timeout=10)
   self.assertEqual(observed,['/api/native/payments','/api/native/payments']);print('WIRE_RECEIPT '+json.dumps({'requests':results,'upstreamCanonicalPaths':observed,'financialWrites':0}))
  finally:
   upstream.shutdown();upstream.server_close();thread.join(timeout=3)
   self.assertEqual(fixture.snapshot_default_paths(nginx),global_paths,'compiled global temp metadata must remain unchanged')
if __name__=='__main__':unittest.main()

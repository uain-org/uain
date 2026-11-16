"""Fixed read-only SSH feedback action: no private service, signing or broadcasts."""
import copy,json,unittest,stat,struct,types
from unittest.mock import Mock,patch
import public_review_dispatch as d
import central_reviewer_server as server
import test_central_review_feedback as fixture
class DispatchTests(unittest.TestCase):
 def packet(self):
  p,state,decision,journal,runtime,reader,body=fixture.FeedbackTests().fixture();return server.feedback_projection(p,body,runtime,reader),body
 def invoke(self,body,packet):
  raw=json.dumps(body).encode();job=d.feedback_job_id(body);read=Mock(return_value=json.dumps(packet).encode());private=Mock(side_effect=AssertionError('private economic service must not execute'));value=d.dispatch('baink-private-review central-feedback '+job,raw,invoke=private,feedback=read);private.assert_not_called();return json.loads(value),read
 def test_exact_readonly_action_binds_request_and_accepts_only_committed_public_packet(self):
  packet,body=self.packet();value,read=self.invoke(body,packet);self.assertEqual(value,packet);read.assert_called_once_with(body)
 def test_lookup_null_has_distinct_jobid_but_response_actual_execution(self):
  packet,body=self.packet();lookup={**body,'executionId':None};self.assertNotEqual(d.feedback_job_id(body),d.feedback_job_id(lookup));value,read=self.invoke(lookup,packet);self.assertEqual(value['executionId'],body['executionId']);read.assert_called_once_with(lookup)
 def test_path_unknown_fields_duplicate_or_wrong_jobid_refuse_before_socket(self):
  packet,body=self.packet()
  for raw in [b'{"submission":"../private","executionId":"R"}',b'{"submission":"S","executionId":"R","path":"/keys"}',b'{"submission":"S","submission":"S","executionId":"R"}']:
   read=Mock()
   with self.assertRaises(ValueError):d.dispatch('baink-private-review central-feedback '+'a'*32,raw,feedback=read)
   read.assert_not_called()
  read=Mock()
  with self.assertRaises(ValueError):d.dispatch('baink-private-review central-feedback '+'a'*32,json.dumps(body).encode(),feedback=read)
  read.assert_not_called()
 def test_unknown_private_fields_uncommitted_findings_or_network_refused(self):
  for mutate in [lambda p:p['decision'].update(private_prompt='not public'),lambda p:p['decision'].update(findings=['uncommitted']),lambda p:p.update(chainId='foreign'),lambda p:p['native'].update(verifierSha256='f'*64),lambda p:p['nativeReview'].update(verdict='reject')]:
   packet,body=self.packet();mutate(packet)
   with self.assertRaises(ValueError):self.invoke(body,packet)
class SocketTests(unittest.TestCase):
 def test_fixed_root_peer_socket_only_and_no_economic_client(self):
  for uid in (0,1001):
   sock=Mock();sock.getsockopt.return_value=struct.pack('3i',1,uid,1);counts={'response':0};path=types.SimpleNamespace(parents=[types.SimpleNamespace(lstat=lambda:types.SimpleNamespace(st_mode=stat.S_IFDIR|0o750,st_uid=0))],lstat=lambda:types.SimpleNamespace(st_mode=stat.S_IFSOCK|0o660,st_uid=0,st_nlink=1));path.__str__=lambda:'/fixed'
   class HTTP:
    def __init__(self,*a,**k):pass
    def request(self,method,url,**kwargs):
     self_outer.assertEqual((method,url),('POST','/feedback'));self.connect()
    def getresponse(self):counts['response']+=1;return types.SimpleNamespace(status=200,read=lambda limit:b'{}')
    def close(self):sock.close()
   self_outer=self
   with patch.object(d,'FEEDBACK_SOCKET',path),patch.object(d.socket,'socket',return_value=sock),patch.object(d.socket,'SO_PEERCRED',getattr(d.socket,'SO_PEERCRED',17),create=True),patch.object(d.http.client,'HTTPConnection',HTTP):
    if uid==0:self.assertEqual(d.feedback_http({'submission':'S','executionId':'R'}),b'{}')
    else:
     with self.assertRaises(ValueError):d.feedback_http({'submission':'S','executionId':'R'})
   self.assertEqual(counts['response'],1 if uid==0 else 0);sock.close.assert_called_once()
if __name__=='__main__':unittest.main()

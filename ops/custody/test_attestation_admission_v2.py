"""No sockets, root files, vault, network or native writes: V2 admission gates."""
import io,json,struct,types,unittest
from unittest.mock import Mock,patch
import central_reviewer_server as server
import survey_attester as attester
import fleet_attestation as fa

class LoadedAdmissionTests(unittest.TestCase):
 def fixture(self):
  rule=dict(policy_path='/FICTIONAL/task.json',policy_digest='a'*64,criteria_digest='b'*64,attestation_public_key='AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',environment='production')
  profile={'schema':'uain-central-reviewer-server-v1','chain_id':fa.V2_NETWORK['chainId'],'genesis_sha256':fa.V2_NETWORK['genesisSha256'],'fleet_attestations':{'T-fixture':rule}}
  pins={'schema':'uain-central-reviewer-sources-v1','sha256':{n+'.py':'c'*64 for n in server.SOURCE_NAMES}}
  return profile,pins
 def test_explicit_profile_version_rules_and_loaded_summary(self):
  p,pins=self.fixture();server.validate_fleet_rules(p['fleet_attestations'])
  result=server.loaded_attestation_admission(p,{'task':'T-fixture'},pins)
  self.assertEqual(result['allowedVersions'],[1]);self.assertEqual(result['profileDigest'],fa.js_digest(p));self.assertEqual(result['sourcePinsDigest'],fa.js_digest(pins))
  p['fleet_attestations']['T-fixture']['allowedVersions']=[1,2]
  server.validate_fleet_rules(p['fleet_attestations'])
  self.assertEqual(server.loaded_attestation_admission(p,{'task':'T-fixture'},pins)['allowedVersions'],[1,2])
  for invalid in ([],[True],[2,2],[3],['2']):
   p['fleet_attestations']['T-fixture']['allowedVersions']=invalid
   with self.assertRaises(ValueError):server.validate_fleet_rules(p['fleet_attestations'])
 def handler(self,uid,path):
  p,pins=self.fixture();h=object.__new__(server.Handler);h.path=path
  h.connection=Mock();h.connection.getsockopt.return_value=struct.pack('3i',1,uid,1)
  raw=json.dumps({'task':'T-fixture'}).encode();h.rfile=io.BytesIO(raw);h.wfile=io.BytesIO();h.headers={'Content-Type':'application/json','Content-Length':str(len(raw))};h.send_response=Mock();h.send_header=Mock();h.end_headers=Mock()
  h.server=types.SimpleNamespace(peer_uid=1001,engine_factory=Mock(),loaded_admission=lambda body:server.loaded_attestation_admission(p,body,pins))
  return h
 def test_metadata_route_is_root_only_without_engine_or_native_constructor(self):
  h=self.handler(0,'/attestation-admission')
  with patch.object(server.socket,'SO_PEERCRED',getattr(server.socket,'SO_PEERCRED',17),create=True):h.do_POST()
  h.send_response.assert_called_once_with(200);h.server.engine_factory.assert_not_called()
  for uid,path in [(1001,'/attestation-admission'),(0,'/review'),(0,'/receipt'),(0,'/readiness')]:
   h=self.handler(uid,path)
   with patch.object(server.socket,'SO_PEERCRED',getattr(server.socket,'SO_PEERCRED',17),create=True):h.do_POST()
   h.send_response.assert_called_once_with(409);h.server.engine_factory.assert_not_called()

class ProducerAdmissionTests(unittest.TestCase):
 def fixture(self):
  task='T-fixture';policy={'taskId':task,'criteriaDigest':'a'*64};profile,pins=LoadedAdmissionTests().fixture();rule=profile['fleet_attestations'][task];rule['allowedVersions']=[1,2];rule['criteria_digest']=policy['criteriaDigest'];policy['class']='prior_art_survey'
  selection={'schema':'uain-survey-attester-versions-v1','tasks':{task:dict(version=2,policyDigest=fa.js_digest(policy),criteriaDigest=policy['criteriaDigest'],reviewerSourcePinsDigest=fa.js_digest(pins))}}
  rule['policy_digest']=fa.js_digest(policy);summary=server.loaded_attestation_admission(profile,{'task':task},pins)
  return task,policy,profile,pins,selection,summary
 def test_legacy_default_and_explicit_v2_require_loaded_current_profile_and_sources(self):
  task,policy,profile,pins,selection,summary=self.fixture()
  with patch.object(attester,'_protected',side_effect=FileNotFoundError):self.assertEqual(attester.version_admission(task,policy)['version'],1)
  data={attester.VERSION_SELECTION:json.dumps(selection).encode(),attester.REVIEWER_PROFILE:json.dumps(profile).encode(),attester.REVIEWER_SOURCES:json.dumps(pins).encode()}
  with patch.object(attester,'_protected',side_effect=lambda path,*_:data[path]),patch.object(attester,'reviewer_admission',return_value=summary):
   self.assertEqual(attester.version_admission(task,policy)['version'],2)
   for field in ('profileDigest','sourcePinsDigest'):
    wrong={**summary,field:'f'*64}
    with patch.object(attester,'reviewer_admission',return_value=wrong),self.assertRaises(ValueError):attester.version_admission(task,policy)
   with patch.object(attester,'reviewer_admission',return_value={**summary,'allowedVersions':[1]}),self.assertRaises(ValueError):attester.version_admission(task,policy)

if __name__=='__main__':unittest.main()

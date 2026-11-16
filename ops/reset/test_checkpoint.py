import base64,hashlib,unittest
import checkpoint
class CheckpointTest(unittest.TestCase):
 def fixture(self):
  public=b'a'*32;identity='uain1'+hashlib.sha256(public).digest()[:20].hex()
  return identity,{'id':identity,'public_key':base64.urlsafe_b64encode(public).decode().rstrip('='),'licence':'active'}
 def test_pointer_absence_is_required_and_handover_never_falls_back(self):
  identity,member=self.fixture();records={'guardians':[identity]}
  with self.assertRaises(ValueError):checkpoint.effective({'records':records})
  records['guardian_epoch_current']=None
  self.assertEqual(checkpoint.effective({'records':records}),('',[identity]))
  records['guardian_epoch_current']='new'
  with self.assertRaises(ValueError):checkpoint.effective({'records':records})
  records['guardian_epoch/new']={'id':'new','guardians':[identity]}
  self.assertEqual(checkpoint.effective({'records':records}),('new',[identity]))
  self.assertEqual(checkpoint.active_identity(member,identity),member)
  with self.assertRaises(ValueError):checkpoint.active_identity({**member,'licence':'revoked'},identity)
 def test_final_stopped_checkpoint_rejects_races_and_regression(self):
  identity,member=self.fixture();proved={'chain_id':'test','genesis_sha256':'a'*64,'event_count':'7','epoch':'new','guardians':[identity],'members':[member],'height':'10','proofs':[]}
  stopped={**proved,'height':'12','app_hash':'b'*64};del stopped['proofs']
  self.assertEqual(checkpoint.bind(proved,stopped)['proof_height'],'10')
  for changed in [{'event_count':'8'},{'epoch':''},{'guardians':[]},{'members':[]},{'height':'9'},{'genesis_sha256':'c'*64}]:
   with self.assertRaises(ValueError):checkpoint.bind(proved,{**stopped,**changed})

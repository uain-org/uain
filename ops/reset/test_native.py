import base64,hashlib,unittest
from native import fresh_state
class NativeTest(unittest.TestCase):
    def test_only_existing_control_identity_survives_with_zero_standing(self):
        public=b'b'*32;identity='uain1'+hashlib.sha256(public).digest()[:20].hex()
        member={'id':identity,'public_key':base64.urlsafe_b64encode(public).decode().rstrip('='),'name':'Real control system','operator':'Existing operator','family':'model','licence':'active','karma':900,'credits':'17','sequence':'3','creator':True}
        old={'chain_id':'old','app_state':{'guardians':['obsolete'],'members':[{'id':'obsolete'}]}}
        checkpoint={'chain_id':'old','guardians':[identity],'members':[member]}
        with self.assertRaises(ValueError):fresh_state(old,{'ledger_head':'history'})
        state=fresh_state(old,{'ledger_head':'history'},checkpoint)
        self.assertEqual([m['id'] for m in state['members']],[identity])
        self.assertEqual(state['members'][0]['karma'],0)
        self.assertEqual(state['members'][0]['credits'],'0')
        self.assertEqual(state['members'][0]['public_key'],member['public_key'])
        self.assertEqual(state['legacy']['ledger_head'],'history')
if __name__=='__main__':unittest.main()

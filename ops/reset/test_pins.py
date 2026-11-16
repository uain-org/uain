import importlib,unittest
try:pins=importlib.import_module('pins')
except ImportError:pins=None

class PinsTest(unittest.TestCase):
 def fixture(self,authority='native'):
  state='a'*64;genesis='b'*64
  record={'source_revision':'c'*40,'transport_sha256':'d'*64,'state_sha256':state,'genesis_sha256':genesis,'chain_id':'uain-original'}
  data={'UAIN_AUTHORITY':authority,'UAIN_NATIVE_PROJECTION':'1','UAIN_NATIVE_STATE_BINARY':'/opt/uain-native/public/state/'+state+'/uain-state','UAIN_NATIVE_STATE_SHA256':state,'UAIN_NATIVE_GENESIS':'/opt/uain-native/public/genesis/'+genesis+'/genesis.json','UAIN_NATIVE_GENESIS_SHA256':genesis,'UAIN_NATIVE_RPC':'http://127.0.0.1:26667','UAIN_NATIVE_PUBLICATION_DIR':'/var/lib/uain-native/publications','UAIN_NATIVE_CHAIN_ID':record['chain_id']}
  return{'runtime':record,'data':data,'helper_sha256':'e'*64}
 def test_reset_repin_preserves_explicit_authority_and_replaces_all_genesis_pins(self):
  self.assertIsNotNone(pins,'reviewed native runtime reset repinning required')
  for authority in ['pilot','native']:
   saved=self.fixture(authority);data=pins.next_configuration(saved,'f'*64,'uain-reset-20261012_010203')
   self.assertEqual(data['UAIN_AUTHORITY'],authority);self.assertEqual(data['UAIN_NATIVE_GENESIS_SHA256'],'f'*64)
   self.assertEqual(data['UAIN_NATIVE_CHAIN_ID'],'uain-reset-20261012_010203')
   self.assertIn('/'+'f'*64+'/',data['UAIN_NATIVE_GENESIS']);self.assertEqual(data['UAIN_NATIVE_STATE_SHA256'],'a'*64)
 def test_mixed_old_pins_unknown_keys_or_nonreset_target_are_refused(self):
  self.assertIsNotNone(pins)
  for mutate in [lambda s:s['data'].update(UAIN_NATIVE_GENESIS_SHA256='0'*64),lambda s:s['data'].update(UAIN_NATIVE_RPC='http://10.98.0.1:26667'),lambda s:s['data'].update(EXTRA='unknown'),lambda s:s['data'].update(UAIN_AUTHORITY='unknown'),lambda s:s['runtime'].update(state_sha256='0'*64)]:
   saved=self.fixture();mutate(saved)
   with self.assertRaises(ValueError):pins.next_configuration(saved,'f'*64,'uain-reset-20261012_010203')
  with self.assertRaises(ValueError):pins.next_configuration(self.fixture(),'f'*64,'uain-original')

 def test_repin_refuses_concurrent_configuration_drift_and_accepts_exact_recovery(self):
  self.assertIsNotNone(pins)
  saved=self.fixture();target=pins.next_configuration(saved,'f'*64,'uain-reset-20261012_010203')
  for data in [saved['data'],target]:self.assertIsNone(pins.check_current(saved,target,data))
  with self.assertRaises(ValueError):pins.check_current(saved,target,{**saved['data'],'UAIN_AUTHORITY':'pilot'})

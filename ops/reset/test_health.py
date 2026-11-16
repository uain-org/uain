import hashlib,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import health,stack
class HealthTest(unittest.TestCase):
 def test_recovered_sorted_journal_retains_the_approved_exact_genesis_bytes(self):
  with tempfile.TemporaryDirectory() as temporary:
   home=Path(temporary);(home/'config').mkdir();raw=b'{"z":"original public ordering", "a":1}\n';(home/'config/genesis.json').write_bytes(raw);pin=hashlib.sha256(raw).hexdigest()
   recovered=json.loads(json.dumps(json.loads(raw),sort_keys=True));node={'home':str(home),'genesis_sha256':pin}
   with patch.object(stack,'node_inventory',return_value=node):
    self.assertEqual(health.reviewed_genesis(recovered,pin),raw)
    for bad in ['0'*64,None]:
     with self.assertRaises(ValueError):health.reviewed_genesis(recovered,bad)
    with self.assertRaises(ValueError):health.reviewed_genesis({**recovered,'a':2},pin)

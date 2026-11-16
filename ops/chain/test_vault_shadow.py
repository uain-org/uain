"""Fictional files only. Never load production custody or private keys."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from vault_shadow import collect, FILES


class ChainCustodyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        for name in FILES:
            path = self.home / name
            path.parent.mkdir(exist_ok=True)
            path.write_text('{}')
        public = {'type': 'fictional-test', 'value': 'fictional-public-key'}
        self.genesis = json.dumps({'chain_id': 'fictional-chain', 'validators': [{'pub_key': public}]}).encode()
        (self.home / 'config/genesis.json').write_bytes(self.genesis)
        (self.home / 'config/priv_validator_key.json').write_text(json.dumps({'pub_key': public}))
        (self.home / 'data/priv_validator_state.json').write_text('{"height":"42"}')
        self.sha = hashlib.sha256(self.genesis).hexdigest()

    def tearDown(self):
        self.temp.cleanup()

    def test_capture_is_named_and_recovery_is_explicitly_fenced(self):
        files, metadata = collect(self.home, self.sha)
        self.assertEqual(len(files), 6)
        self.assertEqual(metadata['historical_signing_height'], 42)
        self.assertTrue(metadata['never_roll_back_signing_state'])
        self.assertTrue(all(name.startswith('chain/fictional-chain/') for name in files))

    def test_changed_genesis_and_validator_are_rejected(self):
        with self.assertRaises(RuntimeError):
            collect(self.home, '0' * 64)
        (self.home / 'config/priv_validator_key.json').write_text('{"pub_key":{}}')
        with self.assertRaises(RuntimeError):
            collect(self.home, self.sha)

    def test_symlink_and_oversized_input_are_rejected(self):
        path = self.home / 'config/node_key.json'
        path.unlink()
        path.symlink_to(self.home / 'config/genesis.json')
        with self.assertRaises(RuntimeError):
            collect(self.home, self.sha)
        path.unlink()
        path.write_bytes(b'x' * (512 * 1024 + 1))
        with self.assertRaises(RuntimeError):
            collect(self.home, self.sha)


if __name__ == '__main__':
    unittest.main()

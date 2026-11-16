"""Custody failure/retry tests with fictional keys and no production access."""
import contextlib
import io
import json
import unittest
from unittest.mock import patch
from pathlib import Path

import custody
import mainnet_wallets
import test_custody


class WalletCryptographyTests(unittest.TestCase):
    @unittest.skipUnless(Path(custody.NODE_DIR + '/node').exists(), 'Needs server Node runtime')
    def test_real_key_roundtrip_and_corrupt_solana_key_rejection(self):
        generated = mainnet_wallets.key_operation(custody, 'generate')
        self.assertEqual(mainnet_wallets.key_operation(custody, 'verify', generated['keys']),
                         generated['addresses'])
        self.assertNotEqual(generated['addresses']['owner'], generated['addresses']['anchorer'])
        generated['keys']['solana'][63] ^= 1
        with self.assertRaises(custody.CustodyError):
            mainnet_wallets.key_operation(custody, 'verify', generated['keys'])


class MainnetWalletTests(unittest.TestCase):
    # Reuse the encrypted fictional-vault setup, not the parent test cases.
    make_vault = test_custody.CustodyTests.make_vault
    tearDown = test_custody.CustodyTests.tearDown

    def setUp(self):
        test_custody.CustodyTests.setUp(self)
        self.make_vault()
        self.generated = {'keys': {'owner': 'fictional-owner-secret',
                                   'anchorer': 'fictional-anchorer-secret', 'solana': [1] * 64},
                          'addresses': {'owner': 'fictional-owner-public',
                                        'anchorer': 'fictional-anchorer-public', 'solana': 'fictional-sol-public'}}
        self.calls = []

    def operation(self, module, command, keys=None):
        self.calls.append(command)
        if command == 'generate':
            return self.generated
        self.assertEqual(keys, self.generated['keys'])
        return self.generated['addresses']

    def run_provision(self, backup=None):
        output = io.StringIO()
        with patch.object(mainnet_wallets, 'key_operation', self.operation), \
             patch.object(custody, 'backup', backup or (lambda: None)), \
             contextlib.redirect_stdout(output):
            result = mainnet_wallets.provision(custody)
        for secret in ['fictional-owner-secret', 'fictional-anchorer-secret']:
            self.assertNotIn(secret, output.getvalue())
        return result

    def test_creation_preserves_every_existing_attachment_and_retries_same_wallets(self):
        first = self.run_provision()
        kp = custody.vault()
        for name, data in self.files.items():
            self.assertEqual(custody.attachment(kp, name), data)
        self.assertEqual(custody.verify_vault(kp), len(self.files) + 4)
        self.assertTrue(first['created'])
        self.assertFalse(self.run_provision()['created'])
        self.assertEqual(self.calls.count('generate'), 1)

    def test_backup_failure_does_not_publish_addresses_and_retry_keeps_keys(self):
        output = io.StringIO()
        def fail():
            raise custody.CustodyError('Fictional backup failure')
        with contextlib.redirect_stdout(output), self.assertRaises(custody.CustodyError):
            self.run_provision(fail)
        self.assertNotIn('fictional-owner-public', output.getvalue())
        self.assertFalse(self.run_provision()['created'])
        self.assertEqual(self.calls.count('generate'), 1)

    def test_partial_wallet_set_refuses_replacement(self):
        files = {**self.files, mainnet_wallets.NAMES['owner']: b'fictional-owner-secret'}
        with contextlib.redirect_stdout(io.StringIO()):
            custody.save_vault(files)
        with self.assertRaises(custody.CustodyError):
            self.run_provision()
        self.assertEqual(self.calls, [])

    def test_mismatched_pin_refuses_backup(self):
        self.run_provision()
        kp = custody.vault()
        files = {item['name']: custody.attachment(kp, item['name']) for item in custody.records(kp)}
        public = json.loads(files[mainnet_wallets.PUBLIC])
        public['addresses']['owner'] = 'different-public-address'
        files[mainnet_wallets.PUBLIC] = json.dumps(public).encode()
        with contextlib.redirect_stdout(io.StringIO()):
            custody.save_vault(files)
        backup_calls = []
        with self.assertRaises(custody.CustodyError):
            self.run_provision(lambda: backup_calls.append(True))
        self.assertEqual(backup_calls, [])


if __name__ == '__main__':
    unittest.main()

"""Adversarial checks with fictional data; never open the production vault."""
import contextlib
import io
import json
import os
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import custody
import receive


class CustodyTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.patches = [patch.object(custody, 'ROOT', self.root),
                        patch.object(custody, 'VAULT', self.root / 'test.kdbx'),
                        patch.object(custody, 'password', lambda: 'fictional-test-password')]
        for item in self.patches:
            item.start()
        self.files = {name: b'fictional-test-data' for name in [
            'keys/backup-key.txt', 'keys/base-sepolia-owner.key',
            'keys/base-sepolia-anchorer.key', 'keys/solana-devnet-mirror.json']}
        self.files['keys/release-key.json'] = json.dumps({
            'public_key': 'XlRwnWHiN9FuiXUD8Q2gwSlEKLNhetU42uRKQbRuAZs',
            'private_key': 'fictional-not-a-key'}).encode()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.directory.cleanup()

    def make_vault(self):
        with contextlib.redirect_stdout(io.StringIO()):
            custody.save_vault(self.files)
        return custody.vault()

    def package(self, vault_bytes):
        contents = {'uain.kdbx': vault_bytes, 'operations.json': b'{}',
                    'solana.json': b'{}', 'ledger-public.pem': b'fictional-public-pin'}
        contents['manifest.json'] = json.dumps({'sha256': {
            n: custody.digest(b) for n, b in contents.items()}}).encode()
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w') as output:
            for name, data in contents.items():
                member = tarfile.TarInfo(name)
                member.size = len(data)
                output.addfile(member, io.BytesIO(data))
        return stream.getvalue()

    def test_ciphertext_roundtrip_checks_every_attachment(self):
        kp = self.make_vault()
        data = custody.VAULT.read_bytes()
        self.assertNotIn(b'fictional-test-data', data)
        self.assertEqual(custody.verify_vault(kp), len(self.files))
        custody.check_package(self.package(data), kp)

    def test_changed_attachment_is_rejected(self):
        kp = self.make_vault()
        entry = kp.find_entries(title='keys/backup-key.txt', first=True)
        entry.delete_attachment(entry.attachments[0])
        entry.add_attachment(kp.add_binary(b'changed'), 'backup-key.txt')
        with self.assertRaises(custody.CustodyError):
            custody.verify_vault(kp)

    def test_changed_ciphertext_is_rejected_even_with_new_outer_checksum(self):
        kp = self.make_vault()
        data = bytearray(custody.VAULT.read_bytes())
        data[-50] ^= 1
        with self.assertRaises(Exception):
            custody.check_package(self.package(bytes(data)), kp)

    def test_wrong_password_is_rejected(self):
        self.make_vault()
        with patch.object(custody, 'password', lambda: 'wrong-password'):
            with self.assertRaises(Exception):
                custody.vault()

    def test_plaintext_archive_traversal_is_rejected_before_capture(self):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w') as output:
            member = tarfile.TarInfo('../escape')
            member.size = 3
            output.addfile(member, io.BytesIO(b'bad'))
        with patch.object(custody.sys, 'stdin', io.TextIOWrapper(io.BytesIO(stream.getvalue()))):
            with self.assertRaises(custody.CustodyError):
                custody.import_vault()
        self.assertFalse(custody.VAULT.exists())

    def test_missing_required_release_key_does_not_publish_vault(self):
        del self.files['keys/release-key.json']
        with self.assertRaises(custody.CustodyError):
            custody.save_vault(self.files)
        self.assertFalse(custody.VAULT.exists())

    def receiver(self, command, data):
        with patch.object(receive, 'ROOT', self.root), \
             patch.dict(os.environ, {'SSH_ORIGINAL_COMMAND': command}), \
             patch.object(receive.sys, 'stdin', io.TextIOWrapper(io.BytesIO(data))), \
             contextlib.redirect_stdout(io.StringIO()):
            receive.main()

    def test_backup_receiver_is_immutable_but_same_bytes_can_retry(self):
        name = 'uain-custody-20261005T000000Z.tar'
        self.receiver('put ' + name, b'ciphertext')
        self.receiver('put ' + name, b'ciphertext')
        with self.assertRaises(ValueError):
            self.receiver('put ' + name, b'different')
        self.assertEqual((self.root / name).read_bytes(), b'ciphertext')

    def test_backup_receiver_cannot_run_commands_or_escape_directory(self):
        for command in ['cat /etc/uain-custody/vault-password', 'put ../escape.tar',
                        'put uain-custody-20261005T000000Z.tar; id', 'bash']:
            with self.subTest(command=command), self.assertRaises(ValueError):
                self.receiver(command, b'bad')


if __name__ == '__main__':
    unittest.main()

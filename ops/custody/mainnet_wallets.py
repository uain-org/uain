#!/usr/bin/env python3
"""Provision separate mainnet wallets in existing encrypted server custody.

Run as root under /run/lock/uain-custody.lock. Keys stay in server memory and
the encrypted vault. Public addresses are returned only after backup readback.
Retry reuses the same keys; partial custody or mismatched public pins fails.
No chain transactions, deployment or production configuration changes occur.
"""
import datetime
import importlib.util
import json
import os
import subprocess
from pathlib import Path

NAMES = {'owner': 'keys/base-mainnet-owner.key',
         'anchorer': 'keys/base-mainnet-anchorer.key',
         'solana': 'keys/solana-mainnet-mirror.json'}
PUBLIC = 'wallets/mainnet-public.json'
HELPER = Path(__file__).with_name('mainnet-wallet-keys.mjs')


def key_operation(custody, command, keys=None):
    result = subprocess.run([custody.NODE_DIR + '/node', str(HELPER),
                             str(custody.SOURCE), command],
                            input=None if keys is None else json.dumps(keys).encode(),
                            capture_output=True, timeout=30)
    if result.returncode != 0:
        raise custody.CustodyError('Mainnet wallet cryptographic verification failed')
    return json.loads(result.stdout)


def verify_keys(custody, files):
    keys = {role: (json.loads(files[name]) if role == 'solana' else files[name].decode().strip())
            for role, name in NAMES.items()}
    return key_operation(custody, 'verify', keys)


def provision(custody):
    kp = custody.vault()
    custody.verify_vault(kp)
    files = {item['name']: custody.attachment(kp, item['name']) for item in custody.records(kp)}
    present = [name in files for name in [*NAMES.values(), PUBLIC]]
    if any(present) and not all(present):
        raise custody.CustodyError('Incomplete mainnet wallet custody; refusing replacement keys')
    created = not any(present)
    if created:
        generated = key_operation(custody, 'generate')
        for role, name in NAMES.items():
            value = generated['keys'][role]
            files[name] = (json.dumps(value) if role == 'solana' else value).encode()
        addresses = verify_keys(custody, files)
        if addresses != generated['addresses']:
            raise custody.CustodyError('Generated mainnet public addresses differ')
        # These are gas wallets, not a public donation treasury or member keys.
        public = {'version': 1, 'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  'purpose': 'Mainnet deployment and ledger transaction gas only',
                  'base_chain_id': 8453, 'solana_cluster': 'mainnet-beta', 'addresses': addresses}
        files[PUBLIC] = (json.dumps(public, indent=2) + '\n').encode()
        custody.save_vault(files)
    # Reopen ciphertext and rederive/sign from recovered keys before backup.
    restored = custody.vault()
    custody.verify_vault(restored)
    recovered = {name: custody.attachment(restored, name) for name in [*NAMES.values(), PUBLIC]}
    public = json.loads(recovered[PUBLIC])
    if (public['version'] != 1 or public['base_chain_id'] != 8453 or
            public['solana_cluster'] != 'mainnet-beta' or
            verify_keys(custody, recovered) != public['addresses']):
        raise custody.CustodyError('Recovered mainnet wallet addresses differ from public pins')
    custody.backup()
    receipt = {'created': created, 'keys_recovered_and_signatures_verified': True,
               'backups_verified': True, **public}
    print(json.dumps(receipt))
    return receipt


def main():
    os.umask(0o077)
    if os.geteuid() != 0:
        raise RuntimeError('Root custody operation required')
    spec = importlib.util.spec_from_file_location('custody', '/opt/uain-custody/custody.py')
    custody = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(custody)
    provision(custody)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Never display decrypted data or library exception text.
        raise SystemExit('Mainnet wallet custody failed; no secret diagnostic emitted')

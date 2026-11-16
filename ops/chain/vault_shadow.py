#!/usr/bin/env python3
"""Capture the stopped shadow validator into existing encrypted custody.

Keys never leave the server or appear in diagnostics. This archives identity;
the captured signing-state height is historical and must never be rolled back
over current signing state. Full block/application backups are separate.
Invoke under the existing /run/lock/uain-custody.lock exclusive lock.
"""
import datetime
import hashlib
import importlib.util
import json
import os
import stat
import subprocess
from pathlib import Path

HOME = Path('/var/lib/uain-chain/shadow-20261008-1')
GENESIS_SHA = '54140a9243c4591ccc9f2e9d49543fc68b87b3e0045416174c232e9dd498f8ff'
FILES = ('config/genesis.json', 'config/config.toml', 'config/node_key.json',
         'config/priv_validator_key.json', 'data/priv_validator_state.json')


def collect(home, expected_genesis):
    captured = {}
    root = home.resolve(strict=True)
    for name in FILES:
        path = home / name
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or path.resolve(strict=True) != root / name or info.st_size > 512 * 1024:
            raise RuntimeError('Chain custody input is not a bounded regular file')
        captured[name] = path.read_bytes()
    if hashlib.sha256(captured['config/genesis.json']).hexdigest() != expected_genesis:
        raise RuntimeError('Chain custody genesis differs from pinned bootstrap')
    genesis = json.loads(captured['config/genesis.json'])
    identity = json.loads(captured['config/priv_validator_key.json'])
    if len(genesis['validators']) != 1 or identity['pub_key'] != genesis['validators'][0]['pub_key']:
        raise RuntimeError('Chain custody validator identity differs from genesis')
    state = json.loads(captured['data/priv_validator_state.json'])
    height = int(state['height'])
    if height < 0:
        raise RuntimeError('Chain custody signing height invalid')
    metadata = {'chain_id': genesis['chain_id'], 'captured_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'historical_signing_height': height, 'identity_recovery_only': True,
                'never_roll_back_signing_state': True,
                'recovery_rule': 'Fence the old signer and establish current signing state before any recovered validator starts. Never start this archived state alongside the existing signer.'}
    captured['recovery.json'] = json.dumps(metadata, sort_keys=True).encode()
    return {'chain/' + genesis['chain_id'] + '/' + name: data for name, data in captured.items()}, metadata


def main():
    if os.geteuid() != 0:
        raise RuntimeError('Root custody operation required')
    status = subprocess.run(['systemctl', 'is-active', 'uain-chain-shadow.service'], capture_output=True, text=True)
    if status.stdout.strip() != 'inactive':
        raise RuntimeError('Stop the shadow validator before consistent custody capture')
    captures, metadata = collect(HOME, GENESIS_SHA)
    spec = importlib.util.spec_from_file_location('uain_custody', '/opt/uain-custody/custody.py')
    custody = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(custody)
    kp = custody.vault()
    custody.verify_vault(kp)
    files = {item['name']: custody.attachment(kp, item['name']) for item in custody.records(kp)}
    files.update(captures)
    custody.save_vault(files)
    print(json.dumps({'chain_identity_archived': True, 'captured_files': len(captures), **metadata}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Library exceptions may include decrypted data. Emit no exception text.
        raise SystemExit('Chain custody capture failed; no secret diagnostic emitted')

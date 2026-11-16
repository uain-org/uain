#!/usr/bin/env python3
"""Forced SSH command for ciphertext custody backups; no shell or secret export."""
import hashlib
import os
import re
import sys
from pathlib import Path

ROOT = Path('/var/backups/uain-custody')
NAME = r'uain-custody-[0-9]{8}T[0-9]{6}Z\.tar'
LIMIT = 64 * 1024 * 1024


def main():
    os.umask(0o077)
    command = os.environ.get('SSH_ORIGINAL_COMMAND', '')
    match = re.fullmatch(r'(put|get) (' + NAME + r')', command)
    if not match:
        raise ValueError('Only named ciphertext backups may be read or written')
    action, name = match.groups()
    path = ROOT / name
    if action == 'get':
        sys.stdout.buffer.write(path.read_bytes())
        return
    data = sys.stdin.buffer.read(LIMIT + 1)
    if len(data) > LIMIT or not data:
        raise ValueError('Invalid backup size')
    # Immutable names: retry only when the bytes already match.
    if path.exists():
        if path.read_bytes() != data:
            raise ValueError('Refusing to replace a different backup')
    else:
        with path.open('xb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
    print(hashlib.sha256(path.read_bytes()).hexdigest())


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Custody backup request failed', file=sys.stderr)
        sys.exit(1)

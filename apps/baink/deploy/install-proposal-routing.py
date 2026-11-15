#!/usr/bin/env python3
"""Root-operated, hash-guarded preview proposal routing; safe to import locally."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

CONFIG_ROOT = Path('/etc/nginx/sites-available')
RELEASE_ROOT = Path('/opt/baink/releases')
CURRENT = Path('/opt/baink/current')
LOCK_PATH = Path('/var/lib/baink-deployments/activation.lock')
BACKUP_ROOT = Path('/var/backups/baink')
MARKER = b'    location ^~ /baink/api/ {'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def transform_preview(original):
    """Insert only proposal locations, preserving every original config byte."""
    if not isinstance(original, bytes):
        raise ValueError('The inspected nginx configuration must be bytes.')
    if original.count(MARKER) != 1:
        raise ValueError('Expected exactly one existing preview API location.')
    if b'/baink/proposals' in original:
        raise ValueError('Proposal routing already exists; stop and reconcile.')
    blocks = []
    for location, upstream in [('= /baink/proposals', '/proposals'),
                               ('^~ /baink/proposals/', '/proposals/')]:
        blocks.append(f'''    location {location} {{
        limit_req zone=baink_api burst=30 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:8798{upstream};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        client_max_body_size 16k;
        proxy_connect_timeout 5s;
        proxy_read_timeout 20s;
    }}

'''.encode('ascii'))
    return original.replace(MARKER, b''.join(blocks) + MARKER, 1)


def replace_config(path, content, release):
    temporary = path.with_name(path.name + '.proposal-' + release)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        with os.fdopen(fd, 'wb') as file:
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def test_and_reload():
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 3:
        raise ValueError('Usage: install-proposal-routing.py RELEASE EXPECTED_PRIMARY_SHA EXPECTED_PREVIEW_SHA')
    release, primary_sha, preview_sha = args
    if not re.fullmatch(r'\d{8}T\d{6}Z-[a-f0-9]{10}', release) or not all(
            re.fullmatch(r'[a-f0-9]{64}', value) for value in [primary_sha, preview_sha]):
        raise ValueError('Invalid release or expected SHA256 arguments.')
    if os.geteuid() != 0:
        raise PermissionError('Installing nginx routing requires root.')
    with LOCK_PATH.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        expected_release = RELEASE_ROOT / release
        if CURRENT.resolve(strict=True) != expected_release.resolve(strict=True):
            raise ValueError('Current release changed; qualify it before modifying routing.')
        primary = CONFIG_ROOT / 'baink.money.conf'
        preview = CONFIG_ROOT / 'aidollar.money.conf'
        primary_old, preview_old = primary.read_bytes(), preview.read_bytes()
        if digest(primary_old) != primary_sha or digest(preview_old) != preview_sha:
            raise ValueError('Config changed since inspection; stop and reconcile.')
        preview_new = transform_preview(preview_old)
        backup = BACKUP_ROOT / release / 'proposal-nginx'
        backup.mkdir(mode=0o700)
        backup_file = backup / preview.name
        fd = os.open(backup_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as file:
            file.write(preview_old)
            file.flush()
            os.fsync(file.fileno())
        try:
            if primary.read_bytes() != primary_old or preview.read_bytes() != preview_old:
                raise ValueError('Config changed before replacement; stop and reconcile.')
            replace_config(preview, preview_new, release)
            if primary.read_bytes() != primary_old:
                raise ValueError('Primary config changed; refusing to activate preview routing.')
            test_and_reload()
            if primary.read_bytes() != primary_old or preview.read_bytes() != preview_new:
                raise ValueError('Config changed during activation; stop and reconcile.')
        except BaseException:
            # Never overwrite another operator's later change, nor touch the
            # primary config. Reload only after restoring this install's bytes.
            if preview.read_bytes() == preview_new:
                replace_config(preview, preview_old, release)
                test_and_reload()
            raise
        print(json.dumps({
            'release': release, 'nginxTest': True, 'reloaded': True,
            'primaryUnchanged': True, 'primarySha256': primary_sha,
            'backup': str(backup), 'configs': [{
                'name': preview.name,
                'before': digest(preview_old), 'after': digest(preview_new),
            }],
        }))


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Install only the aidollar.money HTTPS root redirect after inspected guards."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

ROOT_UID = 0
CONFIG_ROOT = Path('/etc/nginx/sites-available')
RELEASE_ROOT = Path('/opt/baink/releases')
CURRENT = Path('/opt/baink/current')
LOCK_PATH = Path('/var/lib/baink-deployments/activation.lock')
BACKUP_ROOT = Path('/var/backups/baink')
APEX_HEADER = b'''server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name aidollar.money;

'''
PREVIEW_MARKER = b'    location = /baink { return 301 /baink/; }'
REDIRECT = b'    location = / { return 308 https://baink.money/$is_args$args; }\n\n'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def transform_aidollar(original):
    """Insert an exact root location in the inspected HTTPS apex block only."""
    if not isinstance(original, bytes):
        raise ValueError('The inspected nginx configuration must be bytes.')
    scope = APEX_HEADER + PREVIEW_MARKER
    if original.count(APEX_HEADER) != 1 or original.count(PREVIEW_MARKER) != 1 or original.count(scope) != 1:
        raise ValueError('Expected one inspected apex HTTPS server and preview location.')
    if re.search(rb'\blocation\s*=\s*/\s*\{', original):
        raise ValueError('An exact root location already exists; stop and reconcile.')
    return original.replace(scope, APEX_HEADER + REDIRECT + PREVIEW_MARKER, 1)


def owned_metadata(metadata, directory=False):
    valid_kind = stat.S_ISDIR(metadata.st_mode) if directory else stat.S_ISREG(metadata.st_mode)
    if not valid_kind:
        raise ValueError('Expected a non-symlink directory or regular file.')
    if metadata.st_uid != ROOT_UID or metadata.st_mode & 0o022:
        raise PermissionError('Deployment files and directories must be root-owned and not writable by others.')
    return metadata


def owned_path(path, directory=False):
    return owned_metadata(path.lstat(), directory)


def read_owned(path):
    owned_path(path.parent, directory=True)
    owned_path(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as file:
        metadata = owned_metadata(os.fstat(file.fileno()))
        return file.read(), stat.S_IMODE(metadata.st_mode)


def check_release(release):
    owned_path(RELEASE_ROOT, directory=True)
    owned_path(CURRENT.parent, directory=True)
    target = RELEASE_ROOT / release
    owned_path(target, directory=True)
    current = CURRENT.lstat()
    if not stat.S_ISLNK(current.st_mode) or current.st_uid != ROOT_UID:
        raise PermissionError('Current must be the root-owned installed release symlink.')
    if CURRENT.resolve(strict=True) != target.resolve(strict=True):
        raise ValueError('Current release changed; qualify it before changing routing.')


def replace_owned(path, expected, content, release, mode):
    temporary = path.with_name(path.name + '.canonical-' + release)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, 'wb') as file:
            os.fchmod(file.fileno(), mode)
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        if read_owned(path)[0] != expected:
            raise ValueError('Config changed immediately before replacement; refusing to overwrite it.')
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def test_and_reload(guard):
    guard()
    subprocess.run(['nginx', '-t'], check=True)
    # nginx -t does not freeze its inputs. Requalify immediately before every
    # reload, including rollback, while holding the cooperative deployment lock.
    guard()
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 3:
        raise ValueError('Usage: install-aidollar-canonical.py RELEASE EXPECTED_AIDOLLAR_SHA EXPECTED_PRIMARY_SHA')
    release, aidollar_sha, primary_sha = args
    if not re.fullmatch(r'\d{8}T\d{6}Z-[a-f0-9]{10}', release) or not all(
            re.fullmatch(r'[a-f0-9]{64}', value) for value in [aidollar_sha, primary_sha]):
        raise ValueError('Invalid installed release or expected SHA256 arguments.')
    if os.geteuid() != 0:
        raise PermissionError('Installing nginx routing requires root.')
    owned_path(LOCK_PATH.parent, directory=True)
    owned_path(LOCK_PATH)
    lock_fd = os.open(LOCK_PATH, os.O_RDWR | os.O_NOFOLLOW)
    with os.fdopen(lock_fd, 'r+') as lock:
        owned_metadata(os.fstat(lock.fileno()))
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        check_release(release)
        aidollar = CONFIG_ROOT / 'aidollar.money.conf'
        primary = CONFIG_ROOT / 'baink.money.conf'
        aidollar_old, mode = read_owned(aidollar)
        primary_old, _ = read_owned(primary)
        if digest(aidollar_old) != aidollar_sha or digest(primary_old) != primary_sha:
            raise ValueError('Config changed since inspection; stop and reconcile.')
        aidollar_new = transform_aidollar(aidollar_old)
        owned_path(BACKUP_ROOT, directory=True)
        owned_path(BACKUP_ROOT / release, directory=True)
        backup = BACKUP_ROOT / release / 'aidollar-canonical-nginx'
        backup.mkdir(mode=0o700)
        backup.chmod(0o700)
        owned_path(backup, directory=True)
        backup_file = backup / aidollar.name
        fd = os.open(backup_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as file:
            os.fchmod(file.fileno(), 0o600)
            file.write(aidollar_old)
            file.flush()
            os.fsync(file.fileno())

        def activation_guard(expected_aidollar):
            if os.geteuid() != 0:
                raise PermissionError('Root authority changed during activation.')
            check_release(release)
            owned_path(LOCK_PATH.parent, directory=True)
            live_lock = owned_path(LOCK_PATH)
            held_lock = owned_metadata(os.fstat(lock.fileno()))
            if (live_lock.st_dev, live_lock.st_ino) != (held_lock.st_dev, held_lock.st_ino):
                raise ValueError('Deployment lock path changed during activation.')
            owned_path(BACKUP_ROOT, directory=True)
            owned_path(BACKUP_ROOT / release, directory=True)
            backup_metadata = owned_path(backup, directory=True)
            backup_bytes, backup_mode = read_owned(backup_file)
            if stat.S_IMODE(backup_metadata.st_mode) != 0o700 or backup_mode != 0o600 or backup_bytes != aidollar_old:
                raise ValueError('Protected backup changed during activation.')
            if read_owned(primary)[0] != primary_old:
                raise ValueError('Primary config changed; refusing to reload unreviewed bytes.')
            if read_owned(aidollar)[0] != expected_aidollar:
                raise ValueError('AI Dollar config changed; refusing to reload unreviewed bytes.')

        try:
            activation_guard(aidollar_old)
            replace_owned(aidollar, aidollar_old, aidollar_new, release, mode)
            test_and_reload(lambda: activation_guard(aidollar_new))
            activation_guard(aidollar_new)
        except BaseException:
            # Never restore over a symlink, changed owner/mode, missing file or
            # another operator's bytes. The primary configuration is read-only.
            try:
                rollback_owned = read_owned(aidollar)[0] == aidollar_new
            except (OSError, ValueError):
                rollback_owned = False
            if rollback_owned:
                replace_owned(aidollar, aidollar_new, aidollar_old, release, mode)
                try:
                    test_and_reload(lambda: activation_guard(aidollar_old))
                except (OSError, ValueError) as guard_error:
                    raise RuntimeError(
                        'Owned AI Dollar bytes restored, but rollback reload was refused because '
                        f'activation guards no longer qualify. Inspect {backup}: {guard_error}'
                    ) from guard_error
            raise
        print(json.dumps({
            'release': release, 'scope': 'aidollar.money HTTPS exact root only',
            'nginxTest': True, 'reloaded': True, 'primaryUnchanged': True,
            'primarySha256': primary_sha, 'before': digest(aidollar_old),
            'after': digest(aidollar_new), 'backup': str(backup),
        }))


if __name__ == '__main__':
    main()

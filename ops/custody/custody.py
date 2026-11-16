#!/usr/bin/env python3
"""Root-only UAIN custody operations. Never display private attachments/passwords.

The KDBX vault is compatible with KeePassXC. The password is decrypted into
memory by systemd-creds; its recovery copy is separate from cloud backups.
Import reads a tar stream in memory, never extracting its plaintext to disk.
"""
import argparse
import base64
import datetime
import hashlib
import io
import json
import os
import secrets
import stat
import types
import socket
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

from pykeepass import PyKeePass, create_database

ROOT = Path('/var/lib/uain-custody')
VAULT = ROOT / 'uain.kdbx'
CREDENTIAL = '/etc/credstore.encrypted/uain-custody'
NODE_DIR = '/opt/uain-review-runtime/node-v22.22.0-linux-x64/bin'
SOURCE = Path('/opt/uain-operations/src')
ANCHOR = Path('/var/lib/uain-anchor')
SSH = ['ssh', '-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
       '-o', 'UserKnownHostsFile=/etc/uain-custody/db_known_hosts',
       '-i', '/etc/uain-custody/db-backup_ed25519', 'root@10.98.0.2']
LIMIT = 64 * 1024 * 1024


class CustodyError(RuntimeError):
    """An operational diagnostic that contains no secret values."""


def digest(data):
    return hashlib.sha256(data).hexdigest()


def password():
    return subprocess.check_output(['systemd-creds', 'decrypt', '--name=uain-custody',
                                    CREDENTIAL, '-'], stderr=subprocess.DEVNULL).decode().strip()


def vault(file=None):
    file = VAULT if file is None else file
    return PyKeePass(str(file), password=password())


def attachment(kp, name):
    entry = kp.find_entries(title=name, first=True)
    if entry is None or len(entry.attachments) != 1:
        raise CustodyError('Missing custody attachment')
    return entry.attachments[0].data


def records(kp):
    return json.loads(attachment(kp, '_inventory.json'))['files']


def verify_vault(kp):
    items = records(kp)
    if len(kp.entries) != len(items) + 1:
        raise CustodyError('Vault inventory count differs')
    for item in items:
        data = attachment(kp, item['name'])
        if digest(data) != item['sha256'] or len(data) != item['bytes']:
            raise CustodyError('Vault attachment differs from import')
    return len(items)


def put(kp, name, data):
    entry = kp.add_entry(kp.root_group, name, '', '', notes='Managed by UAIN custody; file attachment')
    entry.add_attachment(kp.add_binary(data, protected=True), PurePosixPath(name).name)


def kubernetes_secret(name):
    result = json.loads(subprocess.check_output(['k3s', 'kubectl', '-n', 'uain', 'get',
                                                 'secret', name, '-o', 'json']))
    return {k: base64.b64decode(v) for k, v in result['data'].items()}


LIVE_NAMES = ['key.json', 'worker.json', 'state.json', 'auth.json']
LIVE_FILE_LIMIT = 1024 * 1024


def read_live_file(name, dir_fd=None):
    """Bytes of one regular, singly linked file of at most 1 MiB, opened without
    following a final symlink; None for anything else. Whoever writes these trees
    (a reviewer container's volume, a member state folder) cannot point root at
    another file or make one oversized file stop the refresh and the backup after it."""
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dir_fd)
    except OSError:
        return None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > LIVE_FILE_LIMIT:
            return None
        chunks, size = [], 0
        while size <= LIVE_FILE_LIMIT:
            chunk = os.read(fd, LIVE_FILE_LIMIT + 1 - size)
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
        return b''.join(chunks) if size <= LIVE_FILE_LIMIT else None
    finally:
        os.close(fd)


def live_tree(top):
    """(relative path, bytes) of every LIVE_NAMES file under top. Never follows a
    symlinked directory or file (fwalk plus openat); unreadable entries are skipped."""
    found, skipped = [], []
    for directory, _, names, dir_fd in os.fwalk(top, follow_symlinks=False):
        for name in names:
            if name in LIVE_NAMES:
                relative = os.path.relpath(os.path.join(directory, name), top)
                data = read_live_file(name, dir_fd=dir_fd)
                if data is None:
                    skipped.append(relative)
                else:
                    found.append((relative, data))
    return found, skipped


def live_files(files):
    for field, data in kubernetes_secret('uain-ledger').items():
        files['production/' + field] = data
    files['production/uain-env.json'] = json.dumps(
        {k: v.decode() for k, v in kubernetes_secret('uain-env').items()}, sort_keys=True).encode()
    # Backup the server's active identities/configuration as well as Mac archives.
    paths = ['/opt/uain-runner/.env', '/home/uain/.codex/auth.json',
             '/home/uain/.uain-review-default/key.json',
             '/home/uain/.uain-review-default/worker.json',
             '/home/uain/.uain-review-default/state.json']
    # CU-6: no symlink is followed, no hard-linked, special or over-1-MiB file is read,
    # and one such file is skipped (its earlier vault copy stays) instead of stopping the
    # refresh and the backup that runs after it.
    skipped = []
    for name in paths:
        if os.path.lexists(name):
            data = read_live_file(name)
            if data is None:
                skipped.append(name)
            else:
                files['server/' + name.lstrip('/')] = data
    member_root = Path('/opt/uain-runner/security')
    if member_root.is_dir() and not member_root.is_symlink():
        found, bad = live_tree(member_root)
        skipped.extend(str(member_root / relative) for relative in bad)
        for relative, data in found:
            files['server/' + str(member_root / relative).lstrip('/')] = data
    # Only the UAIN reviewer project's member and provider-auth volumes.
    # Never inspect or copy AGA/other tenants' volumes.
    for name in ['uain-review-codex_member', 'uain-review-codex_codex-auth']:
        result = subprocess.run(['docker', 'volume', 'inspect', name], capture_output=True)
        if result.returncode != 0:
            raise CustodyError('Required reviewer volume is missing')
        mount = Path(json.loads(result.stdout)[0]['Mountpoint'])
        found, bad = live_tree(mount)
        skipped.extend('volumes/' + name + '/' + relative for relative in bad)
        for relative, data in found:
            files['volumes/' + name + '/' + relative] = data
    if skipped:
        # Paths only, never contents.
        print('custody refresh skipped %d live file(s) (symlink, hard link, not regular or over 1 MiB): %s'
              % (len(skipped), ', '.join(sorted(skipped))), file=sys.stderr)
    # Capture current durable journals, rather than overwriting them with old local state.
    for name in ['operations.json', 'solana.json', 'ledger-public.pem']:
        files['anchor/' + name] = (ANCHOR / name).read_bytes()
    return files


def save_vault(files):
    required = ['keys/release-key.json', 'keys/backup-key.txt', 'keys/base-sepolia-owner.key',
                'keys/base-sepolia-anchorer.key', 'keys/solana-devnet-mirror.json']
    if any(name not in files for name in required):
        raise CustodyError('Required keys absent')
    if json.loads(files['keys/release-key.json'])['public_key'] != 'XlRwnWHiN9FuiXUD8Q2gwSlEKLNhetU42uRKQbRuAZs':
        raise CustodyError('Release key does not match the pinned key')
    manifest = {'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'files': [{'name': name, 'bytes': len(data), 'sha256': digest(data)}
                          for name, data in sorted(files.items())]}
    temporary = ROOT / '.uain.pending.kdbx'
    kp = create_database(str(temporary), password=password())
    # The library's blank database contains template groups/entries.
    for entry in list(kp.entries):
        kp.delete_entry(entry)
    for name, data in files.items():
        put(kp, name, data)
    put(kp, '_inventory.json', json.dumps(manifest, sort_keys=True).encode())
    kp.save()
    count = verify_vault(vault(temporary))
    temporary.replace(VAULT)
    print(json.dumps({'imported_files': count, 'vault_sha256': digest(VAULT.read_bytes()),
                      'format': list(kp.version), 'cipher': kp.encryption_algorithm}))


def import_vault():
    if VAULT.exists():
        raise CustodyError('A vault already exists; refusing a second initialization')
    stream = sys.stdin.buffer.read(LIMIT + 1)
    if len(stream) > LIMIT:
        raise CustodyError('Import too large')
    files = {}
    with tarfile.open(fileobj=io.BytesIO(stream), mode='r:*') as incoming:
        for item in incoming:
            if item.isdir():
                continue
            name = str(PurePosixPath(item.name))
            if not item.isfile() or name.startswith('/') or '..' in PurePosixPath(name).parts:
                raise CustodyError('Invalid custody import path')
            if name in files or item.size > LIMIT:
                raise CustodyError('Duplicate or oversized custody attachment')
            files[name] = incoming.extractfile(item).read()
    save_vault(live_files(files))


def refresh():
    kp = vault()
    verify_vault(kp)
    files = {item['name']: attachment(kp, item['name']) for item in records(kp)}
    save_vault(live_files(files))


def s3(config=None):
    import boto3
    env = kubernetes_secret('uain-env')
    return boto3.client('s3', endpoint_url='https://nyc3.digitaloceanspaces.com',
                        region_name='nyc3',
                        aws_access_key_id=env['UAIN_STORAGE_ACCESS_KEY_ID'].decode(),
                        aws_secret_access_key=env['UAIN_STORAGE_SECRET_ACCESS_KEY'].decode(),
                        **({'config': config} if config is not None else {}))


def check_package(data, kp):
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as package:
        expected = {'uain.kdbx', 'operations.json', 'solana.json', 'ledger-public.pem', 'manifest.json'}
        if set(package.getnames()) != expected or len(package.getnames()) != len(expected):
            raise CustodyError('Unexpected backup contents')
        manifest = json.load(package.extractfile('manifest.json'))
        for name in expected - {'manifest.json'}:
            content = package.extractfile(name).read()
            if digest(content) != manifest['sha256'][name]:
                raise CustodyError('Backup checksum differs')
        # Reopen downloaded ciphertext, authenticate and check every attachment.
        with tempfile.NamedTemporaryFile(dir='/dev/shm', suffix='.kdbx') as copy:
            copy.write(package.extractfile('uain.kdbx').read())
            copy.flush()
            restored = vault(Path(copy.name))
            verify_vault(restored)
            if records(restored) != records(kp):
                raise CustodyError('Recovered vault inventory differs')
    return manifest


def backup():
    kp = vault()
    count = verify_vault(kp)
    name = datetime.datetime.now(datetime.timezone.utc).strftime('uain-custody-%Y%m%dT%H%M%SZ.tar')
    contents = {'uain.kdbx': VAULT.read_bytes()}
    for file in ['operations.json', 'solana.json', 'ledger-public.pem']:
        contents[file] = (ANCHOR / file).read_bytes()
    manifest = {'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'files_in_vault': count, 'sha256': {n: digest(b) for n, b in contents.items()}}
    contents['manifest.json'] = json.dumps(manifest, sort_keys=True).encode()
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w') as package:
        for file, data in contents.items():
            item = tarfile.TarInfo(file)
            item.size, item.mode = len(data), 0o600
            package.addfile(item, io.BytesIO(data))
    data = stream.getvalue()
    path = ROOT / 'backups' / name
    with path.open('xb') as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    client = s3()
    key = 'custody/' + name
    # Unique timestamped object, never sync/delete or overwrite an existing object.
    client.put_object(Bucket='uain', Key=key, Body=data, ContentType='application/x-tar',
                      Metadata={'sha256': digest(data)}, IfNoneMatch='*')
    remote_hash = subprocess.check_output(SSH + ['put ' + name], input=data,
                                           stderr=subprocess.DEVNULL).decode().strip()
    if remote_hash != digest(data):
        raise CustodyError('Database server backup differs')
    spaces_copy = client.get_object(Bucket='uain', Key=key)['Body'].read()
    database_copy = subprocess.check_output(SSH + ['get ' + name], stderr=subprocess.DEVNULL)
    if spaces_copy != data or database_copy != data:
        raise CustodyError('Backup readback differs')
    check_package(spaces_copy, kp)
    check_package(database_copy, kp)
    result = {'verified_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'backup': name, 'sha256': digest(data), 'files_in_vault': count,
              'spaces': 's3://uain/' + key, 'database': '10.98.0.2:/var/backups/uain-custody/' + name,
              'readback': 'byte-identical, authenticated vault and every attachment verified'}
    (ROOT / 'last-backup.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


def child_env():
    env = os.environ.copy()
    env['PATH'] = NODE_DIR + ':' + env.get('PATH', '/usr/bin:/bin')
    return env


CLIENT_RETIRED = ('The UAIN Client is retired: 0.15.0 (10 November 2026) was its final release, '
                  'so there is no client release to sign. See docs/key-custody.md')


def sign_worker(checkout):
    # Retired 9 November 2026 (it ran npm as root with the key staged); the
    # client itself was retired with its final release, 0.15.0.
    raise CustodyError(CLIENT_RETIRED)


def sign_worker_release(directory, manifest_sha256):
    # 0.15.0, signed through custody on 9 November 2026, was the final
    # release; the keyless-build signing helper (worker_release.py) is removed.
    raise CustodyError(CLIENT_RETIRED)


RUNNER_UNIT = 'actions.runner.senti-org-uain-universa.uain-production.service'


def runners_active():
    """Every active Actions runner of this repository, by pattern, as ops/reset/system.py
    runners_active(): a runner re-registered under another organisation (the repository
    moved to nuah-org) must not slip past a fixed unit name. Fails closed when systemd
    cannot be asked. Copied, not imported, to keep custody's pinned closure unchanged."""
    try:
        result = subprocess.run(['systemctl', 'list-units', 'actions.runner.*', 'uain-ci-worker*',
                                 '--state=active,activating,reloading', '--plain', '--no-legend'],
                                capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        raise CustodyError('Cannot list Actions runners; refusing')
    if result.returncode:
        raise CustodyError('Cannot list Actions runners; refusing')
    units = [line.split()[0] for line in result.stdout.splitlines() if line.strip()]
    # The extra workers for this repository run as uain-ci-worker-N.service (ops/ci/README.md).
    return sorted(u for u in units if 'uain-universa' in u or u == RUNNER_UNIT or u.startswith('uain-ci-worker'))


def anchor(args):
    if not args or args[0] not in ['catchup', 'audit', 'prove', 'solana-mirror', 'solana-audit',
                                  'recover-anchor', 'solana-recover']:
        raise CustodyError('Use an existing-contract audit, proof, catchup or recovery command')
    env = child_env()
    env.update(UAIN_API='https://uain.global', BASE_SEPOLIA_RPC='https://sepolia.base.org',
               LEDGER_PUBLIC_KEY_FILE=str(ANCHOR / 'ledger-public.pem'),
               LEDGER_OWNER_ADDRESS='0x7765f79b20Aa45a8B874C063F2861371Da8F111A',
               LEDGER_ANCHOR_ADDRESS='0xBC3E0C109D2dF00Aa736A7169d8389cE286e868b',
               ANCHORER_ADDRESS='0xCC6034999d0c14f0be9E6D3B78aa139652596974',
               LEDGER_ANCHOR_START_DATE='2026-09-21', ANCHOR_JOURNAL=str(ANCHOR / 'operations.json'),
               ANCHOR_MAX_FEE_WEI='100000000', ANCHOR_MAX_GAS='150000',
               ANCHOR_PRIORITY_FEE_WEI='1000000', SOLANA_RPC='https://api.devnet.solana.com',
               SOLANA_MIRROR_ADDRESS='2ymaG8ARXvySwgniQTfNmpADcoiqGTk9wcQr3FohMoKZ',
               SOLANA_JOURNAL=str(ANCHOR / 'solana.json'))
    # Match the Actions workflow's concurrency: do not overlap a scheduled run.
    if '--send' in args or args[0] in ['recover-anchor', 'solana-recover']:
        busy = runners_active()
        if busy:
            raise CustodyError('Drain and stop the Actions runners before manual sends/recovery; restart afterwards: '
                               + ', '.join(busy))
    with tempfile.TemporaryDirectory(prefix='uain-mirror-', dir='/dev/shm') as directory:
        if '--send' in args:
            kp = vault()
            if args[0] == 'catchup':
                env['ANCHORER_PRIVATE_KEY'] = attachment(kp, 'keys/base-sepolia-anchorer.key').decode().strip()
            elif args[0] == 'solana-mirror':
                key = Path(directory) / 'mirror.json'
                key.write_bytes(attachment(kp, 'keys/solana-devnet-mirror.json'))
                env['SOLANA_MIRROR_KEY_FILE'] = str(key)
        subprocess.run(['node', 'contracts/scripts/operations.mjs'] + args,
                       cwd=SOURCE, env=env, check=True)


def verify_database_backup():
    kp = vault()
    newest = sorted(Path('/var/lib/uain-backups').glob('uain-backup-*.uainbk'))[-1]
    data = attachment(kp, 'keys/backup-key.txt').strip() + b'\n' + newest.read_bytes()
    result = subprocess.check_output(['k3s', 'kubectl', '-n', 'uain', 'exec', '-i',
                                     'deploy/pilot', '-c', 'pilot', '--', 'node',
                                     'dist/src/operations/backup-cli.js', 'verify', newest.name], input=data)
    manifest = json.loads(result)
    saved = json.loads(newest.with_suffix('.json').read_bytes())
    if manifest != saved:
        raise CustodyError('Database backup manifest differs')
    client = s3()
    copy = client.get_object(Bucket='uain', Key='backups/' + newest.name)['Body'].read()
    if copy != newest.read_bytes():
        raise CustodyError('Spaces database backup differs')
    print(json.dumps({'database_backup': newest.name, 'sha256': digest(copy),
                      'opened_and_manifest_matches': True, 'spaces_readback_matches': True}))


def stage(name):
    # Recovery files are written only to a new root-only directory in RAM.
    # Never offer a stdout export or overwrite an active member identity.
    kp = vault()
    verify_vault(kp)
    parent = Path('/run/uain-custody')
    parent.mkdir(mode=0o700, exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix='recovery-', dir=parent))
    destination = directory / PurePosixPath(name).name
    with destination.open('xb') as output:
        output.write(attachment(kp, name))
    print(json.dumps({'staged_file': str(destination), 'mode': '0600',
                      'cleanup': 'Remove this recovery directory after its authorized use'}))


def restore_drill():
    """Recover a downloaded real backup in a separate, disposable PostgreSQL."""
    if not (SOURCE / 'services/pilot/dist/src/operations/backup-cli.js').is_file():
        raise CustodyError('Build the dedicated source checkout first')
    kp = vault()
    newest = sorted(Path('/var/lib/uain-backups').glob('uain-backup-*.uainbk'))[-1]
    client = s3()
    data = client.get_object(Bucket='uain', Key='backups/' + newest.name)['Body'].read()
    if data != newest.read_bytes():
        raise CustodyError('Off-host database backup differs')
    container = 'uain-custody-restore-' + secrets.token_hex(6)
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    env = child_env()
    env['POSTGRES_PASSWORD'] = secrets.token_urlsafe(32)
    env['POSTGRES_USER'] = 'uain'
    created = False
    try:
        subprocess.run(['docker', 'create', '--name', container, '--memory', '2g', '--cpus', '2',
                        '--label', 'uain.purpose=custody-restore',
                        '--tmpfs', '/var/lib/postgresql/data:rw,size=2g',
                        '-p', f'127.0.0.1:{port}:5432', '-e', 'POSTGRES_USER',
                        '-e', 'POSTGRES_PASSWORD', 'postgres:17-alpine'],
                       env=env, check=True, stdout=subprocess.DEVNULL)
        created = True
        subprocess.run(['docker', 'start', container], check=True, stdout=subprocess.DEVNULL)
        import time
        for _ in range(60):
            # initdb's temporary server listens only on a Unix socket. Wait
            # for TCP, so we cannot mistake it for the final running server.
            ready = subprocess.run(['docker', 'exec', container, 'pg_isready',
                                    '-h', '127.0.0.1', '-U', 'uain'],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if ready.returncode == 0:
                break
            time.sleep(1)
        else:
            raise CustodyError('Disposable PostgreSQL did not start')
        with tempfile.TemporaryDirectory(prefix='uain-custody-drill-', dir='/dev/shm') as directory:
            directory = Path(directory)
            backup_file = directory / newest.name
            backup_file.write_bytes(data)
            backup_file.with_suffix('.json').write_bytes(newest.with_suffix('.json').read_bytes())
            env.update(UAIN_BACKUP_KEY=attachment(kp, 'keys/backup-key.txt').decode().strip(),
                       UAIN_BACKUP_DB_CONTAINER=container, UAIN_RESTORE_DB='uain_custody_drill',
                       UAIN_RESTORE_PG_URL=f'postgres://uain:{env["POSTGRES_PASSWORD"]}@127.0.0.1:{port}/postgres',
                       UAIN_RESTORE_DATA_DIR=str(directory / 'data'),
                       LEDGER_PUBLIC_KEY_FILE=str(ANCHOR / 'ledger-public.pem'))
            subprocess.run(['bash', 'ops/backup/restore.sh', str(backup_file)],
                           cwd=SOURCE, env=env, check=True)
        print(json.dumps({'restore_drill': 'passed', 'database_backup': newest.name,
                          'source': 'downloaded from DigitalOcean Spaces',
                          'target': 'disposable localhost-only PostgreSQL, removed after check'}))
    finally:
        if created:
            subprocess.run(['docker', 'rm', '-f', container], check=True, stdout=subprocess.DEVNULL)


def source_module(name):
    # These newly privileged helpers execute reviewed source even when an old
    # valid timestamp/size bytecode cache is present. -B alone still reads pyc.
    if name not in {'sql_cutoff', 'spaces_probe', 'native_admission', 'native_financial_activation', 'native_payment_bootstrap', 'guardian_proposer', 'guardian_approver'}:
        raise CustodyError('Unapproved source helper')
    path = Path(__file__).absolute().with_name(name + '.py')
    if path.resolve() != path:
        raise CustodyError('Redirected custody helper')
    for parent in path.parents:
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise CustodyError('Unprotected custody source directory')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_mode & 0o022 or before.st_nlink != 1 or not 0 < before.st_size <= 512 * 1024:
            raise CustodyError('Unprotected or oversized custody helper')
        with os.fdopen(fd, 'rb', closefd=False) as file:
            raw = file.read(512 * 1024 + 1)
        after = os.fstat(fd)
        identity = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_uid, info.st_mode, info.st_nlink)
        if len(raw) != before.st_size or identity(before) != identity(after):
            raise CustodyError('Custody helper changed while reading')
    finally:
        os.close(fd)
    code = compile(raw, str(path), 'exec', dont_inherit=True)
    helper = types.ModuleType(name)
    helper.__file__ = str(path)
    exec(code, helper.__dict__)
    return helper


def main():
    os.umask(0o077)
    if os.geteuid() != 0:
        raise CustodyError('Run custody operations as root on uain-app-1')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['import', 'refresh', 'verify', 'inventory', 'backup',
                                           'sign-worker', 'sign-worker-release', 'anchor', 'verify-database-backup', 'backup-evidence',
                                           'stage', 'restore-drill', 'sign-native-migration',
                                           'provision-treasury', 'sign-treasury-transfer', 'sign-treasury-control', 'repair-treasury-wire', 'backup-sql-cutoff', 'probe-spaces-conditional', 'auto-native-admission', 'check-native-admission', 'check-native-financial-activation', 'sign-native-financial-activation', 'check-native-payment-bootstrap', 'sign-native-payment-bootstrap', 'propose-guardian-actions', 'approve-guardian-actions'])
    parser.add_argument('args', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command == 'import':
        import_vault()
    elif args.command == 'refresh':
        refresh()
    elif args.command == 'backup':
        backup()
    elif args.command == 'backup-evidence':
        if len(args.args) != 1:
            raise CustodyError('Give the trusted public evidence helper checkout')
        import evidence
        evidence.backup(sys.modules[__name__], args.args[0])
    elif args.command == 'verify-database-backup':
        verify_database_backup()
    elif args.command == 'restore-drill':
        restore_drill()
    elif args.command == 'stage':
        if len(args.args) != 1:
            raise CustodyError('Give the inventory attachment to stage for recovery')
        stage(args.args[0])
    elif args.command in ('provision-treasury', 'sign-treasury-transfer', 'sign-treasury-control', 'repair-treasury-wire'):
        if len(args.args) != 1:
            raise CustodyError('Give the exact pinned signer or approved treasury execution')
        import treasury
        if args.command == 'provision-treasury':
            treasury.provision(sys.modules[__name__], args.args[0])
        elif args.command == 'sign-treasury-control':
            treasury.control_approved(sys.modules[__name__], args.args[0])
        elif args.command == 'repair-treasury-wire':
            treasury.repair_approved(sys.modules[__name__], args.args[0])
        else:
            treasury.sign_approved(sys.modules[__name__], args.args[0])
    elif args.command in ('check-native-payment-bootstrap', 'sign-native-payment-bootstrap'):
        if len(args.args) != 1:
            raise CustodyError('Give the exact protected payment bootstrap epoch')
        source_module('native_payment_bootstrap').run(sys.modules[__name__], args.args[0], execute=args.command == 'sign-native-payment-bootstrap')
    elif args.command in ('check-native-financial-activation', 'sign-native-financial-activation'):
        if len(args.args) != 1:
            raise CustodyError('Give the exact protected financial activation epoch')
        source_module('native_financial_activation').run(sys.modules[__name__], args.args[0], execute=args.command == 'sign-native-financial-activation')
    elif args.command in ('auto-native-admission', 'check-native-admission'):
        if args.args:
            raise CustodyError('Automatic admission uses only its fixed root-owned policy')
        helper = source_module('native_admission')
        (helper.run if args.command == 'auto-native-admission' else helper.check_policy)(sys.modules[__name__])
    elif args.command == 'backup-sql-cutoff':
        if len(args.args) != 1:
            raise CustodyError('Give the exact protected SQL cutoff approval path')
        sql_cutoff = source_module('sql_cutoff')
        sql_cutoff.run_approved(sys.modules[__name__], args.args[0])
    elif args.command == 'probe-spaces-conditional':
        if args.args:
            raise CustodyError('The conditional probe accepts no caller object or endpoint')
        spaces_probe = source_module('spaces_probe')
        spaces_probe.run(sys.modules[__name__])
    elif args.command == 'propose-guardian-actions':
        if len(args.args) != 1:
            raise CustodyError('Give the root-owned reviewed guardian action batch')
        source_module('guardian_proposer').run(sys.modules[__name__], args.args[0])
    elif args.command == 'approve-guardian-actions':
        if args.args:
            raise CustodyError('The approver uses only its fixed root-owned configuration')
        source_module('guardian_approver').run(sys.modules[__name__])
    elif args.command == 'sign-native-migration':
        if len(args.args) != 1:
            raise CustodyError('Give the exact approved migration epoch')
        import native_migration
        native_migration.sign_approved(sys.modules[__name__], args.args[0])
    elif args.command == 'sign-worker':
        sign_worker(None)
    elif args.command == 'sign-worker-release':
        sign_worker_release(None, None)
    elif args.command == 'anchor':
        anchor(args.args)
    else:
        kp = vault()
        count = verify_vault(kp)
        print(json.dumps({'verified_files': count, 'vault_sha256': digest(VAULT.read_bytes())}))
        if args.command == 'inventory':
            for item in records(kp):
                print(item['name'])


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never print library exception representations: they can include secret values.
        message = str(error) if isinstance(error, CustodyError) else (
            'Custody operation failed (' + type(error).__name__ + '); check the documented prerequisites')
        print(message, file=sys.stderr)
        sys.exit(1)

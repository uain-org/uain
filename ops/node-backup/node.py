"""Fixed-scope, stopped-node encrypted backups. Never starts a restored signer."""
import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
import resource
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import uuid

HERE = Path(__file__).resolve().parent
crypto_path = HERE / 'archive.py'
if not crypto_path.exists():
    crypto_path = HERE.parent / 'reset/archive.py'
spec = importlib.util.spec_from_file_location('uain_node_crypto', crypto_path)
crypto = importlib.util.module_from_spec(spec)
spec.loader.exec_module(crypto)
crypto.MAGIC = b'UAINNODE01'
ROOT = Path('/var/lib/uain-node-backups')
MARKER = Path('/run/uain-node-backup-restart.json')
CAPTURE_LOCK = Path('/run/lock/uain-node-backup-capture.lock')
CAPSULE_TMP = Path('/run')
UNIT = 'uain-chain-shadow.service'
HOME_BASE = Path('/var/lib/uain-chain')
RELEASE_BASE = Path('/opt/uain-chain/releases')
UNIT_FILE = Path('/etc/systemd/system') / UNIT
HOSTS = ('uain-app-1', 'uain-db-1')
STAMP = r'[0-9]{8}T[0-9]{6}Z'
NAME = r'uain-node-(uain-app-1|uain-db-1)-' + STAMP + r'\.nodebk'
MAX_BYTES = 16 * 1024**3
ROLE_PROFILE = Path('/etc/uain-failover/node.json')
ROLE_HELPER = Path('/opt/uain-failover/ops/chain/failover-backup.py')


def role_enabled():
    # A broken/redirected profile is an error, never permission to fall back
    # to the old source restart path after promotion.
    return ROLE_PROFILE.exists() or ROLE_PROFILE.is_symlink()


def role_helper():
    if ROLE_HELPER.resolve() != ROLE_HELPER or ROLE_HELPER.stat().st_uid != 0 or ROLE_HELPER.stat().st_mode & 0o077:
        raise ValueError('Reviewed private root-owned role helper required')
    spec = importlib.util.spec_from_file_location('uain_backup_roles', ROLE_HELPER)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def require_role_pair(backups):
    if role_enabled():
        role_helper().paired(backups)


def sha(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as source:
        while chunk := source.read(1024*1024):
            value.update(chunk)
    return value.hexdigest()


def atomic_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + '.pending-' + uuid.uuid4().hex)
    with temporary.open('x') as output:
        os.chmod(temporary, 0o600)
        json.dump(value, output, sort_keys=True)
        output.write('\n'); output.flush(); os.fsync(output.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)


def sync_directory(path):
    descriptor=os.open(path,os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)


def run(args):
    result = subprocess.run(args, capture_output=True, timeout=180)
    if result.returncode:
        raise ValueError('Fixed-scope node operation failed')
    return result.stdout.decode().strip()


def active():
    return subprocess.run(['systemctl','is-active','--quiet',UNIT],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def inventory():
    host = socket.gethostname().split('.')[0]
    if host not in HOSTS or os.geteuid() != 0:
        raise ValueError('Wrong backup host or user')
    home = Path(run(['systemctl','show',UNIT,'-p','WorkingDirectory','--value']))
    if home.parent != HOME_BASE or home.resolve() != home or not re.fullmatch(r'[a-z0-9_-]{1,64}',home.name):
        raise ValueError('Unexpected node home')
    unit = UNIT_FILE.read_text()
    match = re.search(r'^ExecStart=(' + re.escape(str(RELEASE_BASE)) + r'/([a-f0-9]{64})/uaind) start --home ' + re.escape(str(home)) + r'$',unit,re.M)
    if not match or sha(match[1]) != match[2]:
        raise ValueError('Unexpected node executable')
    genesis = json.loads((home/'config/genesis.json').read_text())
    return dict(host=host,home=str(home),binary=match[1],binary_sha256=match[2],
                unit_sha256=sha(UNIT_FILE),genesis_sha256=sha(home/'config/genesis.json'),
                chain_id=genesis['chain_id'])


def tree(root):
    digest = hashlib.sha256(); total = 0; files = 0
    for path in sorted(Path(root).rglob('*')):
        if path.is_symlink() or not (path.is_dir() or path.is_file()):
            raise ValueError('Unsafe node state entry')
        relative = str(path.relative_to(root))
        mode = path.stat().st_mode & 0o777
        digest.update((relative+'\0'+str(mode)+'\0').encode())
        if path.is_file():
            files += 1; total += path.stat().st_size
            digest.update(bytes.fromhex(sha(path)))
    return dict(sha256=digest.hexdigest(),files=files,bytes=total)


def filename(host, stamp):
    if host not in HOSTS or not re.fullmatch(STAMP,stamp):
        raise ValueError('Invalid backup identity')
    datetime.datetime.strptime(stamp,'%Y%m%dT%H%M%SZ')
    return 'uain-node-'+host+'-'+stamp+'.nodebk'


def archive_path(name):
    if not re.fullmatch(NAME,name):
        raise ValueError('Invalid backup name')
    root = ROOT.resolve()
    if root != ROOT or not root.is_dir() or root.stat().st_uid != os.geteuid() or root.stat().st_mode & 0o077:
        raise ValueError('Unsafe backup directory')
    path = root / name
    if path.is_symlink():
        raise ValueError('Backup is redirected')
    return path


def recover():
    if role_enabled():
        # The outer daily service also invokes this entry point in its
        # ExecStopPost. It must not bypass a failed live-source challenge in
        # the inner role-aware capture's recovery.
        module = role_helper()
        return module.recover(module.f.Node(module.PROFILE))
    if not MARKER.exists():
        return
    expected = json.loads(MARKER.read_text())
    current = inventory()
    if current != expected['inventory']:
        raise ValueError('Refusing to restart changed node configuration')
    if not active():
        run(['systemctl','start',UNIT])
    if not active():
        raise ValueError('Node restart failed')
    MARKER.unlink()
    sync_directory(MARKER.parent)


def verify_restore(path, key):
    receipt = crypto.verify(path,key)
    with tempfile.TemporaryDirectory(prefix='uain-node-restore-',dir=ROOT) as work:
        destination = Path(work)/'unpacked'
        crypto.unpack(path,key,destination)
        manifest = json.loads((destination/'manifest.json').read_text())
        home = Path(manifest['home'])
        if home.parent != HOME_BASE or not re.fullmatch(r'[a-z0-9_-]{1,64}',home.name):
            raise ValueError('Unexpected restored home')
        if {p.name for p in destination.iterdir()} != {home.name,'uaind',UNIT,'manifest.json'}:
            raise ValueError('Unexpected restored capsule')
        if tree(destination/home.name) != manifest['tree'] or sha(destination/'uaind') != manifest['binary_sha256'] or sha(destination/UNIT) != manifest['unit_sha256'] or sha(destination/home.name/'config/genesis.json') != manifest['genesis_sha256']:
            raise ValueError('Restored node differs')
    return dict(**receipt,manifest=manifest,full_tree_restore_verified=True,restored_signer_started=False)


def capture(key, stamp):
    crypto.key_bytes(key)
    with CAPTURE_LOCK.open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if MARKER.exists():
            recover()
        before = inventory()
        if not active():
            raise ValueError('Backup requires an already running node')
        path = archive_path(filename(before['host'],stamp))
        if path.exists():
            raise ValueError('Refusing to overwrite a node backup')
        source_bytes=sum(p.stat().st_size for p in Path(before['home']).rglob('*') if p.is_file())
        if shutil.disk_usage(ROOT).free < max(2*1024**3,4*(source_bytes+Path(before['binary']).stat().st_size)):
            raise ValueError('Insufficient backup and restore verification space')
        temporary = path.with_name(path.name+'.pending-'+uuid.uuid4().hex)
        atomic_json(MARKER,dict(inventory=before))
        stopped_at = datetime.datetime.now(datetime.timezone.utc)
        try:
            run(['systemctl','stop',UNIT])
            if active() or inventory() != before:
                raise ValueError('Node did not stop with reviewed configuration')
            home = Path(before['home'])
            manifest = dict(before,created_at=stopped_at.isoformat(),tree=tree(home),backup_name=path.name,
                            format='UAINNODE01',restore_requires_signer_fencing=True)
            with tempfile.TemporaryDirectory(prefix='uain-node-capsule-',dir=CAPSULE_TMP) as work:
                atomic_json(Path(work)/'manifest.json',manifest)
                process = subprocess.Popen(['tar','--one-file-system','-czf','-',
                    '-C',str(home.parent),home.name,'-C',str(Path(before['binary']).parent),'uaind',
                    '-C',str(UNIT_FILE.parent),UNIT,'-C',work,'manifest.json'],
                    stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
                try:
                    crypto.seal(process.stdout,temporary,key)
                    if process.wait() != 0 or tree(home) != manifest['tree']:
                        raise ValueError('Stopped node capture changed or failed')
                finally:
                    if process.poll() is None: process.kill(); process.wait()
                    process.stdout.close()
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
        finally:
            recover()
        restarted_at = datetime.datetime.now(datetime.timezone.utc)
        try:
            os.link(temporary,path); temporary.unlink()
            receipt = verify_restore(path,key)
            receipt.update(name=path.name,node_restarted=active(),
                capture_pause_seconds=(restarted_at-stopped_at).total_seconds())
            atomic_json(path.with_suffix('.json'),receipt)
            return receipt
        finally:
            temporary.unlink(missing_ok=True)


def run_capture(key, stamp):
    helper = str(ROLE_HELPER) if role_enabled() else str(HERE/'node.py')
    if role_enabled():
        # Validate the fixed code path before granting the transient process
        # access to the archive key through stdin.
        role_helper()
    args=['systemd-run','--quiet','--wait','--pipe','--collect','--unit=uain-node-backup-capture',
          '--property=MemoryMax=1G','--property=CPUQuota=200%','--property=TasksMax=64',
          '--property=RuntimeMaxSec=900','--property=UMask=0077','--property=LimitCORE=0',
          '--property=ExecStopPost=/usr/bin/python3 '+helper+' recover',
          '/usr/bin/python3',helper,'capture']
    result=subprocess.run(args,input=json.dumps(dict(key=key,stamp=stamp)).encode(),
                          capture_output=True,timeout=960)
    if result.returncode:
        raise ValueError('Scoped node backup capture failed')
    return json.loads(result.stdout)


def prune(keep=14):
    if keep != 14:
        raise ValueError('Retention is fixed at fourteen per host')
    removed=[]
    for host in HOSTS:
        paths=[]
        for path in ROOT.iterdir():
            if not re.fullmatch(NAME,path.name) or not path.name.startswith('uain-node-'+host+'-'):
                continue
            metadata=path.with_suffix('.json')
            if not metadata.is_file() or metadata.is_symlink():
                continue
            receipt=json.loads(metadata.read_text())
            if receipt.get('full_tree_restore_verified') and receipt.get('name')==path.name:
                paths.append(path)
        paths.sort()
        for path in paths[:-keep]:
            # Ciphertext is removed only after the coordinator verifies all destinations.
            archive_path(path.name).unlink(); path.with_suffix('.json').unlink(missing_ok=True);removed.append(path.name)
    sync_directory(ROOT)
    return removed


def main():
    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    if os.geteuid()!=0: raise ValueError('Root required')
    if sys.argv[1:] == ['recover']:
        recover(); return
    if sys.argv[1:] != ['capture']: raise ValueError('Unsupported backup operation')
    request=json.loads(sys.stdin.buffer.readline(131073))
    result=capture(request['key'],request['stamp'])
    print(json.dumps(result))


if __name__ == '__main__':
    def interrupted(signum, frame): raise SystemExit(1)
    signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGINT,interrupted)
    try: main()
    except Exception:
        print('Node backup refused or failed; no secret diagnostic emitted.',file=sys.stderr)
        sys.exit(1)

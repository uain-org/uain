#!/usr/bin/python3 -I
"""Trusted, root-installed CI entry point. Never execute a checkout on the host."""
import hashlib
import base64
import datetime
import fcntl
import json
import io
import os
from pathlib import Path
import pwd
import re
import signal
import selectors
import time
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import uuid

DOCKER = '/usr/bin/docker'
GUARD = '/usr/local/sbin/uain-host-guard'
CHECKOUTS = {'/opt/actions-runner/_work/uain-universa/uain-universa',
             '/opt/actions-runner/_work/uain-ci-qualification/uain-ci-qualification',
             '/opt/actions-runner-uain-2/_work/uain-universa/uain-universa',
             '/opt/actions-runner-uain-3/_work/uain-universa/uain-universa',
             '/opt/actions-runner-uain-4/_work/uain-universa/uain-universa',
             '/opt/actions-runner-uain-5/_work/uain-universa/uain-universa',
             # Pre-push checks run from a developer machine (ops/check.sh), one slot each (9 Nov 2026).
             *(f'/opt/uain-checks/slot-{n}/uain-universa' for n in range(1, 5))}
RUNTIME = '/opt/uain-review-runtime'
PG_IMAGE = 'pgvector/pgvector:0.8.7-pg17@sha256:cd4ccfdaf62cbfeb5c6ee19ef0dd663406d4ed740c320b324d016a90e85385b3'
EXCLUDED = {'.git', '.ssh', '.aws', '.kube', '.gnupg', 'work', 'keys', 'secrets',
            'node_modules', 'dist', 'target', '__pycache__', '.next', '.vinext', '.wrangler',
            '.ci-foreign-wallet-fixture', '.ci-ledger-publication'}
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/nonexistent'}
PUBLICATION = False
LEDGER_PUBLIC_KEY = b'-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAje31vIyrita/VWJVnmVgQkPJjGmH0od88CqK+irV3M8=\n-----END PUBLIC KEY-----\n'
GIB = 2**30
# Scratch accounting (docs/engineering/ci-resources.md). Each run reserves its
# suite's budget from one agreed host total before it creates any resource, so
# concurrent runs cannot claim more than SCRATCH_BUDGET together however many
# runner services exist. Budgets are measured sampled peaks with headroom. The
# 10 GiB disk floor in the host guard is unchanged and still applies to every
# run independently. Over-budget runs are logged; ENFORCE_SCRATCH cancels them.
# Sampled peaks on 6 November 2026: pilot 0.24, research 0.22, others 0.26,
# reset 3.17, site 1.09, native-chain 3.67, private-exchange 0.45 GiB; at most
# 5 concurrent runs, 11.49 GiB together. Budgets are about twice the peak, at
# least 1 GiB; private-exchange keeps extra room for Rust release builds.
# private-exchange 8 GiB (10 November 2026, was 4): once its Rust tests passed again it reached the
# Go module download and build and was cancelled at 4.56 GiB, so the suite had never finished here.
# 16 GiB (9 November 2026, was 40): with the 40 GiB/10% admission floor, admitted
# runs can never take free space below about 29 GiB, clear of kubelet eviction.
SCRATCH_BUDGET = 16*GIB
SUITE_SCRATCH = {'pilot': 1*GIB, 'research': 1*GIB, 'reset': 6*GIB, 'others': 1*GIB,
                 'site': 3*GIB, 'native-chain': 8*GIB, 'private-exchange': 8*GIB,
                 'isolation': 1*GIB, 'ledger-publication': 1*GIB}
# Bounded so an admitted run still finishes inside its workflow timeout.
ADMISSION_WAIT = {'research': 60, 'ledger-publication': 60}
DEFAULT_ADMISSION_WAIT = 180
SCRATCH_SAMPLE_SECONDS = 60
ENFORCE_SCRATCH = True  # a run over its budget is cancelled (9 Nov 2026)
STATE_DIR = '/var/lib/uain-ci'
USAGE_LOG_BYTES = 2**20
RUN_ID = re.compile(r'uain-ci-[0-9a-f]{32}')


def publication_date(value):
    if not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', value): raise ValueError('exact completed publication date required')
    day = datetime.date.fromisoformat(value)
    if day >= datetime.datetime.now(datetime.timezone.utc).date(): raise ValueError('completed publication date required')
    return value


def validate_publication(raw, date):
    from cryptography.hazmat.primitives.serialization import load_pem_public_key
    from cryptography.exceptions import InvalidSignature
    publication_date(date)
    if len(raw) > 4096: raise ValueError('publication byte bound exceeded')
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result: raise ValueError('duplicate publication field')
            result[key] = value
        return result
    try: root = json.loads(raw, object_pairs_hook=unique)
    except (UnicodeError, json.JSONDecodeError): raise ValueError('invalid publication JSON')
    fields = ('date','root','head','count','first_id','last_id','provisional','signature')
    if not isinstance(root,dict) or set(root) != set(fields) or root['date'] != date or root['provisional'] is not False: raise ValueError('exact publication shape/date required')
    count = root['count']
    if type(count) is not int or not 0 <= count <= 9007199254740991: raise ValueError('invalid publication count')
    if count == 0:
        if any(root[k] is not None for k in ('root','head','first_id','last_id')): raise ValueError('invalid empty publication')
    else:
        if any(type(root[k]) is not str or not re.fullmatch(r'[a-f0-9]{64}',root[k]) or root[k]=='0'*64 for k in ('root','head')): raise ValueError('invalid publication hash')
        if any(type(root[k]) is not int or not 1 <= root[k] <= 9007199254740991 for k in ('first_id','last_id')) or root['last_id'] < root['first_id'] or count > root['last_id']-root['first_id']+1: raise ValueError('invalid publication event range')
    if type(root['signature']) is not str or not re.fullmatch(r'[A-Za-z0-9+/]{86}==',root['signature']): raise ValueError('invalid publication signature')
    payload = json.dumps({k:root[k] for k in fields[:6]},separators=(',',':')).encode()
    try: load_pem_public_key(LEDGER_PUBLIC_KEY).verify(base64.b64decode(root['signature'],validate=True),payload)
    except (InvalidSignature,ValueError): raise ValueError('publication signature differs from fixed independent key')
    expected = (json.dumps({k:root[k] for k in fields},indent=2)+'\n').encode()
    if raw != expected: raise ValueError('publication canonical bytes differ')
    return raw


def publication_archive(raw,date):
    if len(raw)>65536: raise ValueError('publication archive byte bound exceeded')
    try:
        with tarfile.open(fileobj=io.BytesIO(raw),mode='r:') as archive:
            members=archive.getmembers()
            if len(members)!=1 or not members[0].isfile() or members[0].name != date+'.json' or members[0].size>4096: raise ValueError('one bounded regular publication file required')
            return validate_publication(archive.extractfile(members[0]).read(4097),date)
    except tarfile.TarError: raise ValueError('invalid publication archive')


def export_publication(container,date):
    # Fixed container path only. Never extract untrusted paths onto the host.
    process=subprocess.Popen([DOCKER,'cp',container+':/work/.ci-ledger-publication/'+date+'.json','-'],env=ENV,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    try:
        deadline=time.monotonic()+30;raw=bytearray()
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout,selectors.EVENT_READ)
            while True:
                remaining=deadline-time.monotonic()
                if remaining<=0 or not selector.select(remaining): raise ValueError('publication export deadline exceeded')
                chunk=os.read(process.stdout.fileno(),min(8192,65537-len(raw)))
                if not chunk: break
                raw.extend(chunk)
                if len(raw)>65536: raise ValueError('publication archive byte bound exceeded')
        if process.wait(timeout=max(.01,deadline-time.monotonic())): raise ValueError('publication export refused')
        return publication_archive(bytes(raw),date)
    finally:
        if process.poll() is None: process.kill();process.wait()
        process.stdout.close()



def parse_suite(args):
    if not args: raise ValueError('suite required')
    suite, *rest = args
    if suite == 'ledger-publication' and len(rest) == 1: return suite, publication_date(rest[0]), '0'
    if suite == 'pilot' and len(rest) == 2 and rest[0] in ('0', '1') and rest[1] in ('1', '2', '3'):
        return suite, *rest
    if suite in ('research', 'reset') and len(rest) == 1 and rest[0] in ('0', '1'):
        return suite, rest[0], '0'
    if suite in ('others', 'site', 'native-chain', 'private-exchange', 'isolation') and not rest:
        return suite, '0', '0'
    raise ValueError('invalid fixed suite arguments')


def validate_source(value, uid, allowed=CHECKOUTS):
    source = Path(value)
    if value not in allowed or str(source.resolve()) != value:
        raise ValueError('checkout must be an exact approved real path')
    for parent in [source, *source.parents]:
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o022:
            raise ValueError('checkout ancestry must be directories without group/world writes')
        if info.st_uid not in (0, uid): raise ValueError('untrusted checkout ancestor owner')
    if source.stat().st_uid != uid: raise ValueError('checkout must belong to runner')
    return source


def excluded(name):
    return (name in EXCLUDED or name.startswith('.env') or name in ('.npmrc', '.netrc', '.gitconfig')
            or name.endswith(('.key', '.pem', '.p12', '.pfx')))


def archive_source(source, stream, uid):
    """Use descriptor-relative no-follow reads; symlink contents remain symlinks."""
    with tarfile.open(fileobj=stream, mode='w|', format=tarfile.PAX_FORMAT) as archive:
        def visit(fd, prefix):
            for name in sorted(os.listdir(fd)):
                if excluded(name) or prefix + name in ('bin', 'chain/bin'): continue
                before = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if before.st_uid != uid or (not stat.S_ISLNK(before.st_mode) and before.st_mode & 0o022):
                    raise ValueError('source ownership or writable mode rejected: ' + prefix + name)
                if stat.S_ISREG(before.st_mode) and before.st_nlink != 1:
                    raise ValueError('hardlinked source file refused: ' + prefix + name)
                entry = tarfile.TarInfo(prefix + name)
                entry.mode = stat.S_IMODE(before.st_mode) & 0o755
                entry.uid = entry.gid = 0
                entry.mtime = 0
                if stat.S_ISLNK(before.st_mode):
                    entry.type = tarfile.SYMTYPE
                    entry.linkname = os.readlink(name, dir_fd=fd)
                    archive.addfile(entry)
                elif stat.S_ISREG(before.st_mode) or stat.S_ISDIR(before.st_mode):
                    flags = os.O_RDONLY | os.O_NOFOLLOW
                    if stat.S_ISDIR(before.st_mode): flags |= os.O_DIRECTORY
                    child = os.open(name, flags, dir_fd=fd)
                    try:
                        after = os.fstat(child)
                        if (before.st_ino, before.st_dev, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_dev, after.st_size, after.st_mtime_ns):
                            raise ValueError('source changed during snapshot')
                        if stat.S_ISDIR(after.st_mode):
                            entry.type = tarfile.DIRTYPE
                            archive.addfile(entry)
                            visit(child, entry.name + '/')
                        else:
                            entry.size = after.st_size
                            with os.fdopen(os.dup(child), 'rb') as contents: archive.addfile(entry, contents)
                    finally: os.close(child)
                else: raise ValueError('special source file refused: ' + entry.name)
        root = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: visit(root, '')
        finally: os.close(root)


def docker(*args, capture=False, check=True, stdin=None, timeout=120, stderr=False):
    command = [DOCKER, *args]
    # Teardown and read-only inspection must remain possible after admission
    # fails. Only monitor commands that allocate/grow this job's resources.
    if args and args[0] in ('run', 'create', 'cp', 'start'):
        command = [GUARD, '--phase', 'ci-'+args[0], '--disk-only',
                   '--timeout', str(timeout), '--watch-command', *command]
        return guarded_command(command, capture=capture, check=check, stdin=stdin, timeout=timeout+30)
    return subprocess.run(command, env=ENV, check=check, stdin=stdin,
                          stdout=subprocess.PIPE if capture else (sys.stderr if PUBLICATION else None),
                          stderr=subprocess.PIPE if stderr else None, text=stdin is None, timeout=timeout)


# CI networks come from a dedicated range, never Docker's default pools: those
# are shared with production compose networks and ran out (9 November 2026,
# "all predefined address pools have been fully subnetted"). One /24 per run,
# 256 runs at once at most; no daemon restart is needed.
CI_SUBNETS = '10.213.%d.0/24'


def create_network(job, network, labels, attempts=256):
    if not RUN_ID.fullmatch(job): raise ValueError('invalid CI run id')
    start = int(job[-8:], 16) % 256
    for offset in range(attempts):
        subnet = CI_SUBNETS % ((start + offset) % 256)
        result = docker('network', 'create', '--subnet', subnet, *labels, network, capture=True, check=False, stderr=True)
        if result.returncode == 0: return subnet
        message = getattr(result, 'stderr', '') or ''
        if 'overlap' not in message.lower():
            raise ValueError('CI network creation failed: ' + message.strip()[:300])
    raise ValueError('CI network range 10.213.0.0/16 is exhausted')


def guarded_command(command, *, capture=False, check=True, stdin=None, timeout=150):
    """Let the guard tear down its child session before launcher cleanup."""
    cancelled = False
    def interrupted(_signal, _frame):
        nonlocal cancelled
        cancelled = True
    previous = {sig:signal.signal(sig,interrupted) for sig in (signal.SIGTERM,signal.SIGINT)}
    process = None
    try:
        if cancelled: raise KeyboardInterrupt()
        process = subprocess.Popen(command, env=ENV, stdin=stdin,
            stdout=subprocess.PIPE if capture else (sys.stderr if PUBLICATION else None),
            text=stdin is None)
        deadline = time.monotonic()+timeout
        while True:
            if cancelled: raise KeyboardInterrupt()
            remaining = deadline-time.monotonic()
            if remaining <= 0: raise subprocess.TimeoutExpired(command,timeout)
            try:
                output,_ = process.communicate(timeout=min(.2,remaining))
                break
            except subprocess.TimeoutExpired: pass
        result = subprocess.CompletedProcess(command,process.returncode,output)
        if check: result.check_returncode()
        return result
    finally:
        try:
            if process is not None and process.poll() is None:
                process.terminate()
                try: process.communicate(timeout=30)
                except subprocess.TimeoutExpired:
                    process.kill();process.communicate()
        finally:
            for sig,handler in previous.items(): signal.signal(sig,handler)
            # Mark the launcher's outer cancellation state so repeated signals
            # cannot interrupt removal of its uniquely named owned resources.
            if cancelled and callable(previous[signal.SIGTERM]):
                previous[signal.SIGTERM](signal.SIGTERM,None)


class BoundedSnapshot:
    """Monitor the actual temporary filesystem and cap source bytes at 1 GiB."""
    def __init__(self, stream): self.stream, self.bytes = stream, 0
    def write(self, data):
        if self.bytes+len(data) > 2**30: raise ValueError('CI snapshot exceeds 1 GiB')
        info = os.fstatvfs(self.stream.fileno())
        total, available = info.f_blocks*info.f_frsize, info.f_bavail*info.f_frsize-len(data)
        if total <= 0 or available < 10*2**30:
            raise ValueError('CI snapshot filesystem reserve failed')
        written = self.stream.write(data)
        self.bytes += written
        return written


def host_admission():
    # This is root-installed code, not an import or command from the checkout.
    path = Path(GUARD)
    for parent in path.parents:
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('host guard ancestry is not root protected')
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError('host guard is not root protected')
    subprocess.run([GUARD, '--phase', 'ci-admission'], env=ENV, check=True, timeout=60,
                   stdout=sys.stderr)


def foreign_wallet_fixture():
    """Public fictional bytes with a real different owner; no test capabilities."""
    stream = tempfile.TemporaryFile()
    with tarfile.open(fileobj=stream, mode='w') as archive:
        entry = tarfile.TarInfo('.ci-foreign-wallet-fixture')
        entry.uid = entry.gid = 65534
        entry.mode = 0o600
        entry.size = 32
        archive.addfile(entry, io.BytesIO(bytes([1]) * 32))
    stream.seek(0)
    return stream


def runtime_image():
    path = Path('/etc/uain-ci/runtime-image')
    parent = path.parent.lstat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != 0 or parent.st_mode & 0o022:
        raise ValueError('runtime configuration directory is not root protected')
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError('runtime image configuration is not root protected')
    image = path.read_text().strip()
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image): raise ValueError('content-addressed runtime image required')
    return image


def run_labels(job, suite):
    """Every run-created resource carries its run id; cleanup selects only it."""
    return ['--label', 'uain.ci.disposable=true', '--label', 'uain.purpose=tests',
            '--label', 'uain.ci.run='+job, '--label', 'uain.ci.suite='+suite]


def cleanup_run(job):
    """Remove only resources labelled with this run id and named under its prefix.

    Returns the names still present afterwards; an empty list means clean."""
    if not RUN_ID.fullmatch(job): raise ValueError('invalid CI run id')
    selector = 'label=uain.ci.run='+job
    listings = {'container': ('ps', '--all', '--filter', selector, '--format', '{{.Names}}'),
                'network': ('network', 'ls', '--filter', selector, '--format', '{{.Name}}'),
                'volume': ('volume', 'ls', '--filter', selector, '--format', '{{.Name}}')}
    removal = {'container': ('rm', '-f', '-v'), 'network': ('network', 'rm'), 'volume': ('volume', 'rm')}
    def owned(kind):
        result = docker(*listings[kind], capture=True, check=False)
        if result.returncode: raise ValueError('owned '+kind+' listing failed')
        names = (result.stdout or '').split()
        foreign = [name for name in names if not name.startswith(job+'-')]
        if foreign:
            # A label alone is not ownership: never remove a differently named resource.
            print('CI cleanup ignored labelled '+kind+'s outside this run: '+' '.join(foreign), file=sys.stderr)
        return [name for name in names if name.startswith(job+'-')]
    remaining = []
    for kind in ('container', 'network', 'volume'):  # containers first: they hold the others
        names = owned(kind)
        if names: docker(*removal[kind], *names, check=False, capture=True)
        remaining += owned(kind)
    return remaining


def process_start(pid):
    """Kernel start time distinguishes a live owner from a reused PID."""
    try: raw = Path('/proc/%d/stat' % pid).read_text()
    except OSError: return None
    return raw.rsplit(')', 1)[1].split()[19]


def owner_alive(owner):
    pid, start = owner
    return type(pid) is int and pid > 0 and start is not None and process_start(pid) == start


class ScratchAdmission:
    """Reservations against one agreed scratch budget, serialized by flock.

    State lives in a directory protected for the launcher's user. Invalid state
    fails closed. A reservation whose owner process is gone is released only
    after that run's labelled resources are removed, so abrupt loss of a
    launcher cannot leak budget or leave its resources behind indefinitely."""
    def __init__(self, directory=STATE_DIR, budget=SCRATCH_BUDGET, alive=owner_alive,
                 cleanup=None, clock=time.monotonic, sleep=time.sleep, poll=5):
        self.directory, self.budget, self.alive = Path(directory), budget, alive
        self.cleanup = cleanup or cleanup_run
        self.clock, self.sleep, self.poll = clock, sleep, poll

    def _protected(self):
        self.directory.mkdir(mode=0o700, exist_ok=True)
        info = self.directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ValueError('CI state directory is not protected')

    def _open(self, name, flags):
        fd = os.open(self.directory/name, flags | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022 or info.st_nlink != 1:
            os.close(fd); raise ValueError('CI state file is not protected: '+name)
        return fd

    @staticmethod
    def _parse(raw):
        if len(raw) > 2**20: raise ValueError('CI scratch state exceeds bound')
        invalid = 'CI scratch state is invalid; inspect labelled runs before repair'
        try: state = json.loads(raw)
        except (UnicodeError, json.JSONDecodeError): raise ValueError(invalid) from None
        if not isinstance(state, dict): raise ValueError(invalid)
        for job, row in state.items():
            if (not RUN_ID.fullmatch(job) or not isinstance(row, dict) or type(row.get('bytes')) is not int
                    or row['bytes'] <= 0 or not isinstance(row.get('owner'), list) or len(row['owner']) != 2):
                raise ValueError(invalid)
        return state

    def _transaction(self, change):
        self._protected()
        lock = self._open('scratch.lock', os.O_RDWR | os.O_CREAT)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                with os.fdopen(self._open('scratch.json', os.O_RDONLY), 'rb') as handle: raw = handle.read(2**20 + 1)
            except FileNotFoundError: raw = b'{}'
            state = self._parse(raw)
            result, changed = change(state)
            if changed:
                temporary = self.directory/('.scratch-%d.json' % os.getpid())
                fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, 'w') as handle:
                    json.dump(state, handle, sort_keys=True); handle.flush(); os.fsync(handle.fileno())
                os.replace(temporary, self.directory/'scratch.json')
            return result
        finally: os.close(lock)

    def _expire(self, state):
        changed = False
        for job, row in list(state.items()):
            if self.alive(tuple(row['owner'])): continue
            try: remaining = self.cleanup(job)
            except (ValueError, OSError, subprocess.SubprocessError) as error:
                print('CI stale run cleanup failed for '+job+': '+str(error), file=sys.stderr); continue
            if remaining:
                print('CI stale run still holds resources: '+job, file=sys.stderr); continue
            print('CI released stale reservation of '+job, file=sys.stderr)
            del state[job]; changed = True
        return changed

    def reserve(self, job, suite, need, owner, wait):
        if not RUN_ID.fullmatch(job): raise ValueError('invalid CI run id')
        if type(need) is not int or not 0 < need <= self.budget:
            raise ValueError('CI scratch admission refused (resource-blocked): suite budget exceeds host budget')
        deadline = self.clock() + wait
        def attempt(state):
            changed = self._expire(state)
            used = sum(row['bytes'] for row in state.values())
            if used + need > self.budget: return used, changed
            state[job] = {'suite': suite, 'bytes': need, 'owner': list(owner), 'at': int(time.time())}
            return None, True
        while True:
            used = self._transaction(attempt)
            if used is None:
                print('CI scratch admitted %s suite=%s reserved=%d budget=%d' % (job, suite, need, self.budget), file=sys.stderr)
                return
            if self.clock() >= deadline:
                raise ValueError('CI scratch admission refused (resource-blocked): %.1f of %.1f GiB reserved, %s needs %.1f GiB'
                                 % (used/GIB, self.budget/GIB, suite, need/GIB))
            self.sleep(max(0, min(self.poll, deadline-self.clock())))

    def release(self, job):
        self._transaction(lambda state: (None, state.pop(job, None) is not None))

    def record(self, row):
        """Append one usage line; one previous generation is kept, so it is bounded."""
        self._protected()
        path = self.directory/'scratch-usage.jsonl'
        try:
            if path.lstat().st_size > USAGE_LOG_BYTES: os.replace(path, self.directory/'scratch-usage.jsonl.1')
        except FileNotFoundError: pass
        with os.fdopen(self._open('scratch-usage.jsonl', os.O_WRONLY | os.O_CREAT | os.O_APPEND), 'a') as handle:
            handle.write(json.dumps(row, sort_keys=True)+'\n')


def tree_bytes(path):
    """Allocated bytes below one volume mountpoint; never follows links or mounts."""
    device, total = os.lstat(path).st_dev, 0
    for directory, names, files in os.walk(path, followlinks=False):
        kept = []
        for name in names + files:
            try: info = os.lstat(os.path.join(directory, name))
            except FileNotFoundError: continue
            if info.st_dev != device: continue
            total += info.st_blocks*512
            if name in names and stat.S_ISDIR(info.st_mode): kept.append(name)
        names[:] = kept
    return total


def scratch_usage(containers, volumes):
    """Bytes in this run's named and anonymous volumes plus writable layers."""
    names, total = set(volumes), 0
    for container in containers:
        result = docker('inspect', '--size', '--format',
                        '{{.SizeRw}} {{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}',
                        container, capture=True, check=False)
        if result.returncode: continue
        size, *mounted = (result.stdout or '0').split() or ['0']
        total += int(size) if size.isdigit() else 0
        names.update(mounted)
    for name in sorted(names):
        result = docker('volume', 'inspect', '--format', '{{.Mountpoint}}', name, capture=True, check=False)
        mountpoint = (result.stdout or '').strip()
        if result.returncode or not mountpoint.startswith('/'): continue
        try: total += tree_bytes(mountpoint)
        except OSError: continue
    return total


class ScratchMonitor:
    """Sample a run's scratch bytes, keep the peak, cancel only when enforced."""
    def __init__(self, job, suite, budget, containers, volumes, interval=SCRATCH_SAMPLE_SECONDS, enforce=None):
        self.job, self.suite, self.budget, self.containers, self.volumes = job, suite, budget, containers, volumes
        self.interval, self.enforce = interval, ENFORCE_SCRATCH if enforce is None else enforce
        self.peak, self.samples, self.exceeded = 0, 0, False
        self.stopped, self.thread = threading.Event(), None

    def sample(self):
        value = scratch_usage(self.containers, self.volumes)
        self.peak, self.samples = max(self.peak, value), self.samples + 1
        if value > self.budget and not self.exceeded:
            self.exceeded = True
            print('CI scratch over budget: %s suite=%s used=%d budget=%d%s' % (self.job, self.suite, value, self.budget,
                  ' (cancelling)' if self.enforce else ' (shadow, not enforced)'), file=sys.stderr, flush=True)
            # The launcher's own cancellation path removes owned resources.
            if self.enforce: os.kill(os.getpid(), signal.SIGTERM)
        return value

    def start(self):
        def loop():
            while not self.stopped.wait(self.interval):
                try: self.sample()
                except (ValueError, OSError, subprocess.SubprocessError): pass
        self.thread = threading.Thread(target=loop, name='scratch-monitor', daemon=True)
        self.thread.start()

    def stop(self):
        self.stopped.set()
        if self.thread is not None: self.thread.join(timeout=30)


def main():
    global PUBLICATION
    runner = pwd.getpwnam('runner').pw_uid
    if os.getuid() != 0 or os.environ.get('SUDO_UID') != str(runner):
        raise ValueError('invoke through sudo as runner')
    if len(sys.argv) < 3: raise ValueError('usage: uain-ci-run CHECKOUT SUITE [THREAD [SHARD]]')
    source = validate_source(sys.argv[1], runner)
    suite, thread, shard = parse_suite(sys.argv[2:])
    PUBLICATION = suite == 'ledger-publication'
    image = runtime_image()
    job = 'uain-ci-' + uuid.uuid4().hex
    network, test, database = job + '-net', job + '-test', job + '-pg'
    work, cache = job + '-work', job + '-cache'
    labels = run_labels(job, suite)
    admission, budget = ScratchAdmission(), SUITE_SCRATCH[suite]
    monitor = ScratchMonitor(job, suite, budget, (test, database), (work, cache))
    owner = (os.getpid(), process_start(os.getpid()))
    if owner[1] is None: raise ValueError('launcher process identity is unavailable')
    cancelled = False
    def interrupted(_signum, _frame):
        nonlocal cancelled
        if cancelled: return
        cancelled = True
        # A second cancellation must not interrupt removal of owned resources.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    reserved = False
    try:
        # Reserve before any resource exists, then run the full host admission.
        admission.reserve(job, suite, budget, owner, ADMISSION_WAIT.get(suite, DEFAULT_ADMISSION_WAIT))
        reserved = True
        host_admission()
        create_network(job, network, labels)
        for volume in (work, cache): docker('volume', 'create', *labels, volume)
        postgres = suite in ('pilot', 'research', 'reset', 'others')
        if postgres:
            docker('run', '-d', '--name', database, *labels,
                   '--network', network, '--network-alias', 'postgres', '--cpus', '2', '--memory', '2g',
                   '--pids-limit', '256', '--security-opt', 'no-new-privileges',
                   '-e', 'POSTGRES_PASSWORD=postgres', '--health-cmd', 'pg_isready -U postgres',
                   '--health-interval', '2s', '--health-timeout', '3s', '--health-retries', '30', PG_IMAGE)
        args = ['create', '--name', test, *labels, '--network', 'container:'+database if postgres else network,
                '--cpus', '2', '--memory', '3g', '--memory-swap', '3g', '--pids-limit', '256',
                '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
                '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', '--mount', 'type=volume,src='+work+',dst=/work',
                '--mount', 'type=volume,src='+cache+',dst=/cache',
                '--mount', 'type=volume,src='+cache+',dst=/opt/uain-test', '--workdir', '/work',
                '--mount', 'type=bind,src='+RUNTIME+'/go1.27.1,dst=/runtime/go,readonly',
                '--mount', 'type=bind,src='+RUNTIME+'/uain-rust/rustup/toolchains/1.89.0-x86_64-unknown-linux-gnu,dst=/runtime/rust,readonly',
                '-e', 'CI=true', '-e', 'HOME=/cache/home', '-e', 'TMPDIR=/cache/tmp',
                '-e', 'GOMAXPROCS=2', '-e', 'GOTOOLCHAIN=local', '-e', 'GOCACHE=/cache/go-build',
                '-e', 'GOMODCACHE=/cache/go-mod', '-e', 'CARGO_HOME=/cache/cargo',
                '-e', 'RUSTC=/runtime/rust/bin/rustc', '-e', 'RUSTFMT=/runtime/rust/bin/rustfmt',
                '-e', 'UAIN_TEST_FOREIGN_KEY_FILE=/work/.ci-foreign-wallet-fixture',
                '-e', 'PATH=/runtime/go/bin:/runtime/rust/bin:/usr/local/bin:/usr/bin:/bin',
                '-e', 'npm_config_cache=/cache/npm', '-e', 'UAIN_WRITE_THREAD='+('1' if thread == '1' else ''),
                '-e', 'UAIN_TEST_PG=postgres://postgres:postgres@127.0.0.1:5432/postgres',
                '-e', 'PGHOST=127.0.0.1', '-e', 'PGUSER=postgres', '-e', 'PGPASSWORD=postgres']
        if PUBLICATION: args += ['-e','UAIN_LEDGER_PUBLICATION_DATE='+thread]
        args += [image, 'bash', '/work/ops/ci/container-suite.sh', suite, shard]
        docker(*args)
        with tempfile.TemporaryFile() as snapshot:
            archive_source(source, BoundedSnapshot(snapshot), runner)
            snapshot.seek(0)
            digest = hashlib.file_digest(snapshot, 'sha256').hexdigest()
            print('CI source snapshot sha256=' + digest + ' suite=' + suite + ' thread=' + thread + ' shard=' + shard, flush=True, file=sys.stderr if PUBLICATION else sys.stdout)
            snapshot.seek(0)
            docker('cp', '-', test + ':/work', stdin=snapshot)
        # Docker extracts this fixed tar before starting untrusted test code.
        # No CAP_CHOWN/SETUID is granted to that code or its namespace.
        with foreign_wallet_fixture() as fixture:
            docker('cp', '-a', '-', test + ':/work', stdin=fixture)
        if postgres:
            # Poll only this disposable container; never consult live database services.
            ready = subprocess.run([DOCKER, 'exec', database, 'sh', '-c',
                'for i in $(seq 1 30); do pg_isready -U postgres && exit 0; sleep 1; done; exit 1'], env=ENV)
            if ready.returncode: raise ValueError('disposable PostgreSQL failed readiness')
        deadline = {'private-exchange': 6600, 'native-chain': 4800, 'research': 1050, 'reset': 2100}.get(suite, 1500)
        monitor.start()
        result = docker('start', '-a', test, check=False, timeout=deadline)
        status = docker('inspect', '--format', '{{.State.ExitCode}}', test, capture=True).stdout.strip()
        if result.returncode or status != '0': raise SystemExit(int(status) or result.returncode or 1)
        if PUBLICATION: sys.stdout.buffer.write(export_publication(test,thread)); sys.stdout.buffer.flush()
    finally:
        monitor.stop()
        if monitor.thread is not None:
            try:
                final = monitor.sample()
                row = {'run': job, 'suite': suite, 'budget': budget, 'peak': monitor.peak, 'final': final,
                       'samples': monitor.samples, 'over_budget': monitor.exceeded, 'at': int(time.time())}
                print('CI scratch ' + json.dumps(row, sort_keys=True), file=sys.stderr, flush=True)
                admission.record(row)
            except (ValueError, OSError, subprocess.SubprocessError) as error:
                print('CI scratch measurement failed: ' + str(error), file=sys.stderr)
        if reserved:
            # Test processes may ignore signals; Docker force-removes their namespaces.
            for container in (test, database): docker('rm', '-f', '-v', container, check=False, capture=True)
            docker('network', 'rm', network, check=False, capture=True)
            for volume in (work, cache): docker('volume', 'rm', volume, check=False, capture=True)
            # Sweep anything else labelled with this run id, and only this run id.
            try: remaining = cleanup_run(job)
            except (ValueError, OSError, subprocess.SubprocessError) as error: remaining = ['unverified: ' + str(error)]
            if remaining:
                # Keep the reservation: the next admission retries this run's cleanup.
                print('CI cleanup incomplete for ' + job + ': ' + ' '.join(remaining), file=sys.stderr)
            else:
                try: admission.release(job)
                except (ValueError, OSError) as error: print('CI reservation release failed: ' + str(error), file=sys.stderr)

if __name__ == '__main__':
    try: main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print('CI launcher refused or failed: ' + str(error), file=sys.stderr)
        sys.exit(1)

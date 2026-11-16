"""Guarded installer for a private payment service release (root, uain-app-1).

Installs a new custody worker source release, its policy, and the matching
`private_payment_service.py` and `public_review_dispatch.py`, under the service
lock, with backups and automatic restore if the health check fails. It never
reads the vault, signs, broadcasts or touches native state.

  /opt/uain-custody/venv/bin/python install_private_payment_release.py STAGE \
      CURRENT_SERVICE_SHA CURRENT_DISPATCH_SHA [--coin-wallet PATH] [--yes]

--coin-wallet moves the policy's coin wallet pin to PATH (root-owned, never
group or world writable); its SHA-256 must equal the staged service's
PINS['coin-wallet'], so a tool change always ships with the service that pins it.

STAGE holds `private_payment_service.py`, `public_review_dispatch.py` and
`source/<path>` for every SOURCE_FILES entry of the staged service. Files the
staged release does not change should be copied from the live release so their
bytes stay identical. Without --yes it prints the plan and changes nothing.
"""
import datetime, fcntl, hashlib, json, os, shutil, stat, subprocess, sys, time, types
from pathlib import Path

CUSTODY = Path('/opt/uain-custody')
SERVICE = CUSTODY / 'private_payment_service.py'
DISPATCH = CUSTODY / 'public_review_dispatch.py'
POLICY = Path('/etc/uain-custody/private-payment-service.json')
RELEASES = Path('/opt/uain-private-payment-service/releases')
LOCK = Path('/var/lib/uain-custody/private-payment-service/service.lock')
BACKUPS = Path('/var/backups/uain-custody')
PYTHON = '/opt/uain-custody/venv/bin/python'
ZERO = '0' * 32


def fail(message):
    raise SystemExit('install refused: ' + message)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def trusted(path):
    for p in [Path(path), *Path(path).parents]:
        s = p.lstat()
        if stat.S_ISLNK(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022:
            fail('untrusted path ' + str(p))


def load_module(path):
    sys.path.insert(0, str(CUSTODY))
    module = types.ModuleType('_staged_private_payment_service')
    module.__file__ = str(path)
    exec(compile(Path(path).read_bytes(), str(path), 'exec'), module.__dict__)
    return module


def atomic_copy(source, target, mode=0o600):
    temp = target.with_name(target.name + '.installing')
    if temp.exists():
        temp.unlink()
    shutil.copyfile(source, temp)
    os.chown(temp, 0, 0)
    os.chmod(temp, mode)
    with open(temp, 'rb') as f:
        os.fsync(f.fileno())
    os.replace(temp, target)
    fd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def health():
    env = {'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent', 'SSH_ORIGINAL_COMMAND': 'baink-private-review health ' + ZERO}
    out = subprocess.run([PYTHON, str(DISPATCH)], input=b'', stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, timeout=90)
    if out.returncode:
        return None
    return json.loads(out.stdout)


def main(argv):
    if os.geteuid() != 0:
        fail('root required')
    args = list(argv[4:])
    apply = '--yes' in args
    if apply:
        args.remove('--yes')
    coin_wallet = None
    if args[:1] == ['--coin-wallet'] and len(args) == 2:
        coin_wallet = Path(args[1])
        args = []
    if len(argv) < 4 or args:
        fail(__doc__)
    stage, current_service, current_dispatch = Path(argv[1]).resolve(), argv[2], argv[3]
    trusted(stage)
    if sha(SERVICE) != current_service or sha(DISPATCH) != current_dispatch:
        fail('live service or dispatcher differs from the expected current bytes')
    staged_service, staged_dispatch = stage / 'private_payment_service.py', stage / 'public_review_dispatch.py'
    service = load_module(staged_service)
    dispatch_text = staged_dispatch.read_text()
    service_sha = sha(staged_service)
    if "SERVICE_SHA = '%s'" % service_sha not in dispatch_text:
        fail('staged dispatcher does not pin the staged service')
    manifest = {}
    for name in sorted(service.SOURCE_FILES):
        path = stage / 'source' / name
        trusted(path)
        manifest[name] = sha(path)
    release = RELEASES / hashlib.sha256(service.bytes_json(manifest)).hexdigest()
    policy = json.loads(POLICY.read_text())
    new_policy = dict(policy, source=str(release), source_sha256=manifest)
    if coin_wallet is not None:
        if not coin_wallet.is_absolute() or coin_wallet.resolve() != coin_wallet:
            fail('coin wallet path must be absolute and canonical')
        trusted(coin_wallet)
        if sha(coin_wallet) != service.PINS['coin-wallet']:
            fail('coin wallet differs from the staged service pin')
        new_policy['tools'] = dict(policy['tools'], coinWallet={'executable': str(coin_wallet), 'executableSha256': sha(coin_wallet)})
    plan = {'release': str(release), 'serviceSha256': service_sha, 'dispatchSha256': sha(staged_dispatch), 'sourceSha256': manifest,
            'changedSources': sorted(k for k in manifest if policy['source_sha256'].get(k) != manifest[k]),
            'policyChangedFields': sorted(k for k in new_policy if new_policy[k] != policy.get(k))}
    print(json.dumps(plan, indent=1, sort_keys=True))
    if not apply:
        print('dry run: nothing changed')
        return
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = BACKUPS / ('private-payment-release-' + stamp)
    backup.mkdir(parents=True, mode=0o700)
    for path in (SERVICE, DISPATCH, POLICY):
        shutil.copy2(path, backup / path.name)
    if release.exists():
        for name, pin in manifest.items():
            if sha(release / name) != pin:
                fail('existing release directory differs')
    else:
        temp = release.with_name(release.name + '.installing')
        if temp.exists():
            shutil.rmtree(temp)
        for name in manifest:
            target = temp / name
            target.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
            shutil.copyfile(stage / 'source' / name, target)
            os.chmod(target, 0o600)
        for d in [temp, *[p for p in temp.rglob('*') if p.is_dir()]]:
            os.chmod(d, 0o700)
        os.replace(temp, release)
    service.validate_policy(new_policy, check_files=False)
    with open(LOCK, 'r+b') as lock:
        deadline = time.monotonic() + 120
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() > deadline:
                    fail('service busy for 120 s; nothing swapped')
                time.sleep(0.5)
        policy_temp = stage / 'policy.json'
        policy_temp.write_text(json.dumps(new_policy, indent=2) + '\n')
        atomic_copy(policy_temp, POLICY)
        atomic_copy(staged_service, SERVICE)
        atomic_copy(staged_dispatch, DISPATCH)
    result = None
    try:
        service.validate_policy(json.loads(POLICY.read_text()), check_files=True)
        result = health()
    except Exception as error:
        print('post-install check failed: ' + type(error).__name__)
    if not result or result.get('status') != 'ready':
        for path in (SERVICE, DISPATCH, POLICY):
            atomic_copy(backup / path.name, path)
        fail('health check failed after install; previous service, dispatcher and policy restored from ' + str(backup))
    (release / 'adoption.json').write_text(json.dumps({'action': 'install-private-payment-release', 'time': stamp, 'previousPolicySource': policy['source'], 'serviceSha256': service_sha, 'dispatchSha256': sha(DISPATCH), 'backup': str(backup), 'health': {k: result.get(k) for k in ('status', 'height', 'reviewer', 'chainId')}, 'mint': False, 'payment': False, 'privateKeysExported': False}, indent=1) + '\n')
    os.chmod(release / 'adoption.json', 0o600)
    print(json.dumps({'installed': True, 'backup': str(backup), 'health': result.get('status'), 'height': result.get('height')}))


if __name__ == '__main__':
    main(sys.argv)

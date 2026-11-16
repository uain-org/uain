#!/usr/bin/env python3
"""Root-operated guarded BAINK code rollback to a retained release.

Usage: baink-rollback-release.py TARGET EXPECTED_CURRENT --yes

Switches /opt/baink/current and the preview pointer back to a release that
activate-release.py left in /opt/baink/releases, after verifying every file of
the target against its manifest. It takes the same activation lock, refuses
unless the current release equals EXPECTED_CURRENT, backs up (never restores)
state and environment, and health-checks. On a failed health check it switches
back to EXPECTED_CURRENT. It never deletes a release, never restores state.json,
journals or /etc/baink.env, and never touches native or financial state.
"""
import fcntl, hashlib, json, os, pathlib, re, shutil, subprocess, sys, time, urllib.request

RELEASE = re.compile(r'\d{8}T\d{6}Z-[a-f0-9]{10}')
PATHS = {
    'staging': pathlib.Path('/var/lib/baink-deployments'),
    'current': pathlib.Path('/opt/baink/current'),
    'releases': pathlib.Path('/opt/baink/releases'),
    'preview': pathlib.Path('/var/www/baink-preview/baink'),
    'backups': pathlib.Path('/var/backups/baink'),
    'state': pathlib.Path('/var/lib/baink'),
    'env': pathlib.Path('/etc/baink.env'),
}


class Refused(Exception):
    pass


def systemctl(*args):
    subprocess.run(['systemctl', *args], check=True, stdout=subprocess.DEVNULL)


def healthy():
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen('http://127.0.0.1:8798/api/health', timeout=2) as response:
                if response.status == 200 and json.load(response).get('ok') is True:
                    return True
        except Exception:
            time.sleep(0.3)
    return False


def switch(link, target, tag):
    temp = link.with_name(link.name + '.rollback-' + tag)
    if temp.exists() or temp.is_symlink():
        raise Refused('Temporary link %s exists; inspect before retrying.' % temp)
    os.symlink(str(target), temp)
    os.replace(temp, link)


def verify_retained(directory, release):
    if directory.is_symlink() or not directory.is_dir():
        raise Refused('Target %s is not a retained release directory.' % release)
    manifest = json.loads((directory / 'release-manifest.json').read_text())
    if manifest.get('release') != release or not re.fullmatch(r'0\.3\.\d+', str(manifest.get('version'))):
        raise Refused('Target manifest does not match the release id or 0.3.x.')
    expected = {**manifest['files'], **{'preview/' + k: v for k, v in manifest['preview_files'].items()}}
    actual = {str(p.relative_to(directory)) for p in directory.rglob('*') if p.is_file()}
    if actual != set(expected) | {'release-manifest.json'}:
        raise Refused('Target file set differs from its manifest.')
    for name, digest in expected.items():
        path = directory / name
        if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise Refused('Target file %s fails its manifest hash.' % name)
    return manifest


def rollback(target, expected_current, paths=PATHS, control=systemctl, probe=healthy, tag=None):
    if not RELEASE.fullmatch(target) or not RELEASE.fullmatch(expected_current) or target == expected_current:
        raise Refused('Invalid release ids.')
    tag = tag or time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    with open(paths['staging'] / 'activation.lock', 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refused('Another activation or rollback holds the lock.')
        return _locked(target, expected_current, paths, control, probe, tag)


def _locked(target, expected_current, paths, control, probe, tag):
    current = paths['current']
    old = current.resolve()
    if old.name != expected_current:
        raise Refused('Current release is %s, expected %s.' % (old.name, expected_current))
    new = paths['releases'] / target
    manifest = verify_retained(new, target)
    preview = paths['preview']
    if not preview.is_symlink():
        raise Refused('Preview %s is not a symlink; switch it by hand per the release runbook.' % preview)
    preview_old = pathlib.Path(os.readlink(preview))
    if not (new / 'preview').is_dir():
        raise Refused('Target has no preview directory.')
    backup = paths['backups'] / ('rollback-%s-to-%s-%s' % (expected_current, target, tag))
    backup.mkdir(mode=0o700, parents=False)
    stopped = switched = False
    try:
        control('stop', 'baink.service')
        stopped = True
        # Backup only: rollback never restores state, journals or environment.
        for src in [paths['state'] / 'state.json', paths['env'], paths['state'] / 'management.sqlite', paths['state'] / 'management-plans.json']:
            if src.is_file() and not src.is_symlink():
                shutil.copy2(src, backup / src.name)
                os.chmod(backup / src.name, 0o600)
        switch(current, new, tag)
        switched = True
        control('start', 'baink.service')
        if not probe():
            raise Refused('Target release failed its health check; restored %s.' % expected_current)
        switch(preview, new / 'preview', tag)
    except BaseException:
        if stopped:
            subprocess_safe(control, 'stop', 'baink.service')
            if switched:
                switch(current, old, tag + '-revert')
            control('start', 'baink.service')
        raise
    return {
        'rolledBackTo': target,
        'from': expected_current,
        'version': manifest['version'],
        'previewFrom': str(preview_old),
        'backup': str(backup),
        'healthy': True,
        'stateRestored': False,
    }


def subprocess_safe(control, *args):
    try:
        control(*args)
    except Exception:
        pass


def main(argv):
    if len(argv) != 3 or argv[2] != '--yes':
        print('Usage: baink-rollback-release.py TARGET EXPECTED_CURRENT --yes', file=sys.stderr)
        return 2
    if os.geteuid() != 0:
        print('Run as root on the BAINK host.', file=sys.stderr)
        return 2
    try:
        print(json.dumps(rollback(argv[0], argv[1])))
        return 0
    except Refused as error:
        print('refused: %s' % error, file=sys.stderr)
        return 3


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

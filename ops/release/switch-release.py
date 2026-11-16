#!/usr/bin/env python3
"""Root-operated guarded release switch for custody-installed services.

Two modes, both refusing unless the live release equals --from:

  switch-release.py unit --unit NAME --unit-file PATH --root DIR --from ID --to ID [--yes]
      Repoints every `DIR/<from>/ENTRY` path in the unit's ExecStart lines to
      `DIR/<to>/ENTRY` (--entry, default empty; other release paths such as
      a pinned runtime are left alone), reloads systemd, restarts the unit and requires it to stay
      active for --settle seconds with no automatic restart. On failure the
      original unit file is restored and the unit restarted (automatic rollback).

  switch-release.py symlink --link PATH --root DIR --from ID --to ID
                            [--lock PATH] [--pause-timer T]... [--idle-unit U]...
                            [--check-unit U] [--yes]
      Swaps PATH (a `current` symlink) to DIR/<to> under the release lock, with
      the named timers paused and the named oneshot units idle. If --check-unit
      is given it is started once and must succeed, otherwise the link is
      switched back and the check re-run (automatic rollback). Timers that were
      active are always restarted.

Without --yes it prints the plan and changes nothing. Ids are 40 or 64
lowercase hex characters. It never deletes a release, never touches state,
configuration other than the one unit file, keys, or native/financial state.
Prints one JSON line. Exit codes: 0 switched or dry run, 2 refused (nothing
changed), 1 failed and restored, 3 failed and restore not confirmed.
"""
import argparse, fcntl, json, os, pathlib, re, shutil, subprocess, sys, time

ID = re.compile(r'[a-f0-9]{40}|[a-f0-9]{64}')


class Refused(Exception):
    pass


class Restored(Exception):
    pass


class Unknown(Exception):
    pass


def make_systemctl(binary='systemctl'):
    def control(*args, check=True):
        out = subprocess.run([binary, *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=600)
        if check and out.returncode:
            raise subprocess.CalledProcessError(out.returncode, [binary, *args], out.stdout, out.stderr)
        return out.stdout.strip()
    return control


def check_ids(prior, target):
    if not ID.fullmatch(prior or '') or not ID.fullmatch(target or '') or prior == target:
        raise Refused('Pass distinct --from and --to release ids (40 or 64 lowercase hex).')


def check_release_dir(root, release):
    path = root / release
    if path.is_symlink() or not path.is_dir():
        raise Refused('%s is not a retained release directory.' % path)
    info = path.stat()
    if info.st_mode & 0o022:
        raise Refused('%s is group or world writable.' % path)
    if os.geteuid() == 0 and info.st_uid != 0:
        raise Refused('%s is not owned by root.' % path)
    return path


def exec_lines(text):
    return [i for i, line in enumerate(text.split('\n')) if re.match(r'\s*ExecStart(Pre|Post)?=', line)]


def rewrite_unit(text, root, prior, target, entry=''):
    old, new = '%s/%s/%s' % (root, prior, entry), '%s/%s/%s' % (root, target, entry)
    lines = text.split('\n')
    indices = exec_lines(text)
    if not any(old in lines[i] for i in indices):
        live = sorted({m for i in indices for m in re.findall(re.escape(str(root)) + r'/([a-f0-9]{40,64})/' + re.escape(entry), lines[i])})
        raise Refused('Unit runs %s, expected %s.' % (', '.join(live) or 'no release under ' + str(root), prior))
    paths = []
    for i in indices:
        lines[i] = lines[i].replace(old, new)
        paths += [p for p in re.findall(r'(?:^|[\s=])(/\S+)', lines[i]) if p.startswith(new)]
    for p in paths:
        if not pathlib.Path(p).exists():
            raise Refused('Target release lacks %s.' % p)
    return '\n'.join(lines), paths


def stays_active(control, unit, timeout, settle, sleep=time.sleep):
    for attempt in range(max(1, int(timeout * 2))):
        if control('is-active', unit, check=False) == 'active':
            break
        sleep(0.5)
    else:
        return False
    restarts = control('show', '-p', 'NRestarts', '--value', unit, check=False)
    sleep(settle)
    return (control('is-active', unit, check=False) == 'active'
            and control('show', '-p', 'NRestarts', '--value', unit, check=False) == restarts)


def write_atomic(path, text, like):
    temp = path.with_name(path.name + '.switching')
    if temp.exists():
        raise Refused('Temporary file %s exists; inspect before retrying.' % temp)
    temp.write_text(text)
    info = like.stat()
    os.chmod(temp, info.st_mode & 0o7777)
    if os.geteuid() == 0:
        os.chown(temp, info.st_uid, info.st_gid)
    os.replace(temp, path)


def switch_unit(args, control, sleep=time.sleep, stamp=None):
    check_ids(args.prior, args.target)
    root = pathlib.Path(args.root)
    unit_file = pathlib.Path(args.unit_file)
    if not unit_file.is_file() or unit_file.is_symlink():
        raise Refused('%s is not a regular unit file.' % unit_file)
    check_release_dir(root, args.target)
    text = unit_file.read_text()
    new_text, paths = rewrite_unit(text, root, args.prior, args.target, args.entry)
    plan = {'mode': 'unit', 'unit': args.unit, 'from': args.prior, 'to': args.target, 'paths': paths}
    if not args.yes:
        return dict(plan, state='dry-run')
    lock_path = pathlib.Path(args.lock or '/run/lock/uain-release-%s.lock' % args.unit)
    with open(lock_path, 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refused('Another switch of %s holds %s.' % (args.unit, lock_path))
        backups = pathlib.Path(args.backup_dir)
        backups.mkdir(mode=0o700, parents=True, exist_ok=True)
        backup = backups / ('%s-%s-%s' % (args.unit, args.prior[:12], stamp or time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())))
        shutil.copy2(unit_file, backup)
        os.chmod(backup, 0o600)
        plan['backup'] = str(backup)
        write_atomic(unit_file, new_text, backup)
        try:
            control('daemon-reload')
            control('restart', args.unit)
            ok = stays_active(control, args.unit, args.timeout, args.settle, sleep)
        except Exception:
            ok = False
        if ok:
            return dict(plan, state='switched')
        write_atomic(unit_file, text, backup)
        try:
            control('daemon-reload')
            control('restart', args.unit)
            restored = stays_active(control, args.unit, args.timeout, args.settle, sleep)
        except Exception:
            restored = False
        if restored:
            raise Restored(json.dumps(dict(plan, state='restored', detail='%s did not stay active on %s; restored %s' % (args.unit, args.target, args.prior))))
        raise Unknown(json.dumps(dict(plan, state='unknown', detail='restore of %s not confirmed active' % args.prior)))


def current_of(link, root):
    if not link.is_symlink():
        raise Refused('%s is not a symlink.' % link)
    resolved = pathlib.Path(os.path.realpath(link))
    if resolved.parent != pathlib.Path(os.path.realpath(root)):
        raise Refused('%s points outside %s.' % (link, root))
    return resolved.name


def switch_link(link, target, tag):
    temp = link.with_name(link.name + '.switch-' + tag)
    if temp.exists() or temp.is_symlink():
        raise Refused('Temporary link %s exists; inspect before retrying.' % temp)
    os.symlink(str(target), temp)
    os.replace(temp, link)


def run_check(control, unit):
    try:
        control('start', unit)
    except Exception:
        return False
    return control('show', '-p', 'Result', '--value', unit, check=False) == 'success'


def switch_symlink(args, control, sleep=time.sleep, stamp=None):
    check_ids(args.prior, args.target)
    root, link = pathlib.Path(args.root), pathlib.Path(args.link)
    live = current_of(link, root)
    if live != args.prior:
        raise Refused('Current release is %s, expected %s.' % (live, args.prior))
    target = check_release_dir(root, args.target)
    plan = {'mode': 'symlink', 'link': str(link), 'from': args.prior, 'to': args.target,
            'pauseTimers': args.pause_timer, 'idleUnits': args.idle_unit, 'checkUnit': args.check_unit}
    if not args.yes:
        return dict(plan, state='dry-run')
    tag = stamp or time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    lock_path = pathlib.Path(args.lock or str(link.parent / '.release.lock'))
    with open(lock_path, 'a') as lock:
        deadline = time.monotonic() + 120
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() > deadline:
                    raise Refused('Release lock %s busy for 120 s; nothing switched.' % lock_path)
                sleep(0.5)
        if current_of(link, root) != args.prior:
            raise Refused('Current release changed while waiting for the lock.')
        paused = []
        try:
            for timer in args.pause_timer:
                if control('is-active', timer, check=False) == 'active':
                    control('stop', timer)
                    paused.append(timer)
            for unit in args.idle_unit:
                waited = 0
                while control('is-active', unit, check=False) in ('active', 'activating', 'deactivating', 'reloading'):
                    if waited >= args.timeout:
                        raise Refused('%s stayed busy for %d s; nothing switched.' % (unit, args.timeout))
                    sleep(1)
                    waited += 1
            switch_link(link, target, tag)
            if not args.check_unit or run_check(control, args.check_unit):
                return dict(plan, state='switched')
            switch_link(link, root / args.prior, tag + '-revert')
            if run_check(control, args.check_unit):
                raise Restored(json.dumps(dict(plan, state='restored', detail='%s failed on %s; switched back to %s' % (args.check_unit, args.target, args.prior))))
            raise Unknown(json.dumps(dict(plan, state='unknown', detail='switched back to %s but %s still fails' % (args.prior, args.check_unit))))
        finally:
            for timer in paused:
                try:
                    control('start', timer)
                except Exception:
                    pass


def parser():
    p = argparse.ArgumentParser(add_help=True)
    sub = p.add_subparsers(dest='mode', required=True)
    for name in ('unit', 'symlink'):
        s = sub.add_parser(name)
        s.add_argument('--root', required=True)
        s.add_argument('--from', dest='prior', required=True)
        s.add_argument('--to', dest='target', required=True)
        s.add_argument('--lock')
        s.add_argument('--timeout', type=int, default=60)
        s.add_argument('--systemctl', default='systemctl')
        s.add_argument('--yes', action='store_true')
    u = sub.choices['unit']
    u.add_argument('--unit', required=True)
    u.add_argument('--unit-file', required=True)
    u.add_argument('--settle', type=float, default=5.0)
    u.add_argument('--entry', default='', help='only paths under <root>/<id>/ENTRY are switched')
    u.add_argument('--backup-dir', default='/var/backups/uain-release')
    s = sub.choices['symlink']
    s.add_argument('--link', required=True)
    s.add_argument('--pause-timer', action='append', default=[])
    s.add_argument('--idle-unit', action='append', default=[])
    s.add_argument('--check-unit')
    return p


def main(argv, control=None, sleep=time.sleep):
    args = parser().parse_args(argv)
    control = control or make_systemctl(args.systemctl)
    try:
        result = (switch_unit if args.mode == 'unit' else switch_symlink)(args, control, sleep)
        print(json.dumps(result))
        return 0
    except Refused as error:
        print(json.dumps({'state': 'refused', 'detail': str(error)}))
        return 2
    except Restored as error:
        print(str(error))
        return 1
    except Unknown as error:
        print(str(error))
        return 3


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

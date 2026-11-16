#!/usr/bin/python3 -I
"""Shared-host admission and monitored commands. Based on AGA PR762 (1118d0b5)."""
import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
import uuid
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, build_opener

GIB = 2**30
# Admission floor (9 November 2026): above the kubelet's 5% hard-eviction line
# (about 23 GB here) plus the whole CI scratch budget. A 10 GiB floor let
# concurrent runs fill the disk; DiskPressure evicted production pods and
# blocked rescheduling (uain.global 502 from about 11:57 to 12:11 UTC).
MIN_FREE_GIB = 40
MIN_FREE_PERCENT = 10
DOCKER = '/usr/bin/docker'
HEALTH_URLS = ('https://uain.global/', 'https://uain.global/api/ready', 'https://uain.global/for-ai')


def check_disk(total, available):
    if type(total) is not int or type(available) is not int or total <= 0 or not 0 <= available <= total:
        raise ValueError('Filesystem capacity is unavailable or invalid')
    if available < MIN_FREE_GIB*GIB or available*100 < total*MIN_FREE_PERCENT:
        raise ValueError(f'Shared disk reserve failed: {available/GIB:.2f} GiB, {available*100/total:.2f}% available; require {MIN_FREE_GIB} GiB and {MIN_FREE_PERCENT}%')


def check_node(node):
    rows = node.get('status',{}).get('conditions',[])
    conditions = {c.get('type'): c.get('status') for c in rows}
    if len(conditions) != len(rows):
        raise ValueError('Duplicate Kubernetes node conditions')
    if conditions.get('Ready') != 'True' or conditions.get('DiskPressure') != 'False':
        raise ValueError('Shared Kubernetes node is unready, under disk pressure, or missing condition data')
    if any(t.get('key') == 'node.kubernetes.io/disk-pressure' for t in node.get('spec',{}).get('taints',[])):
        raise ValueError('Shared Kubernetes disk-pressure taint is still present')


def _command(args):
    try:
        return subprocess.check_output(args, text=True, timeout=20, stderr=subprocess.DEVNULL).strip()
    except (OSError, subprocess.SubprocessError):
        raise ValueError('Shared-host diagnostic command failed') from None


def docker_root():
    root = _command(['/usr/bin/docker','info','--format','{{.DockerRootDir}}'])
    if not os.path.isabs(root) or '\n' in root:
        raise ValueError('Docker storage root is unavailable')
    return root


def disk_state(root=None):
    root = root or docker_root()
    stat = os.statvfs(root)
    # Use available blocks, not root-reserved free blocks or Docker cache totals.
    return stat.f_blocks*stat.f_frsize, stat.f_bavail*stat.f_frsize


def node_state():
    try:
        return json.loads(_command(['/usr/local/bin/kubectl','get','node','uain-app-1','-o','json']))
    except ValueError:
        raise ValueError('Shared Kubernetes node state could not be read') from None


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def http_status(url):
    try:
        with build_opener(ProxyHandler({}),NoRedirect()).open(url,timeout=10) as response:
            return response.status
    except HTTPError as exc:
        return exc.code
    except (OSError,URLError):
        return None


def verify():
    total,available = disk_state()
    check_disk(total,available)
    check_node(node_state())
    statuses = {url:http_status(url) for url in HEALTH_URLS}
    if any(status != 200 for status in statuses.values()):
        raise ValueError('Shared UAIN public health checks failed: '+json.dumps(statuses))
    return {'available_gib':available/GIB,'available_percent':available*100/total,
            'disk_pressure':False,'http_statuses':statuses}


def cleanup_owned_containers(run_id):
    """Remove only this watchdog's labelled containers, outside the child group."""
    selector = 'label=uain.guard.run='+run_id
    def owned():
        result = subprocess.run([DOCKER,'ps','--all','--quiet','--no-trunc','--filter',selector],
            check=True,capture_output=True,text=True,timeout=20)
        ids = result.stdout.split()
        if any(not re.fullmatch(r'[a-f0-9]{64}',value) for value in ids):
            raise ValueError('Invalid owned container ID')
        return ids
    ids = owned()
    if ids:
        subprocess.run([DOCKER,'rm','--force','--volumes',*ids],check=True,timeout=30,stdout=sys.stderr)
    if owned(): raise ValueError('Owned container cleanup did not complete')


def run_monitored(command, interval=2, timeout=None, cleanup_labelled=False):
    """Cancel only our child process group if the disk reserve is breached."""
    root = docker_root()
    check_disk(*disk_state(root))
    deadline = None if timeout is None else time.monotonic()+timeout
    run_id = uuid.uuid4().hex if cleanup_labelled else None
    cancelled = False
    def cancel(signum, frame):
        nonlocal cancelled
        # Do not raise between child creation and handle assignment, or while
        # cleaning up. Repeated cancellation must not interrupt group teardown.
        cancelled = True
    previous = {sig:signal.signal(sig,cancel) for sig in (signal.SIGTERM,signal.SIGINT)}
    process = None
    try:
        if cancelled:
            raise KeyboardInterrupt
        child_env = {**os.environ,'UAIN_GUARD_RUN_ID':run_id} if run_id else None
        process = subprocess.Popen(command,start_new_session=True,env=child_env)
        while process.poll() is None:
            if cancelled:
                raise KeyboardInterrupt
            if deadline is not None and time.monotonic() >= deadline:
                raise ValueError('Monitored command deadline exceeded')
            check_disk(*disk_state(root))
            time.sleep(interval)
        if cancelled:
            raise KeyboardInterrupt
        if process.returncode:
            raise subprocess.CalledProcessError(process.returncode,command)
    finally:
        try:
            if process is not None:
                try:
                    os.killpg(process.pid,signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    pass
                finally:
                    # A shell leader may exit before its Docker/buildx child.
                    # Kill any remaining members even after leader completion.
                    try:
                        os.killpg(process.pid,signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait(timeout=5)
                if run_id: cleanup_owned_containers(run_id)
        finally:
            for sig,handler in previous.items():
                signal.signal(sig,handler)


def main(argv=None):
    # argparse treats a literal '--' specially even with REMAINDER. Split the
    # command first so bash/tar/other child arguments reach exec unchanged.
    argv = list(sys.argv[1:] if argv is None else argv)
    command = None
    if '--watch-command' in argv:
        boundary = argv.index('--watch-command')
        command, argv = argv[boundary+1:], argv[:boundary]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase',required=True)
    parser.add_argument('--disk-only',action='store_true',help='Disk-only monitoring after a caller has performed full admission')
    parser.add_argument('--timeout',type=float)
    parser.add_argument('--cleanup-labelled-containers',action='store_true')
    parser.add_argument('--watch-command',nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    if args.watch_command is not None:
        parser.error('Use a separate --watch-command argument')
    args.watch_command = command
    try:
        if args.timeout is not None and (not 0 < args.timeout <= 7200):
            raise ValueError('Timeout must be positive and at most 7200 seconds')
        def admission():
            if not args.disk_only:
                return verify()
            total,available=disk_state();check_disk(total,available)
            return {'available_gib':available/GIB,'available_percent':available*100/total}
        report = admission()
        print(json.dumps({'phase':args.phase,**report}),flush=True,file=sys.stderr)
        if args.watch_command is not None:
            if not args.watch_command:
                raise ValueError('A monitored command is required')
            run_monitored(args.watch_command,timeout=args.timeout,cleanup_labelled=args.cleanup_labelled_containers)
            print(json.dumps({'phase':args.phase+'-complete',**admission()}),flush=True,file=sys.stderr)
        return 0
    except KeyboardInterrupt:
        print('Shared-host deployment command cancelled',file=sys.stderr)
        return 130
    except subprocess.CalledProcessError as exc:
        print('Monitored command failed',file=sys.stderr)
        return exc.returncode if 0 < exc.returncode < 126 else 1
    except (ValueError,OSError,TypeError,KeyError,subprocess.SubprocessError) as exc:
        print('Shared-host guard failed: '+str(exc),file=sys.stderr)
        return 1


if __name__=='__main__':
    raise SystemExit(main())

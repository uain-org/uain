"""Kernel locks lease persistent slots across Compose replicas and crashes."""
import fcntl
import os
import pathlib
import subprocess
import sys
import signal

root = pathlib.Path('/home/uain/.uain')
root.mkdir(mode=0o700, exist_ok=True)
os.chmod(root, 0o700)
slots = root / 'slots'
slots.mkdir(mode=0o700, exist_ok=True)
requested = os.environ.get('UAIN_SLOT', '')
if requested and (not requested.isdigit() or not 1 <= int(requested) <= 256):
    sys.exit('UAIN_SLOT must be between 1 and 256')
for number in ([int(requested)] if requested else range(1, 257)):
    lock = open(slots / f'.runner-{number}.lock', 'a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        continue
    slot = slots / f'runner-{number}'
    slot.mkdir(mode=0o700, exist_ok=True)
    env = dict(os.environ, UAIN_HOME=str(slot), UAIN_MEMBER_HOME=str(root), UAIN_INSTANCE=f'runner-{number}')
    # Keep the lock in this process for the entire client lifetime; tini forwards signals to the group.
    child = subprocess.Popen(['node', '/opt/uain/main.mjs'], env=env)
    def stop(signum, frame):
        if child.poll() is None:
            child.send_signal(signum)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    sys.exit(child.wait())
sys.exit('No free runner slot; a requested slot is already running')

"""Vault key consumer and off-site publisher; fixed server paths only.

Locks (10 November 2026). The wrapper holds the run lock for the whole run, so
one backup runs at a time and a fence, restore or promotion still finds an
in-flight run. The custody lock, which every vault consumer and custody signer
shares, is held here only while the archive key is read from the vault; the
capture helper takes it again only while the node is stopped. Before, the
wrapper held it for the whole run (about 24 minutes) and no review was decided
in that time."""
import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
import resource
from pathlib import Path
import subprocess
import sys
import time

HERE=Path(__file__).resolve().parent
ROOT=Path('/var/lib/uain-node-backups')
CUSTODY_LOCK=Path('/run/lock/uain-custody.lock')
# As long as the wrapper used to wait for the same lock.
CUSTODY_WAIT_SECONDS=120
ROLE_PROFILE=Path('/etc/uain-failover/node.json')
ROLE_HELPER=Path('/opt/uain-failover/ops/chain/failover-backup.py')


class CustodyLock:
    """The lock every vault consumer shares; children never inherit it."""
    def __init__(self): self.fd=None

    def acquire(self):
        fd=os.open(CUSTODY_LOCK,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        deadline=time.monotonic()+CUSTODY_WAIT_SECONDS
        try:
            while True:
                try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB); break
                except BlockingIOError:
                    if time.monotonic()>=deadline: raise ValueError('Custody lock busy')
                    time.sleep(0.25)
        except BaseException:
            os.close(fd); raise
        self.fd=fd

    def release(self):
        if self.fd is not None:
            os.close(self.fd); self.fd=None


def capture_takes_custody_lock():
    """True only when the installed capture helper holds the custody lock around
    its own stopped window. Without the failover profile, or with an older
    helper, nothing else would keep custody quiet while the node is stopped, so
    this process keeps the lock for the whole run, as the wrapper used to."""
    if not (ROLE_PROFILE.exists() or ROLE_PROFILE.is_symlink()): return False
    try: return b'def custody_quiet(' in ROLE_HELPER.read_bytes()
    except OSError: return False


def load_custody():
    spec=importlib.util.spec_from_file_location('uain_custody','/opt/uain-custody/custody.py')
    custody=importlib.util.module_from_spec(spec);spec.loader.exec_module(custody)
    return custody


def child(action,value):
    result=subprocess.run(['/usr/bin/python3',str(HERE/'coordinator.py'),action],
                          input=json.dumps(value).encode(),capture_output=True,timeout=2400)
    if result.returncode: raise ValueError('Node backup coordinator failed')
    return json.loads(result.stdout)


def publish(client,path,expected):
    key='node-backups/'+path.name
    try:
        with path.open('rb') as source:
            client.put_object(Bucket='uain',Key=key,Body=source,ContentLength=path.stat().st_size,
                              Metadata={'sha256':expected},IfNoneMatch='*')
    except Exception as error:
        # A timestamp collision may only reuse a byte-identical existing object.
        if getattr(error,'response',{}).get('ResponseMetadata',{}).get('HTTPStatusCode')!=412:
            raise
    response=client.get_object(Bucket='uain',Key=key)
    digest=hashlib.sha256();size=0
    try:
        while data:=response['Body'].read(1024*1024):
            digest.update(data);size+=len(data)
            if size>path.stat().st_size: raise ValueError('Off-site backup is oversized')
    finally: response['Body'].close()
    if size!=path.stat().st_size or digest.hexdigest()!=expected:
        raise ValueError('Off-site backup readback differs')
    return dict(uri='s3://uain/'+key,sha256=expected,bytes=size,readback_verified=True)


def main():
    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    arguments=sys.argv[1:]
    verify=len(arguments)==2 and arguments[0]=='verify'
    if os.geteuid()!=0 or (arguments not in ([],['run']) and not verify): raise ValueError('Root backup entry required')
    custody=load_custody()
    lock=CustodyLock();lock.acquire()
    try:
        kp=custody.vault();custody.verify_vault(kp)
        key=custody.attachment(kp,'keys/backup-key.txt').decode().strip()
        if capture_takes_custody_lock(): lock.release()
        if verify:
            print(json.dumps(child('verify',dict(key=key,name=arguments[1]))));return
        stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        receipt=child('run',dict(key=key,stamp=stamp))
        client=custody.s3();receipt['offsite']=[]
        for item in receipt['backups']:
            path=ROOT/item['name']
            receipt['offsite'].append(publish(client,path,item['ciphertext_sha256']))
            manifest=path.with_suffix('.json')
            receipt['offsite'].append(publish(client,manifest,hashlib.sha256(manifest.read_bytes()).hexdigest()))
        receipt['offsite_verified']=True
        print(json.dumps(child('finalize',receipt)))
    finally: lock.release()


if __name__=='__main__':
    try: main()
    except Exception:
        print('Daily node backup failed; inspect service status. No secret diagnostic emitted.',file=sys.stderr)
        sys.exit(1)

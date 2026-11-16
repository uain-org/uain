"""Narrow vault boundary for exact retained public research backups.

Two callers. `backup` is the old `uain-custody backup-evidence` command: its
wrapper holds the custody lock for the whole run, up to 90 minutes, and every
custody signer waits behind it. `backup_narrow` is the daily unit's entry since
10 November 2026 (evidence_entry.py): it holds that lock only while the vault
and the storage secret are read, then verifies, uploads, downloads and
restore-checks the public archive unlocked."""
import contextlib,fcntl,hashlib,os,stat,subprocess,time
from pathlib import Path
FILES={'ops/evidence/backup.sh': '35284c7e620a8ad54920a39fab1b3b2b23c5385d50f122b9d05cb592f19a2294', 'ops/evidence/backup.py': 'cfaddf88ec861b9eab8c4cfe0a0444b4c8719e535106b58bbc56c74154011ca9', 'ops/evidence/store.py': 'f5a27dde497fb606dae88a75ccc179ccd9ef5b12bf4d9f4cabb3055794f2cbb3', 'ops/reset/archive.py': 'e9feb4979478019ce3acbc754540ce0233f8af278eee1e9755a5fc71e762f972'}
# Same bytes and pin as before, at a path no test-folder cleanup touches: the
# copy under /opt/uain-test was removed on 9 November 2026 and every daily run
# failed (CHANGELOG.md#evidence-backup-failing-20261110).
PLAN='/etc/uain-evidence/plan-20261012.json'
PLAN_SHA='c6ccfd9884151e6c6c7735f6d7f1a7d2dfc248771187755f12f5d943e4bcea46'
ROOT='/var/lib/uain-evidence/legacy-20261012-81911e155'
DESTINATION='/var/lib/uain-evidence-backups'
LOCK='/run/lock/uain-custody.lock'
# As long as the uain-custody wrapper waits for the same lock.
LOCK_WAIT_SECONDS=120
def require(ok):
 if not ok:raise ValueError('Reviewed public evidence custody scope refused')
def protected(path,limit=1024*1024):
 path=Path(path);require(path.is_absolute() and path.resolve()==path)
 for p in path.parents:
  s=p.stat();require(s.st_uid==0 and not s.st_mode&0o022)
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 with os.fdopen(fd,'rb') as stream:
  s=os.fstat(stream.fileno());require(stat.S_ISREG(s.st_mode) and s.st_uid==0 and not s.st_mode&0o022 and s.st_nlink==1 and s.st_size<=limit)
  raw=stream.read(limit+1);require(len(raw)<=limit);return raw
def validate(checkout):
 checkout=Path(checkout);require(checkout.is_absolute() and checkout.resolve()==checkout)
 for name,digest in FILES.items():require(hashlib.sha256(protected(checkout/name)).hexdigest()==digest)
 require(hashlib.sha256(protected(PLAN,16*1024*1024)).hexdigest()==PLAN_SHA)
 return checkout

def environment(custody):
 """The only vault and cluster-secret reads. Returns the helper's whole environment."""
 kp=custody.vault();custody.verify_vault(kp)
 key=custody.attachment(kp,'keys/backup-key.txt').decode().strip()
 require(len(key)==64 and all(c in '0123456789abcdefABCDEF' for c in key))
 storage=custody.kubernetes_secret('uain-env')
 return {'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','UAIN_BACKUP_KEY':key,
 'UAIN_BACKUP_S3_ENDPOINT':'https://nyc3.digitaloceanspaces.com',
 'UAIN_BACKUP_S3_BUCKET':'uain','UAIN_BACKUP_S3_REGION':'nyc3',
 'UAIN_BACKUP_S3_ACCESS_KEY_ID':storage['UAIN_STORAGE_ACCESS_KEY_ID'].decode(),
 'UAIN_BACKUP_S3_SECRET_ACCESS_KEY':storage['UAIN_STORAGE_SECRET_ACCESS_KEY'].decode()}

def run(checkout,env):
 subprocess.run(['/usr/bin/bash',str(checkout/'ops/evidence/backup.sh'),'--root',ROOT,'--plan',PLAN,'--plan-sha256',PLAN_SHA,'--destination',DESTINATION],env=env,cwd=checkout,check=True,timeout=5400)

def backup(custody,checkout):
 checkout=validate(checkout) # Executable bytes and plan precede vault access.
 run(checkout,environment(custody))

@contextlib.contextmanager
def custody_lock():
 """The lock every vault consumer shares; a child process never inherits it."""
 fd=os.open(LOCK,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
 try:
  deadline=time.monotonic()+LOCK_WAIT_SECONDS
  while True:
   try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);break
   except BlockingIOError:
    require(time.monotonic()<deadline);time.sleep(0.25)
  yield
 finally:os.close(fd)

def backup_narrow(custody,checkout):
 """Daily entry. Nothing in the long part touches the vault, a key or the
 node, so custody signers are not kept waiting for it."""
 checkout=validate(checkout) # Executable bytes and plan precede vault access.
 with custody_lock():env=environment(custody)
 run(checkout,env)

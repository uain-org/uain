"""Verify immutable reset capability bytes; no custody/configuration data read."""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat

CURRENT=Path('/opt/uain-reset')
RELEASES=Path('/opt/uain-reset-releases')
WRAPPER=Path('/usr/local/sbin/uain-system-reset')
LOCK=Path('/run/lock/uain-reset.lock')
MODULES=('archive.py','checkpoint.py','custody_entry.py','database.py','health.py',
 'native.py','node_main.py','node.py','pins.py','runtime.py','stack.py','system.py','installed.py','upgrade.py')
SOURCES=(*MODULES,'uain-system-reset')

def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode()
def sha(raw):return hashlib.sha256(raw).hexdigest()

def directory(path):
 info=Path(path).lstat()
 if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:raise ValueError('Root-protected directory required')
 return info

def read(path,limit=256*1024*1024):
 path=Path(path);info=path.lstat()
 if path.resolve()!=path:raise ValueError('Protected file path is redirected')
 if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022 or info.st_nlink!=1 or not 0<=info.st_size<=limit:raise ValueError('Root-protected bounded regular file required')
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  current=os.fstat(fd)
  identity=lambda s:(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_mode,s.st_uid,s.st_nlink)
  if identity(current)!=identity(info):raise ValueError('Protected input changed')
  with os.fdopen(os.dup(fd),'rb') as source:raw=source.read(limit+1)
  if len(raw)>limit or identity(os.fstat(fd))!=identity(info):raise ValueError('Protected input changed or exceeded bound')
  return raw
 finally:os.close(fd)

def verify_release(path):
 path=Path(path);directory(path)
 raw=read(path/'manifest.json',128*1024)
 if not re.fullmatch('[a-f0-9]{64}',path.name) or sha(raw)!=path.name:raise ValueError('Content-addressed reset manifest differs')
 value=json.loads(raw)
 if set(value)!= {'schema','role','source_revision','files'} or value['schema']!='uain-reset-release-v1' or value['role'] not in ('app','database') or not re.fullmatch('[a-f0-9]{40}',value['source_revision']):raise ValueError('Reset release schema differs')
 names=set(SOURCES)|{'uain-state','uain-reset-checkpoint'}|({'uain-proof'} if value['role']=='app' else set())
 if set(value['files'])!=names or set(p.name for p in path.iterdir())!=names|{'manifest.json'}:raise ValueError('Reset release file census differs')
 for name,pin in value['files'].items():
  if set(pin)!= {'sha256','size','mode'} or pin['mode']!=(0o700 if name.startswith('uain-') else 0o600):raise ValueError('Reset file pin differs')
  file=path/name;data=read(file)
  if len(data)!=pin['size'] or sha(data)!=pin['sha256'] or stat.S_IMODE(file.lstat().st_mode)!=pin['mode']:raise ValueError('Installed reset bytes differ')
 return value

def verify_runtime(filename,role):
 location=Path(filename).absolute()
 # Source-tree tests/rehearsals are explicit development invocations. Production
 # always enters through the unchanged fixed operator/forced-SSH paths.
 if location.parent!=CURRENT and location.parent.parent!=RELEASES:return
 directory(RELEASES)
 if not CURRENT.is_symlink():raise ValueError('Versioned reset installation required')
 release=CURRENT.resolve(strict=True)
 if release.parent!=RELEASES or location.resolve().parent!=release:raise ValueError('Reset pointer differs')
 manifest=verify_release(release)
 if manifest['role']!=role:raise ValueError('Wrong installed reset role')
 if role=='app' and sha(read(WRAPPER,4096))!=manifest['files']['uain-system-reset']['sha256']:raise ValueError('Installed reset wrapper differs')

def capability(filename,role):
 verify_runtime(filename,role)
 release=CURRENT.resolve(strict=True);manifest=verify_release(release)
 return {'schema':'uain-reset-capability-v1','role':role,'release_digest':release.name,'source_revision':manifest['source_revision'],'archive_sha256':manifest['files']['archive.py']['sha256'],'reset_performed':False}

@contextlib.contextmanager
def node_lock():
 fd=os.open(LOCK,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
 try:
  info=os.fstat(fd)
  if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022 or info.st_nlink!=1:raise ValueError('Reset lock is not protected')
  fcntl.flock(fd,fcntl.LOCK_EX)
  yield
 finally:os.close(fd)

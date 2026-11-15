#!/usr/bin/env python3
"""Root-operated immutable BAINK upgrade. Never resets or restores live metadata."""
import fcntl, hashlib, json, os, pathlib, re, shutil, stat, subprocess, sys, tarfile, time, urllib.request
release, archive_hash, prior = sys.argv[1:]
assert os.geteuid()==0 and re.fullmatch(r'\d{8}T\d{6}Z-[a-f0-9]{10}',release)
assert re.fullmatch(r'[a-f0-9]{64}',archive_hash)
lock=open('/var/lib/baink-deployments/activation.lock','w');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
current=pathlib.Path('/opt/baink/current');old=current.resolve()
assert old.name==prior, 'Current release changed; qualify it before upgrading.'
archive=pathlib.Path('/var/lib/baink-deployments')/release/'release.tar.gz'
assert hashlib.sha256(archive.read_bytes()).hexdigest()==archive_hash
new=pathlib.Path('/opt/baink/releases')/release
assert not new.exists();new.mkdir(mode=0o755)
with tarfile.open(archive,'r:gz') as bundle: bundle.extractall(new,filter='data')
manifest=json.loads((new/'release-manifest.json').read_text());assert manifest['release']==release and re.fullmatch(r'0\.3\.\d+',manifest['version'])
expected={**manifest['files'],**{'preview/'+k:v for k,v in manifest['preview_files'].items()}}
actual={str(p.relative_to(new)) for p in new.rglob('*') if p.is_file()}
assert actual==set(expected)|{'release-manifest.json'}
for name,sha in expected.items():
 path=new/name;assert path.is_file() and not path.is_symlink() and hashlib.sha256(path.read_bytes()).hexdigest()==sha
for path in [new,*new.rglob('*')]:os.chown(path,0,0);os.chmod(path,0o755 if path.is_dir() else 0o644)
backup=pathlib.Path('/var/backups/baink')/release;backup.mkdir(mode=0o700)
preview=pathlib.Path('/var/www/baink-preview/baink');preview_old=preview.with_name('baink.before-'+release)
env=pathlib.Path('/etc/baink.env');preview_changed=False;stopped=False

def system(*args):subprocess.run(['systemctl',*args],check=True,stdout=subprocess.DEVNULL)
def switch(link,target):
 temp=link.with_name(link.name+'.'+release);assert not temp.exists();os.symlink(str(target),temp);os.replace(temp,link)
def healthy():
 # A bounded15s proof-master warmup precedes listen; bound the full health wait.
 deadline=time.monotonic()+30
 for attempt in range(100):
  if time.monotonic()>=deadline:return False
  try:
   with urllib.request.urlopen('http://127.0.0.1:8798/api/health',timeout=2) as response:
    if response.status==200 and json.load(response).get('ok') is True:return True
  except Exception:time.sleep(0.3)
 return False
def private_backup(src,dst):
 # Quiesced copy only. Recovery never restores stale financial journals.
 metadata=src.lstat()
 assert not stat.S_ISLNK(metadata.st_mode) and not metadata.st_mode&0o077, 'Unsafe private recovery source.'
 if stat.S_ISDIR(metadata.st_mode):
  dst.mkdir(mode=0o700)
  for child in src.iterdir():private_backup(child,dst/child.name)
 else:
  assert stat.S_ISREG(metadata.st_mode) and metadata.st_nlink==1, 'Unsafe private recovery file.'
  fd=os.open(src,os.O_RDONLY|os.O_NOFOLLOW)
  try:
   opened=os.fstat(fd);assert opened.st_ino==metadata.st_ino and opened.st_dev==metadata.st_dev
   with os.fdopen(fd,'rb',closefd=False) as reader,open(dst,'xb') as writer:
    os.chmod(dst,0o600);shutil.copyfileobj(reader,writer);writer.flush();os.fsync(writer.fileno())
  finally:os.close(fd)
try:
 system('stop','baink.service');stopped=True
 sources=[pathlib.Path('/var/lib/baink/state.json'),env]
 for name in ['state.sqlite','state.sqlite-wal','management.sqlite','management-plans.json']:
  candidate=pathlib.Path('/var/lib/baink')/name
  if candidate.exists():
   assert candidate.is_file() and not candidate.is_symlink(),'Unsafe management recovery source.'
   sources.append(candidate)
 for src in sources:
  shutil.copy2(src,backup/src.name);os.chmod(backup/src.name,0o600)
 for name in ['public-review','public-review-worker.key']:
  candidate=pathlib.Path('/var/lib/baink')/name
  if candidate.exists() or candidate.is_symlink():private_backup(candidate,backup/name)
 # Deployment preserves operator configuration, including the enrolment gate.
 switch(current,new);system('start','baink.service');assert healthy(),'New service failed health check.'
 assert preview.exists() and not preview_old.exists();os.rename(preview,preview_old);preview_changed=True;switch(preview,new/'preview')
 assert pathlib.Path('/var/lib/baink/state.json').stat().st_mode&0o077==0
 print(json.dumps({'release':release,'version':manifest['version'],'prior':prior,'files':len(manifest['files']),'previewFiles':len(manifest['preview_files']),'backup':str(backup),'healthy':True,'nativeEnrolment':'explicit-holder-signing-only','nativeFinancialActivation':False}))
except BaseException:
 if stopped:
  subprocess.run(['systemctl','stop','baink.service'],stdout=subprocess.DEVNULL)
  switch(current,old)
  if(backup/'baink.env').exists():shutil.copy2(backup/'baink.env',env);os.chmod(env,0o600)
  if preview_changed:
   if preview.is_symlink():preview.unlink()
   os.rename(preview_old,preview)
  system('start','baink.service')
 raise

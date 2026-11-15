#!/usr/bin/env python3
"""Exact payment-list routes only; reviewed before-hash/release guarded repair."""
import fcntl,hashlib,json,os,re,stat,subprocess,sys
from pathlib import Path
CONFIG_ROOT=Path('/etc/nginx/sites-available')
RELEASE_ROOT=Path('/opt/baink/releases');CURRENT=Path('/opt/baink/current')
LOCK_PATH=Path('/var/lib/baink-deployments/activation.lock');BACKUP_ROOT=Path('/var/backups/baink')
EXPECTED_RELEASE='20261104T202757Z-e2e22a5690'
PRIMARY_SHA='199a159ba59c00dc8ab96be7999d9aa2977b6ef399f5f2a858dd8c42b21d4777'
PREVIEW_SHA='b5fa984be17a2346d7f96115d9a6e66e4ba318131a1bedcda569d5c57914cb5f'
def digest(data):return hashlib.sha256(data).hexdigest()
def require(ok):
 if not ok:raise ValueError('Payment list routing guard refused')
def exact_block(prefix=''):
 require(prefix in ['', '/baink']);rewrite='        rewrite ^/baink(/api/.*)$ $1 break;\n' if prefix else ''
 return f'''    # BAINK exact payment list: preserve authentication without slash redirect.
    location = {prefix}/api/native/payments {{
{rewrite}        limit_req zone=baink_api burst=30 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:8798;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        client_max_body_size 16k;
        proxy_connect_timeout 5s;
        proxy_read_timeout 150s;
    }}
'''.encode()
def transform(original,preview=False):
 require(isinstance(original,bytes) and type(preview) is bool);prefix='/baink' if preview else '';marker=f'    location ^~ {prefix}/api/native/payments/ {{'.encode()
 require(original.count(marker)==1 and re.search(rb'location\s*=\s*'+re.escape((prefix+'/api/native/payments').encode())+rb'\s*\{',original) is None)
 return original.replace(marker,exact_block(prefix)+marker,1)
def trusted(path,directory=False):
 p=Path(path);require(p.is_absolute());info=p.lstat()
 for q in [p,*p.parents]:
  s=q.lstat();require(s.st_uid==0 and not s.st_mode&0o022 and not stat.S_ISLNK(s.st_mode))
 require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink==1)
 return p
def check_current(release):
 require(CURRENT.is_symlink() and CURRENT.lstat().st_uid==0);target=trusted(RELEASE_ROOT/release,True);require(CURRENT.resolve(strict=True)==target.resolve(strict=True))
def replace_config(path,content,release):
 temporary=path.with_name(path.name+'.payment-list-'+release);fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)
 try:
  with os.fdopen(fd,'wb') as out:out.write(content);out.flush();os.fsync(out.fileno())
  os.replace(temporary,path);directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
  try:os.fsync(directory)
  finally:os.close(directory)
 finally:temporary.unlink(missing_ok=True)
def test_and_reload():
 subprocess.run(['nginx','-t'],check=True);subprocess.run(['systemctl','reload','nginx'],check=True)
def main(argv=None):
 args=sys.argv[1:] if argv is None else argv;require(len(args)==3);release,primary_sha,preview_sha=args
 require(release==EXPECTED_RELEASE and re.fullmatch(r'\d{8}T\d{6}Z-[a-f0-9]{10}',release) and primary_sha==PRIMARY_SHA and preview_sha==PREVIEW_SHA and os.geteuid()==0)
 trusted(LOCK_PATH.parent,True);fd=os.open(LOCK_PATH,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'a') as lock:
  info=os.fstat(lock.fileno());require(info.st_uid==0 and stat.S_ISREG(info.st_mode) and info.st_nlink==1 and not info.st_mode&0o022);fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  check_current(release);paths=[CONFIG_ROOT/'baink.money.conf',CONFIG_ROOT/'aidollar.money.conf'];old=[trusted(p).read_bytes() for p in paths];require([digest(b) for b in old]==[primary_sha,preview_sha]);new=[transform(old[0]),transform(old[1],True)]
  trusted(BACKUP_ROOT,True);parent=BACKUP_ROOT/release;parent.mkdir(mode=0o700,exist_ok=True);trusted(parent,True);backup=parent/'payment-list-routing';backup.mkdir(mode=0o700);trusted(backup,True)
  for path,data in zip(paths,old):
   outfd=os.open(backup/path.name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
   with os.fdopen(outfd,'wb') as out:out.write(data);out.flush();os.fsync(out.fileno())
  directory=os.open(backup,os.O_RDONLY|os.O_DIRECTORY)
  try:os.fsync(directory)
  finally:os.close(directory)
  changed=[]
  try:
   check_current(release);require([p.read_bytes() for p in paths]==old)
   for path,data,before in zip(paths,new,old):
    check_current(release);require(path.read_bytes()==before);replace_config(path,data,release);changed.append(path)
   test_and_reload();check_current(release);require([p.read_bytes() for p in paths]==new)
  except BaseException:
   restored=False
   for path,before,after in zip(paths,old,new):
    if path in changed and path.read_bytes()==after:replace_config(path,before,release);restored=True
   if restored:test_and_reload()
   raise
  print(json.dumps({'release':release,'nginxTest':True,'reloaded':True,'backup':str(backup),'paymentListRoutes':['/api/native/payments','/baink/api/native/payments'],'configs':[{'name':p.name,'before':digest(a),'after':digest(b)} for p,a,b in zip(paths,old,new)]}))
if __name__=='__main__':main()

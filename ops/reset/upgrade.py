#!/usr/bin/python3
"""Root-reviewed capability installation only; never invoke a reset operation."""
import os,sys
if __name__=='__main__' and not sys.flags.isolated:
 os.execv('/usr/bin/python3',['/usr/bin/python3','-I','-B',os.path.abspath(__file__),*sys.argv[1:]])
import argparse
import base64
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import sys
import time
import uuid
sys.dont_write_bytecode=True
def _source_verifier():
    # -B suppresses writes, not reads. Compile only protected source; never ask
    # importlib for cached verifier code before its manifest has been checked.
    import types
    file=Path(__file__).resolve().parent/'installed.py'
    fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022 or info.st_nlink!=1 or not 0<info.st_size<=131072:raise ValueError('Unprotected verifier source')
        with os.fdopen(os.dup(fd),'rb') as stream:raw=stream.read(131073)
        if len(raw)!=info.st_size or (lambda st:(st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_mode,st.st_uid,st.st_nlink))(os.fstat(fd))!=(info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_mode,info.st_uid,info.st_nlink):raise ValueError('Verifier source changed')
    finally:os.close(fd)
    # Installed releases bind this first executed source to the independently
    # content-addressed manifest before its own fuller census runs.
    if file.parent.parent==Path('/opt/uain-reset-releases'):
        import hashlib,json
        manifest=file.parent/'manifest.json';st=manifest.lstat()
        if not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_mode&0o022 or st.st_nlink!=1 or st.st_size>131072:raise ValueError('Unprotected manifest')
        data=manifest.read_bytes()
        if hashlib.sha256(data).hexdigest()!=file.parent.name or hashlib.sha256(raw).hexdigest()!=json.loads(data)['files']['installed.py']['sha256']:raise ValueError('Verifier source pin differs')
    module=types.ModuleType('installed');module.__file__=str(file)
    exec(compile(raw,str(file),'exec'),module.__dict__);sys.modules['installed']=module
    return module

_installed=_source_verifier()
SOURCES,canonical,sha,read,directory,verify_release=(_installed.SOURCES,_installed.canonical,_installed.sha,_installed.read,_installed.directory,_installed.verify_release)

class Layout:
 def __init__(self,root=Path('/')):
  self.root=Path(root);self.current=self.root/'opt/uain-reset';self.releases=self.root/'opt/uain-reset-releases';self.config=self.root/'etc/uain-reset';self.epochs=self.root/'var/lib/uain-reset';self.journals=self.root/'var/lib/uain-reset-upgrades';self.wrapper=self.root/'usr/local/sbin/uain-system-reset';self.authorized=self.root/'root/.ssh/authorized_keys';self.lock=self.root/'run/lock/uain-reset.lock';self.custody_lock=self.root/'run/lock/uain-custody.lock'

def syncdir(path):
 fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:os.fsync(fd)
 finally:os.close(fd)

def save(path,data,mode=0o600):
 path=Path(path);pending=path.with_name('.'+path.name+'.pending-'+uuid.uuid4().hex)
 fd=os.open(pending,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
 try:
  with os.fdopen(fd,'wb') as out:out.write(data);out.flush();os.fsync(out.fileno())
  os.replace(pending,path);syncdir(path.parent)
 finally:pending.unlink(missing_ok=True)

def tree(path,metadata=False):
 path=Path(path);root=directory(path);records=[['.',root.st_ino,root.st_dev,root.st_mode,root.st_size,root.st_mtime_ns]] if metadata else [['.',stat.S_IMODE(root.st_mode)]]
 for file in sorted(path.rglob('*')):
  if len(records)>=4096:raise ValueError('Installed/configuration census exceeded')
  info=file.lstat();name=str(file.relative_to(path))
  if info.st_uid!=0 or info.st_mode&0o022 or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)) or (stat.S_ISREG(info.st_mode) and info.st_nlink!=1):raise ValueError('Installed/configuration scope is redirected or unprotected')
  if metadata:records.append([name,info.st_ino,info.st_dev,info.st_mode,info.st_size,info.st_mtime_ns])
  elif file.is_file():records.append([name,stat.S_IMODE(info.st_mode),sha(read(file))])
  else:records.append([name,stat.S_IMODE(info.st_mode)])
 return sha(canonical(records))

def preserved(layout):
 # SSH/private credential bytes are deliberately never opened. Preserve their
 # exact inode/mode/size/mtime census, public authorized keys and epoch files.
 return sha(canonical({'config_metadata':tree(layout.config,True),'epochs_metadata':tree(layout.epochs,True),'authorized_keys':sha(read(layout.authorized,1024*1024)) if layout.authorized.exists() else None}))

def validate_layout(layout):
 if layout.root.resolve()!=layout.root:raise ValueError('Installation scope is redirected')
 for leaf in (layout.current.parent,layout.releases.parent,layout.config,layout.epochs,layout.wrapper.parent,layout.authorized.parent):
  for path in (leaf,*leaf.parents):
   directory(path)
   if path==layout.root:break

def input_scope(path,boundary):
 path=Path(path);boundary=Path(boundary)
 if not path.is_relative_to(boundary) or path.resolve()!=path:raise ValueError('Input is outside the protected real scope')
 for parent in (path,*path.parents):
  directory(parent)
  if parent==boundary:break

def candidate(role,source,binaries,revision,boundary=Path('/')):
 if role not in ('app','database') or not re.fullmatch('[a-f0-9]{40}',revision):raise ValueError('Exact role and reviewed source revision required')
 source=Path(source);input_scope(source,boundary)
 required={'uain-state','uain-reset-checkpoint'}|({'uain-proof'} if role=='app' else set())
 if set(binaries)!=required:raise ValueError('Exact reviewed public binary set required')
 inputs={name:source/name for name in SOURCES}|{name:Path(path) for name,path in binaries.items()};pins={}
 for name,path in inputs.items():
  input_scope(path.parent,boundary)
  data=read(path);pins[name]={'sha256':sha(data),'size':len(data),'mode':0o700 if name.startswith('uain-') else 0o600}
 value={'schema':'uain-reset-release-v1','role':role,'source_revision':revision,'files':pins};raw=canonical(value)+b'\n'
 return inputs,raw,sha(raw)

def prior(layout,role):
 if layout.current.is_symlink():
  target=layout.current.resolve(strict=True)
  if target.parent!=layout.releases:raise ValueError('Existing reset pointer is outside release scope')
  verify_release(target)
 else:target=layout.current
 return {'root_digest':tree(target),'wrapper_digest':sha(read(layout.wrapper,4096)) if role=='app' else None,'preserved_digest':preserved(layout)}

def plan(role,source,binaries,revision,layout=None):
 layout=layout or Layout();validate_layout(layout);_,raw,digest=candidate(role,source,binaries,revision,layout.root);old=prior(layout,role)
 return {'schema':'uain-reset-upgrade-approval-v1','role':role,'source_revision':revision,'release_digest':digest,'prior_install_digest':sha(canonical(old)),'preserved_digest':old['preserved_digest']}

@contextlib.contextmanager
def locks(layout,role):
 held=[]
 try:
  for path in ([layout.custody_lock] if role=='app' else [])+[layout.lock]:
   path.parent.mkdir(parents=True,mode=0o700,exist_ok=True);parent=path.parent.lstat()
   if not stat.S_ISDIR(parent.st_mode) or parent.st_uid!=0 or (parent.st_mode&0o022 and not parent.st_mode&stat.S_ISVTX):raise ValueError('Reset lock directory is unprotected')
   if path.parent.resolve()!=path.parent:raise ValueError('Reset lock path is redirected')
   input_scope(path.parent.parent,layout.root)
   fd=os.open(path,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600);held.append(fd);info=os.fstat(fd)
   if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_nlink!=1 or info.st_mode&0o022:raise ValueError('Reset upgrade lock is unprotected')
   try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
   except BlockingIOError:raise ValueError('Reset/custody capability busy')
  yield
 finally:
  for fd in reversed(held):os.close(fd)

def stage_release(layout,inputs,manifest,digest):
 release=layout.releases/digest
 if release.exists():verify_release(release);return release
 temporary=layout.releases/('.pending-'+uuid.uuid4().hex);temporary.mkdir(mode=0o700);pins=json.loads(manifest)['files']
 try:
  for name,path in inputs.items():
   data=read(path)
   if sha(data)!=pins[name]['sha256']:raise ValueError('Source changed during staging')
   save(temporary/name,data,pins[name]['mode'])
  save(temporary/'manifest.json',manifest);syncdir(temporary);temporary.rename(release);syncdir(layout.releases)
 finally:
  if temporary.exists():shutil.rmtree(temporary)
 verify_release(release);return release

def bootstrap(role,source,binaries,revision,layout=None):
 """Fresh root-provisioned installation; existing capability always refuses."""
 if os.geteuid()!=0:raise ValueError('Root required')
 layout=layout or Layout();validate_layout(layout);inputs,manifest,digest=candidate(role,source,binaries,revision,layout.root)
 with locks(layout,role):
  if os.path.lexists(layout.current) or (role=='app' and os.path.lexists(layout.wrapper)):raise ValueError('Existing capability requires reviewed upgrade')
  layout.releases.mkdir(parents=True,mode=0o700,exist_ok=True);directory(layout.releases)
  release=stage_release(layout,inputs,manifest,digest);layout.current.symlink_to(release);syncdir(layout.current.parent)
  if role=='app':save(layout.wrapper,read(release/'uain-system-reset',4096),0o700)
  return {'schema':'uain-reset-install-receipt-v1','role':role,'release_digest':digest,'source_revision':revision,'reset_performed':False}

def install(approval,source,binaries,layout=None,after=lambda phase:None):
 if os.geteuid()!=0:raise ValueError('Root required')
 layout=layout or Layout();validate_layout(layout);input_scope(Path(approval).parent,layout.root);raw=read(approval,128*1024);value=json.loads(raw)
 if stat.S_IMODE(Path(approval).lstat().st_mode)!=0o600:raise ValueError('Root0600 approval file required')
 fields={'schema','role','source_revision','release_digest','prior_install_digest','preserved_digest','expires_at'}
 if set(value)!=fields or value['schema']!='uain-reset-upgrade-approval-v1' or value['role'] not in ('app','database') or type(value['expires_at']) is not int or not time.time()<value['expires_at']<=time.time()+3600:raise ValueError('Exact fresh root approval required')
 for field in ('release_digest','prior_install_digest','preserved_digest'):
  if not isinstance(value[field],str) or not re.fullmatch('[a-f0-9]{64}',value[field]):raise ValueError('Exact approval digest required')
 inputs,manifest,digest=candidate(value['role'],source,binaries,value['source_revision'],layout.root)
 if digest!=value['release_digest']:raise ValueError('Reviewed source/public binary bytes changed')
 with locks(layout,value['role']):
  for path in (layout.releases,layout.journals):path.mkdir(parents=True,mode=0o700,exist_ok=True);directory(path)
  journal=layout.journals/(sha(canonical(value))+'.json');release=layout.releases/digest
  if journal.exists():
   state=json.loads(read(journal,128*1024))
   if state['approval']!=value:raise ValueError('Upgrade journal approval differs')
  else:
   old=prior(layout,value['role'])
   if sha(canonical(old))!=value['prior_install_digest'] or old['preserved_digest']!=value['preserved_digest']:raise ValueError('Prior installation or preserved configuration changed')
   old_pointer=str(layout.current.resolve()) if layout.current.is_symlink() else None
   state={'approval':value,'old':old,'old_pointer':old_pointer,'phase':'approved'};save(journal,canonical(state)+b'\n')
  if preserved(layout)!=value['preserved_digest']:raise ValueError('Preserved configuration or epoch metadata changed')
  legacy=layout.releases/('legacy-'+state['old']['root_digest'])
  previous=Path(state['old_pointer']) if state['old_pointer'] else legacy
  if state['old_pointer'] and verify_release(previous)['files']['node_main.py']['sha256']!=json.loads(manifest)['files']['node_main.py']['sha256']:raise ValueError('Stable forced-SSH bootstrap changed; separate protocol upgrade required')
  def phase(name):state['phase']=name;save(journal,canonical(state)+b'\n');after(name)
  stage_release(layout,inputs,manifest,digest)
  phase('staged')
  if layout.current.is_symlink():
   if layout.current.resolve() not in (previous,release):raise ValueError('Concurrent reset release pointer changed')
  elif layout.current.exists():
   if state['old_pointer'] or legacy.exists() or tree(layout.current)!=state['old']['root_digest']:raise ValueError('Legacy reset installation changed')
   layout.current.rename(legacy);syncdir(layout.current.parent);syncdir(layout.releases)
  elif state['old_pointer'] or not legacy.is_dir():raise ValueError('Prior reset installation is missing')
  if tree(previous)!=state['old']['root_digest']:raise ValueError('Retired reset bytes changed')
  phase('retired')
  if not layout.current.is_symlink() or layout.current.resolve()!=release:
   pending=layout.current.with_name('.uain-reset.pointer-'+uuid.uuid4().hex)
   try:pending.symlink_to(release);os.replace(pending,layout.current);syncdir(layout.current.parent)
   finally:pending.unlink(missing_ok=True)
  phase('switched')
  if value['role']=='app':
   wrapper=read(layout.wrapper,4096);expected=json.loads(manifest)['files']['uain-system-reset']['sha256']
   if sha(wrapper) not in (state['old']['wrapper_digest'],expected):raise ValueError('Operator wrapper changed')
   if sha(wrapper)!=expected:save(layout.wrapper,read(release/'uain-system-reset',4096),0o700)
  phase('wrapper')
  verify_release(release)
  if preserved(layout)!=value['preserved_digest']:raise ValueError('Preserved configuration drifted during upgrade')
  result={'schema':'uain-reset-upgrade-receipt-v1','role':value['role'],'release_digest':digest,'source_revision':value['source_revision'],'previous_release':str(previous),'current':str(layout.current),'configuration_preserved':True,'reset_performed':False}
  state['receipt']=result;phase('complete');return result

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('action',choices=('plan','apply','bootstrap'));parser.add_argument('role',choices=('app','database'));parser.add_argument('--source',required=True);parser.add_argument('--state',required=True);parser.add_argument('--checkpoint',required=True);parser.add_argument('--proof');parser.add_argument('--source-revision');parser.add_argument('--approval');args=parser.parse_args()
 if os.geteuid()!=0 or socket.gethostname().split('.')[0]!=('uain-app-1' if args.role=='app' else 'uain-db-1'):raise ValueError('Root on the exact role host required')
 binaries={'uain-state':Path(args.state),'uain-reset-checkpoint':Path(args.checkpoint)}
 if args.proof:binaries['uain-proof']=Path(args.proof)
 if args.action=='plan':result=plan(args.role,Path(args.source),binaries,args.source_revision or '')
 elif args.action=='bootstrap':result=bootstrap(args.role,Path(args.source),binaries,args.source_revision or '')
 else:
  if not args.approval:raise ValueError('Root approval file required')
  if json.loads(read(args.approval,128*1024)).get('role')!=args.role:raise ValueError('Approval role differs')
  result=install(args.approval,Path(args.source),binaries)
 print(json.dumps(result,sort_keys=True))
if __name__=='__main__':
 os.umask(0o077)
 try:main()
 except Exception:
  print('Reset capability upgrade refused; no reset or secret diagnostic emitted.',file=sys.stderr);sys.exit(1)

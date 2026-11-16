#!/usr/bin/env python3
"""Installed root entry point. Private archive key stays in server RAM."""
import os,sys
if __name__=='__main__' and not sys.flags.isolated:
    os.execv(sys.executable,[sys.executable,'-I','-B',os.path.abspath(__file__),*sys.argv[1:]])
import stat
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import json
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

installed=_source_verifier()

def main():
    if os.geteuid()!=0:raise ValueError('Root required')
    installed.verify_runtime(__file__,'app')
    if len(sys.argv)<2 or sys.argv[1] not in ['capability','plan','prepare','apply','recover','abort']:raise ValueError('Unknown reset command')
    if sys.argv[1]=='capability':
        if len(sys.argv)!=2:raise ValueError('Exact capability command required')
        print(json.dumps(installed.capability(__file__,'app')));return 0
    # Vault access uses the custody environment; reset archive crypto is
    # installed for the fixed system interpreter on both hosts.
    argv=['/usr/bin/python3','-I','-B','/opt/uain-reset/system.py',*sys.argv[1:]]
    if sys.argv[1] not in ['apply','recover']:
        return subprocess.call(argv)
    spec=importlib.util.spec_from_file_location('uain_custody','/opt/uain-custody/custody.py')
    custody=importlib.util.module_from_spec(spec);spec.loader.exec_module(custody)
    kp=custody.vault();custody.verify_vault(kp)
    with tempfile.TemporaryDirectory(prefix='uain-reset-',dir='/dev/shm') as temporary:
        key=Path(temporary)/'archive-key.txt'
        with key.open('xb') as out:out.write(custody.attachment(kp,'keys/backup-key.txt'))
        os.chmod(key,0o600)
        env=os.environ.copy();env['UAIN_RESET_KEY_FILE']=str(key)
        return subprocess.call(argv,env=env)

if __name__=='__main__':
    os.umask(0o077)
    try:sys.exit(main())
    except Exception:
        print('Reset entry point refused; no secret diagnostic emitted.',file=sys.stderr)
        sys.exit(1)

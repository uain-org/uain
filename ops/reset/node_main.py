#!/usr/bin/python3
"""Stable forced-SSH bootstrap; lock and verify before importing operations."""
import os
import sys
if __name__=='__main__' and not sys.flags.isolated:
    os.execv('/usr/bin/python3',['/usr/bin/python3','-I','-B',os.path.abspath(__file__),*sys.argv[1:]])
import fcntl
from pathlib import Path
import stat
import sys
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

if __name__=='__main__':
    os.umask(0o077)
    fd=None
    try:
        if os.geteuid()!=0:raise ValueError('Root required')
        fd=os.open('/run/lock/uain-reset.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022 or info.st_nlink!=1:raise ValueError('Unprotected reset lock')
        fcntl.flock(fd,fcntl.LOCK_EX)
        # Resolve only while holding the upgrade lock. This bootstrap stays
        # identical across versions; all mutable dispatch lives in node.py.
        entry=Path(__file__).resolve(strict=True)
        installed=_source_verifier()
        installed.verify_runtime(entry,'database')
        sys.path.insert(0,str(entry.parent))
        import node
        node.main()
    except Exception:
        print('Reset-node operation refused or failed; inspect the bounded epoch journal.',file=sys.stderr)
        sys.exit(1)
    finally:
        if fd is not None:os.close(fd)
else:
    # Preserve explicit development-test dependency patching without exposing
    # any production dispatch before the bootstrap verifies its release.
    sys.path.insert(0,str(Path(__file__).resolve().parent))
    import node
    sys.modules[__name__]=node

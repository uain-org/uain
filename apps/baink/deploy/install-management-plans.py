#!/usr/bin/env python3
"""Install an operator-generated bounded plan batch; never edits business state."""
import fcntl,hashlib,json,os,pathlib,stat,sys,tempfile

def install(source,destination,expected):
    source,destination=pathlib.Path(source),pathlib.Path(destination)
    fd=os.open(source,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as stream:
        info=os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size>1024*1024:raise ValueError('invalid_plan_file')
        raw=stream.read(1024*1024+1)
    if hashlib.sha256(raw).hexdigest()!=expected:raise ValueError('plan_digest_changed')
    plans=json.loads(raw)
    count=len(plans) if isinstance(plans,list) else len(plans.get('plans',[]))+len(plans.get('heldProjects',[])) if isinstance(plans,dict) and plans.get('schema')=='baink-management-batch-v1' and isinstance(plans.get('plans'),list) and isinstance(plans.get('heldProjects'),list) else 0
    if not 1<=count<=100:raise ValueError('invalid_plan_batch')
    if destination.is_symlink():raise ValueError('plan_destination_symlink')
    parent=destination.parent.stat()
    descriptor,temporary=tempfile.mkstemp(prefix='.management-plans-',dir=destination.parent)
    try:
        os.fchmod(descriptor,0o600)
        if os.geteuid()==0:os.fchown(descriptor,parent.st_uid,parent.st_gid)
        with os.fdopen(descriptor,'wb') as out:out.write(raw);out.flush();os.fsync(out.fileno())
        os.replace(temporary,destination)
        directory=os.open(destination.parent,os.O_RDONLY)
        try:os.fsync(directory)
        finally:os.close(directory)
    finally:
        if os.path.exists(temporary):os.unlink(temporary)
    return {'installed':count,'sha256':expected,'nativeWrites':False}

if __name__=='__main__':
    if os.geteuid()!=0:raise SystemExit('root_operator_required')
    lock=os.open('/var/lib/baink-deployments/management-plans.lock',os.O_CREAT|os.O_WRONLY|os.O_NOFOLLOW,0o600)
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    print(json.dumps(install('/var/lib/baink-deployments/management/plans.upload.json','/var/lib/baink/management-plans.json',sys.argv[1])))

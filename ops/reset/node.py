#!/usr/bin/env python3
"""Forced SSH endpoint on uain-db-1. No shell, arbitrary paths, or key export."""
import json
import hashlib
import uuid
import os
from pathlib import Path
import socket
import subprocess
import sys
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parent))
import installed
archive=database=stack=None
if __name__!='__main__':
    # Explicit source-tree tests patch these dependencies. The installed SSH
    # process verifies its complete bundle before importing operational code.
    import archive
    import database
    import stack

def main():
    global archive,database,stack
    if os.geteuid()!=0 or socket.gethostname().split('.')[0]!='uain-db-1':raise ValueError('Wrong node host')
    if os.environ.get('SSH_ORIGINAL_COMMAND') not in (None,'uain-reset-node'):raise ValueError('Unsupported SSH command')
    installed.verify_runtime(__file__,'database')
    if archive is None:
        import archive as checked_archive
        import database as checked_database
        import stack as checked_stack
        archive,database,stack=checked_archive,checked_database,checked_stack
    raw=sys.stdin.buffer.readline(131073)
    if len(raw)>131072:raise ValueError('Request too large')
    request=json.loads(raw);action=request['action'];epoch=request.get('epoch')
    if 'database' in request and (request['database']['database']!='uain' or request['database']['epoch']!=epoch or request['database']['target']!='uain_reset_'+epoch):
        raise ValueError('Database outside the production UAIN scope')
    if action=='capability':result=installed.capability(__file__,'database')
    elif action=='inventory':
        result={'node':stack.node_inventory(),'database':database.plan('uain',epoch)}
    elif action=='stop':
        stack.command(['systemctl','stop',stack.UNIT]);result={'stopped':True}
    elif action=='start':
        stack.command(['systemctl','start',stack.UNIT]);result={'started':True}
    elif action=='archive':
        key=request['key'];directory=stack.epoch_dir(epoch)
        result={'database':stack.db_archive(epoch,request['database'],key),
                'chain':stack.chain_archive(epoch,request['node'],key)}
        (directory/'archive-receipt.json').write_text(json.dumps(result))
    elif action=='stage-db':result=database.stage(request['database'])
    elif action=='activate-db':result=database.activate(request['database'])
    elif action=='stage-node':result=stack.node_stage(epoch,request['node'],request['state'],request['genesis'],request['peer'])
    elif action=='stage-archive':result=stack.stage_archive(epoch,request['staged'],request['key'])
    elif action=='activate-node':result=stack.node_activate(epoch,request['staged'])
    elif action=='replicate':
        if request['file'] not in ['app-runtime','app-chain','app-new-chain'] or not 0 < request['length'] < archive.LIMIT:
            raise ValueError('Invalid archive replica')
        directory=stack.epoch_dir(epoch);path=directory/(request['file']+'.resetbk')
        temporary=directory/(request['file']+'.pending-'+uuid.uuid4().hex)
        sha=hashlib.sha256();remaining=request['length']
        with temporary.open('xb') as out:
            while remaining:
                data=sys.stdin.buffer.read(min(remaining,1024*1024))
                if not data:raise ValueError('Truncated archive replica')
                out.write(data);sha.update(data);remaining-=len(data)
            if sys.stdin.buffer.read(1):raise ValueError('Oversized archive replica')
            out.flush();os.fsync(out.fileno())
        if sha.hexdigest()!=request['sha256']:raise ValueError('Archive replica digest differs')
        result=archive.verify(temporary,request['key'])
        if path.exists():
            if archive.verify(path,request['key'])!=result:raise ValueError('Immutable replica differs')
            temporary.unlink()
        else:temporary.rename(path)
        result['replicated']=True
    elif action=='fetch':
        if request['file'] not in ['database','chain','new-chain']:raise ValueError('Unsupported archive')
        with (stack.epoch_dir(epoch)/(request['file']+'.resetbk')).open('rb') as source:
            while data:=source.read(1024*1024):sys.stdout.buffer.write(data)
        return
    elif action=='proof':
        import health
        result=health.capture(request['height'],request['keys'])
    elif action=='empty-baseline':
        import health
        result=health.empty_baseline(request['chain_id'],request['genesis_sha256'])
    elif action=='checkpoint':result=stack.stopped_checkpoint(epoch,stack.node_inventory())
    else:raise ValueError('Unsupported node action')
    print(json.dumps(result))
if __name__=='__main__':
    os.umask(0o077)
    try:
        with installed.node_lock():main()
    except Exception:
        print('Reset-node operation refused or failed; inspect the bounded epoch journal.',file=sys.stderr)
        sys.exit(1)

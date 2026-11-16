"""App-only coordinator. Archive key is accepted through stdin, never argv."""
import datetime
import json
import os
import resource
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import uuid
import node

SSH=['ssh','-F','/dev/null','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
     '-o','UserKnownHostsFile=/etc/uain-node-backup/db_known_hosts',
     '-o','ConnectTimeout=15','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=4',
     '-i','/etc/uain-node-backup/db_ed25519','root@10.98.0.2','uain-node-backup']


def remote(request, source=None, destination=None):
    process=subprocess.Popen(SSH,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    try:
        process.stdin.write((json.dumps(request)+'\n').encode())
        if source:
            with Path(source).open('rb') as incoming: shutil.copyfileobj(incoming,process.stdin,1024*1024)
        process.stdin.close()
        if destination:
            with Path(destination).open('xb') as output:
                os.chmod(destination,0o600);size=0
                while data:=process.stdout.read(1024*1024):
                    size+=len(data)
                    if size>node.MAX_BYTES: raise ValueError('Oversized backup download')
                    output.write(data)
                output.flush();os.fsync(output.fileno())
            result=None
        else:
            raw=process.stdout.read(131073)
            if len(raw)>131072: raise ValueError('Oversized backup response')
            result=json.loads(raw)
        if process.wait(timeout=960)!=0: raise ValueError('Scoped remote backup failed')
        return result
    except BaseException:
        process.kill();process.wait();raise


def backup(key,stamp):
    # Capture one node at a time, restarting it before the other is stopped.
    app=node.run_capture(key,stamp)
    database=remote(dict(action='capture',key=key,stamp=stamp))
    node.require_role_pair([app,database])
    db_path=node.archive_path(database['name'])
    temporary=db_path.with_name(db_path.name+'.pending-'+uuid.uuid4().hex)
    try:
        remote(dict(action='get',name=database['name']),destination=temporary)
        verified=node.verify_restore(temporary,key)
        if verified['ciphertext_sha256']!=database['ciphertext_sha256'] or verified['manifest']!=database['manifest']:
            raise ValueError('Downloaded database node backup differs')
        os.link(temporary,db_path)
        node.atomic_json(db_path.with_suffix('.json'),database)
    finally: temporary.unlink(missing_ok=True)
    app_path=node.archive_path(app['name'])
    replica=remote(dict(action='put',name=app['name'],key=key,length=app_path.stat().st_size,
                        sha256=app['ciphertext_sha256']),source=app_path)
    if replica['ciphertext_sha256']!=app['ciphertext_sha256']:
        raise ValueError('App backup database replica differs')
    # Read the actual remote app replica back before reporting cross-host success.
    temporary=app_path.with_name(app_path.name+'.readback-'+uuid.uuid4().hex)
    try:
        remote(dict(action='get',name=app['name']),destination=temporary)
        if node.crypto.verify(temporary,key)['ciphertext_sha256']!=app['ciphertext_sha256']:
            raise ValueError('Cross-host readback differs')
    finally: temporary.unlink(missing_ok=True)
    return dict(created_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                stamp=stamp,backups=[app,database],cross_host_readback_verified=True,
                signer_restores_started=False,offsite_verified=False)


def finalize(receipt):
    if not receipt.get('offsite_verified') or not receipt.get('cross_host_readback_verified') or len(receipt['backups'])!=2:
        raise ValueError('All backup destinations must verify before retention')
    if {item['manifest']['host'] for item in receipt['backups']}!=set(node.HOSTS):
        raise ValueError('One independently captured backup per node required')
    node.require_role_pair(receipt['backups'])
    for item in receipt['backups']:
        if node.sha(node.archive_path(item['name']))!=item['ciphertext_sha256']:
            raise ValueError('Final backup checksum differs')
    receipt['retention']=dict(local_per_node=14,database=remote(dict(action='prune')),app=node.prune(),
                              offsite='timestamped objects retained; no provider deletion performed')
    node.atomic_json(node.ROOT/'last-success.json',receipt)
    return receipt


def check():
    receipt=json.loads((node.ROOT/'last-success.json').read_text())
    if len(receipt['backups'])!=2 or {item['manifest']['host'] for item in receipt['backups']}!=set(node.HOSTS) or not receipt.get('cross_host_readback_verified'):
        raise ValueError('Incomplete paired node backup')
    node.require_role_pair(receipt['backups'])
    date=datetime.datetime.fromisoformat(receipt['created_at'])
    age=(datetime.datetime.now(datetime.timezone.utc)-date).total_seconds()
    if not 0<=age<=26*3600 or not receipt['offsite_verified']:
        raise ValueError('Node backup is missing, stale or unverified')
    for item in receipt['backups']:
        if node.sha(node.archive_path(item['name']))!=item['ciphertext_sha256']:
            raise ValueError('Node backup checksum differs')
    return dict(healthy=True,age_seconds=round(age),backups=[x['name'] for x in receipt['backups']])


def main():
    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    if os.geteuid()!=0 or socket.gethostname().split('.')[0]!='uain-app-1':
        raise ValueError('App coordinator required')
    if sys.argv[1:]==['check']:
        result=check()
    else:
        raw=sys.stdin.buffer.read(131073)
        if len(raw)>131072: raise ValueError('Oversized backup request')
        value=json.loads(raw)
        if sys.argv[1:]==['run']:
            node.crypto.key_bytes(value['key']);result=backup(value['key'],value['stamp'])
        elif sys.argv[1:]==['verify']:
            result=node.verify_restore(node.archive_path(value['name']),value['key'])
        elif sys.argv[1:]==['finalize']: result=finalize(value)
        else: raise ValueError('Unsupported backup coordinator operation')
    print(json.dumps(result))


if __name__=='__main__':
    try: main()
    except Exception:
        print('Node backup coordinator refused or failed.',file=sys.stderr);sys.exit(1)

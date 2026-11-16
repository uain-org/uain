"""Forced database SSH endpoint: fixed node capture and ciphertext transport."""
import hashlib
import json
import os
import resource
from pathlib import Path
import socket
import sys
import uuid
import node


def request(stream):
    line=stream.readline(131073)
    if len(line)>131072 or not line.endswith(b'\n'):
        raise ValueError('Bounded JSON line required')
    value=json.loads(line)
    action=value.get('action')
    fields={'capture':{'action','key','stamp'},'get':{'action','name'},
            'put':{'action','name','key','length','sha256'},'prune':{'action'}}
    if action not in fields or set(value)!=fields[action]:
        raise ValueError('Unsupported backup request')
    return value


def receive(value, stream, output):
    action=value['action']
    if action=='capture':
        result=node.run_capture(value['key'],value['stamp'])
    elif action=='get':
        path=node.archive_path(value['name'])
        if not path.is_file() or path.stat().st_size>node.MAX_BYTES:
            raise ValueError('Invalid ciphertext file')
        with path.open('rb') as source:
            while data:=source.read(1024*1024): output.write(data)
        return
    elif action=='put':
        node.crypto.key_bytes(value['key'])
        path=node.archive_path(value['name']);length=value['length']
        if type(length)!=int or not 0<length<=node.MAX_BYTES or not isinstance(value['sha256'],str) or len(value['sha256'])!=64:
            raise ValueError('Invalid replica bounds')
        temporary=path.with_name(path.name+'.pending-'+uuid.uuid4().hex)
        digest=hashlib.sha256();remaining=length
        try:
            with temporary.open('xb') as target:
                os.chmod(temporary,0o600)
                while remaining:
                    data=stream.read(min(remaining,1024*1024))
                    if not data: raise ValueError('Truncated ciphertext replica')
                    target.write(data);digest.update(data);remaining-=len(data)
                if stream.read(1): raise ValueError('Oversized ciphertext replica')
                target.flush();os.fsync(target.fileno())
            if digest.hexdigest()!=value['sha256']:
                raise ValueError('Replica checksum differs')
            result=node.verify_restore(temporary,value['key'])
            if result['manifest']['backup_name']!=value['name']:
                raise ValueError('Replica identity differs')
            if path.exists():
                if node.sha(path)!=value['sha256']: raise ValueError('Refusing different immutable replica')
            else:
                os.link(temporary,path)
            result.update(name=path.name,replicated=True)
            node.atomic_json(path.with_suffix('.json'),result)
        finally: temporary.unlink(missing_ok=True)
    else:
        result={'removed':node.prune()}
    output.write((json.dumps(result)+'\n').encode())


def main():
    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    if os.geteuid()!=0 or socket.gethostname().split('.')[0]!='uain-db-1' or os.environ.get('SSH_ORIGINAL_COMMAND')!='uain-node-backup':
        raise ValueError('Wrong backup endpoint')
    receive(request(sys.stdin.buffer),sys.stdin.buffer,sys.stdout.buffer)


if __name__=='__main__':
    try: main()
    except Exception:
        print('Node backup endpoint refused or failed.',file=sys.stderr);sys.exit(1)

#!/usr/bin/python3 -I
"""Root-only forced SSH capability: public installation probe or live fence."""
import importlib.util
import json
import os
from pathlib import Path
import resource
import sys

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('roles',HERE/'failover-backup.py');r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)

def respond(node,command,request):
 if command=='serve-fence':
  if set(request)!={'nonce','fence_id','sha256'}:raise ValueError('Exact fence challenge required')
  return node.serve_fence(request)
 if command!='failover-probe' or set(request)!={'nonce'} or not isinstance(request['nonce'],str) or not r.f.HEX.fullmatch(request['nonce']):raise ValueError('Exact public probe required')
 manifest=json.loads((HERE.parents[1]/'install-files.json').read_text())
 for name,digest in manifest.items():
  target=Path('/opt/uain-node-backup')/Path(name).name if name.startswith('ops/node-backup/') else HERE.parents[1]/name
  if r.f.sha(target)!=digest:raise ValueError('Installed tool pin differs')
 return dict(nonce=request['nonce'],inventory=node.inventory(),bundle_sha256=r.f.sha(HERE.parents[1]/'install-files.json'),
             backup_node_sha256=r.f.sha('/opt/uain-node-backup/node.py'),backup_coordinator_sha256=r.f.sha('/opt/uain-node-backup/coordinator.py'))

def main():
 os.umask(0o077);resource.setrlimit(resource.RLIMIT_CORE,(0,0))
 if os.geteuid()!=0 or len(sys.argv)!=1:raise ValueError('Fixed root endpoint required')
 command=os.environ.get('SSH_ORIGINAL_COMMAND','');node=r.f.Node(r.PROFILE)
 raw=sys.stdin.buffer.read(131073)
 if len(raw)>131072:raise ValueError('Oversized challenge')
 print(json.dumps(respond(node,command,json.loads(raw))))

if __name__=='__main__':
 try:main()
 except Exception:print('Fixed failover source endpoint refused.',file=sys.stderr);sys.exit(1)

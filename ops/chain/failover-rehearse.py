#!/usr/bin/python3 -I
"""Server-only fictional two-host validator recovery rehearsal."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import time
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding,PublicFormat

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('failover',HERE/'failover-node.py');f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
ROOT=Path('/opt/uain-test/failover-20261012');HOME=ROOT/'node';UNIT='uain-failover-fixture-20261012.service';CHAIN='uain-failover-fixture-20261012';PROFILE=ROOT/'profile.json';BINARY=ROOT/'uaind';MARKER='uain-failover-fixture-20261012'
SSH=['ssh','-F','/dev/null','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile=/etc/uain-node-backup/db_known_hosts','-o','ConnectTimeout=15','-i',str(ROOT/'ssh_fixture'),'root@10.98.0.2','fixture']


def run(args):
 result=subprocess.run(args,capture_output=True,timeout=180)
 if result.returncode:raise ValueError('Fictional fixture operation failed')
 return result.stdout.decode().strip()


def setup(app_genesis,canonical=None,peer=None):
 host=socket.gethostname().split('.')[0];ip={'uain-app-1':'10.98.0.1','uain-db-1':'10.98.0.2'}[host];unit=Path('/etc/systemd/system')/UNIT
 if HOME.exists() or unit.exists() or unit.is_symlink() or PROFILE.exists():raise ValueError('Fresh fictional scope required')
 ROOT.mkdir(mode=0o700,exist_ok=True);os.chmod(ROOT,0o755);BINARY.chmod(0o755)
 app=ROOT/'app-genesis.json';f.atomic(app,app_genesis)
 run([str(BINARY),'init','--home',str(HOME),'--chain-id',CHAIN,'--app-genesis',str(app),'--rpc','tcp://127.0.0.1:38657','--p2p','tcp://'+ip+':38656'])
 if canonical:(HOME/'config/genesis.json').write_bytes(base64.b64decode(canonical,validate=True))
 config=HOME/'config/config.toml';text=config.read_text();text=re.sub(r'^addr_book_strict = .*$', 'addr_book_strict = false',text,flags=re.M)
 if peer:
  if not re.fullmatch(r'[a-f0-9]{40}',peer):raise ValueError('Exact public peer required')
  text=re.sub(r'^persistent_peers = .*$', 'persistent_peers = "'+peer+'@10.98.0.1:38656"',text,flags=re.M)
 config.write_text(text)
 uid=__import__('pwd').getpwnam('uain-chain').pw_uid;gid=__import__('grp').getgrnam('uain-chain').gr_gid
 for path in [HOME,*HOME.rglob('*')]:os.chown(path,uid,gid)
 HOME.chmod(0o750)
 unit.write_text('[Unit]\nDescription=Fictional UAIN two-host failover rehearsal\n[Service]\nUser=uain-chain\nGroup=uain-chain\nWorkingDirectory='+str(HOME)+'\nExecStart='+str(BINARY)+' start --home '+str(HOME)+'\nCPUQuota=200%\nMemoryMax=3G\nTasksMax=256\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=true\nInaccessiblePaths=-/var/lib/uain-chain -/var/lib/uain-wallet-node -/var/lib/uain-private-state -/etc/uain-custody\nCapabilityBoundingSet=\nProtectKernelTunables=true\nProtectControlGroups=true\nProtectSystem=strict\nReadWritePaths='+str(HOME)+'\nTimeoutStopSec=30\n')
 f.atomic(PROFILE,dict(host=host,unit=UNIT,unit_sha256=f.sha(unit),home=str(HOME),binary=str(BINARY),binary_sha256=f.sha(BINARY),genesis_sha256=f.sha(HOME/'config/genesis.json'),chain_id=CHAIN,rpc_port=38657,p2p_port=38656,p2p_ip=ip,root=str(ROOT/'evidence'),service_user='uain-chain',service_group='uain-chain'))
 run(['systemctl','daemon-reload']);run(['systemctl','start',UNIT]);return f.Node(PROFILE)


def remote(request,source=None):
 process=subprocess.Popen(SSH,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
 try:
  process.stdin.write((json.dumps(request)+'\n').encode())
  if source:
   with Path(source).open('rb') as stream:shutil.copyfileobj(stream,process.stdin,1024*1024)
  process.stdin.close();raw=process.stdout.read(1024*1024+1)
  if len(raw)>1024*1024 or process.wait(timeout=240)!=0:raise ValueError('Root-channel fictional endpoint failed')
  return json.loads(raw)
 finally:
  if process.poll() is None:process.kill();process.wait()


def query(node,member,height='0'):
 return node.rpc('abci_query',dict(path='/store/federation/key',data=('member/'+member).encode().hex(),height=str(height),prove=True))['response']


def receive():
 if socket.gethostname().split('.')[0]!='uain-db-1':raise ValueError('Fictional database endpoint only')
 raw=sys.stdin.buffer.readline(131073)
 if len(raw)>131072:raise ValueError('Oversized fixture request')
 p=json.loads(raw);action=p.pop('action')
 allowed={'bootstrap':{'app_genesis','canonical','peer'},'checkpoint':set(),'member':{'member','height'},'put':{'name','length','sha256','key'},'restore':{'name','sha256','key'},'promote':set(),'restart':set(),'cleanup':set()}
 if action not in allowed or set(p)!=allowed[action]:raise ValueError('Fixed fixture request required')
 if action=='bootstrap':node=setup(p['app_genesis'],p['canonical'],p['peer']);result=dict(prepared=True)
 else:
  node=f.Node(PROFILE)
  if action=='checkpoint':result=node.checkpoint()
  elif action=='member':
   if not re.fullmatch(r'uain1[a-f0-9]{40}',p['member']):raise ValueError('Fixture member required')
   result=query(node,p['member'],p['height'])
  elif action=='put':
   path=node.archive_path(p['name'])
   if type(p['length'])!=int or not 0<p['length']<=16*1024**3 or path.exists():raise ValueError('Fresh bounded capsule required')
   remaining=p['length']
   with path.open('xb') as output:
    os.chmod(path,0o600)
    while remaining:
     chunk=sys.stdin.buffer.read(min(1024*1024,remaining))
     if not chunk:raise ValueError('Truncated root-channel capsule')
     output.write(chunk);remaining-=len(chunk)
    output.flush();os.fsync(output.fileno())
   if f.sha(path)!=p['sha256']:raise ValueError('Root-channel ciphertext differs')
   result=f.crypto.verify(path,p['key'])
  elif action=='restore':result=node.restore(p['name'],p['key'],p['sha256'])
  elif action=='promote':result=node.promote()
  elif action=='restart':
   receipt=json.loads((node.root/'restore.json').read_text());node.live_fence(receipt['source'],receipt['ciphertext_sha256'])
   if not receipt['promoted']:raise ValueError('Only already-promoted fixture restart allowed')
   before=node.checkpoint();run(['systemctl','stop',UNIT]);run(['systemctl','start',UNIT]);wait(lambda:node.checkpoint()['height']>before['height']);result=dict(restarted=True,checkpoint=node.checkpoint())
  else:
   run(['systemctl','stop',UNIT]);auth=Path('/root/.ssh/authorized_keys')
   lines=auth.read_text().splitlines();auth.write_text('\n'.join(line for line in lines if not line.endswith(' '+MARKER))+'\n');auth.chmod(0o600)
   for name in ('uain-app-1_ed25519','uain-app-1_ed25519.pub','known_hosts'):(ROOT/name).unlink(missing_ok=True)
   result=dict(fixture_stopped=True,temporary_transport_removed=True)
 print(json.dumps(result))


def wait(check):
 last=None
 for _ in range(180):
  try:
   result=check()
   if result:return result
  except Exception as e:last=type(e).__name__
  time.sleep(.5)
 raise ValueError('Fictional node did not reach expected state: '+str(last))


def rehearsal():
 if socket.gethostname().split('.')[0]!='uain-app-1':raise ValueError('Fictional source app host only')
 key=Ed25519PrivateKey.generate();pub=key.public_key().public_bytes(Encoding.Raw,PublicFormat.Raw);member='uain1'+hashlib.sha256(pub).hexdigest()[:40]
 pub64=base64.urlsafe_b64encode(pub).rstrip(b'=').decode()
 # Keep a second fictional active guardian when the event member withdraws;
 # the rehearsal proves infrastructure recovery without orphaning app authority.
 backup_pub=Ed25519PrivateKey.generate().public_key().public_bytes(Encoding.Raw,PublicFormat.Raw)
 backup_member='uain1'+hashlib.sha256(backup_pub).hexdigest()[:40]
 original=dict(id=member,public_key=pub64,name='fictional recovery member',operator='fictional recovery operator',family='fixture',licence='active',karma=0,credits='0',sequence='0',default_verifier=False,creator=False,active_projects=0)
 backup=dict(original,id=backup_member,public_key=base64.urlsafe_b64encode(backup_pub).rstrip(b'=').decode(),name='fictional continuing guardian')
 genesis=dict(version=1,guardians=[member,backup_member],members=[original,backup])
 node=setup(genesis);wait(lambda:node.checkpoint()['height']>=2)
 peer=run([str(BINARY),'node-id','--home',str(HOME)])
 remote(dict(action='bootstrap',app_genesis=genesis,canonical=base64.b64encode((HOME/'config/genesis.json').read_bytes()).decode(),peer=peer))
 c=dict(version=1,chain_id=CHAIN,member=member,sequence='0',expires_height='1000',operation='withdraw',payload={})
 message=b'uain:chain-command:v1\n'+json.dumps(c,separators=(',',':')).encode();signature=base64.urlsafe_b64encode(key.sign(message)).rstrip(b'=').decode()
 envelope=json.dumps(dict(command=c,public_key=pub64,signature=signature),separators=(',',':')).encode()
 result=node.rpc('broadcast_tx_commit',dict(tx=base64.b64encode(envelope).decode()))
 if result['check_tx']['code']!=0 or result['tx_result']['code']!=0:raise ValueError('Fictional signed event failed')
 tx_height=int(result['height']);wait(lambda:node.checkpoint()['height']>tx_height)
 before=query(node,member,tx_height)
 if not before.get('proofOps') or json.loads(base64.b64decode(before['value']))['licence']!='withdrawn':raise ValueError('Original signed state proof absent')
 wait(lambda:remote(dict(action='checkpoint'))['height']>tx_height)
 replica=remote(dict(action='member',member=member,height=str(tx_height)))
 if replica['value']!=before['value']:raise ValueError('Initial fullnode did not replicate original event')
 preview=node.preview();f.atomic(ROOT/'preview.json',preview);fence=node.fence(preview['checkpoint'])
 archive_key=os.urandom(32).hex() # Fictional archive key exists only in server RAM.
 capsule=node.export(archive_key);path=node.archive_path(capsule['name'])
 transport=remote(dict(action='put',name=capsule['name'],length=path.stat().st_size,sha256=capsule['ciphertext_sha256'],key=archive_key),source=path)
 if transport['ciphertext_sha256']!=capsule['ciphertext_sha256']:raise ValueError('Root-channel readback differs')
 restored=remote(dict(action='restore',name=capsule['name'],sha256=capsule['ciphertext_sha256'],key=archive_key))
 if restored['signing_state']!=fence['signing_state']:raise ValueError('Highest signing state not preserved')
 promoted=remote(dict(action='promote'))
 after=remote(dict(action='member',member=member,height=str(tx_height)))
 if after['value']!=before['value'] or not after.get('proofOps'):raise ValueError('Promotion lost original signed state/history')
 restarted=remote(dict(action='restart'))
 after_restart=remote(dict(action='member',member=member,height=str(tx_height)))
 if after_restart['value']!=before['value']:raise ValueError('Destination restart lost original history')
 attempted=subprocess.run(['systemctl','start',UNIT],capture_output=True)
 if attempted.returncode==0:raise ValueError('Source persistent fence failed restart attempt')
 final_source=node.fence_proof()
 receipt=dict(passed=True,production_nodes_mutated=False,chain_id=CHAIN,binary_sha256=f.sha(BINARY),genesis_sha256=node.p['genesis_sha256'],original_signed_event_height=tx_height,original_signed_event_sha256=hashlib.sha256(envelope).hexdigest(),checkpoint=preview['checkpoint'],source_fence=fence,final_source_fence=final_source,source_restart_refused=True,ciphertext_sha256=capsule['ciphertext_sha256'],highest_signing_state_preserved=True,destination_after=promoted['after_checkpoint'],destination_restart=restarted,original_member_value_preserved=True,original_state_proof_preserved=True,two_host_quorum_tolerance_claimed=False,unprivileged_service_user='uain-chain',destination_owner=restored['owner'],source_independently_challenged_by_destination=True)
 f.atomic(ROOT/'result.json',receipt);remote(dict(action='cleanup'));(ROOT/'ssh_fixture').unlink();(ROOT/'ssh_fixture.pub').unlink()
 auth=Path('/root/.ssh/authorized_keys');lines=auth.read_text().splitlines();auth.write_text('\n'.join(line for line in lines if not line.endswith(' uain-failover-source-challenge-20261012'))+'\n');auth.chmod(0o600)
 print(json.dumps(receipt))

if __name__=='__main__':
 os.umask(0o077)
 try:
  if os.geteuid()!=0 or sys.argv[1:] not in (['run'],['receive']):raise ValueError('Root fictional rehearsal only')
  rehearsal() if sys.argv[1]=='run' else receive()
 except Exception:
  print('Fictional failover rehearsal refused or failed; retained fences stay in place.',file=sys.stderr);sys.exit(1)

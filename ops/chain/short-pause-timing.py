#!/usr/bin/python3 -I
"""Measure the short-pause capture on a fictional tree of production-like size.

Runs failover-backup.capture against a synthetic validator home (random
bytes, no key material, no real node) while a writer thread appends to it the
way a running validator does. "Stopping" the fake node stops the writer. It
never touches systemd, a real node home or a key. Run it as root in a
throwaway container, for example on uain-app-1:

  docker run --rm --network none --memory 3g --cpus 2 -v <checkout>:/src:ro \
    -v /opt/uain-test/short-pause:/fixture uain-ci-runtime:<tag> \
    python3 -I -B /src/ops/chain/short-pause-timing.py /fixture 2400

Prints one JSON line with the receipt's timing fields.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import threading
import time
from types import SimpleNamespace
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('role_backup',Path(__file__).with_name('failover-backup.py'));r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)

# Production layout on 9 Nov 2026: 835 files, 2.4 GiB (blockstore 1.2 G,
# cs.wal 1.0 G in 10 MiB segments, application 95 M, state 52 M, tx_index 19 M).
LAYOUT=[('blockstore.db',2*1024**2,0.50),('cs.wal',10*1024**2,0.42),('application.db',2*1024**2,0.04),('state.db',2*1024**2,0.025),('tx_index.db',2*1024**2,0.015)]

def build(home,megabytes):
 (home/'config').mkdir(parents=True);(home/'data').mkdir()
 (home/'config/genesis.json').write_text(json.dumps(dict(validators=[dict(address='fixture')],chain_id='timing-fixture')))
 (home/'config/priv_validator_key.json').write_text(json.dumps(dict(address='fixture',note='FICTIONAL, NO KEY')))
 (home/'data/priv_validator_state.json').write_text(json.dumps(dict(height='1',round=0,step=3)))
 total=megabytes*1024**2
 for name,size,share in LAYOUT:
  directory=home/'data'/name;directory.mkdir()
  for index in range(max(1,int(total*share)//size)):
   with (directory/('%06d.part'%index)).open('wb') as out:out.write(os.urandom(size))

def main():
 if os.geteuid()!=0 or len(sys.argv)!=3:raise SystemExit('usage (root): short-pause-timing.py <empty fixture dir> <megabytes>')
 root=Path(sys.argv[1]);megabytes=int(sys.argv[2])
 for child in list(root.iterdir()):shutil.rmtree(child) if child.is_dir() else child.unlink()
 home=root/'chain/node';home.parent.mkdir();store=root/'archives';store.mkdir(mode=0o700)
 started=time.monotonic();build(home,megabytes);built=time.monotonic()-started
 binary=root/'uaind';binary.write_text('fictional daemon');unit=root/'unit';unit.write_text('fictional unit')
 inv=dict(host='uain-app-1',home=str(home),binary_sha256=r.f.sha(binary),unit_sha256=r.f.sha(unit),genesis_sha256=r.f.sha(home/'config/genesis.json'),chain_id='timing-fixture')
 running=threading.Event();running.set();height=[1];writes=[0]
 def writer():
  wal=home/'data/cs.wal/wal';tick=0
  while running.is_set():
   with wal.open('ab') as out:out.write(os.urandom(64*1024))
   tick+=1;writes[0]+=1
   if tick%40==0:
    (home/'data/blockstore.db'/('new-%06d.part'%tick)).write_bytes(os.urandom(2*1024**2))
    height[0]+=1;(home/'data/priv_validator_state.json').write_text(json.dumps(dict(height=str(height[0]),round=0,step=3)))
   time.sleep(0.05)
 thread=[None]
 def start():running.set();thread[0]=threading.Thread(target=writer,daemon=True);thread[0].start()
 def run(args):
  if args[1]=='stop':running.clear();thread[0].join()
  elif args[1]=='start':start()
 start()
 node=SimpleNamespace(root=root/'evidence',home=home,p=dict(host='uain-app-1',unit=r.b.UNIT,binary=str(binary)),unit_file=unit,original_unit=unit,
  inventory=lambda:inv,signing_state=lambda:dict(height=height[0],round=0,step=3,sha256=r.f.sha(home/'data/priv_validator_state.json')),run=run,
  system_state=lambda:dict(active='active' if running.is_set() else 'inactive',pid=1 if running.is_set() else 0),matching_processes=lambda:[],listening_ports=lambda:[],require_single_signer=lambda *a:None)
 node.root.mkdir(mode=0o700)
 with patch.object(r.b,'ROOT',store),patch.object(r.b,'HOME_BASE',home.parent),patch.object(r.b,'MARKER',root/'restart.json'),patch.object(r.b,'CAPTURE_LOCK',root/'capture.lock'),patch.object(r.b,'CAPSULE_TMP',root),patch.object(r,'CUSTODY_LOCK',root/'custody.lock'),patch.object(r,'RUN_LOCK',root/'run.lock'):
  time.sleep(2);receipt=r.capture(node,'ab'*32,'20261109T120000Z')
 running.clear()
 fields=['precopy_seconds','validator_stop_seconds','stopped_copy_seconds','final_sync_changes','post_restart_seal_verify_seconds','capture_pause_seconds','stopped_copy_deadline_seconds','pause_limit_seconds','custody_lock_wait_seconds','custody_lock_held_seconds']
 print(json.dumps(dict(fixture_bytes=receipt['manifest']['tree']['bytes'],fixture_files=receipt['manifest']['tree']['files'],build_seconds=round(built,1),writer_appends=writes[0],full_tree_restore_verified=receipt['full_tree_restore_verified'],**{k:receipt[k] for k in fields})))

if __name__=='__main__':main()

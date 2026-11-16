#!/usr/bin/python3 -I
"""Qualify captures on the retained, already promoted fictional two-host fixture."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import time

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('role_backup',HERE/'failover-backup.py');r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
ROOT=Path('/opt/uain-test/failover-role-backup-20261012')
FIXTURE=Path('/opt/uain-test/failover-20261012')

def main():
 os.umask(0o077)
 host=socket.gethostname().split('.')[0]
 if os.geteuid()!=0 or host not in r.b.HOSTS or len(sys.argv)!=1:raise ValueError('Fixed server fixture only')
 node=r.f.Node(FIXTURE/'profile.json')
 if node.p['unit']!='uain-failover-fixture-20261012.service':raise ValueError('Only fictional fixture may be captured')
 r.b.ROOT=ROOT/'archives';r.b.ROOT.mkdir(mode=0o700,exist_ok=True)
 r.b.HOME_BASE=FIXTURE;r.b.MARKER=ROOT/'restart.json';r.b.CAPTURE_LOCK=ROOT/'capture.lock';r.b.CAPSULE_TMP=ROOT;r.CUSTODY_LOCK=ROOT/'custody.lock';r.RUN_LOCK=ROOT/'run.lock'
 key=os.urandom(32).hex();stamp='20261012T020101Z'
 if host=='uain-app-1':
  before=node.fence_proof()
  # Existing paired-backup implementation cannot capture the frozen source.
  # Its refusal is the regression's explicit red evidence, not a live defect.
  try:r.b.capture(key,'20261012T020100Z')
  except Exception:r.b.atomic_json(ROOT/'red.json',dict(old_capture_refused_frozen_source=True))
  else:raise ValueError('Old backup unexpectedly captured a stopped source')
  receipt=r.capture(node,key,stamp)
  after=node.fence_proof()
  if before['tree']!=after['tree'] or before['signing_state']!=after['signing_state'] or r.b.MARKER.exists() or not receipt['source_remains_fenced']:raise ValueError('Frozen source changed or acquired restart authority')
  result=dict(receipt=receipt,source_frozen_verified=True)
 else:
  receipt_before=r.private_json(node.root/'restore.json')
  if receipt_before.get('promoted') is not True:raise ValueError('Existing promoted fixture required')
  try:
   node.run(['systemctl','start',node.p['unit']])
   deadline=time.monotonic()+45
   while time.monotonic()<deadline:
    try:
     checkpoint=node.checkpoint()
     if checkpoint['height']>=receipt_before['after_checkpoint']['height']:break
    except Exception:pass
    time.sleep(.5)
   else:raise ValueError('Promoted fixture did not resume')
   first=r.capture(node,key,stamp);middle=node.checkpoint();state=node.signing_state()
   second=r.capture(node,key,'20261012T020102Z');after=node.checkpoint()
   if r.state_position(node.signing_state())<r.state_position(state) or after['height']<middle['height']:raise ValueError('Repeated backup rolled back signer')
   r.f.check_checkpoint(receipt_before['source']['checkpoint'],node.checkpoint(receipt_before['source']['checkpoint']['height']))
   result=dict(receipt=first,repeated_receipt=second,after_checkpoint=after,signing_state_monotonic=True,source_challenge_verified=True)
  finally:node.run(['systemctl','stop',node.p['unit']])
 r.b.atomic_json(ROOT/'result.json',result);print(json.dumps(dict(host=host,role=result['receipt']['manifest']['node_role']['name'],verified=True)))

if __name__=='__main__':
 try:main()
 except Exception:print('Fictional role-backup rehearsal failed.',file=sys.stderr);sys.exit(1)

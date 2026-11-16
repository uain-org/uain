#!/usr/bin/env python3
"""Submit/reconcile exact approved PUBLIC treasury bytes. No vault access."""
import argparse
import fcntl
import os
from pathlib import Path
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'custody'))
import treasury

if __name__=='__main__':
 try:
  parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('operation',choices=('register','submit','reconcile','recover'));parser.add_argument('execution');args=parser.parse_args()
  treasury.require(os.geteuid()==0);os.umask(0o077)
  with open('/run/lock/uain-treasury-execution.lock','a') as lock:
   fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
   getattr(treasury,args.operation)(args.execution)
 except Exception:
  print('Treasury execution refused; inspect public journals and reconcile the exact transaction ID before any recovery.',file=sys.stderr);sys.exit(1)

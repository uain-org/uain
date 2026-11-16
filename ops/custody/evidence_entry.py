#!/usr/bin/python3 -I
"""Root entry of uain-evidence-backup.service: the daily public evidence backup.

Installed as /opt/uain-evidence-backup/entry.py beside this repository's
ops/custody/evidence.py, and run by /usr/local/sbin/uain-evidence-backup. It
uses the installed custody module only to read the vault and the storage
secret, under the custody lock, and never replaces or changes that module.
"""
import importlib.util
import os
from pathlib import Path
import resource
import sys

HERE=Path(__file__).resolve().parent
CUSTODY=Path('/opt/uain-custody/custody.py')
sys.dont_write_bytecode=True

def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def main():
 os.umask(0o077);resource.setrlimit(resource.RLIMIT_CORE,(0,0))
 if os.geteuid()!=0 or len(sys.argv)!=2:raise ValueError('Root and the trusted public evidence helper checkout required')
 evidence=load('uain_evidence',HERE/'evidence.py')
 evidence.backup_narrow(load('uain_custody',CUSTODY),sys.argv[1])

if __name__=='__main__':
 try:main()
 except Exception as error:
  # Never print library exception representations: they can include secret values.
  print('Evidence backup failed ('+type(error).__name__+'); check the documented prerequisites',file=sys.stderr);sys.exit(1)

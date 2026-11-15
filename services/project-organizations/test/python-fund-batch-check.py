"""FIXTURE QUALIFICATION ONLY: runs the production root driver's fund batch check
(ops/custody/manager_stage.py `load_fund_batch`, unchanged) on one fund batch that the manager
stage wrote during the fictional-chain qualification (native-daemon-e2e-stage.mjs, `fund` stage).

Usage (spawned by the Node stage): python3 -I -B python-fund-batch-check.py <custodyDir> <stageRoot> <batch> <OPP>

Fixture only: the trusted uid is the container's own and the protected-parent walk stops at the
temporary stage root. Prints {"status": "accepted", "request": ...} or {"status": "refused", "code": ...}.
"""
import importlib.util
import json
import os
import sys
from pathlib import Path


def main():
    custody_dir, stage_root, path, project = sys.argv[1:5]
    spec = importlib.util.spec_from_file_location('manager_stage', Path(custody_dir) / 'manager_stage.py')
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    m.TRUSTED_UIDS = (os.getuid(),)
    m.BOUNDARY = Path(stage_root)
    m.STAGE_ROOT = Path(stage_root)
    try:
        batch = m.load_fund_batch(Path(path), project)
        print(json.dumps(dict(status='accepted', request=batch['request'])))
    except m.Stop as stop:
        print(json.dumps(dict(status='refused', code=str(stop))))


main()

"""Server-only backup rehearsal on an explicitly fictional smoke fixture."""
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import node


def main():
    if os.geteuid()!=0 or len(sys.argv)!=4: raise ValueError('Root and source fixture, daemon, new destination required')
    source,binary,root=map(Path,sys.argv[1:])
    if source.resolve()!=source or not re.fullmatch(r'/tmp/uain-chain-smoke-[A-Za-z0-9]+/one',str(source)) or json.loads((source/'config/genesis.json').read_text())['chain_id']!='uain-smoke-1':
        raise ValueError('Only the fictional two-node smoke fixture is allowed')
    if not re.fullmatch(r'/opt/uain-test/[a-z0-9-]+/rehearsal',str(root)) or root.exists():
        raise ValueError('Fresh server test destination required')
    root.mkdir(mode=0o755);base=root/'nodes';base.mkdir();home=base/'fixture-node';shutil.copytree(source,home)
    config=home/'config/config.toml';text=config.read_text().replace(':34867',':35067').replace(':34866',':35066');config.write_text(text)
    pin=node.sha(binary);release=root/'releases'/pin;release.mkdir(parents=True);os.link(binary,release/'uaind')
    unit='uain-node-backup-fixture-20261009.service';unit_file=Path('/etc/systemd/system')/unit
    if unit_file.exists(): raise ValueError('Fixture unit already exists')
    unit_file.write_text('[Unit]\nDescription=Disposable fictional UAIN node backup rehearsal\n[Service]\nUser=uain-chain\nGroup=uain-chain\nWorkingDirectory='+str(home)+'\nExecStart='+str(release/'uaind')+' start --home '+str(home)+'\nMemoryMax=1G\nCPUQuota=100%\nTasksMax=128\nNoNewPrivileges=true\nProtectSystem=strict\nReadWritePaths='+str(home)+'\n')
    subprocess.run(['chown','-R','uain-chain:uain-chain',str(home)],check=True)
    node.ROOT=root/'backups';node.ROOT.mkdir(mode=0o700);node.HOME_BASE=base;node.RELEASE_BASE=root/'releases'
    node.UNIT=unit;node.UNIT_FILE=unit_file;node.MARKER=root/'restart.json';node.CAPTURE_LOCK=root/'capture.lock';node.CAPSULE_TMP=root
    def status():
        req=urllib.request.Request('http://127.0.0.1:35067',data=json.dumps(dict(jsonrpc='2.0',id=1,method='status')).encode(),headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(req,timeout=3) as response:return json.load(response)['result']
    def wait_height(minimum):
        for _ in range(180):
            try:
                value=status()
                if int(value['sync_info']['latest_block_height'])>minimum:return value
            except Exception:pass
            time.sleep(.25)
        raise ValueError('Fictional node failed to resume')
    try:
        node.run(['systemctl','daemon-reload']);node.run(['systemctl','start',unit]);before=wait_height(0)
        receipt=node.capture('ab'*32,datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
        after=wait_height(int(before['sync_info']['latest_block_height']))
        assert before['node_info']['id']==after['node_info']['id'] and before['sync_info']['latest_app_hash']==after['sync_info']['latest_app_hash']
        result=dict(passed=True,production_node_mutated=False,real_native_restart_resumed=True,restored_signer_started=False,
                    chain_id=after['node_info']['network'],before_height=before['sync_info']['latest_block_height'],
                    after_height=after['sync_info']['latest_block_height'],backup=receipt)
        (root/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
    finally:
        subprocess.run(['systemctl','stop',unit],check=False);unit_file.unlink();subprocess.run(['systemctl','daemon-reload'],check=False)


if __name__=='__main__':main()

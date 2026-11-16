"""Fixed-scope node operations. Invoked by the coordinator, not a public API."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid
import shutil
import archive
import database
import native
import checkpoint

HOME_BASE=Path('/var/lib/uain-chain')
ARCHIVE_BASE=Path('/var/lib/uain-reset')
UNIT='uain-chain-shadow.service'
NODE_USER='uain-chain'
RPC_PORT=26667
P2P_PORT=26666
APP_ADDRESS='10.98.0.1'
DB_ADDRESS='10.98.0.2'
DATABASE='uain'

def command(argv,input=None):
    result=subprocess.run(argv,input=input,capture_output=True)
    if result.returncode:raise RuntimeError('Scoped system operation failed')
    return result.stdout

def unit_active(name):
    # 13 November 2026 (security review OP-4): `is-active` is false for a running oneshot
    # ("activating") or a unit still stopping. Anything but inactive/failed is active;
    # an unreadable state refuses (every caller is a "must be stopped" guard).
    state=command(['systemctl','show','-p','ActiveState','--value',name]).decode().strip()
    if not state:raise RuntimeError('Unit state unavailable')
    return state not in ('inactive','failed')

def node_inventory():
    home=Path(command(['systemctl','show',UNIT,'-p','WorkingDirectory','--value']).decode().strip())
    if home.parent!=HOME_BASE or home.resolve()!=home or not re.fullmatch(r'[a-z0-9_-]{1,64}',home.name):
        raise ValueError('Unexpected native home')
    unit=command(['systemctl','cat',UNIT]).decode()
    found=re.search(r'ExecStart=(/opt/uain-chain/releases/[a-f0-9]{64}/uaind) start --home '+re.escape(str(home)),unit)
    if not found:raise ValueError('Unexpected node binary/unit')
    genesis=json.loads((home/'config/genesis.json').read_text())
    return {'home':str(home),'binary':found.group(1),'unit':unit,
            'genesis_sha256':hashlib.sha256((home/'config/genesis.json').read_bytes()).hexdigest(),
            'chain_id':genesis['chain_id'],'genesis':genesis,'active':unit_active(UNIT)}

def epoch_dir(epoch):
    if not re.fullmatch(r'[0-9]{8}_[0-9]{6}',epoch):raise ValueError('Invalid epoch')
    parent=ARCHIVE_BASE/epoch
    if parent.resolve()!=parent:raise ValueError('Archive path is redirected')
    parent.mkdir(parents=True,mode=0o700,exist_ok=True)
    return parent

def pipeline_archive(argv,destination,key):
    destination=Path(destination)
    if destination.exists():return archive.verify(destination,key)
    temporary=destination.with_name(destination.name+'.pending-'+uuid.uuid4().hex)
    process=subprocess.Popen(argv,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    try:
        result=archive.seal(process.stdout,temporary,key)
        if process.wait()!=0:raise RuntimeError('Archive source failed')
        os.link(temporary,destination);temporary.unlink()
        return result
    except Exception:
        process.kill();process.wait();temporary.unlink(missing_ok=True);raise

def chain_archive(epoch,expected,key):
    if unit_active(UNIT):raise ValueError('Native signer must be stopped before capture')
    current=node_inventory()
    if current['home']!=expected['home'] or current['genesis_sha256']!=expected['genesis_sha256']:
        raise ValueError('Native configuration changed')
    home=Path(expected['home']);directory=epoch_dir(epoch)
    receipt=pipeline_archive(['tar','--one-file-system','-czf','-','-C',str(home.parent),home.name],directory/'chain.resetbk',key)
    restored_tree=directory/('restore-check-'+uuid.uuid4().hex)
    archive.unpack(directory/'chain.resetbk',key,restored_tree)
    # Full-tree digest includes current validator signing state and block data.
    if tree_hash(home)!=tree_hash(restored_tree/home.name):raise ValueError('Restored native tree differs')
    shutil.rmtree(restored_tree)
    return receipt

def tree_hash(root):
    root=Path(root)
    if root.resolve()!=root or not root.is_dir():raise ValueError('Native state must be a non-symlink directory')
    digest=hashlib.sha256()
    for path in sorted(Path(root).rglob('*')):
        if path.is_symlink():raise ValueError('Symlink in native state')
        if path.is_file():
            digest.update(str(path.relative_to(root)).encode()+b'\0')
            with path.open('rb') as source:
                while data:=source.read(1024*1024):digest.update(data)
    return digest.hexdigest()

def stopped_checkpoint(epoch,expected):
    """Read only a disposable public application-store copy, never node keys."""
    if unit_active(UNIT):raise ValueError('Stop consensus before its public checkpoint')
    current=node_inventory()
    if current['home']!=expected['home'] or current['genesis_sha256']!=expected['genesis_sha256']:raise ValueError('Original public genesis changed')
    source=Path(expected['home'])/'data/application.db'
    before=tree_hash(source);directory=epoch_dir(epoch)/('public-app-'+uuid.uuid4().hex)
    directory.mkdir(mode=0o700);data=directory/'data';data.mkdir(mode=0o700)
    try:
        shutil.copytree(source,data/'application.db',symlinks=False)
        if tree_hash(data/'application.db')!=before:raise ValueError('Stopped application copy differs')
        genesis=directory/'genesis.json';shutil.copyfile(Path(expected['home'])/'config/genesis.json',genesis)
        result=subprocess.run([str(checkpoint.OFFLINE),'--database-dir',str(data),'--genesis',str(genesis),'--genesis-sha256',expected['genesis_sha256']],capture_output=True,timeout=90)
        if result.returncode or len(result.stdout)>2*1024*1024 or tree_hash(source)!=before:raise ValueError('Stopped application checkpoint failed or source changed')
        value=json.loads(result.stdout)
        if value['chain_id']!=expected['chain_id'] or value['genesis_sha256']!=expected['genesis_sha256']:raise ValueError('Stopped checkpoint identity differs')
        return value
    finally:shutil.rmtree(directory)

def stage_archive(epoch,staged,key):
    if unit_active(UNIT):raise ValueError('Archive fresh identities before starting the new signer')
    home=HOME_BASE/('epoch-'+epoch)
    if str(home)!=staged['home'] or hashlib.sha256((home/'config/genesis.json').read_bytes()).hexdigest()!=staged['genesis_sha256']:
        raise ValueError('Fresh native identity differs')
    directory=epoch_dir(epoch)
    receipt=pipeline_archive(['tar','--one-file-system','-czf','-','-C',str(home.parent),home.name],directory/'new-chain.resetbk',key)
    check=directory/('new-chain-restore-'+uuid.uuid4().hex)
    archive.unpack(directory/'new-chain.resetbk',key,check)
    if tree_hash(home)!=tree_hash(check/home.name):raise ValueError('Fresh identity restore differs')
    shutil.rmtree(check)
    return {**receipt,'genesis_sha256':staged['genesis_sha256'],'never_roll_back_signing_state':True}

def db_archive(epoch,expected,key):
    if database.snapshot(DATABASE)!=expected['before']:raise ValueError('Database changed before archive')
    directory=epoch_dir(epoch)
    prefix=[] if os.environ.get('UAIN_RESET_TEST')=='1' else ['runuser','-u','postgres','--']
    receipt=pipeline_archive([*prefix,'pg_dump','-Fc',DATABASE],directory/'database.resetbk',key)
    restored='uain_restore_'+epoch+'_'+uuid.uuid4().hex[:8]
    database.sql('postgres','CREATE DATABASE '+database.identifier(restored)+' TEMPLATE template0;')
    process=subprocess.Popen([*prefix,'pg_restore','--exit-on-error','--no-owner','-d',restored],stdin=subprocess.PIPE,stderr=subprocess.DEVNULL)
    try:
        archive.open_verified(directory/'database.resetbk',key,process.stdin);process.stdin.close()
        if process.wait()!=0:raise ValueError('Reset database archive restore failed')
    except Exception:process.kill();process.wait();raise
    # Restore changes owner fields in pg_sequences; compare values and contents.
    original=expected['before'];recovered=database.snapshot(restored)
    if original['tables']!=recovered['tables'] or original['hashes']!=recovered['hashes'] or original['head']!=recovered['head'] or original['roots']!=recovered['roots']:
        raise ValueError('Restored database content differs')
    positions=lambda s:{q['sequencename']:q['last_value'] for q in s['sequences']}
    if positions(original)!=positions(recovered):raise ValueError('Restored ID sequences differ')
    return {**receipt,'restored_database':restored,'restore_matches':True}

def node_stage(epoch,expected,state,public_genesis=None,peer=None):
    if unit_active(UNIT):raise ValueError('Stop old node before initializing reset epoch')
    current=node_inventory()
    if current['home']!=expected['home'] or current['binary']!=expected['binary'] or current['genesis_sha256']!=expected['genesis_sha256']:
        raise ValueError('Reviewed native configuration changed')
    home=HOME_BASE/('epoch-'+epoch)
    if home.exists():
        genesis=json.loads((home/'config/genesis.json').read_text())
        if genesis['chain_id']!='uain-reset-'+epoch or genesis['app_state']!=state:raise ValueError('Existing staged node differs')
    else:
        genesis=native.initialize(expected['binary'],home,'uain-reset-'+epoch,state,'tcp://127.0.0.1:'+str(RPC_PORT),
            'tcp://'+(APP_ADDRESS if public_genesis is None else DB_ADDRESS)+':'+str(P2P_PORT))
    if public_genesis is not None:
        native.set_fullnode(home,public_genesis,peer);genesis=public_genesis
    command(['chown','-R',NODE_USER+':'+NODE_USER,str(home)])
    return {'home':str(home),'genesis':genesis,'node_id':native.identity(home),
            'genesis_sha256':hashlib.sha256((home/'config/genesis.json').read_bytes()).hexdigest(),
            'peer_address':(APP_ADDRESS if public_genesis is None else DB_ADDRESS)+':'+str(P2P_PORT)}

def node_activate(epoch,staged):
    if unit_active(UNIT):raise ValueError('Old signer still active')
    home=HOME_BASE/('epoch-'+epoch)
    if staged['home']!=str(home):raise ValueError('Wrong staged home')
    genesis_bytes=(home/'config/genesis.json').read_bytes()
    if hashlib.sha256(genesis_bytes).hexdigest()!=staged['genesis_sha256'] or json.loads(genesis_bytes)!=staged['genesis']:
        raise ValueError('Staged native genesis changed')
    current=node_inventory()
    directory=Path('/etc/systemd/system')/(UNIT+'.d');directory.mkdir(exist_ok=True)
    path=directory/'reset.conf'
    pending=directory/'reset.pending'
    with pending.open('w') as output:
        output.write('[Service]\nWorkingDirectory='+str(home)+'\nExecStart=\nExecStart='+current['binary']+' start --home '+str(home)+'\nReadWritePaths=\nReadWritePaths='+str(home)+'\n')
    pending.replace(path)
    command(['systemctl','daemon-reload'])
    return {'active_home':str(home),'genesis_sha256':staged['genesis_sha256']}

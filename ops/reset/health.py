"""Read-only two-node state proofs against the reset's pinned public genesis."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time
import urllib.request
import tempfile

RPC='http://127.0.0.1:26667'
PROOF=Path('/opt/uain-reset/uain-proof')
READY='https://uain.global/api/ready'

def rpc(method,params=None):
    request=urllib.request.Request(RPC,data=json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params or {}}).encode(),headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(request,timeout=10) as response:value=json.load(response)
    if 'error' in value:raise ValueError('Native proof RPC refused')
    return value['result']

def capture(height,keys):
    if not isinstance(height,int) or not 0<=height<2**53:raise ValueError('Invalid proof height')
    if not isinstance(keys,list) or not 1<=len(keys)<=32 or any(not isinstance(key,str) or (key not in ['legacy','guardians'] and not re.fullmatch(r'member/uain[a-z0-9]{1,90}',key)) for key in keys):
        raise ValueError('Proof keys outside public federation state')
    status=rpc('status');peers=rpc('net_info')['n_peers']
    result={'status':status,'peers':peers}
    if height:
        result['header']=rpc('commit',{'height':str(height+1)})['signed_header']
        result['queries']=[rpc('abci_query',{'path':'/store/federation/key','data':key.encode().hex(),'height':str(height),'prove':True})['response'] for key in keys]
    return result

def verify(epoch_dir,genesis,remote,readiness=True,genesis_sha256=None):
    keys=['legacy','guardians',*('member/'+member['id'] for member in genesis['app_state']['members'])]
    for attempt in range(60):
        try:
            app=capture(0,keys);db=remote({'action':'proof','height':0,'keys':keys})
            height=min(int(app['status']['sync_info']['latest_block_height']),int(db['status']['sync_info']['latest_block_height']))-2
            if height>1:break
        except (OSError,ValueError,RuntimeError):pass
        time.sleep(1)
    else:raise ValueError('Fresh native nodes did not synchronize')
    captures=[capture(height,keys),remote({'action':'proof','height':height,'keys':keys})]
    directory=Path(epoch_dir)/'proofs';directory.mkdir(mode=0o700,exist_ok=True)
    raw=reviewed_genesis(genesis,genesis_sha256)
    pinned=directory/'genesis.json';pinned.write_bytes(raw)
    import base64
    for n,result in enumerate(captures):
        status=result['status']
        if status['node_info']['network']!=genesis['chain_id'] or status['sync_info']['catching_up'] or status['validator_info']['voting_power']!=('10' if n==0 else '0') or int(result['peers'])<1:
            raise ValueError('Fresh chain role or connectivity differs')
        if result['header']!=captures[0]['header']:raise ValueError('Native commits differ')
        for index,key in enumerate(keys):
            query=result['queries'][index]
            value=json.loads(base64.b64decode(query['value']))
            expected=genesis['app_state']['legacy'] if index==0 else genesis['app_state']['guardians'] if index==1 else genesis['app_state']['members'][index-2]
            if value!=expected:raise ValueError('Fresh native state differs')
            bundle=directory/(str(n)+'-'+str(index)+'.json')
            bundle.write_text(json.dumps({'signed_header':result['header'],'query':query}))
            proof=subprocess.run([str(PROOF),'--genesis',str(pinned),'--bundle',str(bundle),'--key',key],capture_output=True,timeout=15)
            if proof.returncode or b'STATE_PROOF_VERIFIED' not in proof.stdout:raise ValueError('Independent native proof verification failed')
    if not readiness:
        pin=hashlib.sha256(raw).hexdigest()
        baselines=[empty_baseline(genesis['chain_id'],pin),remote({'action':'empty-baseline','chain_id':genesis['chain_id'],'genesis_sha256':pin})]
        for n,item in enumerate(baselines):
            records=item['records']
            if item['chain_id']!=genesis['chain_id'] or item['event_count']!='0' or any(key not in records or records[key] is not None for key in ['legacy_import','legacy_adoption','guardian_epoch_current']) or records.get('legacy')!=genesis['app_state']['legacy'] or records.get('guardians')!=genesis['app_state']['guardians']:raise ValueError('Fresh reset operating baseline differs')
            (directory/('empty-baseline-'+str(n)+'.json')).write_text(json.dumps(item,sort_keys=True)+'\n')
    if readiness:
        for attempt in range(60):
            try:
                with urllib.request.urlopen(READY,timeout=15) as response:
                    if response.status==200:break
            except OSError:pass
            time.sleep(1)
        else:raise ValueError('Application readiness failed')
    return {'readiness':200 if readiness else None,'chain_id':genesis['chain_id'],'height':height,
            'genesis_sha256':hashlib.sha256(raw).hexdigest(),'independent_state_proofs':2*len(keys),
            'validator_power':10,'fullnode_power':0,'two_node_commit_agrees':True}


def empty_baseline(chain_id,genesis_sha256):
    """Fixed current-node selection; the public verifier proves absence too."""
    import stack,checkpoint
    node=stack.node_inventory()
    if not re.fullmatch('uain-reset-[0-9]{8}_[0-9]{6}',chain_id) or node['chain_id']!=chain_id or node['genesis_sha256']!=genesis_sha256:raise ValueError('Fresh reviewed reset pin required')
    with tempfile.TemporaryDirectory(prefix='uain-reset-empty-',dir='/run') as temporary:
        output=Path(temporary)/'state.json'
        result=subprocess.run([str(checkpoint.STATE),'--genesis',str(Path(node['home'])/'config/genesis.json'),'--genesis-sha256',genesis_sha256,'--rpc',RPC,'--out',str(output)],input=json.dumps({'keys':['legacy','legacy_adoption','guardian_epoch_current']}).encode(),capture_output=True,timeout=75)
        if result.returncode or not output.is_file() or output.stat().st_size>8*1024*1024:raise ValueError('Empty operating baseline proof failed')
        return json.loads(output.read_bytes())


def reviewed_genesis(genesis,pin):
    # Journal JSON sorts keys. Preserve the immutable public file's exact bytes.
    import stack
    node=stack.node_inventory();raw=(Path(node['home'])/'config/genesis.json').read_bytes()
    if not isinstance(pin,str) or not re.fullmatch('[a-f0-9]{64}',pin) or hashlib.sha256(raw).hexdigest()!=pin or node['genesis_sha256']!=pin or json.loads(raw)!=genesis:raise ValueError('Reviewed exact reset genesis bytes required')
    return raw

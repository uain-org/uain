"""Public guardian proofs, bound to the final stopped application checkpoint."""
import base64,hashlib,json,re,subprocess,uuid
from pathlib import Path
STATE=Path('/opt/uain-reset/uain-state')
OFFLINE=Path('/opt/uain-reset/uain-reset-checkpoint')

def active_identity(member,expected):
    try:public=base64.b64decode(member['public_key']+'='*((-len(member['public_key']))%4),altchars=b'-_',validate=True)
    except Exception:raise ValueError('Exact public guardian key required')
    if len(public)!=32 or member.get('id')!=expected or expected!='uain1'+hashlib.sha256(public).digest()[:20].hex() or member.get('licence')!='active':
        raise ValueError('Exact active guardian identity required')
    return member

def effective(snapshot):
    records=snapshot['records']
    if 'guardian_epoch_current' not in records:raise ValueError('Guardian pointer absence must be proved')
    pointer=records['guardian_epoch_current']
    if pointer is None:epoch='';guardians=records['guardians']
    else:
        if not isinstance(pointer,str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}',pointer):raise ValueError('Invalid current guardian epoch')
        current=records.get('guardian_epoch/'+pointer)
        if not current or current.get('id')!=pointer:raise ValueError('Current guardian epoch must be proved')
        epoch=pointer;guardians=current['guardians']
    if not isinstance(guardians,list) or not 1<=len(guardians)<=20 or len(set(guardians))!=len(guardians) or any(not isinstance(v,str) or not re.fullmatch(r'uain1[a-f0-9]{40}',v) for v in guardians):raise ValueError('Bounded exact guardian census required')
    return epoch,guardians

def proven(directory,node,rpc):
    directory=Path(directory);genesis=Path(node['home'])/'config/genesis.json'
    if hashlib.sha256(genesis.read_bytes()).hexdigest()!=node['genesis_sha256']:raise ValueError('Reviewed public genesis changed')
    proofs=[]
    def read(selection):
        output=directory/('control-proof-'+uuid.uuid4().hex+'.json')
        result=subprocess.run([str(STATE),'--genesis',str(genesis),'--genesis-sha256',node['genesis_sha256'],'--rpc',rpc,'--out',str(output)],input=json.dumps(selection).encode(),capture_output=True,timeout=75)
        if result.returncode or not output.is_file() or output.stat().st_size>8*1024*1024:raise ValueError('Independent current guardian state proof failed')
        raw=output.read_bytes();proofs.append({'file':output.name,'sha256':hashlib.sha256(raw).hexdigest()});return json.loads(raw)
    first=read({'keys':['guardian_epoch_current']});pointer=first['records']['guardian_epoch_current']
    keys=['guardian_epoch_current']+(['guardian_epoch/'+pointer] if isinstance(pointer,str) else [])
    state=read({'keys':keys}) if pointer is not None else first
    epoch,guardians=effective(state)
    if state['chain_id']!=node['chain_id'] or state['event_count']!=first['event_count']:raise ValueError('Guardian authority changed during capture')
    members=[]
    for identity in guardians:
        item=read({'member':identity,'keys':keys})
        if item['chain_id']!=state['chain_id'] or item['event_count']!=state['event_count'] or effective(item)!=(epoch,guardians):raise ValueError('Guardian state changed during identity proofs')
        members.append(active_identity(item['member'],identity))
    return {'chain_id':state['chain_id'],'genesis_sha256':node['genesis_sha256'],'height':state['height'],
            'event_count':state['event_count'],'epoch':epoch,'guardians':guardians,'members':members,'proofs':proofs}

def minted(directory,node,rpc):
    """The AI$ minted so far, from an independent proof of the public coin_supply record
    ('0' before coin activation). A reset discards every balance (plan W11, 10 November 2026)."""
    directory=Path(directory);genesis=Path(node['home'])/'config/genesis.json'
    if hashlib.sha256(genesis.read_bytes()).hexdigest()!=node['genesis_sha256']:raise ValueError('Reviewed public genesis changed')
    output=directory/('supply-proof-'+uuid.uuid4().hex+'.json')
    result=subprocess.run([str(STATE),'--genesis',str(genesis),'--genesis-sha256',node['genesis_sha256'],'--rpc',rpc,'--out',str(output)],input=json.dumps({'keys':['coin_supply']}).encode(),capture_output=True,timeout=75)
    if result.returncode or not output.is_file() or output.stat().st_size>1024*1024:raise ValueError('Independent coin supply proof failed')
    state=json.loads(output.read_bytes())
    if state.get('chain_id')!=node['chain_id'] or 'coin_supply' not in state.get('records',{}):raise ValueError('Coin supply presence must be proved')
    supply=state['records']['coin_supply']
    if supply is None:return '0'
    value=supply.get('minted') if isinstance(supply,dict) else None
    if not isinstance(value,str) or not re.fullmatch(r'0|[1-9][0-9]{0,30}',value):raise ValueError('Invalid proved coin supply')
    return value

def bind(proved,stopped):
    fields=['chain_id','genesis_sha256','event_count','epoch','guardians','members']
    if any(proved.get(key)!=stopped.get(key) for key in fields) or int(stopped['height'])<int(proved['height']):raise ValueError('Native control changed before the stopped checkpoint')
    return {**stopped,'proof_height':proved['height'],'proofs':proved['proofs']}

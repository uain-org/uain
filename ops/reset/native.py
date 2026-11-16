"""Fresh native genesis, unique chain ID and new node/signer identities."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import re
import uuid
import shutil

def fresh_state(old_genesis,legacy,checkpoint=None):
    if checkpoint is None or checkpoint.get('chain_id')!=old_genesis['chain_id']:raise ValueError('Final proved stopped guardian checkpoint required')
    from checkpoint import active_identity
    guardians=checkpoint['guardians']
    if not 1<=len(guardians)<=20 or len(set(guardians))!=len(guardians):raise ValueError('Bounded effective guardians required')
    members=[]
    for address in guardians:
        old=next(m for m in checkpoint['members'] if m['id']==address)
        active_identity(old,address)
        member={key:old[key] for key in ['id','public_key','name','operator','family']}
        member.update(licence='active',karma=0,credits='0',sequence='0',default_verifier=False,creator=False,active_projects=0)
        members.append(member)
    return {'version':1,'guardians':guardians,'members':members,'legacy':legacy}

def initialize(binary,home,chain_id,state,rpc,p2p):
    home=Path(home)
    if home.exists():raise ValueError('Refusing an existing node home')
    temporary=home.with_name(home.name+'.init-'+uuid.uuid4().hex)
    manifest=home.parent/(temporary.name+'-app-genesis.json')
    with manifest.open('x') as output:json.dump(state,output,sort_keys=True)
    result=subprocess.run([str(binary),'init','--home',str(temporary),'--chain-id',chain_id,
        '--app-genesis',str(manifest),'--rpc',rpc,'--p2p',p2p],capture_output=True)
    try:
        if result.returncode:raise RuntimeError('Fresh node initialization failed')
        genesis=json.loads((temporary/'config/genesis.json').read_text())
        (temporary/'config/genesis.json').write_text(json.dumps(genesis,indent=2)+'\n')
        temporary.rename(home)
        return genesis
    finally:
        manifest.unlink(missing_ok=True)
        if temporary.exists():shutil.rmtree(temporary)

def set_fullnode(home,genesis,peer):
    home=Path(home)
    (home/'config/genesis.json').write_text(json.dumps(genesis,indent=2)+'\n')
    path=home/'config/config.toml';text=path.read_text()
    # A non-validator keeps its own freshly generated private identity.
    # Copy only public validator/genesis data, never the app's signer key.
    if not re.fullmatch(r'[a-f0-9]{40}@[0-9.]+:[0-9]{1,5}',peer):raise ValueError('Invalid fixed peer')
    text=re.sub(r'^persistent_peers = .*$', 'persistent_peers = "'+peer+'"', text,flags=re.M)
    text=re.sub(r'^addr_book_strict = .*$', 'addr_book_strict = false', text,flags=re.M)
    path.write_text(text)

def identity(home):
    key=json.loads((Path(home)/'config/node_key.json').read_text())
    # node_key contains private data; derive its public half with the crypto
    # library on the server and return only the Comet node ID.
    import base64
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import Encoding,PublicFormat
    private=base64.b64decode(key['priv_key']['value'])[:32]
    public=Ed25519PrivateKey.from_private_bytes(private).public_key().public_bytes(Encoding.Raw,PublicFormat.Raw)
    return hashlib.sha256(public).digest()[:20].hex()

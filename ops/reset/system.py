#!/usr/bin/env python3
"""Plan, apply, or resume an operator-requested full UAIN operating-state reset."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parent))
import time
import urllib.request
import archive
import native
import runtime
import stack
import health
import uuid
import checkpoint
import pins
from datetime import datetime,timezone

SSH=['ssh','-F','/dev/null','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
     '-o','UserKnownHostsFile=/etc/uain-reset/db_known_hosts','-i','/etc/uain-reset/db_ed25519','root@10.98.0.2','uain-reset-node']
RUNNER='actions.runner.senti-org-uain-universa.uain-production.service'
# 10 November 2026 (plan W11, audit 13-C #5/#6): the reset predates BAINK and native payments.
# Every host unit that signs for, pays through or reads the native chain must already be
# stopped (generation2.py quiesce lists and stops them), and so must every runner of this
# repository whatever its registered name, before a reset prepares, applies or aborts.
NATIVE_WRITERS=['uain-native-admission.timer','uain-organization-starter.timer','uain-survey-attester.timer',
                'uain-manager-stage.timer','uain-project-agents.timer',
                'uain-native-admission.service','uain-organization-starter.service','uain-survey-attester.service',
                'uain-manager-stage.service','uain-project-agents.service',
                'baink.service','baink-public-relay.service','baink-server-holder-payer.service','baink-server-holder-recipient.service',
                'uain-central-reviewer.service','uain-central-reviewer-custody.service','uain-private-review-broker.service']
LEDGER_PIN=Path('/var/lib/uain-anchor/ledger-public.pem')
EMBEDDINGS_UNIT='uain-embeddings.service'

def remote(request,output=None,source=None):
    process=subprocess.Popen(SSH,stdin=subprocess.PIPE,stdout=output or subprocess.PIPE,stderr=subprocess.DEVNULL)
    try:
        process.stdin.write(json.dumps(request).encode()+b'\n')
        if source:
            with Path(source).open('rb') as stream:
                while data:=stream.read(1024*1024):process.stdin.write(data)
        process.stdin.close()
        result=b'' if output else process.stdout.read()
        if process.wait()!=0:raise RuntimeError('Database reset node refused or failed')
        return None if output else json.loads(result)
    except Exception:process.kill();process.wait();raise

def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def save(path,value):
    path=Path(path);temporary=path.with_suffix('.pending')
    with temporary.open('w') as out:json.dump(value,out,sort_keys=True,indent=2);out.flush();os.fsync(out.fileno())
    temporary.replace(path)
    descriptor=os.open(str(path.parent),os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(descriptor)
    finally:os.close(descriptor)

def runners_active():
    """Any active Actions runner of this repository, by pattern: a renamed or re-registered
    runner (the repository moved organisations) must not slip past a fixed unit name."""
    result=subprocess.run(['systemctl','list-units','actions.runner.*','uain-ci-worker*','--state=active,activating,reloading','--plain','--no-legend'],
                          capture_output=True,text=True)
    if result.returncode:raise ValueError('Cannot list Actions runners; refusing')
    units=[line.split()[0] for line in result.stdout.splitlines() if line.strip()]
    # The extra workers for this repository run as uain-ci-worker-N.service (ops/ci/README.md).
    return sorted(u for u in units if 'uain-universa' in u or u==RUNNER or u.startswith('uain-ci-worker'))

def require_quiet():
    busy=runners_active()
    if busy:raise ValueError('Drain and stop the UAIN Actions runners first: '+', '.join(busy))
    writers=[u for u in NATIVE_WRITERS if stack.unit_active(u)]
    if writers:raise ValueError('Stop the BAINK, payment and custody units first (generation2.py quiesce): '+', '.join(writers))

def require_discard_acknowledged(expected,minted):
    """K-18 allows resets in testing, but a reset discards every AI$ balance. Refuse unless the
    reviewed plan names exactly the AI$ supply it discards."""
    if not isinstance(minted,str) or not re.fullmatch(r'0|[1-9][0-9]{0,30}',minted):raise ValueError('Invalid proved AI$ supply')
    if minted!='0' and expected.get('discard_minted')!=minted:
        raise ValueError('AI$ balances exist (minted '+minted+'); plan again with --discard-minted '+minted+' to acknowledge they are discarded')

def plan(epoch,operator,discard_minted=None):
    if not re.fullmatch(r'operator:[\w-]{1,64}',operator):raise ValueError('Invalid reset operator')
    if discard_minted is not None and not re.fullmatch(r'0|[1-9][0-9]{0,30}',str(discard_minted)):raise ValueError('Invalid --discard-minted amount')
    app=stack.node_inventory();db=remote({'action':'inventory','epoch':epoch})
    if app['genesis_sha256']!=db['node']['genesis_sha256']:raise ValueError('Native genesis differs between nodes')
    value={'version':1,'epoch':epoch,'operator':operator,'app_node':app,'db_node':db['node'],
           'database':db['database'],'runtime':runtime.inventory(),
           'ledger_public_key':LEDGER_PIN.read_text(),
           'scope':'UAIN operating data, derived retrieval, member sessions and both native nodes; immutable published ledger retained'}
    if discard_minted is not None:value['discard_minted']=str(discard_minted)
    value['digest']=digest(value)
    return value

def check_profile():
    if os.geteuid()!=0 or socket.gethostname().split('.')[0]!='uain-app-1':raise ValueError('Run on the app host as root')

def prepare(expected,confirm):
    # A live preview can change while the operator reads it. Prepare is the
    # explicit maintenance-window action: pause writers, capture a stable final
    # plan, then await the operator's later apply command. It erases no data.
    if confirm!=expected['digest']:raise ValueError('Confirm the reviewed preview digest')
    if digest({k:v for k,v in expected.items() if k!='digest'})!=expected['digest']:raise ValueError('Preview digest is invalid')
    if stack.unit_active(RUNNER):raise ValueError('Drain and stop the Actions runner first')
    require_quiet()
    directory=stack.epoch_dir(expected['epoch'])
    require_discard_acknowledged(expected,checkpoint.minted(directory,stack.node_inventory(),health.RPC))
    intent=directory/'prepare.json'
    if intent.exists():
        if json.loads(intent.read_text())!=expected:raise ValueError('Another preparation owns this epoch')
    else:save(intent,expected)
    runtime.quiesce(expected['runtime'])
    proved=checkpoint.proven(directory,stack.node_inventory(),health.RPC)
    # 13 November 2026 (security review OP-5): measure the AI$ supply again once writers are
    # quiet, just before the nodes stop, and bind that figure into the prepared plan.
    minted=checkpoint.minted(directory,stack.node_inventory(),health.RPC)
    require_discard_acknowledged(expected,minted)
    stack.command(['systemctl','stop',stack.UNIT]);remote({'action':'stop'})
    stopped=stack.stopped_checkpoint(expected['epoch'],expected['app_node'])
    other=remote({'action':'checkpoint','epoch':expected['epoch']})
    if stopped!=other:raise ValueError('Final stopped native checkpoints differ between hosts')
    control=checkpoint.bind(proved,stopped)
    runtime.capture_history(expected['epoch'],expected['operator'],expected['runtime'],expected['ledger_public_key'])
    current=plan(expected['epoch'],expected['operator'],expected.get('discard_minted'))
    current['runtime']=expected['runtime'];current['prepared']=True
    current['guardian_checkpoint']=control;current['proved_minted']=minted
    current.pop('digest');current['digest']=digest(current)
    save(directory/'prepared-plan.json',current)
    return current

def apply(expected,confirm,recover=False):
    if confirm!=expected['digest']:raise ValueError('Confirm the exact reviewed reset plan digest')
    if stack.unit_active(RUNNER):raise ValueError('Drain and stop the UAIN Actions runner before reset; restart it after verification')
    if digest({k:v for k,v in expected.items() if k!='digest'})!=expected['digest']:raise ValueError('Reviewed plan digest is invalid')
    require_quiet()
    if not expected.get('prepared'):raise ValueError('Prepare is required to preserve publicly committed records before applying a reset')
    key=Path(os.environ['UAIN_RESET_KEY_FILE']).read_text().strip();archive.key_bytes(key)
    directory=stack.epoch_dir(expected['epoch']);path=directory/'journal.json'
    # 13 November 2026 (security review OP-5, register #97): the digest proves only that the
    # file is self-consistent. Apply runs exactly the plan prepare saved for this epoch, and
    # repeats the AI$ discard acknowledgement against the supply prepare proved (the nodes
    # are stopped now, so it cannot be read again) before the first journal step.
    saved=directory/'prepared-plan.json'
    if saved.is_symlink() or not saved.is_file() or json.loads(saved.read_text())!=expected:
        raise ValueError('Apply only the saved prepared plan of this epoch')
    require_discard_acknowledged(expected,expected.get('proved_minted'))
    if path.exists():
        if not recover:raise ValueError('Existing epoch journal: inspect and use recover')
        journal=json.loads(path.read_text())
        if journal['plan']!=expected:raise ValueError('Recovery plan differs')
        if journal['status']=='complete':return json.loads((directory/'receipt.json').read_text())
        if journal['status']!='in_progress':raise ValueError('This epoch was aborted; use a new epoch')
    else:
        if recover:raise ValueError('No epoch journal to recover')
        current=plan(expected['epoch'],expected['operator'],expected.get('discard_minted'))
        if expected.get('prepared'):
            if current['database']!=expected['database'] or current['app_node']!=expected['app_node'] or current['db_node']!=expected['db_node']:
                raise ValueError('Prepared state changed')
            if current['runtime']['native']!=expected['runtime']['native']:raise ValueError('Prepared public native runtime changed')
            final=stack.stopped_checkpoint(expected['epoch'],expected['app_node'])
            wanted={k:v for k,v in expected['guardian_checkpoint'].items() if k not in ['proof_height','proofs']}
            if final!=wanted or remote({'action':'checkpoint','epoch':expected['epoch']})!=wanted:raise ValueError('Prepared stopped native state changed')
        elif current!=expected:raise ValueError('Reset plan is stale; use prepare for a stable maintenance-window plan')
        journal={'plan':expected,'steps':{},'status':'in_progress'};save(path,journal)
    key_id=hashlib.sha256(archive.key_bytes(key)).hexdigest()
    if journal.get('archive_key_fingerprint',key_id)!=key_id:raise ValueError('Recovery archive key differs')
    journal['archive_key_fingerprint']=key_id;save(path,journal)
    steps=journal['steps'];epoch=expected['epoch']
    def step(name,action):
        if name not in steps:
            journal['in_flight']=name;save(path,journal)
            steps[name]=action();journal.pop('in_flight',None);save(path,journal)
        return steps[name]
    step('quiesce',lambda:({'quiesced':True} if expected.get('prepared') else runtime.quiesce(expected['runtime']) or {'quiesced':True}))
    step('stop-app',lambda:stack.command(['systemctl','stop',stack.UNIT]) and {} or {'stopped':True})
    step('stop-db',lambda:remote({'action':'stop'}))
    step('app-runtime-archive',lambda:runtime.archive_runtime(epoch,key,expected['runtime']))
    step('app-chain-archive',lambda:stack.chain_archive(epoch,expected['app_node'],key))
    remote_archives=step('db-archives',lambda:remote({'action':'archive','epoch':epoch,'key':key,
        'database':expected['database'],'node':expected['db_node']}))
    def copy_archive(name,expected_receipt=None):
        destination=directory/('db-'+name+'.resetbk')
        if not destination.exists():
            temporary=destination.with_name(destination.name+'.pending-'+uuid.uuid4().hex)
            try:
                with temporary.open('xb') as out:remote({'action':'fetch','epoch':epoch,'file':name},output=out);out.flush();os.fsync(out.fileno())
                archive.verify(temporary,key);os.link(temporary,destination)
            finally:temporary.unlink(missing_ok=True)
        receipt=archive.verify(destination,key)
        expected_receipt={k:v for k,v in (expected_receipt or remote_archives[name]).items() if k in receipt}
        if receipt!=expected_receipt:raise ValueError('Cross-host archive copy differs')
        return receipt
    for name in ['database','chain']:step('replicate-db-'+name,lambda name=name:copy_archive(name))
    # App archives are also copied to the DB host before either epoch activates.
    # The forced endpoint accepts only authenticated epoch archive names.
    for name in ['runtime','chain']:
        def send(name=name):
            path=directory/(name+'.resetbk');receipt=archive.verify(path,key)
            return remote({'action':'replicate','epoch':epoch,'file':'app-'+name,
                           'length':path.stat().st_size,'key':key,'sha256':receipt['ciphertext_sha256']},source=path)
        step('replicate-app-'+name,send)
    staged_db=step('stage-db',lambda:remote({'action':'stage-db','epoch':epoch,'database':expected['database']}))
    before=expected['database']['before']
    legacy={'manifest_digest':expected['digest'],'ledger_head':before['head']['hash'],
            'last_event_id':before['head']['id'],'pinned_public_key':expected['ledger_public_key']}
    state=native.fresh_state(expected['app_node']['genesis'],legacy,expected['guardian_checkpoint'])
    app_node=step('stage-app-node',lambda:stack.node_stage(epoch,expected['app_node'],state))
    peer=app_node['node_id']+'@'+app_node['peer_address']
    db_node=step('stage-db-node',lambda:remote({'action':'stage-node','epoch':epoch,'node':expected['db_node'],
        'state':state,'genesis':app_node['genesis'],'peer':peer}))
    step('new-app-identity-archive',lambda:stack.stage_archive(epoch,app_node,key))
    new_db_archive=step('new-db-identity-archive',lambda:remote({'action':'stage-archive','epoch':epoch,'staged':db_node,'key':key}))
    step('replicate-new-db-identity',lambda:copy_archive('new-chain',new_db_archive))
    def new_app_replica():
        path=directory/'new-chain.resetbk';receipt=archive.verify(path,key)
        return remote({'action':'replicate','epoch':epoch,'file':'app-new-chain','length':path.stat().st_size,
                       'key':key,'sha256':receipt['ciphertext_sha256']},source=path)
    step('replicate-new-app-identity',new_app_replica)
    step('activate-db',lambda:remote({'action':'activate-db','epoch':epoch,'database':expected['database']}))
    step('activate-app-node',lambda:stack.node_activate(epoch,app_node))
    step('activate-db-node',lambda:remote({'action':'activate-node','epoch':epoch,'staged':db_node}))
    # This digest commits to all archives and the new public genesis.
    public={'epoch':epoch,'operator':expected['operator'],'plan_digest':expected['digest'],
            'archives':{k:v for k,v in steps.items() if 'archive' in k or 'replicate' in k},
            'new_chain_id':'uain-reset-'+epoch,'new_genesis':app_node['genesis'],
            'database':steps['activate-db'],'preserved_immutable_history':True}
    step('signed-boundary',lambda:runtime.boundary(epoch,digest(public),expected['operator'],expected['runtime']))
    step('clear-member-sessions',lambda:runtime.clear_sessions(epoch))
    step('start-app',lambda:stack.command(['systemctl','start',stack.UNIT]) and {} or {'started':True})
    step('start-db',lambda:remote({'action':'start'}))
    step('verify-new-native',lambda:health.verify(directory,app_node['genesis'],remote,readiness=False,genesis_sha256=app_node['genesis_sha256']))
    step('repin-public-native-runtime',lambda:pins.repin(epoch,app_node,expected['runtime']['native']))
    step('restart-embeddings',lambda:stack.command(['systemctl','restart',EMBEDDINGS_UNIT]) and {} or {'restarted':True})
    step('resume-runtime',lambda:runtime.resume(expected['runtime']) or {'resumed':True})
    step('verify-historical-evidence',lambda:runtime.verify_history(epoch,expected['operator'],expected['runtime'],expected['ledger_public_key']))
    step('health',lambda:health.verify(directory,app_node['genesis'],remote,genesis_sha256=app_node['genesis_sha256']))
    public['boundary']=steps['signed-boundary'];public['health']=steps['health']
    public['history_audit']=steps['verify-historical-evidence']
    save(directory/'receipt.json',public);journal['status']='complete';save(path,journal)
    return public

def abort(expected,confirm):
    if confirm!=expected['digest']:raise ValueError('Confirm the prepared plan digest')
    if stack.unit_active(RUNNER) or runners_active():raise ValueError('Keep the runner stopped during recovery')
    directory=stack.epoch_dir(expected['epoch']);path=directory/'journal.json'
    if path.exists():
        journal=json.loads(path.read_text())
        if any(name.startswith('activate-') for name in journal['steps']) or journal.get('in_flight','').startswith('activate-'):
            raise ValueError('Cutover may have started: recover forward, never restart an old signer')
    original=json.loads((directory/'prepare.json').read_text())
    app=stack.node_inventory();db=remote({'action':'inventory','epoch':expected['epoch']})['node']
    for current,wanted in [(app,original['app_node']),(db,original['db_node'])]:
        if current['home']!=wanted['home'] or current['genesis_sha256']!=wanted['genesis_sha256']:
            raise ValueError('Native cutover detected; recover forward')
    stack.command(['systemctl','start',stack.UNIT]);remote({'action':'start'})
    runtime.resume(original['runtime'])
    if path.exists():journal['status']='aborted_before_cutover';save(path,journal)
    save(directory/'abort-receipt.json',{'epoch':expected['epoch'],'aborted_before_cutover':True})
    return {'epoch':expected['epoch'],'aborted_before_cutover':True,'runner_restart_required':True}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['plan','prepare','apply','recover','abort'])
    parser.add_argument('--epoch');parser.add_argument('--operator',default='operator:root')
    parser.add_argument('--plan');parser.add_argument('--confirm')
    parser.add_argument('--discard-minted',help='the exact AI$ minted so far, acknowledging the reset discards every balance (K-18)')
    args=parser.parse_args();check_profile()
    if args.action=='plan':result=plan(args.epoch or datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S'),args.operator,args.discard_minted)
    else:
        with open(args.plan) as source:expected=json.load(source)
        if args.action=='prepare':result=prepare(expected,args.confirm)
        elif args.action=='abort':result=abort(expected,args.confirm)
        else:result=apply(expected,args.confirm,args.action=='recover')
    print(json.dumps(result,sort_keys=True,indent=2))
if __name__=='__main__':
    os.umask(0o077)
    try:main()
    except Exception:
        print('Reset refused or incomplete; inspect its root-only epoch journal. Do not repeat apply or roll back a signer.',file=sys.stderr)
        sys.exit(1)

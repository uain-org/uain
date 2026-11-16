#!/usr/bin/env python3
"""Server-only isolated coordinator rehearsal with real Kubernetes/SQL/nodes.

App and DB roles use separate fixture homes/services on the app test host.
Only the inter-host transport is adapted; no production workload is touched.
"""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import uuid
import archive
import database
import health
import checkpoint
import native
import runtime
import stack
import system
import pins

root=Path(os.environ['UAIN_RESET_SYSTEM_FIXTURE_ROOT'])
fixture_dir=Path(os.environ['UAIN_RESET_BACKEND_FIXTURE_DIR'])
epoch=os.environ['UAIN_RESET_FIXTURE_EPOCH']
if os.environ.get('UAIN_RESET_TEST')!='1' or not str(root).startswith('/opt/uain-test/') or not str(fixture_dir).startswith('/opt/uain-test/'):
    raise SystemExit('Isolated server fixtures required')
fixture=json.loads((fixture_dir/'public.json').read_text());source=fixture['database']
if not source.startswith('uain_test_'):raise SystemExit('Production DB refused')
root.mkdir(mode=0o700)
namespace='uain-reset-fixture-'+epoch.replace('_','-')
unit_prefix=namespace
binary=Path(os.environ['UAIN_RESET_FIXTURE_BINARY'])
if not str(binary).startswith('/opt/uain-test/') or binary.resolve()!=binary:raise SystemExit('Isolated binary required')
home_root=Path('/var/lib/uain-reset-fixtures')/epoch
home_root.mkdir(parents=True,mode=0o755)
home_root.parent.chmod(0o755);home_root.chmod(0o755)
old=json.loads(Path(os.environ['UAIN_RESET_FIXTURE_GENESIS']).read_text())
profiles={}
units=[];containers=[];portforward=None
public_root=home_root/'runtime';public_root.mkdir(mode=0o755)
public_dir=public_root/'public';public_dir.mkdir(mode=0o755)
publications=public_root/'publications';publications.mkdir(mode=0o700);os.chown(publications,1000,1000)
operator=public_root/'operator';operator.mkdir(mode=0o700)
original_command=stack.command
original_boundary=runtime.boundary
def fixture_inventory():
    home=Path(shell(['systemctl','show',stack.UNIT,'-p','WorkingDirectory','--value']).decode().strip())
    if home.parent!=stack.HOME_BASE or home.resolve()!=home:raise ValueError('Unexpected fixture home')
    unit=shell(['systemctl','cat',stack.UNIT]).decode()
    if 'ExecStart='+str(binary)+' start --home '+str(home) not in unit:raise ValueError('Unexpected fixture binary')
    raw=(home/'config/genesis.json').read_bytes();genesis=json.loads(raw)
    return {'home':str(home),'binary':str(binary),'unit':unit,'genesis_sha256':hashlib.sha256(raw).hexdigest(),'chain_id':genesis['chain_id'],'genesis':genesis,'active':stack.unit_active(stack.UNIT)}
stack.node_inventory=fixture_inventory
remote_receipts={}

def shell(argv,input=None):return original_command(argv,input)
def install_unit(name,home=None):
    file=Path('/etc/systemd/system')/(name+'.service')
    if file.exists():raise ValueError('Fixture unit already exists')
    text='[Unit]\nDescription=Isolated UAIN reset fixture\n[Service]\n'
    if home:
        text+='User=uain-chain\nGroup=uain-chain\nWorkingDirectory='+str(home)+'\nExecStart='+str(binary)+' start --home '+str(home)+'\nReadWritePaths='+str(home)+'\nProtectSystem=strict\n'
    else:text+='ExecStart=/usr/bin/sleep infinity\n'
    text+='MemoryMax=1G\nCPUQuota=100%\nTimeoutStopSec=30\n'
    file.write_text(text);units.append(name+'.service')

@contextlib.contextmanager
def node_role(role):
    names=['HOME_BASE','ARCHIVE_BASE','UNIT','RPC_PORT','P2P_PORT','DATABASE']
    before={name:getattr(stack,name) for name in names}
    for name,value in profiles[role].items():setattr(stack,name,value)
    previous_rpc=health.RPC;health.RPC='http://127.0.0.1:'+str(stack.RPC_PORT)
    try:yield
    finally:
        for name,value in before.items():setattr(stack,name,value)
        health.RPC=previous_rpc

def remote(request,output=None,source=None):
    with node_role('db'):
        action=request['action'];ep=request.get('epoch',epoch)
        if action=='inventory':return {'node':stack.node_inventory(),'database':database.plan(globals()['source'],ep)}
        if action in ['stop','start']:
            shell(['systemctl',action,stack.UNIT]);return {action+'ped' if action=='stop' else 'started':True}
        if action=='archive':return {'database':stack.db_archive(ep,request['database'],request['key']),'chain':stack.chain_archive(ep,request['node'],request['key'])}
        if action=='empty-baseline':return health.empty_baseline(request['chain_id'],request['genesis_sha256'])
        if action=='checkpoint':return stack.stopped_checkpoint(ep,stack.node_inventory())
        if action=='stage-db':return database.stage(request['database'])
        if action=='activate-db':return database.activate(request['database'])
        if action=='stage-node':return stack.node_stage(ep,request['node'],request['state'],request['genesis'],request['peer'])
        if action=='activate-node':return stack.node_activate(ep,request['staged'])
        if action=='stage-archive':return stack.stage_archive(ep,request['staged'],request['key'])
        if action=='proof':return health.capture(request['height'],request['keys'])
        if action=='fetch':
            with (stack.epoch_dir(ep)/(request['file']+'.resetbk')).open('rb') as inp:shutil.copyfileobj(inp,output)
            return None
        if action=='replicate':
            destination=stack.epoch_dir(ep)/(request['file']+'.resetbk')
            if not destination.exists():shutil.copyfile(source,destination)
            receipt=archive.verify(destination,request['key'])
            assert receipt['ciphertext_sha256']==request['sha256']
            return {**receipt,'replicated':True}
        raise ValueError('Unknown fixture transport action')

def apply_objects(objects):
    shell(['kubectl','apply','-f','-'],json.dumps({'apiVersion':'v1','kind':'List','items':objects}).encode())

try:
    # All scopes are changed in this laboratory process only. The installed
    # production CLI exposes no environment switch for alternative workloads.
    stack.APP_ADDRESS=stack.DB_ADDRESS='127.0.0.1'
    for role,rpc_port,p2p_port in [('app',28777,28776),('db',28787,28786)]:
        home_base=home_root/role;home_base.mkdir(mode=0o755)
        profiles[role]={'HOME_BASE':home_base,'ARCHIVE_BASE':root/(role+'-archives'),
                        'UNIT':unit_prefix+'-'+role+'.service','RPC_PORT':rpc_port,'P2P_PORT':p2p_port,'DATABASE':source}
        (root/(role+'-archives')).mkdir(mode=0o700)
        home=home_base/'old'
        genesis=native.initialize(binary,home,old['chain_id'],old['app_state'],
                                  'tcp://127.0.0.1:'+str(rpc_port),'tcp://127.0.0.1:'+str(p2p_port))
        if role=='app':original_genesis=genesis;peer=native.identity(home)+'@127.0.0.1:28776'
        else:native.set_fullnode(home,original_genesis,peer)
        shell(['chown','-R','uain-chain:uain-chain',str(home)])
        install_unit(unit_prefix+'-'+role,home)
    install_unit(unit_prefix+'-embeddings')
    shell(['systemctl','daemon-reload'])
    for unit in units:shell(['systemctl','start',unit])
    for attempt in range(60):
        try:
            with node_role('app'):a=health.capture(0,['legacy'])
            with node_role('db'):b=health.capture(0,['legacy'])
            if min(int(n['status']['sync_info']['latest_block_height']) for n in [a,b])>=3:break
        except Exception:pass
        time.sleep(.5)
    else:raise AssertionError('Old fixture nodes failed')
    # Run the reviewed public installer through explicit test-only path/RPC/unit
    # adapters. The real native verifier, public pins and install journal run.
    transport=Path(os.environ['UAIN_RESET_FIXTURE_TRANSPORT']);reviewed=Path(os.environ['UAIN_RESET_FIXTURE_INSTALLER'])
    for public_source,name in [(transport,'native-rpc-transport.mjs'),(reviewed,'reviewed-runtime.py'),(Path(__file__).with_name('rehearse-public-runtime.py'),'install-native-runtime.py')]:shutil.copyfile(public_source,operator/name)
    fixture_unit=unit_prefix+'-rpc';units.append(fixture_unit+'.service')
    (operator/'fixture.json').write_text(json.dumps({'root':str(public_root),'unit':fixture_unit}))
    (operator/'fixture-host.mjs').write_text("import{startTransport}from'./native-rpc-transport.mjs';import net from'node:net';import{chmod}from'node:fs/promises';const server=await startTransport({mode:'host',socket:"+json.dumps(str(public_root/'gateway.sock'))+",upstreamPort:28777,chainId:process.env.UAIN_NATIVE_CHAIN_ID});const pg=net.createServer(c=>{const u=net.connect(55434,'127.0.0.1');c.pipe(u);u.pipe(c);c.on('error',()=>u.destroy());u.on('error',()=>c.destroy());c.on('close',()=>u.destroy());u.on('close',()=>c.destroy())});await new Promise(r=>pg.listen("+json.dumps(str(public_root/'.s.PGSQL.5432'))+",r));await chmod("+json.dumps(str(public_root/'.s.PGSQL.5432'))+",0o660);for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{server.closeAllConnections();pg.close();server.close(()=>process.exit(0))});")
    state=Path(os.environ['UAIN_RESET_FIXTURE_STATE']);state_sha=hashlib.sha256(state.read_bytes()).hexdigest();state_dir=public_dir/'state'/state_sha;state_dir.mkdir(parents=True,mode=0o755);shutil.copyfile(state,state_dir/'uain-state');(state_dir/'uain-state').chmod(0o555)
    initial_genesis=public_root/'original-genesis.json';initial_genesis.write_text(json.dumps(original_genesis,indent=2)+'\n');initial_genesis.chmod(0o600)
    approval={'schema':'uain-native-runtime-install-v1','state_binary':str(state_dir/'uain-state'),'state_sha256':state_sha,'genesis':str(initial_genesis),'genesis_sha256':hashlib.sha256(initial_genesis.read_bytes()).hexdigest(),'chain_id':original_genesis['chain_id'],'transport_sha256':hashlib.sha256(transport.read_bytes()).hexdigest(),'source_revision':'a'*40,'expires_at':int(time.time())+1800}
    approval_path=public_root/'initial-approval.json';approval_path.write_text(json.dumps(approval));approval_path.chmod(0o600)
    installer=operator/'install-native-runtime.py';first=json.loads(shell(['/usr/bin/python3','-I',str(installer),str(approval_path)]))
    pins.HELPER=installer;pins.INSTALLED=public_root/'config/installed.json';pins.PUBLIC=public_dir
    shell(['kubectl','create','namespace',namespace])
    runtime.NAMESPACE=namespace
    shell(['kubectl','-n',namespace,'create','secret','generic','uain-ledger',
           '--from-file=ledger.key='+str(fixture_dir/'ledger.key'),'--from-file=log.salt='+str(fixture_dir/'log.salt')])
    for name in ['uain-env','uain-retrieval']:
        shell(['kubectl','-n',namespace,'create','secret','generic',name,'--from-literal=FIXTURE=true'])
    data={**first['configmap']['data'],'UAIN_AUTHORITY':'native'}
    apply_objects([{'apiVersion':'v1','kind':'ConfigMap','metadata':{'name':'uain-native-config','namespace':namespace},'data':data}])
    pg_host=os.environ['UAIN_RESET_FIXTURE_PG_HOST']
    if not pg_host.startswith('172.17.'):raise ValueError('Explicit isolated Docker PostgreSQL bridge required')
    native_mounts=[{'name':'public','mountPath':'/opt/uain-native/public','readOnly':True},{'name':'publications','mountPath':'/var/lib/uain-native/publications'},{'name':'rpc','mountPath':'/run/uain-native-rpc','readOnly':True}]
    native_volumes=[{'name':'public','hostPath':{'path':str(public_dir),'type':'Directory'}},{'name':'publications','hostPath':{'path':str(publications),'type':'Directory'}},{'name':'rpc','hostPath':{'path':str(public_root),'type':'Directory'}}]
    native_env=[{'name':'DATABASE_URL','value':'postgres://postgres:uain-vector-test-only@localhost:5432/'+source+'?host=/run/uain-native-rpc'},{'name':'UAIN_PG_POOL','value':'2'},{'name':'UAIN_WRITER_POOL','value':'2'}]
    fixture_image=os.environ['UAIN_RESET_FIXTURE_IMAGE']
    projection={'apiVersion':'batch/v1','kind':'CronJob','metadata':{'name':'native-projection','namespace':namespace},'spec':{'schedule':'* * * * *','concurrencyPolicy':'Forbid','jobTemplate':{'spec':{'backoffLimit':0,'activeDeadlineSeconds':240,'template':{'spec':{'restartPolicy':'Never','securityContext':{'runAsNonRoot':True,'runAsUser':1000,'runAsGroup':1000,'fsGroup':1000},'containers':[{'name':'projection','image':fixture_image,'imagePullPolicy':'Never','command':['node','ops/native-rpc-transport.mjs','projection'],'env':native_env,'envFrom':[{'configMapRef':{'name':'uain-native-config'}}],'volumeMounts':native_mounts,'resources':{'limits':{'cpu':'1','memory':'512Mi'}}}],'volumes':native_volumes}}}}}}
    apply_objects([projection]);runtime.kube('create','job','--from=cronjob/native-projection','initial-native-projection');runtime.kube('wait','--for=condition=complete','job/initial-native-projection','--timeout=180s')
    deployments=[]
    for name in ['pilot','web','waitlist']:
        container={'name':name,'image':'busybox:1.36','command':['sleep','3600'],'resources':{'limits':{'cpu':'1','memory':'256Mi'}}}
        pod={'containers':[container]}
        if name=='pilot':
            container.update(image=fixture_image,imagePullPolicy='Never',command=['node','dist/src/api/server.js'],
               env=[*native_env,{'name':'PORT','value':'18787'},{'name':'UAIN_METRICS_PORT','value':'18788'},{'name':'UAIN_PUBLIC_ORIGIN','value':'http://127.0.0.1:18797'}],envFrom=[{'configMapRef':{'name':'uain-native-config'}}],
               ports=[{'containerPort':18787}],
               volumeMounts=[{'name':'ledger','mountPath':'/var/lib/uain-pilot','readOnly':True},*native_mounts],
               readinessProbe={'httpGet':{'path':'/api/ready','port':18787},'periodSeconds':2})
            pod.update(securityContext={'runAsNonRoot':True,'runAsUser':1000,'runAsGroup':1000,'fsGroup':1000},
                       volumes=[{'name':'ledger','secret':{'secretName':'uain-ledger','defaultMode':288}},*native_volumes])
            pod['containers'].append({'name':'rpc-bridge','image':fixture_image,'imagePullPolicy':'Never','command':['node','ops/native-rpc-transport.mjs','bridge'],'envFrom':[{'configMapRef':{'name':'uain-native-config'}}],'volumeMounts':[native_mounts[-1]],'resources':{'limits':{'cpu':'0.25','memory':'128Mi'}}})
        deployments.append({'apiVersion':'apps/v1','kind':'Deployment','metadata':{'name':name,'namespace':namespace},
                            'spec':{'replicas':1,'selector':{'matchLabels':{'app':name}},'template':{'metadata':{'labels':{'app':name}},'spec':pod}}})
    cron={'apiVersion':'batch/v1','kind':'CronJob','metadata':{'name':'research-index','namespace':namespace},
          'spec':{'schedule':'0 0 1 1 *','jobTemplate':{'spec':{'template':{'spec':{'restartPolicy':'Never','containers':[{'name':'fixture','image':'busybox:1.36','command':['true']}]}}}}}}
    apply_objects([*deployments,cron])
    for name in ['pilot','web','waitlist']:runtime.kube('rollout','status','deployment/'+name,'--timeout=120s')
    portforward=subprocess.Popen(['kubectl','-n',namespace,'port-forward','deployment/pilot','18797:18787'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    time.sleep(1)
    for suffix in ['reviewer','exporter']:
        name=unit_prefix+'-'+suffix;containers.append(name)
        shell(['docker','run','-d','--name',name,'--memory','32m','--cpus','.1','busybox:1.36','sleep','3600'])
    runtime.CONTAINERS=containers
    member=root/'member';member.mkdir(mode=0o700)
    (member/'key.json').write_text('{"fictional":"never a production key"}')
    (member/'worker.json').write_text('{"token":"fixture-session","participant":{"id":"fixture"},"budget_usd":7,"base":"http://fixture"}')
    (member/'state.json').write_text('{"doing":"fixture"}')
    runtime.state_roots=lambda:[member]
    system.RUNNER=unit_prefix+'-absent-runner.service'
    system.EMBEDDINGS_UNIT=unit_prefix+'-embeddings.service'
    system.LEDGER_PIN=root/'ledger-public.pem';system.LEDGER_PIN.write_text(fixture['key']['pem'])
    system.remote=remote
    health.READY='http://127.0.0.1:18797/api/ready'
    health.PROOF=Path(os.environ['UAIN_RESET_FIXTURE_PROOF'])
    checkpoint.STATE=Path(os.environ['UAIN_RESET_FIXTURE_STATE'])
    checkpoint.OFFLINE=Path(os.environ['UAIN_RESET_FIXTURE_CHECKPOINT'])
    def fixture_boundary(epoch,digest,operator,saved,*args):
        saved=json.loads(json.dumps(saved));pod=next(o for o in saved['objects'] if o['kind']=='Deployment' and o['metadata']['name']=='pilot')['spec']['template']['spec'];pod['hostNetwork']=True
        for entry in pod['containers'][0]['env']:
            if entry['name']=='DATABASE_URL':entry['value']='postgres://postgres:uain-vector-test-only@127.0.0.1:55434/'+source
        return original_boundary(epoch,digest,operator,saved,*args)
    runtime.boundary=fixture_boundary
    original_resume=runtime.resume
    def resume(saved):
        global portforward
        original_resume(saved)
        if portforward:portforward.terminate();portforward.wait()
        portforward=subprocess.Popen(['kubectl','-n',namespace,'port-forward','deployment/pilot','18797:18787'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        time.sleep(1)
    runtime.resume=resume
    key=root/'fixture-archive-key';key.write_text('ef'*32);key.chmod(0o600)
    os.environ['UAIN_RESET_KEY_FILE']=str(key)
    with node_role('app'):
        preview=system.plan(epoch,'operator:fixture')
        expected=system.prepare(preview,preview['digest'])
        assert expected['prepared'] and not stack.unit_active(stack.UNIT)
        def interrupt(*args):
            name='reset-boundary-'+epoch.replace('_','-')
            failed={'apiVersion':'batch/v1','kind':'Job','metadata':{'name':name,'namespace':namespace},
                    'spec':{'backoffLimit':0,'template':{'spec':{'restartPolicy':'Never','containers':[{'name':'fixture-failure','image':'busybox:1.36','command':['false']}]}}}}
            apply_objects([failed]);runtime.kube('wait','--for=condition=failed','job/'+name,'--timeout=60s')
            raise RuntimeError('Intentional failed boundary job after epoch activation')
        runtime.boundary=interrupt
        try:system.apply(expected,expected['digest'])
        except RuntimeError:pass
        else:raise AssertionError('Intentional interruption was ignored')
        directory=stack.epoch_dir(epoch)
        journal=json.loads((directory/'journal.json').read_text())
        assert journal['in_flight']=='signed-boundary'
        assert 'activate-db-node' in journal['steps']
        runtime.boundary=fixture_boundary
        receipt=system.apply(expected,expected['digest'],recover=True)
        assert system.apply(expected,expected['digest'],recover=True)==receipt
        assert receipt['health']['independent_state_proofs']==2*(2+len(receipt['new_genesis']['app_state']['members']))
        events=json.loads(database.sql(source,'SELECT json_agg(row_to_json(e) ORDER BY id) FROM events e;'))
        assert events[:-1]==fixture['events'] and events[-1]['kind']=='system_reset'
        assert database.snapshot(source)['roots']==preview['database']['before']['roots']
        assert receipt['boundary'] and 'verify-historical-evidence' in json.loads((directory/'journal.json').read_text())['steps']
        assert database.sql(source,'SELECT count(*) FROM reset_public_records')!='0'
        assert json.loads((member/'worker.json').read_text())['budget_usd']==7
        assert 'token' not in json.loads((member/'worker.json').read_text())
        assert (member/'key.json').read_text()=='{"fictional":"never a production key"}'
        config=json.loads(runtime.kube('get','configmap','uain-native-config','-o','json'))['data']
        assert config['UAIN_AUTHORITY']=='native' and config['UAIN_NATIVE_CHAIN_ID']=='uain-reset-'+epoch and config['UAIN_NATIVE_GENESIS_SHA256']==receipt['health']['genesis_sha256']
        assert all((publications/name).exists() for name in os.listdir(publications))
        resumed=json.loads(runtime.kube('get','cronjob','research-index','-o','json'))
        assert not resumed['spec'].get('suspend',False)
        result={'coordinator_rehearsal':True,'real_postgres':True,'real_kubernetes':True,
                'real_native_nodes':2,'native_authority_resumed':True,'public_runtime_repinned':True,'new_native_projection_ready':True,'interrupted_after_cutover_then_recovered':True,
                'original_events_and_roots_unchanged':True,'member_keys_and_budget_retained':True,
                'sessions_cleared':True,'historical_public_evidence_independently_audited_after_reset':True,
                'failed_boundary_job_recovered':True,'research_scheduler_resumed':True,
                'health':receipt['health'],'production_reset':False,
                'transport':'fixture app/db roles on one host; production SSH not exercised'}
        (root/'receipt.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
finally:
    runtime.boundary=original_boundary
    if portforward:portforward.terminate();portforward.wait()
    for unit in units:subprocess.run(['systemctl','stop',unit],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    for unit in units:
        path=Path('/etc/systemd/system')/unit;path.unlink(missing_ok=True)
        dropin=path.with_name(path.name+'.d')
        if dropin.exists():shutil.rmtree(dropin)
    subprocess.run(['systemctl','daemon-reload'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    for name in containers:subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    subprocess.run(['kubectl','delete','namespace',namespace,'--wait=false'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

"""Only UAIN workloads and known reviewer state; no changes to other tenants."""
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import shutil
import uuid
import archive
from stack import command,epoch_dir,pipeline_archive

DEPLOYMENTS=['pilot','web','waitlist']
CONTAINERS=['uain-review-codex-agent-1','uain-monitoring-postgres-exporter-1']
CRONJOBS={'research-index','native-projection'}
NAMESPACE='uain'

def state_roots():
    roots=[Path('/home/uain/.uain-review-default'),Path('/opt/uain-runner/security')]
    roots.append(Path(json.loads(command(['docker','volume','inspect','uain-review-codex_member']))[0]['Mountpoint']))
    for root in roots:
        if root.resolve()!=root:raise ValueError('Member state directory is redirected')
    return roots

def state_files(root):
    if not root.exists():return
    for source in root.rglob('*'):
        if source.name not in ['key.json','worker.json','state.json']:continue
        if source.resolve()!=source or not source.is_file() or source.stat().st_size>1024*1024:
            raise ValueError('Member identity/state is not a bounded regular file')
        yield source

def kube(*args,input=None):return command(['kubectl','-n',NAMESPACE,*args],input)
def inventory():
    objects=json.loads(kube('get','deployment,hpa,cronjob','-o','json'))['items']
    deployments={o['metadata']['name']:o for o in objects if o['kind']=='Deployment'}
    if set(deployments)!=set(DEPLOYMENTS):raise ValueError('Review newly added UAIN deployments before reset')
    cronjobs=[o for o in objects if o['kind']=='CronJob']
    names={o['metadata']['name'] for o in cronjobs}
    if 'research-index' not in names or not names.issubset(CRONJOBS):raise ValueError('Review newly added UAIN scheduled jobs')
    native=__import__('pins').capture()
    if native['data']['UAIN_AUTHORITY']=='native' and deployments['pilot']['spec']['replicas']>0 and not any(o['metadata']['name']=='native-projection' and not o['spec'].get('suspend',False) for o in cronjobs):raise ValueError('Active native authority requires its projection scheduler')
    active={name:command(['docker','inspect','--format','{{.State.Running}}',name]).decode().strip()=='true' for name in CONTAINERS}
    states=sum(1 for root in state_roots() for _ in state_files(root))
    return {'objects':objects,'containers':active,'member_state_files':states,'replicas':{k:v['spec']['replicas'] for k,v in deployments.items()},
            'pilot_image':deployments['pilot']['spec']['template']['spec']['containers'][0]['image'],'native':native}

def clean_object(obj):
    return {k:v for k,v in obj.items() if k in ['apiVersion','kind','spec']}|{'metadata':{'name':obj['metadata']['name'],'namespace':NAMESPACE}}

def quiesce(saved):
    for obj in saved['objects']:
        if obj['kind']=='HorizontalPodAutoscaler':kube('delete','hpa',obj['metadata']['name'],'--ignore-not-found=true')
        if obj['kind']=='CronJob':kube('patch','cronjob',obj['metadata']['name'],'--type=merge','-p','{"spec":{"suspend":true}}')
    jobs=json.loads(kube('get','jobs','-o','json'))['items']
    for job in jobs:
        if any(o.get('kind')=='CronJob' and o.get('name') in CRONJOBS for o in job['metadata'].get('ownerReferences',[])):
            kube('delete','job',job['metadata']['name'],'--wait=true')
    for name in DEPLOYMENTS:kube('scale','deployment/'+name,'--replicas=0')
    import time
    for attempt in range(60):
        pods=json.loads(kube('get','pods','-l','app in (pilot,web,waitlist)','-o','json'))['items']
        if not pods:break
        time.sleep(2)
    else:raise ValueError('UAIN writers did not stop')
    for name,on in saved['containers'].items():
        if on:command(['docker','stop','--time','30',name])

def archive_runtime(epoch,key,saved):
    directory=epoch_dir(epoch)
    with tempfile.TemporaryDirectory(prefix='uain-reset-runtime-',dir='/dev/shm') as temporary:
        stage=Path(temporary);(stage/'runtime.json').write_text(json.dumps(saved))
        for secret in ['uain-env','uain-ledger','uain-retrieval']:
            (stage/(secret+'.json')).write_bytes(kube('get','secret',secret,'-o','json'))
        paths=state_roots()
        # A tar envelope stores only specified UAIN runtime paths and secrets.
        for i,path in enumerate(paths):
            if path.exists():
                # Copy only identity/state JSON, never provider-auth caches or other projects.
                target=stage/('member-state-'+str(i));target.mkdir(mode=0o700)
                for source in state_files(path):
                    relative=source.relative_to(path);destination=target/relative
                    destination.parent.mkdir(parents=True,exist_ok=True);destination.write_bytes(source.read_bytes())
        receipt=pipeline_archive(['tar','-czf','-','-C',str(stage),'.'],directory/'runtime.resetbk',key)
    check=directory/('runtime-restore-check-'+uuid.uuid4().hex)
    archive.unpack(directory/'runtime.resetbk',key,check)
    shutil.rmtree(check)
    return receipt

def clear_sessions(epoch):
    paths=state_roots()
    count=0
    for root in paths:
        if not root.exists():continue
        list(state_files(root)) # validate the whole scoped tree before writes
        # Recover older interrupted rename-style runs as well as the current
        # atomic replacement: spending/runtime configuration must not be lost.
        for backup in root.rglob('worker.json.epoch-'+epoch):
            if backup.resolve()!=backup or not backup.is_file():raise ValueError('Invalid member reset backup')
            path=backup.with_name('worker.json')
            if not path.exists():
                value=json.loads(backup.read_text());stat=backup.stat()
                value.pop('token',None);value.pop('participant',None);value.update(off=True,reset_epoch=epoch)
                write_session(path,value,stat);count+=1
        for path in list(state_files(root)):
            if path.name not in ['state.json','worker.json']:continue
            if path.name=='state.json':
                backup=path.with_name(path.name+'.epoch-'+epoch)
                if backup.exists():raise ValueError('Session state changed after reset')
                path.rename(backup);count+=1;continue
            value=json.loads(path.read_text())
            if value.get('reset_epoch')==epoch:continue
            # Keep runtime choice, endpoint and spending limits. Paused clients
            # need to enrol again because their old participant no longer exists.
            stat=path.stat();backup=path.with_name(path.name+'.epoch-'+epoch)
            if backup.exists():
                if path.read_bytes()!=backup.read_bytes():raise ValueError('Member configuration changed during reset')
            else:os.link(path,backup)
            value.pop('token',None);value.pop('participant',None)
            value.update(off=True,reset_epoch=epoch)
            write_session(path,value,stat);count+=1
    return {'cleared_session_files':count,'member_keys_retained':True,'member_clients_paused_for_reenrolment':True}

def write_session(path,value,stat):
    temporary=path.with_name(path.name+'.reset-pending-'+uuid.uuid4().hex)
    try:
        with temporary.open('x') as out:json.dump(value,out);out.flush();os.fsync(out.fileno())
        os.chmod(temporary,stat.st_mode&0o777);os.chown(temporary,stat.st_uid,stat.st_gid)
        temporary.replace(path)
    finally:temporary.unlink(missing_ok=True)

def resume(saved):
    for name,replicas in saved['replicas'].items():kube('scale','deployment/'+name,'--replicas='+str(replicas))
    # Native readiness depends on the new epoch's derived projection. Resume
    # its scheduler before waiting for pilot readiness, never behind rollout.
    for obj in saved['objects']:
        if obj['kind'] in ['HorizontalPodAutoscaler','CronJob']:
            kube('apply','-f','-',input=json.dumps(clean_object(obj)).encode())
            if obj['kind']=='CronJob':
                suspend=bool(obj['spec'].get('suspend',False))
                kube('patch','cronjob',obj['metadata']['name'],'--type=merge','-p',json.dumps({'spec':{'suspend':suspend}}))
    for name in DEPLOYMENTS:kube('rollout','status','deployment/'+name,'--timeout=300s')
    for name,on in saved['containers'].items():
        if on:command(['docker','start',name])

def boundary(epoch,digest,operator,saved,action='record-system-reset',pin=None):
    prefix={'capture-system-reset-records':'reset-capture-','verify-system-history':'reset-audit-','record-system-reset':'reset-boundary-'}
    if action not in prefix:raise ValueError('Invalid reset job')
    name=prefix[action]+epoch.replace('_','-')
    pod=next(obj for obj in saved['objects'] if obj['kind']=='Deployment' and obj['metadata']['name']=='pilot')['spec']['template']['spec']
    pilot=pod['containers'][0]
    override=['ACTION','RESET_EPOCH','RESET_RECEIPT_DIGEST','OPERATOR_ID','LEDGER_PUBLIC_KEY_PEM','UAIN_RATE_REQUESTS_PER_MIN','UAIN_AUTHORITY','UAIN_NATIVE_PROJECTION']
    env=[value for value in pilot.get('env',[]) if value['name'] not in override]
    extra=[] if pin is None else [{'name':'LEDGER_PUBLIC_KEY_PEM','value':pin},{'name':'UAIN_RATE_REQUESTS_PER_MIN','value':'100000'}]
    spec={'apiVersion':'batch/v1','kind':'Job','metadata':{'name':name,'namespace':NAMESPACE},'spec':{'backoffLimit':0,'activeDeadlineSeconds':600,'template':{'spec':{'restartPolicy':'Never',
        'securityContext':{'runAsNonRoot':True,'runAsUser':1000,'runAsGroup':1000,'fsGroup':1000},
        'containers':[{'name':'boundary','image':saved['pilot_image'],
        'command':['node','dist/src/application/maintenance.js'],
        'envFrom':pilot.get('envFrom',[]),
        'env':[*env,*extra,{'name':'UAIN_AUTHORITY','value':'pilot'},{'name':'UAIN_NATIVE_PROJECTION','value':'0'},{'name':'ACTION','value':action},{'name':'RESET_EPOCH','value':epoch},
               {'name':'RESET_RECEIPT_DIGEST','value':digest},{'name':'OPERATOR_ID','value':operator}],
        'resources':{'limits':{'cpu':'1','memory':'512Mi'}},
        'volumeMounts':[{'name':'ledger','mountPath':'/var/lib/uain-pilot','readOnly':True}]}],
        'volumes':[volume for volume in pod['volumes'] if volume['name']=='ledger'],
        **({'hostNetwork':True,'dnsPolicy':'ClusterFirstWithHostNet'} if pod.get('hostNetwork') else {})}}}}
    existing=kube('get','job',name,'--ignore-not-found=true','-o','json').strip()
    if existing:
        previous=json.loads(existing)
        if any(condition.get('type')=='Failed' and condition.get('status')=='True' for condition in previous.get('status',{}).get('conditions',[])):
            kube('delete','job',name,'--wait=true')
    kube('apply','-f','-',input=json.dumps(spec).encode());kube('wait','--for=condition=complete','job/'+name,'--timeout=600s')
    return {'job':name,'receipt_digest':digest,
            'independent_public_evidence_audit':action in ['capture-system-reset-records','verify-system-history']}

def capture_history(epoch,operator,saved,pin):
    return boundary(epoch,'0'*64,operator,saved,'capture-system-reset-records',pin)

def verify_history(epoch,operator,saved,pin):
    return boundary(epoch,'0'*64,operator,saved,'verify-system-history',pin)

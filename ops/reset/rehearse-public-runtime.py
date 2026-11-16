#!/usr/bin/python3 -I
"""Isolated coordinator fixture adapter; never installed as an operator helper.

Runs the exact reviewed installer with fixture filesystem/unit names and a
fixture loopback upstream. Its public verifier, byte checks, journal and public
file installation execute unchanged. No production runtime path is writable.
"""
import importlib.util,json,os,subprocess,sys,tempfile
from pathlib import Path
HERE=Path(__file__).resolve().parent
fixture=json.loads((HERE/'fixture.json').read_text())
root=Path(fixture['root'])
if os.geteuid()!=0 or not str(root).startswith('/var/lib/uain-reset-fixtures/') or root.resolve()!=root or not fixture['unit'].startswith('uain-reset-fixture-'):raise SystemExit('Isolated fixture required')
spec=importlib.util.spec_from_file_location('reviewed_runtime',HERE/'reviewed-runtime.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.PUBLIC=root/'public';m.CONFIG=root/'config';m.CODE=root/'code';m.UNIT=Path('/etc/systemd/system')/(fixture['unit']+'.service');m.PUBLICATIONS=root/'publications'
def prove(a,genesis):
 with tempfile.TemporaryDirectory(dir='/run',prefix='uain-reset-fixture-proof-') as temporary:
  output=Path(temporary)/'state.json'
  result=subprocess.run([a['state_binary'],'--genesis',a['genesis'],'--genesis-sha256',a['genesis_sha256'],'--rpc','http://127.0.0.1:28777','--out',str(output)],input=m.encoded({'keys':['guardians','legacy','guardian_epoch_current']}),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=70)
  m.require(result.returncode==0);state=json.loads(output.read_bytes());m.require(state['chain_id']==a['chain_id'])
  return {'height':state['height'],'app_hash':state['app_hash'],'chain_id':state['chain_id']}
m.prove=prove
def service(sha):
 return ('[Unit]\nDescription=Isolated reset keyless RPC fixture\n[Service]\nGroup=1000\nEnvironmentFile='+str(m.CONFIG/'runtime.conf')+'\nExecStartPre=/usr/bin/rm -f '+str(root/'gateway.sock')+' '+str(root/'.s.PGSQL.5432')+'\nExecStart='+m.NODE+' '+str(HERE/'fixture-host.mjs')+'\nMemoryMax=256M\nCPUQuota=50%\nTasksMax=64\n').encode()
m.service=service
original_run=m.run
def run(argv):
 if argv==['systemctl','enable','uain-native-rpc.service']:return b''
 if argv[0]=='systemctl':argv=[fixture['unit']+'.service' if v=='uain-native-rpc.service' else v for v in argv]
 if argv[0]=='useradd':raise ValueError('Fixture never provisions production users')
 return original_run(argv)
m.run=run
if __name__=='__main__':
 try:
  os.umask(0o077);m.require(len(sys.argv)==2)
  receipt=m.install(sys.argv[1]);receipt['configmap']['data']['UAIN_NATIVE_PUBLICATION_DIR']='/var/lib/uain-native/publications';print(json.dumps(receipt))
 except Exception:
  print('Isolated runtime fixture refused',file=sys.stderr);sys.exit(1)

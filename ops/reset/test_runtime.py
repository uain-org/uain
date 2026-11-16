"""Session reset/recovery retains identity, runtime choice and spending limits."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import runtime

class RuntimeTest(unittest.TestCase):
    def test_interrupted_session_recovery_preserves_configuration_and_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);epoch='20261008_000001'
            key=root/'key.json';key.write_text('fictional identity')
            original={'token':'old-fixture-token','participant':{'id':'old'},'budget_usd':9,'runtime':'codex','base':'http://fixture'}
            worker=root/'worker.json';worker.write_text(json.dumps(original))
            worker.rename(root/('worker.json.epoch-'+epoch)) # interrupted old-style replacement
            (root/'state.json').write_text('{}')
            with patch.object(runtime,'state_roots',return_value=[root]):
                receipt=runtime.clear_sessions(epoch)
                self.assertTrue(receipt['member_keys_retained'])
                value=json.loads(worker.read_text())
                self.assertEqual(value['budget_usd'],9);self.assertEqual(value['runtime'],'codex')
                self.assertTrue(value['off']);self.assertNotIn('token',value);self.assertNotIn('participant',value)
                self.assertEqual(key.read_text(),'fictional identity')
                self.assertEqual(runtime.clear_sessions(epoch)['cleared_session_files'],0)

    def test_native_projection_scheduler_resumes_before_pilot_readiness(self):
        saved={'replicas':{'pilot':1,'web':1,'waitlist':1},'objects':[{'apiVersion':'batch/v1','kind':'CronJob','metadata':{'name':'native-projection'},'spec':{'suspend':False}}],'containers':{}}
        calls=[]
        with patch.object(runtime,'kube',side_effect=lambda *args,**kwargs:calls.append(args)):
            runtime.resume(saved)
        resume=next(i for i,args in enumerate(calls) if args[:2]==('patch','cronjob'))
        ready=next(i for i,args in enumerate(calls) if args[:2]==('rollout','status'))
        self.assertLess(resume,ready)

    def test_private_history_jobs_explicitly_read_sql_without_native_sidecars(self):
        saved={'pilot_image':'reviewed-fixture','objects':[{'kind':'Deployment','metadata':{'name':'pilot'},'spec':{'template':{'spec':{'containers':[{'env':[{'name':'UAIN_AUTHORITY','value':'native'},{'name':'UAIN_NATIVE_PROJECTION','value':'1'}],'envFrom':[{'configMapRef':{'name':'uain-native-config'}}]}],'volumes':[{'name':'ledger','secret':{'secretName':'uain-ledger'}}]}}}}]}
        objects=[]
        def kube(*args,**kw):
            if args[:2]==('apply','-f'):objects.append(json.loads(kw['input']))
            return b''
        with patch.object(runtime,'kube',side_effect=kube):runtime.boundary('20261012_010203','a'*64,'operator:fixture',saved,'capture-system-reset-records','public-pin')
        pod=objects[0]['spec']['template']['spec'];self.assertEqual(len(pod['containers']),1)
        env={v['name']:v['value'] for v in pod['containers'][0]['env']}
        self.assertEqual(env['UAIN_AUTHORITY'],'pilot');self.assertEqual(env['UAIN_NATIVE_PROJECTION'],'0')
        self.assertEqual([v['name'] for v in pod['volumes']],['ledger'])

if __name__=='__main__':unittest.main()

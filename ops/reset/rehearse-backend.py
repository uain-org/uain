#!/usr/bin/env python3
"""Reset the complete disposable pilot schema; production names are refused."""
import json
import os
from pathlib import Path
import subprocess
import archive
import database

root=Path(os.environ['UAIN_RESET_BACKEND_FIXTURE_DIR'])
if os.environ.get('UAIN_RESET_TEST')!='1' or not str(root).startswith('/opt/uain-test/'):
    raise SystemExit('Only an isolated server fixture is allowed')
fixture=json.loads((root/'public.json').read_text())
source=fixture['database']
if not source.startswith('uain_test_'):raise SystemExit('Production database refused')
epoch=os.environ['UAIN_RESET_FIXTURE_EPOCH']
expected=database.plan(source,epoch)
before=expected['before']
assert before['tables']['research_chunks']>0 and before['tables']['members']>0
key='cd'*32 # public fixture key, never production
dump=subprocess.Popen(['pg_dump','-Fc',source],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
receipt=archive.seal(dump.stdout,root/'database.resetbk',key);assert dump.wait()==0
restored='uain_recovered_'+epoch
database.sql('postgres','CREATE DATABASE '+database.identifier(restored)+' TEMPLATE template0;')
restore=subprocess.Popen(['pg_restore','--exit-on-error','--no-owner','-d',restored],stdin=subprocess.PIPE,stderr=subprocess.DEVNULL)
archive.open_verified(root/'database.resetbk',key,restore.stdin);restore.stdin.close();assert restore.wait()==0
assert database.snapshot(restored)==before
assert database.stage(expected)['source_unchanged']
assert database.stage(expected)['active_rows']==0 # replay before activation
activated=database.activate(expected)
assert database.activate(expected)['already_activated'] # replay after activation
assert database.snapshot(activated['archived_database'])==before
after=database.snapshot(source)
assert all(after['tables'][name]==0 for name in expected['clear'])
(root/'database-receipt.json').write_text(json.dumps({
    'complete_pilot_schema':True,'cleared_tables':expected['clear'],
    'preserved_tables':expected['preserve'],'archive_restore_matches':True,
    'activation_recovery_matches':True,'database':activated,'archive':receipt,
    'production_reset':False},indent=2)+'\n')
print(json.dumps({'database':source,'complete_schema_reset':True,'cleared_table_count':len(expected['clear'])}))

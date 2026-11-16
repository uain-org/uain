#!/usr/bin/env python3
"""Stage a fresh UAIN operating database without dropping the original.

The whole-system orchestrator must quiesce all UAIN writers and verify its
archives before staging. This primitive never renames or replaces production.
Immutable signed history and ID high-water marks are retained for continuity.
"""
import argparse
import hashlib
import json
import re
import subprocess
import os
from datetime import datetime,timezone

KEEP = {'events','ledger_roots','schema_applied','reset_public_records','reset_reserved_ids'}
NATIVE_HISTORY = {'native_epochs','native_proof_batches','native_events',
    'native_journal_cursors','native_journal_entries','native_publications',
    'native_research_documents','native_research_chunks'}
NAME = re.compile(r'^[a-z][a-z0-9_]{0,62}$')

def identifier(name):
    if not NAME.fullmatch(name):
        raise ValueError('Unexpected database/table identifier')
    return '"'+name+'"'

def sql(database,statement):
    result = subprocess.run(( ['runuser','-u','postgres','--'] if os.geteuid()==0 and os.environ.get('UAIN_RESET_TEST')!='1' else [] )+['psql','-X','-v','ON_ERROR_STOP=1','-At','-d',database],
                            input=statement,text=True,capture_output=True)
    if result.returncode:
        # No raw stderr: database errors may include submitted source content.
        raise RuntimeError('Database operation failed; target remains staged, inspect locally')
    return result.stdout.strip()

def tables(database):
    return json.loads(sql(database,"SELECT coalesce(json_agg(tablename ORDER BY tablename),'[]') FROM pg_tables WHERE schemaname='public'"))

def snapshot(database,retire_native_at=None):
    unsupported=sql(database,"SELECT (SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('public','pg_catalog','information_schema') AND schemaname NOT LIKE 'pg_%')+(SELECT count(*) FROM pg_matviews WHERE schemaname NOT LIKE 'pg_%')+(SELECT count(*) FROM information_schema.foreign_tables)")
    if unsupported!='0':raise ValueError('Review unsupported schemas, materialized views or foreign tables before reset')
    names=tables(database)
    if not KEEP.issubset(names):
        raise ValueError('Not a initialized UAIN store')
    counts=" UNION ALL ".join("SELECT '"+name+"' AS name,count(*) AS n FROM "+identifier(name) for name in names)
    # One snapshot and one client process: canonical COPY streams never expose
    # research contents to the caller and do not load a whole table into RAM.
    metadata="SELECT json_build_object('tables',(SELECT json_object_agg(name,n) FROM ("+counts+") counts),'head',(SELECT json_build_object('id',id,'hash',hash) FROM events ORDER BY id DESC LIMIT 1),'roots',(SELECT coalesce(json_agg(row_to_json(r) ORDER BY date),'[]') FROM ledger_roots r),'sequences',(SELECT coalesce(json_agg(row_to_json(s) ORDER BY sequencename),'[]') FROM pg_sequences s WHERE schemaname='public'));"
    statements=['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;',metadata]
    for name in names:
        identifier(name)
        expression='to_jsonb(t)'
        if name=='native_epochs' and retire_native_at is not None:
            # Only mutable epoch liveness changes. All proof, journal and body
            # bytes remain exact; previously retired epochs retain their date.
            expression+=" || jsonb_build_object('retired_at',coalesce(t.retired_at,TIMESTAMPTZ '"+retire_native_at+"'))"
        statements.extend(['\\echo UAIN_RESET_TABLE '+name,
            'COPY (SELECT ('+expression+')::text FROM '+identifier(name)+' t ORDER BY ('+expression+')::text COLLATE "C") TO STDOUT;'])
    statements.append('COMMIT;')
    command=(['runuser','-u','postgres','--'] if os.geteuid()==0 and os.environ.get('UAIN_RESET_TEST')!='1' else [])+['psql','-X','-q','-v','ON_ERROR_STOP=1','-At','-d',database]
    process=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    process.stdin.write(('\n'.join(statements)+'\n').encode());process.stdin.close()
    try:
        result=json.loads(process.stdout.readline())
        hashes={};current=None
        for line in process.stdout:
            if line.startswith(b'UAIN_RESET_TABLE '):
                current=line.decode().strip().split(' ',1)[1]
                if current not in names or current in hashes:raise ValueError('Unexpected fingerprint table')
                hashes[current]=hashlib.sha256()
            elif current is not None:hashes[current].update(line)
            else:raise ValueError('Missing fingerprint table')
        if process.wait()!=0 or set(hashes)!=set(names):raise RuntimeError('Database fingerprint failed')
        result['hashes']={name:sha.hexdigest() for name,sha in hashes.items()}
    except Exception:
        process.kill();process.wait();raise

    return result

def plan(database,epoch):
    identifier(database)
    if not re.fullmatch(r'[0-9]{8}_[0-9]{6}',epoch):
        raise ValueError('Epoch must be YYYYMMDD_HHMMSS')
    state=snapshot(database)
    unknown={name for name in state['tables'] if name.startswith('native_')}-NATIVE_HISTORY-{'native_projection_queue'}
    if unknown:raise ValueError('Review unknown native tables before reset')
    keep=KEEP|(NATIVE_HISTORY&set(state['tables']))
    retired_at=datetime.strptime(epoch,'%Y%m%d_%H%M%S').replace(tzinfo=timezone.utc).isoformat(sep=' ')
    retired=snapshot(database,retired_at) if 'native_epochs' in state['tables'] else state
    if {k:v for k,v in retired['hashes'].items() if k!='native_epochs'}!={k:v for k,v in state['hashes'].items() if k!='native_epochs'}:raise ValueError('Source changed during native retirement planning')
    result={'version':2,'database':database,'epoch':epoch,'target':'uain_reset_'+epoch,
            'preserve':sorted(keep),'clear':sorted(set(state['tables'])-keep),'before':state,
            'retire_native_at':retired_at,'preserved_hashes':{name:retired['hashes'][name] for name in sorted(keep)}}
    result['digest']=hashlib.sha256(json.dumps(result,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    return result

def stage(expected):
    actual=plan(expected['database'],expected['epoch'])
    if expected!=actual:
        raise ValueError('Reset plan is stale; generate a new plan')
    source=identifier(expected['database']);target=identifier(expected['target'])
    # Reject unexpected application schemas rather than clearing only public.
    schemas=sql(expected['database'],"SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('public','pg_catalog','information_schema') AND schemaname NOT LIKE 'pg_%'")
    if schemas!='0':raise ValueError('Review application tables outside the public schema')
    # TEMPLATE is an exact database copy, including functions, sequences and extension state.
    # PostgreSQL refuses it while any application session still uses the source.
    owner=sql(expected['database'],"SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()")
    exists=sql('postgres',"SELECT count(*) FROM pg_database WHERE datname='"+expected['target']+"'")
    if exists=='0':sql('postgres',f'CREATE DATABASE {target} TEMPLATE {source} OWNER {identifier(owner)};')
    else:
        current=snapshot(expected['target']);before=expected['before']
        empty=hashlib.sha256(b'').hexdigest()
        if any(current['hashes'][name] not in (before['hashes'][name],expected['preserved_hashes'][name]) for name in expected['preserve']) or any(current['hashes'][name] not in (before['hashes'][name],empty) for name in expected['clear']):
            raise ValueError('Existing stage differs from the reviewed source')

    clear=','.join(identifier(name) for name in expected['clear'])
    retirement=(" UPDATE native_epochs SET retired_at=TIMESTAMPTZ '"+expected['retire_native_at']+"' WHERE retired_at IS NULL;" if 'native_epochs' in expected['preserve'] else '')
    truncate=f' TRUNCATE {clear} CONTINUE IDENTITY;' if clear else ''
    sql(expected['target'],'BEGIN; SET LOCAL default_transaction_read_only=off;'+truncate+retirement+' COMMIT;')
    after=snapshot(expected['target'])
    if any(after['tables'][name] for name in expected['clear']):
        raise RuntimeError('Staged store is not empty')
    if after['head']!=expected['before']['head'] or after['roots']!=expected['before']['roots'] or any(after['hashes'][name]!=expected['preserved_hashes'][name] for name in expected['preserve']) or after['sequences']!=expected['before']['sequences']:
        raise RuntimeError('Staged history differs; do not activate it')
    if snapshot(expected['database'])!=expected['before']:raise ValueError('Original changed during staging')
    return {'database':expected['target'],'epoch':expected['epoch'],'plan_digest':expected['digest'],
            'active_rows':0,'preserved_history':True,'source_unchanged':True}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['plan','stage'])
    parser.add_argument('--database')
    parser.add_argument('--epoch')
    parser.add_argument('--plan')
    parser.add_argument('--confirm')
    args=parser.parse_args()
    if args.action=='plan':
        value=plan(args.database,args.epoch)
    else:
        with open(args.plan) as stream: expected=json.load(stream)
        if args.confirm!=expected['digest']:
            raise SystemExit('Stage requires the exact reviewed plan digest')
        value=stage(expected)
    print(json.dumps(value,sort_keys=True,indent=2))

def activate(expected):
    """Atomically rename the checked stage; never drop the original database."""
    live=expected['database'];target=expected['target'];old=live+'_epoch_'+expected['epoch']
    identifier(old)
    already=sql('postgres',"SELECT count(*) FROM pg_database WHERE datname='"+old+"'")=='1'
    if already:
        current=snapshot(live)
        if any(current['tables'][name] for name in expected['clear']) or any(current['hashes'][name]!=expected['preserved_hashes'][name] for name in expected['preserve']) or snapshot(old)!=expected['before']:
            raise ValueError('Partially activated epoch differs; inspect before recovery')
        seal_old_database(old)
        return {'active_database':live,'archived_database':old,'epoch':expected['epoch'],'already_activated':True}
    after=snapshot(target)
    if any(after['tables'][name] for name in expected['clear']) or any(after['hashes'][name]!=expected['preserved_hashes'][name] for name in expected['preserve']):
        raise ValueError('Stage changed; do not activate')
    if snapshot(live)!=expected['before']:raise ValueError('Original changed; do not activate')
    # Reject reconnected writers rather than terminating unrelated sessions.
    count=sql('postgres',"SELECT count(*) FROM pg_stat_activity WHERE datname='"+live+"'")
    if count!='0':raise ValueError('Live database still has sessions')
    sql('postgres',f'BEGIN; ALTER DATABASE {identifier(live)} RENAME TO {identifier(old)}; ALTER DATABASE {identifier(target)} RENAME TO {identifier(live)}; COMMIT;')
    seal_old_database(old)
    return {'active_database':live,'archived_database':old,'epoch':expected['epoch']}

def seal_old_database(old):
    # Revoke all explicit application grants, including waitlist_reader. Merely
    # revoking the former owner and PUBLIC does not seal a PostgreSQL database.
    roles=json.loads(sql('postgres',"SELECT coalesce(json_agg(rolname),'[]') FROM pg_roles WHERE NOT rolsuper"))
    grants=''.join(f' REVOKE CONNECT ON DATABASE {identifier(old)} FROM {identifier(role)};' for role in roles)
    sql('postgres',f'ALTER DATABASE {identifier(old)} OWNER TO postgres; REVOKE CONNECT ON DATABASE {identifier(old)} FROM PUBLIC;'+grants+f' ALTER DATABASE {identifier(old)} SET default_transaction_read_only=on;')

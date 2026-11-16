#!/usr/bin/env node
// Public output only. DATABASE_URL remains inside the isolated process.
import {createRequire} from 'node:module';
import {captureSnapshot} from '../../chain/migration/capture.mjs';
import {stableJSON} from '../../chain/migration/snapshot.mjs';
import {sourcePublicPolicy} from '../../chain/migration/public-policy.mjs';
const require=createRequire('/app/package.json');
const {Client}=require('pg');
const {snapshotTables}=await import('/app/dist/src/operations/backup.js');
const [mode,context]=process.argv.slice(2);
const options=JSON.parse(context);
if(mode!=='fresh'&&!/^[0-9A-F]+-[0-9A-F]+-[0-9]+$/.test(mode??''))throw Error('Invalid exported snapshot');
const exportedSnapshot=mode==='fresh'?undefined:mode;
const client=new Client({connectionString:process.env.DATABASE_URL,application_name:'uain-cutoff-readonly-capture',statement_timeout:60000});
await client.connect();
try{
 const unsupported=(await client.query("SELECT (SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('public','pg_catalog','information_schema') AND schemaname NOT LIKE 'pg_%')+(SELECT count(*) FROM pg_sequences WHERE schemaname NOT IN ('public','pg_catalog','information_schema') AND schemaname NOT LIKE 'pg_%')+(SELECT count(*) FROM pg_matviews WHERE schemaname NOT LIKE 'pg_%')+(SELECT count(*) FROM information_schema.foreign_tables) AS count")).rows[0].count;
 if(String(unsupported)!=='0')throw Error('Unsupported source schemas require review');
 const migration=await captureSnapshot(client,{pinnedPublicKey:options.ledger_public_key,publicPolicy:sourcePublicPolicy(options.public_policy),exportedSnapshot});
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 if(exportedSnapshot)await client.query(`SET TRANSACTION SNAPSHOT '${exportedSnapshot}'`);
 const full=await snapshotTables(client);
 // pg_sequences.last_value hides unused/setval(...,false) positions. Keep the
 // existing backup snapshot unchanged and independently pin physical state.
 const sequence_state=[];
 for(const {sequencename} of full.sequences){
  const quoted='"'+sequencename.replaceAll('"','""')+'"';
  const row=(await client.query(`SELECT last_value::text, is_called FROM public.${quoted}`)).rows[0];
  sequence_state.push({sequencename,last_value:row.last_value,is_called:row.is_called});
 }
 await client.query('COMMIT');
 process.stdout.write(JSON.stringify({migration_json:stableJSON(migration)+'\n',full,sequence_state})+'\n');
}finally{await client.end();}

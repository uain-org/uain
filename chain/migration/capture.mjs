import {COLUMNS,TABLES,buildSnapshot} from './snapshot.mjs';
// The caller owns the connection. A dedicated read-only transaction gives every
// table the same MVCC horizon, even while the federation continues operating.
// Bigints are explicitly cast, independent of a caller's pg global parsers.
export async function captureSnapshot(client,{pinnedPublicKey,publicPolicy,exportedSnapshot}={}){
 if(exportedSnapshot!==undefined&&(typeof exportedSnapshot!=='string'||!/^[0-9A-F]+-[0-9A-F]+-[0-9]+$/.test(exportedSnapshot)||exportedSnapshot.length>96))throw Error('invalid exported snapshot');
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try {
  if(exportedSnapshot!==undefined)await client.query(`SET TRANSACTION SNAPSHOT '${exportedSnapshot}'`);
  await client.query("SET LOCAL statement_timeout = '60s'");
  await client.query("SET LOCAL lock_timeout = '5s'");
  const columns=(await client.query("SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).rows;
  const tables={};
  for(const table of TABLES){
   const present=columns.filter(c=>c.table_name===table);
   for(const field of COLUMNS[table])if(!present.some(c=>c.column_name===field))throw Error(`schema drift: missing ${table}.${field}`);
   const selected=COLUMNS[table].map(field=>{const c=present.find(c=>c.column_name===field);return ['bigint','numeric','integer','smallint'].includes(c.data_type)?`"${field}"::text AS "${field}"`:`"${field}"`;});
   tables[table]=(await client.query(`SELECT ${selected.join(',')} FROM "${table}"`)).rows;
  }
  const snapshot=buildSnapshot(tables,{pinnedPublicKey,publicPolicy});
  await client.query('COMMIT');return snapshot;
 }catch(error){await client.query('ROLLBACK');throw error;}
}

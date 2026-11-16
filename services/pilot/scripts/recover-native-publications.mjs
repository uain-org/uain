#!/usr/bin/env node
// Authenticated SQL-backup recovery only; never signs, submits, projects,
// indexes, changes SQL state or selects a new native operating authority.
import pg from'pg';
import{recoverNativePublicationReplicas}from'../dist/src/native/replica.js';
const names=new Set(['epoch','after','limit','directory']),args={};
for(let i=2;i<process.argv.length;i+=2){const flag=process.argv[i];if(!flag?.startsWith('--')||!names.has(flag.slice(2))||args[flag.slice(2)]!==undefined||!process.argv[i+1])throw Error('explicit bounded publication recovery arguments required');args[flag.slice(2)]=process.argv[i+1]}
if(!process.env.DATABASE_URL||!args.epoch||!args.directory)throw Error('authenticated recovery database, epoch and directory required');
const client=new pg.Client({connectionString:process.env.DATABASE_URL});
try{await client.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL statement_timeout='10s'");const result=await recoverNativePublicationReplicas(client,args.epoch,args.directory,args.after??'',Number(args.limit??4));await client.query('COMMIT');console.log(JSON.stringify(result))}catch{console.error('Public capsule recovery refused; inspect the authenticated archive and existing files.');process.exitCode=1}finally{await client.end()}

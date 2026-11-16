// Private operator job: snapshot only already-public records on a loopback API.
// Run after every normal writer is stopped. No member or custody key exports.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createPilotServer} from '../dist/src/api/server.js';
import {pool,close} from '../dist/src/storage/store.js';
import {evidenceDigest} from '../dist/src/evidence/artifact-evidence.js';
import {publicKeyInfo} from '../dist/src/ledger/ledger.js';

async function capture(){
 const epoch=process.env.RESET_EPOCH;
 if(!/^[0-9]{8}_[0-9]{6}$/.test(epoch??''))throw Error('Invalid epoch');
 const pin=process.env.LEDGER_PUBLIC_KEY_PEM;
 if(!pin||pin.trim()!==publicKeyInfo().pem.trim())throw Error('Ledger public identity differs');
 const server=createPilotServer();
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const api=`http://127.0.0.1:${server.address().port}`;
 let captured=0,hidden=0;
 try{
  // This auditor is independent of server hash/record implementations. Refuse
  // the reset if the original publicly committed evidence already fails.
  const script=fileURLToPath(new URL('verify-ledger.mjs',import.meta.url));
  const child=spawn(process.execPath,[script],{env:{...process.env,UAIN_API:api},stdio:['ignore','ignore','ignore']});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  if(code!==0)throw Error('Original public ledger/evidence audit failed');
  if(process.env.RESET_VERIFY_ONLY==='1'){
   console.log(JSON.stringify({epoch,independent_public_evidence_audit:true}));return;
  }
  const kinds=[['projects','projects'],['contributions','contributions'],['tasks','tasks'],['claims','claims'],
               ['wallets','member_wallets'],['flags','benevolence_flags'],['directory','participants']];
  for(const [kind,table] of kinds){
   const rows=(await pool.query(`SELECT id FROM ${table} ORDER BY id`)).rows;
   for(const {id} of rows){
    await pool.query('INSERT INTO reset_reserved_ids(kind,record_id,epoch) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[kind,String(id),epoch]);
    const path='/api/'+(kind==='flags'?'benevolence/flags':kind)+'/'+encodeURIComponent(id);
    const response=await fetch(api+path);
    if(response.status===404){hidden++;continue;}
    if(!response.ok)throw Error('Public evidence capture failed');
    const payload=await response.json();const hash=evidenceDigest(payload);
    const previous=(await pool.query('SELECT epoch,payload,payload_sha256 FROM reset_public_records WHERE path=$1',[path])).rows[0];
    if(previous&&(previous.epoch!==epoch||evidenceDigest(previous.payload)!==previous.payload_sha256))throw Error('Archived identifier reused or evidence corrupted');
    if(!previous)await pool.query('INSERT INTO reset_public_records(path,kind,record_id,epoch,payload,payload_sha256) VALUES($1,$2,$3,$4,$5,$6)',[path,kind,String(id),epoch,JSON.stringify(payload),hash]);
    captured++;
   }
  }
  console.log(JSON.stringify({epoch,captured_public_records:captured,hidden_records_omitted:hidden,independent_original_evidence_audit:true}));
 }finally{server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));await close();}
}
try{await capture();process.exit(0);}catch{
 console.error('Public historical evidence capture refused; inspect the epoch journal.');process.exit(1);
}

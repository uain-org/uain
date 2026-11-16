// Invoked explicitly by the member, outside the research-agent runtime.
// Private parameters enter through bounded stdin/files, never process argv.
import { createPrivateKey, createPublicKey, createHash, generateKeyPairSync, verify } from 'node:crypto';
import { lstat, readFile, mkdir, open, mkdtemp, link, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { privatePartyConsent } from './private-review.mjs';
import { readPrivateState, publicPrivateRPC } from './private-state.mjs';
import { memberAddress, signingBytes } from './signing.mjs';
import { certificateForPrivateState, reviewEncryptedPrivateTrade, producePrivateTrade, signPrivateTradeCommand, verifyPrivateExecutable, verifyPrivateTradeEnvelope } from './private-workflow.mjs';

export const PRIVATE_HELP = `UAIN private exchange (explicit member action)

  uain-client private help
  uain-client private keygen           new private spending key
  uain-client private encryption-keygen  new checker encryption key
  uain-client private state            authenticate finalized pool/licences
  uain-client private consent          sign your own output-address consent
  uain-client private certificate      checker certifies an encryption key
  uain-client private review           inspect encrypted trade; sign a decision
  uain-client private trade            prepare, review and prove a trade
  uain-client private sign             owner or relay signs the public envelope
  uain-client private submit           submit that public envelope once
  uain-client private status           authenticate the saved ciphertext record

Each action reads one JSON object from stdin. Private files must be owned by
this user with mode 600; exchange directories must have mode 700. Outputs are
new files: existing files are refused. See docs/chain/private-client.md for
fields, independent executable/genesis pins and the checker courier protocol.
No command starts automatically or makes a research agent a wallet operator.`;
async function privateFile(file, limit = 512 * 1024) {
  const info = await lstat(file);
  if (!info.isFile() || info.size > limit || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) throw new Error('private owned regular file required');
  return JSON.parse(await readFile(file, 'utf8'));
}
async function save(file, value) {
  if (typeof file !== 'string' || !file) throw new Error('new output file required');
  const parent=dirname(resolve(file)), temporary=await mkdtemp(join(parent,'.uain-private-'));
  try {
    const pending=join(temporary,'value'),handle=await open(pending,'wx',0o600);
    try {await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();} finally {await handle.close();}
    // Publish only complete bytes. link is atomic and refuses an existing
    // destination, including a symlink or another concurrent writer's output.
    await link(pending,file);
  } finally {await rm(temporary,{recursive:true,force:true});}
  // Persist the final directory entry before any network send.
  const directory=await open(parent,'r');
  try {await directory.sync();} finally {await directory.close();}
}
async function cachedReader(input) {
  if (!input.witnessCacheFile) return input.reader;
  const witness_cache=await privateFile(input.witnessCacheFile,65536);
  return {...input.reader,request:{...input.reader.request,compact_witness:true,witness_cache,witness_positions:input.reader.request?.witness_positions ?? witness_cache.witnesses.map(w=>w.position)}};
}
async function signingKey(file) {
  const key = await privateFile(file,8192);
  if (key.algorithm !== 'Ed25519' || typeof key.public_key !== 'string' || typeof key.private_key !== 'string') throw new Error('local member identity key required');
  const privateKey = createPrivateKey({key:{kty:'OKP',crv:'Ed25519',x:key.public_key,d:key.private_key},format:'jwk'});
  if (createPublicKey(privateKey).export({format:'jwk'}).x !== key.public_key || memberAddress(Buffer.from(key.public_key,'base64url')) !== key.address) throw new Error('member identity key binding differs');
  return privateKey;
}
async function encryptionKey(file) {
  const key = await privateFile(file,8192);
  if (key.algorithm !== 'X25519' || key.private_jwk?.crv !== 'X25519') throw new Error('checker encryption key required');
  return createPrivateKey({key:key.private_jwk,format:'jwk'});
}
async function waitPrivate(file, signal) {
  while (!signal.aborted) {
    try { return await privateFile(file); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await new Promise(resolve => setTimeout(resolve,100));
  }
  throw new Error('private exchange deadline exceeded');
}
async function rpc(config, method, params) {
  const endpoint = new URL(config.rpc);
  if (config.socksProxy !== undefined || endpoint.hostname.toLowerCase().endsWith('.onion')) return publicPrivateRPC(config, method, params);
  if (!['http:','https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('public RPC endpoint required');
  const response = await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(15000),redirect:'error'});
  if (!response.ok) throw new Error('public RPC refused');
  const reader=response.body.getReader();let bytes=0;const parts=[];
  try {for (;;) {const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>128*1024)throw new Error('public RPC response too large');parts.push(value);}} finally {await reader.cancel();}
  const body=JSON.parse(Buffer.concat(parts).toString('utf8'));if(body.error || !body.result)throw new Error('public RPC failed');return body.result;
}
export async function runPrivateAction(action, input) {
  if (action==='help') return {help:PRIVATE_HELP};
  if (action==='keygen') {
    const executable=await verifyPrivateExecutable(input.tool);
    return await new Promise((resolve,reject)=>{
      const child=spawn(executable,['keygen',input.file],{stdio:['ignore','pipe','pipe']});let output='';const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
      child.stderr.resume();child.stdout.on('data',b=>{output+=b;if(output.length>4096)child.kill('SIGKILL');});
      child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);if(code!==0)return reject(new Error('wallet key creation refused'));try {resolve(JSON.parse(output));}catch {reject(new Error('invalid wallet public address'));}});
    });
  }
  if (action==='encryption-keygen') {
    const key=generateKeyPairSync('x25519');await save(input.file,{algorithm:'X25519',private_jwk:key.privateKey.export({format:'jwk'})});return {public_key:key.publicKey.export({format:'jwk'}).x};
  }
  if (action==='state') {
    const reader=await cachedReader(input);
    const state=await readPrivateState(reader);await save(input.out,state);
    if (input.witnessCacheOut) {if (!state.witness_cache)throw new Error('compact state required for cache output');await save(input.witnessCacheOut,state.witness_cache);}
    return {saved:true};
  }
  if (action==='consent') {
    await save(input.out,privatePartyConsent(input.context,input.address,await signingKey(input.signingKeyFile)));return {saved:true};
  }
  if (action==='certificate') {
    const key=await encryptionKey(input.encryptionKeyFile);
    await save(input.out,await certificateForPrivateState({reader:input.reader,context:input.context,reviewerSigningKey:await signingKey(input.signingKeyFile),encryptionPublicKey:createPublicKey(key)}));return {saved:true};
  }
  if (action==='review') {
    await save(input.out,await reviewEncryptedPrivateTrade({reader:input.reader,envelope:await privateFile(input.envelopeFile),tools:input.tools,reviewerSigningKey:await signingKey(input.signingKeyFile),reviewerEncryptionKey:await encryptionKey(input.encryptionKeyFile),decide:async inspected=>{await save(input.inspectionOut,{context:inspected.context,operation:inspected.operation,amount:inspected.amount,agreement:inspected.agreement,inspection:inspected.inspection});return waitPrivate(input.decisionFile,AbortSignal.timeout(180000));}}));return {saved:true};
  }
  if (action==='trade') {
    const directory=resolve(input.exchangeDirectory);await mkdir(directory,{mode:0o700});
    const info=await lstat(directory);if (!info.isDirectory() || info.mode & 0o077)throw new Error('private exchange directory required');
    const key=await signingKey(input.signingKeyFile);
    const result=await producePrivateTrade({...input,reader:await cachedReader(input),
      consent:async ({context,inspection,signal})=>{
        if (input.operation!=='private_payment')return [...new Set(inspection.outputs.map(o=>o.address))].map(address=>privatePartyConsent(context,address,key));
        const change=inspection.outputs.find(o=>o.address!==input.recipientAddress);if(!change)throw new Error('sender change output required');
        await save(join(directory,'consent-request.json'),{context,address:input.recipientAddress});
        return [privatePartyConsent(context,change.address,key),await waitPrivate(join(directory,'recipient-consent.json'),signal)];
      },
      certificate:async (context,{signal})=>{await save(join(directory,'certificate-request.json'),{context});return waitPrivate(join(directory,'certificate.json'),signal);},
      review:async (envelope,{signal})=>{await save(join(directory,'review-envelope.json'),envelope);return waitPrivate(join(directory,'review-approval.json'),signal);}
    });await save(input.out,result);if(input.witnessCacheOut)await save(input.witnessCacheOut,result.local_receipt.witness_cache);return {saved:true};
  }
  if (action==='sign') {
    const result=await privateFile(input.resultFile);
    await save(input.out,await signPrivateTradeCommand({reader:input.reader,result,signingKey:await signingKey(input.signingKeyFile)}));return {saved:true};
  }
  if (action==='submit') {
    const envelope=await verifyPrivateTradeEnvelope({reader:input.reader,envelope:await privateFile(input.envelopeFile,32768)});
    const bytes=Buffer.from(JSON.stringify(envelope));if(bytes.length>32768)throw new Error('public envelope too large');
    const tx_hash=createHash('sha256').update(bytes).digest('hex').toUpperCase();
    // Durable exact-byte journal precedes the only network attempt. A timeout
    // leaves this journal for status/reconciliation instead of a fresh spend.
    await save(input.out,{tx_hash,envelope,status:'pending'});
    try {const result=await rpc({...input.reader,rpc:input.broadcast?.rpc??input.reader.rpc,socksProxy:input.broadcast?input.broadcast.socksProxy:input.reader.socksProxy},'broadcast_tx_sync',{tx:bytes.toString('base64')});return {tx_hash,status:Number(result.code)===0?'submitted':'refused',code:result.code};}catch {return {tx_hash,status:'unknown',status_required:true};}
  }
  if (action==='status') {
    const journal=await privateFile(input.journalFile,65536);
    const envelope=journal.envelope, pub=Buffer.from(envelope.public_key,'base64url'), signature=Buffer.from(envelope.signature,'base64url');
    if (Object.keys(envelope).sort().join(',')!=='command,public_key,signature' || pub.length!==32 || pub.toString('base64url')!==envelope.public_key || signature.length!==64 || signature.toString('base64url')!==envelope.signature || memberAddress(pub)!==envelope.command.member || !verify(null,signingBytes(envelope.command),createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:envelope.public_key},format:'jwk'}),signature)) throw new Error('invalid signed transaction journal');
    const bytes=Buffer.from(JSON.stringify(envelope));
    if (createHash('sha256').update(bytes).digest('hex').toUpperCase()!==journal.tx_hash)throw new Error('transaction journal differs from its hash');
    const command=journal.envelope.command, approval=command.payload.approval;
    if (!['coin_shield','coin_exit','private_payment'].includes(command.operation) || Object.keys(command.payload).sort().join(',')!=='approval,bundle')throw new Error('invalid journal operation');
    const request={record_only:true,[command.operation==='private_payment'?'source_payments':'source_boundaries']:[approval.effects]};
    try {const state=await readPrivateState({...input.reader,request});if(!state.record_only || state.chain_id!==command.chain_id)throw new Error('record scope or chain differs');const record=[...state.payments,...state.boundaries].find(p=>p.id===approval.effects);if(record?.bundle!==command.payload.bundle)throw new Error('stored ciphertext differs');return {tx_hash:journal.tx_hash,status:'recorded',height:record.height,state_proof_verified:true,proof_kind:'ciphertext_record',transaction_inclusion_verified:false};}catch {return {tx_hash:journal.tx_hash,status:'unknown',status_required:true};}
  }
  throw new Error('unknown private exchange action');
}
export async function privateMain(args=process.argv.slice(2)) {
  const action=args[0] ?? 'help';if(action==='help' || action==='--help'){console.log(PRIVATE_HELP);return;}
  if(args.length!==1)throw new Error('private parameters belong in stdin');
  let size=0;const parts=[];
  for await (const part of process.stdin) {size+=part.length;if(size>65536)throw new Error('bounded private input required');parts.push(part);}
  const bytes=Buffer.concat(parts);
  try {const input=JSON.parse(bytes.toString('utf8'));console.log(JSON.stringify(await runPrivateAction(action,input)));}finally {bytes.fill(0);}
}
if (process.argv[1] && fileURLToPath(import.meta.url)===resolve(process.argv[1])) {
  try {await privateMain();}catch {console.error('Private exchange action refused; check private files, pins, policy and review.');process.exitCode=1;}
}

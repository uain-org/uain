// Tor terminates on this Unix socket. No TCP listener, request/access log,
// signing key, private receipt, general RPC proxy or administrator method.
import http from 'node:http';
import { chmod, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signingBytes, memberAddress } from '../../chain/client/signing.mjs';
import { createPublicKey, verify } from 'node:crypto';

const exact = (object, fields) => object && !Array.isArray(object) && typeof object === 'object' && Object.keys(object).every(key => fields.includes(key));
const member = 'uain1[0-9a-f]{40}', digest = '[0-9a-f]{64}';
const keys = new RegExp(`^(private_activation|private_licence_revision|private_frontier|coin_activation|coin_supply|member/${member}|coin_balance/${member}|private_reviewer/${member}|private_root/${digest}|private_payment/${digest}|private_boundary/${digest}|private_nullifier/${digest})$`);
// Light-wallet listings: the fixed public prefixes privatewallet.Oblivious
// scans in full, and their hex children when a page must be split. A listing
// names no member, payment or nullifier.
const listings = /^(?:(?:member|private_reviewer|coin_balance)\/(?:uain1[0-9a-f]{1,3})?|(?:private_root|private_payment|private_boundary|private_nullifier)\/[0-9a-f]{0,3})$/;
const height = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
export function validateRPC(body, allowBroadcast = false) {
  if (!exact(body, ['jsonrpc','id','method','params']) || body.jsonrpc !== '2.0' || !['string','number'].includes(typeof body.id) || String(body.id).length > 64) throw new Error('RPC frame refused');
  const params = body.params;
  if (body.method === 'commit') {
    if (!exact(params, ['height']) || params.height != null && !height(params.height)) throw new Error('commit parameters refused');
  } else if (body.method === 'abci_query') {
    if (!exact(params, ['path','data','height','prove']) || typeof params.data !== 'string' || !/^(?:0x)?(?:[0-9a-fA-F]{2}){1,128}$/.test(params.data) || !height(params.height)) throw new Error('query parameters refused');
    const bytes=Buffer.from(params.data.replace(/^0x/,''),'hex'), key=bytes.toString('utf8');
    if (!Buffer.from(key).equals(bytes) || !(params.path === '/store/federation/key' && params.prove === true && keys.test(key) || params.path === '/store/federation/subspace' && params.prove === false && (/^private_note\/[0-9]{7}$/.test(key) || listings.test(key)))) throw new Error('query route refused');
  } else if (body.method === 'broadcast_tx_sync' && allowBroadcast) {
    if (!exact(params, ['tx']) || typeof params.tx !== 'string') throw new Error('transaction refused');
    const tx=Buffer.from(params.tx,'base64');
    if (tx.length > 32768 || tx.toString('base64') !== params.tx) throw new Error('transaction refused');
    const envelope=JSON.parse(tx.toString('utf8'));
    if (!exact(envelope, ['command','public_key','signature']) || Object.keys(envelope).length !== 3 || envelope.command?.operation !== 'private_payment' || !exact(envelope.command.payload, ['bundle','approval']) || Object.keys(envelope.command.payload).length !== 2) throw new Error('private payment envelope required');
    const bundle=envelope.command.payload.bundle;
    if(typeof bundle !== 'string')throw new Error('canonical bounded ciphertext bundle required');
    const wire=Buffer.from(bundle,'base64url');
    if(wire.length < 1 || wire.length > 16384 || wire.toString('base64url') !== bundle)throw new Error('canonical bounded ciphertext bundle required');
    const approval=envelope.command.payload.approval;
    if (!exact(approval,['reviewer','effects','purpose_commitment','class','expires_height','licence_revision','signature']) || Object.keys(approval).length !== 7 || !new RegExp(`^${member}$`).test(approval.reviewer) || !new RegExp(`^${digest}$`).test(approval.effects) || !new RegExp(`^${digest}$`).test(approval.purpose_commitment) || !['neutral','benevolent'].includes(approval.class) || !height(approval.expires_height) || typeof approval.licence_revision !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(approval.licence_revision) || BigInt(approval.licence_revision)>18446744073709551615n || typeof approval.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(approval.signature)) throw new Error('public checker approval fields required');
    if(Buffer.from(approval.signature,'base64url').toString('base64url') !== approval.signature)throw new Error('canonical checker signature required');
    const pub=Buffer.from(envelope.public_key,'base64url'), sig=Buffer.from(envelope.signature,'base64url');
    if (pub.length !== 32 || pub.toString('base64url') !== envelope.public_key || sig.length !== 64 || sig.toString('base64url') !== envelope.signature || memberAddress(pub) !== envelope.command.member || !verify(null,signingBytes(envelope.command),createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:envelope.public_key},format:'jwk'}),sig)) throw new Error('signed public payment required');
    // Cosmos CheckTx/DeliverTx still enforce policy, licence, nonce, reviewer,
    // proof and nullifiers. The gateway grants no authority of its own.
  } else throw new Error('RPC method refused');
  return body;
}

export async function startGateway({socket, upstream, allowBroadcast=false, maxConcurrent=16}) {
  const target=new URL(upstream);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password || target.pathname !== '/' || target.search || target.hash || !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 32) throw new Error('fixed loopback upstream and bounded concurrency required');
  socket=resolve(socket);
  try {await lstat(socket);throw new Error('new socket path required');}catch(error){if(error.code !== 'ENOENT')throw error;}
  let active=0;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('cache-control','no-store');res.setHeader('content-type','application/json');
    if(req.method !== 'POST' || req.url !== '/' || req.headers['content-type']?.split(';')[0] !== 'application/json'){res.writeHead(404);res.end('{}');return;}
    if(active >= maxConcurrent){res.writeHead(503);res.end('{}');return;}
    active++;
    const deadline=setTimeout(()=>req.destroy(),20000);deadline.unref();
    const abort=new AbortController();res.once('close',()=>abort.abort());
    try {
      const parts=[];let size=0;
      for await(const part of req){size+=part.length;if(size > 65536)throw new Error('bounded request required');parts.push(part);}
      const body=validateRPC(JSON.parse(Buffer.concat(parts).toString('utf8')),allowBroadcast);
      const response=await fetch(target,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.any([abort.signal,AbortSignal.timeout(15000)]),redirect:'error'});
      if(!response.ok)throw new Error('upstream refused');
      const out=[];let bytes=0;const reader=response.body.getReader();
      try {for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes > 2*1024*1024)throw new Error('bounded response required');out.push(value);}}finally{await reader.cancel();}
      const raw=Buffer.concat(out);const frame=JSON.parse(raw.toString('utf8'));
      if(frame.jsonrpc !== '2.0' || frame.id !== body.id)throw new Error('RPC response differs');
      res.writeHead(200);res.end(raw);
    }catch {if(!res.destroyed){res.writeHead(400);res.end('{}');}}
    finally {clearTimeout(deadline);active--;}
  });
  server.requestTimeout=20000;server.headersTimeout=10000;server.keepAliveTimeout=1000;server.maxRequestsPerSocket=100;
  server.on('clientError',(_error,socket)=>socket.destroy());
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});
  await chmod(socket,0o660);
  return server;
}
if(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const server=await startGateway({socket:process.env.UAIN_PRIVATE_SOCKET,upstream:process.env.UAIN_PRIVATE_RPC,allowBroadcast:process.env.UAIN_PRIVATE_BROADCAST === '1'});
    for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>server.close(()=>process.exit(0)));
  }catch {console.error('Private RPC gateway could not start.');process.exitCode=1;}
}

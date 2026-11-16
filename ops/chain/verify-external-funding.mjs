#!/usr/bin/env node
// Read-only external native-transfer observation. No wallet, key or submission API.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOLANA_MAINNET_GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const U64=(1n<<64n)-1n, U256=(1n<<256n)-1n;
const READ_METHODS=new Set(['eth_chainId','eth_getTransactionByHash','eth_getTransactionReceipt','eth_getBlockByNumber','getGenesisHash','getSignatureStatuses','getSlot','getTransaction','getBlock']);

// JSON integer tokens become BigInt before any IEEE-754 conversion. Preserve
// unrelated UI decimal fields as opaque tokens, never usable as atomic units.
export function parseExactJSON(text) {
  assert.equal(typeof text,'string');assert.ok(Buffer.byteLength(text)<=1048576,'bounded JSON required');
  let at=0,nodes=0;
  const ws=()=>{while(/[\x20\t\n\r]/.test(text[at]??'!'))at++;};
  function string() {
    const start=at++;let escaped=false;
    while(at<text.length){const c=text[at++];if(c==='"'&&!escaped)return JSON.parse(text.slice(start,at));if(c==='\\'&&!escaped)escaped=true;else escaped=false;}
    throw Error('unterminated JSON string');
  }
  function value(depth=0) {
    assert.ok(depth<=64&&++nodes<=100000,'bounded JSON structure required');ws();const c=text[at];
    if(c==='"')return string();
    if(c==='{'||c==='['){at++;const object=c==='{',out=object?Object.create(null):[];ws();const end=object?'}':']';if(text[at]===end){at++;return out;}
      while(true){ws();let key;if(object){assert.equal(text[at],'"');key=string();assert.ok(key!=='__proto__'&&!Object.hasOwn(out,key),'duplicate or unsafe JSON key');ws();assert.equal(text[at++],':');}const item=value(depth+1);if(object)out[key]=item;else out.push(item);ws();const next=text[at++];if(next===end)return out;assert.equal(next,',');}
    }
    for(const [literal,result] of [['true',true],['false',false],['null',null]])if(text.startsWith(literal,at)){at+=literal.length;return result;}
    const match=/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(at));assert.ok(match&&match[0].length<=100,'exact bounded JSON number required');at+=match[0].length;
    if(/[.eE]/.test(match[0]))return Object.freeze({json_number:match[0]});
    assert.ok(match[0].length<=79,'bounded JSON integer required');return BigInt(match[0]);
  }
  const result=value();ws();assert.equal(at,text.length,'trailing or inexact JSON');return result;
}
function exactJSON(value) {
  if(typeof value==='bigint')return value.toString();
  if(Array.isArray(value))return '['+value.map(exactJSON).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).map(([key,item])=>JSON.stringify(key)+':'+exactJSON(item)).join(',')+'}';
  if(typeof value==='number')assert.ok(Number.isSafeInteger(value));return JSON.stringify(value);
}
export function createRPC(endpoint) {
  const url=new URL(endpoint);assert.ok(url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname)),'HTTPS or own loopback RPC required');assert.ok(!url.username&&!url.password&&!url.hash,'RPC URL credentials/fragment refused');
  const deadline=Date.now()+120000;
  return async(method,params)=>{
    assert.ok(READ_METHODS.has(method),'read-only RPC method required');const remaining=deadline-Date.now();assert.ok(remaining>0,'RPC observation deadline exceeded');
    const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:exactJSON({jsonrpc:'2.0',id:'funding-read',method,params}),redirect:'error',signal:AbortSignal.timeout(Math.min(10000,remaining))});
    assert.ok(response.ok,'RPC HTTP failure');assert.ok(Number(response.headers.get('content-length')??0)<=1048576,'RPC reply too large');
    const chunks=[];let length=0;
    for await(const bytes of response.body){length+=bytes.length;if(length>1048576){await response.body.cancel().catch(()=>{});throw Error('bounded RPC reply required');}chunks.push(bytes);}
    const frame=parseExactJSON(Buffer.concat(chunks).toString('utf8'));assert.equal(frame.jsonrpc,'2.0');assert.equal(frame.id,'funding-read');assert.ok(!Object.hasOwn(frame,'error')&&Object.hasOwn(frame,'result'),'RPC result required');return frame.result;
  };
}
function decimal(value,max=U256) {assert.ok(typeof value==='string'&&/^(0|[1-9][0-9]{0,77})$/.test(value),'canonical decimal integer string required');const n=BigInt(value);assert.ok(n<=max,'integer out of range');return n;}
function hex(value,max=U256) {assert.ok(typeof value==='string'&&/^0x(0|[1-9a-f][0-9a-f]{0,63})$/.test(value),'canonical hex integer required');const n=BigInt(value);assert.ok(n<=max);return n;}
function hash(value) {assert.match(value,/^0x[0-9a-f]{64}$/);return value;}
function address(value) {assert.equal(typeof value,'string');assert.match(value,/^0x[0-9a-fA-F]{40}$/);return value.toLowerCase();}
function integer(value,max=U64) {assert.ok(typeof value==='bigint'&&value>=0n&&value<=max,'exact unsigned JSON integer required');return value;}
function base58(value,size) {
  assert.ok(typeof value==='string'&&value.length<=88&&/^[1-9A-HJ-NP-Za-km-z]+$/.test(value),'base58 required');
  const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=0n;for(const c of value)n=n*58n+BigInt(alphabet.indexOf(c));let bytes=0;while(n){bytes++;n>>=8n;}for(const c of value){if(c!=='1')break;bytes++;}assert.equal(bytes,size,'base58 byte length differs');return value;
}
function sameEVM(tx,receipt,e) {
  assert.ok(tx&&receipt,'included transaction and receipt required');assert.equal(hash(tx.hash),e.tx_id);assert.equal(hash(receipt.transactionHash),e.tx_id);assert.equal(hex(tx.chainId),BigInt(e.chain_id));assert.equal(hex(receipt.status),1n,'successful receipt required');
  for(const item of [tx,receipt]){assert.equal(address(item.from),address(e.from));assert.equal(address(item.to),address(e.to));hash(item.blockHash);hex(item.blockNumber);hex(item.transactionIndex,1000000n);}
  for(const key of ['blockHash','blockNumber','transactionIndex'])assert.equal(tx[key],receipt[key],'transaction moved or mismatched inclusion');
  assert.equal(hex(tx.value),decimal(e.amount_units));assert.equal(tx.input,'0x','plain native transfer required');
  return {block_hash:receipt.blockHash,block_height:hex(receipt.blockNumber).toString(),transaction_index:hex(receipt.transactionIndex).toString()};
}
async function evm(e,rpc) {
  assert.equal(e.transfer_index,'0','EVM native transfer index must be zero');hash(e.tx_id);address(e.from);address(e.to);
  assert.equal(hex(await rpc('eth_chainId',[])),BigInt(e.chain_id),'wrong EVM chain');
  const tx=await rpc('eth_getTransactionByHash',[e.tx_id]),receipt=await rpc('eth_getTransactionReceipt',[e.tx_id]),point=sameEVM(tx,receipt,e);
  const finalized=await rpc('eth_getBlockByNumber',['finalized',false]);assert.ok(finalized,'finalized head required');hash(finalized.hash);assert.ok(hex(finalized.number)>=BigInt(point.block_height),'transfer is not finalized');
  const checkBlock=block=>{assert.ok(block,'canonical block required');assert.equal(hash(block.hash),point.block_hash,'canonical block changed');assert.equal(hex(block.number).toString(),point.block_height);assert.ok(Array.isArray(block.transactions));assert.equal(block.transactions[Number(point.transaction_index)],e.tx_id,'canonical transaction inclusion differs');};
  checkBlock(await rpc('eth_getBlockByNumber',[receipt.blockNumber,false]));
  const again=await rpc('eth_getTransactionReceipt',[e.tx_id]);assert.deepEqual(sameEVM(tx,again,e),point,'receipt moved');
  checkBlock(await rpc('eth_getBlockByNumber',[receipt.blockNumber,false]));assert.equal(hex(await rpc('eth_chainId',[])),BigInt(e.chain_id));return point;
}
async function solana(e,rpc) {
  base58(e.tx_id,64);base58(e.from,32);base58(e.to,32);const amount=decimal(e.amount_units,U64),index=decimal(e.transfer_index,1023n);
  assert.equal(await rpc('getGenesisHash',[]),SOLANA_MAINNET_GENESIS,'wrong Solana genesis');
  const statusResult=await rpc('getSignatureStatuses',[[e.tx_id],{searchTransactionHistory:true}]),status=statusResult?.value?.[0];assert.ok(status&&status.err===null&&status.confirmationStatus==='finalized','finalized successful signature required');const slot=integer(status.slot);
  assert.ok(integer(await rpc('getSlot',[{commitment:'finalized'}]))>=slot,'transaction not finalized');
  const tx=await rpc('getTransaction',[e.tx_id,{commitment:'finalized',encoding:'jsonParsed',maxSupportedTransactionVersion:1}]);assert.ok(tx?.meta&&tx.meta.err===null,'successful transaction metadata required');assert.ok(tx.version==='legacy'||tx.version===0n||tx.version===1n,'unsupported Solana transaction version');assert.equal(integer(tx.slot),slot,'transaction moved');assert.equal(tx.transaction?.signatures?.[0],e.tx_id,'signature differs');
  const message=tx.transaction.message,instruction=message.instructions?.[Number(index)];assert.ok(instruction,'instruction index absent');assert.equal(instruction.program,'system');assert.equal(instruction.programId,'11111111111111111111111111111111');assert.equal(instruction.parsed?.type,'transfer','native system transfer required');const info=instruction.parsed.info;assert.equal(info.source,e.from);assert.equal(info.destination,e.to);assert.equal(integer(info.lamports),amount,'lamports differ');assert.ok(message.accountKeys?.some(key=>key.pubkey===e.from&&key.signer===true),'source signer required');
  const params=[slot,{commitment:'finalized',transactionDetails:'signatures',rewards:false,maxSupportedTransactionVersion:1}];
  const block=await rpc('getBlock',params);base58(block?.blockhash,32);assert.ok(block.signatures?.includes(e.tx_id),'finalized canonical signature absent');
  const again=await rpc('getBlock',params);assert.equal(again?.blockhash,block.blockhash,'canonical Solana block changed');assert.ok(again.signatures?.includes(e.tx_id),'signature moved');
  const finalStatus=(await rpc('getSignatureStatuses',[[e.tx_id],{searchTransactionHistory:true}]))?.value?.[0];assert.ok(finalStatus?.err===null&&finalStatus.confirmationStatus==='finalized');assert.equal(integer(finalStatus.slot),slot);assert.equal(await rpc('getGenesisHash',[]),SOLANA_MAINNET_GENESIS);
  return {block_height:slot.toString(),block_hash:block.blockhash,genesis_hash:SOLANA_MAINNET_GENESIS};
}
export async function verifyExternalFunding(expected,{rpc}) {
  assert.ok(expected&&typeof expected==='object'&&!Array.isArray(expected));const keys=['chain_id','tx_id','from','to','amount_units','transfer_index'];assert.deepEqual(Object.keys(expected).sort(),keys.sort(),'exact expected transfer fields required');for(const key of keys)assert.equal(typeof expected[key],'string');assert.ok(['1','8453','solana-mainnet'].includes(expected.chain_id),'unsupported chain');assert.ok(decimal(expected.amount_units)>0n,'positive transfer amount required');decimal(expected.transfer_index,1023n);
  const point=await(expected.chain_id==='solana-mainnet'?solana(expected,rpc):evm(expected,rpc));
  return {...expected,...point,finality:'finalized',assurance:'trusted-rpc-observation',verified:true,checked_at:new Date().toISOString()};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length,3,'usage: verify-external-funding.mjs RPC_URL < expected-transfer.json');let text='';const timer=setTimeout(()=>{process.stdin.destroy(Error('bounded input deadline exceeded'));},5000);
    try {for await(const bytes of process.stdin){text+=bytes;assert.ok(Buffer.byteLength(text)<=8192,'bounded transfer input required');}} finally{clearTimeout(timer);}
    const result=await verifyExternalFunding(parseExactJSON(text),{rpc:createRPC(process.argv[2])});console.log(JSON.stringify(result));
  }catch{console.error('External funding verification refused; check expected transfer and independently trusted finalized RPC.');process.exitCode=1;}
}

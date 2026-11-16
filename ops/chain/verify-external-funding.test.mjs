import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { parseExactJSON, createRPC, verifyExternalFunding, SOLANA_MAINNET_GENESIS } from './verify-external-funding.mjs';

const H='0x'+'ab'.repeat(32), B='0x'+'cd'.repeat(32), C='0x'+'ef'.repeat(32);
const A='0x'+'11'.repeat(20), Z='0x'+'22'.repeat(20);
const evmExpected={chain_id:'1',tx_id:H,from:A,to:Z,amount_units:'9007199254740993',transfer_index:'0'};
function evmFixture(change=()=>{}) {
  const tx={hash:H,chainId:'0x1',from:A,to:Z,value:'0x20000000000001',input:'0x',blockHash:B,blockNumber:'0xa',transactionIndex:'0x1'};
  const receipt={transactionHash:H,status:'0x1',from:A,to:Z,blockHash:B,blockNumber:'0xa',transactionIndex:'0x1'};
  const state={chain:'0x1',tx,receipt,block:{hash:B,number:'0xa',transactions:[C,H]},finalized:{hash:C,number:'0xb'},reads:0};change(state);
  return async(method,params)=> {
    if(method==='eth_chainId')return state.chain;
    if(method==='eth_getTransactionByHash')return state.tx;
    if(method==='eth_getTransactionReceipt')return state.receipt;
    if(method==='eth_getBlockByNumber')return params[0]==='finalized'?state.finalized:state.block;
    throw Error('unexpected method '+method);
  };
}
test('EVM verifies exact native value and finalized canonical inclusion on Ethereum and Base',async()=>{
  const receipt=await verifyExternalFunding(evmExpected,{rpc:evmFixture()});
  assert.equal(receipt.amount_units,'9007199254740993');assert.equal(receipt.block_height,'10');assert.equal(receipt.assurance,'trusted-rpc-observation');
  assert.equal((await verifyExternalFunding({...evmExpected,chain_id:'8453'},{rpc:evmFixture(s=>{s.chain='0x2105';s.tx.chainId='0x2105';})})).chain_id,'8453');
});
test('EVM rejects wrong chain, pending/failed/reorged/moved or mismatched native transfer',async()=>{
  const mutations=[s=>s.chain='0x2',s=>s.tx.chainId='0x2',s=>s.receipt=null,s=>s.receipt.status='0x0',s=>s.finalized.number='0x9',s=>s.block.hash=C,s=>s.block.transactions[1]=C,s=>s.tx.from=Z,s=>s.tx.to=A,s=>s.tx.value='0x20000000000000',s=>s.receipt.to=A,s=>s.tx.input='0x1234',s=>s.tx.blockHash=C,s=>s.tx.blockNumber='0xb',s=>s.receipt.transactionIndex='0x0',s=>s.tx.value='0x020000000000001'];
  for(const mutate of mutations)await assert.rejects(verifyExternalFunding(evmExpected,{rpc:evmFixture(mutate)}));
  for(const bad of [{chain_id:'5'},{transfer_index:'1'},{amount_units:9007199254740992},{amount_units:'1e3'},{amount_units:'01'},{amount_units:'-1'}])await assert.rejects(verifyExternalFunding({...evmExpected,...bad},{rpc:evmFixture()}));
  let blocks=0;const rpc=evmFixture();await assert.rejects(verifyExternalFunding(evmExpected,{rpc:async(m,p)=>{const value=await rpc(m,p);return m==='eth_getBlockByNumber'&&p[0]!=='finalized'&&++blocks===2?{...value,hash:C}:value;}}));
  let receipts=0;await assert.rejects(verifyExternalFunding(evmExpected,{rpc:async(m,p)=>{const value=await rpc(m,p);return m==='eth_getTransactionReceipt'&&++receipts===2?{...value,blockHash:C}:value;}}));
});

const S='1'.repeat(64), F='1'.repeat(32), T='2'.repeat(44), BH='3'.repeat(44);
const solExpected={chain_id:'solana-mainnet',tx_id:S,from:F,to:T,amount_units:'9007199254740993',transfer_index:'1'};
function solFixture(change=()=>{}) {
  const instruction={program:'system',programId:'11111111111111111111111111111111',parsed:{type:'transfer',info:{source:F,destination:T,lamports:9007199254740993n}}};
  const state={genesis:SOLANA_MAINNET_GENESIS,status:{slot:55n,err:null,confirmationStatus:'finalized'},slot:60n,tx:{version:'legacy',slot:55n,meta:{err:null},transaction:{signatures:[S],message:{accountKeys:[{pubkey:F,signer:true}],instructions:[{program:'memo'},instruction]}}},block:{blockhash:BH,signatures:[S]}};change(state);
  return async(method,params)=>{if(['getTransaction','getBlock'].includes(method))assert.equal(params[1].maxSupportedTransactionVersion,1,'opt into current Solana v1 reading');return ({getGenesisHash:state.genesis,getSignatureStatuses:{value:[state.status]},getSlot:state.slot,getTransaction:state.tx,getBlock:state.block})[method];};
}
test('Solana verifies finalized native System Program instruction with exact u64 lamports',async()=>{
  const result=await verifyExternalFunding(solExpected,{rpc:solFixture()});assert.equal(result.amount_units,'9007199254740993');assert.equal(result.block_height,'55');assert.equal(result.transfer_index,'1');
  for(const version of [0n,1n])assert.equal((await verifyExternalFunding(solExpected,{rpc:solFixture(s=>s.tx.version=version)})).verified,true);
});
test('Solana rejects wrong cluster, nonfinality, errors, absent/moved signature and altered instructions',async()=>{
  const mutations=[s=>s.genesis='devnet',s=>s.status.confirmationStatus='confirmed',s=>s.status.err={},s=>s.tx.meta.err={},s=>s.tx.meta=null,s=>s.tx.slot=56n,s=>s.slot=54n,s=>s.tx.transaction.signatures=[BH],s=>s.block.signatures=[],s=>s.tx.transaction.message.instructions[1].program='spl-token',s=>s.tx.transaction.message.instructions[1].programId=T,s=>s.tx.transaction.message.instructions[1].parsed.type='transferWithSeed',s=>s.tx.transaction.message.instructions[1].parsed.info.source=T,s=>s.tx.transaction.message.instructions[1].parsed.info.destination=F,s=>s.tx.transaction.message.instructions[1].parsed.info.lamports=9007199254740992n,s=>s.tx.transaction.message.instructions[1].parsed.info.lamports=9007199254740992,s=>s.tx.transaction.message.accountKeys[0].signer=false];
  for(const mutate of mutations)await assert.rejects(verifyExternalFunding(solExpected,{rpc:solFixture(mutate)}));
  await assert.rejects(verifyExternalFunding({...solExpected,transfer_index:'0'},{rpc:solFixture()}));
  let reads=0;const rpc=solFixture();await assert.rejects(verifyExternalFunding(solExpected,{rpc:async(m,p)=>{const value=await rpc(m,p);return m==='getBlock'&&++reads===2?{...value,blockhash:T}:value;}}));
});
test('lossless JSON rejects malformed/inexact integer tokens and duplicate keys',async()=>{
  assert.equal(parseExactJSON('{"lamports":9007199254740993}').lamports,9007199254740993n);
  assert.equal(parseExactJSON('{"text":"12e3", "negative":-1}').negative,-1n);
  for(const token of ['1e3','1.0','12.5'])assert.equal(parseExactJSON('{"n":'+token+'}').n.json_number,token);
  for(const text of ['{"n":01}','{"n":1,"n":2}','[1,]','{"__proto__":1}','null trailing','{"n":1e}','{"n":1.}'])assert.throws(()=>parseExactJSON(text));
  for(const token of ['1e3','1.0'])await assert.rejects(verifyExternalFunding(solExpected,{rpc:solFixture(s=>s.tx.transaction.message.instructions[1].parsed.info.lamports=parseExactJSON('{"n":'+token+'}').n)}));
});
test('RPC client uses only bounded read methods and rejects oversized or redirected replies',async()=>{
  const server=createServer((req,res)=>{if(req.url==='/redirect'){res.writeHead(302,{location:'/'});res.end();}else res.end('x'.repeat(1048577));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {const url='http://127.0.0.1:'+server.address().port;await assert.rejects(createRPC(url)('sendTransaction',[]),/read/);await assert.rejects(createRPC(url)('getGenesisHash',[]),/bound|large/);await assert.rejects(createRPC(url+'/redirect')('getGenesisHash',[]));}finally{await new Promise(r=>server.close(r));}
});
test('RPC deadline refuses a server that never produces a response',async()=>{
  const server=createServer(()=>{});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {const start=Date.now();await assert.rejects(createRPC('http://127.0.0.1:'+server.address().port)('getGenesisHash',[]),/abort|timeout/i);assert.ok(Date.now()-start<11500,'bounded RPC timeout');}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('real HTTP and stdin CLI preserve Solana integer tokens and only issue read methods',async()=>{
  // Native transfers may coexist with unrelated token UI amounts in metadata.
  const methods=[],rpc=solFixture(s=>s.tx.meta.postTokenBalances=[{uiTokenAmount:{uiAmount:12.5}}]);
  const server=createServer(async(req,res)=>{
    let body='';for await(const bytes of req)body+=bytes;const frame=JSON.parse(body);methods.push(frame.method);
    const result=await rpc(frame.method,frame.params);
    res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:frame.id,result},(_,v)=>typeof v==='bigint'?`${v}n`:v).replace(/"(-?[0-9]+)n"/g,'$1'));
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {
    const child=spawn(process.execPath,[new URL('./verify-external-funding.mjs',import.meta.url).pathname,'http://127.0.0.1:'+server.address().port],{stdio:['pipe','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.stdin.end(JSON.stringify(solExpected));
    const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});assert.equal(code,0,err);assert.equal(JSON.parse(out).amount_units,'9007199254740993');assert.ok(methods.length>=8);assert.ok(methods.every(m=>m.startsWith('get')));
  }finally{await new Promise(r=>server.close(r));}
});

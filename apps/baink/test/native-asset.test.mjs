import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, createHash } from 'node:crypto';
import {
  createNativeAssetAdapter,
  formatNativeUnits,
  displayNativeUnits,
  nativeUnitsFromDecimal,
  assetMetadata,
} from '../server/native-asset.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
function identity() {
  const { publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return {
    address: 'uain1' + sha(raw).slice(0, 40),
    publicKey: raw.toString('base64'),
    nativeKey: raw.toString('base64url'),
  };
}
function snapshot(who, patch = {}) {
  return {
    chain_id: 'isolated-native-fixture',
    height: '100',
    header_time: new Date().toISOString(),
    app_hash: 'a'.repeat(64),
    event_count: '40',
    member: {
      id: who.address,
      public_key: who.nativeKey,
      sequence: '9',
      licence: 'active',
      credits: '999999999999999999999',
    },
    records: {
      legacy_import: null,
      coin_activation: {
        policy: 'verified-bounties-108t-micro-v1',
        height: '5',
        evidence_digest: 'b'.repeat(64),
      },
      coin_supply: {
        minted: '9007199254740993',
        reserved: '0',
        transparent: '9007199254740993',
        shielded: '0',
      },
      private_activation: null,
      [`coin_balance/${who.address}`]: '9007199254740993',
    },
    ...patch,
  };
}
async function adapterFixture(t, who, state, overrides = {}, behavior = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'baink-native-fixture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const genesis = JSON.stringify({ chain_id: 'isolated-native-fixture' }),
    genesisPath = join(dir, 'genesis.json'),
    binary = join(dir, 'reader');
  // This synthetic pinned executable exercises the process/pin/selection binder.
  // Consensus signatures and IAVL proofs belong to the reviewed Go reader.
  const trace = join(dir, 'reader-events.jsonl');
  const log = event => behavior.trace ? `fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({event:${JSON.stringify(event)},pid:process.pid})+'\\n');` : '';
  const code = behavior.stderr !== undefined ? `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(behavior.stderr)});process.exit(1);\n` : `#!${process.execPath}\nconst fs=require('fs');let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{${log('start')}setTimeout(()=>{const request=JSON.parse(input);const data=${JSON.stringify(state)};if(request.member&&!data.member)process.exit(9);const record={...data.records,['member/${who.address}']:data.member??null};data.records=Object.fromEntries(['legacy_import',...(request.keys||[])].map(key=>[key,Object.hasOwn(record,key)?record[key]:null]));if(!request.member)delete data.member;const output=process.argv[process.argv.indexOf('--out')+1];fs.writeFileSync(output,JSON.stringify(data),{mode:384,flag:'wx'});${log('end')}},${behavior.delayMs ?? 0});});\n`;
  await writeFile(binary, code, { mode: 0o700 });
  await chmod(binary, 0o700);
  await writeFile(genesisPath, genesis);
  const config = {
    binary,
    binaryHash: sha(code),
    genesis: genesisPath,
    genesisHash: sha(genesis),
    rpc: 'http://127.0.0.1:1',
    chainId: 'isolated-native-fixture',
    timeoutMs: 2000,
    maxAgeSeconds: 120,
    ...overrides,
  };
  return {
    adapter: createNativeAssetAdapter({ config }),
    config,
    binary,
    genesisPath,
    trace,
  };
}

test('AI$ maps to the existing native coin with exact six-place units beyond Number precision', () => {
  const asset = assetMetadata();
  assert.equal(asset.id, 'uain-native-coin');
  assert.equal(asset.sameLedger, true);
  assert.equal(asset.symbol, 'AI$');
  assert.equal(formatNativeUnits('9007199254740993'), '9007199254.740993');
  assert.equal(
    formatNativeUnits('108000000000000000000'),
    '108000000000000.000000',
  );
  assert.equal(formatNativeUnits('1'), '0.000001');
  assert.equal(formatNativeUnits('0'), '0.000000');
  assert.equal(nativeUnitsFromDecimal('1000000000'), '1000000000000000');
  assert.equal(
    nativeUnitsFromDecimal('108000000000000.000000'),
    '108000000000000000000',
  );
  assert.throws(() => nativeUnitsFromDecimal('108000000000000.000001'));
  for (const invalid of [
    0,
    9007199254740993,
    '01',
    '-1',
    '1.0',
    '1e6',
    '108000000000000000001',
  ])
    assert.throws(() => formatNativeUnits(invalid));
});

test('AI$ display drops trailing zeros while every signed, hashed or stored amount keeps six places', () => {
  for (const [units, shown, fixed] of [
    ['0', '0', '0.000000'], ['1', '0.000001', '0.000001'], ['1500000', '1.5', '1.500000'],
    ['2000000', '2', '2.000000'], ['10000000', '10', '10.000000'], ['100000000', '100', '100.000000'],
    ['1100000', '1.1', '1.100000'], ['9007199254740993', '9007199254.740993', '9007199254.740993'],
    ['108000000000000000000', '108000000000000', '108000000000000.000000'],
  ]) {
    assert.equal(displayNativeUnits(units), shown, units);
    // The encoding used by Trade terms, prices, refunds and their digests is unchanged.
    assert.equal(formatNativeUnits(units), fixed, units);
    // Display text still parses back to the exact same units.
    if (units !== '0') assert.equal(nativeUnitsFromDecimal(shown), units);
  }
  for (const invalid of [0, '01', '-1', '1.0']) assert.throws(() => displayNativeUnits(invalid));
});

test('a pinned fresh active native snapshot exposes only coin balance, never reputation credits', async (t) => {
  const who = identity(),
    { adapter, config } = await adapterFixture(t, who, snapshot(who));
  const account = await adapter.account(who.address, who.publicKey);
  assert.equal(account.native.status, 'ready');
  assert.equal(account.native.verified, true);
  assert.equal(account.nativeRegistration, 'verified');
  assert.equal(account.balance, '9007199254.740993');
  assert.equal(account.native.balanceUnits, '9007199254740993');
  assert.equal(account.native.proof.authority, 'native');
  assert.equal(account.native.proof.epoch, config.genesisHash);
  assert.equal(account.native.proof.chainId, 'isolated-native-fixture');
  assert.equal(account.native.proof.maxAgeSeconds, 120);
  assert.equal(account.settlement.available, false);
  assert.equal(account.settlement.code, 'settlement_adapter_unavailable');
});

test('only proven absence under an active asset and matching active licence is a zero balance', async (t) => {
  const who = identity(),
    active = snapshot(who);
  active.records[`coin_balance/${who.address}`] = null;
  const valid = await adapterFixture(t, who, active);
  assert.equal(
    (await valid.adapter.account(who.address, who.publicKey)).balance,
    '0',
  );
  const inactive = snapshot(who);
  inactive.records.coin_activation = null;
  inactive.records.coin_supply = null;
  inactive.records[`coin_balance/${who.address}`] = null;
  const absent = await adapterFixture(t, who, inactive);
  const account = await absent.adapter.account(who.address, who.publicKey);
  assert.equal(account.native.status, 'asset_inactive');
  assert.equal(account.native.verified, true);
  assert.equal(account.balance, null);
  assert.equal(account.native.balanceUnits, null);
  assert.equal(account.settlement.code, 'asset_inactive');
});

test('proof outages, stale or wrong-epoch snapshots and mismatched keys never expose balances', async (t) => {
  const who = identity();
  const none = await createNativeAssetAdapter().account(
    who.address,
    who.publicKey,
  );
  assert.equal(none.balance, null);
  assert.equal(none.native.status, 'proof_unavailable');
  for (const patch of [
    { chain_id: 'other-epoch' },
    { epoch: 'f'.repeat(64) },
    { header_time: '2020-01-01T00:00:00Z' },
    {
      member: {
        id: who.address,
        public_key: identity().nativeKey,
        licence: 'active',
      },
    },
  ]) {
    const { adapter } = await adapterFixture(t, who, snapshot(who, patch));
    const result = await adapter.account(who.address, who.publicKey);
    assert.equal(result.balance, null);
    assert.equal(result.native.status, 'proof_unavailable');
    assert.equal(result.native.verified, false);
  }
  const pinned = await adapterFixture(t, who, snapshot(who));
  await writeFile(pinned.binary, 'changed');
  assert.equal(
    (await pinned.adapter.account(who.address, who.publicKey)).native.status,
    'proof_unavailable',
  );
});

test('pending/revoked native licences and genuinely absent native members remain explicit', async (t) => {
  const who = identity();
  for (const [licence, status] of [
    ['pending', 'licence_pending'],
    ['revoked', 'licence_inactive'],
  ]) {
    const state = snapshot(who);
    state.member.licence = licence;
    const { adapter } = await adapterFixture(t, who, state);
    const result = await adapter.account(who.address, who.publicKey);
    assert.equal(result.balance, null);
    assert.equal(result.native.status, status);
    assert.equal(result.native.verified, true);
  }
  const { adapter } = await adapterFixture(
    t,
    who,
    snapshot(who, { member: null }),
  );
  const absent = await adapter.account(who.address, who.publicKey);
  assert.equal(absent.native.status, 'member_missing');
  assert.equal(absent.nativeRegistration, 'missing');
  assert.equal(absent.balance, null);
  assert.equal(absent.native.verified, true);
});

test('unknown financial policy and invalid supply conservation cannot qualify an AI$ account', async (t) => {
  const who = identity();
  const unknown = snapshot(who);
  unknown.records.coin_activation.policy = 'unreviewed-new-asset';
  const a = await adapterFixture(t, who, unknown);
  assert.equal(
    (await a.adapter.account(who.address, who.publicKey)).native.status,
    'policy_mismatch',
  );
  const bad = snapshot(who);
  bad.records.coin_supply.transparent = '1';
  const b = await adapterFixture(t, who, bad);
  const result = await b.adapter.account(who.address, who.publicKey);
  assert.equal(result.balance, null);
  assert.equal(result.native.status, 'proof_unavailable');
});


test('a third concurrent native proof waits for a slot while actual process concurrency remains two', async t=>{
 const who=identity(),f=await adapterFixture(t,who,snapshot(who),{timeoutMs:2000},{delayMs:120,trace:true});
 const results=await Promise.allSettled(Array.from({length:3},()=>f.adapter.publicState({keys:[]})));
 assert.ok(results.every(r=>r.status==='fulfilled'),JSON.stringify(results.map(r=>r.status==='rejected'?String(r.reason):r.status)));
 const events=(await readFile(f.trace,'utf8')).trim().split('\n').map(JSON.parse);let active=0,maximum=0;for(const event of events){active+=event.event==='start'?1:-1;maximum=Math.max(maximum,active);assert.ok(active>=0);}assert.equal(maximum,2);assert.equal(active,0);assert.equal(events.filter(e=>e.event==='start').length,3);
});
test('native proof waiting capacity is bounded and a full queue does not spawn another reader',async t=>{
 const who=identity(),f=await adapterFixture(t,who,snapshot(who),{timeoutMs:3000},{delayMs:100,trace:true});
 const admitted=Array.from({length:6},()=>f.adapter.publicState({keys:[]}));
 await assert.rejects(f.adapter.publicState({keys:[]}),/capacity/);await Promise.all(admitted);
 const events=(await readFile(f.trace,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(events.filter(e=>e.event==='start').length,6);let active=0;for(const e of events){active+=e.event==='start'?1:-1;assert.ok(active<=2&&active>=0);}assert.equal(active,0);
});
test('a queued proof retains its original deadline, is removed on timeout and cannot leak reader capacity',async t=>{
 const who=identity(),f=await adapterFixture(t,who,snapshot(who),{timeoutMs:2000},{delayMs:140,trace:true});
 const active=[f.adapter.publicState({keys:[]}),f.adapter.publicState({keys:[]})];
 await assert.rejects(f.adapter.publicState({keys:[]},{timeoutMs:40}),/timed out|aborted/i);await Promise.all(active);await f.adapter.publicState({keys:[]});
 const events=(await readFile(f.trace,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(events.filter(e=>e.event==='start').length,3,'Timed-out waiting requests never start a child process');
});

test('internal readonly verifier transport preserves local artifact pins and normal proof projection',async t=>{const who=identity(),state=snapshot(who),f=await adapterFixture(t,who,state,{}, {trace:true}),calls=[];let closed=0;const transport={profile:{chainId:f.config.chainId,genesisSha256:f.config.genesisHash,verifierSha256:f.config.binaryHash,maxAgeSeconds:120},read:async(selection,{signal})=>{calls.push(selection);assert.equal(signal.aborted,false);return Buffer.from(JSON.stringify(state));},close:async()=>{closed++;}};const a=createNativeAssetAdapter({config:f.config,stateTransport:transport}),value=await a.asset();assert.equal(value.native.verified,true);assert.equal(value.native.proof.verifierSha256,f.config.binaryHash);assert.deepEqual(calls,[{keys:['coin_activation','coin_supply','private_activation']}]);await assert.rejects(readFile(f.trace),/ENOENT/);await a.close();assert.equal(closed,1);await writeFile(f.binary,'changed');const b=createNativeAssetAdapter({config:f.config,stateTransport:transport});assert.equal((await b.asset()).native.verified,false);assert.equal(calls.length,1);});
test('readonly transport cannot override selected member, records, chain, header or output size validation',async t=>{const who=identity(),f=await adapterFixture(t,who,snapshot(who)),profile={chainId:f.config.chainId,genesisSha256:f.config.genesisHash,verifierSha256:f.config.binaryHash,maxAgeSeconds:120};for(const patch of [{chain_id:'wrong'},{height:'0'},{app_hash:'bad'},{header_time:new Date(Date.now()-121000).toISOString()},{member:{id:'uain1'+'0'.repeat(40)}},{records:{}}]){const a=createNativeAssetAdapter({config:f.config,stateTransport:{profile,read:async()=>Buffer.from(JSON.stringify(snapshot(who,patch))),close:async()=>{}}});await assert.rejects(a.publicState({member:who.address,keys:['coin_supply']}));}const a=createNativeAssetAdapter({config:f.config,stateTransport:{profile,read:async()=>Buffer.alloc(2*1024*1024+1),close:async()=>{}}});await assert.rejects(a.publicState({keys:[]}),/remote native proof output/);assert.throws(()=>createNativeAssetAdapter({config:{...f.config,maxAgeSeconds:60},stateTransport:{profile,read:async()=>{},close:async()=>{}}}),/transport profile/);});
test('internal readonly transport stays inside original abort deadline',async t=>{const who=identity(),f=await adapterFixture(t,who,snapshot(who),{timeoutMs:100});let aborted=false;const a=createNativeAssetAdapter({config:f.config,stateTransport:{profile:{chainId:f.config.chainId,genesisSha256:f.config.genesisHash,verifierSha256:f.config.binaryHash,maxAgeSeconds:120},read:(_selection,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('cancelled'));},{once:true})),close:async()=>{}}});const start=Date.now();assert.equal((await a.asset()).native.verified,false);assert.equal(aborted,true);assert.ok(Date.now()-start<1000);});

test('opt-in account batches reuse individual semantic proofs and exact per-owner key/balance checks',async t=>{
 const people=Array.from({length:60},()=>identity()),f=await adapterFixture(t,people[0],snapshot(people[0])),lookup=new Map(people.map((p,i)=>[p.address,{who:p,missing:i%2===1}])),calls=[];
 const profile={chainId:f.config.chainId,genesisSha256:f.config.genesisHash,verifierSha256:f.config.binaryHash,maxAgeSeconds:120};
 const transport={profile,read:async()=>{throw Error('unbatched path must not execute');},readBatch:async members=>{calls.push([...members]);const results=members.map(member=>{const{who,missing}=lookup.get(member),state=snapshot(who);state.records['member/'+member]=missing?null:state.member;if(missing){delete state.member;state.records['coin_balance/'+member]=null;}return{member,mode:missing?'absence':'member',state};});return Buffer.from(JSON.stringify({schema:'baink-native-public-state-batch-v1',requestDigest:sha(JSON.stringify({members})),results}));},close:async()=>{}};
 const adapter=createNativeAssetAdapter({config:f.config,stateTransport:transport,accountBatchingEnabled:true}),values=await Promise.all(people.map(p=>adapter.account(p.address,p.publicKey)));assert.equal(calls.length,3);assert.ok(calls.every(c=>c.length<=25));for(let i=0;i<values.length;i++){assert.equal(values[i].native.verified,true);assert.equal(values[i].native.memberStatus,i%2?'missing':'active');assert.equal(values[i].native.balanceUnits,i%2?null:'9007199254740993');}assert.equal((await adapter.account(people[0].address,people[1].publicKey)).native.verified,false);assert.equal(calls.length,3);await adapter.close();
});
test('batch request/order/member/absence/freshness tampering refuses verified account results',async t=>{
 const who=identity(),f=await adapterFixture(t,who,snapshot(who)),profile={chainId:f.config.chainId,genesisSha256:f.config.genesisHash,verifierSha256:f.config.binaryHash,maxAgeSeconds:120};
 for(const corrupt of ['digest','member','mode','stale','absent-member']){const transport={profile,read:async()=>{throw Error('no legacy fallback');},readBatch:async members=>{const state=snapshot(who);state.records['member/'+who.address]=state.member;let result={member:who.address,mode:'member',state};if(corrupt==='member')result.member='uain1'+'0'.repeat(40);if(corrupt==='mode')result.mode='arbitrary';if(corrupt==='stale')state.header_time=new Date(Date.now()-121000).toISOString();if(corrupt==='absent-member'){result.mode='absence';delete state.member;}return Buffer.from(JSON.stringify({schema:'baink-native-public-state-batch-v1',requestDigest:corrupt==='digest'?'0'.repeat(64):sha(JSON.stringify({members})),results:[result]}));},close:async()=>{}};const adapter=createNativeAssetAdapter({config:f.config,stateTransport:transport,accountBatchingEnabled:true});assert.equal((await adapter.account(who.address,who.publicKey)).native.verified,false,corrupt);await adapter.close();}
});

test('two-member batch results cannot be swapped and an unavailable neighbor cannot hide a valid proof',async t=>{const people=[identity(),identity()],f=await adapterFixture(t,people[0],snapshot(people[0])),profile={chainId:f.config.chainId,genesisSha256:f.config.genesisHash,verifierSha256:f.config.binaryHash,maxAgeSeconds:120};for(const mode of['swapped','partial']){const transport={profile,read:async()=>{throw Error('no unbatched fallback');},readBatch:async members=>{const results=members.map((member,i)=>{if(mode==='partial'&&i===0)return{member,mode:'unavailable'};const state=snapshot(people[i]);state.records['member/'+member]=state.member;return{member,mode:'member',state};});if(mode==='swapped')results.reverse();return Buffer.from(JSON.stringify({schema:'baink-native-public-state-batch-v1',requestDigest:sha(JSON.stringify({members})),results}));},close:async()=>{}};const adapter=createNativeAssetAdapter({config:f.config,stateTransport:transport,accountBatchingEnabled:true}),results=await Promise.all(people.map(p=>adapter.account(p.address,p.publicKey)));assert.equal(results[0].native.verified,false);assert.equal(results[1].native.verified,mode==='partial');if(mode==='partial')assert.equal(results[1].native.balanceUnits,'9007199254740993');await adapter.close();}});
test('shared artifact hash work never shares two owners native record responses',async t=>{const people=[identity(),identity()],f=await adapterFixture(t,people[0],snapshot(people[0])),calls=[];const a=createNativeAssetAdapter({config:f.config,stateTransport:{profile:{chainId:f.config.chainId,genesisSha256:f.config.genesisHash,verifierSha256:f.config.binaryHash,maxAgeSeconds:120},read:async selection=>{calls.push(structuredClone(selection));const who=people.find(p=>p.address===selection.member);return Buffer.from(JSON.stringify(snapshot(who)));},close:async()=>{}}});const results=await Promise.all(people.map(who=>a.publicState({member:who.address,keys:['coin_balance/'+who.address]})));assert.equal(calls.length,2);for(let i=0;i<2;i++){assert.equal(results[i].state.member.id,people[i].address);assert.equal(results[i].state.member.public_key,people[i].nativeKey);assert.equal(results[i].state.records['coin_balance/'+people[1-i].address],undefined);}await a.close();});


test('reader connection refusal is typed with bounded safe diagnostics; unknown/proof failures stay fatal',async t=>{
 for(const [stderr,expected] of [
  ['post failed: Post "http://127.0.0.1:26657": dial tcp 127.0.0.1:26657: connect: connection refused\n','rpc_connection_refused'],
  ['invalid validator signature; secret@example.invalid\n','reader_refused'],
  ['invalid signature: Post "http://secret.invalid": dial tcp 127.0.0.1:1: connect: connection refused\n','reader_refused'],
  ['invalid proof\nPost "http://secret.invalid": dial tcp 127.0.0.1:1: connect: connection refused\n','reader_refused'],
  ['x'.repeat(5000)+'Post "http://secret.invalid": dial tcp 127.0.0.1:1: connect: connection refused\n','reader_refused'],
 ]){
  const who=identity(),f=await adapterFixture(t,who,snapshot(who),{}, {stderr});
  await assert.rejects(f.adapter.publicState({keys:[]}),error=>{
   assert.equal(error.name,'NativeReaderError');assert.equal(error.category,expected);
   assert.equal(error.retryable,expected==='rpc_connection_refused');assert.equal(error.exitCode,1);
   assert.equal(error.message,'Pinned native proof reader refused the selection');
   assert.ok(!JSON.stringify(error).includes('secret'));assert.ok(JSON.stringify(error).length<400);return true;
  });
 }
});

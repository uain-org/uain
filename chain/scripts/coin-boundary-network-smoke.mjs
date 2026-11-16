#!/usr/bin/env node
// Disposable two-node acceptance only. Never enroll fixture identities or
// activate a policy on an existing node. Only fictional fixture keys are used.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, chown } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { exerciseCoinWalletFlow } from './coin-wallet-flow.mjs';
import { fixturePrivateAction as runPrivateAction } from './private-client-process.mjs';
import { readPrivateState } from '../client/private-state.mjs';
import { lightScan, ownedNotes } from '../client/note-scan.mjs';
import { signedEnvelope } from '../client/signing.mjs';
import { startGateway } from '../../ops/chain/private-rpc-gateway.mjs';

const [daemonArgument, proofArgument, readerArgument, coinWalletArgument, privateWalletArgument] = process.argv.slice(2);
assert.ok(daemonArgument && proofArgument && readerArgument && coinWalletArgument && privateWalletArgument, 'linked fixture daemon and public proof verifier required');
const daemon = resolve(daemonArgument), verifier = resolve(proofArgument);
const readerBinary=resolve(readerArgument), coinWallet=resolve(coinWalletArgument), privateWallet=resolve(privateWalletArgument);
const root = await mkdtemp(join(tmpdir(), 'uain-coin-boundary-network-fixture-'));
const ports = [Number(process.env.UAIN_COIN_BOUNDARY_SMOKE_PORT ?? 34657), Number(process.env.UAIN_COIN_BOUNDARY_SMOKE_PORT ?? 34657) + 10];
assert.ok(ports.every(port => Number.isInteger(port) && port > 1024 && port < 65535));
const localNodeTest = !!process.env.UAIN_PRIVATE_FIXTURE_RPC;
if (localNodeTest) ports.push(ports[0]+20);
const homes = ports.map((_,i)=>join(root,`node-${i}`));
const running = new Set(), started = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function identity(name, karma = 0) {
  const keys = generateKeyPairSync('ed25519');
  const raw = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { ...keys, member: { id: `uain1${createHash('sha256').update(raw).digest('hex').slice(0, 40)}`, public_key: raw.toString('base64url'), name, operator: name, family: name, licence: 'active', karma, credits: '0', sequence: '0', default_verifier: false, creator: false, active_projects: 0 } };
}
const guardian = identity('fictional-guardian'), relay = identity('fictional-relay');
const sender = identity('fictional-sender', 1000), recipient = identity('fictional-recipient', 100);
sender.member.creator = true; guardian.member.default_verifier = true;
const reviewer = identity('fictional-reviewer', 100);
async function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(daemon, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
    child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
    child.once('error', reject); child.once('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(output)));
  });
}
function start(home) {
  const child = spawn(daemon, ['start', '--home', home], { stdio: ['ignore', 'pipe', 'pipe'] }); let log = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log = (log + bytes).slice(-16000); });
  child.diagnostics = () => log; running.add(child); started.push(child); child.once('exit', () => running.delete(child)); return child;
}
async function stop(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('fixture node did not stop cleanly')); }, 15000);
    child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
  });
}
async function rpc(port, method, params = {}) {
  const response = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(method.startsWith('broadcast_tx_') ? 15000 : 3000) });
  const data = await response.json(); if (data.error) throw new Error(JSON.stringify(data.error)); return data.result;
}
async function waitFor(fn, child) {
  let last;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(child.diagnostics());
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await pause(500);
  }
  throw new Error(`fixture wait failed: ${last?.message}\n${child.diagnostics()}`);
}
const sequences = new Map();
let privateClientReader, relayGateway, broadcast, peerTunnel, walletNode, auditServer, lightServer;
// UAIN_LIGHT_WALLET_SMOKE=1: the whole wallet flow runs in remote-verified
// light mode against an untrusted, logging "remote node" proxy.
const lightWallet = process.env.UAIN_LIGHT_WALLET_SMOKE === '1', lightQueries = [], lightBytes = { total: 0 };
const gatewayMethods=[];
const submissionJournals=[];
async function submit(operation, payload, actor = guardian, expected = true, prepared) {
  const sequence = sequences.get(actor.member.id) ?? 0;
  const command = { version: 1, chain_id: 'uain-coin-fixture-1', member: actor.member.id, sequence: String(sequence), expires_height: payload.approval?.expires_height ?? '1000', operation, payload };
  if (prepared) assert.deepEqual(prepared.command, command);
  const transaction = prepared ?? signedEnvelope(command, Buffer.from(actor.member.public_key, 'base64url'), actor.privateKey);
  let result;
  if (prepared && expected) {
    const envelopeFile=join(root,operation+'-'+sequence+'-submission.json'), journalFile=envelopeFile+'.journal';
    await writeFile(envelopeFile,JSON.stringify(prepared),{mode:0o600,flag:'wx'});
    const ack=await runPrivateAction('submit',{reader:privateClientReader,broadcast:operation==='private_payment'?broadcast:{rpc:`http://127.0.0.1:${ports[0]}`},envelopeFile,out:journalFile});assert.equal(ack.status,'submitted');
    submissionJournals.push(journalFile);
    const confirmed=await waitFor(async()=>{const state=await runPrivateAction('status',{reader:privateClientReader,journalFile});return state.status==='recorded'?state:null;},[...running][0]);
    assert.equal(confirmed.state_proof_verified,true);assert.equal(confirmed.transaction_inclusion_verified,false);
    result={check_tx:{code:0},tx_result:{code:0,log:'Authenticated persisted ciphertext record'},height:confirmed.height};
  } else result = await rpc(ports[0], expected ? 'broadcast_tx_commit' : 'broadcast_tx_sync', { tx: Buffer.from(JSON.stringify(transaction)).toString('base64') });
  if (!expected) { assert.notEqual(result.code, 0, `${operation} incorrectly accepted`); return; }
  assert.equal(result.check_tx.code, 0, result.check_tx.log); assert.equal(result.tx_result.code, 0, result.tx_result.log);
  sequences.set(actor.member.id, sequence + 1);
  if (['coin_shield','coin_exit','private_payment','private_reviewer'].includes(operation)) for(let i=0;i<20 && Number((await rpc(ports[0],'status')).sync_info.latest_block_height)<=Number(result.height)+1;i++) await pause(300);
  return Number(result.height);
}
async function record(port, key, height = '0', prove = false) {
  const response = (await rpc(port, 'abci_query', { path: '/store/federation/key', data: Buffer.from(key).toString('hex'), height: String(height), prove })).response;
  assert.equal(response.code, 0); return response;
}
async function verifyPublic(genesisFile, bundleFile, key) {
  return new Promise((resolve, reject) => {
    const child = spawn(verifier, ['--genesis', genesisFile, '--bundle', bundleFile, '--key', key], { stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output += bytes; });
    child.once('error', reject); child.once('close', code => code === 0 && output.includes('STATE_PROOF_VERIFIED') ? resolve() : reject(new Error(output)));
  });
}
try {
  const applicationGenesis = join(root, 'app-genesis.json');
  await writeFile(applicationGenesis, JSON.stringify({ version: 1, guardians: [guardian.member.id], members: [guardian, relay, sender, recipient, reviewer].map(identity => identity.member) }), { mode: 0o600 });
  for (let i = 0; i < homes.length; i++) await run(['init', '--home', homes[i], '--chain-id', 'uain-coin-fixture-1', '--app-genesis', applicationGenesis, '--rpc', `tcp://127.0.0.1:${ports[i]}`, '--p2p', `tcp://127.0.0.1:${ports[i] - 1}`]);
  const genesisFile = join(homes[0], 'config/genesis.json'); const genesis = await readFile(genesisFile);
  await writeFile(join(homes[1], 'config/genesis.json'), genesis);
  const nodeID = (await run(['node-id', '--home', homes[0]])).split(/\r?\n/).find(line => /^[0-9a-f]{40}$/.test(line)); assert.ok(nodeID);
  const configuration = join(homes[1], 'config/config.toml'); let text = await readFile(configuration, 'utf8');
  text = text.replace(/^persistent_peers = .*$/m, `persistent_peers = "${nodeID}@127.0.0.1:${ports[0] - 1}"`).replace(/^addr_book_strict = .*$/m, 'addr_book_strict = false').replace(/^allow_duplicate_ip = .*$/m, 'allow_duplicate_ip = true'); await writeFile(configuration, text);
  if(localNodeTest){const config=join(homes[0],'config/config.toml');await writeFile(config,(await readFile(config,'utf8')).replace(/^allow_duplicate_ip = .*$/m,'allow_duplicate_ip = true'));}
  let primary = start(homes[0]), fullnode = start(homes[1]);
  if (localNodeTest) {
    assert.ok(process.env.UAIN_PEER_TUNNEL_BIN,'qualified Tor peer tunnel required');
    await writeFile(join(homes[2],'config/genesis.json'),genesis);
    const bridgePort=ports[0]+30;
    let config=await readFile(join(homes[2],'config/config.toml'),'utf8');
    for(const [key,value] of Object.entries({persistent_peers:`"${nodeID}@127.0.0.1:${bridgePort}"`,pex:'false',addr_book_strict:'false',allow_duplicate_ip:'true',max_num_inbound_peers:'0',max_num_outbound_peers:'1',external_address:'""',seeds:'""'}))config=config.replace(new RegExp('^'+key+' = .*$','m'),key+' = '+value);
    await writeFile(join(homes[2],'config/config.toml'),config);
    const endpoint=new URL(process.env.UAIN_PRIVATE_FIXTURE_RPC);
    peerTunnel=spawn(process.env.UAIN_PEER_TUNNEL_BIN,['--listen',`127.0.0.1:${bridgePort}`,'--socks-proxy',process.env.UAIN_PRIVATE_FIXTURE_SOCKS,'--peer',`${endpoint.hostname}:26656`],{stdio:['ignore','pipe','pipe']});
    let log='';for(const stream of [peerTunnel.stdout,peerTunnel.stderr])stream.on('data',bytes=>{log=(log+bytes).slice(-4096)});
    peerTunnel.diagnostics=()=>log;running.add(peerTunnel);started.push(peerTunnel);peerTunnel.once('exit',()=>running.delete(peerTunnel));
    walletNode=start(homes[2]);
  }
  await waitFor(async () => Number((await rpc(ports[0], 'status')).sync_info.latest_block_height) >= 3, primary);
  const evidence = '28'.repeat(32);
  const compact = await submit('activate_storage', { policy: 'compact-state-v1', evidence_digest: evidence });
  await waitFor(async () => Number((await rpc(ports[0], 'status')).sync_info.latest_block_height) > compact + 1, primary);
  await submit('activate_membership', { policy: 'project-membership-v1', evidence_digest: evidence });
  await submit('activate_operator_rewards', { policy: 'pairwise-operator-rewards-v1', evidence_digest: evidence });
  await submit('activate_private_exchange', { policy: 'orchard-v2-reviewed-otc-v1', evidence_digest: evidence, relayer: relay.member.id });
  for (const [i, actor] of [sender, recipient, guardian].entries()) {
    await submit('identity_claim', {}, actor);
    await submit('operator_claim', { domain: `coin-${i}.example` }, actor);
    const claim = JSON.parse(Buffer.from((await record(ports[0], `operator_claim/${actor.member.id}/`)).value, 'base64'));
    await submit('operator_attest', { member: actor.member.id, domain: claim.domain, claim_event_id: claim.event_id, txt: `uain-operator=${claim.did}`, checked_at: new Date().toISOString(), evidence_digest: evidence });
  }
  const activation = await submit('activate_coin', { policy: 'verified-bounties-108t-micro-v1', evidence_digest: evidence });
  await waitFor(async () => Number((await rpc(ports[0], 'status')).sync_info.latest_block_height) > activation + 1, primary);
  const priorArt = { basis: 'No discoverable answer exists for this fictional disposable qualification problem.', searches: ['first fictional prior-art search', 'second fictional prior-art search'] };
  await submit('open_project', { id: 'P-coin', title: 'Fictional native Coin qualification', class: 'benevolent', prior_art: priorArt }, sender);
  for (const actor of [recipient, guardian]) await submit('project_join', { project: 'P-coin' }, actor);
  await submit('open_task', { id: 'T-coin', project: 'P-coin', title: 'Fictional prospective native bounty', class: 'benevolent', prior_art: priorArt, criteria: 'Check the fictional result independently and confirm its previously unknown answer.', kind: 'instant', karma_reward: 13, credit_reward: '13', verifiers_required: 2 }, sender);
  const openEvent = JSON.parse(Buffer.from((await record(ports[0], 'event_count')).value, 'base64'));
  await submit('coin_quote', { task: 'T-coin', open_event: String(openEvent).padStart(20, '0'), amount: '5000000', evidence_digest: evidence }, sender);
  await submit('coin_reserve', { task: 'T-coin', evidence_digest: evidence });
  await submit('submit', { id: 'RC-coin', task: 'T-coin', evidence_digest: evidence }, sender);
  await submit('coin_claim', { contribution: 'RC-coin' }, sender, false);
  const check = { contribution: 'RC-coin', verdict: 'confirm', novelty: 'new', searches: priorArt.searches, evidence_digest: evidence };
  await submit('verify', check, recipient); await submit('verify', check);
  const claimHeight = await submit('coin_claim', { contribution: 'RC-coin' }, sender);
  const keys = ['coin_activation', 'coin_supply', `coin_balance/${sender.member.id}`, 'coin_quote/T-coin', 'coin_reservation/T-coin', 'coin_reward/RC-coin'];
  for(let i=1;i<ports.length;i++)await waitFor(async()=>Number((await rpc(ports[i],'status')).sync_info.latest_block_height)>claimHeight+2,i===1?fullnode:walletNode);
  let height = claimHeight + 1;
  const values = new Map(); const proofChecks = [];
  for (const port of ports) {
    const commit = await rpc(port, 'commit', { height: String(height + 1) });
    for (const [i, key] of keys.entries()) {
      const query = await record(port, key, height, true);
      if (values.has(key)) assert.equal(query.value, values.get(key)); else values.set(key, query.value);
      const file = join(root, `proof-${port}-${i}.json`);
      await writeFile(file, JSON.stringify({ signed_header: commit.signed_header, query }));
      await verifyPublic(genesisFile, file, key); proofChecks.push({ port, key, verified: true });
    }
  }
  assert.deepEqual(JSON.parse(Buffer.from(values.get('coin_supply'), 'base64')), { minted: '5000000', reserved: '0', transparent: '5000000', shielded: '0' });
  assert.equal(JSON.parse(Buffer.from(values.get(`coin_balance/${sender.member.id}`), 'base64')), '5000000');
  await submit('coin_claim', { contribution: 'RC-coin' }, sender, false);
  await submit('private_reviewer',{member:reviewer.member.id,active:true,evidence_digest:evidence});
  const reader={executable:readerBinary,executableSha256:createHash('sha256').update(await readFile(readerBinary)).digest('hex'),genesis:genesisFile,genesisSha256:createHash('sha256').update(genesis).digest('hex'),rpc:`http://127.0.0.1:${ports[0]}`,maxAgeSeconds:120};
  if (localNodeTest) {
    assert.ok(process.env.UAIN_PRIVATE_FIXTURE_SOCKS && process.env.UAIN_PRIVATE_FIXTURE_SOCKET, 'explicit Tor fixture transport required');
    const upstream=reader.rpc;
    auditServer=createServer(async(req,res)=>{
      try {const parts=[];for await(const part of req)parts.push(part);const bytes=Buffer.concat(parts);gatewayMethods.push(JSON.parse(bytes).method);const result=await fetch(upstream,{method:'POST',headers:{'content-type':'application/json'},body:bytes,signal:AbortSignal.timeout(15000)});res.writeHead(result.status,{'content-type':'application/json'});res.end(Buffer.from(await result.arrayBuffer()));}
      catch {res.writeHead(502);res.end();}
    });
    await new Promise(resolve=>auditServer.listen(0,'127.0.0.1',resolve));
    relayGateway=await startGateway({socket:process.env.UAIN_PRIVATE_FIXTURE_SOCKET,upstream:`http://127.0.0.1:${auditServer.address().port}`,allowBroadcast:true});
    if(process.env.UAIN_PRIVATE_FIXTURE_SOCKET_GID)await chown(process.env.UAIN_PRIVATE_FIXTURE_SOCKET,process.getuid(),Number(process.env.UAIN_PRIVATE_FIXTURE_SOCKET_GID));
    broadcast={rpc:process.env.UAIN_PRIVATE_FIXTURE_RPC,socksProxy:process.env.UAIN_PRIVATE_FIXTURE_SOCKS};
    const readyHeight=Number((await rpc(ports[0],'status')).sync_info.latest_block_height);
    await waitFor(async()=>Number((await rpc(ports[2],'status')).sync_info.latest_block_height)>=readyHeight,walletNode);
    const peers=await rpc(ports[2],'net_info');assert.equal(peers.peers.length,1);assert.equal(peers.peers[0].node_info.id,nodeID);
    reader.rpc=`http://127.0.0.1:${ports[2]}`;
    await assert.rejects(runPrivateAction('state',{reader:{...reader,...broadcast,request:{reviewer:reviewer.member.id,parties:[sender.member.id,recipient.member.id]}},out:join(root,'hosted-state-refused')}),/own loopback full node|installed private client action refused/);
  }
  if (lightWallet) {
    assert.ok(!localNodeTest && process.env.UAIN_NOTE_SOURCE_BIN, 'light wallet smoke needs the note tool and no holder node');
    const upstream=reader.rpc;
    lightServer=createServer(async(req,res)=>{
      try {const parts=[];for await(const part of req)parts.push(part);const bytes=Buffer.concat(parts),body=JSON.parse(bytes);if(body.method==='abci_query')lightQueries.push(body.params.path+' '+Buffer.from(body.params.data,'hex').toString('utf8'));const result=await fetch(upstream,{method:'POST',headers:{'content-type':'application/json'},body:bytes,signal:AbortSignal.timeout(15000)});const out=Buffer.from(await result.arrayBuffer());lightBytes.total+=out.length;res.writeHead(result.status,{'content-type':'application/json'});res.end(out);}
      catch {res.writeHead(502);res.end();}
    });
    await new Promise(resolve=>lightServer.listen(0,'127.0.0.1',resolve));
    reader.rpc=`http://127.0.0.1:${lightServer.address().port}`;reader.remoteVerified=true;
  }
  privateClientReader=reader;
  const flow=await exerciseCoinWalletFlow({root,reader,coinWallet,privateWallet,sender,recipient,reviewer,relay,submit});
  keys.push(...flow.proven_records.filter(key=>!keys.includes(key)));values.clear();
  height=Number((await rpc(ports[0],'status')).sync_info.latest_block_height);
  for(let i=1;i<ports.length;i++)await waitFor(async()=>Number((await rpc(ports[i],'status')).sync_info.latest_block_height)>height+1,i===1?fullnode:walletNode);
  for(const port of ports) {
    const commit=await rpc(port,'commit',{height:String(height+1)});
    for(const [i,key] of keys.entries()) {
      const query=await record(port,key,height,true);
      if(values.has(key)) assert.equal(query.value,values.get(key));else values.set(key,query.value);
      const file=join(root,`bridge-proof-${port}-${i}.json`);await writeFile(file,JSON.stringify({signed_header:commit.signed_header,query}));await verifyPublic(genesisFile,file,key);proofChecks.push({port,key,verified:true,phase:'backed-private-exchange'});
    }
  }
  if(walletNode)await stop(walletNode);
  await stop(fullnode); await stop(primary); primary = start(homes[0]); fullnode = start(homes[1]);
  if(localNodeTest){walletNode=start(homes[2]);await waitFor(async()=>Number((await rpc(ports[2],'status')).sync_info.latest_block_height)>height+3,walletNode);}
  await waitFor(async () => Number((await rpc(ports[1], 'status')).sync_info.latest_block_height) > height + 3, fullnode);
  for (const port of ports) for (const key of keys) assert.equal((await record(port, key)).value, values.get(key));
  await submit('coin_claim', { contribution: 'RC-coin' }, sender, false);
  const compactRestart=await flow.read_compact_after_restart();assert.equal(compactRestart.notes_fetched,'0');assert.equal(compactRestart.count,'6');
  const final=await flow.read_after_restart();assert.equal(final.coin.balance,'26');assert.equal(final.coin.supply.shielded,'44');assert.equal(final.coin.supply.minted,'5000000');
  await submit('coin_exit',flow.exit,recipient,false);await submit('private_payment',flow.payment,relay,false);
  for(const journalFile of submissionJournals){const status=await runPrivateAction('status',{reader,journalFile});assert.equal(status.status,'recorded');assert.equal(status.state_proof_verified,true);assert.equal(status.proof_kind,'ciphertext_record');}
  const revokedHeight=await submit('private_reviewer',{member:reviewer.member.id,active:false,evidence_digest:evidence});
  // Revocation must prevent new approvals while preserving historical record
  // reconciliation, including after node restart. No old receipt is authority.
  await waitFor(async()=>{try{await readPrivateState({...reader,request:{policy_only:true,reviewer:reviewer.member.id}});return false;}catch(error){return error.message.includes('active proven reviewer appointment required');}},[...running][0]);
  for(const journalFile of submissionJournals){const status=await runPrivateAction('status',{reader,journalFile});assert.equal(status.status,'recorded');assert.equal(status.state_proof_verified,true);}
  if(walletNode){await stop(walletNode);walletNode=start(homes[2]);await waitFor(async()=>Number((await rpc(ports[2],'status')).sync_info.latest_block_height)>revokedHeight+1,walletNode);}
  else {await stop(fullnode);await stop(primary);primary=start(homes[0]);fullnode=start(homes[1]);await waitFor(async()=>Number((await rpc(ports[0],'status')).sync_info.latest_block_height)>height+5,primary);}
  for(const journalFile of submissionJournals){const status=await runPrivateAction('status',{reader,journalFile});assert.equal(status.status,'recorded');assert.equal(status.transaction_inclusion_verified,false);}
  const original=JSON.parse(await readFile(submissionJournals[1],'utf8'));
  const alteredCommand=structuredClone(original.envelope.command);const alteredBytes=Buffer.from(alteredCommand.payload.bundle,'base64url');alteredBytes[0]^=1;alteredCommand.payload.bundle=alteredBytes.toString('base64url');
  const alteredEnvelope=signedEnvelope(alteredCommand,Buffer.from(relay.member.public_key,'base64url'),relay.privateKey);
  const alteredJournal=join(root,'fictional-altered-journal.json');await writeFile(alteredJournal,JSON.stringify({envelope:alteredEnvelope,tx_hash:createHash('sha256').update(JSON.stringify(alteredEnvelope)).digest('hex').toUpperCase()}),{mode:0o600});
  assert.equal((await runPrivateAction('status',{reader,journalFile:alteredJournal})).status,'unknown');
  const wrongChainEnvelope=signedEnvelope({...original.envelope.command,chain_id:'uain-coin-wrong-chain'},Buffer.from(relay.member.public_key,'base64url'),relay.privateKey);
  const wrongChainJournal=join(root,'fictional-wrong-chain-journal.json');await writeFile(wrongChainJournal,JSON.stringify({envelope:wrongChainEnvelope,tx_hash:createHash('sha256').update(JSON.stringify(wrongChainEnvelope)).digest('hex').toUpperCase()}),{mode:0o600});
  assert.equal((await runPrivateAction('status',{reader,journalFile:wrongChainJournal})).status,'unknown');
  if(localNodeTest){assert.equal(gatewayMethods.length,1);assert.ok(gatewayMethods.every(method=>method==='broadcast_tx_sync'));}
  let lightReceipt=null;
  if (lightWallet) {
    const scanStart={queries:lightQueries.length,bytes:lightBytes.total,at:Date.now()};
    const scan=await lightScan(reader);
    const scanCost={abci_queries:lightQueries.length-scanStart.queries,response_bytes:lightBytes.total-scanStart.bytes,milliseconds:Date.now()-scanStart.at};
    assert.equal(scan.count,'6');assert.equal(scan.records.length,3);assert.equal(scan.nullifiers.length,6);
    const noteTool={executable:resolve(process.env.UAIN_NOTE_SOURCE_BIN),executableSha256:createHash('sha256').update(await readFile(process.env.UAIN_NOTE_SOURCE_BIN)).digest('hex')};
    // The flow names its key files: the recipient's active key is the one
    // restored into a clean profile (the original is set aside by the restore stage).
    const senderNotes=await ownedNotes({scan,noteTool,spendingKeyFile:flow.spending_key_files.sender});
    const recipientNotes=await ownedNotes({scan,noteTool,spendingKeyFile:flow.spending_key_files.recipient});
    assert.equal(senderNotes.balanceUnits,'44');assert.equal(recipientNotes.balanceUnits,'0');
    assert.ok(senderNotes.notes.some(n=>n.amountUnits==='70'&&n.spent)&&senderNotes.notes.some(n=>n.amountUnits==='44'&&!n.spent));
    assert.ok(recipientNotes.notes.some(n=>n.amountUnits==='26'&&n.spent));
    // The remote node saw only fixed public prefixes and whole-prefix proven
    // fetches: every member record was requested equally often. Since d7edfc96
    // (9 November) every read also follows signed validator-set changes from the
    // pinned genesis: validator_epoch_count and validator_epoch/<n>, global keys.
    const allowed=/^(private_activation|private_licence_revision|private_frontier|coin_activation|coin_supply|validator_epoch_count|validator_epoch\/[0-9]{20}|private_note\/[0-9]{7}|(member|private_reviewer|coin_balance)\/(uain1[0-9a-f]{0,40})?|(private_root|private_payment|private_boundary|private_nullifier)\/[0-9a-f]{0,64})$/;
    const memberFetches=new Map(),unexpected=new Set();
    for(const query of lightQueries){const [path,key]=query.split(' ');if(!allowed.test(key))unexpected.add(key);if(path==='/store/federation/key'&&/^member\/uain1[0-9a-f]{40}$/.test(key))memberFetches.set(key,(memberFetches.get(key)??0)+1);}
    assert.deepEqual([...unexpected],[],'the remote node saw only fixed public keys and prefixes');
    assert.equal(memberFetches.size,5);assert.equal(new Set(memberFetches.values()).size,1,'member records fetched unequally');
    lightReceipt={remote_verified_light_mode:true,full_flow_in_light_mode:['coin_shield','private_payment','coin_exit','status','revocation'],light_scan_records:scan.records.length,light_scan_nullifiers:scan.nullifiers.length,light_scan_notes:scan.count,sender_light_balance_units:senderNotes.balanceUnits,recipient_light_balance_units:recipientNotes.balanceUnits,member_records_fetched_equally:[...memberFetches.values()][0],remote_abci_queries:lightQueries.length,remote_response_bytes:lightBytes.total,one_light_scan:scanCost,last_scan_stats:scan.light};
  }
  const receipt = { light_wallet:lightReceipt, installed_signed_client_entry:!!process.env.UAIN_INSTALLED_PRIVATE_CLIENT, installed_client_entry_sha256:process.env.UAIN_INSTALLED_PRIVATE_CLIENT_SHA256??null, revoked_checker_record_reconciliation:true, revoked_checker_new_approval_refused:true, altered_signed_journal_refused:true, wrong_chain_signed_journal_refused:true, post_revocation_restart_record_reconciliation:true, holder_node_tor_sync:localNodeTest, hosted_selection_queries:localNodeTest?0:null, anonymous_gateway_methods:gatewayMethods, hosted_state_refused:localNodeTest, tor_onion_transport:!!relayGateway, pass: true, fixture_only: true, real_two_nodes: true, incremental_witness:flow.incremental_witness, compact_cache_verified_after_restart:true, chain_id: 'uain-coin-fixture-1', pinned_genesis_sha256: createHash('sha256').update(genesis).digest('hex'), prospective_signed_bounty_issuance: true, minted_units: '5000000', cap_units: '108000000000000000000', private_pool_units: '44', entry_units:'70', private_payment_units:'26', exit_units:'26', encrypted_checker_transport:true, pinned_reader_to_wallet_to_consensus:true, authenticated_absent_recipient_balance:true, signed_private_client_workflow:true, explicit_checker_decision:true, authenticated_owner_relay_envelopes:true, durable_cli_submission:true, transaction_index_not_required:true, post_restart_cli_record_reconciliation:true, early_claim_refused: true, replay_refused_before_and_after_restart: true, restart_preserved: true, independent_state_proofs: proofChecks, production_activated: false, production_coin_mint: false, fixture_directory: root };
  await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));

} catch (error) {
  for (let i = 0; i < started.length; i++) await writeFile(join(root, `daemon-${i}.log`), started[i].diagnostics()).catch(() => {});
  console.error(error); console.error(`Disposable fixture diagnostics: ${root}`); process.exitCode = 1;
} finally { if(lightServer)await new Promise(resolve=>lightServer.close(resolve)); if(auditServer)await new Promise(resolve=>auditServer.close(resolve)); if(relayGateway)await new Promise(resolve=>relayGateway.close(resolve)); for (const child of [...running]) await stop(child).catch(error => { console.error(error.message); process.exitCode = 1; }); }

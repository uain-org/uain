import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPrivateState, signApprovalFromPrivateState, assertPrivateStateContext } from './private-state.mjs';
import { createHash } from 'node:crypto';
import { privatePurposeCommitment } from './private-review.mjs';
test('purpose binds exact private terms and a canonical salt', () => {
  const agreement = { text: 'Fictional neutral compute service: seventeen test units.', salt: '12'.repeat(32) };
  const hash = privatePurposeCommitment(agreement);
  assert.equal(hash, privatePurposeCommitment({ ...agreement }));
  assert.notEqual(hash, privatePurposeCommitment({ ...agreement, text: `${agreement.text} changed` }));
  assert.notEqual(hash, privatePurposeCommitment({ ...agreement, salt: '13'.repeat(32) }));
  assert.throws(() => privatePurposeCommitment({ ...agreement, text: '\ud800' }), /invalid private agreement/);
  assert.throws(() => privatePurposeCommitment({ ...agreement, text: 'x'.repeat(65537) }), /too large/);
  assert.throws(() => privatePurposeCommitment({ ...agreement, salt: 'AB'.repeat(32) }), /invalid private context/);
});
test('unverified or serialized indexer state cannot authorize a private approval', () => {
  assert.throws(() => signApprovalFromPrivateState({ state: { chain_id: 'untrusted', licence_revision: '0', parties: [] }, context: {} }), /pinned finalized-state reader/);
});
test('state reader refuses a substituted binary before execution and bounds private input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'uain-private-state-pin-fixture-'));
  try {
    const executable = join(directory, 'fictional-reader');
    await writeFile(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    const args = { executable, executableSha256: '00'.repeat(32), genesisSha256: '01'.repeat(32), genesis: 'unused-public-genesis', rpc: 'http://127.0.0.1:1', request: {} };
    await assert.rejects(readPrivateState(args), /binary pin/);
    await assert.rejects(readPrivateState({ ...args, maxAgeSeconds: 601 }), /bounded freshness/);
    await assert.rejects(readPrivateState({ ...args, request: { oversized: 'x'.repeat(65536) } }), /request too large/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('private selectors refuse a hosted, proxied or named RPC before executing a tool', async () => {
  for (const reader of [
    {rpc:'http://192.0.2.1:26657'}, {rpc:'http://localhost:26657'},
    {rpc:'http://example.onion',socksProxy:'127.0.0.1:9050'},
    {rpc:'http://127.0.0.1:26657',socksProxy:'127.0.0.1:9050'},
    {rpc:'http://user@127.0.0.1:26657'}, {rpc:'http://127.0.0.1/path'},
  ]) await assert.rejects(readPrivateState({...reader,request:{parties:['selected sender','selected recipient']}}), /own loopback full node/);
});

test('remote-verified light mode admits only HTTPS, onion over SOCKS5 or loopback, and passes its flag to the pinned reader', async () => {
  for (const reader of [
    {rpc:'http://192.0.2.1:26657',remoteVerified:true}, {rpc:'http://example.onion',remoteVerified:true},
    {rpc:'https://user@rpc.example.org',remoteVerified:true}, {rpc:'https://rpc.example.org/path',remoteVerified:true},
    {rpc:'https://rpc.example.org/?q=1',remoteVerified:true}, {rpc:'http://127.0.0.1:26657',socksProxy:'127.0.0.1:9050',remoteVerified:true},
  ]) await assert.rejects(readPrivateState({...reader,request:{parties:['selected sender','selected recipient']}}), /remote-verified reads require/);
  await assert.rejects(readPrivateState({rpc:'https://rpc.example.org',remoteVerified:'yes',request:{}}), /exactly true/);
  const directory = await mkdtemp(join(tmpdir(), 'uain-private-state-remote-fixture-'));
  try {
    const executable = join(directory, 'fictional-reader'), argsFile = join(directory, 'args');
    await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nexit 7\n`, { mode: 0o700 });
    const executableSha256 = createHash('sha256').update(`#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nexit 7\n`).digest('hex');
    await assert.rejects(readPrivateState({ executable, executableSha256, genesisSha256: '01'.repeat(32), genesis: 'unused-public-genesis', rpc: 'https://rpc.example.org', remoteVerified: true, request: { light_scan: true } }), /refused/);
    const { readFile } = await import('node:fs/promises');
    const args = (await readFile(argsFile, 'utf8')).trim().split('\n');
    assert.ok(args.includes('--remote-verified')); assert.equal(args[args.indexOf('--rpc') + 1], 'https://rpc.example.org');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a pinned record-only result cannot acquire approval authority', async () => {
  const directory=await mkdtemp(join(tmpdir(),'uain-record-scope-'));
  try {
    const executable=join(directory,'record-fixture');
    const script=`#!/usr/bin/env node
const fs=require('node:fs');fs.writeFileSync(process.argv[process.argv.indexOf('--out')+1],JSON.stringify({record_only:true,header_time:new Date().toISOString(),relayer:{},reviewer:{},parties:[],payments:[],boundaries:[],commitments:[]}),{mode:0o600});
`;
    await writeFile(executable,script,{mode:0o700});
    const state=await readPrivateState({executable,executableSha256:createHash('sha256').update(script).digest('hex'),genesis:'unused',genesisSha256:'01'.repeat(32),rpc:'http://127.0.0.1:1',request:{record_only:true,source_payments:['02'.repeat(32)]}});
    assert.equal(state.record_only,true);
    assert.throws(()=>assertPrivateStateContext(state,{}),/record-only proof cannot authorize/);
    assert.throws(()=>signApprovalFromPrivateState({state,context:{}}),/record-only proof cannot authorize/);
  } finally {await rm(directory,{recursive:true,force:true});}
});

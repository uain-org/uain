import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFunctionData, encodeFunctionResult } from 'viem';
import { compile } from '../scripts/compile.mjs';
import { expectedRuntime } from '../dist/contract.js';
import { account } from './evm.mjs';

const pair = generateKeyPairSync('ed25519');
const dir = mkdtempSync(join(tmpdir(), 'uain-cli-'));
const keyFile = join(dir, 'public.pem');
writeFileSync(keyFile, pair.publicKey.export({ type: 'spki', format: 'pem' }));
const artifact = compile().LedgerAnchor;
const payload = { date: '2026-09-27', root: 'a'.repeat(64), head: 'b'.repeat(64), count: 1, first_id: 1, last_id: 1 };
const root = { ...payload, provisional: false, signature: sign(null, Buffer.from(JSON.stringify(payload)), pair.privateKey).toString('base64') };
const cli = fileURLToPath(new URL('../scripts/operations.mjs', import.meta.url));
let server, base, env, chainId = 84532, anchored = false, conflict = false;
const rpcMethods = [];
before(async () => {
  server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/api/ledger/roots/')) { res.end(JSON.stringify(root)); return; }
    if (req.url.startsWith('/api/ledger/roots?')) { res.end(JSON.stringify({ count: 1, roots: [root] })); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw); rpcMethods.push(request.method);
    let result;
    if (request.method === 'eth_chainId') result = `0x${chainId.toString(16)}`;
    else if (request.method === 'eth_blockNumber') result = '0x64';
    else if (request.method === 'eth_getCode') result = expectedRuntime(artifact, account(1));
    else if (request.method === 'eth_call') {
      const decoded = decodeFunctionData({ abi: artifact.abi, data: request.params[0].data });
      const values = { owner: account(1), anchorer: account(2), lastDay: anchored ? 20723 : 0, anchorOf: anchored ? { root: `0x${'a'.repeat(64)}`, head: `0x${(conflict ? 'c' : 'b').repeat(64)}`, count: 1n, lastEventId: 1n, anchoredAt: 100n } : { root: `0x${'0'.repeat(64)}`, head: `0x${'0'.repeat(64)}`, count: 0n, lastEventId: 0n, anchoredAt: 0n } };
      result = encodeFunctionResult({ abi: artifact.abi, functionName: decoded.functionName, result: values[decoded.functionName] });
    } else { res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Mutation is disabled in this fixture' } })); return; }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  env = { ...process.env, UAIN_API: base, BASE_SEPOLIA_RPC: `${base}/rpc`, LEDGER_OWNER_ADDRESS: account(1), LEDGER_ANCHOR_ADDRESS: account(3), ANCHORER_ADDRESS: account(2), LEDGER_PUBLIC_KEY_FILE: keyFile, LEDGER_ANCHOR_START_DATE: '2026-09-26', ANCHOR_JOURNAL: join(dir, 'operations.json') };
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
const run = args => promisify(execFile)(process.execPath, [cli, ...args], { env, timeout: 15_000 });
test('the runnable CLI prepares deployment offline without touching RPC or loading private keys', async () => {
  const count = rpcMethods.length;
  const output = await run(['deploy', '--nonce', '0']);
  const plan = JSON.parse(output.stdout);
  assert.equal(plan.owner, account(1)); assert.equal(plan.chainId, 84532);
  assert.equal(rpcMethods.length, count);
});
test('the runnable dry catch-up validates RPC identity and signatures and never sends', async () => {
  const output = await run(['catchup', '--to', '2026-09-28']);
  assert.match(output.stdout, /Verified dry run: 1 day/);
  assert.ok(rpcMethods.includes('eth_getCode'));
  assert.equal(rpcMethods.some(m => /send/i.test(m)), false);
});
test('read-only CLI audit fails for an absent root, passes exact matches and rejects changed heads', async () => {
  await assert.rejects(run(['audit', '--to', '2026-09-28']), error => error.code === 2 && /absent/.test(error.stdout));
  anchored = true;
  assert.match((await run(['audit', '--to', '2026-09-28'])).stdout, /matches/);
  conflict = true;
  await assert.rejects(run(['audit', '--to', '2026-09-28']), error => error.code === 1);
  conflict = false; anchored = false;
});
test('CLI refuses mainnet before inspecting or calling the configured contract', async () => {
  chainId = 1; const count = rpcMethods.length;
  await assert.rejects(run(['catchup', '--to', '2026-09-28']), error => error.code === 1);
  assert.deepEqual(rpcMethods.slice(count), ['eth_chainId']); chainId = 84532;
});
test('runnable publication writes validated evidence and refuses a wrong pinned key', async () => {
  const out = join(dir, 'roots');
  assert.match((await run(['publish', '--date', root.date, '--out', out])).stdout, /created/);
  assert.match((await run(['publish', '--date', root.date, '--out', out])).stdout, /unchanged/);
  writeFileSync(keyFile, generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }));
  await assert.rejects(run(['publish', '--date', root.date, '--out', out]), error => error.code === 1);
});

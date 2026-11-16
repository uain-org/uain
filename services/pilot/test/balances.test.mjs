/**
 * The live public balance of a member's bound wallet addresses
 * (integrations/chain-balances.ts, GET /api/directory/{id}/balances and
 * GET /api/members/{address}/balances).
 *
 * No test touches a real chain: the reader is given a fake fetch, and the
 * server is pointed at a JSON-RPC stub on 127.0.0.1 through
 * UAIN_ETHEREUM_RPC_URL and UAIN_SOLANA_RPC_URL.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { createServer } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { boot } from './helpers.mjs';

const NOTE = /UAIN holds no keys or funds and pays nothing to these addresses yet/;

/* ------------------------------------------------------------ the JSON-RPC stub */

/** How each chain's stub answers: ok, http500, rpcError, junk or hang. */
const mode = { ethereum: 'ok', solana: 'ok' };
const calls = { ethereum: [], solana: [] };
const WEI = 1234567890123456789012n; // 1234.567890123456789012 ETH
const LAMPORTS = 1500000001; // 1.500000001 SOL

const stub = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const chain = req.url.startsWith('/eth/') ? 'ethereum' : 'solana';
    const rpc = JSON.parse(body);
    calls[chain].push({ path: req.url, rpc });
    const m = mode[chain];
    if (m === 'hang') return; // never answers; the reader's deadline must end it
    if (m === 'http500') {
      res.writeHead(500);
      return res.end('upstream down');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (m === 'rpcError')
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32005, message: 'rate limited' } }));
    if (m === 'junk') return res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: 'lots' }));
    const result =
      chain === 'ethereum' ? `0x${WEI.toString(16)}` : { context: { slot: 1 }, value: LAMPORTS };
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
});

let t;
before(async () => {
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const port = stub.address().port;
  t = await boot({
    // The Ethereum URL carries a provider key in its path: it must never be shown.
    UAIN_ETHEREUM_RPC_URL: `http://127.0.0.1:${port}/eth/secret-provider-key`,
    UAIN_SOLANA_RPC_URL: `http://127.0.0.1:${port}/sol`,
    UAIN_BALANCE_TIMEOUT_MS: '300',
  });
});
after(async () => {
  await t.close();
  stub.closeAllConnections?.();
  await new Promise((resolve) => stub.close(resolve));
});

/* ------------------------------------------- wallets, made apart from the server */

const hex = (b) => Buffer.from(b).toString('hex');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes) {
  let n = BigInt(`0x${hex(bytes) || '0'}`);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = `1${s}`;
  }
  return s;
}
function eip55(lower) {
  const h = hex(keccak_256(Buffer.from(lower)));
  return `0x${[...lower].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join('')}`;
}
function ethWallet() {
  const sk = secp256k1.utils.randomSecretKey();
  const address = eip55(hex(keccak_256(secp256k1.getPublicKey(sk, false).subarray(1)).subarray(12)));
  const sign = (message) => {
    const body = Buffer.from(message, 'utf8');
    const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`), body]));
    const sig = secp256k1.sign(digest, sk, { prehash: false, format: 'recovered' });
    return `0x${hex(sig.subarray(1))}${(27 + sig[0]).toString(16)}`;
  };
  return { chain: 'ethereum', address, sign };
}
function solWallet() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(privateKey.export({ format: 'jwk' }).x, 'base64url');
  return { chain: 'solana', address: b58(raw), sign: (m) => b58(edSign(null, Buffer.from(m, 'utf8'), privateKey)) };
}
async function bind(m, w) {
  const c = await m.call('uain_wallet_challenge', { chain: w.chain, address: w.address });
  const r = await m.call('uain_wallet_bind', { chain: w.chain, address: w.address, message: c.message, signature: w.sign(c.message) });
  assert.equal(r.bound, true, JSON.stringify(r));
}
const get = async (path) => {
  const res = await t.http(path);
  return { status: res.status, body: await res.json() };
};

/* ------------------------------------------------------------ the reader alone */

describe('the reader', () => {
  let reader;
  before(async () => {
    reader = await import('../dist/src/integrations/chain-balances.js');
  });

  /** A fetch that answers from `answer(chain, body)` and counts its calls. */
  function fakeFetch(answer) {
    const seen = [];
    const impl = async (url, init) => {
      const body = JSON.parse(init.body);
      seen.push({ url, body });
      return answer(url, body, init);
    };
    return { impl, seen };
  }
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

  test('whole units are exact, with no floating point', () => {
    assert.equal(reader.formatUnits(0n, 18), '0');
    assert.equal(reader.formatUnits(1n, 18), '0.000000000000000001');
    assert.equal(reader.formatUnits(10n ** 18n, 18), '1');
    assert.equal(reader.formatUnits(WEI, 18), '1234.567890123456789012');
    assert.equal(reader.formatUnits(1500000001n, 9), '1.500000001');
    assert.equal(reader.formatUnits(2n * 10n ** 9n, 9), '2');
  });

  test('Ethereum and Solana are asked the standard read-only methods, on mainnet by default', async () => {
    assert.equal(reader.DEFAULT_RPC.ethereum, 'https://ethereum-rpc.publicnode.com');
    assert.equal(reader.DEFAULT_RPC.solana, 'https://api.mainnet-beta.solana.com');
    const f = fakeFetch((url, body) =>
      json({ jsonrpc: '2.0', id: body.id, result: body.method === 'eth_getBalance' ? '0xde0b6b3a7640000' : { context: { slot: 9 }, value: 42 } }),
    );
    const r = reader.createBalanceReader({ fetchImpl: f.impl, env: {} });
    const eth = await r.read('ethereum', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
    const sol = await r.read('solana', 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg');
    assert.equal(f.seen[0].url, 'https://ethereum-rpc.publicnode.com');
    assert.deepEqual(f.seen[0].body.params, ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 'latest']);
    assert.equal(f.seen[0].body.method, 'eth_getBalance');
    assert.equal(f.seen[1].url, 'https://api.mainnet-beta.solana.com');
    assert.equal(f.seen[1].body.method, 'getBalance');
    assert.deepEqual(f.seen[1].body.params, ['vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg', { commitment: 'finalized' }]);
    assert.equal(eth.balance, '1');
    assert.equal(eth.balance_raw, '1000000000000000000');
    assert.equal(eth.asset, 'ETH');
    assert.equal(eth.network, 'Ethereum mainnet');
    assert.equal(eth.source, 'ethereum-rpc.publicnode.com');
    assert.ok(Date.parse(eth.read_at));
    assert.equal(eth.error, undefined);
    assert.equal(sol.balance, '0.000000042');
    assert.equal(sol.unit, 'lamports');
    assert.equal(sol.network, 'Solana mainnet-beta');
  });

  test('an endpoint can be replaced, and only its host is ever shown', async () => {
    const f = fakeFetch((url, body) => json({ jsonrpc: '2.0', id: body.id, result: '0x0' }));
    const r = reader.createBalanceReader({ fetchImpl: f.impl, env: { UAIN_ETHEREUM_RPC_URL: 'https://eth.example.net/v3/abc123key' } });
    const a = await r.read('ethereum', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
    assert.equal(f.seen[0].url, 'https://eth.example.net/v3/abc123key');
    assert.equal(a.source, 'eth.example.net');
    assert.doesNotMatch(JSON.stringify(a), /abc123key/);
    assert.equal(a.balance, '0');
  });

  test('each failure is an answer with balance null and a reason, never a throw', async () => {
    const cases = [
      [() => json({}, 503), 'rpc_http_error', /HTTP 503/],
      [(u, b) => json({ jsonrpc: '2.0', id: b.id, error: { code: -32005, message: 'too many requests' } }), 'rpc_error', /too many requests/],
      [(u, b) => json({ jsonrpc: '2.0', id: b.id, result: 'plenty' }), 'rpc_bad_answer', /not a balance/],
      [(u, b) => json({ jsonrpc: '2.0', id: b.id, result: '-0x1' }), 'rpc_bad_answer', /not a balance/],
      [() => new Response('<html>gateway</html>', { status: 200 }), 'rpc_bad_answer', /not a balance/],
      [() => { throw new TypeError('fetch failed'); }, 'rpc_unreachable', /could not be reached/],
    ];
    for (const [answer, error, reason] of cases) {
      const r = reader.createBalanceReader({ fetchImpl: fakeFetch(answer).impl, env: {} });
      const a = await r.read('ethereum', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
      assert.equal(a.balance, null, error);
      assert.equal(a.balance_raw, null);
      assert.equal(a.read_at, null);
      assert.equal(a.error, error);
      assert.match(a.reason, reason);
      assert.equal(a.address, '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
    }
    // A Solana answer without a lamport count is not a balance either.
    const s = reader.createBalanceReader({ fetchImpl: fakeFetch((u, b) => json({ jsonrpc: '2.0', id: b.id, result: { value: 1.5 } })).impl, env: {} });
    assert.equal((await s.read('solana', 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg')).error, 'rpc_bad_answer');
    // A configured URL that is not HTTP is refused before any request.
    const f = fakeFetch(() => json({}));
    const bad = reader.createBalanceReader({ fetchImpl: f.impl, env: { UAIN_SOLANA_RPC_URL: 'file:///etc/passwd' } });
    assert.equal((await bad.read('solana', 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg')).error, 'rpc_not_configured');
    assert.equal(f.seen.length, 0);
  });

  test('a node that does not answer is given up on at the deadline', async () => {
    const hang = (url, body, init) =>
      new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    const r = reader.createBalanceReader({ fetchImpl: fakeFetch(hang).impl, env: { UAIN_BALANCE_TIMEOUT_MS: '50' } });
    const started = Date.now();
    const a = await r.read('solana', 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg');
    assert.ok(Date.now() - started < 2000);
    assert.equal(a.error, 'rpc_timeout');
    assert.match(a.reason, /did not answer within 0.05 seconds/);
  });

  test('an address is read once per cache period, a failure is retried after 30 seconds, and reads in flight are shared', async () => {
    let clock = 1_000_000;
    let fail = false;
    const f = fakeFetch((u, b) => (fail ? json({}, 502) : json({ jsonrpc: '2.0', id: b.id, result: '0x1' })));
    const r = reader.createBalanceReader({ fetchImpl: f.impl, env: {}, now: () => clock });
    const addr = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
    assert.equal(r.cacheSeconds(), 300);

    // Three at once: one request.
    const three = await Promise.all([r.read('ethereum', addr), r.read('ethereum', addr), r.read('ethereum', addr)]);
    assert.equal(f.seen.length, 1);
    assert.ok(three.every((a) => a.balance === '0.000000000000000001'));

    clock += 299_000;
    await r.read('ethereum', addr);
    assert.equal(f.seen.length, 1, 'still fresh at 299 seconds');

    clock += 2_000;
    fail = true;
    const failed = await r.read('ethereum', addr);
    assert.equal(f.seen.length, 2, 'read again after 300 seconds');
    assert.equal(failed.error, 'rpc_http_error');

    clock += 29_000;
    await r.read('ethereum', addr);
    assert.equal(f.seen.length, 2, 'a failure is remembered for 30 seconds');

    clock += 2_000;
    fail = false;
    assert.equal((await r.read('ethereum', addr)).balance, '0.000000000000000001');
    assert.equal(f.seen.length, 3);

    // Another address, and the other chain, are their own entries.
    await r.read('ethereum', '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359');
    assert.equal(f.seen.length, 4);
  });

  test('the cache is bounded', async () => {
    const f = fakeFetch((u, b) => json({ jsonrpc: '2.0', id: b.id, result: '0x1' }));
    const r = reader.createBalanceReader({ fetchImpl: f.impl, env: {}, maxEntries: 2 });
    for (const a of ['0x01', '0x02', '0x03', '0x01']) await r.read('ethereum', a);
    // 0x01 was dropped when 0x03 arrived, so it is read again.
    assert.equal(f.seen.length, 4);
  });
});

/* ------------------------------------------------------------ over HTTP */

describe('GET /api/directory/{id}/balances', () => {
  test('a member with both addresses bound: each balance, exact, from the configured nodes', async () => {
    const a = await t.member('Kestrel Labs', 'Kestrel');
    const eth = ethWallet();
    const sol = solWallet();
    await bind(a, eth);
    await bind(a, sol);

    const { status, body } = await get(`/api/directory/${a.id}/balances`);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.id, a.id);
    assert.equal(body.member, a.key.address);
    assert.equal(body.cache_seconds, 300);
    assert.match(body.note, NOTE);
    assert.match(body.note, /not credits and not Karma/);

    const e = body.balances.ethereum;
    assert.equal(e.address, eth.address);
    assert.equal(e.balance, '1234.567890123456789012');
    assert.equal(e.balance_raw, WEI.toString());
    assert.equal(e.asset, 'ETH');
    assert.equal(e.source, `127.0.0.1:${stub.address().port}`);
    assert.doesNotMatch(JSON.stringify(body), /secret-provider-key/);

    const s = body.balances.solana;
    assert.equal(s.address, sol.address);
    assert.equal(s.balance, '1.500000001');
    assert.equal(s.asset, 'SOL');

    // The node was asked for exactly these addresses, read-only.
    assert.deepEqual(calls.ethereum.at(-1).rpc.params, [eth.address, 'latest']);
    assert.equal(calls.ethereum.at(-1).rpc.method, 'eth_getBalance');
    assert.equal(calls.solana.at(-1).rpc.method, 'getBalance');

    // The member route answers the same, from the cache.
    const before = calls.ethereum.length + calls.solana.length;
    const m = await get(`/api/members/${a.key.address}/balances`);
    assert.equal(m.status, 200);
    assert.equal(m.body.member, a.key.address);
    assert.equal(m.body.id, undefined);
    assert.equal(m.body.balances.ethereum.balance, '1234.567890123456789012');
    assert.equal(m.body.balances.solana.balance, '1.500000001');
    assert.equal(calls.ethereum.length + calls.solana.length, before, 'served from the cache');
  });

  test('no address bound: both chains are null, and no node is asked', async () => {
    const a = await t.member('Wren Labs', 'Wren');
    const before = calls.ethereum.length + calls.solana.length;
    const { status, body } = await get(`/api/directory/${a.id}/balances`);
    assert.equal(status, 200);
    assert.deepEqual(body.balances, { ethereum: null, solana: null });
    assert.equal(calls.ethereum.length + calls.solana.length, before);
  });

  test('one failing node never fails the response or the other chain', async () => {
    for (const failure of ['http500', 'rpcError', 'junk', 'hang']) {
      const a = await t.member('Tern Labs', `Tern-${failure}`);
      const eth = ethWallet();
      const sol = solWallet();
      await bind(a, eth);
      await bind(a, sol);
      mode.solana = failure;
      try {
        const { status, body } = await get(`/api/directory/${a.id}/balances`);
        assert.equal(status, 200, failure);
        assert.equal(body.balances.ethereum.balance, '1234.567890123456789012', failure);
        assert.equal(body.balances.solana.address, sol.address);
        assert.equal(body.balances.solana.balance, null, failure);
        assert.equal(typeof body.balances.solana.reason, 'string');
        assert.equal(
          body.balances.solana.error,
          { http500: 'rpc_http_error', rpcError: 'rpc_error', junk: 'rpc_bad_answer', hang: 'rpc_timeout' }[failure],
        );
      } finally {
        mode.solana = 'ok';
      }
    }
  });

  test('an unknown agent or member is 404; other methods are not answered here', async () => {
    assert.equal((await get('/api/directory/no-such-agent/balances')).status, 404);
    assert.equal((await get(`/api/members/uain1${'0'.repeat(40)}/balances`)).status, 404);
    const post = await t.http('/api/directory/no-such-agent/balances', { method: 'POST' });
    assert.notEqual(post.status, 200);
  });
});

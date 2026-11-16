import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:https';
import { createPinnedFetch } from '../src/pinned-fetch.mjs';
import { createRetriever, isPublicAddress } from '../src/verification.mjs';
import { sha256 } from '../src/common.mjs';

/* A throwaway self-signed certificate for `pinned.test`, built in-process (DER by hand),
 * so the test needs no openssl, no committed key and no network. */
const der = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  const n = body.length;
  const len = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
};
const seq = (...p) => der(0x30, ...p);
const oid = (dotted) => {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const bytes = [40 * a + b];
  for (const v of rest) {
    const stack = [v & 0x7f];
    for (let x = v >> 7; x > 0; x >>= 7) stack.unshift(0x80 | (x & 0x7f));
    bytes.push(...stack);
  }
  return der(0x06, Buffer.from(bytes));
};
const utf8 = (s) => der(0x0c, Buffer.from(s));
const time = (d) => der(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
const name = (cn) => seq(der(0x31, seq(oid('2.5.4.3'), utf8(cn))));

function selfSigned(host) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sigAlg = seq(oid('1.2.840.10045.4.3.2'));
  const san = seq(oid('2.5.29.17'), der(0x04, seq(der(0x82, Buffer.from(host)))));
  const now = Date.now();
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([0x01, 0x23, 0x45])),
    sigAlg,
    name(host),
    seq(time(new Date(now - 3600e3)), time(new Date(now + 86400e3))),
    name(host),
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, seq(san)),
  );
  const signature = sign('sha256', tbs, privateKey);
  const cert = seq(tbs, sigAlg, der(0x03, Buffer.from([0]), signature));
  const pem = `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  return { cert: pem, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

const HOST = 'pinned.test';
const tls = selfSigned(HOST);
const BODY = Buffer.from('pinned bytes\n');
const seen = [];
const server = createServer({ cert: tls.cert, key: tls.key }, (req, res) => {
  seen.push({ path: req.url, local: req.socket.localAddress, host: req.headers.host, ua: req.headers['user-agent'], servername: req.socket.servername });
  if (req.url === '/redirect') {
    res.writeHead(302, { location: 'https://169.254.169.254/latest/meta-data/' });
    return res.end();
  }
  if (req.url === '/big') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' }); // streamed, no length declared
    const chunk = Buffer.alloc(4096, 0x61);
    let sent = 0;
    const pump = () => {
      while (sent < 64 && res.write(chunk)) sent += 1;
      if (sent < 64) res.once('drain', pump);
      else res.end();
    };
    return pump();
  }
  if (req.url === '/declared-big') {
    res.writeHead(200, { 'content-length': '999999' });
    return res.end();
  }
  if (req.url === '/slow') return setTimeout(() => res.end('late'), 2000).unref();
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(BODY);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;
test.after(() => server.close());

/** Loopback stands in for a "public" address only in this harness; the real policy is used for everything else. */
const harnessPublic = (address) => address === '127.0.0.1' || isPublicAddress(address);
/** First answer is the local test server; every later lookup would rebind to a private address. */
function rebindingLookup() {
  const calls = [];
  const lookup = (hostname, options, callback) => {
    calls.push(hostname);
    const address = calls.length === 1 ? '127.0.0.1' : '10.0.0.7';
    callback(null, [{ address, family: 4 }]);
  };
  return { lookup, calls };
}
const pinnedFetch = (extra = {}) => createPinnedFetch({ allowedHosts: [HOST], isPublicAddress: harnessPublic, ca: tls.cert, timeoutMs: 1000, ...extra });
const url = (path) => `https://${HOST}:${PORT}${path}`;

test('the connection goes to the address that passed the check, even when a second lookup would rebind', async () => {
  const { lookup, calls } = rebindingLookup();
  const fetch = pinnedFetch({ lookup });
  seen.length = 0;
  const response = await fetch(url('/data'));
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), BODY);
  assert.equal(calls.length, 1, 'the name is resolved exactly once per request; the socket never resolves again');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].local, '127.0.0.1');
  assert.equal(seen[0].servername, HOST, 'SNI carries the hostname, not the address');
  assert.equal(seen[0].host, `${HOST}:${PORT}`);
  assert.equal(seen[0].ua, 'uain-trusted-retrieval/1');
  // A second request resolves again and is refused before connecting: it would now be private.
  await assert.rejects(fetch(url('/data')), (e) => e.code === 'private_address_refused');
  assert.equal(seen.length, 1, 'no connection was made for the refused request');
});

test('certificate validation stays on: an untrusted certificate is refused', async () => {
  const { lookup } = rebindingLookup();
  const fetch = createPinnedFetch({ allowedHosts: [HOST], isPublicAddress: harnessPublic, lookup, timeoutMs: 1000 });
  await assert.rejects(fetch(url('/data')), (e) => e.code === 'retrieval_failed');
});

test('private, loopback, link-local and mixed answers are refused before any connection', async () => {
  seen.length = 0;
  for (const answers of [['127.0.0.1'], ['10.1.2.3'], ['169.254.169.254'], ['::1'], ['fd00::1'], ['93.184.216.34', '192.168.1.1'], []]) {
    const lookup = (_h, _o, cb) => cb(null, answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
    const fetch = createPinnedFetch({ allowedHosts: [HOST], lookup, ca: tls.cert, timeoutMs: 1000 }); // the real address policy
    await assert.rejects(fetch(url('/data')), (e) => e.code === (answers.length ? 'private_address_refused' : 'dns_failed'), answers.join());
  }
  const failing = createPinnedFetch({ allowedHosts: [HOST], lookup: (_h, _o, cb) => cb(new Error('ENOTFOUND')), timeoutMs: 1000 });
  await assert.rejects(failing(url('/data')), (e) => e.code === 'dns_failed');
  assert.equal(seen.length, 0);
});

test('only https GET to an allowlisted name: http, IP literals, credentials, other hosts and methods refuse', async () => {
  const { lookup, calls } = rebindingLookup();
  const fetch = pinnedFetch({ lookup });
  const cases = [
    [`http://${HOST}/data`, 'https_required'],
    [`https://127.0.0.1:${PORT}/data`, 'ip_literal_refused'],
    ['https://[::1]/data', 'ip_literal_refused'],
    [`https://user:pw@${HOST}/data`, 'credentials_in_url'],
    ['https://other.test/data', 'host_not_allowed'],
    ['not a url', 'invalid_url'],
  ];
  for (const [u, code] of cases) await assert.rejects(fetch(u), (e) => e.code === code, u);
  await assert.rejects(fetch(url('/data'), { method: 'POST', body: 'x' }), (e) => e.code === 'method_refused');
  assert.equal(calls.length, 0, 'refused before any lookup');
});

test('redirects are returned, not followed, so the caller re-checks the next hop', async () => {
  const { lookup } = rebindingLookup();
  seen.length = 0;
  const response = await pinnedFetch({ lookup })(url('/redirect'));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://169.254.169.254/latest/meta-data/');
  assert.equal(seen.length, 1, 'only the first hop was requested');
});

test('oversize bodies abort, declared or streamed; per-call caps can only lower the limit; timeouts abort', async () => {
  await assert.rejects(pinnedFetch({ lookup: rebindingLookup().lookup, maxBytes: 8192 })(url('/big')), (e) => e.code === 'size_exceeded');
  await assert.rejects(pinnedFetch({ lookup: rebindingLookup().lookup })(url('/declared-big'), { maxBytes: 1000 }), (e) => e.code === 'size_exceeded');
  await assert.rejects(pinnedFetch({ lookup: rebindingLookup().lookup, maxBytes: 100 })(url('/data'), { maxBytes: 1000 }), (e) => e.code === 'invalid_request');
  await assert.rejects(pinnedFetch({ lookup: rebindingLookup().lookup, timeoutMs: 100 })(url('/slow')), (e) => e.code === 'timeout');
});

test('configuration is strict', () => {
  for (const bad of [{ allowedHosts: [] }, { allowedHosts: ['127.0.0.1'] }, { allowedHosts: [HOST, HOST] }, { allowedHosts: [HOST], timeoutMs: 0 },
    { allowedHosts: [HOST], maxBytes: 2 ** 40 }, { allowedHosts: [HOST], lookup: 'dns' }]) {
    assert.throws(() => createPinnedFetch(bad), (e) => e.code === 'invalid_pinned_fetch', JSON.stringify(bad));
  }
});

test('createRetriever uses the pinned transport by default: a rebind after the retriever check is refused at connect time', async () => {
  // The retriever's own check sees a public answer; the transport's lookup (the one the socket would use) sees a private one.
  const transportCalls = [];
  const lookup = (hostname, _o, cb) => (transportCalls.push(hostname), cb(null, [{ address: '169.254.169.254', family: 4 }]));
  const retriever = createRetriever({ allowedHosts: ['data.example.org'], resolve: async () => [{ address: '93.184.216.34', family: 4 }], lookup });
  await assert.rejects(retriever.retrieve({ url: 'https://data.example.org/x', sha256: sha256('x'), bytes: 1 }, { hosts: ['data.example.org'] }),
    (e) => e.code === 'private_address_refused');
  await assert.rejects(retriever.observe('https://data.example.org/x', { hosts: ['data.example.org'] }), (e) => e.code === 'private_address_refused');
  assert.deepEqual(transportCalls, ['data.example.org', 'data.example.org']);
  assert.throws(() => createRetriever({ allowedHosts: ['data.example.org'], fetchImpl: async () => {}, lookup }), (e) => e.code === 'invalid_retriever');
});

test('the retriever over a pinned transport rechecks a redirect to a metadata address and binds observed bytes', async () => {
  const fetchImpl = pinnedFetch({ lookup: rebindingLookup().lookup });
  const resolve = async () => [{ address: '93.184.216.34', family: 4 }];
  // allowedHosts must match the pinned transport; the retriever refuses non-default ports, so call through a port-mapping shim.
  const shim = (u, init) => fetchImpl(u.replace(`https://${HOST}/`, `https://${HOST}:${PORT}/`), init);
  const retriever = createRetriever({ fetchImpl: shim, resolve, allowedHosts: [HOST] });
  await assert.rejects(retriever.observe(`https://${HOST}/redirect`, { hosts: [HOST] }), (e) => e.code === 'ip_literal_refused');
  const fresh = createRetriever({ fetchImpl: (u, init) => pinnedFetch({ lookup: rebindingLookup().lookup })(u.replace(`https://${HOST}/`, `https://${HOST}:${PORT}/`), init),
    resolve, allowedHosts: [HOST] });
  const observed = await fresh.observe(`https://${HOST}/data`, { hosts: [HOST] });
  assert.deepEqual(observed.bytes, BODY);
  assert.equal(observed.sha256, sha256(BODY));
  assert.equal(observed.url, `https://${HOST}/data`);
  assert.equal(observed.contentType, 'text/plain');
  await assert.rejects(fresh.observe(`https://${HOST}/data`, { hosts: [HOST], maxBytes: 4 }), (e) => e.code === 'size_exceeded');
});

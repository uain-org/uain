/**
 * Before its secrets exist the app must still start and pass its health
 * check, or the first deploy with it in compose.yaml would fail, and serve
 * nothing else.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { CSP } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Browser, SECRET, passwordHash, startApp } from './helpers.mjs';

const main = fileURLToPath(new URL('../src/main.js', import.meta.url));
const URL_OK = 'postgres://waitlist_reader:a-long-hex-password@db:5432/uain';

test('each missing or unusable secret leaves the app not configured', async () => {
  const hash = await passwordHash();
  const good = {
    DATABASE_URL: URL_OK,
    WAITLIST_ADMIN_PASSWORD_HASH: hash,
    WAITLIST_SESSION_SECRET: SECRET,
  };
  assert.equal(loadConfig(good).configured, true);
  /** @type {{ change: Record<string, string>, why: RegExp }[]} */
  const cases = [
    { change: { DATABASE_URL: '' }, why: /DATABASE_URL is not set/ },
    // What compose.yaml gives before the secret exists.
    {
      change: { DATABASE_URL: 'postgres://waitlist_reader:@db:5432/uain' },
      why: /no password/,
    },
    { change: { DATABASE_URL: 'mysql://a:b@db/uain' }, why: /not a postgres/ },
    { change: { DATABASE_URL: 'not a url' }, why: /not a URL/ },
    { change: { WAITLIST_ADMIN_PASSWORD_HASH: '' }, why: /HASH is not set/ },
    {
      change: { WAITLIST_ADMIN_PASSWORD_HASH: 'hunter2' },
      why: /HASH is not scrypt/,
    },
    {
      change: {
        WAITLIST_ADMIN_PASSWORD_HASH: hash.replace('$16384$', '$8192$'),
      },
      why: /HASH is not scrypt/,
    },
    { change: { WAITLIST_SESSION_SECRET: '' }, why: /SECRET is not set/ },
    {
      change: { WAITLIST_SESSION_SECRET: 'x'.repeat(31) },
      why: /shorter than 32 bytes/,
    },
  ];
  for (const { change, why } of cases) {
    const config = loadConfig(Object.assign({}, good, change));
    assert.equal(config.configured, false, JSON.stringify(change));
    assert.match(config.problems.join('; '), why);
    // Problems name what is wrong, never a value.
    assert.ok(!config.problems.join(' ').includes('a-long-hex-password'));
  }
  assert.equal(loadConfig({}).problems.length, 3);
  assert.equal(
    loadConfig({ ...good, WAITLIST_TRUSTED_PROXY_HOPS: '' }).trustedProxyHops,
    1,
  );
  assert.equal(
    loadConfig({ ...good, WAITLIST_TRUSTED_PROXY_HOPS: '0' }).trustedProxyHops,
    0,
  );
  assert.equal(
    loadConfig({ ...good, WAITLIST_TRUSTED_PROXY_HOPS: 'lots' })
      .trustedProxyHops,
    1,
  );
});

test('not configured: /healthz is 200, everything else 503', async () => {
  const app = await startApp({
    databaseUrl: 'postgres://waitlist_reader:@db:5432/uain',
  });
  try {
    assert.equal(app.config.configured, false);
    const b = new Browser(app.base);
    const health = await b.request('/healthz');
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.text), { ok: true, configured: false });
    assert.equal(health.headers.get('content-security-policy'), CSP);
    for (const path of [
      '/',
      '/login',
      '/signups',
      '/signups/UAIN-00000001',
      '/export.csv',
      '/nowhere',
    ]) {
      const res = await b.request(path);
      assert.equal(res.status, 503, path);
      assert.match(res.text, /not configured/i);
      assert.equal(res.headers.get('content-security-policy'), CSP, path);
      assert.equal(res.headers.get('cache-control'), 'no-store', path);
      assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow', path);
    }
    const post = await b.request('/login', {
      method: 'POST',
      form: { password: 'x' },
    });
    assert.equal(post.status, 503);
    assert.equal(post.cookies.length, 0);
  } finally {
    await app.close();
  }
});

async function freePort() {
  const s = net.createServer().listen(0, '127.0.0.1');
  await once(s, 'listening');
  const { port } = s.address();
  s.close();
  await once(s, 'close');
  return port;
}

test('the real entry point starts without secrets and stops on SIGTERM', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [main], {
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      HOST: '127.0.0.1',
      // What compose.yaml gives it before UAIN_WAITLIST_DB_PASSWORD exists.
      DATABASE_URL: 'postgres://waitlist_reader:@db:5432/uain',
      WAITLIST_ADMIN_PASSWORD_HASH: '',
      WAITLIST_SESSION_SECRET: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
  });
  try {
    for (let i = 0; i < 100 && !out.includes('"listening"'); i++)
      await new Promise((r) => setTimeout(r, 50));
    const started = JSON.parse(out.split('\n')[0]);
    assert.equal(started.event, 'listening');
    assert.equal(started.configured, false);
    assert.equal(started.problems.length, 3);
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, configured: false });
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' })).status,
      503,
    );
  } finally {
    child.kill('SIGTERM');
  }
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
});

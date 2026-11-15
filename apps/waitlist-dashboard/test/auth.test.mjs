import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { clientIp, safeNext } from '../src/app.js';
import {
  FailureLimiter,
  Sessions,
  hashPassword,
  parsePasswordHash,
  verifyPassword,
} from '../src/auth.js';
import { SECRET, fakeClock } from './helpers.mjs';

const script = fileURLToPath(
  new URL('../scripts/hash-password.mjs', import.meta.url),
);

test('a password hashes to scrypt$N$r$p$salt$hash and verifies', async () => {
  const hash = await hashPassword('a long admin passphrase', { N: 16384 });
  assert.match(
    hash,
    /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}$/,
  );
  assert.equal(await verifyPassword('a long admin passphrase', hash), true);
  assert.equal(await verifyPassword('a long admin passphrasE', hash), false);
  assert.equal(await verifyPassword('', hash), false);
  assert.equal(await verifyPassword(undefined, hash), false);
  assert.equal(await verifyPassword('x'.repeat(2000), hash), false);
  // Salted: the same password never hashes the same way twice.
  assert.notEqual(
    await hashPassword('a long admin passphrase', { N: 16384 }),
    hash,
  );
});

test('the default cost is N=65536', async () => {
  const hash = await hashPassword('another long passphrase');
  assert.equal(parsePasswordHash(hash).N, 65536);
  assert.equal(await verifyPassword('another long passphrase', hash), true);
});

test('weak or malformed hashes are refused', async () => {
  const good = await hashPassword('a long admin passphrase', { N: 16384 });
  const [, , r, p, salt, key] = good.split('$');
  for (const bad of [
    '',
    'plaintext',
    `scrypt$8192$${r}$${p}$${salt}$${key}`, // N below 16384
    `scrypt$20000$${r}$${p}$${salt}$${key}`, // N not a power of two
    `scrypt$16384$${r}$${p}$${salt}`, // missing part
    `bcrypt$16384$${r}$${p}$${salt}$${key}`,
    `scrypt$16384$${r}$${p}$!!!$${key}`,
    `scrypt$16384$${r}$${p}$${salt}$${key.slice(0, 8)}`, // hash too short
    `scrypt$16384$0$${p}$${salt}$${key}`,
  ])
    assert.equal(parsePasswordHash(bad), null, bad);
  await assert.rejects(hashPassword('pw', { N: 1024 }));
  assert.equal(
    await verifyPassword(
      'a long admin passphrase',
      'scrypt$8192$8$1$AAAA$AAAA',
    ),
    false,
  );
});

test('a session verifies until it expires, is ended, or is altered', () => {
  const now = fakeClock();
  const sessions = new Sessions({ secret: SECRET, now });
  const s = sessions.create();
  assert.ok(sessions.verify(s.token));
  assert.equal(sessions.verify(s.token).csrf, s.csrf);

  // Altered: each part of the cookie, and the cookie as a whole.
  const [sid, exp, sig] = s.token.split('.');
  const flip = (x) => (x[0] === 'A' ? 'B' : 'A') + x.slice(1);
  for (const forged of [
    `${flip(sid)}.${exp}.${sig}`,
    `${sid}.${Number(exp) + 1000}.${sig}`,
    `${sid}.${exp}.${flip(sig)}`,
    `${sid}.${exp}`,
    `${s.token}.x`,
    '',
    'garbage',
  ])
    assert.equal(sessions.verify(forged), null, forged);

  // Signed with another secret.
  const other = new Sessions({ secret: `${SECRET}-other`, now });
  assert.equal(other.verify(s.token), null);

  // Twelve hours, not a second more.
  now.advance(12 * 3600 * 1000 - 1000);
  assert.ok(sessions.verify(s.token));
  now.advance(1000);
  assert.equal(sessions.verify(s.token), null);

  // Ended.
  const t = sessions.create();
  sessions.destroy(t.sid);
  assert.equal(sessions.verify(t.token), null);
});

test('a session secret under 32 bytes is refused', () => {
  assert.throws(() => new Sessions({ secret: 'short' }));
});

test('the sign-in CSRF token is bound to its nonce', () => {
  const sessions = new Sessions({ secret: SECRET });
  const nonce = 'n'.repeat(43);
  const token = sessions.loginToken(nonce);
  assert.equal(sessions.checkLoginToken(nonce, token), true);
  assert.equal(sessions.checkLoginToken('m'.repeat(43), token), false);
  assert.equal(sessions.checkLoginToken(nonce, `${token}x`), false);
  assert.equal(sessions.checkLoginToken(undefined, token), false);
  assert.equal(sessions.checkLoginToken(nonce, null), false);
});

test('ten failures in fifteen minutes lock an address out', () => {
  const now = fakeClock();
  const limiter = new FailureLimiter({ now });
  for (let i = 0; i < 10; i++) {
    assert.equal(limiter.check('203.0.113.1').blocked, false);
    limiter.fail('203.0.113.1');
    now.advance(1000);
  }
  const gate = limiter.check('203.0.113.1');
  assert.equal(gate.blocked, true);
  assert.ok(gate.retryAfter > 0 && gate.retryAfter <= 900);
  assert.equal(limiter.check('203.0.113.2').blocked, false);
  now.advance(15 * 60 * 1000);
  assert.equal(limiter.check('203.0.113.1').blocked, false);
  limiter.fail('203.0.113.1');
  limiter.reset('203.0.113.1');
  assert.equal(limiter.hits.has('203.0.113.1'), false);
});

test('addresses in one IPv6 /64 share one lock-out', () => {
  const now = fakeClock();
  const limiter = new FailureLimiter({ now });
  // A person or a rented network holds a whole /64: ten different addresses in
  // it are one caller. Spellings of the same address count as one too.
  const spellings = [
    '2001:db8:1:2::1',
    '2001:0db8:0001:0002:0000:0000:0000:0002',
    '2001:DB8:1:2:aaaa::3',
    '2001:db8:1:2:1:2:3:4',
    '2001:db8:1:2::5%eth0',
    '2001:db8:1:2:ffff:ffff:ffff:ffff',
    '2001:db8:1:2::7',
    '2001:db8:1:2::8',
    '2001:db8:1:2::9',
    '2001:db8:1:2::a',
  ];
  for (const address of spellings) {
    assert.equal(limiter.check(address).blocked, false);
    limiter.fail(address);
    now.advance(1000);
  }
  assert.equal(limiter.check('2001:db8:1:2:dead:beef::1').blocked, true);
  // The next /64 and an IPv4 address are other callers.
  assert.equal(limiter.check('2001:db8:1:3::1').blocked, false);
  assert.equal(limiter.check('203.0.113.1').blocked, false);
  // A right password forgives the whole /64, as it forgives one address.
  limiter.reset('2001:db8:1:2::99');
  assert.equal(limiter.check('2001:db8:1:2::1').blocked, false);
});

test('a global ceiling stops failures spread over many addresses', () => {
  const now = fakeClock();
  const limiter = new FailureLimiter({ now, globalLimit: 20 });
  for (let i = 0; i < 20; i++) {
    const key = `198.51.100.${i}`;
    assert.equal(limiter.check(key).blocked, false, `attempt ${i}`);
    limiter.fail(key);
    now.advance(1000);
  }
  const gate = limiter.check('192.0.2.77');
  assert.equal(gate.blocked, true, 'an address that never failed');
  assert.ok(gate.retryAfter > 0 && gate.retryAfter <= 900);
  now.advance(15 * 60 * 1000);
  assert.equal(limiter.check('192.0.2.77').blocked, false, 'the window passed');
  // A right password is not a failure: it takes its own count back out.
  const forgiving = new FailureLimiter({ now, globalLimit: 3 });
  forgiving.fail('192.0.2.1');
  forgiving.fail('192.0.2.2');
  forgiving.fail('192.0.2.3');
  forgiving.reset('192.0.2.3');
  assert.equal(forgiving.check('192.0.2.9').blocked, false);
});

test('the address that last signed in gets past the global ceiling, not its own limit', () => {
  const now = fakeClock();
  const limiter = new FailureLimiter({ now, globalLimit: 20 });
  // The administrator signs in once from a /64, then others fill the ceiling.
  limiter.fail('2001:db8:9:9::1');
  limiter.reset('2001:db8:9:9::1');
  for (let i = 0; i < 20; i++) {
    limiter.fail(`198.51.100.${i}`);
    now.advance(1000);
  }
  assert.equal(limiter.check('198.51.100.200').blocked, true, 'never signed in');
  assert.equal(limiter.check('203.0.113.5').scope, 'all');
  assert.equal(limiter.check('2001:db8:9:9::77').blocked, false, 'same /64');
  // Still bound by its own limit.
  for (let i = 0; i < 10; i++) limiter.fail('2001:db8:9:9::1');
  const gate = limiter.check('2001:db8:9:9::1');
  assert.equal(gate.blocked, true);
  assert.equal(gate.scope, 'address');
  // Another address signing in takes the place of the first.
  limiter.reset('192.0.2.50');
  assert.equal(limiter.check('192.0.2.50').blocked, false);
  assert.equal(limiter.check('2001:db8:9:9::2').scope, 'address');
});

test('the client address is the trusted proxy hop, not what the client wrote', () => {
  const req = (xff, remote = '172.17.0.1') => ({
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
    socket: { remoteAddress: remote },
  });
  assert.equal(clientIp(req('198.51.100.7'), 1), '198.51.100.7');
  assert.equal(clientIp(req('6.6.6.6, 198.51.100.7'), 1), '198.51.100.7');
  assert.equal(
    clientIp(req('6.6.6.6, 198.51.100.7, 10.0.0.2'), 2),
    '198.51.100.7',
  );
  assert.equal(clientIp(req(undefined), 1), '172.17.0.1');
  assert.equal(clientIp(req('not-an-ip'), 1), '172.17.0.1');
  assert.equal(
    clientIp(req('198.51.100.7', '::ffff:127.0.0.1'), 0),
    '127.0.0.1',
  );
  assert.equal(clientIp(req('2001:db8::1'), 1), '2001:db8::1');
});

test('after sign-in, only a path on this site', () => {
  assert.equal(safeNext('/signups?q=a'), '/signups?q=a');
  assert.equal(safeNext('/signups/UAIN-00000001'), '/signups/UAIN-00000001');
  for (const bad of [
    '//evil.example/',
    '/\\evil.example',
    '/.//evil.example',
    'https://evil.example/',
    'javascript:alert(1)',
    '/login',
    '/logout',
    '',
    undefined,
  ])
    assert.equal(safeNext(bad), '/', String(bad));
});

test('npm run hash-password reads stdin and prints a hash that verifies', async () => {
  const out = spawnSync(process.execPath, [script, '--n', '16384'], {
    input: 'my long admin passphrase\n',
    encoding: 'utf8',
  });
  assert.equal(out.status, 0, out.stderr);
  const hash = out.stdout.trim();
  assert.ok(parsePasswordHash(hash));
  assert.equal(await verifyPassword('my long admin passphrase', hash), true);

  const short = spawnSync(process.execPath, [script, '--n', '16384'], {
    input: 'short\n',
    encoding: 'utf8',
  });
  assert.notEqual(short.status, 0);
  assert.equal(short.stdout, '');
  const weak = spawnSync(process.execPath, [script, '--n', '1024'], {
    input: 'my long admin passphrase',
    encoding: 'utf8',
  });
  assert.notEqual(weak.status, 0);
});

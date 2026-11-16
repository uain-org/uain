import {
  generateKeyPairSync,
  randomBytes,
  sign,
  createHash,
} from 'node:crypto';
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBainkServer } from '../server/app.mjs';

const audience = 'https://baink.example';
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function member() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return {
    privateKey,
    publicKey: raw.toString('base64'),
    address: `uain1${createHash('sha256').update(raw).digest('hex').slice(0, 40)}`,
  };
}
function signed(who, method, path, body = {}, overrides = {}) {
  const nonce = overrides.nonce ?? randomBytes(24).toString('base64url');
  const timestamp = overrides.timestamp ?? Date.now().toString();
  const message = canonical({
    audience: overrides.audience ?? audience,
    method,
    path,
    body,
    nonce,
    timestamp,
  });
  return {
    'X-BAINK-Public-Key': who.publicKey,
    'X-BAINK-Nonce': nonce,
    'X-BAINK-Timestamp': timestamp,
    'X-BAINK-Signature': sign(
      null,
      Buffer.from(message),
      who.privateKey,
    ).toString('base64'),
  };
}
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'baink-test-'));
  const { initialState, ...serverOptions } = options;
  if (initialState)
    await writeFile(join(dataDir, 'state.json'), JSON.stringify(initialState));
  let app;
  async function start() {
    app = await createBainkServer({
      dataDir,
      publicOrigin: audience,
      projectsSource: null,
      catalogueDir: null,
      // The server's own default is paused (P0-4); the existing suites exercise open Trade
      // explicitly here, and trade-availability.test.mjs passes tradeMode: 'paused'.
      tradeMode: 'open',
      ...serverOptions,
    });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${app.server.address().port}`;
  }
  let base;
  try {
    base = await start();
  } catch (error) {
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    dataDir,
    get base() {
      return base;
    },
    async request(who, method, path, body = {}, headers) {
      const response = await fetch(base + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Origin: audience,
          ...(who ? signed(who, method, path, body) : {}),
          ...headers,
        },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        body: await response.json(),
        headers: response.headers,
      };
    },
    // Restart on the same data, optionally with changed server options (a new setting).
    async restart(overrides = {}) {
      Object.assign(serverOptions, overrides);
      await app.close();
      base = await start();
    },
    // Stop, change the durable state file (as another service would), start.
    async edit(mutate) {
      await app.close();
      const path = join(dataDir, 'state.json');
      const state = JSON.parse(await readFile(path, 'utf8'));
      mutate(state);
      await writeFile(path, JSON.stringify(state));
      base = await start();
    },
  };
}

export { fixture, member, signed, audience };

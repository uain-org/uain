#!/usr/bin/env node
/**
 * A UAIN identity: an Ed25519 key pair made and kept on this computer. It is
 * the member (the AI system); every agent it runs (Claude Code, Codex,
 * OpenClaw, Hermes ...) signs in with it as an instance of that member.
 *
 * The private key never leaves the file it is saved in. The network only ever
 * sees the public key, the address derived from it, and signatures. Keeping
 * the file safe is the holder's responsibility: whoever has it is this member.
 *
 *   node uain-key.mjs new     [--file F]        make a key (refuses to overwrite)
 *   node uain-key.mjs show    [--file F]        public key and address
 *   node uain-key.mjs sign    <purpose> [--audience ORIGIN] [--file F]
 *                                               a signed proof, as JSON, for
 *                                               uain_enrol, uain_login or
 *                                               uain_claim_record; --audience is
 *                                               the server it is for, such as
 *                                               https://uain.global
 *   node uain-key.mjs login   [<agent id>] [--file F] [--base URL]
 *                                               sign in; with an agent id, prints
 *                                               a session token for that agent
 *   node uain-key.mjs claim   [--file F] [--base URL]
 *                                               tie an agent enrolled before keys
 *                                               to this key; old token from
 *                                               UAIN_TOKEN; prints a session token
 *
 * A proof names the server it is for (its audience), so one given to a
 * look-alike is no use at the real one. login and claim name the base they
 * send to. A proof without --audience is the older, unbound kind, accepted
 * only while servers still take it.
 *
 * The file defaults to ~/.uain/key.json, or UAIN_KEY_FILE. Needs Node 18+.
 * No dependencies: the worker imports it, and it runs on its own.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PURPOSES = ['enrol', 'login', 'claim'];

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** The address: "uain1" and the first 20 bytes of SHA-256 of the raw public key, in hex. */
export function addressOf(publicKey) {
  return `uain1${createHash('sha256')
    .update(Buffer.from(publicKey, 'base64url'))
    .digest('hex')
    .slice(0, 40)}`;
}

/**
 * A server's origin as proofs name it: scheme, host, and the port only when it
 * is not the default ("https://uain.global"). Null for anything else.
 */
export function audienceOf(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * Exactly what gets signed. The server rebuilds the same string to check it.
 * With an audience the proof is bound to that server; without, it is unbound.
 */
export function proofMessage(purpose, address, signedAt, nonce, audience) {
  return audience
    ? `uain:${purpose}:${audience}:${address}:${signedAt}:${nonce}`
    : `uain:${purpose}:${address}:${signedAt}:${nonce}`;
}

/** A new key pair, as the JSON saved to the key file. */
export function newKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'jwk' }).x;
  return {
    algorithm: 'Ed25519',
    address: addressOf(pub),
    public_key: pub,
    private_key: privateKey.export({ format: 'jwk' }).d,
    created_at: new Date().toISOString(),
  };
}

/**
 * Sign a proof for one purpose. What uain_enrol, uain_login and
 * uain_claim_record take. `audience`, the origin of the server it is sent to,
 * binds it to that server.
 */
export function proveWith(
  key,
  purpose,
  signedAt = new Date().toISOString(),
  nonce = randomBytes(16).toString('hex'),
  audience = undefined,
) {
  if (!PURPOSES.includes(purpose))
    throw new Error(`purpose must be one of ${PURPOSES.join(', ')}`);
  const origin = audience === undefined ? undefined : audienceOf(audience);
  if (origin === null)
    throw new Error(`The audience must be a server's origin, such as https://uain.global, not ${audience}.`);
  const privateKey = createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: key.public_key, d: key.private_key },
    format: 'jwk',
  });
  const message = proofMessage(purpose, key.address, signedAt, nonce, origin);
  return {
    address: key.address,
    public_key: key.public_key,
    signed_at: signedAt,
    nonce,
    ...(origin ? { audience: origin } : {}),
    signature: b64url(sign(null, Buffer.from(message), privateKey)),
  };
}

/** A proof bound to the server at `base`, the address it is about to be sent to. */
export const proveFor = (key, purpose, base) =>
  proveWith(key, purpose, undefined, undefined, base);

export const defaultKeyFile = () =>
  process.env.UAIN_KEY_FILE ??
  path.join(process.env.UAIN_HOME ?? path.join(os.homedir(), '.uain'), 'key.json');

export function readKey(file = defaultKeyFile()) {
  let key;
  try {
    key = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  // Checked on load, so a damaged or hand-edited file fails here, not later.
  const pub = createPublicKey(
    createPrivateKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: key.public_key, d: key.private_key },
      format: 'jwk',
    }),
  ).export({ format: 'jwk' }).x;
  if (pub !== key.public_key || addressOf(pub) !== key.address)
    throw new Error(`${file} does not hold a matching key pair.`);
  return key;
}

/** Saved readable only by you. Never overwrites: a lost key is a lost member. */
export function saveKey(key, file = defaultKeyFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(key, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  return file;
}

async function post(base, pathname, body) {
  const res = await fetch(`${base.replace(/\/$/, '')}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, ok: res.ok, body: await res.json().catch(() => ({})) };
}

/**
 * Sign in as the member this key is. `agent` names the instance to get a
 * session for; `newAgent` (an enrolment's declaration) adds one first.
 * Neither: the member and its agents, and no session.
 */
export const login = (base, key, { agent, newAgent, device } = {}) =>
  post(base, '/api/login', {
    ...proveFor(key, 'login', base),
    ...(agent ? { agent } : {}),
    ...(newAgent ? { new_agent: newAgent } : {}),
    ...(device ? { device } : {}),
  });

/**
 * What a member signs to publish one research run to UAIN's activity feed
 * (POST /api/agent-runs): bound to the server and to the member's address.
 */
export const agentRunMessage = (audience, address, payload) =>
  `uain:agent-run:${audience}:${address}:${JSON.stringify(payload)}`;

/**
 * A run envelope signed with this key for the server at `base`. `payload` is
 * { source, participant_id, external_id (a UUID), topic, status, public_url,
 * consent_at }; status is queued, running, waiting, completed, failed or
 * cancelled. Only publish what the system's owner chose to make public.
 */
export function signAgentRun(key, payload, base) {
  const origin = audienceOf(base);
  if (!origin) throw new Error(`base must be a server's address, such as https://uain.global, not ${base}.`);
  const privateKey = createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: key.public_key, d: key.private_key },
    format: 'jwk',
  });
  const signature = sign(null, Buffer.from(agentRunMessage(origin, key.address, payload)), privateKey);
  return { payload, key_signature: b64url(signature) };
}

/** Sign and publish a run as the agent whose session is `token`. */
export async function publishAgentRun(base, token, key, payload) {
  const res = await fetch(`${base.replace(/\/$/, '')}/api/agent-runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(signAgentRun(key, payload, base)),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, ok: res.ok, body: await res.json().catch(() => ({})) };
}

/** Tie a member enrolled before keys existed to this key, proved by its old token. */
export const claim = (base, key, participantToken) =>
  post(base, '/api/claim', {
    ...proveFor(key, 'claim', base),
    participant_token: participantToken,
  });

/* --------------------------------------------------------------------- CLI */

async function cli(argv) {
  const args = [...argv];
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    if (i < 0) return undefined;
    const [, v] = args.splice(i, 2);
    return v;
  };
  const file = flag('file') ?? defaultKeyFile();
  const base = flag('base') ?? process.env.UAIN_BASE ?? 'https://uain.global';
  const audience = flag('audience');
  const [cmd, purpose] = args;
  const agentArg = cmd === 'login' ? purpose : undefined;
  const out = (o) => console.log(JSON.stringify(o, null, 2));
  const need = () => {
    const key = readKey(file);
    if (!key) throw new Error(`No key at ${file}. Make one: node uain-key.mjs new`);
    return key;
  };

  if (cmd === 'new') {
    if (fs.existsSync(file))
      throw new Error(`${file} already exists. A key is never replaced; move it away first.`);
    const key = newKey();
    saveKey(key, file);
    return out({ saved: file, address: key.address, public_key: key.public_key });
  }
  if (cmd === 'show') {
    const key = need();
    return out({ file, address: key.address, public_key: key.public_key });
  }
  if (cmd === 'sign') return out(proveWith(need(), purpose, undefined, undefined, audience));
  if (cmd === 'login' || cmd === 'claim') {
    const key = need();
    let r;
    if (cmd === 'login') r = await login(base, key, { agent: agentArg });
    else {
      const old = process.env.UAIN_TOKEN;
      if (!old) throw new Error('Put the old participant token in UAIN_TOKEN.');
      r = await claim(base, key, old);
    }
    if (!r.ok) throw new Error(r.body.message ?? r.body.error ?? `HTTP ${r.status}`);
    return out(r.body);
  }
  console.log(
    'usage: node uain-key.mjs new | show | sign <enrol|login|claim> [--audience ORIGIN] | login [agent id] | claim  [--file F] [--base URL]',
  );
  process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
  cli(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });

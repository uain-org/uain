/**
 * A member ties one Ethereum and one Solana address to its profile (white
 * paper 5.2; decision D6, 30 September 2026). It binds its own: each address
 * is proven by a signature from that address's key over a UAIN challenge,
 * made here with real keys (noble for secp256k1, node:crypto for Ed25519).
 * UAIN never holds a wallet key and pays nothing to the addresses yet.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, createPublicKey, randomBytes, sign as edSign, verify as edVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { boot } from './helpers.mjs';

const LIMIT = 30;
let t;
let proof;
before(async () => {
  t = await boot({ UAIN_RATE_WALLET_CALLS_PER_HOUR: String(LIMIT) });
  proof = await import('../dist/src/identity/wallet-proof.js');
});
after(async () => {
  await t.close();
});

const NOTE = /bound by the member, proven by signature; UAIN holds no keys or funds and pays no bounties to these addresses yet/i;

/* ------------------------------------------- wallets, made apart from the server */

const hex = (b) => Buffer.from(b).toString('hex');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Base58 with BigInt, written apart from the server's. */
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
/** EIP-55 of 40 lower-case hex characters. */
function eip55(lower) {
  const h = hex(keccak_256(Buffer.from(lower)));
  return `0x${[...lower].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join('')}`;
}
/** Every private key made here, to look for afterwards. */
const secrets = [];

function ethWallet() {
  const sk = secp256k1.utils.randomSecretKey();
  secrets.push(Buffer.from(sk));
  const pub = secp256k1.getPublicKey(sk, false);
  const address = eip55(hex(keccak_256(pub.subarray(1)).subarray(12)));
  /** EIP-191 personal_sign: r, s and v = 27 + recovery, in hex. */
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
  const jwk = privateKey.export({ format: 'jwk' });
  const seed = Buffer.from(jwk.d, 'base64url');
  const raw = Buffer.from(jwk.x, 'base64url');
  secrets.push(seed, Buffer.concat([seed, raw])); // the seed, and the 64-byte keypair Solana tools keep
  return {
    chain: 'solana',
    address: b58(raw),
    raw,
    sign: (message) => b58(edSign(null, Buffer.from(message, 'utf8'), privateKey)),
  };
}

/** The challenge as the task defines it, built here to hold the server to it. */
const messageOf = ({ member, chain, wallet, audience, nonce, issued }) =>
  `UAIN wallet binding\nmember: ${member}\nchain: ${chain}\nwallet: ${wallet}\naudience: ${audience}\nnonce: ${nonce}\nissued: ${issued}`;

/* ------------------------------------------------------------------ helpers */

const members = [];
async function member(name) {
  const m = await t.member(`${name} Labs`, name);
  secrets.push(Buffer.from(m.key.private_key, 'base64url'));
  members.push(m);
  return { ...m, address: m.key.address };
}
const origin = () => new URL(t.base).origin;
const post = (path, token, body) =>
  t.http(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const binding = async (id) => (await t.http(`/api/wallets/${id}`)).json();

/** Challenge, sign with `signer` (the wallet itself unless named), bind: over MCP. */
async function bind(m, w, { signer = w } = {}) {
  const c = await m.call('uain_wallet_challenge', { chain: w.chain, address: w.address });
  assert.ok(c.message, JSON.stringify(c));
  return m.call('uain_wallet_bind', { chain: w.chain, address: w.address, message: c.message, signature: signer.sign(c.message) });
}

/* -------------------------------------------------------------------- tests */

describe('the proof, against published vectors', () => {
  test('base58, EIP-55, and personal_sign recovery match their references', () => {
    // Bitcoin Core's base58_encode_decode.json, and Solana's system program id.
    const vectors = [
      [Buffer.from('61', 'hex'), '2g'],
      [Buffer.from('626262', 'hex'), 'a3gV'],
      [Buffer.from('636363', 'hex'), 'aPEr'],
      [Buffer.from('simply a long string'), '2cFupjhnEsSn59qHXstmK2ffpLv2'],
      [Buffer.from('00eb15231dfceb60925886b67d065299925915aeb172c06647', 'hex'), '1NS17iag9jJgTHD1VXjvLCEnZuQ3rJDE9L'],
      [Buffer.from('516b6fcd0f', 'hex'), 'ABnLTmg'],
      [Buffer.from('bf4f89001e670274dd', 'hex'), '3SEo3LWLoPntC'],
      [Buffer.from('ecac89cad93923c02321', 'hex'), 'EJDM8drfXA6uyA'],
      [Buffer.from('00000000000000000000', 'hex'), '1111111111'],
      [Buffer.from('000000287fb4cd', 'hex'), '111233QC4'],
      [Buffer.alloc(32), '11111111111111111111111111111111'],
    ];
    for (const [bytes, text] of vectors) {
      assert.equal(proof.base58Encode(bytes), text);
      assert.equal(b58(bytes), text);
      assert.deepEqual(Buffer.from(proof.base58Decode(text)), bytes);
    }
    assert.equal(proof.base58Decode('0OIl'), null);

    // EIP-55's own examples.
    for (const a of [
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
      '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
      '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
      '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
    ]) {
      assert.equal(proof.toChecksumAddress(a.toLowerCase()), a);
      assert.deepEqual(proof.normalizeAddress('ethereum', a), { address: a });
      assert.deepEqual(proof.normalizeAddress('ethereum', a.toLowerCase()), { address: a });
      const wrong = a.replace(/[a-f]/, (c) => c.toUpperCase());
      assert.deepEqual(proof.normalizeAddress('ethereum', wrong), { error: 'bad_checksum' });
    }

    // web3.js's documented example: eth.accounts.sign('Some data', 0x4c08…2318).
    assert.equal(hex(proof.personalMessageHash('Some data')), '1da44b586eb0729ff70a73c326926f6ed5a25f5b056e7f47fbc6e58d86871655');
    const signature =
      '0xb91467e570a6466aa9e9876cbcd013baba02900b8979d43fe208a4a4f339f5fd6007e74cd82e037b800186422fc2da167c747ef045e5d18a5f5d4300f8e1a0291c';
    assert.equal(proof.recoverEthereumSigner('Some data', signature), '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23');
    // v as 0 or 1 is read as 27 or 28.
    assert.equal(proof.recoverEthereumSigner('Some data', `${signature.slice(0, -2)}01`), '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23');
    assert.equal(proof.recoverEthereumSigner('Some data', `${signature.slice(0, -2)}1d`), null);
  });
});

describe('binding a wallet', () => {
  test('an Ethereum address: the challenge is the one specified, and the signer is recovered', async () => {
    const a = await member('Heron');
    const w = ethWallet();
    // Sent in lower case, answered and signed for in EIP-55 form.
    const c = await a.call('uain_wallet_challenge', { chain: 'ethereum', address: w.address.toLowerCase() });
    assert.equal(c.address, w.address, JSON.stringify(c));
    assert.equal(c.member, a.address);
    assert.match(c.nonce, /^[0-9a-f]{32}$/);
    assert.equal(Date.parse(c.expires_at) - Date.parse(c.issued_at), 10 * 60_000);
    assert.equal(
      c.message,
      messageOf({ member: a.address, chain: 'ethereum', wallet: w.address, audience: origin(), nonce: c.nonce, issued: c.issued_at }),
    );
    assert.match(c.sign, /personal_sign/);
    assert.match(c.never_send, /never needs, and never asks for, a wallet's private key/);
    assert.match(c.note, NOTE);

    const r = await a.call('uain_wallet_bind', { chain: 'ethereum', address: w.address, message: c.message, signature: w.sign(c.message) });
    assert.equal(r.bound, true, JSON.stringify(r));
    assert.equal(r.address, w.address);
    assert.equal(r.replaced, null);
    assert.equal(typeof r.ledger_event, 'number');
    assert.equal(r.wallets.ethereum.address, w.address);
    assert.equal(r.wallets.solana, null);
    assert.match(r.wallets.note, NOTE);

    const b = await binding(r.binding);
    assert.equal(b.member, a.address);
    assert.equal(b.bound_by, a.id);
    assert.equal(b.message, c.message);
    assert.equal(b.signature, w.sign(c.message).toLowerCase());
    assert.equal(b.event_id, r.ledger_event);
    assert.equal(b.in_force, true);
    assert.equal(b.ended, null);
    // Anyone can check it: the signer recovered from the served record is the address.
    assert.equal(proof.recoverEthereumSigner(b.message, b.signature), w.address);
  });

  test('an Ethereum address whose case is not its EIP-55 checksum is refused', async () => {
    const a = await member('Egret');
    const w = ethWallet();
    const i = [...w.address].findIndex((ch, k) => k > 1 && /[a-fA-F]/.test(ch));
    const flip = (ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase());
    const wrong = w.address.slice(0, i) + flip(w.address[i]) + w.address.slice(i + 1);
    const c = await a.call('uain_wallet_challenge', { chain: 'ethereum', address: wrong });
    assert.equal(c.error, 'bad_checksum', JSON.stringify(c));
    assert.match(c.message, /EIP-55/);
    // Nor does a bind with a correct challenge accept it.
    const ok = await a.call('uain_wallet_challenge', { chain: 'ethereum', address: w.address });
    const r = await a.call('uain_wallet_bind', { chain: 'ethereum', address: wrong, message: ok.message, signature: w.sign(ok.message) });
    assert.equal(r.bound, false);
    assert.equal(r.error, 'bad_checksum');
  });

  test('a Solana address, over HTTP, checkable with node:crypto alone', async () => {
    const a = await member('Plover');
    const w = solWallet();
    const res = await post('/api/wallets/challenge', a.token, { chain: 'solana', address: w.address });
    assert.equal(res.status, 200);
    const c = await res.json();
    assert.equal(
      c.message,
      messageOf({ member: a.address, chain: 'solana', wallet: w.address, audience: origin(), nonce: c.nonce, issued: c.issued_at }),
    );
    assert.match(c.sign, /base58/);
    const bound = await post('/api/wallets', a.token, { chain: 'solana', address: w.address, message: c.message, signature: w.sign(c.message) });
    const r = await bound.json();
    assert.equal(bound.status, 200, JSON.stringify(r));
    assert.equal(r.bound, true);
    assert.equal(r.wallets.solana.address, w.address);

    const b = await binding(r.binding);
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: w.raw.toString('base64url') }, format: 'jwk' });
    const sig = Buffer.from(proof.base58Decode(b.signature));
    assert.equal(edVerify(null, Buffer.from(b.message, 'utf8'), key, sig), true);
    assert.equal(b.address, w.address);

    // Without a session, nothing.
    assert.equal((await post('/api/wallets', null, { chain: 'solana' })).status, 401);
    assert.equal((await post('/api/wallets/challenge', null, { chain: 'solana', address: w.address })).status, 401);
  });
});

describe('refused', () => {
  test('a signature from another key, or one that cannot be read; the challenge stays usable', async () => {
    const a = await member('Stilt');
    for (const [w, other] of [[ethWallet(), ethWallet()], [solWallet(), solWallet()]]) {
      const c = await a.call('uain_wallet_challenge', { chain: w.chain, address: w.address });
      const wrong = await a.call('uain_wallet_bind', { chain: w.chain, address: w.address, message: c.message, signature: other.sign(c.message) });
      assert.equal(wrong.error, 'wrong_signer', JSON.stringify(wrong));
      assert.equal(wrong.bound, false);
      // A signature over other text by the right key is no better.
      const other_text = await a.call('uain_wallet_bind', {
        chain: w.chain, address: w.address, message: c.message, signature: w.sign(`${c.message} `),
      });
      assert.equal(other_text.error, 'wrong_signer');
      const garbled = await a.call('uain_wallet_bind', { chain: w.chain, address: w.address, message: c.message, signature: 'not-a-signature' });
      assert.equal(garbled.error, 'bad_signature');
      // None of them used the challenge up.
      const right = await a.call('uain_wallet_bind', { chain: w.chain, address: w.address, message: c.message, signature: w.sign(c.message) });
      assert.equal(right.bound, true, JSON.stringify(right));
    }
    const res = await post('/api/wallets', a.token, { chain: 'ethereum', address: ethWallet().address, message: 'hello', signature: '0x00' });
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error, 'bad_message');
  });

  test('a challenge signed for another member, or naming another server', async () => {
    const a = await member('Curlew');
    const b = await member('Godwit');
    const w = ethWallet();
    const c = await a.call('uain_wallet_challenge', { chain: 'ethereum', address: w.address });
    const signature = w.sign(c.message);
    // B sends A's signed challenge as its own.
    const stolen = await b.call('uain_wallet_bind', { chain: 'ethereum', address: w.address, message: c.message, signature });
    assert.equal(stolen.error, 'wrong_member', JSON.stringify(stolen));
    const res = await post('/api/wallets', b.token, { chain: 'ethereum', address: w.address, message: c.message, signature });
    assert.equal(res.status, 403);

    // A message naming a look-alike server, properly signed, is refused here.
    const elsewhere = messageOf({
      member: a.address, chain: 'ethereum', wallet: w.address, audience: 'https://uain.example',
      nonce: randomBytes(16).toString('hex'), issued: new Date().toISOString(),
    });
    const r = await a.call('uain_wallet_bind', { chain: 'ethereum', address: w.address, message: elsewhere, signature: w.sign(elsewhere) });
    assert.equal(r.error, 'wrong_audience', JSON.stringify(r));
    assert.equal(r.audience_expected, origin());

    // A challenge for one address does not bind another, even signed by it.
    const v = ethWallet();
    const swapped = await a.call('uain_wallet_bind', { chain: 'ethereum', address: v.address, message: c.message, signature: v.sign(c.message) });
    assert.equal(swapped.error, 'message_mismatch');
    const chain = await a.call('uain_wallet_bind', { chain: 'solana', address: solWallet().address, message: c.message, signature: 'x' });
    assert.equal(chain.error, 'message_mismatch');

    // After all that, A's own challenge still binds, for A.
    const own = await a.call('uain_wallet_bind', { chain: 'ethereum', address: w.address, message: c.message, signature });
    assert.equal(own.bound, true, JSON.stringify(own));
    assert.equal((await b.call('uain_whoami')).wallets.ethereum, null);
  });

  test('a challenge used twice, never issued, or older than ten minutes', async () => {
    const a = await member('Knot');
    const w = solWallet();
    const c = await a.call('uain_wallet_challenge', { chain: 'solana', address: w.address });
    const signature = w.sign(c.message);
    assert.equal((await a.call('uain_wallet_bind', { chain: 'solana', address: w.address, message: c.message, signature })).bound, true);
    const again = await a.call('uain_wallet_bind', { chain: 'solana', address: w.address, message: c.message, signature });
    assert.equal(again.error, 'challenge_used', JSON.stringify(again));
    assert.equal((await post('/api/wallets', a.token, { chain: 'solana', address: w.address, message: c.message, signature })).status, 409);

    // A well-formed challenge this server never issued.
    const made = messageOf({
      member: a.address, chain: 'solana', wallet: w.address, audience: origin(),
      nonce: randomBytes(16).toString('hex'), issued: new Date().toISOString(),
    });
    const unknown = await a.call('uain_wallet_bind', { chain: 'solana', address: w.address, message: made, signature: w.sign(made) });
    assert.equal(unknown.error, 'challenge_unknown', JSON.stringify(unknown));

    // Issued eleven minutes ago: the stored challenge and its message both say so.
    const v = ethWallet();
    const old = await a.call('uain_wallet_challenge', { chain: 'ethereum', address: v.address });
    const issued = new Date(Date.now() - 11 * 60_000).toISOString();
    await t.db.query('UPDATE wallet_challenges SET issued_at = $1 WHERE nonce = $2', [issued, old.nonce]);
    const stale = messageOf({ member: a.address, chain: 'ethereum', wallet: v.address, audience: origin(), nonce: old.nonce, issued });
    const expired = await a.call('uain_wallet_bind', { chain: 'ethereum', address: v.address, message: stale, signature: v.sign(stale) });
    assert.equal(expired.error, 'challenge_expired', JSON.stringify(expired));
    const res = await post('/api/wallets', a.token, { chain: 'ethereum', address: v.address, message: stale, signature: v.sign(stale) });
    assert.equal(res.status, 410);
  });

  test('an address another member has bound', async () => {
    const a = await member('Dunlin');
    const b = await member('Sandpiper');
    for (const w of [ethWallet(), solWallet()]) {
      assert.equal((await bind(a, w)).bound, true);
      // The same key holder, signing properly, still cannot bind it to a second member.
      const r = await bind(b, w);
      assert.equal(r.error, 'wallet_taken', JSON.stringify(r));
      const c = await post('/api/wallets/challenge', b.token, { chain: w.chain, address: w.address });
      const { message } = await c.json();
      const res = await post('/api/wallets', b.token, { chain: w.chain, address: w.address, message, signature: w.sign(message) });
      assert.equal(res.status, 409);
    }
  });
});

describe('changing a binding', () => {
  test('rebinding replaces the address and keeps the old binding on the record; any agent of the member may; unbinding removes it', async () => {
    const a = await member('Turnstone');
    const second = await t.instance(a.key, 'Turnstone Labs', 'Turnstone-2');
    const w1 = ethWallet();
    const w2 = ethWallet();
    const first = await bind(a, w1);
    assert.equal(first.bound, true);

    // The member's other agent replaces it.
    const r = await bind(second, w2);
    assert.equal(r.bound, true, JSON.stringify(r));
    assert.deepEqual(r.replaced, { binding: first.binding, address: w1.address });
    assert.equal(r.wallets.ethereum.address, w2.address);
    const old = await binding(first.binding);
    assert.equal(old.in_force, false);
    assert.deepEqual(
      { how: old.ended.how, by: old.ended.by, event_id: old.ended.event_id, replaced_by: old.ended.replaced_by },
      { how: 'replaced', by: second.id, event_id: r.ledger_event, replaced_by: r.binding },
    );
    assert.deepEqual((await binding(r.binding)).replaces, { binding: first.binding, address: w1.address });

    // The address let go is free for another member.
    const b = await member('Whimbrel');
    assert.equal((await bind(b, w1)).bound, true);

    // Binding the address already bound changes nothing and records nothing.
    const head = (await t.db.query('SELECT MAX(id) AS id FROM events')).rows[0].id;
    const same = await bind(a, w2);
    assert.equal(same.bound, false);
    assert.equal(same.unchanged, true, JSON.stringify(same));
    assert.equal((await t.db.query('SELECT MAX(id) AS id FROM events')).rows[0].id, head);

    // Unbinding, by the first agent.
    const u = await a.call('uain_wallet_unbind', { chain: 'ethereum' });
    assert.equal(u.unbound, true, JSON.stringify(u));
    assert.equal(u.address, w2.address);
    assert.equal(u.wallets.ethereum, null);
    const ended = await binding(r.binding);
    assert.equal(ended.ended.how, 'unbound');
    assert.equal(ended.ended.by, a.id);
    assert.equal(ended.ended.event_id, u.ledger_event);
    const none = await a.call('uain_wallet_unbind', { chain: 'ethereum' });
    assert.equal(none.error, 'not_bound');
    assert.equal((await post('/api/wallets/unbind', a.token, { chain: 'solana' })).status, 404);
    assert.equal((await post('/api/wallets/unbind', a.token, { chain: 'bitcoin' })).status, 422);
  });
});

describe('reading', () => {
  test('the addresses appear on every public record of the member, with the note, to anyone', async () => {
    const a = await member('Avocet');
    const e = ethWallet();
    const s = solWallet();
    await bind(a, e);
    await bind(a, s);
    const anon = await t.connect();
    const expect = (wallets, where) => {
      assert.equal(wallets.ethereum.address, e.address, where);
      assert.equal(wallets.solana.address, s.address, where);
      assert.match(wallets.ethereum.proof, /^\/api\/wallets\/\d+$/, where);
      assert.match(wallets.note, NOTE, where);
    };
    expect((await (await t.http(`/api/members/${a.address}`)).json()).wallets, 'member');
    expect((await (await t.http(`/api/directory/${a.id}`)).json()).wallets, 'directory');
    expect((await anon.call('uain_participant', { id: a.id })).wallets, 'uain_participant');
    expect((await a.call('uain_whoami')).wallets, 'uain_whoami');

    // A member with none says so, with the same note.
    const b = await member('Oystercatcher');
    const none = (await (await t.http(`/api/members/${b.address}`)).json()).wallets;
    assert.equal(none.ethereum, null);
    assert.equal(none.solana, null);
    assert.match(none.note, NOTE);
    assert.equal((await t.http('/api/wallets/999999')).status, 404);

    // The descriptor and uain_describe point to it, and say nothing is paid.
    const d = await (await t.http('/api/descriptor')).json();
    assert.match(d.connection.fallback_http.wallet_bind, /POST .*\/api\/wallets$/);
    const described = await anon.call('uain_describe');
    assert.match(described.identity.wallets, /pays nothing to these addresses yet/);
    const { tools } = await anon.client.listTools();
    for (const name of ['uain_wallet_challenge', 'uain_wallet_bind', 'uain_wallet_unbind']) {
      const tool = tools.find((x) => x.name === name);
      assert.ok(tool, name);
      assert.match(tool.description, /UAIN holds no keys or funds/, name);
    }
  });
});

describe('the ledger', () => {
  test('bind, rebind and unbind are entries that commit the binding, its message and signature, and verify from outside', async () => {
    const a = await member('Ruff');
    const w1 = solWallet();
    const w2 = solWallet();
    const b1 = await bind(a, w1);
    const b2 = await bind(a, w2);
    const u = await a.call('uain_wallet_unbind', { chain: 'solana' });
    const entry = async (id) => (await t.db.query('SELECT * FROM events WHERE id = $1', [id])).rows[0];

    const bound = await entry(b1.ledger_event);
    assert.equal(bound.kind, 'wallet');
    assert.equal(bound.actor, a.id);
    assert.match(bound.summary, new RegExp(`bound Solana address ${w1.address} to its member`));
    assert.match(bound.commits, new RegExp(`^wallet ${b1.binding} sha256:[0-9a-f]{64}$`));

    const rebound = await entry(b2.ledger_event);
    assert.match(rebound.summary, new RegExp(`replaced Solana address ${w1.address} .* with ${w2.address}`));
    assert.match(rebound.commits, new RegExp(`^wallet ${b2.binding} sha256:`));

    const unbound = await entry(u.ledger_event);
    assert.match(unbound.summary, new RegExp(`removed Solana address ${w2.address} from its member`));
    assert.match(unbound.commits, new RegExp(`^wallet ${b2.binding} unbind sha256:`));

    // The committed digest is the record as served.
    const served = await binding(b1.binding);
    const { evidenceDigest } = await import('../dist/src/evidence/artifact-evidence.js');
    const digest = evidenceDigest({
      version: 1, record: 'wallet_binding', binding: served.id, member: served.member, chain: served.chain,
      address: served.address, message: served.message, signature: served.signature,
      bound_by: served.bound_by, bound_at: served.bound_at, replaces: served.replaces,
    });
    assert.equal(bound.commits, `wallet ${b1.binding} sha256:${digest}`);

    // The independent verifier recomputes every one of them.
    const ok = await verifyLedger();
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /PASS/);

    // A signature changed in the store after the fact fails it.
    const stored = served.signature;
    await t.db.query('UPDATE member_wallets SET proof_signature = $1 WHERE id = $2', [w2.sign('forged'), b1.binding]);
    const bad = await verifyLedger();
    assert.notEqual(bad.code, 0);
    assert.match(bad.stdout, new RegExp(`wallet ${b1.binding} does not match the digest`));
    await t.db.query('UPDATE member_wallets SET proof_signature = $1 WHERE id = $2', [stored, b1.binding]);
    assert.equal((await verifyLedger()).code, 0);
  });
});

const script = fileURLToPath(new URL('../scripts/verify-ledger.mjs', import.meta.url));
async function verifyLedger() {
  const clean = { ...process.env };
  delete clean.LEDGER_PUBLIC_KEY_FILE;
  delete clean.LEDGER_PUBLIC_KEY_PEM;
  return await new Promise((resolve) =>
    execFile(process.execPath, [script], { env: { ...clean, UAIN_API: t.base } }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr })));
}

describe('limits and secrets', () => {
  test('wallet calls are rate-limited per agent, as profile updates are', async () => {
    const a = await member('Snipe');
    const w = ethWallet();
    for (let i = 0; i < LIMIT; i++) {
      const c = await a.call('uain_wallet_challenge', { chain: 'ethereum', address: w.address });
      assert.ok(c.message, `call ${i + 1}: ${JSON.stringify(c)}`);
    }
    const over = await a.call('uain_wallet_challenge', { chain: 'ethereum', address: w.address });
    assert.equal(over.error, 'rate_limited');
    const res = await post('/api/wallets/challenge', a.token, { chain: 'ethereum', address: w.address });
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) > 0);
    // Another agent has its own allowance.
    const b = await member('Jacksnipe');
    assert.ok((await b.call('uain_wallet_challenge', { chain: 'ethereum', address: w.address })).message);
  });

  test('no private key, wallet or member, is stored, served or asked for; the UAIN key tool handles no wallet', async () => {
    assert.ok(secrets.length > 20);
    const forms = secrets.flatMap((s) => [hex(s), s.toString('base64'), s.toString('base64url'), b58(s)]);
    // Everything the store holds, table by table.
    const { rows: tables } = await t.db.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
    let dump = '';
    for (const { tablename } of tables)
      dump += (await t.db.query(`SELECT to_jsonb(x)::text AS row FROM "${tablename}" x`)).rows.map((r) => r.row).join('\n');
    // And what the public reads serve.
    dump += await (await t.http('/api/events?limit=500')).text();
    for (const m of members) {
      dump += await (await t.http(`/api/members/${m.key.address}`)).text();
      dump += JSON.stringify(await m.call('uain_whoami'));
    }
    const { rows: ids } = await t.db.query('SELECT id FROM member_wallets');
    for (const { id } of ids) dump += await (await t.http(`/api/wallets/${id}`)).text();
    assert.ok(ids.length >= 15);
    const lower = dump.toLowerCase();
    for (const f of forms) assert.equal(lower.includes(f.toLowerCase()), false, 'a private key appears in the store or a public read');

    // No wallet tool takes a key, seed or keystore.
    const { tools } = await (await t.connect()).client.listTools();
    for (const tool of tools.filter((x) => x.name.startsWith('uain_wallet_')))
      for (const field of Object.keys(tool.inputSchema.properties ?? {}))
        assert.doesNotMatch(field, /private|secret|seed|mnemonic|keystore/i, `${tool.name}.${field}`);

    const keyTool = readFileSync(new URL('../../../public/worker/uain-key.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(keyTool, /secp256k1|keccak|wallet|solana|ethereum/i);
  });
});

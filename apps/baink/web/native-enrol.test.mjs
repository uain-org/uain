import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { createIdentity } from './identity.js';
import { signingBytes } from '../../../chain/client/signing.mjs';
import {
  nativeEnrolSigningBytes,
  signNativeEnrolIntent,
} from './native-enrol.js';

const epoch = '1'.repeat(64);
const chainId = 'baink-test-chain';
async function fixture() {
  const identity = await createIdentity();
  const payload = {
    name: 'Research <AI> & team\u2028research',
    operator: 'Responsible operator',
    family: 'Test system',
  };
  const command = {
    version: 1,
    chain_id: chainId,
    member: identity.address,
    sequence: '0',
    expires_height: '200',
    operation: 'enrol',
    payload,
  };
  const intent = {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'prepared',
    command,
    publicKey: identity.publicKeyBase64
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', ''),
    signingBytesBase64: signingBytes(command).toString('base64'),
    proof: {
      authority: 'native',
      chainId,
      height: '100',
      headerTime: new Date().toISOString(),
      maxAgeSeconds: 120,
      epoch,
      genesisSha256: epoch,
      verifierSha256: '2'.repeat(64),
    },
  };
  return {
    identity,
    payload,
    intent,
    options: { chainId, genesisSha256: epoch, expectedPayload: payload },
  };
}

test('browser native enrol serialization matches the existing native client, including Go string escaping', async () => {
  const { intent } = await fixture();
  assert.deepEqual(
    Buffer.from(nativeEnrolSigningBytes(intent.command)),
    signingBytes(intent.command),
  );
  const bytes = Buffer.from(nativeEnrolSigningBytes(intent.command)).toString();
  assert.ok(
    bytes.startsWith('uain:chain-command:v1\n{"version":1,"chain_id":'),
  );
  assert.ok(bytes.includes('\\u003cAI\\u003e \\u0026'));
  assert.ok(bytes.includes('\\u2028'));
});

test('the browser signs the reviewed enrol command locally and returns only its public native envelope', async () => {
  const { identity, intent, options } = await fixture();
  const envelope = await signNativeEnrolIntent(identity, intent, options);
  assert.deepEqual(Object.keys(envelope).sort(), [
    'command',
    'public_key',
    'signature',
  ]);
  assert.equal(envelope.public_key, intent.publicKey);
  assert.deepEqual(envelope.command, intent.command);
  const key = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: envelope.public_key },
    format: 'jwk',
  });
  assert.ok(
    verify(
      null,
      signingBytes(envelope.command),
      key,
      Buffer.from(envelope.signature, 'base64url'),
    ),
  );
});

test('native enrol signing rejects server challenge substitution and unreviewed operation, identity or payload changes', async () => {
  const changes = [
    (i) =>
      (i.signingBytesBase64 = Buffer.from('sign something else').toString(
        'base64',
      )),
    (i) => (i.command.operation = 'coin_reserve'),
    (i) => (i.command.chain_id = 'another-chain'),
    (i) => (i.command.member = 'uain1' + 'a'.repeat(40)),
    (i) => (i.command.sequence = '1'),
    (i) => (i.command.expires_height = '201'),
    (i) => (i.command.expires_height = '100'),
    (i) => (i.command.instance = 'unexpected-instance'),
    (i) => (i.command.payload.operator = 'Other operator'),
    (i) => (i.command.payload.role = 'guardian'),
    (i) => (i.publicKey = 'A'.repeat(43)),
    (i) => (i.status = 'unknown'),
  ];
  for (const change of changes) {
    const { identity, intent, options } = await fixture();
    change(intent);
    await assert.rejects(signNativeEnrolIntent(identity, intent, options));
  }
});

test('native enrol signing rejects stale, wrong-epoch or unverified signing context', async () => {
  for (const change of [
    (i) => (i.proof.headerTime = '2020-01-01T00:00:00Z'),
    (i) => (i.proof.epoch = '3'.repeat(64)),
    (i) => (i.proof.genesisSha256 = '3'.repeat(64)),
    (i) => (i.proof.authority = 'unverified'),
    (i) => (i.proof.chainId = 'another-chain'),
    (i) => (i.proof.maxAgeSeconds = 10000),
  ]) {
    const { identity, intent, options } = await fixture();
    change(intent);
    await assert.rejects(signNativeEnrolIntent(identity, intent, options));
  }
});

test('native enrol rejects unpaired Unicode and UTF-8 fields beyond the chain limits', async () => {
  const { intent } = await fixture();
  intent.command.payload.name = '\ud800';
  assert.throws(() => nativeEnrolSigningBytes(intent.command));
  intent.command.payload.name = '界'.repeat(41);
  assert.throws(() => nativeEnrolSigningBytes(intent.command));
});

test('a mismatched local private key cannot produce an accepted native enrol envelope', async () => {
  const { identity, intent, options } = await fixture();
  const other = await createIdentity();
  await assert.rejects(
    signNativeEnrolIntent(
      { ...identity, privateKey: other.privateKey },
      intent,
      options,
    ),
  );
});

test('native public profile control characters are refused before local signing', async () => {
  const { intent } = await fixture();
  for (const name of ['Bad\nname', 'Bad\u0000name', 'Bad\u007fname']) {
    intent.command.payload.name = name;
    assert.throws(() => nativeEnrolSigningBytes(intent.command));
  }
});

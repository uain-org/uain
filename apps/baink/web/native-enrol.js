import { base64 } from './identity.js';
import { nativeProofFreshness } from './native-balance.js';
const enc = new TextEncoder();
const commandFields = [
  'version',
  'chain_id',
  'member',
  'sequence',
  'expires_height',
  'operation',
  'payload',
];
const payloadFields = ['name', 'operator', 'family'];
const url64 = (value) =>
  value.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
function requireCondition(ok, message) {
  if (!ok) throw new Error(message);
}
function exactFields(value, fields) {
  return (
    value &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === fields.length &&
    fields.every((key) => Object.hasOwn(value, key))
  );
}
function jsonString(value) {
  requireCondition(
    typeof value === 'string' &&
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        value,
      ),
    'Invalid native text',
  );
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}
function validatePayload(payload) {
  requireCondition(
    exactFields(payload, payloadFields),
    'Unexpected native profile fields',
  );
  for (const [field, minimum, maximum] of [
    ['name', 2, 120],
    ['operator', 2, 200],
    ['family', 0, 100],
  ]) {
    const value = payload[field];
    jsonString(value);
    requireCondition(
      value === value.trim() &&
        !/[\u0000-\u001f\u007f]/.test(value) &&
        enc.encode(value).length >= minimum &&
        enc.encode(value).length <= maximum,
      'Native profile field exceeds its limits',
    );
  }
}
export function nativeEnrolSigningBytes(command) {
  requireCondition(
    exactFields(command, commandFields),
    'Unexpected native command fields',
  );
  requireCondition(
    command.version === 1 &&
      command.operation === 'enrol' &&
      typeof command.chain_id === 'string' &&
      command.chain_id.length > 0 &&
      /^uain1[0-9a-f]{40}$/.test(command.member) &&
      command.sequence === '0',
    'Only a new membership enrolment can be signed here',
  );
  requireCondition(
    typeof command.expires_height === 'string' &&
      /^[1-9][0-9]*$/.test(command.expires_height) &&
      BigInt(command.expires_height) <= 9223372036854775807n,
    'Invalid native command expiry',
  );
  validatePayload(command.payload);
  const payload =
    '{' +
    [...payloadFields]
      .sort()
      .map((key) => jsonString(key) + ':' + jsonString(command.payload[key]))
      .join(',') +
    '}';
  return enc.encode(
    'uain:chain-command:v1\n{' +
      commandFields
        .map(
          (key) =>
            jsonString(key) +
            ':' +
            (key === 'payload'
              ? payload
              : key === 'version'
                ? '1'
                : jsonString(command[key])),
        )
        .join(',') +
      '}',
  );
}
/** The browser reconstructs the reviewed operation; server bytes alone are never signing authority. */
export async function signNativeEnrolIntent(
  identity,
  intent,
  { chainId, genesisSha256, expectedPayload, now = Date.now() } = {},
) {
  requireCondition(
    intent?.status === 'prepared',
    'Only a prepared membership intent can be signed',
  );
  const proof = intent.proof;
  requireCondition(
    typeof chainId === 'string' &&
      chainId.length > 0 &&
      /^[0-9a-f]{64}$/.test(genesisSha256) &&
      proof?.chainId === chainId &&
      proof.epoch === genesisSha256 &&
      proof.genesisSha256 === genesisSha256 &&
      /^[0-9a-f]{64}$/.test(proof.verifierSha256) &&
      nativeProofFreshness(proof, { now }).fresh,
    'Native signing context is not current or trusted',
  );
  requireCondition(
    typeof proof.height === 'string' && /^[1-9][0-9]*$/.test(proof.height),
    'Invalid native proof height',
  );
  const bytes = nativeEnrolSigningBytes(intent.command);
  requireCondition(
    intent.command.chain_id === chainId &&
      intent.command.member === identity.address,
    'Native command identity does not match',
  );
  const expiry = BigInt(intent.command.expires_height),
    height = BigInt(proof.height);
  requireCondition(
    expiry > height && expiry <= height + 100n,
    'Native command expiry is outside the reviewed window',
  );
  validatePayload(expectedPayload);
  requireCondition(
    payloadFields.every(
      (key) => expectedPayload[key] === intent.command.payload[key],
    ),
    'Native profile differs from your reviewed details',
  );
  const raw = new Uint8Array(
    await crypto.subtle.exportKey('raw', identity.publicKey),
  );
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  const address =
    'uain1' +
    Array.from(hash, (b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 40);
  requireCondition(
    raw.length === 32 &&
      address === identity.address &&
      base64(raw) === identity.publicKeyBase64 &&
      url64(base64(raw)) === intent.publicKey,
    'Native public key does not match this identity',
  );
  requireCondition(
    base64(bytes) === intent.signingBytesBase64,
    'Native signing challenge does not match the reviewed command',
  );
  const signature = await crypto.subtle.sign(
    'Ed25519',
    identity.privateKey,
    bytes,
  );
  requireCondition(
    await crypto.subtle.verify('Ed25519', identity.publicKey, signature, bytes),
    'Local signing keys do not match',
  );
  return {
    command: structuredClone(intent.command),
    public_key: intent.publicKey,
    signature: url64(base64(signature)),
  };
}

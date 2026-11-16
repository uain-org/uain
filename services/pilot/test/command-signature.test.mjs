// The one check of a native command envelope's own signature
// (native/command-signature.ts), used by the publication gate and by the
// retained-epoch archive (13 November 2026).
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { verifiedCommand } from '../dist/src/native/command-signature.js';
import { canonical } from '../dist/src/native/evidence.js';

function envelope({ instance } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const member = 'uain1' + createHash('sha256').update(raw).digest('hex').slice(0, 40);
  const command = { version: 1, chain_id: 'fixture', member, sequence: '3', expires_height: '100', operation: 'submit', payload: { evidence_digest: 'e', id: 'C-1', task: 'T-1' }, ...(instance ? { instance } : {}) };
  const fields = ['version', 'chain_id', 'member', 'sequence', 'expires_height', 'operation', 'payload', ...(instance ? ['instance'] : [])];
  const bytes = Buffer.from('uain:chain-command:v1\n{' + fields.map((f) => canonical(f) + ':' + canonical(command[f])).join(',') + '}');
  return { env: { command, public_key: raw.toString('base64url'), signature: sign(null, bytes, privateKey).toString('base64url') }, bytes, member };
}

test('a validly signed envelope yields its member and signed bytes', () => {
  for (const options of [{}, { instance: 'agent-1' }]) {
    const { env, bytes, member } = envelope(options);
    const r = verifiedCommand(env);
    assert.equal(r?.member, member);
    assert.deepEqual(r.bytes, bytes);
  }
});

test('tampering, a forged signature, a foreign key or a wrong shape is refused', () => {
  const { env } = envelope(), other = envelope();
  for (const bad of [
    { ...env, command: { ...env.command, sequence: '4' } },
    { ...env, signature: Buffer.alloc(64, 1).toString('base64url') },
    { ...env, public_key: other.env.public_key },
    { ...other.env, command: { ...other.env.command, member: env.command.member } },
    { ...env, command: { ...env.command, extra: 1 } },
    { command: env.command, public_key: env.public_key },
    { public_key: env.public_key }, null, 'x', [],
  ]) assert.equal(verifiedCommand(bad), null, JSON.stringify(bad)?.slice(0, 80));
});

/** Byte formats for no-install sending, local to the standalone BAINK release
 * (which ships without the repository's chain/client). They match
 * chain/client/signing.mjs signingBytes and chain/client/coin-boundary.mjs
 * coinBoundaryApprovalBytes byte for byte; test/server-send.test.mjs checks it. */
import { createHash } from 'node:crypto';
import { canonicalJSON } from './native-financial-command.mjs';

export { canonicalJSON };
const COIN_POLICY = 'verified-bounties-108t-micro-v1';
const sha = value => createHash('sha256').update(value).digest();
const fail = message => { throw new Error(message); };

/** `uain:chain-command:v1` signing bytes for a version-1 native command. */
export function chainCommandSigningBytes(command) {
  const fields = ['version', 'chain_id', 'member', 'sequence', 'expires_height', 'operation', 'payload'];
  if (!command || typeof command !== 'object' || Object.keys(command).length !== fields.length || fields.some(k => !Object.hasOwn(command, k))) fail('invalid command fields');
  if (command.version !== 1 || typeof command.chain_id !== 'string' || !/^uain1[0-9a-f]{40}$/.test(command.member)) fail('invalid command identity');
  if (typeof command.sequence !== 'string' || !/^(0|[1-9][0-9]*)$/.test(command.sequence) || BigInt(command.sequence) > 18446744073709551615n) fail('invalid sequence');
  if (typeof command.expires_height !== 'string' || !/^[1-9][0-9]*$/.test(command.expires_height) || BigInt(command.expires_height) > 9223372036854775807n) fail('invalid expiration height');
  if (typeof command.operation !== 'string') fail('invalid operation');
  return Buffer.from('uain:chain-command:v1\n{' + fields.map(k => canonicalJSON(k) + ':' + canonicalJSON(command[k])).join(',') + '}');
}

function u64(value, max, zero = false) {
  if (typeof value !== 'string' || !(zero ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/).test(value) || value.length > 20 || BigInt(value) > max) fail('canonical bounded decimal boundary units required');
  const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(value)); return b;
}
const hex32 = value => { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail('invalid boundary digest'); return Buffer.from(value, 'hex'); };

/** The bytes the boundary checker signs (consensus: CoinBoundaryApprovalBytes). */
export function coinBoundaryApprovalBytes(context, boundary, classification) {
  if (context.version !== 1 || typeof context.chain !== 'string' || !context.chain.length || context.chain.length > 128) fail('invalid boundary chain');
  const cls = classification === 'benevolent' ? 1 : classification === 'neutral' ? 2 : 0;
  if (!cls) fail('explicit benevolent/neutral review required');
  if (!['shield', 'exit'].includes(boundary.direction) || typeof boundary.member !== 'string' || !/^uain1[0-9a-f]{40}$/.test(boundary.member)) fail('invalid boundary owner/direction');
  return Buffer.concat([
    Buffer.from('UAIN/coin-boundary/approval/v1\0'), sha(COIN_POLICY), sha(context.chain),
    u64(context.expires, 0x7fffffffffffffffn), u64(context.licenceRevision, 0xffffffffffffffffn, true),
    hex32(context.effects), hex32(context.purpose), Buffer.from([cls, 1]), hex32(context.reviewer),
    Buffer.from([boundary.direction === 'shield' ? 1 : 2]), Buffer.from(boundary.member.slice(5), 'hex'), u64(boundary.amount, 0x7fffffffffffffffn),
  ]);
}

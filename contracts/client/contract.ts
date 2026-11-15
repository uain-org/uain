import { createHash } from 'node:crypto';
import { isAddress, type Abi, type Address, type Hex } from 'viem';
export interface Artifact {
  abi: Abi; bytecode: Hex; deployedBytecode: Hex;
  immutableReferences: Record<string, { start: number; length: number }[]>;
  compiler: string;
}
export interface Identity { chainId: number; code: Hex | undefined; owner: Address; anchorer: Address }
export function assertTestnet(chainId: number): void {
  if (chainId !== 84532) throw new Error('Only Base Sepolia (84532) is enabled');
}
export function address(value: string | undefined): Address {
  if (!value || !isAddress(value, { strict: false }) || /^0x0{40}$/i.test(value)) throw new Error('A nonzero EVM address is required');
  return value.toLowerCase() as Address;
}
export function artifactHash(artifact: Artifact): string {
  return createHash('sha256').update(JSON.stringify(artifact)).digest('hex');
}
/** LedgerAnchor has exactly one immutable variable, its constructor's owner. */
export function expectedRuntime(artifact: Artifact, owner: Address): Hex {
  address(owner);
  if (!/^0x(?:[a-f0-9]{2})+$/i.test(artifact.deployedBytecode) || !artifact.compiler.startsWith('0.8.26+')) throw new Error('Invalid pinned compiler artifact');
  const groups = Object.values(artifact.immutableReferences);
  if (groups.length !== 1 || !groups[0]?.length) throw new Error('Unexpected immutable layout');
  const code = Buffer.from(artifact.deployedBytecode.slice(2), 'hex');
  const patched = new Set<number>();
  for (const { start, length } of groups[0]) {
    if (!Number.isSafeInteger(start) || start < 0 || length !== 32 || start + length > code.length || patched.has(start)) throw new Error('Invalid immutable position');
    Buffer.from(owner.slice(2).padStart(64, '0'), 'hex').copy(code, start);
    patched.add(start);
  }
  return `0x${code.toString('hex')}`;
}
export function verifyIdentity(artifact: Artifact, identity: Identity, expectedOwner: Address, expectedAnchorer?: Address): void {
  assertTestnet(identity.chainId);
  if (!identity.code || identity.code.toLowerCase() !== expectedRuntime(artifact, expectedOwner)) throw new Error('Deployed runtime does not match the compiled LedgerAnchor and owner');
  if (address(identity.owner) !== address(expectedOwner)) throw new Error('Contract owner mismatch');
  address(identity.anchorer);
  if (expectedAnchorer && address(identity.anchorer) !== address(expectedAnchorer)) throw new Error('Contract anchorer mismatch');
}

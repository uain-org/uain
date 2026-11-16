import { createHash } from 'node:crypto';
import { encodeDeployData, getContractAddress, type Address, type Hex } from 'viem';
import { address, artifactHash, assertTestnet, expectedRuntime, type Artifact } from './contract.js';

export interface DeploymentPlan {
  chainId: 84532; owner: Address; anchorer: Address; nonce: number;
  address: Address; data: Hex; artifactHash: string; fingerprint: string;
}
export function prepareDeployment(artifact: Artifact, input: { owner: string; anchorer: string; nonce: number; chainId: number }): DeploymentPlan {
  assertTestnet(input.chainId);
  const owner = address(input.owner), anchorer = address(input.anchorer);
  if (!Number.isSafeInteger(input.nonce) || input.nonce < 0) throw new Error('Invalid deployment nonce');
  expectedRuntime(artifact, owner);
  const fields = {
    chainId: 84532 as const, owner, anchorer, nonce: input.nonce,
    address: getContractAddress({ from: owner, nonce: BigInt(input.nonce) }),
    data: encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: [anchorer] }),
    artifactHash: artifactHash(artifact),
  };
  return { ...fields, fingerprint: createHash('sha256').update(JSON.stringify(fields)).digest('hex') };
}

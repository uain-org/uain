/**
 * A minimal in-process EVM for the contract tests: deploy, call, send, and
 * read logs and revert reasons, with ABI coding done by viem. No node, no
 * network, no Foundry.
 */
import { Common, Hardfork, Mainnet } from '@ethereumjs/common';
import { Address, bytesToHex, hexToBytes } from '@ethereumjs/util';
import { createVM } from '@ethereumjs/vm';
import {
  decodeErrorResult,
  decodeEventLog,
  decodeFunctionResult,
  encodeDeployData,
  encodeFunctionData,
} from 'viem';
import { compile } from '../scripts/compile.mjs';

let artefacts;
const extra = {};
export const artefact = (name) => {
  artefacts ??= compile();
  return extra[name] ?? artefacts[name];
};

/** Make artefacts compiled by a test itself (the draft token) deployable here. */
export const registerArtefacts = (more) => Object.assign(extra, more);

/** Deterministic test accounts: 0x…01, 0x…02, and so on. */
export const account = (n) => `0x${n.toString(16).padStart(40, '0')}`;

export async function newChain(initialTimestamp = 1_790_000_000n) {
  const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun });
  const vm = await createVM({ common });
  let timestamp = initialTimestamp;

  async function exec({ from, to, data }) {
    timestamp += 12n;
    const result = await vm.evm.runCall({
      caller: new Address(hexToBytes(from)),
      origin: new Address(hexToBytes(from)),
      to: to ? new Address(hexToBytes(to)) : undefined,
      data: hexToBytes(data),
      gasLimit: 10_000_000n,
      block: { header: { timestamp, number: timestamp / 12n } },
    });
    return result;
  }

  async function deploy(name, from, args = []) {
    const { abi, bytecode } = artefact(name);
    const r = await exec({ from, data: encodeDeployData({ abi, bytecode, args }) });
    if (r.execResult.exceptionError) throw new Error(`deploy ${name} failed: ${r.execResult.exceptionError.error}`);
    return contract(name, r.createdAddress.toString());
  }

  function contract(name, address) {
    const { abi } = artefact(name);
    return {
      address,
      abi,
      /** Read-only call; returns the decoded result. */
      async read(functionName, args = [], from = account(0xdead)) {
        const r = await exec({ from, to: address, data: encodeFunctionData({ abi, functionName, args }) });
        if (r.execResult.exceptionError) throw revertError(abi, r);
        return decodeFunctionResult({ abi, functionName, data: bytesToHex(r.execResult.returnValue) });
      },
      /** State-changing call; returns { logs } or throws with the custom error name. */
      async send(functionName, args = [], from) {
        const r = await exec({ from, to: address, data: encodeFunctionData({ abi, functionName, args }) });
        if (r.execResult.exceptionError) throw revertError(abi, r);
        const logs = (r.execResult.logs ?? []).map(([, topics, data]) =>
          decodeEventLog({ abi, topics: topics.map((t) => bytesToHex(t)), data: bytesToHex(data) }),
        );
        return { logs };
      },
    };
  }

  return { deploy, getCode: async address => bytesToHex(await vm.stateManager.getCode(new Address(hexToBytes(address)))) };
}

function revertError(abi, r) {
  const data = bytesToHex(r.execResult.returnValue);
  try {
    const decoded = decodeErrorResult({ abi, data });
    const e = new Error(`reverted: ${decoded.errorName}`);
    e.errorName = decoded.errorName;
    e.args = decoded.args;
    return e;
  } catch {
    const e = new Error(`reverted: ${r.execResult.exceptionError.error} ${data}`);
    e.errorName = 'unknown';
    return e;
  }
}

/** Resolves to the error name a promise rejected with. */
export async function revertsWith(promise) {
  try {
    await promise;
  } catch (e) {
    return e.errorName;
  }
  return null;
}

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, encodeFunctionData, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { address, artifactHash, assertTestnet, verifyIdentity, type Artifact } from './contract.js';
import { prepareDeployment } from './deployment.js';
import { auditRoot, catchupStart, compareAnchor, dateWindows, executeAnchors, planCatchup, type AnchorPort, type StoredAnchor } from './anchoring.js';
import { anchorParameters, dateForDay, dayNumber, validateRoot, type SignedRoot } from './root.js';
import { recoverOperation, runOperation, withJournal } from './journal.js';
import { apiOrigin, fetchJsonRetry } from './http.js';
import { publishRoot } from './publication.js';
import { checkInclusion, validateProof } from './proof.js';
import { assertDevnet, mirrorAddress, mirroredDays, mirrorRoots, planMirror, readMirrorKey, recoverMirror, rpcPort, solanaRpcUrl } from './solana.js';

const required = (name: string): string => {
  const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value;
};
const COMMANDS = ['deploy', 'catchup', 'anchor', 'recover-anchor', 'audit', 'publish', 'prove', 'solana-mirror', 'solana-audit', 'solana-recover'];
export function parseArguments(args: string[]): { command: string; send: boolean; recover: boolean; values: Record<string, string> } {
  const command = args[0];
  if (!command || !COMMANDS.includes(command)) throw new Error('Expected deploy, catchup, anchor, recover-anchor, audit, publish, prove, solana-mirror, solana-audit or solana-recover');
  let send = false, recover = false;
  const values: Record<string, string> = {};
  const allowed: Record<string, string[]> = { deploy: ['nonce'], catchup: ['from', 'to', 'limit'], anchor: ['date'], 'recover-anchor': ['date'], audit: ['from', 'to'], publish: ['date', 'out', 'input'], prove: ['id'], 'solana-mirror': ['from', 'to', 'limit'], 'solana-audit': ['from', 'to'], 'solana-recover': [] };
  for (let i = 1; i < args.length; i++) {
    const option = args[i];
    if (option === '--send' && !send) { send = true; continue; }
    if (option === '--recover' && !recover) { recover = true; continue; }
    const name = option?.slice(2);
    if (!option?.startsWith('--') || !name || !allowed[command]?.includes(name) || values[name] !== undefined || !args[i + 1] || args[i + 1]?.startsWith('--')) throw new Error('Unknown, duplicate or incomplete option');
    values[name] = args[++i]!;
  }
  if ((send && !['deploy', 'catchup', 'anchor', 'solana-mirror'].includes(command)) || (recover && command !== 'deploy') || (send && recover)) throw new Error('Invalid mutation/recovery flags');
  return { command, send, recover, values };
}
function unsigned(value: string, name: string, allowZero = false): bigint {
  if (!/^\d+$/.test(value) || (!allowZero && BigInt(value) === 0n)) throw new Error(`Invalid ${name}`);
  return BigInt(value);
}
function fees() {
  const gas = unsigned(required('ANCHOR_MAX_GAS'), 'ANCHOR_MAX_GAS');
  const maxFeePerGas = unsigned(required('ANCHOR_MAX_FEE_WEI'), 'ANCHOR_MAX_FEE_WEI');
  const maxPriorityFeePerGas = unsigned(required('ANCHOR_PRIORITY_FEE_WEI'), 'ANCHOR_PRIORITY_FEE_WEI', true);
  if (maxPriorityFeePerGas > maxFeePerGas) throw new Error('Priority fee exceeds maximum fee');
  return { gas, maxFeePerGas, maxPriorityFeePerGas };
}
function publicClient() {
  const rpc = required('BASE_SEPOLIA_RPC');
  const parsed = new URL(rpc);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) throw new Error('RPC requires HTTPS or loopback HTTP');
  return createPublicClient({ transport: http(rpc, { retryCount: 0, timeout: 15_000 }) });
}
function wallet(name: string) {
  const key = required(name);
  if (!/^0x[0-9a-f]{64}$/i.test(key)) throw new Error(`Invalid ${name}`);
  const account = privateKeyToAccount(key as Hex);
  return createWalletClient({ account, chain: baseSepolia, transport: http(required('BASE_SEPOLIA_RPC'), { retryCount: 0, timeout: 15_000 }) });
}
const artifactFile = fileURLToPath(new URL('../build/LedgerAnchor.json', import.meta.url));
/** Provider errors may contain authenticated RPC URLs; expose only our own messages. */
export function failureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/^Missing [A-Z_]+$/.test(message) || /^(Expected deploy, catchup, anchor, recover-anchor, audit, publish, prove, solana-mirror, solana-audit or solana-recover|Only Solana devnet is enabled|Invalid event id|Proof is for another event|Event hash differs from the proof leaf|Proof root differs from the signed root|Proof leaf count differs from the signed root|Event lies outside the signed day|Inclusion proof does not reach the signed root|Proof step is on the wrong side for its index|Proof path is (longer|shorter) than the tree|Mirrored memo conflicts with the signed root; refusing a replacement|Two mirrored memos for one day|A mirrored memo is malformed|Mirror balance is too low for the batch|Mirror transaction (failed on-chain|expired without landing; use solana-recover|not confirmed in time; use solana-recover)|Mirror memo read-back differs|Mirror batch must be chronological|Journal already holds this day; inspect the chain|Solana keypair file is inconsistent|Mirror key differs from SOLANA_MIRROR_ADDRESS|Unknown, duplicate or incomplete option|Invalid mutation\/recovery flags|Only Base Sepolia \(84532\) is enabled|Ledger root signature does not match the pinned key|A completed, final UTC day is required|Journal is locked; inspect the previous process before recovery|Journal contains an uncertain operation; read-only recovery is required|Earlier final roots are waiting; use catchup to preserve chronological coverage|On-chain anchor conflict; refusing a replacement|Deployed runtime does not match the compiled LedgerAnchor and owner|Wallet is not the contract anchorer|Deployment already recorded; use --recover instead of sending again)$/.test(message)) return message;
  return 'Check configuration, pinned root and journal/chain state';
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  const { command, send, recover, values } = parseArguments(args);
  const artifact = JSON.parse(readFileSync(artifactFile, 'utf8')) as Artifact;
  const usesContract = ['deploy', 'catchup', 'anchor', 'recover-anchor', 'audit'].includes(command) || (command === 'prove' && !!process.env.LEDGER_ANCHOR_ADDRESS);
  const owner = usesContract ? address(required('LEDGER_OWNER_ADDRESS')) : undefined;
  const journalFile = resolve(process.env.ANCHOR_JOURNAL ?? fileURLToPath(new URL('../../work/blockchain/operations.json', import.meta.url)));
  const yesterday = dateForDay(Math.floor(Date.now() / 86_400_000) - 1);

  if (command === 'deploy') {
    const nonceValue = unsigned(values.nonce ?? required('DEPLOY_NONCE'), 'nonce', true);
    const nonce = Number(nonceValue);
    if (!Number.isSafeInteger(nonce)) throw new Error('Invalid deployment nonce');
    const plan = prepareDeployment(artifact, { owner: owner!, anchorer: required('ANCHORER_ADDRESS'), nonce, chainId: 84532 });
    console.log(JSON.stringify(plan, null, 2));
    if (!send && !recover) return;
    const client = publicClient(); assertTestnet(await client.getChainId());
    const verify = async () => {
      const blockNumber = await client.getBlockNumber();
      const [code, actualOwner, actualAnchorer] = await Promise.all([
        client.getCode({ address: plan.address, blockNumber }),
        client.readContract({ address: plan.address, abi: artifact.abi, functionName: 'owner', blockNumber }),
        client.readContract({ address: plan.address, abi: artifact.abi, functionName: 'anchorer', blockNumber }),
      ]);
      verifyIdentity(artifact, { chainId: 84532, code, owner: address(String(actualOwner)), anchorer: address(String(actualAnchorer)) }, plan.owner, plan.anchorer);
    };
    const confirm = async (hash: Hex) => {
      const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 120_000, pollingInterval: 2_000 });
      if (receipt.status !== 'success' || receipt.contractAddress?.toLowerCase() !== plan.address.toLowerCase()) throw new Error('Deployment receipt mismatch or revert');
      await verify();
    };
    await withJournal(journalFile, async journal => {
      if (recover) {
        await recoverOperation(journal, 'deploy', plan.fingerprint, async op => {
          if (op.hash) await confirm(op.hash);
          else {
            // No hash: require the predicted address to have the exact intended
            // runtime at a block with two confirmations, then check latest roles.
            const tip = await client.getBlockNumber();
            if (tip < 2n) throw new Error('Deployment cannot yet be recovered from confirmed chain state');
            const code = await client.getCode({ address: plan.address, blockNumber: tip - 1n });
            verifyIdentity(artifact, { chainId: 84532, code, owner: plan.owner, anchorer: plan.anchorer }, plan.owner);
            await verify();
          }
        });
        console.log('Deployment recovered by read-only verification'); return;
      }
      if (journal.data.operations.deploy) throw new Error('Deployment already recorded; use --recover instead of sending again');
      if (await client.getCode({ address: plan.address })) throw new Error('Predicted deployment address already contains code');
      const signer = wallet('OWNER_PRIVATE_KEY');
      if (signer.account.address.toLowerCase() !== plan.owner) throw new Error('Deployment signer differs from owner');
      if (await client.getTransactionCount({ address: plan.owner, blockTag: 'pending' }) !== plan.nonce) throw new Error('Pending deployment nonce differs from plan');
      const limits = fees();
      const estimate = await client.estimateGas({ account: signer.account, data: plan.data });
      if (estimate > limits.gas || await client.getBalance({ address: plan.owner }) < limits.gas * limits.maxFeePerGas) throw new Error('Deployment gas cap or balance insufficient');
      await runOperation(journal, 'deploy', plan.fingerprint, () => signer.sendTransaction({ data: plan.data, nonce: plan.nonce, ...limits }), confirm);
      console.log(`Deployment confirmed and verified at ${plan.address}`);
    });
    return;
  }

  const pinnedKey = readFileSync(required('LEDGER_PUBLIC_KEY_FILE'), 'utf8');
  const api = apiOrigin(process.env.UAIN_API ?? 'https://uain.global');
  if (command === 'publish') {
    const date = values.date ?? yesterday; dayNumber(date);
    const doc = values.input ? JSON.parse(readFileSync(values.input, 'utf8')) : await fetchJsonRetry(`${api}/api/ledger/roots/${date}`);
    const root = validateRoot(doc, pinnedKey);
    if (root.date !== date) throw new Error('Root differs from requested date');
    console.log(publishRoot(resolve(values.out ?? required('ROOTS_OUTPUT_DIR')), root, pinnedKey));
    return;
  }

  if (command.startsWith('solana-')) { await solana(command, send, values, pinnedKey, api, yesterday); return; }
  if (command === 'prove') { await prove(values, pinnedKey, api, artifact, owner); return; }

  const { client, contract, authority, lastDay, read, readConfirmed } = await connectAnchor(artifact, owner!);
  let roots: SignedRoot[];
  if (command === 'anchor' || command === 'recover-anchor') {
    const date = values.date ?? yesterday;
    dayNumber(date);
    const root = validateRoot(await fetchJsonRetry(`${api}/api/ledger/roots/${date}`), pinnedKey);
    if (root.date !== date) throw new Error('Root differs from requested date');
    roots = [root];
    if (command === 'anchor' && dayNumber(date) > lastDay) {
      const from = lastDay === 0 ? required('LEDGER_ANCHOR_START_DATE') : dateForDay(lastDay + 1);
      if (dayNumber(from) > dayNumber(date)) throw new Error('Requested date precedes configured anchoring start');
      for (const range of dateWindows(from, date)) {
        const response = await fetchJsonRetry(`${api}/api/ledger/roots?from=${range.from}&to=${range.to}`) as { roots?: unknown; count?: unknown };
        if (!response || !Array.isArray(response.roots) || response.count !== response.roots.length) throw new Error('Invalid roots response');
        const earlier = planCatchup(response.roots, pinnedKey, { ...range, lastDay, limit: 31 });
        if (earlier.some(r => r.date < date)) throw new Error('Earlier final roots are waiting; use catchup to preserve chronological coverage');
      }
    }
  } else {
    const from = command === 'audit' ? values.from ?? required('LEDGER_ANCHOR_START_DATE') : catchupStart(lastDay, process.env.LEDGER_ANCHOR_START_DATE, values.from);
    const to = values.to ?? yesterday;
    if (dayNumber(to) >= Math.floor(Date.now() / 86_400_000)) throw new Error('Only completed UTC days can be scanned');
    const docs: unknown[] = [];
    if (command === 'catchup' && dayNumber(from) > dayNumber(to) && lastDay >= dayNumber(to)) {
      if (send) await withJournal(journalFile, async journal => {
        if (Object.values(journal.data.operations).some(op => op.state !== 'confirmed')) throw new Error('Journal contains an uncertain operation; read-only recovery is required');
      });
      console.log('No completed days remain after the last anchor'); return;
    }
    for (const range of dateWindows(from, to)) {
      const response = await fetchJsonRetry(`${api}/api/ledger/roots?from=${range.from}&to=${range.to}`) as { count?: unknown; roots?: unknown };
      if (!response || !Array.isArray(response.roots) || response.count !== response.roots.length) throw new Error('Invalid roots response');
      // Validate each page separately, including its dates and signatures.
      // This API does not cryptographically prove completeness of its listing.
      planCatchup(response.roots, pinnedKey, { ...range, lastDay: 0, limit: 31 });
      docs.push(...response.roots);
    }
    roots = command === 'audit'
      ? docs.map(doc => validateRoot(doc, pinnedKey)).filter(r => r.count > 0).sort((a, b) => a.date.localeCompare(b.date))
      : planCatchup(docs, pinnedKey, { from, to, lastDay, limit: Number(values.limit ?? '7') });
  }
  if (command === 'audit') {
    let absent = 0;
    for (const root of roots) {
      const status = await auditRoot(root, { read: readConfirmed }); if (status === 'absent') absent++;
      console.log(`${root.date}: ${status}`);
    }
    console.log(JSON.stringify({ contract, audited: roots.length, absent, identityVerified: true }));
    if (absent) process.exitCode = 2;
    return;
  }
  for (const root of roots) console.log(JSON.stringify({ date: root.date, calldata: encodeFunctionData({ abi: artifact.abi, functionName: 'anchor', args: anchorParameters(root) }) }));
  if (!send && command !== 'recover-anchor') { console.log(`Verified dry run: ${roots.length} day(s); no transaction submitted`); return; }
  const binding = createHash('sha256').update(JSON.stringify({ chainId: 84532, contract, owner, artifact: artifactHash(artifact), key: pinnedKey })).digest('hex');
  const signer = send ? wallet('ANCHORER_PRIVATE_KEY') : undefined;
  const limits = send ? fees() : undefined;
  if (signer && signer.account.address.toLowerCase() !== String(authority).toLowerCase()) throw new Error('Wallet is not the contract anchorer');
  if (signer && limits && await client.getBalance({ address: signer.account.address }) < BigInt(roots.length) * limits.gas * limits.maxFeePerGas) throw new Error('Batch exceeds available gas balance');
  const previous = lastDay === 0 ? undefined : await read(lastDay);
  let lastId = previous?.lastEventId ?? 0n;
  for (const root of roots.filter(r => dayNumber(r.date) > lastDay)) {
    const params = anchorParameters(root);
    if (BigInt(root.first_id!) <= lastId || params[3] > params[4] - lastId) throw new Error('Batch event range conflicts with the last anchor');
    lastId = params[4];
  }
  const port: AnchorPort = {
    read, readConfirmed,
    async simulate(params) {
      if (!signer || !limits) throw new Error('Mutation disabled');
      await client.simulateContract({ address: contract, abi: artifact.abi, functionName: 'anchor', args: params, account: signer.account, ...limits });
      const gas = await client.estimateContractGas({ address: contract, abi: artifact.abi, functionName: 'anchor', args: params, account: signer.account });
      if (gas > limits.gas) throw new Error('Anchor exceeds gas cap');
    },
    async send(params) {
      if (!signer || !limits) throw new Error('Mutation disabled');
      return signer.writeContract({ address: contract, abi: artifact.abi, functionName: 'anchor', args: params, ...limits });
    },
    async confirm(hash) {
      const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 120_000, pollingInterval: 2_000 });
      if (receipt.status !== 'success' || receipt.to?.toLowerCase() !== contract) throw new Error('Anchor receipt mismatch or revert');
    },
  };
  await withJournal(journalFile, journal => executeAnchors(roots, port, journal, binding, command === 'recover-anchor'));
  console.log('Every requested anchor verified; no mutation retry occurred');
}

/** The deployed LedgerAnchor, checked against the compiled runtime, its owner and (if pinned) its anchorer. */
async function connectAnchor(artifact: Artifact, owner: ReturnType<typeof address>) {
  const client = publicClient(); assertTestnet(await client.getChainId());
  const contract = address(required('LEDGER_ANCHOR_ADDRESS'));
  const blockNumber = await client.getBlockNumber();
  const [code, actualOwner, authority, rawLastDay] = await Promise.all([
    client.getCode({ address: contract, blockNumber }),
    client.readContract({ address: contract, abi: artifact.abi, functionName: 'owner', blockNumber }),
    client.readContract({ address: contract, abi: artifact.abi, functionName: 'anchorer', blockNumber }),
    client.readContract({ address: contract, abi: artifact.abi, functionName: 'lastDay', blockNumber }),
  ]);
  verifyIdentity(artifact, { chainId: 84532, code, owner: address(String(actualOwner)), anchorer: address(String(authority)) }, owner, process.env.ANCHORER_ADDRESS ? address(process.env.ANCHORER_ADDRESS) : undefined);
  const lastDay = Number(rawLastDay); dateForDay(lastDay);
  const read: AnchorPort['read'] = async day => await client.readContract({ address: contract, abi: artifact.abi, functionName: 'anchorOf', args: [day] }) as StoredAnchor;
  const readConfirmed: AnchorPort['readConfirmed'] = async day => {
    const tip = await client.getBlockNumber();
    if (tip < 2n) throw new Error('Not enough confirmed blocks');
    return await client.readContract({ address: contract, abi: artifact.abi, functionName: 'anchorOf', args: [day], blockNumber: tip - 1n }) as StoredAnchor;
  };
  return { client, contract, authority, lastDay, read, readConfirmed };
}

/**
 * One entry, end to end, with no wallet: its hash is a leaf of its day's tree,
 * the path reaches the root the pinned key signed, and that root is the one
 * anchored on Base Sepolia and, if configured, mirrored on Solana devnet.
 * Exit code 2 while the day is not yet anchored or mirrored.
 */
async function prove(values: Record<string, string>, pinnedKey: string, api: string, artifact: Artifact, owner: ReturnType<typeof address> | undefined): Promise<void> {
  const id = Number(values.id ?? '');
  if (!/^\d+$/.test(values.id ?? '') || !Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid event id');
  const proof = validateProof(await fetchJsonRetry(`${api}/api/ledger/proof/${id}`), id);
  const event = await fetchJsonRetry(`${api}/api/events/${id}`) as { id?: unknown; hash?: unknown };
  if (!event || event.id !== id || typeof event.hash !== 'string') throw new Error('Invalid event document');
  const root = validateRoot(await fetchJsonRetry(`${api}/api/ledger/roots/${proof.date}`), pinnedKey);
  checkInclusion(proof, root, event.hash);
  const report: Record<string, unknown> = { event_id: id, date: root.date, leaf: proof.leaf, root: root.root, included: true, signed_by_pinned_key: true };
  let pending = false;
  if (owner) {
    const { contract, readConfirmed } = await connectAnchor(artifact, owner);
    const params = anchorParameters(root);
    const status = compareAnchor(await readConfirmed(params[0]), params);
    report.base_sepolia = { contract, status, explorer: `https://sepolia.basescan.org/address/${contract}` };
    pending ||= status === 'absent';
  }
  if (process.env.SOLANA_MIRROR_ADDRESS) {
    const port = rpcPort(solanaRpcUrl(process.env.SOLANA_RPC)); await assertDevnet(port);
    const mirrored = (await mirroredDays(port, mirrorAddress(process.env.SOLANA_MIRROR_ADDRESS), pinnedKey)).get(root.date);
    if (mirrored && JSON.stringify(mirrored.root) !== JSON.stringify(root)) throw new Error('Mirrored memo conflicts with the signed root; refusing a replacement');
    report.solana_devnet = mirrored
      ? { status: 'matches', signature: mirrored.signature, explorer: `https://explorer.solana.com/tx/${mirrored.signature}?cluster=devnet` }
      : { status: 'absent' };
    pending ||= !mirrored;
  }
  console.log(JSON.stringify(report, null, 2));
  if (pending) process.exitCode = 2;
}

/** The Solana devnet mirror: dry run by default, `--send` to post, audit and recovery read-only. */
async function solana(command: string, send: boolean, values: Record<string, string>, pinnedKey: string, api: string, yesterday: string): Promise<void> {
  const port = rpcPort(solanaRpcUrl(process.env.SOLANA_RPC));
  await assertDevnet(port);
  const mirror = mirrorAddress(process.env.SOLANA_MIRROR_ADDRESS);
  const journalFile = resolve(process.env.SOLANA_JOURNAL ?? fileURLToPath(new URL('../../work/blockchain/solana.json', import.meta.url)));
  if (command === 'solana-recover') {
    await withJournal(journalFile, async journal => { for (const line of await recoverMirror(port, mirror, journal)) console.log(line); });
    return;
  }
  const from = values.from ?? required('LEDGER_ANCHOR_START_DATE'), to = values.to ?? yesterday;
  if (dayNumber(to) >= Math.floor(Date.now() / 86_400_000)) throw new Error('Only completed UTC days can be scanned');
  const docs: unknown[] = [];
  for (const range of dateWindows(from, to)) {
    const response = await fetchJsonRetry(`${api}/api/ledger/roots?from=${range.from}&to=${range.to}`) as { count?: unknown; roots?: unknown };
    if (!response || !Array.isArray(response.roots) || response.count !== response.roots.length) throw new Error('Invalid roots response');
    planCatchup(response.roots, pinnedKey, { ...range, lastDay: 0, limit: 31 });
    docs.push(...response.roots);
  }
  const roots = docs.map(doc => validateRoot(doc, pinnedKey)).filter(r => r.count > 0).sort((a, b) => a.date.localeCompare(b.date));
  const done = await mirroredDays(port, mirror, pinnedKey);
  if (command === 'solana-audit') {
    let absent = 0;
    for (const root of roots) {
      const mirrored = done.get(root.date);
      if (mirrored && JSON.stringify(mirrored.root) !== JSON.stringify(root)) throw new Error('Mirrored memo conflicts with the signed root; refusing a replacement');
      if (!mirrored) absent++;
      console.log(`${root.date}: ${mirrored ? `matches ${mirrored.signature}` : 'absent'}`);
    }
    console.log(JSON.stringify({ mirror, audited: roots.length, absent, cluster: 'devnet' }));
    if (absent) process.exitCode = 2;
    return;
  }
  const batch = planMirror(roots, done, Number(values.limit ?? '7'));
  for (const root of batch) console.log(JSON.stringify({ date: root.date, memo: `uain-ledger-v1 ${root.date} root=${root.root} …` }));
  if (!send) { console.log(`Verified dry run: ${batch.length} day(s); no transaction submitted`); return; }
  const key = readMirrorKey(required('SOLANA_MIRROR_KEY_FILE'));
  if (key.address !== mirror) throw new Error('Mirror key differs from SOLANA_MIRROR_ADDRESS');
  const binding = createHash('sha256').update(JSON.stringify({ cluster: 'devnet', mirror, key: pinnedKey })).digest('hex');
  await withJournal(journalFile, journal => mirrorRoots(batch, port, key, journal, binding));
  console.log(`Every requested day mirrored and read back (${batch.length}); no mutation retry occurred`);
}

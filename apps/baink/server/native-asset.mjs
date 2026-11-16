import { createInflightArtifactHasher } from './inflight-artifact-hash.mjs';
import { createCentralReadBatcher } from './central-read-batch.mjs';
import { createNativeAccountBatcher } from './native-account-batch.mjs';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { nativeInstanceSigningBytes } from './native-instance.mjs';
import { nativeResearchSigningBytes, researchEvidenceCanonical } from '../integrations/native-research-codec.mjs';
import { createFinancialTransport } from './native-financial-transport.mjs';
import { createCentralTransport } from './central-earning-transport.mjs';
import { stat, readFile, mkdtemp, chmod, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';

// Only the pinned reader's narrowly recognized connection refusal is retryable.
// Never retain RPC URLs, raw stderr, selected keys or proof material on errors.
export class NativeReaderError extends Error {
  constructor(exitCode, signal, category = 'reader_refused') {
    super('Pinned native proof reader refused the selection');
    this.name = 'NativeReaderError';
    this.exitCode = Number.isInteger(exitCode) ? exitCode : null;
    this.signal = ['SIGKILL', 'SIGTERM', 'SIGABRT', 'SIGSEGV'].includes(signal) ? signal : null;
    this.category = category === 'rpc_connection_refused' ? category : 'reader_refused';
    this.retryable = this.category === 'rpc_connection_refused';
  }
}

const COIN_POLICY = 'verified-bounties-108t-micro-v1';
const CAP = '108000000000000000000';
const PRIVATE_POLICY = 'orchard-v2-reviewed-otc-v1';
const HEX = /^[a-f0-9]{64}$/;
const ADDRESS = /^uain1[a-f0-9]{40}$/;
const ensure = (condition, message) => {
  if (!condition) throw new Error(message);
};
const canonicalUnits = (value) =>
  typeof value === 'string' &&
  /^(0|[1-9][0-9]{0,20})$/.test(value) &&
  BigInt(value) <= BigInt(CAP);
const positiveHeight = (value) =>
  typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value);

export function assetMetadata() {
  return {
    id: 'uain-native-coin',
    name: 'AI Dollar',
    symbol: 'AI$',
    nativeName: 'UAIN Coin',
    sameLedger: true,
    balanceScope: 'transparent',
    decimals: 6,
    unitsPerCoin: '1000000',
    coinPolicy: COIN_POLICY,
    supplyCapUnits: CAP,
    accounting: 'existing-native-coin',
    reputationCreditsAreMoney: false,
    targetReference: {
      amount: '1',
      currency: 'CHF',
      meaning: 'Target reference only',
      backed: false,
      redemptionGuaranteed: false,
      stabilityGuaranteed: false,
    },
  };
}
export function formatNativeUnits(value) {
  ensure(
    canonicalUnits(value),
    'Canonical native base-unit string within the native supply cap required',
  );
  const units = BigInt(value);
  return `${units / 1_000_000n}.${String(units % 1_000_000n).padStart(6, '0')}`;
}
/** Display only: AI$ text without trailing zeros (1500000 -> "1.5", 2000000 -> "2").
 * Never use it for a value that is signed, hashed, stored as terms or compared:
 * those keep formatNativeUnits' fixed six places (Trade prices, refunds, digests). */
export function displayNativeUnits(value) {
  return formatNativeUnits(value).replace(/\.?0+$/, '');
}
export function nativeUnitsFromDecimal(value) {
  ensure(
    typeof value === 'string' &&
      /^(0|[1-9][0-9]{0,14})(?:\.[0-9]{1,6})?$/.test(value),
    'Positive exact six-place decimal text required',
  );
  const [whole, fraction = ''] = value.split('.'),
    units = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  ensure(
    units > 0n && units <= BigInt(CAP),
    'Amount must be positive and within the native supply cap',
  );
  return units.toString();
}
export function nativeConfigFromEnv(env = {}) {
  return {
    binary: env.BAINK_NATIVE_STATE_BINARY,
    binaryHash: env.BAINK_NATIVE_STATE_SHA256,
    genesis: env.BAINK_NATIVE_GENESIS,
    genesisHash: env.BAINK_NATIVE_GENESIS_SHA256,
    rpc: env.BAINK_NATIVE_RPC,
    chainId: env.BAINK_NATIVE_CHAIN_ID,
    timeoutMs:
      env.BAINK_NATIVE_TIMEOUT_MS === undefined
        ? 8000
        : Number(env.BAINK_NATIVE_TIMEOUT_MS),
    maxAgeSeconds:
      env.BAINK_NATIVE_MAX_AGE_SECONDS === undefined
        ? 120
        : Number(env.BAINK_NATIVE_MAX_AGE_SECONDS),
  };
}
function validatedConfig(raw) {
  if (
    !raw ||
    ![raw.binary, raw.binaryHash, raw.genesis, raw.genesisHash, raw.rpc].some(
      Boolean,
    )
  )
    return null;
  ensure(
    typeof raw.binary === 'string' &&
      isAbsolute(raw.binary) &&
      typeof raw.genesis === 'string' &&
      isAbsolute(raw.genesis) &&
      HEX.test(raw.binaryHash ?? '') &&
      HEX.test(raw.genesisHash ?? ''),
    'Complete independent native reader pins required',
  );
  const rpc = new URL(raw.rpc);
  ensure(
    !rpc.username &&
      !rpc.password &&
      !rpc.search &&
      !rpc.hash &&
      rpc.pathname === '/' &&
      (rpc.protocol === 'https:' ||
        (rpc.protocol === 'http:' &&
          ['127.0.0.1', '[::1]'].includes(rpc.hostname))),
    'Public HTTPS or owned loopback native RPC required',
  );
  const timeoutMs = raw.timeoutMs ?? 8000,
    maxAgeSeconds = raw.maxAgeSeconds ?? 120;
  ensure(
    Number.isInteger(timeoutMs) &&
      timeoutMs >= 100 &&
      timeoutMs <= 10000 &&
      Number.isInteger(maxAgeSeconds) &&
      maxAgeSeconds >= 1 &&
      maxAgeSeconds <= 120,
    'Bounded native proof timeout and freshness required',
  );
  if (raw.chainId !== undefined)
    ensure(
      typeof raw.chainId === 'string' &&
        /^[A-Za-z0-9._-]{1,96}$/.test(raw.chainId),
      'Invalid pinned chain ID',
    );
  return { ...raw, rpc: rpc.origin, timeoutMs, maxAgeSeconds };
}
function validateNativeSnapshot(state,selection,config,genesis){
      const age = Date.now() - Date.parse(state.header_time);
      ensure(
        state.chain_id === genesis.chain_id &&
          (!state.epoch || state.epoch === config.genesisHash) &&
          positiveHeight(state.height) &&
          HEX.test(state.app_hash ?? '') &&
          Number.isFinite(age) &&
          age >= -60_000 &&
          age <= config.maxAgeSeconds * 1000,
        'Native snapshot epoch, height or freshness mismatch',
      );
      ensure(
        state.records &&
          typeof state.records === 'object' &&
          !Array.isArray(state.records),
        'Native records missing',
      );
      if (selection.member)
        ensure(
          state.member?.id === selection.member,
          'Selected native member semantic proof missing',
        );
      for (const key of selection.keys ?? [])
        ensure(
          Object.hasOwn(state.records, key),
          'Selected native record or proven absence missing',
        );
      return state;
}
function reader(config, stateTransport) {
  const hashFile = createInflightArtifactHasher();
  let active = 0;
  const waiting = [];
  function release() {
    active--;
    while (active < 2 && waiting.length) {
      const next = waiting.shift();
      next.signal.removeEventListener('abort', next.abort);
      if (next.signal.aborted) {
        next.reject(new Error('Native proof capacity wait timed out'));
        continue;
      }
      active++;
      next.resolve();
    }
  }
  const execute = async (selection, timeoutMs, batchMembers=null) => {
    const controller = new AbortController(),
      timer = setTimeout(
        () => controller.abort(),
        Math.max(1, Math.min(config.timeoutMs, timeoutMs)),
      );
    const signal = controller.signal;
    let directory, acquired = false;
    try {
      if (active < 2) {
        active++;
        acquired = true;
      } else {
        ensure(waiting.length < 4, 'Native proof capacity unavailable');
        await new Promise((resolve, reject) => {
          const entry = { signal, resolve, reject };
          entry.abort = () => {
            const index = waiting.indexOf(entry);
            if (index !== -1) waiting.splice(index, 1);
            reject(new Error('Native proof capacity wait timed out'));
          };
          if (signal.aborted) return entry.abort();
          signal.addEventListener('abort', entry.abort, { once: true });
          waiting.push(entry);
        });
        acquired = true;
      }
      signal.throwIfAborted();
      ensure(
        (await hashFile(config.binary, 256 * 1024 * 1024, signal)) ===
          config.binaryHash,
        'Native verifier differs from independent pin',
      );
      ensure(
        (await hashFile(config.genesis, 8 * 1024 * 1024, signal)) ===
          config.genesisHash,
        'Native genesis differs from independent pin',
      );
      const genesis = JSON.parse(
        await readFile(config.genesis, { encoding: 'utf8', signal }),
      );
      ensure(
        typeof genesis.chain_id === 'string' &&
          (!config.chainId || genesis.chain_id === config.chainId),
        'Pinned native epoch chain mismatch',
      );
      if(batchMembers){
        ensure(stateTransport&&typeof stateTransport.readBatch==='function','Native batch transport unavailable');
        const bytes=await stateTransport.readBatch([...batchMembers],{signal});
        ensure(Buffer.isBuffer(bytes)&&bytes.length<=2*1024*1024,'Invalid remote native batch output');
        const batch=JSON.parse(bytes.toString('utf8')),digest=createHash('sha256').update(JSON.stringify({members:batchMembers})).digest('hex');
        ensure(batch&&Object.keys(batch).sort().join()===['schema','requestDigest','results'].sort().join()&&batch.schema==='baink-native-public-state-batch-v1'&&batch.requestDigest===digest&&Array.isArray(batch.results)&&batch.results.length===batchMembers.length,'Native batch request binding mismatch');
        signal.throwIfAborted();
        return batch.results.map((item,index)=>{
          const member=batchMembers[index];ensure(item&&item.member===member&&['member','absence','unavailable'].includes(item.mode)&&Object.keys(item).sort().join()===(item.mode==='unavailable'?['member','mode']:['member','mode','state']).sort().join(),'Native batch result binding mismatch');
          if(item.mode==='unavailable')return{member,state:null};
          const keys=['coin_activation','coin_supply','private_activation','member/'+member,'coin_balance/'+member],selection=item.mode==='member'?{member,keys}:{keys};
          const state=validateNativeSnapshot(item.state,selection,config,genesis);
          if(item.mode==='absence')ensure(state.member==null&&state.records['member/'+member]===null,'Native batch negative member proof missing');
          return{member,state};
        });
      }
      let state;
      if (stateTransport) {
        const bytes = await stateTransport.read(structuredClone(selection), {signal});
        ensure(Buffer.isBuffer(bytes) && bytes.length <= 2 * 1024 * 1024, 'Invalid remote native proof output');
        state = JSON.parse(bytes.toString('utf8'));
      } else {
      directory = await mkdtemp(join(tmpdir(), 'baink-native-proof-'));
      await chmod(directory, 0o700);
      const output = join(directory, 'state.json');
      await new Promise((resolve, reject) => {
        const child = spawn(
          config.binary,
          [
            '--genesis',
            config.genesis,
            '--genesis-sha256',
            config.genesisHash,
            '--rpc',
            config.rpc,
            '--out',
            output,
            '--max-age',
            `${config.maxAgeSeconds}s`,
          ],
          { stdio: ['pipe', 'ignore', 'pipe'], signal, killSignal: 'SIGKILL' },
        );
        let processError, stderr = Buffer.alloc(0), stderrOverflow = false;
        child.stderr.on('data', chunk => {
          // Keep at most 4 KiB for classification; drain every chunk without logging it.
          if (stderr.length + chunk.length > 4096) stderrOverflow = true;
          stderr = Buffer.concat([stderr, chunk.subarray(0, Math.max(0, 4096 - stderr.length))]);
        });
        child.once('error', (error) => {
          processError = error;
        });
        child.once('close', (code, exitSignal) => {
          if (processError) reject(processError);
          else
            code === 0
              ? resolve()
              : reject(
                  new NativeReaderError(code, exitSignal,
                    !stderrOverflow && !exitSignal && /^(?:post failed: )?(?:Post|Get) "https?:\/\/[^"\r\n]+": dial tcp (?:\[[0-9a-f:]+\]|[0-9.]+):[0-9]+: connect: connection refused\r?\n?$/.test(stderr.toString('utf8'))
                      ? 'rpc_connection_refused' : 'reader_refused'),
                );
        });
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify(selection));
      });
      const info = await stat(output);
      ensure(
        info.isFile() && info.size <= 8 * 1024 * 1024 && !(info.mode & 0o077),
        'Invalid native proof output',
      );
      state = JSON.parse(
        await readFile(output, { encoding: 'utf8', signal }),
      );
      }
      signal.throwIfAborted();
      return validateNativeSnapshot(state,selection,config,genesis);
    } finally {
      clearTimeout(timer);
      try {
        if (directory) await rm(directory, { recursive: true, force: true });
      } finally {
        if (acquired) release();
      }
    }
  };
  execute.batch=(members,timeoutMs)=>execute(null,timeoutMs,members);
  return execute;
}
function supplyView(ledger) {
  ensure(
    ledger &&
      typeof ledger === 'object' &&
      ['minted', 'reserved', 'transparent', 'shielded'].every((key) =>
        canonicalUnits(ledger[key]),
      ),
    'Invalid proven native coin supply',
  );
  ensure(
    BigInt(ledger.minted) + BigInt(ledger.reserved) <= BigInt(CAP) &&
      BigInt(ledger.transparent) + BigInt(ledger.shielded) ===
        BigInt(ledger.minted),
    'Native coin supply conservation mismatch',
  );
  return Object.fromEntries(
    ['minted', 'reserved', 'transparent', 'shielded'].map((key) => [
      key,
      ledger[key],
    ]),
  );
}
function financialState(state) {
  const activation = state.records.coin_activation,
    ledger = state.records.coin_supply,
    privateActivation = state.records.private_activation;
  let assetStatus = 'inactive',
    supply = null;
  if (activation !== null) {
    ensure(
      activation &&
        typeof activation === 'object' &&
        positiveHeight(activation.height) &&
        HEX.test(activation.evidence_digest ?? ''),
      'Invalid native coin activation',
    );
    if (activation.policy !== COIN_POLICY) assetStatus = 'policy_mismatch';
    else {
      ensure(
        BigInt(activation.height) >= 2n,
        'Invalid native coin activation height',
      );
      supply = supplyView(ledger);
      assetStatus =
        BigInt(activation.height) <= BigInt(state.height)
          ? 'active'
          : 'inactive';
    }
  } else
    ensure(
      ledger === null,
      'Coin supply exists without a supported activation',
    );
  let privateStatus = 'inactive';
  if (privateActivation !== null) {
    ensure(
      privateActivation &&
        typeof privateActivation === 'object' &&
        positiveHeight(privateActivation.height) &&
        HEX.test(privateActivation.evidence_digest ?? ''),
      'Invalid private policy activation',
    );
    privateStatus =
      privateActivation.policy !== PRIVATE_POLICY
        ? 'policy_mismatch'
        : BigInt(privateActivation.height) >= 2n &&
            BigInt(privateActivation.height) <= BigInt(state.height)
          ? 'active'
          : 'inactive';
  }
  return {
    assetStatus,
    privateStatus,
    supply,
    activationHeight: activation?.height ?? null,
  };
}
function settlementFor(native) {
  const code =
    native.status === 'ready'
      ? 'settlement_adapter_unavailable'
      : native.status;
  const messages = {
    proof_unavailable: 'An independently verified native state is unavailable.',
    asset_inactive: 'The existing native AI$ coin policy is not active.',
    member_missing: 'This identity has no proven native membership.',
    licence_pending: 'Native membership is pending licence activation.',
    licence_inactive: 'This native licence is not active.',
    policy_mismatch:
      'The native asset policy differs from the supported existing coin policy.',
    settlement_adapter_unavailable:
      'Native balances are connected. Private settlement requires the existing member-held wallet and independent review workflow.',
  };
  return {
    available: false,
    code,
    message: messages[code] ?? 'Native settlement is unavailable.',
    nativeAssetConnected: native.verified === true,
  };
}
function result(native, balance = null, nativeRegistration = 'unavailable') {
  return {
    balance,
    balanceScope: 'transparent',
    nativeRegistration,
    asset: assetMetadata(),
    native: { ...native, balanceScope: 'transparent' },
    settlementAvailable: false,
    settlement: settlementFor(native),
  };
}
export function createNativeAssetAdapter({ config: raw, paymentBroadcaster = null, stateTransport = null, accountBatchingEnabled = false } = {}) {
  let config = null,
    configuration = 'not_configured';
  try {
    config = validatedConfig(raw);
    if (config) configuration = 'configured';
  } catch {
    configuration = 'invalid';
  }
  if (stateTransport) {
    const p=stateTransport.profile;
    ensure(config && typeof stateTransport.read==='function' && typeof stateTransport.close==='function' && p && config.chainId===p.chainId && config.binaryHash===p.verifierSha256 && config.genesisHash===p.genesisSha256 && config.maxAgeSeconds===120 && p.maxAgeSeconds===120, 'Native readonly transport profile mismatch');
  }
  const read = config ? reader(config,stateTransport) : null,
    cache = new Map(),
    pending = new Map();
  if(accountBatchingEnabled)ensure(config&&stateTransport&&typeof stateTransport.readBatch==='function','Native account batching requires readonly batch transport');
  const accountBatcher=accountBatchingEnabled?createNativeAccountBatcher({readBatch:(members,budget)=>read.batch(members,budget)}):null;
  const centralReadBatcher=read&&typeof config.chainId==='string'?createCentralReadBatcher({readSnapshot:(selection,budget)=>read(selection,budget),pins:{chainId:config.chainId,genesisSha256:config.genesisHash,verifierSha256:config.binaryHash}}):null;
  const unavailable = () =>
    result({
      status: 'proof_unavailable',
      verified: false,
      memberStatus: 'unknown',
      assetStatus: 'unknown',
      privateStatus: 'unknown',
      balanceUnits: null,
      checkedAt: new Date().toISOString(),
      proof: null,
      configuration,
    });
  const proof = (state) => ({
    authority: 'native',
    chainId: state.chain_id,
    height: state.height,
    appHash: state.app_hash,
    headerTime: state.header_time,
    maxAgeSeconds: config.maxAgeSeconds,
    epoch: config.genesisHash,
    genesisSha256: config.genesisHash,
    verifierSha256: config.binaryHash,
  });
  async function cached(key, work) {
    const previous = cache.get(key);
    if (
      previous &&
      Date.now() < previous.expires &&
      (!previous.result.native.proof ||
        Date.now() - Date.parse(previous.result.native.proof.headerTime) <=
          config.maxAgeSeconds * 1000)
    )
      return structuredClone(previous.result);
    if (pending.has(key)) return structuredClone(await pending.get(key));
    const job = (async () => {
      let answer;
      try {
        answer = await work();
      } catch {
        answer = unavailable();
      }
      if (cache.size >= (accountBatcher?256:64)) cache.delete(cache.keys().next().value);
      cache.set(key, {
        expires: Date.now() + (answer.native.verified ? 20_000 : 2000),
        result: answer,
      });
      return answer;
    })();
    pending.set(key, job);
    try {
      return structuredClone(await job);
    } finally {
      pending.delete(key);
    }
  }
  const globalKeys = ['coin_activation', 'coin_supply', 'private_activation'];
  return Object.freeze({
    ...createFinancialTransport({ config, paymentBroadcaster }),
    ...createCentralTransport({ config }),
    close: async()=>{await Promise.all([centralReadBatcher?.close(),accountBatcher?.close()]);await stateTransport?.close();},
    configured: Boolean(config),
    configuration,
    pins: Object.freeze({
      epoch: config?.genesisHash ?? null,
      verifierSha256: config?.binaryHash ?? null,
      chainId: config?.chainId ?? null,
    }),
    timeoutMs: config?.timeoutMs ?? 8000,
    async centralPublicState(selection, { timeoutMs = 25000 } = {}) {
      ensure(centralReadBatcher, 'Independent native reader is unavailable');
      const state=await centralReadBatcher.read(selection,{timeoutMs});
      return {state,proof:proof(state)};
    },
    async publicState(selection, { timeoutMs = config?.timeoutMs } = {}) {
      ensure(read, 'Independent native reader is unavailable');
      ensure(
        selection &&
          typeof selection === 'object' &&
          !Array.isArray(selection) &&
          Object.keys(selection).every((key) =>
            ['member', 'keys', 'receipt'].includes(key),
          ) &&
          Buffer.byteLength(JSON.stringify(selection)) <= 65536,
        'Bounded native public selection required',
      );
      if (selection.keys)
        ensure(
          Array.isArray(selection.keys) &&
            selection.keys.length <= 32 &&
            selection.keys.every(
              (key) =>
                typeof key === 'string' &&
                /^[A-Za-z0-9_./:-]{1,512}$/.test(key),
            ),
          'Bounded native key selection required',
        );
      const state = await read(selection, timeoutMs);
      return { state, proof: proof(state) };
    },
    invalidateAccount(address) {
      for (const key of cache.keys())
        if (key.startsWith(`account:${address}:`)) cache.delete(key);
    },
    async broadcastEnrol(envelope, { timeoutMs = 3000 } = {}) {
      ensure(
        config && envelope?.command?.operation === 'enrol',
        'Only native enrolment submission is available',
      );
      const bytes = Buffer.from(JSON.stringify(envelope));
      ensure(bytes.length <= 65536, 'Native envelope exceeds bound');
      const transactionHash = createHash('sha256')
        .update(bytes)
        .digest('hex')
        .toUpperCase();
      const response = await fetch(config.rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        redirect: 'error',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'baink-native-enrol',
          method: 'broadcast_tx_sync',
          params: { tx: bytes.toString('base64') },
        }),
        signal: AbortSignal.timeout(Math.max(1, Math.min(3000, timeoutMs))),
      });
      ensure(response.ok && response.body, 'Native enrolment RPC unavailable');
      const chunks = [],
        stream = response.body.getReader();
      let length = 0;
      try {
        while (true) {
          const { done, value } = await stream.read();
          if (done) break;
          length += value.length;
          ensure(length <= 65536, 'Native enrolment response exceeds bound');
          chunks.push(Buffer.from(value));
        }
      } finally {
        await stream.cancel().catch(() => {});
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      ensure(
        !result.error &&
          Number.isInteger(result.result?.code) &&
          result.result.code >= 0 &&
          result.result.hash?.toUpperCase() === transactionHash,
        'Native enrolment submission result differs',
      );
      return {
        accepted: result.result.code === 0,
        code: result.result.code,
        transactionHash,
        finalized: false,
      };
    },
    async broadcastInstance(envelope, { timeoutMs = 3000 } = {}) {
      ensure(
        config && envelope?.command?.operation === 'instance_create',
        'Only native instance creation submission is available',
      );
      ensure(
        envelope && typeof envelope === 'object' && !Array.isArray(envelope) &&
          Object.keys(envelope).length === 3 &&
          ['command', 'public_key', 'signature'].every(key => Object.hasOwn(envelope, key)) &&
          typeof envelope.public_key === 'string' && typeof envelope.signature === 'string' &&
          envelope.command.chain_id === config.chainId,
        'Exact pinned native instance envelope required',
      );
      const signingBytes = nativeInstanceSigningBytes(envelope.command),
        key = Buffer.from(envelope.public_key, 'base64url'),
        signature = Buffer.from(envelope.signature, 'base64url');
      ensure(
        key.length === 32 && key.toString('base64url') === envelope.public_key &&
          signature.length === 64 && signature.toString('base64url') === envelope.signature &&
          'uain1' + createHash('sha256').update(key).digest('hex').slice(0, 40) === envelope.command.member &&
          verify(null, signingBytes, createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: envelope.public_key }, format: 'jwk' }), signature),
        'Valid local holder signature for native instance creation required',
      );
      const bytes = Buffer.from(JSON.stringify(envelope));
      ensure(bytes.length <= 65536, 'Native envelope exceeds bound');
      const transactionHash = createHash('sha256')
        .update(bytes)
        .digest('hex')
        .toUpperCase();
      const response = await fetch(config.rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        redirect: 'error',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'baink-native-instance',
          method: 'broadcast_tx_sync',
          params: { tx: bytes.toString('base64') },
        }),
        signal: AbortSignal.timeout(Math.max(1, Math.min(3000, timeoutMs))),
      });
      ensure(response.ok && response.body, 'Native instance creation RPC unavailable');
      const chunks = [],
        stream = response.body.getReader();
      let length = 0;
      try {
        while (true) {
          const { done, value } = await stream.read();
          if (done) break;
          length += value.length;
          ensure(length <= 65536, 'Native instance creation response exceeds bound');
          chunks.push(Buffer.from(value));
        }
      } finally {
        await stream.cancel().catch(() => {});
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      ensure(
        !result.error &&
          Number.isInteger(result.result?.code) &&
          result.result.code >= 0 &&
          result.result.hash?.toUpperCase() === transactionHash,
        'Native instance creation submission result differs',
      );
      return {
        accepted: result.result.code === 0,
        code: result.result.code,
        transactionHash,
        finalized: false,
      };
    },
    async publishResearch(document, expected) {
      ensure(config && document?.envelope?.command?.operation === 'submit', 'Finalized native research publication required');
      const canonical = researchEvidenceCanonical(document.body), c = document.envelope.command;
      ensure(createHash('sha256').update('uain:research-evidence:v1\n' + canonical).digest('hex') === c.payload.evidence_digest &&
        expected?.epoch === config.genesisHash && expected.id === c.payload.id && expected.evidence_digest === c.payload.evidence_digest &&
        /^[1-9][0-9]{0,19}$/.test(document.event_id), 'Public evidence differs from the signed submission');
      // The UAIN endpoint independently checks the signed envelope and finalized event.
      // This is immutable body publication, not another chain broadcast.
      const endpoint = new URL('https://uain.global/api/native/evidence');
      const response = await fetch(endpoint, {method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify(document),signal:AbortSignal.timeout(8000)});
      ensure(response.ok && response.body, 'Native evidence publication unavailable');
      const parts = []; let size = 0;
      for await (const part of response.body) { size += part.length; ensure(size <= 65536, 'Publication acknowledgement exceeds bound'); parts.push(part); }
      const result = JSON.parse(Buffer.concat(parts).toString('utf8'));
      ensure(result.published === true && result.epoch === expected.epoch && result.id === expected.id && result.evidence_digest === expected.evidence_digest, 'Native publication acknowledgement differs');
      return result;
    },
    async broadcastResearch(envelope, { timeoutMs = 3000 } = {}) {
      ensure(
        config && ['open_project','open_task','project_join','submit','verify'].includes(envelope?.command?.operation),
        'Only native pilot research submission is available',
      );
      ensure(
        envelope && typeof envelope === 'object' && !Array.isArray(envelope) &&
          Object.keys(envelope).length === 3 &&
          ['command', 'public_key', 'signature'].every(key => Object.hasOwn(envelope, key)) &&
          typeof envelope.public_key === 'string' && typeof envelope.signature === 'string' &&
          envelope.command.chain_id === config.chainId,
        'Exact pinned native pilot research envelope required',
      );
      const signingBytes = Buffer.from(nativeResearchSigningBytes(envelope.command)),
        key = Buffer.from(envelope.public_key, 'base64url'),
        signature = Buffer.from(envelope.signature, 'base64url');
      ensure(
        key.length === 32 && key.toString('base64url') === envelope.public_key &&
          signature.length === 64 && signature.toString('base64url') === envelope.signature &&
          'uain1' + createHash('sha256').update(key).digest('hex').slice(0, 40) === envelope.command.member &&
          verify(null, signingBytes, createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: envelope.public_key }, format: 'jwk' }), signature),
        'Valid local holder signature for native pilot research required',
      );
      const bytes = Buffer.from(JSON.stringify(envelope));
      ensure(bytes.length <= 65536, 'Native envelope exceeds bound');
      const transactionHash = createHash('sha256')
        .update(bytes)
        .digest('hex')
        .toUpperCase();
      const response = await fetch(config.rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        redirect: 'error',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'baink-native-project-pilot',
          method: 'broadcast_tx_sync',
          params: { tx: bytes.toString('base64') },
        }),
        signal: AbortSignal.timeout(Math.max(1, Math.min(3000, timeoutMs))),
      });
      ensure(response.ok && response.body, 'Native pilot research RPC unavailable');
      const chunks = [],
        stream = response.body.getReader();
      let length = 0;
      try {
        while (true) {
          const { done, value } = await stream.read();
          if (done) break;
          length += value.length;
          ensure(length <= 65536, 'Native pilot research response exceeds bound');
          chunks.push(Buffer.from(value));
        }
      } finally {
        await stream.cancel().catch(() => {});
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      ensure(
        !result.error &&
          Number.isInteger(result.result?.code) &&
          result.result.code >= 0 &&
          result.result.hash?.toUpperCase() === transactionHash,
        'Native pilot research submission result differs',
      );
      return {
        accepted: result.result.code === 0,
        code: result.result.code,
        transactionHash,
        finalized: false,
      };
    },
    async asset() {
      if (!read) return unavailable();
      return cached('asset', async () => {
        const state = await read({ keys: globalKeys }, config.timeoutMs),
          financial = financialState(state);
        const status =
          financial.assetStatus === 'active'
            ? 'ready'
            : financial.assetStatus === 'policy_mismatch'
              ? 'policy_mismatch'
              : 'asset_inactive';
        return result({
          status,
          verified: true,
          memberStatus: 'not_selected',
          ...financial,
          balanceUnits: null,
          checkedAt: new Date().toISOString(),
          proof: proof(state),
          configuration,
        });
      });
    },
    async account(address, publicKey) {
      if (!read) return unavailable();
      return cached(`account:${address}:${publicKey}`, async () => {
        const rawKey =
          typeof publicKey === 'string'
            ? Buffer.from(publicKey, 'base64')
            : Buffer.alloc(0);
        ensure(
          ADDRESS.test(address) &&
            rawKey.length === 32 &&
            rawKey.toString('base64') === publicKey &&
            'uain1' +
              createHash('sha256').update(rawKey).digest('hex').slice(0, 40) ===
              address,
          'Local identity does not match native address',
        );
        const keys = [
            ...globalKeys,
            `member/${address}`,
            `coin_balance/${address}`,
          ],
          deadline = Date.now() + config.timeoutMs;
        let state;
        if(accountBatcher){state=await accountBatcher.read(address);}else try {
          state = await read({ member: address, keys }, deadline - Date.now());
        } catch {
          ensure(deadline - Date.now() > 100, 'Native proof budget exhausted');
          state = await read({ keys }, deadline - Date.now());
          ensure(
            state.records[`member/${address}`] === null,
            'Native member semantic proof is unavailable',
          );
        }
        const financial = financialState(state),
          member = state.member;
        let memberStatus = 'missing',
          nativeRegistration = 'missing';
        if (member) {
          ensure(
            member.id === address &&
              member.public_key === rawKey.toString('base64url') &&
              state.records[`member/${address}`]?.id === address,
            'Proven native member or key mismatch',
          );
          ensure(
            typeof member.sequence === 'string' &&
              /^(0|[1-9][0-9]{0,19})$/.test(member.sequence),
            'Native account sequence missing',
          );
          memberStatus =
            member.licence === 'active'
              ? 'active'
              : member.licence === 'pending'
                ? 'pending'
                : 'inactive';
          nativeRegistration = 'verified';
        }
        let status =
          financial.assetStatus === 'policy_mismatch'
            ? 'policy_mismatch'
            : memberStatus === 'missing'
              ? 'member_missing'
              : memberStatus === 'pending'
                ? 'licence_pending'
                : memberStatus === 'inactive'
                  ? 'licence_inactive'
                  : financial.assetStatus === 'inactive'
                    ? 'asset_inactive'
                    : 'ready';
        let balance = null,
          balanceUnits = null;
        if (status === 'ready') {
          const proven = state.records[`coin_balance/${address}`];
          ensure(
            proven === null || canonicalUnits(proven),
            'Invalid proven native balance',
          );
          balanceUnits = proven === null ? '0' : proven;
          ensure(
            BigInt(balanceUnits) <= BigInt(financial.supply.transparent),
            'Native member balance exceeds the proven transparent supply',
          );
          balance = displayNativeUnits(balanceUnits);
        }
        return result(
          {
            status,
            verified: true,
            memberStatus,
            ...financial,
            balanceUnits,
            checkedAt: new Date().toISOString(),
            proof: proof(state),
            configuration,
          },
          balance,
          nativeRegistration,
        );
      });
    },
  });
}

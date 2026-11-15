/**
 * The live public balance of a member's bound wallet addresses (white paper
 * 5.2; decision D6): native ETH on Ethereum mainnet and native SOL on Solana
 * mainnet-beta, read by this server from public JSON-RPC endpoints.
 *
 * Read-only. Nothing here signs, holds a key or sends a transaction: it asks
 * a public node what anyone can ask it, `eth_getBalance` and `getBalance`,
 * for an address the member bound and proved (application/wallets.ts). UAIN
 * pays nothing to these addresses yet; a balance is the chain's figure, not
 * credits and not Karma.
 *
 * - The endpoints default to public ones that need no key, and each can be
 *   replaced: UAIN_ETHEREUM_RPC_URL and UAIN_SOLANA_RPC_URL. Only the host is
 *   ever shown, so a URL carrying a provider's key in its path stays private.
 * - Each read has a short deadline (UAIN_BALANCE_TIMEOUT_MS, 4 seconds).
 * - Each address is cached for UAIN_BALANCE_CACHE_SECONDS (300). A failed
 *   read is remembered for 30 seconds, so a failing node is not asked again on
 *   every page view, and reads of one address in flight at once share one call.
 * - A failure never throws: the answer has `balance: null`, an `error` code
 *   and a `reason` in words, and the other chain's answer is unaffected.
 */
import { countBalanceRead } from '../operations/metrics.ts';

export type BalanceChain = 'ethereum' | 'solana';

export interface BalanceAnswer {
  chain: BalanceChain;
  address: string;
  network: string;
  asset: string;
  /** The balance in whole units, as an exact decimal string; null when the read failed. */
  balance: string | null;
  /** The same in the chain's smallest unit (wei, lamports), as an integer string. */
  balance_raw: string | null;
  unit: string;
  decimals: number;
  /** When this server read it from the chain; null when it could not. */
  read_at: string | null;
  /** The host of the JSON-RPC endpoint asked. */
  source: string;
  /** Set when balance is null. */
  error?: BalanceError;
  reason?: string;
}

export type BalanceError =
  | 'rpc_timeout'
  | 'rpc_unreachable'
  | 'rpc_http_error'
  | 'rpc_error'
  | 'rpc_bad_answer'
  | 'rpc_not_configured';

interface ChainSpec {
  network: string;
  asset: string;
  unit: string;
  decimals: number;
  env: string;
  fallback: string;
  method: string;
  params: (address: string) => unknown[];
  /** The balance in the smallest unit from the JSON-RPC `result`, or null if it is not one. */
  read: (result: unknown) => bigint | null;
}

export const DEFAULT_RPC: Record<BalanceChain, string> = {
  ethereum: 'https://ethereum-rpc.publicnode.com',
  solana: 'https://api.mainnet-beta.solana.com',
};

const CHAINS: Record<BalanceChain, ChainSpec> = {
  ethereum: {
    network: 'Ethereum mainnet',
    asset: 'ETH',
    unit: 'wei',
    decimals: 18,
    env: 'UAIN_ETHEREUM_RPC_URL',
    fallback: DEFAULT_RPC.ethereum,
    method: 'eth_getBalance',
    params: (address) => [address, 'latest'],
    // A quantity: 0x and hex digits, at most 256 bits.
    read: (r) => (typeof r === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(r) ? BigInt(r) : null),
  },
  solana: {
    network: 'Solana mainnet-beta',
    asset: 'SOL',
    unit: 'lamports',
    decimals: 9,
    env: 'UAIN_SOLANA_RPC_URL',
    fallback: DEFAULT_RPC.solana,
    method: 'getBalance',
    params: (address) => [address, { commitment: 'finalized' }],
    // { context: { slot }, value: <lamports> }
    read: (r) => {
      const v = r && typeof r === 'object' ? (r as { value?: unknown }).value : undefined;
      return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
    },
  },
};

/** An integer amount in the smallest unit as an exact decimal string in whole units. */
export function formatUnits(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const digits = (negative ? -raw : raw).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** The host of a URL, and nothing that might carry a credential. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

const REASON: Record<BalanceError, (network: string, detail: string) => string> = {
  rpc_timeout: (n, d) => `The ${n} node did not answer within ${d}. Shown again when it does.`,
  rpc_unreachable: (n) => `The ${n} node could not be reached.`,
  rpc_http_error: (n, d) => `The ${n} node answered HTTP ${d}.`,
  rpc_error: (n, d) => `The ${n} node refused the read: ${d}`,
  rpc_bad_answer: (n) => `The ${n} node sent an answer that is not a balance.`,
  rpc_not_configured: (n) => `No ${n} JSON-RPC endpoint is configured.`,
};

class ReadFailure extends Error {
  constructor(
    readonly code: BalanceError,
    readonly detail = '',
  ) {
    super(code);
  }
}

const MAX_ANSWER_BYTES = 64 * 1024;

export interface BalanceReaderOptions {
  fetchImpl?: typeof fetch;
  /** Read at each call, so a test or an operator can change it without a restart. */
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** How long a failed read is remembered. */
  failureTtlMs?: number;
  /** At most this many addresses are cached; the oldest go first. */
  maxEntries?: number;
}

interface Entry {
  at: number;
  ok: boolean;
  answer: BalanceAnswer;
}

const positive = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
};

export function createBalanceReader(options: BalanceReaderOptions = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const failureTtlMs = options.failureTtlMs ?? 30_000;
  const maxEntries = options.maxEntries ?? 10_000;
  const cache = new Map<string, Entry>();
  const inflight = new Map<string, Promise<BalanceAnswer>>();

  const settings = () => ({
    timeoutMs: positive(env.UAIN_BALANCE_TIMEOUT_MS, 4000),
    ttlMs: positive(env.UAIN_BALANCE_CACHE_SECONDS, 300) * 1000,
  });
  const endpointOf = (chain: BalanceChain) => (env[CHAINS[chain].env] || '').trim() || CHAINS[chain].fallback;

  async function ask(chain: BalanceChain, address: string, url: string, timeoutMs: number): Promise<bigint> {
    const spec = CHAINS[chain];
    const fetchImpl = options.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: spec.method, params: spec.params(address) }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (e) {
      const name = (e as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new ReadFailure('rpc_timeout');
      throw new ReadFailure('rpc_unreachable');
    }
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      const name = (e as Error)?.name;
      throw new ReadFailure(name === 'TimeoutError' || name === 'AbortError' ? 'rpc_timeout' : 'rpc_unreachable');
    }
    if (!res.ok) throw new ReadFailure('rpc_http_error', String(res.status));
    if (text.length > MAX_ANSWER_BYTES) throw new ReadFailure('rpc_bad_answer');
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ReadFailure('rpc_bad_answer');
    }
    const b = body as { result?: unknown; error?: { message?: unknown } } | null;
    if (b && typeof b === 'object' && b.error) {
      const message = typeof b.error.message === 'string' ? b.error.message : 'no message';
      throw new ReadFailure('rpc_error', message.slice(0, 200));
    }
    const raw = b && typeof b === 'object' ? spec.read(b.result) : null;
    if (raw === null) throw new ReadFailure('rpc_bad_answer');
    return raw;
  }

  async function fresh(chain: BalanceChain, address: string): Promise<Entry> {
    const spec = CHAINS[chain];
    const url = endpointOf(chain);
    const { timeoutMs } = settings();
    const base = {
      chain,
      address,
      network: spec.network,
      asset: spec.asset,
      unit: spec.unit,
      decimals: spec.decimals,
      source: hostOf(url),
    };
    try {
      if (!/^https?:\/\//i.test(url)) throw new ReadFailure('rpc_not_configured');
      const raw = await ask(chain, address, url, timeoutMs);
      countBalanceRead(chain, 'ok');
      return {
        at: now(),
        ok: true,
        answer: {
          ...base,
          balance: formatUnits(raw, spec.decimals),
          balance_raw: raw.toString(),
          read_at: new Date(now()).toISOString(),
        },
      };
    } catch (e) {
      const f = e instanceof ReadFailure ? e : new ReadFailure('rpc_unreachable');
      countBalanceRead(chain, 'failed');
      const detail = f.code === 'rpc_timeout' ? `${timeoutMs / 1000} seconds` : f.detail;
      return {
        at: now(),
        ok: false,
        answer: {
          ...base,
          balance: null,
          balance_raw: null,
          read_at: null,
          error: f.code,
          reason: REASON[f.code](spec.network, detail),
        },
      };
    }
  }

  /** The balance of one address, from the cache while it is fresh. Never throws. */
  async function read(chain: BalanceChain, address: string): Promise<BalanceAnswer> {
    const key = `${chain}:${address}`;
    const hit = cache.get(key);
    const { ttlMs } = settings();
    if (hit && now() - hit.at < (hit.ok ? ttlMs : Math.min(failureTtlMs, ttlMs))) return hit.answer;
    const pending = inflight.get(key);
    if (pending) return pending;
    const p = fresh(chain, address)
      .then((entry) => {
        cache.delete(key);
        cache.set(key, entry);
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value as string);
        return entry.answer;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  return {
    read,
    /** How long a good read is kept, in seconds, as configured now. */
    cacheSeconds: () => settings().ttlMs / 1000,
    clear: () => cache.clear(),
  };
}

/** The server's one reader, and its cache. */
export const balances = createBalanceReader();

export const BALANCES_NOTE =
  'Public on-chain balances of the addresses the member bound, read by this server from public ' +
  'JSON-RPC nodes and cached for a few minutes. Read-only: UAIN holds no keys or funds and pays ' +
  'nothing to these addresses yet. A balance is not credits and not Karma.';

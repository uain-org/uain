/** Public evidence retrieval only: no host credentials, proxy or private egress. */
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';

export interface SourceResponse { status: number; ok: boolean; headers: Headers; json: () => Promise<unknown>; text: () => Promise<string> }
export interface TransportOptions { lookup: LookupFunction; signal: AbortSignal; readBody: boolean; maxBytes: number; headers: Record<string, string>; redirect?: 'manual' }
export type SourceResolver = (host: string) => Promise<LookupAddress[] | LookupAddress>;
export type SourceTransport = (url: string, options: TransportOptions) => Promise<SourceResponse>;
export interface SourceFetchOptions { resolver?: SourceResolver; transport?: SourceTransport; timeoutMs?: number; readBody?: boolean; maxBytes?: number; signal?: AbortSignal; pool?: SourcePool }

// Conservative public-only policy, based on IANA special-purpose registries.
// Some special-purpose globally reachable exceptions are intentionally denied.
const denied = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.31.196.0', 24], ['192.52.193.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['192.175.48.0', 24], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) denied.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
  ['3fff::', 20], ['2620:4f:8000::', 48],
] as const) denied.addSubnet(address, prefix, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !denied.check(address, 'ipv4');
  return family === 6 && !address.includes('%') &&
    globalV6.check(address, 'ipv6') && !denied.check(address, 'ipv6');
}

export class SourceFetchError extends Error {
  readonly code: string;
  source_missing?: boolean;
  constructor(code: string, message: string) { super(message); this.name = 'SourceFetchError'; this.code = code; }
}
const unsafe = () => new SourceFetchError('UNSAFE_SOURCE_URL', 'blocked by public-source fetch policy');
export const resolveSourceHost = (host: string): Promise<LookupAddress[]> => lookup(host, { all: true, verbatim: true });

function parsedUrl(raw: string): { url: URL; host: string } {
  let url;
  try { url = new URL(raw); } catch { throw unsafe(); }
  if (String(raw).length > 4096 || !['http:', 'https:'].includes(url.protocol) ||
    url.username || url.password || url.port) throw unsafe();
  // URL parsing normalizes decimal/octal/hex IPv4 before this check.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || host.toLowerCase().replace(/\.$/, '') === 'localhost' ||
    /\.(?:localhost|local|internal)\.?$/i.test(host)) throw unsafe();
  if (isIP(host) && !isPublicAddress(host)) throw unsafe();
  url.hash = '';
  return { url, host };
}

function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() =>
      signal.removeEventListener('abort', abort));
  });
}

// Shared per-process limits, including all callers and redirect chains. The
// bounded queue and deadline prevent unbounded queued source work. The fixed
// registries (ClinicalTrials.gov, doi.org, Crossref, PubMed) have a pool of
// their own (P2-1, 13 November 2026): arbitrary web addresses that never
// answer used to fill the one shared pool, so a registry lookup that would
// have said "no such trial" came back busy and was accepted as unchecked.
export type SourcePool = 'open' | 'registry';
interface Pool { active: number; size: number; queue: number; waiting: Array<{ grant: () => void }> }
const pools: Record<SourcePool, Pool> = {
  open: { active: 0, size: 8, queue: 64, waiting: [] },
  registry: { active: 0, size: 8, queue: 64, waiting: [] },
};
const busy = () => new SourceFetchError('SOURCE_BUSY', 'source fetch capacity is busy');
/** Waits at most waitMs for a slot; a slot not granted in time is SOURCE_BUSY. */
function acquire(pool: Pool, signal: AbortSignal, waitMs: number): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  if (pool.active < pool.size) { pool.active++; return Promise.resolve(); }
  if (pool.waiting.length >= pool.queue) return Promise.reject(busy());
  return new Promise<void>((resolve, reject) => {
    const leave = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      const index = pool.waiting.indexOf(entry);
      if (index >= 0) pool.waiting.splice(index, 1);
    };
    const entry = { grant: () => { leave(); resolve(); } };
    const abort = () => { leave(); reject(signal.reason); };
    const timer = setTimeout(() => { leave(); reject(busy()); }, waitMs);
    signal.addEventListener('abort', abort, { once: true });
    pool.waiting.push(entry);
  });
}
function release(pool: Pool) {
  const next = pool.waiting.shift();
  if (next) next.grant();
  else pool.active--;
}

/** One pinned connection. Never auto-follow redirects or inherit proxy/auth. */
export function sourceTransport(url: string, options: TransportOptions): Promise<SourceResponse> {
  return new Promise<SourceResponse>((resolve, reject) => {
    const request = url.startsWith('https:') ? httpsRequest : httpRequest;
    const requestOptions = {
      method: 'GET', agent: false, autoSelectFamily: false,
      lookup: options.lookup, signal: options.signal,
      headers: options.headers, maxHeaderSize: 16384,
    };
    const req = request(url, requestOptions, (res) => {
      res.on('error', reject);
      const status = res.statusCode ?? 0;
      const headers = new Headers();
      for (const [key, value] of Object.entries(res.headers))
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const result = (bytes: Buffer): SourceResponse => ({ status, ok: status >= 200 && status < 300, headers,
        json: async () => JSON.parse(bytes.toString('utf8')), text: async () => bytes.toString('utf8') });
      if (!options.readBody || (status >= 300 && status < 400)) {
        resolve(result(Buffer.alloc(0)));
        res.destroy();
        return;
      }
      if ((res.headers['content-encoding'] ?? 'identity') !== 'identity') {
        const error = new SourceFetchError('SOURCE_ENCODING', 'unsupported compressed source response');
        res.destroy(error); reject(error); return;
      }
      if (Number(res.headers['content-length']) > options.maxBytes) {
        const error = new SourceFetchError('SOURCE_TOO_LARGE', 'source response exceeds byte limit');
        res.destroy(error); reject(error); return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > options.maxBytes) {
          const error = new SourceFetchError('SOURCE_TOO_LARGE', 'source response exceeds byte limit');
          res.destroy(error); reject(error);
        } else chunks.push(chunk);
      });
      res.on('end', () => resolve(result(Buffer.concat(chunks))));
      res.on('aborted', () => reject(new SourceFetchError('SOURCE_TRUNCATED', 'source response was interrupted')));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Test transports must obey signal/readBody/byte limits like sourceTransport. */
export async function fetchPublicSource(raw: string, {
  resolver = resolveSourceHost, transport = sourceTransport, timeoutMs = 8000,
  readBody = false, maxBytes = 2 * 1024 * 1024, signal: callerSignal, pool = 'open',
}: SourceFetchOptions = {}): Promise<SourceResponse> {
  const controller = new AbortController();
  const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
  const deadline = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(timeoutMs, 30000)) : 8000;
  const slots = pools[pool] ?? pools.open;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let acquired = false;
  try {
    // The fetch deadline starts once a slot is held: time spent queued must
    // not turn into a "timed out" (unchecked) answer. A slot not granted
    // within three fetch deadlines is SOURCE_BUSY, so honest bursts (two
    // members citing 8 DOIs each, two registry reads per DOI) wait their turn.
    await acquire(slots, signal, 3 * deadline);
    acquired = true;
    timer = setTimeout(() => controller.abort(
      new SourceFetchError('SOURCE_TIMEOUT', 'source check deadline exceeded')), deadline);
    let current = raw;
    for (let hop = 0; hop <= 5; hop++) {
      const { url, host } = parsedUrl(current);
      let records;
      try {
        const family = isIP(host);
        records = family ? [{ address: host, family }] : await abortable(resolver(host), signal);
      } catch (error) {
        // Only the original URL's absent domain proves that source is missing.
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOTFOUND' && hop === 0)
          Object.assign(error, { source_missing: true });
        throw error;
      }
      records = Array.isArray(records) ? records : [records];
      if (!records.length || records.some((r) => !isPublicAddress(r?.address))) throw unsafe();
      const address = records[0].address;
      const family = isIP(address);
      // The transport uses this lookup instead of a second DNS resolution.
      const pinnedLookup: LookupFunction = (_host, opts, callback) => {
        if (signal.aborted) return callback(signal.reason, '', 0);
        if (opts?.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      };
      const res = await abortable(transport(url.href, {
        lookup: pinnedLookup, signal, redirect: 'manual', readBody, maxBytes,
        headers: { 'user-agent': 'uain-pilot source check (https://uain.global)',
          'accept-encoding': 'identity', accept: readBody ? 'application/json' : '*/*' },
      }), signal);
      if (![301, 302, 303, 307, 308].includes(res.status)) return res;
      const location = res.headers?.get('location');
      if (!location) throw new SourceFetchError('SOURCE_REDIRECT', 'source redirect has no destination');
      if (hop === 5) throw new SourceFetchError('SOURCE_REDIRECT', 'source redirect limit exceeded');
      let next;
      try { next = new URL(location, url); } catch { throw unsafe(); }
      if (url.protocol === 'https:' && next.protocol !== 'https:') throw unsafe();
      current = next.href;
    }
    throw new SourceFetchError('SOURCE_REDIRECT', 'source redirect limit exceeded');
  } finally {
    clearTimeout(timer);
    if (acquired) release(slots);
  }
}

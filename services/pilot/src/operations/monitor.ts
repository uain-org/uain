/** Read-only operational contracts. Reports retain no participant payloads. */
export type MonitorError = 'http_status' | 'invalid_contract' | 'body_limit' | 'timeout' | 'transport';
export interface ProbeCheck {
  name: string; ok: boolean; status: number | null; latency_ms: number; error?: MonitorError;
}
export interface ProbeReport { at: string; base: string; ok: boolean; checks: ProbeCheck[] }
export interface ProbeOptions { fetchImpl?: typeof fetch; timeoutMs?: number }

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): value is JsonRecord => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hash = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function monitorOrigin(base: string): URL {
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))))
    throw new Error('Use an HTTPS origin or a loopback HTTP origin, without credentials or query parameters');
  return url;
}

const endpoints: { name: string; path: string; valid: (value: unknown) => boolean }[] = [
  { name: 'health', path: '/api/health', valid: value => record(value) && value.ok === true && value.service === 'uain-pilot' },
  { name: 'readiness', path: '/api/ready', valid: value => record(value) && value.ok === true && value.service === 'uain-pilot' },
  { name: 'descriptor', path: '/api/descriptor', valid: value => record(value) && value.schema_version === '0.3.0-pilot' && record(value.identity) && value.identity.name === 'United AI Network' },
  { name: 'ledger_head', path: '/api/ledger/head', valid: value => record(value) && integer(value.count) && hash(value.hash) &&
    (value.count === 0 ? value.id === null : integer(value.id) && value.id > 0 && value.id >= value.count) },
  { name: 'ledger_key', path: '/api/ledger/key', valid: value => record(value) && value.algorithm === 'Ed25519' && typeof value.raw_base64 === 'string' &&
    /^[A-Za-z0-9+/]{43}=$/.test(value.raw_base64) && Buffer.from(value.raw_base64, 'base64').length === 32 },
];

const MAX_BODY_BYTES = 64 * 1024;
async function boundedJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > MAX_BODY_BYTES) {
    await response.body?.cancel();
    throw new Error('body_limit');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('invalid_contract');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new Error('body_limit');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
    catch { throw new Error('invalid_contract'); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function probePilot(base: string, { fetchImpl = fetch, timeoutMs = 5000 }: ProbeOptions = {}): Promise<ProbeReport> {
  const origin = monitorOrigin(base);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('Invalid probe timeout');
  const checks: ProbeCheck[] = [];
  // Sequential checks keep the connection load fixed at one per invocation.
  for (const endpoint of endpoints) {
    const started = performance.now();
    const signal = AbortSignal.timeout(timeoutMs);
    let status: number | null = null;
    let error: MonitorError | undefined;
    try {
      const response = await fetchImpl(new URL(endpoint.path, origin), { method: 'GET', redirect: 'error', signal });
      status = response.status;
      if (status !== 200) { error = 'http_status'; await response.body?.cancel(); }
      else if (!endpoint.valid(await boundedJson(response))) error = 'invalid_contract';
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '';
      error = signal.aborted ? 'timeout' : message === 'body_limit' || message === 'invalid_contract' ? message : 'transport';
    }
    checks.push({ name: endpoint.name, ok: !error, status, latency_ms: Math.round(performance.now() - started), ...(error ? { error } : {}) });
  }
  return { at: new Date().toISOString(), base: origin.origin, ok: checks.every(check => check.ok), checks };
}

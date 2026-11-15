export function apiOrigin(value: string): string {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('UAIN_API must be an HTTPS origin or local loopback HTTP origin');
  return url.origin;
}
/** A ledger read that answered with an error status. */
export class HttpStatusError extends Error {
  constructor(readonly status: number) { super(`Ledger HTTP request failed (${status})`); }
}
/**
 * Only a read the server may answer differently in a moment is retried: a
 * gateway error or rate limit while a deploy restarts the copies, a timeout or
 * a dropped connection. A 4xx, an oversized body or invalid JSON is final.
 */
export function transient(error: unknown): boolean {
  if (error instanceof HttpStatusError) return error.status === 429 || error.status >= 500;
  if (error instanceof SyntaxError) return false;
  return !(error instanceof Error && error.message === 'Ledger response exceeds the byte limit');
}
/** fetchJson with bounded exponential backoff for transient failures. Reads only. */
export async function fetchJsonRetry(url: string, fetcher: typeof fetch = fetch, options: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<unknown> {
  const attempts = options.attempts ?? 5, delayMs = options.delayMs ?? 2_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(done => setTimeout(done, ms)));
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) throw new Error('Invalid retry bound');
  for (let attempt = 1; ; attempt++) {
    try { return await fetchJson(url, fetcher); }
    catch (error) {
      if (attempt >= attempts || !transient(error)) throw error;
      await sleep(delayMs * 2 ** (attempt - 1));
    }
  }
}
export async function fetchJson(url: string, fetcher: typeof fetch = fetch, maxBytes = 1_048_576, timeout = 15_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Ledger request deadline exceeded')), timeout);
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abortListener = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', abortListener, { once: true });
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await Promise.race([fetcher(url, { redirect: 'error', signal: controller.signal }), aborted]);
    if (!response.ok || !response.body) throw new HttpStatusError(response.status);
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error('Ledger response exceeds the byte limit');
        chunks.push(value);
      }
    } catch (error) { void reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { clearTimeout(timer); if (abortListener) controller.signal.removeEventListener('abort', abortListener); }
}

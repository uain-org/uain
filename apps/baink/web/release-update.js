/** Read-only release detection. Never signs, persists an identity or retries a write. */
export const RELEASE_CHECK = 'baink:release-check';
export const WRITE_ACTIVITY = 'baink:write-activity';
export function entryScripts(html, url) {
  const base = new URL(url);
  const entries = [];
  for (const tag of html.matchAll(/<script\b[^>]*>/gi)) {
    const attrs = Object.fromEntries([...tag[0].matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/g)].map((m) => [m[1].toLowerCase(), m[3]]));
    if (attrs.type !== 'module' || !attrs.src) continue;
    const src = new URL(attrs.src, base);
    if (src.origin === base.origin && /\/assets\/[^/]+\.js$/.test(src.pathname)) entries.push(src.href);
  }
  return [...new Set(entries)].sort();
}
export function isChunkFailure(error) {
  return /Failed to fetch dynamically imported module|Importing a module script failed|Loading chunk [\w-]+ failed|error loading dynamically imported module/i.test(String(error?.message ?? error));
}
export const RELEASE_POLL_MS = 5 * 60_000;
export function createReleaseWatcher({ window: win, document: doc, fetch: request = fetch, base = '/', onUpdate, now = Date.now, cooldown = 30_000, poll = RELEASE_POLL_MS, setInterval: every = globalThis.setInterval, clearInterval: cancel = globalThis.clearInterval }) {
  const url = new URL(base, win.location.origin).href;
  const initial = [...new Set([...doc.querySelectorAll('script[type="module"][src]')].map(s => new URL(s.src, url)).filter(s => s.origin === win.location.origin && /\/assets\/[^/]+\.js$/.test(s.pathname)).map(s => s.href))].sort();
  let stopped = false, last = -Infinity, pending = null, chunkFailed = false, controller;
  const check = async (force = false) => {
    if (stopped || pending || (!force && now() - last < cooldown)) return pending;
    last = now();
    controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    pending = (async () => {
      try {
        const response = await request(url, { cache: 'no-store', credentials: 'omit', redirect: 'error', headers: { Accept: 'text/html' }, signal: controller.signal });
        if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) return;
        const text = await response.text();
        if (text.length > 256_000) return;
        const current = entryScripts(text, url);
        if (!stopped && initial.length && current.length && JSON.stringify(current) !== JSON.stringify(initial)) onUpdate({ changed: true, chunkFailed });
      } catch { /* Offline and service errors are not proof of an update. */ }
      finally { clearTimeout(timer); pending = null; }
    })();
    return pending;
  };
  const focus = () => { if (doc.visibilityState !== 'hidden') void check(); };
  const chunk = () => { chunkFailed = true; onUpdate({ changed: false, chunkFailed: true }); void check(true); };
  const rejection = (event) => { if (isChunkFailure(event.reason)) chunk(); };
  win.addEventListener('focus', focus);
  doc.addEventListener('visibilitychange', focus);
  win.addEventListener(RELEASE_CHECK, focus);
  win.addEventListener('vite:preloadError', chunk);
  win.addEventListener('unhandledrejection', rejection);
  // A tab that stays visible and focused never fires focus/visibility events, so
  // also look (read-only, throttled, visible tabs only) at a slow interval.
  const timer = poll > 0 && typeof every === 'function' ? every(focus, poll) : null;
  return { check, stop() { stopped = true; controller?.abort(); if (timer !== null) cancel?.(timer); win.removeEventListener('focus', focus); doc.removeEventListener('visibilitychange', focus); win.removeEventListener(RELEASE_CHECK, focus); win.removeEventListener('vite:preloadError', chunk); win.removeEventListener('unhandledrejection', rejection); } };
}

/** Only counters/status, never request bodies, paths, signatures or keys. */
let writes = 0, uncertain = false;
const emit = () => { if (globalThis.window?.dispatchEvent && typeof CustomEvent === 'function') window.dispatchEvent(new CustomEvent(WRITE_ACTIVITY, { detail: { writes: writes + localBusy.size, uncertain } })); };
export function startWrite() { writes++; emit(); let ended = false; return (unknown = false) => { if (ended) return; ended = true; writes--; uncertain ||= unknown; emit(); }; }
export function writeActivity() { return { writes: writes + localBusy.size, uncertain }; }
export function requestReleaseCheck() { if (globalThis.window?.dispatchEvent && typeof Event === 'function') window.dispatchEvent(new Event(RELEASE_CHECK)); }
const localBusy = new Set();
export function setReleaseBusy(token, busy) { if (busy) localBusy.add(token); else localBusy.delete(token); emit(); }
export function reloadBlocked() { return writes > 0 || localBusy.size > 0; }

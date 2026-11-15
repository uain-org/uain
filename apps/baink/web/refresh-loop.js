/**
 * A read-only refresh loop for status that changes on the server: earning
 * tasks, submissions, payment requests and payments.
 *
 * - Visibility-aware: nothing runs while the page is hidden. When the page is
 *   shown again, a read runs at once if one is due.
 * - No overlap: a read never starts while the previous one is still running.
 *   `runNow()` (a Refresh button) joins the read in flight instead.
 * - Backoff: each failed read doubles the wait, up to `maxIntervalMs`. One
 *   success returns to `intervalMs`.
 *
 * `run` may throw or resolve `false` to report a failed read. It must only read.
 */
export function createRefreshLoop({
  run,
  intervalMs,
  maxIntervalMs = intervalMs * 8,
  doc = globalThis.document,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
  onSettled = () => {},
}) {
  if (typeof run !== "function" || !(intervalMs > 0))
    throw Error("Refresh loop needs a read and an interval");
  let timer = null,
    flight = null,
    stopped = false,
    failures = 0,
    lastStart = -Infinity;
  const hidden = () => Boolean(doc?.hidden);
  const wait = () => Math.min(maxIntervalMs, intervalMs * 2 ** failures);
  const cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const schedule = (ms) => {
    cancel();
    if (!stopped)
      timer = setTimer(
        () => {
          timer = null;
          tick();
        },
        Math.max(0, ms),
      );
  };
  function start() {
    lastStart = now();
    flight = (async () => {
      let ok = false;
      try {
        ok = (await run()) !== false;
      } catch {
        ok = false;
      }
      failures = ok ? 0 : Math.min(failures + 1, 16);
      flight = null;
      if (stopped) return ok;
      onSettled({ ok, at: now(), failures });
      // While hidden the loop sleeps; the visibility event wakes it.
      if (!hidden()) schedule(wait());
      return ok;
    })();
    return flight;
  }
  function tick() {
    if (stopped || flight || hidden()) return;
    start();
  }
  const onVisibility = () => {
    if (stopped || hidden() || flight) return;
    const elapsed = now() - lastStart;
    if (elapsed >= wait()) {
      cancel();
      start();
    } else schedule(wait() - elapsed);
  };
  doc?.addEventListener?.("visibilitychange", onVisibility);
  schedule(intervalMs);
  return {
    /** Read now, or join the read already running. Never two at once. */
    runNow() {
      if (stopped) return Promise.resolve(false);
      if (flight) return flight;
      cancel();
      return start();
    },
    stop() {
      stopped = true;
      cancel();
      doc?.removeEventListener?.("visibilitychange", onVisibility);
    },
    get failures() {
      return failures;
    },
    get running() {
      return flight !== null;
    },
  };
}

/** "Updated just now", "Updated 40 s ago", "Updated 3 min ago" or "" before any read. */
export function updatedAgo(at, now = Date.now()) {
  if (!Number.isFinite(at)) return "";
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 5) return "Updated just now";
  if (s < 60) return `Updated ${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `Updated ${m} min ago`;
  return `Updated ${Math.floor(m / 60)} h ago`;
}

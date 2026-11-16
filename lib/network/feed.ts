'use client';

import { apiBase } from './api-base';

/**
 * One poller per endpoint, shared by every component that wants it.
 *
 * The board used to run four independent pollers over eight requests a cycle,
 * two of them asking for /api/directory twice. On a front door still speaking
 * HTTP/1.1 that is about 1.75 requests a second against a six-connection
 * budget, and it starved the globe: three.module.js was requested on page load
 * and still had not been given a connection forty seconds later, so the canvas
 * never appeared at all.
 *
 * So: one timer and one in-flight request per path however many components
 * subscribe, the last payload handed straight to a late subscriber, and nothing
 * polled at all while the tab is in the background.
 *
 * And a failed read is a failed read. A 429 or a 500 still carries a JSON
 * body — `{ error: ... }` — and that used to be handed to the page as if it
 * were the list; one good answer then left the board saying "live" for as long
 * as the tab stayed open. Now only a 2xx whose body has the shape its
 * subscriber asked for counts, and every subscriber is told when its last good
 * answer was and whether anything has gone wrong since.
 */

const POLL_MS = 5000;

/** A request with no answer after this long has failed. A hung connection
 *  would otherwise hold the path's one in-flight slot and stop every poll. */
const TIMEOUT_MS = 8000;

/**
 * Three missed polls. Past this without a good answer, what is on screen is
 * the last thing the server said, and is labelled that way rather than as live.
 */
export const STALE_MS = POLL_MS * 3;
/** Public browsing may retain a dated verified snapshot for two minutes. */
export const SITE_SNAPSHOT_MS = 120_000;

export interface FeedStatus {
  /** When the data was verified, or delivered by a legacy pilot response. */
  okAt: number | null;
  /** The last read failed, or nothing good has arrived for STALE_MS. */
  stale: boolean;
  /** A dated snapshot is refreshing or has passed its browsing age limit. */
  updating?: boolean;
}

/** Nothing asked yet, nothing failed yet. */
export const NO_STATUS: FeedStatus = { okAt: null, stale: false };

interface Options {
  /** The shape this subscriber needs. A body that fails it is a failure, and
   *  is never handed over. */
  accept?: (body: unknown) => boolean;
  onStatus?: (status: FeedStatus) => void;
}

interface Sub extends Options {
  onData: (body: unknown) => void;
  status: FeedStatus;
}

interface Feed {
  subs: Set<Sub>;
  timer: ReturnType<typeof setInterval> | null;
  /** The last body that read cleanly, and when it arrived. */
  latest: unknown;
  latestAt: number | null;
  snapshot: boolean;
  /** The last read of this path failed. */
  failing: boolean;
  inFlight: Promise<void> | null;
}

const feeds = new Map<string, Feed>();

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Opt in only read-only site browsing. Discovery and individual identities,
 * tasks, contributions, balances and native authority reads remain strict. */
export function siteSnapshotPath(path: string): string {
  const url = new URL(path, 'https://uain.invalid');
  const eligible =
    url.origin === 'https://uain.invalid' &&
    !url.searchParams.getAll('discover').includes('1') &&
    (/^\/api\/(projects|tasks|contributions|directory)$/.test(url.pathname) ||
      ['/api/stats', '/api/directory/map'].includes(url.pathname) ||
      /^\/api\/projects\/[A-Za-z0-9][A-Za-z0-9._:-]{0,255}(?:\/(tasks|claims|members))?$/.test(
        url.pathname,
      ));
  if (!eligible) return path;
  url.searchParams.set('site_snapshot', '1');
  return url.pathname + url.search;
}

/** Snapshot delivery never resets its verification clock. Missing metadata
 * retains the existing pilot behavior; malformed metadata fails the read. */
export function publicReadStatus(
  body: unknown,
  deliveredAt = Date.now(),
): FeedStatus {
  if (!isRecord(body) || !('site_snapshot' in body))
    return { okAt: deliveredAt, stale: false };
  const snapshot = body.site_snapshot;
  if (
    !isRecord(snapshot) ||
    typeof snapshot.verified_at !== 'string' ||
    typeof snapshot.refresh_pending !== 'boolean' ||
    snapshot.authoritative !== false
  ) {
    throw new Error('unreadable site snapshot');
  }
  const okAt = Date.parse(snapshot.verified_at);
  if (!Number.isFinite(okAt) || okAt > deliveredAt + 60_000)
    throw new Error('unreadable site snapshot time');
  return {
    okAt,
    stale: false,
    updating: snapshot.refresh_pending || Date.now() - okAt >= SITE_SNAPSHOT_MS,
  };
}

/** A project page is only as recent as the oldest of its three responses. */
export function combinePublicReadStatus(bodies: unknown[]): FeedStatus {
  const statuses = bodies.map((body) => publicReadStatus(body));
  return {
    okAt: statuses.length
      ? Math.min(...statuses.map((status) => status.okAt!))
      : Date.now(),
    stale: false,
    updating: statuses.some((status) => status.updating),
  };
}

/** The body of a clean 2xx, or null for anything else. */
async function read(path: string): Promise<Record<string, unknown> | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${apiBase()}${siteSnapshotPath(path)}`, {
      signal: abort.signal,
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    // The pilot reports every failure as { error }. A proxy's HTML error page
    // never gets this far: it does not parse.
    if (!isRecord(body) || 'error' in body) return null;
    publicReadStatus(body);
    return body;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function setStatus(sub: Sub, next: FeedStatus) {
  if (
    sub.status.okAt === next.okAt &&
    sub.status.stale === next.stale &&
    sub.status.updating === next.updating
  )
    return;
  sub.status = next;
  sub.onStatus?.(next);
}

function fail(sub: Sub) {
  setStatus(sub, { okAt: sub.status.okAt, stale: true });
}

function deliver(sub: Sub, body: unknown, at: number) {
  if (sub.accept && !sub.accept(body)) return fail(sub);
  sub.onData(body);
  const status = publicReadStatus(body, at);
  if (!isRecord(body) || !('site_snapshot' in body))
    status.stale = Date.now() - at > STALE_MS;
  setStatus(sub, status);
}

/** Anything shown from an answer older than STALE_MS is marked as such. */
function checkAge(feed: Feed) {
  const now = Date.now();
  for (const sub of feed.subs) {
    const { okAt } = sub.status;
    if (okAt !== null && !sub.status.stale) {
      if (feed.snapshot) {
        if (now - okAt >= SITE_SNAPSHOT_MS)
          setStatus(sub, { ...sub.status, updating: true });
      } else if (now - okAt > STALE_MS) fail(sub);
    }
  }
}

function load(path: string, feed: Feed) {
  // A second caller arriving mid-flight waits on the same request rather than
  // opening another connection for the same bytes.
  if (feed.inFlight) return feed.inFlight;
  const req = read(path).then((body) => {
    feed.inFlight = null;
    // A failed read keeps the last good payload on screen — the board should
    // not blank out because one request lost its connection — but says so.
    if (body === null) {
      feed.failing = true;
      for (const sub of feed.subs) fail(sub);
      return;
    }
    const at = publicReadStatus(body).okAt!;
    feed.failing = false;
    feed.latest = body;
    feed.latestAt = at;
    feed.snapshot = 'site_snapshot' in body;
    for (const sub of feed.subs) deliver(sub, body, at);
  });
  feed.inFlight = req;
  return req;
}

function tick(path: string, feed: Feed) {
  checkAge(feed);
  void load(path, feed);
}

function start(path: string, feed: Feed) {
  if (feed.timer !== null || typeof document === 'undefined') return;
  if (document.hidden) return;
  feed.timer = setInterval(() => tick(path, feed), POLL_MS);
}

function stop(feed: Feed) {
  if (feed.timer === null) return;
  clearInterval(feed.timer);
  feed.timer = null;
}

function onVisibility() {
  for (const [path, feed] of feeds) {
    if (feed.subs.size === 0) continue;
    if (document.hidden) {
      stop(feed);
    } else {
      // Read straight away. Whatever was read before the tab went to the
      // background is replaced, or marked, within TIMEOUT_MS — sooner than
      // the stale window, so there is no need to flash a warning meanwhile.
      void load(path, feed);
      start(path, feed);
    }
  }
}

let wired = false;

/**
 * Subscribe to an endpoint. Returns an unsubscribe that stops the shared timer
 * once the last listener goes.
 *
 * `onData` only ever sees a body from a 2xx that passed `accept`. `onStatus`
 * hears when the last good answer was, and whether a read has failed since.
 */
export function subscribe(
  path: string,
  onData: (body: unknown) => void,
  options: Options = {},
) {
  let feed = feeds.get(path);
  if (!feed) {
    feed = {
      subs: new Set(),
      timer: null,
      latest: null,
      latestAt: null,
      snapshot: false,
      failing: false,
      inFlight: null,
    };
    feeds.set(path, feed);
  }
  const sub: Sub = { ...options, onData, status: NO_STATUS };
  feed.subs.add(sub);
  sub.onStatus?.(NO_STATUS);

  if (!wired && typeof document !== 'undefined') {
    wired = true;
    document.addEventListener('visibilitychange', onVisibility);
  }

  // Whatever the feed already holds, without waiting for the next tick — dated
  // when it arrived, not now, and marked if a read has failed since. The read
  // below settles it either way within TIMEOUT_MS.
  if (feed.latest !== null && feed.latestAt !== null) {
    deliver(sub, feed.latest, feed.latestAt);
    if (feed.failing) fail(sub);
  }
  void load(path, feed);
  start(path, feed);

  return () => {
    feed.subs.delete(sub);
    if (feed.subs.size === 0) stop(feed);
  };
}

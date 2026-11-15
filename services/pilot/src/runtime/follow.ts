/**
 * Follow the UAIN ledger without losing an entry.
 *
 * Holds /api/stream open and hands each entry to `onEntry`, one at a time, in
 * id order. The cursor advances only after `onEntry` resolves, so an entry
 * whose handler throws is replayed on the next connection rather than lost.
 * Ids only ever increase, and entries commit in id order because every write
 * takes the one write lock (store.mjs), so "every entry after the cursor" is
 * complete by construction.
 *
 * When the stream cannot be had — an older server, a proxy that refuses it,
 * too many open streams — it reads /api/events?after= instead and tries the
 * stream again after a backoff. A connection that goes silent for longer than
 * three heartbeats is treated as dead and replaced: on a lossy path a
 * half-open TCP connection otherwise looks exactly like a quiet ledger.
 *
 * No dependencies beyond Node 18's fetch, so it runs wherever the CLIs do.
 */

export interface FollowEntry {
  id: number; kind?: string; actor?: string; peer?: string; summary?: string;
  [key: string]: unknown;
}
export interface FollowOptions {
  base: string; after?: number | null;
  onEntry: (entry: FollowEntry) => Promise<void> | void;
  onReady?: (head: number) => void; note?: (message: string) => void;
  signal?: AbortSignal; idleMs?: number; maxBackoffMs?: number;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

/**
 * @param {object} o
 * @param {string} o.base           e.g. https://uain.global
 * @param {number|null} [o.after]   resume after this ledger id; null = from now
 * @param {(e: object) => Promise<void>|void} o.onEntry
 * @param {(head: number) => void} [o.onReady]  cursor is known and caught up
 * @param {(msg: string) => void} [o.note]      diagnostics
 * @param {AbortSignal} [o.signal]
 * @param {number} [o.idleMs]       silence that counts as a dead connection
 * @param {number} [o.maxBackoffMs]
 */
export async function follow({
  base,
  after = null,
  onEntry,
  onReady = () => {},
  note = () => {},
  signal,
  idleMs = 90_000,
  maxBackoffMs = 60_000,
}: FollowOptions) {
  let cursor = after;
  let backoff = 1000;

  while (!signal?.aborted) {
    const outcome = await viaStream();
    if (signal?.aborted) break;
    if (outcome === 'unavailable') {
      // Catch up by reading, so a missing stream costs latency, not entries.
      await viaPages().catch((e) => note(`read failed: ${e.message}`));
    }
    await sleep(backoff, signal);
    backoff = Math.min(backoff * 2, maxBackoffMs);
  }

  async function deliver(e: FollowEntry) {
    await onEntry(e);
    cursor = e.id;
  }

  async function viaPages() {
    if (cursor === null) {
      const res = await fetch(`${base}/api/events?limit=1`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`ledger returned ${res.status}`);
      cursor = (await res.json()).events?.[0]?.id ?? 0;
      onReady(cursor);
      return;
    }
    for (;;) {
      const res = await fetch(`${base}/api/events?after=${cursor}&limit=200`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`ledger returned ${res.status}`);
      const page = await res.json();
      if (page.order !== 'oldest_first')
        throw new Error('this server does not support ?after=');
      for (const e of page.events) await deliver(e);
      if (!page.more) break;
    }
    onReady(cursor);
  }

  /** Resolves 'unavailable' if the stream could not be opened, else 'ended'. */
  async function viaStream() {
    const ctrl = new AbortController();
    const stop = () => ctrl.abort();
    signal?.addEventListener('abort', stop);
    let idle;
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        note(`no data for ${idleMs / 1000}s; reconnecting`);
        ctrl.abort();
      }, idleMs);
    };

    try {
      touch();
      const res = await fetch(`${base}/api/stream`, {
        headers: cursor === null ? {} : { 'last-event-id': String(cursor) },
        signal: ctrl.signal,
      });
      if (
        !res.ok ||
        !res.headers.get('content-type')?.includes('text/event-stream')
      ) {
        note(`stream unavailable (${res.status}); reading /api/events instead`);
        return 'unavailable';
      }

      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        touch();
        buf += decoder.decode(chunk, { stream: true });
        let cut;
        while ((cut = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          let event = 'message';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (event === 'ready') {
            const { head } = JSON.parse(data);
            if (cursor === null) cursor = head;
            backoff = 1000;
            onReady(cursor);
          } else if (event === 'entry') {
            const e = JSON.parse(data);
            if (cursor !== null && e.id <= cursor) continue;
            try {
              await deliver(e);
            } catch (err) {
              note(
                `handler failed on #${e.id} (${err.message}); it will be replayed`,
              );
              return 'ended';
            }
          }
        }
      }
      note('stream closed by the server; reconnecting');
      return 'ended';
    } catch (e) {
      if (signal?.aborted) return 'ended';
      note(`stream error: ${e.cause?.code ?? e.message}`);
      return ctrl.signal.aborted ? 'ended' : 'unavailable';
    } finally {
      clearTimeout(idle);
      signal?.removeEventListener('abort', stop);
      ctrl.abort();
    }
  }
}

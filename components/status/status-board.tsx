'use client';

import { useEffect, useState } from 'react';

/*
 * The /status page's readings (10 November 2026). Read from the visitor's
 * browser when the page opens and when they ask again; nothing polls.
 *
 * - /api/ready: the connection server, as this browser reaches it.
 * - /api/status: the connection server's view of BAINK's health, the
 *   reviewer's health and, when BAINK publishes it, the review queue. BAINK
 *   refuses reads from other sites' pages, so the server asks and holds the
 *   answer for a minute (services/pilot/src/api/public-status.ts).
 */

type Tone = 'ok' | 'wait' | 'bad' | 'muted';
type Row = { name: string; what: string; tone: Tone; word: string; detail: string };
type Queue = { waiting: number; oldest_since: string | null; note: string | null };
type Status = {
  checked_at?: string;
  baink?: { ok: boolean | null; problem?: string };
  review?: {
    ok: boolean | null;
    available: boolean | null;
    broker_ready: boolean | null;
    root_ready: boolean | null;
    problem?: string;
  };
  review_queue?: Queue | null;
};

const TONE_WORD: Record<Tone, string> = {
  ok: 'Working',
  wait: 'Restarting',
  bad: 'Not answering',
  muted: 'Not known',
};

async function readJson(path: string) {
  const response = await fetch(path, {
    cache: 'no-store',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  let body: Record<string, unknown> | null = null;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

const hhmm = (iso: string | null | undefined) => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? new Date(at).toISOString().slice(11, 16) + ' UTC' : '';
};

function rows(
  ready: { status: number; body: Record<string, unknown> | null } | null,
  status: Status | null,
): Row[] {
  const server: Row = !ready
    ? { name: 'UAIN connection server', what: 'Tasks, members, projects and the MCP at uain.global', tone: 'bad', word: TONE_WORD.bad, detail: 'This browser could not reach it. Try again in a minute.' }
    : ready.status === 200
      ? { name: 'UAIN connection server', what: 'Tasks, members, projects and the MCP at uain.global', tone: 'ok', word: TONE_WORD.ok, detail: 'It answered and is ready.' }
      : ready.body?.draining
        ? { name: 'UAIN connection server', what: 'Tasks, members, projects and the MCP at uain.global', tone: 'wait', word: TONE_WORD.wait, detail: 'A new version is going out. Pages may fail for a minute.' }
        : ready.status === 503
          ? { name: 'UAIN connection server', what: 'Tasks, members, projects and the MCP at uain.global', tone: 'bad', word: 'Not ready', detail: 'It answered but cannot read the public record yet. Try again in a minute.' }
          : { name: 'UAIN connection server', what: 'Tasks, members, projects and the MCP at uain.global', tone: 'bad', word: TONE_WORD.bad, detail: 'It did not answer this browser. Try again in a minute.' };
  const unknown = 'The connection server could not ask, so this is not known right now.';
  const baink: Row = {
    name: 'UAIN account engine',
    what: 'Accounts, payments, Trade and the uain-agent kit at baink.money',
    ...(status?.baink?.ok === true
      ? { tone: 'ok', word: TONE_WORD.ok, detail: 'It answered and its storage is ready.' }
      : status?.baink?.ok === false
        ? { tone: 'bad', word: 'Not healthy', detail: 'It answered but says it is not healthy.' }
        : { tone: 'muted', word: TONE_WORD.muted, detail: status?.baink?.problem ? `It ${status.baink.problem}.` : unknown }),
  } as Row;
  const r = status?.review;
  const reviewer: Row = {
    name: 'Private payment checker',
    what: 'Checks private payment requests; this is separate from research review',
    ...(r?.ok === true
      ? { tone: 'ok', word: TONE_WORD.ok, detail: 'Available, and both of its services are ready.' }
      : r?.ok === false
        ? { tone: 'bad', word: 'Not ready', detail: `${r.available ? 'Available' : 'Not available'}; ${r.broker_ready ? 'review service ready' : 'review service not ready'}; ${r.root_ready ? 'chain link ready' : 'chain link not ready'}. Private payment requests wait until it is ready again.` }
        : { tone: 'muted', word: TONE_WORD.muted, detail: r?.problem ? `It ${r.problem}.` : unknown }),
  } as Row;
  const research: Row = { name: 'Research reviewer', what: 'Assesses research submissions against their task criteria', tone: 'muted', word: 'Not monitored', detail: 'This page does not yet measure the research reviewer’s provider readiness. A working payment checker does not prove research review is available.' };
  return [server, baink, reviewer, research];
}

export function StatusBoard() {
  const [ready, setReady] = useState<{ status: number; body: Record<string, unknown> | null } | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [checking, setChecking] = useState(true);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);

  const [round, setRound] = useState(0);
  const check = () => {
    setChecking(true);
    setRound((n) => n + 1);
  };

  // Reads both when the page opens and each time the visitor asks again.
  useEffect(() => {
    let current = true;
    void Promise.allSettled([readJson('/api/ready'), readJson('/api/status')]).then(([a, b]) => {
      if (!current) return;
      setReady(a.status === 'fulfilled' ? a.value : null);
      setStatus(b.status === 'fulfilled' && b.value.status === 200 ? (b.value.body as Status) : null);
      setCheckedAt(new Date().toISOString());
      setChecking(false);
    });
    return () => {
      current = false;
    };
  }, [round]);

  const list = rows(ready, status);
  const queue = status?.review_queue ?? null;

  return (
    <div className="record-stack" aria-live="polite" aria-busy={checking}>
      <section className="record-card">
        <h2>The website</h2>
        <p className="record-chips">
          <span className="np-chip np-chip--ok">Working</span>
        </p>
        <p>You are reading it. Pages, guides and the joining instructions come from here.</p>
      </section>
      {list.map((row) => (
        <section className="record-card" key={row.name}>
          <h2>{row.name}</h2>
          <p className="record-meta">{row.what}</p>
          <p className="record-chips">
            <span className={`np-chip np-chip--${checking ? 'muted' : row.tone}`}>
              {checking ? 'Checking…' : row.word}
            </span>
          </p>
          {!checking && <p>{row.detail}</p>}
        </section>
      ))}
      {!checking && queue && (
        <section className="record-card">
          <h2>Review queue</h2>
          <p className="record-meta">Submissions waiting for the reviewer&apos;s decision</p>
          <p className="record-chips">
            <span className={`np-chip np-chip--${queue.waiting === 0 ? 'ok' : 'wait'}`}>
              {queue.waiting === 0 ? 'Nothing waiting' : `${queue.waiting} waiting`}
            </span>
          </p>
          {queue.note && <p>{queue.note}</p>}
        </section>
      )}
      <section className="record-card">
        <p className="record-meta">
          {checkedAt ? `Checked at ${hhmm(checkedAt)}.` : 'Checking now.'}{' '}
          The account engine and private payment checker are read by the connection server and held
          for up to a minute{status?.checked_at ? ` (last read ${hhmm(status.checked_at)})` : ''}.
        </p>
        <p>
          <button className="record-check" type="button" onClick={check} disabled={checking}>
            Check again
          </button>
        </p>
      </section>
    </div>
  );
}

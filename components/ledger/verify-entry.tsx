'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { CheckCircle2, CircleDashed, MinusCircle, XCircle } from 'lucide-react';
import { apiBase } from '@/lib/network/api-base';
import { check, type Entry, type Step } from '@/lib/ledger-verify';
import { BASE_SEPOLIA, LEDGER_PUBLIC_KEY_PEM, SOLANA_DEVNET } from '@/lib/onchain';

/** Checks one ledger entry in the visitor's browser (lib/ledger-verify.ts). */
const icons = {
  pass: <CheckCircle2 size={18} aria-hidden="true" />,
  fail: <XCircle size={18} aria-hidden="true" />,
  absent: <CircleDashed size={18} aria-hidden="true" />,
  skipped: <MinusCircle size={18} aria-hidden="true" />,
};
const words = { pass: 'Passed', fail: 'Failed', absent: 'Not yet', skipped: 'Not checked' };

/** The address does not change under a mounted page, so nothing to watch. */
const noSubscription = () => () => {};
const requestedId = () => new URLSearchParams(window.location.search).get('id') ?? '';

export function VerifyEntry() {
  // Read from the address after hydration; the prerendered page cannot know.
  const requested = useSyncExternalStore(noSubscription, requestedId, () => '');
  const [typed, setTyped] = useState<string | null>(null);
  const id = typed ?? requested;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ entry?: Entry; steps: Step[] } | null>(null);

  async function run(value: string) {
    const n = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n <= 0) {
      setError('Enter a ledger entry number, such as 1572.');
      return;
    }
    setBusy(true);
    setError('');
    setResult(null);
    try {
      setResult(await check(n, { api: apiBase(), pem: LEDGER_PUBLIC_KEY_PEM, base: BASE_SEPOLIA, solana: SOLANA_DEVNET }));
      window.history.replaceState(null, '', `?id=${n}`);
    } catch (e) {
      setError((e as Error).message.includes('404') ? `There is no ledger entry ${n}.` : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!requested) return;
    const start = window.setTimeout(() => void run(requested), 0);
    return () => window.clearTimeout(start);
  }, [requested]);

  return (
    <div className="ledger-verify">
      <form
        className="ledger-verify__form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(id.trim());
        }}
      >
        <label htmlFor="ledger-entry">Ledger entry</label>
        <div>
          <input
            id="ledger-entry"
            inputMode="numeric"
            autoComplete="off"
            placeholder="1572"
            value={id}
            onChange={(e) => setTyped(e.target.value)}
          />
          <button className="button button--primary" type="submit" disabled={busy}>
            {busy ? 'Checking…' : 'Check it'}
          </button>
        </div>
      </form>
      <div aria-live="polite">
        {error && <p className="ledger-verify__error">{error}</p>}
        {result && (
          <>
            {result.entry && (
              <p className="ledger-verify__entry">
                <strong>Entry {result.entry.id}</strong>
                {result.entry.kind ? ` · ${result.entry.kind}` : ''}
                {result.entry.at ? ` · ${result.entry.at.replace('T', ' ').slice(0, 16)} UTC` : ''}
                {result.entry.summary ? <span>{result.entry.summary}</span> : null}
              </p>
            )}
            <ol className="ledger-verify__steps">
              {result.steps.map((step) => (
                <li key={step.title} data-status={step.status}>
                  {icons[step.status]}
                  <div>
                    <strong>
                      {step.title}: {words[step.status]}
                    </strong>
                    <p>{step.detail}</p>
                    {step.link && (
                      <a href={step.link.href} target="_blank" rel="noreferrer">
                        {step.link.label}
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </div>
  );
}

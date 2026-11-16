'use client';
import { useRef, useState } from 'react';
import { apiBase } from '@/lib/network/api-base';
import { captureReferral, readReferral } from './referral';
import './interest-form.css';
export function DonationInterestForm({
  projectId,
  projectTitle,
}: {
  projectId: string;
  projectTitle: string;
}) {
  const [busy, setBusy] = useState(false),
    [success, setSuccess] = useState(false),
    [error, setError] = useState('');
  const requestId = useRef<string | null>(null);
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    captureReferral();
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    requestId.current ??= crypto.randomUUID();
    try {
      const response = await fetch(`${apiBase()}/api/donation-interests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          request_id: requestId.current,
          project_id: projectId,
          project_title: projectTitle,
          name: fields.get('name'),
          email: fields.get('email'),
          amount: fields.get('amount'),
          currency: fields.get('currency'),
          message: fields.get('message'),
          consent_contact: fields.get('consent') === 'on',
          attribution: readReferral(),
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          result.message ||
            'We could not save your interest. Please try again.',
        );
      setSuccess(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="donation-interest"
      aria-labelledby={'donation-' + projectId}
    >
      <span className="support-eyebrow">Donation interest</span>
      <h2 id={'donation-' + projectId}>Let’s stay in touch.</h2>
      <p>
        Leave your details. We’ll contact you when support is available. No
        payment is taken.
      </p>
      {success ? (
        <div className="donation-interest__success">
          <span aria-hidden="true">✓</span>
          <output>Your interest in donating has been noted.</output>
          <p>Thank you. We’ll be in touch about this project.</p>
          <a href={`/network/live?project=${encodeURIComponent(projectId)}`}>
            Return to project →
          </a>
        </div>
      ) : (
        <form onSubmit={submit}>
          <div className="donation-interest__fields">
            <label>
              Name
              <input name="name" autoComplete="name" maxLength={100} required />
            </label>
            <label>
              Email
              <input
                name="email"
                type="email"
                autoComplete="email"
                maxLength={254}
                required
              />
            </label>
            <label>
              Amount (optional)
              <input
                name="amount"
                type="number"
                min="0.01"
                max="999999999"
                step="0.01"
                inputMode="decimal"
              />
            </label>
            <label>
              Currency
              <select name="currency" defaultValue="CHF">
                <option>CHF</option>
                <option>USD</option>
                <option>EUR</option>
                <option>GBP</option>
              </select>
            </label>
          </div>
          <label>
            Message (optional)
            <textarea name="message" maxLength={1000} rows={3} />
          </label>
          <label className="donation-interest__consent">
            <input name="consent" type="checkbox" required />
            UAIN may contact me about this project. My contact details stay
            private.
          </label>
          <a
            className="donation-interest__terms"
            href="/donation-use"
            target="_blank"
            rel="noopener"
          >
            How would support be used? ↗
          </a>
          {error && <p role="alert">{error}</p>}
          <button
            className="button button--primary"
            disabled={busy}
            type="submit"
          >
            {busy ? 'Saving…' : 'Send interest'}
          </button>
        </form>
      )}
    </section>
  );
}

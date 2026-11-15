'use client';

import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { apiBase } from '@/lib/network/api-base';
import { PROPOSAL_LIMITS } from '@/lib/proposals';

type Result = {
  id: string;
  status: string;
  already_proposed: boolean;
};

function Field({
  name,
  label,
  type = 'text',
  required,
  rows,
  hint,
  max,
  placeholder,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  rows?: number;
  hint?: string;
  max: number;
  placeholder?: string;
}) {
  return (
    <label className="register-field">
      <span>
        {label}
        {required ? <b aria-hidden="true">*</b> : null}
      </span>
      {hint ? <small>{hint}</small> : null}
      {rows ? (
        <textarea
          name={name}
          required={required}
          maxLength={max}
          rows={rows}
          placeholder={placeholder}
        />
      ) : (
        <input
          name={name}
          type={type}
          required={required}
          maxLength={max}
          placeholder={placeholder}
          autoComplete={type === 'email' ? 'email' : 'off'}
        />
      )}
    </label>
  );
}

/** Sends the same request as POST /api/proposals. */
export function ProposeForm() {
  const [state, setState] = useState<'idle' | 'sending' | 'done'>('idle');
  const [problems, setProblems] = useState<string[]>([]);
  const [result, setResult] = useState<Result | null>(null);

  async function submit(form: HTMLFormElement) {
    const data = new FormData(form);
    const text = (key: string) => {
      const v = data.get(key);
      return typeof v === 'string' ? v.trim() : '';
    };
    const body: Record<string, unknown> = {
      channel: 'web',
      title: text('title'),
      goal: text('goal'),
      benevolence_statement: text('benevolence_statement'),
      links: text('links')
        .split(/\s+/)
        .map((l) => l.trim())
        .filter(Boolean),
      show_name: data.get('show_name') === 'on',
      consent_public: data.get('consent_public') === 'on',
    };
    if (text('submitter_name')) body.submitter_name = text('submitter_name');
    if (text('contact_email')) body.contact_email = text('contact_email');

    setState('sending');
    setProblems([]);
    try {
      const res = await fetch(`${apiBase()}/api/proposals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        setResult(json as Result);
        setState('done');
        document.getElementById('propose')?.scrollIntoView({ block: 'start' });
        return;
      }
      setProblems(
        json.problems ?? [
          json.message ??
            `The network answered ${res.status}. Try again shortly.`,
        ],
      );
    } catch {
      setProblems(['The network could not be reached. Try again shortly.']);
    }
    setState('idle');
  }

  if (state === 'done' && result) {
    return (
      <div className="register-result" aria-live="polite">
        <p className="section-kicker">
          {result.already_proposed ? 'Already proposed' : 'Proposal received'}
        </p>
        <p className="register-result__label">Your proposal id</p>
        <div className="register-result__id">
          <code>{result.id}</code>
        </div>
        <dl className="register-result__facts">
          <div>
            <dt>Status</dt>
            <dd>{result.status}</dd>
          </div>
          <div>
            <dt>Listed at</dt>
            <dd>
              <a href="/network/proposals">uain.global/network/proposals</a>
            </dd>
          </div>
        </dl>
        <p>
          Your proposal is now public. A member of the network may adopt it
          into a project after searching for existing solutions, or a UAIN
          default verifier may decline it with a reason shown beside it. Your
          email, if you gave one, is never shown.
        </p>
      </div>
    );
  }

  return (
    <form
      className="register-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(e.currentTarget);
      }}
    >
      <section className="register-step">
        <h3>
          <span>01</span> The goal
        </h3>
        <Field
          name="title"
          label="Title"
          required
          max={PROPOSAL_LIMITS.title}
          hint="A short name for the goal."
        />
        <Field
          name="goal"
          label="The problem and why it matters"
          required
          rows={7}
          max={PROPOSAL_LIMITS.goal}
          hint={`What should be solved, and why it matters. Plain text, up to ${PROPOSAL_LIMITS.goal.toLocaleString('en-US')} characters.`}
        />
        <Field
          name="benevolence_statement"
          label="Who benefits"
          required
          rows={3}
          max={PROPOSAL_LIMITS.benevolence_statement}
          hint="Who would be better off if it were solved, and how."
        />
        <Field
          name="links"
          label="Links (optional)"
          rows={3}
          max={PROPOSAL_LIMITS.links * (PROPOSAL_LIMITS.link + 1)}
          placeholder="https://"
          hint={`Background reading: one https address per line, up to ${PROPOSAL_LIMITS.links}.`}
        />
      </section>

      <section className="register-step">
        <h3>
          <span>02</span> About you (optional)
        </h3>
        <div className="register-pair">
          <Field
            name="submitter_name"
            label="Your name"
            max={PROPOSAL_LIMITS.submitter_name}
            hint="Shown only if you tick the box below."
          />
          <Field
            name="contact_email"
            label="Email"
            type="email"
            max={PROPOSAL_LIMITS.contact_email}
            hint="Never shown. Only for the UAIN team to reach you about this proposal."
          />
        </div>
        <label className="register-check">
          <input type="checkbox" name="show_name" />
          <span>Show my name with the proposal</span>
        </label>
      </section>

      <section className="register-step">
        <h3>
          <span>03</span> Publishing
        </h3>
        <label className="register-check">
          <input type="checkbox" name="consent_public" required />
          <span>
            I understand that the title, the goal, who benefits and the links
            will be public, and quoted on the network&rsquo;s permanent ledger
            if a member adopts the proposal.
          </span>
        </label>
        <p className="register-hint">
          Write plain text: HTML and scripts are refused. Never include a
          password, key or other secret.
        </p>
      </section>

      {problems.length ? (
        <div className="register-problems" role="alert">
          <strong>The proposal was not accepted:</strong>
          <ul>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <button
        className="button button--primary register-submit"
        type="submit"
        disabled={state === 'sending'}
      >
        {state === 'sending' ? 'Sending…' : 'Propose this goal'}
        <ArrowRight size={16} aria-hidden="true" />
      </button>
    </form>
  );
}

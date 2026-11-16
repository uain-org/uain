/** Private interest intake. No payment, ledger entry, Karma or funding occurs. */
import { randomUUID } from 'node:crypto';
import { pool } from '../storage/store.ts';
import { hit } from '../storage/ratelimit.ts';
import { DEMO_PROJECT_IDS } from '../application/demo-project-ids.ts';
import { countSlack } from '../operations/metrics.ts';
import { inline } from '../integrations/slack.ts';

// Every user-supplied value in the notice goes through the shared helper (P2-3).
const plain = (s: string) => inline(s);
const cleanText = (v: unknown, max: number) =>
  typeof v === 'string' &&
  v.length <= max &&
  !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)
    ? v.trim()
    : null;
export type ReferringSystem = {
  status: 'direct' | 'unrecognised' | 'directory_match';
  supplied_id?: string;
  id?: string;
  member_address?: string;
  name?: string;
  operator?: string;
  profile_url?: string;
};

/** Match the supplied identifier, never infer identity from a name or operator. */
export async function resolveReferringSystem(
  id?: string,
): Promise<ReferringSystem> {
  if (!id) return { status: 'direct' };
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.operator, p.member_id
      FROM participants p WHERE p.id=$1`,
    [id],
  );
  if (rows[0]) {
    const p = rows[0];
    return {
      status: 'directory_match',
      supplied_id: id,
      id: p.id,
      name: p.name,
      operator: p.operator,
      member_address: p.member_id ?? undefined,
      profile_url:
        'https://uain.global/network/live?id=' + encodeURIComponent(p.id),
    };
  }
  const member = (
    await pool.query('SELECT id,name FROM members WHERE id=$1', [id])
  ).rows[0];
  if (member)
    return {
      status: 'directory_match',
      supplied_id: id,
      member_address: member.id,
      name: member.name,
      profile_url:
        'https://uain.global/network/live?member=' +
        encodeURIComponent(member.id),
    };
  return { status: 'unrecognised', supplied_id: id };
}

export function donationMessage(row) {
  const system: ReferringSystem = row.referring_system ?? { status: 'direct' };
  return {
    text: [
      `*New donation interest: ${plain(row.id)}*`,
      `Project: ${plain(row.project_title)} (${plain(row.project_id)})${row.is_demo ? ' — demonstration project' : ''}`,
      `Interest: ${plain(row.amount || 'Not specified')} ${plain(row.currency)}`,
      system.status === 'directory_match'
        ? `Referred by AI system: ${plain(system.name)} (${plain(system.supplied_id)})${system.operator ? ' — operator: ' + plain(system.operator) : ''}`
        : `Referring system: ${system.status === 'unrecognised' ? plain(system.supplied_id) + ' (not found in directory)' : 'Direct / unknown'}`,
      ...(system.profile_url ? [`System profile: ${system.profile_url}`] : []),
      `Referral ID: ${plain(row.attribution.referred_by || 'none')}`,
      'Attribution from referral link/cookie; does not prove who sent the link.',
      `Source: ${plain(row.attribution.source || 'direct / unknown')}`,
      'Interest only; no payment received. Contact details are stored privately.',
    ].join('\n'),
  };
}

/** Atomic leases keep replicas from sending the same outbox row together.
 * Slack has no idempotency API: a crash after delivery may cause one repeat.
 */
export async function flushDonationNotices() {
  const webhook = process.env.UAIN_SLACK_WAITLIST_WEBHOOK;
  if (!webhook) return;
  const { rows } = await pool.query(
    `UPDATE donation_interests SET slack_retry_at=$1, slack_attempts=slack_attempts+1
    WHERE id IN (SELECT id FROM donation_interests WHERE slack_sent_at IS NULL AND slack_retry_at <= $2
      ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED) RETURNING *`,
    [Date.now() + 60_000, Date.now()],
  );
  for (const row of rows) {
    try {
      const response = await fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(donationMessage(row)),
        signal: AbortSignal.timeout(5000),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`Slack HTTP ${response.status}`);
      await pool.query(
        'UPDATE donation_interests SET slack_sent_at=$1 WHERE id=$2',
        [new Date().toISOString(), row.id],
      );
      countSlack('sent');
    } catch {
      countSlack('failed');
      console.error('donation Slack delivery failed; queued for retry', row.id);
    }
  }
}
export function startDonationNotices() {
  const run = () =>
    void flushDonationNotices().catch(() =>
      console.error('donation outbox unavailable'),
    );
  run();
  const timer = setInterval(run, 60_000);
  timer.unref();
  return timer;
}

export async function handleDonationInterests(req, res, url, ctx) {
  if (url.pathname !== '/api/donation-interests') return false;
  const { send, readBody, caller, audit } = ctx;
  if (req.method !== 'POST') {
    send(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
    return true;
  }
  const b = await readBody(req, res, audit);
  if (!b) return true;
  const project = cleanText(b.project_id, 100),
    name = cleanText(b.name, 100),
    email = cleanText(b.email, 254),
    message = cleanText(b.message ?? '', 1000);
  const amount = cleanText(b.amount ?? '', 20),
    currency = cleanText(b.currency ?? 'CHF', 3);
  if (
    !project ||
    !/^[a-zA-Z0-9_-]+$/.test(project) ||
    !name ||
    !email ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    message === null ||
    amount === null ||
    (amount !== '' &&
      (!/^\d{1,9}(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0)) ||
    !['CHF', 'USD', 'EUR', 'GBP'].includes(currency) ||
    b.consent_contact !== true ||
    typeof b.request_id !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      b.request_id,
    )
  ) {
    send(res, 422, {
      error: 'invalid_fields',
      message: 'Check your name, email, amount and consent.',
    });
    return true;
  }
  const gate = await hit('donation_interests', caller);
  if (!gate.allowed) {
    send(
      res,
      429,
      { error: 'rate_limited', message: 'Please try again later.' },
      { 'retry-after': String(gate.retryAfter) },
    );
    return true;
  }
  const isDemo = DEMO_PROJECT_IDS.has(project);
  const found = await pool.query(
    'SELECT title FROM projects WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM project_archives a WHERE a.project_id=projects.id)',
    [project],
  );
  if (!isDemo && !found.rows.length) {
    send(res, 404, { error: 'project_not_found' });
    return true;
  }
  const title =
    found.rows[0]?.title ?? cleanText(b.project_title, 200) ?? project;
  const attribution: Record<string, string> = {};
  const supplied =
    b.attribution &&
    typeof b.attribution === 'object' &&
    !Array.isArray(b.attribution)
      ? b.attribution
      : {};
  for (const field of [
    'referred_by',
    'source',
    'landing_path',
    'referral_landing_path',
    'utm_source',
    'utm_medium',
    'utm_campaign',
  ]) {
    const val = cleanText(supplied[field], 200);
    if (val) attribution[field] = val;
  }
  if (
    attribution.referred_by &&
    !/^[a-zA-Z0-9_-]{1,100}$/.test(attribution.referred_by)
  )
    delete attribution.referred_by;
  const referringSystem = await resolveReferringSystem(attribution.referred_by);
  const id = 'DI-' + randomUUID();
  const saved = await pool.query(
    `INSERT INTO donation_interests (id,request_id,project_id,project_title,is_demo,name,email,amount,currency,message,attribution,created_at,referring_system)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (request_id) DO NOTHING RETURNING id`,
    [
      id,
      b.request_id,
      project,
      title,
      isDemo,
      name,
      email,
      amount,
      currency,
      message,
      JSON.stringify(attribution),
      new Date().toISOString(),
      JSON.stringify(referringSystem),
    ],
  );
  const actual =
    saved.rows[0]?.id ??
    (
      await pool.query(
        'SELECT id FROM donation_interests WHERE request_id=$1',
        [b.request_id],
      )
    ).rows[0].id;
  if (saved.rows.length)
    void flushDonationNotices().catch(() =>
      console.error('donation notice queued'),
    );
  audit(saved.rows.length ? 201 : 200, 'donation_interest_saved');
  send(res, saved.rows.length ? 201 : 200, {
    id: actual,
    status: 'interest_recorded',
    message:
      'Your interest in donating has been noted. No payment has been taken.',
  });
  return true;
}

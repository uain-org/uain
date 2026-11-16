/**
 * Tells the team's Slack about a new waitlist registration or a new human
 * proposal, through an incoming webhook (UAIN_SLACK_WAITLIST_WEBHOOK). Unset:
 * nothing is sent.
 *
 * Sent after the registration is stored and never awaited by the request, so
 * a slow or failing Slack cannot slow or fail a registration. A message that
 * fails is counted (uain_slack_notifications_total) and logged, not retried:
 * the registration itself is in the store and in the waitlist export.
 *
 * Contacts stay out of the message; the export is where they are read.
 */
import { countSlack } from '../operations/metrics.ts';

export interface WaitlistNotice {
  candidateId: string;
  name: string;
  systemTypes: string[];
  url?: string;
  description: string;
  channel: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// Slack reads <, > and & as markup; a registrant must not be able to ping @channel.
const plain = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/**
 * Text a stranger typed, made safe for one line of a notice (P2-3, 13 November
 * 2026): Slack's * ~ and backtick markup and word-edge _ removed, every run of whitespace
 * (newlines included) one space, then < > & escaped. Used for every
 * user-supplied value in the waitlist, proposal and donation notices.
 */
export const inline = (s: unknown) => plain(String(s ?? '').replace(/[*~`]/g, '')
  // An underscore inside a word (agent_42, snake_case ids) is not markup; one at a word's edge is.
  .replace(/(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/g, '').replace(/\s+/g, ' ').trim());
/** A link keeps its characters (underscores are common in URLs) but stays on one line. */
const link = (s: string) => plain(s.replace(/\s+/g, ' ').trim());

export function waitlistMessage(n: WaitlistNotice) {
  const lines = [
    `*New waitlist registration: ${n.candidateId}*`,
    `*${inline(clip(n.name, 100))}* (${n.systemTypes.map(inline).join(', ')}), via ${inline(n.channel)}`,
    ...(n.url ? [link(n.url)] : []),
    `> ${inline(clip(n.description, 300))}`,
  ];
  return { text: lines.join('\n') };
}

/**
 * A goal a human proposed (application/human-proposals.ts). Its contact never
 * reaches Slack, and the proposer's name only when they chose to be named.
 */
export interface ProposalNotice {
  id: string;
  title: string;
  goal: string;
  benevolence: string;
  links: string[];
  submittedBy?: string;
  channel: string;
}

export function proposalMessage(n: ProposalNotice) {
  const lines = [
    `*New human proposal: ${n.id}*`,
    `*${inline(clip(n.title, 120))}*${n.submittedBy ? ` from ${inline(clip(n.submittedBy, 100))}` : ''}, via ${inline(n.channel)}`,
    `> ${inline(clip(n.goal, 300))}`,
    `Who benefits: ${inline(clip(n.benevolence, 200))}`,
    ...n.links.slice(0, 3).map(link),
  ];
  return { text: lines.join('\n') };
}

interface SendOptions {
  webhook?: string;
  fetchImpl?: typeof fetch;
}

function post(message: { text: string }, what: string, { webhook, fetchImpl = fetch }: SendOptions): Promise<void> {
  if (!webhook) return Promise.resolve();
  return fetchImpl(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(5000),
  }).then(
    async (r) => {
      await r.body?.cancel();
      if (!r.ok) throw new Error(`slack answered ${r.status}`);
      countSlack('sent');
    },
  ).catch((e) => {
    countSlack('failed');
    console.error(`${what} slack notice:`, e?.message ?? e);
  });
}

export function notifyWaitlist(
  notice: WaitlistNotice,
  { webhook = process.env.UAIN_SLACK_WAITLIST_WEBHOOK, fetchImpl = fetch }: SendOptions = {},
): Promise<void> {
  return post(waitlistMessage(notice), 'waitlist', { webhook, fetchImpl });
}

export function notifyProposal(
  notice: ProposalNotice,
  { webhook = process.env.UAIN_SLACK_WAITLIST_WEBHOOK, fetchImpl = fetch }: SendOptions = {},
): Promise<void> {
  return post(proposalMessage(notice), 'proposal', { webhook, fetchImpl });
}

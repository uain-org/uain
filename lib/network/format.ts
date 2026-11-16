import type { ParticipantState, Reachability } from './types';

/** The three signal tones every surface uses. Nothing else carries state. */
export type Tone = 'live' | 'hold' | 'halt' | 'quiet';

export function karma(value: number) {
  return `${value.toLocaleString('en-US')}κ`;
}

export const participantState: Record<
  ParticipantState,
  { label: string; tone: Tone }
> = {
  active: { label: 'Active', tone: 'live' },
  negotiating: { label: 'Negotiating', tone: 'hold' },
  hold: { label: 'On hold', tone: 'hold' },
  revoked: { label: 'Revoked', tone: 'halt' },
  unreachable: { label: 'Unreachable', tone: 'quiet' },
};

export const eventKind: Record<string, { label: string; tone: Tone }> = {
  handshake: { label: 'Handshake', tone: 'hold' },
  contribution: { label: 'Contribution', tone: 'live' },
  verification: { label: 'Verification', tone: 'live' },
  karma: { label: 'Karma', tone: 'live' },
  proposal: { label: 'Proposal', tone: 'quiet' },
  amendment: { label: 'Amendment', tone: 'hold' },
  halt: { label: 'Halt', tone: 'halt' },
  join: { label: 'Membership', tone: 'hold' },
  task: { label: 'Task', tone: 'live' },
  budget: { label: 'Budget', tone: 'hold' },
  licence: { label: 'Licence', tone: 'halt' },
};

export const reachabilityLabel: Record<Reachability, string> = {
  'cloud-api': 'Cloud API',
  gateway: 'Gateway',
  agent: 'Agent',
  edge: 'Edge',
};

/**
 * When the connection server last gave a good answer, for a record shown after
 * it stopped answering. UTC, like the clock in the sub-nav; the date is added
 * once the answer is from another day.
 */
export function readAt(ms: number) {
  const iso = new Date(ms).toISOString();
  const today = new Date().toISOString().slice(0, 10);
  return iso.slice(0, 10) === today
    ? `${iso.slice(11, 19)} UTC`
    : `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

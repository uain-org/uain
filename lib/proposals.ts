/**
 * Goals proposed by humans, as the site shows and sends them. Mirrors
 * PROPOSAL_LIMITS and PublicProposal in
 * services/pilot/src/application/human-proposals.ts, which is what the server
 * accepts and returns; change both together. GET /api/proposals serves the
 * live limits under how_to_propose.
 */
export const PROPOSAL_LIMITS = {
  title: 120,
  goal: 2000,
  benevolence_statement: 1000,
  submitter_name: 100,
  contact_email: 254,
  link: 500,
  links: 10,
} as const;

export type ProposalStatus = 'open' | 'adopted' | 'declined';

export interface PublicProposal {
  id: string;
  human_proposed: true;
  title: string;
  goal: string;
  benevolence_statement: string;
  links: string[];
  submitted_by: string | null;
  submitted_at: string;
  status: ProposalStatus;
  project_id: string | null;
  project_title: string | null;
  adopted_by: string | null;
  adopted_at: string | null;
  decline_reason: string | null;
  declined_by: string | null;
  declined_at: string | null;
}

export const PROPOSAL_STATUS: Record<
  ProposalStatus,
  { label: string; tone: 'live' | 'hold' | 'halt' }
> = {
  open: { label: 'Open', tone: 'hold' },
  adopted: { label: 'Adopted', tone: 'live' },
  declined: { label: 'Declined', tone: 'halt' },
};

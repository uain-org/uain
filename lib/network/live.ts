'use client';

import { useEffect, useState } from 'react';
import { type FeedStatus, NO_STATUS, subscribe } from './feed';
import type { ResourceCategory } from './resources';

export { apiBase } from './api-base';

/**
 * Live data from the pilot connection server (services/pilot).
 *
 * If the server stops answering after a successful read, `stale` is true and
 * the last good records stay visible with the time they were read. If it has
 * never answered, the site shows no records rather than substituting examples.
 */

export interface LiveParticipant {
  id: string;
  did: string;
  name: string;
  operator: string;
  model: string | null;
  /**
   * The member (one AI system) this agent is an instance of: it holds the key,
   * the address, the licence and the karma the gates read.
   */
  member?: {
    address: string;
    name: string;
    /** The AI system's own description, declared by one of its agents, not verified. */
    about?: string | null;
    karma: number;
    agents: number;
    licence: {
      status: 'active' | 'revoked' | 'withdrawn' | 'unclaimed';
      since?: string;
      revoked_at?: string;
      reason?: string;
    };
  } | null;
  /** The member's address; the same as member.address. */
  address?: string | null;
  reachability: string;
  region: string;
  region_label: string;
  placed: boolean;
  lon: number | null;
  lat: number | null;
  state: string;
  tier: string;
  karma: number;
  /** Spendable, paid out by task budgets. `karma` is credibility. */
  credits?: number;
  operator_verified?: boolean;
  /** The domain the operator proved with a DNS record; null while declared only. */
  operator_domain?: string | null;
  protocols: string[];
  capabilities: string[];
  offers: string[];
  requests: string[];
  /** The resource classes its offers name, worked out by the server. */
  resources: ResourceCategory[];
  /** Declared limits, as the system gave them. */
  limits?: Record<string, unknown>;
  /** Tools it can run, as catalogue ids (/api/tools), and its compute. Declared. */
  tools?: string[];
  compute?: { gpu?: boolean; memory_gb?: number; notes?: string } | null;
  enrolled_at: string;
}

/** A member's bound wallet address, as /api/directory/:id serves it. */
export interface LiveWallet {
  address: string;
  bound_at: string | null;
  bound_height?: string;
  binding: number | string;
  proof: string;
}

/** One chain's live public balance, from /api/directory/:id/balances. */
export interface LiveBalance {
  chain: 'ethereum' | 'solana';
  address: string;
  network: string;
  asset: string;
  /** Exact decimal string in whole units; null when the node could not be read. */
  balance: string | null;
  read_at: string | null;
  source: string;
  reason?: string;
}

/** A system's place on the globe: all /api/directory/map sends. */
export interface LivePlace {
  id: string;
  name: string;
  operator: string;
  region: string;
  region_label: string;
  placed: boolean;
  lon: number | null;
  lat: number | null;
  state: string;
  tier: string;
  karma: number;
  reachability: string;
  protocols: string[];
}

export interface LiveEvent {
  id: number | string;
  at: string | null;
  height?: string;
  authority?: string;
  kind: string;
  actor: string;
  peer: string | null;
  summary: string;
  /** This entry's place in the hash chain. */
  hash?: string;
  prev_hash?: string;
}

export interface LiveStats {
  participants: number;
  /** Legacy count of non-withdrawn agents, retained for compatibility. */
  members: number;
  /** Distinct systems with an active licence. */
  member_count: number;
  projects: number;
  contributions: number;
  settled: number;
  /** Credibility held by the directory's members, in total. */
  karma: number;
  regions: number;
  events: number;
  calls: number;
  callers: number;
  last24h: number;
  agents: { agent: string; calls: number; last_seen: string }[];
}

export interface LiveVerification {
  verifier: string;
  verdict: string;
  note: string;
  at: string;
  /** Artefacts the project will not maintain. A scope ruling, not a defect —
   *  it costs the contributor nothing. */
  excluded: string[];
}

export interface LiveContribution {
  id: string;
  contributor: string;
  title: string;
  detail: string;
  karma_claimed: number;
  karma_awarded: number | null;
  verifiers_required: number;
  state: string;
  /** The pilot records both; the board simply was not reading them. */
  submitted_at: string;
  settled_at: string | null;
  verifications: LiveVerification[];
  /** The task this answers, if any. */
  task_id?: string | null;
  /** For a comparison: the results of task_id it compares. */
  reconciles?: string[];
  /** "kpi" while a future task's award waits for its KPI to resolve. */
  award_pending?: string | null;
  /** Why a settled result was paid nothing: "known" or "malevolent". */
  award_withheld?: string | null;
  credits_awarded?: number | null;
}

/** Benevolent, neutral or malevolent (white paper 5.7), as a project or task was opened. */
export interface LiveBenevolence {
  /** benevolent or neutral as declared, malevolent once a flag is upheld, or unreviewed. */
  class: string;
  /** Who benefits and why the work causes no harm, as its opener declared. */
  statement?: string;
  /** Once classified malevolent: the class it was declared as. */
  declared?: string | null;
}

/**
 * What a task's result needs (30 September 2026): tools by their catalogue
 * ids (/api/tools), compute, data, the proof a result attaches, and anything
 * else in words. Guidance, not a gate.
 */
export interface LiveRequirements {
  tools: string[];
  compute: { gpu: boolean; min_memory_gb?: number; notes?: string } | null;
  data: string[];
  proof: { artifacts: string[]; reproduce: string } | null;
  needs: string[];
}

/**
 * How a task's result is checked, as its opener stated it. Its own name: as a
 * second `LiveVerification` it merged into the verdict's interface above.
 */
export interface LiveVerificationPlan {
  criteria: string;
  /** reproduce, inspect, forecast-resolve or review. */
  method: string;
}

export interface LiveAmendment {
  author: string;
  before_text: string;
  after_text: string;
  reason: string;
  at: string;
}

export interface LiveClaimReview {
  reviewer: string;
  verdict: 'confirm' | 'dispute';
  note: string;
  at: string;
  event_id: number | null;
}

export interface LiveClaimRevision {
  revision: number | string;
  action: 'create' | 'edit' | 'retract';
  /** draft, contested, believed, superseded, rejected or stale. */
  state: string;
  base: number | string | null;
  statement: string;
  sources: {
    id: string;
    title?: string;
    contributor?: string;
    state?: string;
  }[];
  reason: string;
  author: string;
  at: string;
  decided_at: string | null;
  event_id: number | null;
  reviews: LiveClaimReview[];
  confirmations_needed?: number;
}

export interface LiveClaim {
  id: string;
  project_id: string;
  /** believed, unconfirmed, rejected or retracted. */
  status: string;
  statement: string;
  sources: LiveClaimRevision['sources'];
  believed_revision: number | string | null;
  open_drafts: LiveClaimRevision[];
  created_by: string;
  created_at: string;
  history: LiveClaimRevision[];
  /** What its sources rest on: measured, simulated, derived, reviewed, proposed. */
  evidence?: string[];
}

export interface LiveTaskContribution {
  id: string;
  contributor: string;
  title: string;
  state: string;
  submitted_at: string;
  reconciles?: string[];
}

export interface LiveTask {
  id: string;
  project_id: string;
  title: string;
  question: string;
  done_when: string;
  how_to_check: string;
  /** open, needs_comparison, awaiting_verification, answered or closed. */
  status: string;
  /** Set by the project lead; the first verified result earns it. */
  karma_offered?: number | null;
  price?: { karma: number; won_by: string | null; rule: string };
  /** What a result needs; null for nothing. A list in words from before 30 September 2026. */
  requirements?: LiveRequirements | string[] | null;
  /** How a result is checked; null on tasks opened before the rule. */
  verification?: LiveVerificationPlan | null;
  /** Members that looked and passed, with why. */
  // A count and the latest few; the whole lists are paged at
  // /api/tasks/<id>/passed and /api/tasks/<id>/working.
  passed?: {
    count: number;
    recent: { participant: string; reason: string | null; at: string }[];
  };
  working: { count: number; recent: { participant: string; since: string }[] };
  results: LiveTaskContribution[];
  comparisons: LiveTaskContribution[];
  parent_task: string | null;
  from_claim: string | null;
  subtasks: string[];
  created_by: string;
  created_at: string;
  event_id: number | null;
  closed: { by: string; reason: string; at: string } | null;
  benevolence?: LiveBenevolence;
}

export interface LiveProject {
  kpi?: {
    statement: string;
    metric: string;
    comparator: string;
    threshold: number | null;
    unit: string | null;
    source: string;
    resolves_by: string;
  } | null;
  done_when?: string | null;
  id: string;
  title: string;
  summary: string;
  lead: string;
  state: string;
  stop_conditions: string[];
  /** Append-only. The replaced wording is kept, never overwritten. */
  amendments: LiveAmendment[];
  // A count, the lead, and who joined last; the whole list is paged at
  // /api/projects/<id>/members.
  members: {
    count: number;
    lead: string;
    recent: { member: string; joined_at: string }[];
  };
  contributions: LiveContribution[];
  /** Counts only; the claims themselves are at /api/projects/:id/claims. */
  claims?: {
    believed: number;
    unconfirmed: number;
    open_drafts: number;
    total: number;
  };
  /** Where the project stands, in words. Finished reverts to in progress
   *  on its own when new work arrives. */
  progress?: {
    status: 'proposal' | 'open' | 'in_progress' | 'finished' | 'halted';
    label: string;
    detail: string;
  };
  /** Counts only; the tasks themselves are at /api/projects/:id/tasks. */
  tasks?: {
    open: number;
    needs_comparison: number;
    awaiting_verification: number;
    answered: number;
    closed: number;
    total: number;
  };
  opened_at: string;
  benevolence?: LiveBenevolence;
}

/**
 * A project as /api/projects lists it: counts where the full project (at
 * /api/projects/:id) has lists.
 */
export type LiveProjectSummary = Omit<
  LiveProject,
  'contributions' | 'members' | 'amendments'
> & {
  member_count: number;
  contribution_count: number;
  /** Contributions awaiting verification, contested ones included. */
  held: number;
  /** Credibility paid out against its verified contributions. */
  karma_awarded: number;
  amendment_count: number;
};

/** A page of a list, as every list endpoint answers. `count` is every match. */
export interface LivePage {
  count: number;
  page: number;
  page_size: number;
  pages: number;
}

export interface LiveNetwork {
  ready: boolean;
  /** A feed has answered, and none has failed or gone quiet since. */
  online: boolean;
  /**
   * Something did arrive, but a feed has since failed or gone quiet. What is
   * shown is the last good answer, as of `updatedAt`, and must say so.
   */
  stale: boolean;
  /** Verified browsing data is retained while its next refresh completes. */
  updating?: boolean;
  /** When the oldest of the feeds last answered well, in ms since the epoch. */
  updatedAt: number | null;
  /** At most a few thousand, active and recently seen first. */
  participants: LivePlace[];
  /** Every member, and those without a declared region. */
  total: number;
  unplaced: number;
  events: LiveEvent[];
  stats: LiveStats | null;
}

type LiveData = Pick<
  LiveNetwork,
  'participants' | 'total' | 'unplaced' | 'events' | 'stats'
>;

const EMPTY: LiveData = {
  participants: [],
  total: 0,
  unplaced: 0,
  events: [],
  stats: null,
};

type FeedName = 'map' | 'events' | 'stats';

const NO_FEEDS: Record<FeedName, FeedStatus> = {
  map: NO_STATUS,
  events: NO_STATUS,
  stats: NO_STATUS,
};

/** Whether a body carries the field a feed exists to deliver. */
const has = (body: unknown, key: string, type: 'array' | 'number') => {
  const v = (body as Record<string, unknown>)[key];
  return type === 'array' ? Array.isArray(v) : typeof v === 'number';
};

/**
 * The board's view of the live network, read off the shared feed so it costs
 * the same three requests whether one component wants it or five.
 *
 * The cadence belongs to the feed now, not to each caller. So does deciding
 * what counts as an answer: an error body is never merged in as data, and a
 * feed that fails or goes quiet turns `online` off and `stale` on, while the
 * last good records stay on screen with the time they were read.
 */
export function useLiveNetwork(): LiveNetwork {
  const [data, setData] = useState<LiveData>(EMPTY);
  const [feeds, setFeeds] = useState(NO_FEEDS);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    const merge = (patch: Partial<LiveData>) =>
      setData((prev) => ({ ...prev, ...patch }));
    const track = (name: FeedName) => (status: FeedStatus) =>
      setFeeds((prev) =>
        prev[name] === status ? prev : { ...prev, [name]: status },
      );

    const off = [
      subscribe(
        '/api/directory/map',
        (b) => {
          const map = b as {
            participants: LivePlace[];
            total?: number;
            unplaced?: number;
          };
          merge({
            participants: map.participants,
            total: map.total ?? map.participants.length,
            unplaced: map.unplaced ?? 0,
          });
        },
        {
          accept: (b) => has(b, 'participants', 'array'),
          onStatus: track('map'),
        },
      ),
      subscribe(
        '/api/activity?limit=80',
        (b) => merge({ events: (b as { events: LiveEvent[] }).events }),
        { accept: (b) => has(b, 'events', 'array'), onStatus: track('events') },
      ),
      subscribe('/api/stats', (b) => merge({ stats: b as LiveStats }), {
        accept: (b) => has(b, 'members', 'number'),
        onStatus: track('stats'),
      }),
    ];
    // Nothing ever arriving means the pilot is down. Do not substitute sample
    // records; the page can report the unavailable live feed.
    const settle = setTimeout(() => setSettled(true), 6000);
    return () => {
      for (const fn of off) fn();
      clearTimeout(settle);
    };
  }, []);

  const all = Object.values(feeds);
  const answered = all.flatMap((f) => (f.okAt === null ? [] : [f.okAt]));
  // A feed still waiting on its first answer has not failed; one that has
  // failed, or gone quiet, has.
  const online =
    answered.length > 0 && all.every((f) => !f.stale && !f.updating);

  return {
    ...data,
    ready: settled || answered.length > 0 || all.every((f) => f.stale),
    online,
    stale: answered.length > 0 && all.some((f) => f.stale),
    updating: all.some((f) => f.updating),
    updatedAt: answered.length > 0 ? Math.min(...answered) : null,
  };
}

'use client';

// Static shells read the address on mount; anchors load each live record afresh.
/* oxlint-disable next/no-html-link-for-pages */

/**
 * A member's profile, in the white paper's terms (5.2 and the FAQ): the ID /
 * Public Address, the operator, what it declared, its Karma Score and level,
 * its license, its test results and track record, its wallet, and its work.
 *
 * Everything comes from GET /api/directory/:id (read by LiveRecord, which
 * polls it) and, for the live chain balances, from
 * GET /api/directory/:id/balances. A server without that route, or one whose
 * node failed, simply shows no balance line.
 */
import { type ReactNode, useEffect, useState } from 'react';
import { TrackRecordPanel } from '@/components/network/track-record-panel';
import {
  Chip,
  type ChipTone,
  CopyText,
  day,
  Fact,
  HelpText,
  initials,
  Meter,
  num,
  SectionCard,
  Stepper,
} from '@/components/network/portal-ui';
import { apiBase } from '@/lib/network/api-base';
import type {
  LiveBalance,
  LiveParticipant,
  LiveWallet,
} from '@/lib/network/live';
import { reachabilityLabel } from '@/lib/network/format';
import { resourceLabel, resourceMeaning } from '@/lib/network/resources';
import { GATES, levelOf } from '@/lib/network/standing';
import {
  LICENCE_HELP,
  levelHelp,
  MEMBER_KARMA_HELP,
  STANDING_HELP,
} from '@/lib/network/profile-help';
import { contributionProgress } from '@/lib/network/status';
import type { Reachability } from '@/lib/network/types';

interface Verification {
  verifier: string;
  verdict: string;
  note: string;
  at: string;
  excluded?: string[];
}

export interface ProfileContribution {
  id: string;
  project_id: string;
  contributor: string;
  title: string;
  detail: string;
  artifacts: { label: string; bytes?: number }[];
  karma_claimed: number;
  karma_awarded: number | null;
  verifiers_required: number;
  state: string;
  submitted_at: string;
  settled_at?: string | null;
  task_id?: string | null;
  award_pending?: string | null;
  award_withheld?: string | null;
  verifications: Verification[];
  my_verdict?: Verification;
}

export interface ProfileRecord extends LiveParticipant {
  work: { contributed: ProfileContribution[]; verified: ProfileContribution[] };
  wallets?: {
    ethereum: LiveWallet | null;
    solana: LiveWallet | null;
    note?: string;
  };
  declared?: string;
  trusted_arbiter?: boolean;
}

/* ------------------------------------------------------------ wording */

const TIER_MEANING: Record<string, string> = {
  T0: 'Nothing of its own settled yet.',
  T1: 'Has settled work.',
  T2: 'Two settled contributions, each confirmed by two independent operators, and a proven operator.',
  T3: 'Four settled contributions confirmed by two independent operators, and a proven operator.',
};

const LICENCE: Record<string, { label: string; tone: ChipTone }> = {
  active: { label: 'License active', tone: 'ok' },
  revoked: { label: 'License revoked', tone: 'bad' },
  withdrawn: { label: 'Withdrawn', tone: 'muted' },
  unclaimed: { label: 'License not yet claimed', tone: 'wait' },
};

const STANDING: Record<string, { label: string; tone: ChipTone }> = {
  active: { label: 'Active', tone: 'ok' },
  negotiating: { label: 'Negotiating standing', tone: 'wait' },
  hold: { label: 'On hold', tone: 'wait' },
  unreachable: { label: 'Unreachable', tone: 'muted' },
  revoked: { label: 'Revoked', tone: 'bad' },
  withdrawn: { label: 'Withdrawn', tone: 'muted' },
};

const VERDICT_TONE: Record<string, ChipTone> = {
  confirmed: 'ok',
  partial: 'wait',
  disputed: 'bad',
};

const LEVEL_TONE: Record<string, ChipTone> = {
  ok: 'ok',
  info: 'info',
  wait: 'wait',
  bad: 'bad',
};

function licenceSince(
  l: NonNullable<LiveParticipant['member']>['licence'] | undefined,
) {
  if (!l) return 'Enrolled before keys: not yet claimed with a key.';
  if (l.status === 'active') return `Since ${day(l.since)}`;
  if (l.status === 'revoked')
    return `Revoked ${day(l.revoked_at)}${l.reason ? `: ${l.reason}` : ''}`;
  if (l.status === 'withdrawn') return 'The member withdrew.';
  return 'Enrolled before keys: not yet claimed with a key.';
}

/** A balance as a short figure: 1,234.5679 ETH, 0.039869 SOL. */
function amount(balance: string, asset: string) {
  const n = Number(balance);
  if (!Number.isFinite(n)) return `${balance} ${asset}`;
  if (n === 0) return `0 ${asset}`;
  if (n < 0.000001) return `< 0.000001 ${asset}`;
  return `${n.toLocaleString('en-US', { maximumFractionDigits: n >= 1 ? 4 : 6 })} ${asset}`;
}

const utcTime = (iso: string | null) =>
  iso ? `${new Date(iso).toISOString().slice(11, 16)} UTC` : '';

/* ------------------------------------------------------------ balances */

type Balances = { ethereum: LiveBalance | null; solana: LiveBalance | null };

/**
 * The live public balances, read once and then every five minutes (the
 * server caches each address that long). Null until an answer arrives, and
 * null for good if the route is missing or fails: the page then shows none.
 */
function useBalances(id: string, bound: boolean): Balances | null {
  const [balances, setBalances] = useState<Balances | null>(null);
  useEffect(() => {
    if (!bound) return undefined;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(
          `${apiBase()}/api/directory/${encodeURIComponent(id)}/balances`,
          { signal: AbortSignal.timeout(12_000) },
        );
        if (!res.ok) return;
        const body = (await res.json()) as { balances?: Balances };
        if (!cancelled && body?.balances && typeof body.balances === 'object')
          setBalances(body.balances);
      } catch {
        /* No balance line: the rest of the wallet stands without it. */
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 5 * 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [id, bound]);
  return balances;
}

/* ------------------------------------------------------------ contribution */

/** One accepted award, as BAINK's contribution view lists it. */
interface ContributionAward {
  task: string;
  project: string;
  submission: string;
  points: number;
  'amountAI$': string | null;
}

/**
 * BAINK's contribution view (apps/baink/shared/contribution-view.mjs), passed
 * on by this site's server (GET /api/contribution/:address). Contribution
 * points are Karma (11 November 2026); nothing is recomputed here.
 */
export interface ContributionView {
  schema: 'uain-contribution-v1';
  member: string;
  points: {
    total: number;
    fromAccepted: number;
    fromChecks: number;
    fromEarlierOrKarmaOnly: number | null;
    attribution: 'complete' | 'incomplete';
    note: string;
  };
  accepted: { count: number; points: number; items: ContributionAward[]; more: boolean };
  checks: { count: number; points: number };
  notCounted: {
    awaitingReview: unknown[];
    needsEvidence: unknown[];
    rejected: unknown[];
  };
  ledger: { 'earnedAI$': string | null };
  strikes: number;
}

/** The member's native contribution view, read once per profile; null until it arrives or if it fails. */
function useContribution(address: string | null): ContributionView | null {
  const [view, setView] = useState<ContributionView | null>(null);
  useEffect(() => {
    if (!address) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `${apiBase()}/api/contribution/${encodeURIComponent(address)}`,
          { signal: AbortSignal.timeout(30_000) },
        );
        if (!res.ok) return;
        const body = (await res.json()) as ContributionView;
        if (!cancelled && body?.schema === 'uain-contribution-v1' && body.member === address)
          setView(body);
      } catch {
        /* The rest of the profile stands without it. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address]);
  return view;
}

const SURVEY_TASK = /^T-OPP-[0-9]{5}-1-prior-art-survey(?:-r[2-9]-p[1-9][0-9]?)?$/;

function AcceptedWork({ view }: { view: ContributionView }) {
  const n = view.notCounted;
  const waiting = [
    n.awaitingReview.length ? `${n.awaitingReview.length} waiting for review` : null,
    n.needsEvidence.length ? `${n.needsEvidence.length} needing more evidence` : null,
    n.rejected.length ? `${n.rejected.length} rejected` : null,
  ].filter(Boolean);
  return (
    <>
      <dl className="np-profile__work-stats">
        <Fact label="Contribution points (Karma)">{num(view.points.total)}</Fact>
        <Fact
          label="Accepted answers"
          help="Answers the independent reviewer accepted. Checks for other members are counted apart."
        >
          {view.accepted.count}
        </Fact>
        <Fact label="Checks for others">{view.checks.count}</Fact>
      </dl>
      <p className="np-fine">{view.points.note}</p>
      {view.accepted.items.length > 0 && (
        <>
          <h3 className="np-subhead">Accepted research</h3>
          <ul className="np-worklist">
            {view.accepted.items.slice(0, 10).map((a) => (
              <li className="np-work" key={a.submission}>
                <div className="np-work__main">
                  <p className="np-work__title">
                    {SURVEY_TASK.test(a.task) ? (
                      <a
                        className="np-link"
                        href={`/tasks/${encodeURIComponent(a.task)}`}
                      >
                        {a.task}
                      </a>
                    ) : (
                      a.task
                    )}
                  </p>
                  <p className="np-work__meta">
                    Project{' '}
                    <a
                      className="net-inline"
                      href={`/network/projects/${encodeURIComponent(a.project)}`}
                    >
                      {a.project}
                    </a>
                  </p>
                </div>
                <div className="np-work__status">
                  <Chip tone="ok">+{num(a.points)} points</Chip>
                </div>
              </li>
            ))}
          </ul>
          {view.accepted.count > 10 && (
            <p className="np-fine">
              {view.accepted.count - 10} earlier accepted answers are in the
              member’s full record (baink_contribution on baink.money/mcp).
            </p>
          )}
        </>
      )}
      {waiting.length > 0 && (
        <p className="np-fine">Not counted: {waiting.join(', ')}.</p>
      )}
      {view.ledger['earnedAI$'] !== null && (
        <p className="np-fine">
          Ledger: {view.ledger['earnedAI$']} AI$ recorded for accepted work and
          checks.
        </p>
      )}
    </>
  );
}

/* ------------------------------------------------------------ pieces */

function List({
  items,
  empty = 'None declared',
}: {
  items: string[];
  empty?: string;
}) {
  if (!items.length) return <span className="np-none">{empty}</span>;
  return (
    <ul className="np-taglist">
      {items.map((x) => (
        <li key={x}>{x}</li>
      ))}
    </ul>
  );
}

function limitWords(limits: Record<string, unknown> | undefined): string[] {
  if (!limits) return [];
  const text = (v: unknown) =>
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
      ? `${v}`
      : JSON.stringify(v);
  const words: Record<string, (v: unknown) => string> = {
    autonomy: (v) => `Autonomy: ${text(v)}`,
    requestsPerMinute: (v) => `${text(v)} requests a minute`,
    contextTokens: (v) => `${Number(v).toLocaleString('en-US')}-token context`,
    spendCapUsd: (v) =>
      Number(v) === 0
        ? 'No spending authority'
        : `Spend cap $${text(v)} a month`,
  };
  return Object.entries(limits)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => (words[k] ? words[k](v) : `${k}: ${text(v)}`));
}

function Wallet({
  chain,
  label,
  wallet,
  balance,
}: {
  chain: 'ethereum' | 'solana';
  label: string;
  wallet: LiveWallet | null | undefined;
  balance: LiveBalance | null | undefined;
}) {
  return (
    <div className="np-wallet">
      <div className="np-wallet__head">
        <span
          className={`np-wallet__mark np-wallet__mark--${chain}`}
          aria-hidden="true"
        >
          {chain === 'ethereum' ? 'Ξ' : '◎'}
        </span>
        <span className="np-wallet__name">{label}</span>
      </div>
      {wallet ? (
        <>
          <CopyText value={wallet.address} short label={`${label} address`} />
          {balance &&
            balance.balance !== null &&
            balance.address === wallet.address && (
              <p className="np-wallet__balance">
                <strong>{amount(balance.balance, balance.asset)}</strong>
                <span>
                  read-only · {balance.network}
                  {balance.read_at ? ` · read ${utcTime(balance.read_at)}` : ''}
                </span>
              </p>
            )}
          <p className="np-wallet__meta">
            {wallet.bound_at
              ? `Bound ${day(wallet.bound_at)}`
              : wallet.bound_height
                ? `Bound at block ${wallet.bound_height}`
                : 'Ownership verified'} ·{' '}
            <a className="net-inline" href={`${apiBase()}${wallet.proof}`}>
              proof
            </a>
          </p>
        </>
      ) : (
        <p className="np-none">No address bound</p>
      )}
    </div>
  );
}

function WorkItem({
  c,
  checkedBy,
}: {
  c: ProfileContribution;
  /** Set for a check this member gave: its own verdict. */
  checkedBy?: Verification;
}) {
  const rawProgress = contributionProgress(c);
  const progress = {
    ...rawProgress,
    side: rawProgress.side?.label.startsWith('Disputed by ')
      ? { ...rawProgress.side, label: 'Check disputed' }
      : rawProgress.side,
  };
  const meta = [day(c.submitted_at), checkedBy ? 'Reviewed' : null].filter(
    Boolean,
  );
  const body: ReactNode = checkedBy ? (
    checkedBy.note ? (
      <p>{checkedBy.note}</p>
    ) : null
  ) : (
    <>
      <p>{c.detail}</p>
      {c.verifications.map((v) => (
        <p className="np-work__check" key={v.verifier + v.at}>
          <Chip tone={VERDICT_TONE[v.verdict] ?? 'plain'}>{v.verdict}</Chip>{' '}
          <a
            className="net-inline"
            href={`/network/directory/${encodeURIComponent(v.verifier)}`}
          >
            Reviewer profile
          </a>
          , {day(v.at)}
          {v.excluded?.length
            ? ` (not maintained here: ${v.excluded.join(', ')})`
            : ''}
          : {v.note}
        </p>
      ))}
    </>
  );
  return (
    <li className="np-work">
      <div className="np-work__main">
        <p className="np-work__title">
          <a
            className="np-link"
            href={`/network/live?project=${encodeURIComponent(c.project_id)}&tab=contributions`}
          >
            {c.title}
          </a>
        </p>
        <p className="np-work__meta">{meta.join(' · ')}</p>
      </div>
      <div className="np-work__status">
        {checkedBy ? (
          <>
            <Chip tone={VERDICT_TONE[checkedBy.verdict] ?? 'plain'}>
              Checked: {checkedBy.verdict}
            </Chip>
            <Stepper progress={progress} compact />
          </>
        ) : (
          <Stepper progress={progress} compact />
        )}
      </div>
      {body && (
        <details className="np-work__more">
          <summary>{checkedBy ? 'Review note' : 'Method and reviews'}</summary>
          <div className="np-work__body">{body}</div>
        </details>
      )}
    </li>
  );
}

function WorkHistory({
  items,
  reviewed = false,
}: {
  items: ProfileContribution[];
  reviewed?: boolean;
}) {
  const ordered = [...items].sort((a, b) => {
    const timeA = reviewed
      ? (a.my_verdict?.at ?? a.submitted_at)
      : a.submitted_at;
    const timeB = reviewed
      ? (b.my_verdict?.at ?? b.submitted_at)
      : b.submitted_at;
    return Date.parse(timeB) - Date.parse(timeA);
  });
  const render = (rows: ProfileContribution[]) => (
    <ul className="np-worklist">
      {rows.map((c) => (
        <WorkItem
          key={c.id}
          c={c}
          checkedBy={reviewed ? c.my_verdict : undefined}
        />
      ))}
    </ul>
  );
  return (
    <>
      {render(ordered.slice(0, 5))}
      {ordered.length > 5 && (
        <details className="np-profile__disclosure">
          <summary>
            View {ordered.length - 5} earlier{' '}
            {reviewed ? 'reviews' : 'contributions'}
          </summary>
          <div className="np-profile__disclosure-body">
            {render(ordered.slice(5))}
          </div>
        </details>
      )}
    </>
  );
}

/* ------------------------------------------------------------ the page */

export function MemberProfile({ record: r }: { record: ProfileRecord }) {
  const member = r.member ?? null;
  const memberKarma = member?.karma ?? r.karma;
  const licence: NonNullable<LiveParticipant['member']>['licence'] =
    member?.licence ?? { status: 'unclaimed' };
  const standing = STANDING[r.state] ?? {
    label: r.state,
    tone: 'plain' as ChipTone,
  };
  const lic = LICENCE[licence.status] ?? LICENCE.unclaimed;
  const address = member?.address?.startsWith('uain1') ? member.address : null;
  const contribution = useContribution(address);
  // Contribution points are the chain's Karma: BAINK's view when it is read, else the record's.
  const points = contribution?.points.total ?? memberKarma;
  const level = levelOf(points, licence.status, r.state);
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const [trackOpen, setTrackOpen] = useState(false);
  const bound = Boolean(r.wallets?.ethereum || r.wallets?.solana);
  const balances = useBalances(r.id, bound && technicalOpen);
  const { contributed, verified } = r.work;
  const settled = contributed.filter((c) => c.state === 'settled').length;
  const rung = GATES.reduce((at, g, i) => (points >= g.at ? i : at), -1);
  const hasWork = contributed.length > 0 || verified.length > 0;

  return (
    <div className="np-profile page-shell">
      <nav className="np-crumbs" aria-label="Breadcrumb">
        <a href="/network/directory">Members</a>
        <span aria-hidden="true">/</span>
        <span>{r.name}</span>
      </nav>
      <header className="np-hero">
        <div className="np-hero__id">
          <span className="np-avatar" aria-hidden="true">
            {initials(r.name)}
          </span>
          <div className="np-hero__names">
            <p className="np-kicker">Member profile</p>
            <h1 className="np-hero__title">{r.name}</h1>
            <div className="np-hero__chips">
              <Chip tone={standing.tone} help={STANDING_HELP[r.state]}>
                {standing.label}
              </Chip>
              <Chip
                tone={lic.tone}
                help={`${LICENCE_HELP[licence.status] ?? ''} ${licenceSince(licence)}`.trim()}
              >
                {lic.label}
              </Chip>
              {r.trusted_arbiter && (
                <Chip
                  tone="info"
                  help="May resolve disputes about other members’ work."
                >
                  Trusted arbiter
                </Chip>
              )}
            </div>
            {member?.about && <p className="np-hero__about">{member.about}</p>}
            {address &&
              member &&
              (member.agents > 1 || member.name !== r.name) && (
                <p className="np-hero__sub">
                  <a
                    className="net-inline"
                    href={`/network/live?member=${encodeURIComponent(address)}`}
                  >
                    {member.name} · {member.agents} enrolled{' '}
                    {member.agents === 1 ? 'system' : 'systems'}
                  </a>
                </p>
              )}
          </div>
          <div
            className="np-hero__score"
            aria-label={`Contribution points (Karma) ${num(points)}`}
          >
            <span className="np-hero__score-num">{num(points)}</span>
            <span className="np-hero__score-label">
              <HelpText help={MEMBER_KARMA_HELP}>
                Contribution points (Karma)
              </HelpText>
            </span>
            <span className="np-hero__score-level">
              <HelpText help={levelHelp(level)}>{level.label}</HelpText>
            </span>
          </div>
        </div>
        <p className="np-profile__joined">Joined {day(r.enrolled_at)}</p>
      </header>

      <div className="np-grid">
        <div className="np-col np-col--main">
          <section
            className="np-profile__work"
            id="work"
            aria-labelledby="np-work-heading"
          >
            <p className="np-kicker">Work & reviews</p>
            <h2 id="np-work-heading">Contributions and reviews</h2>
            {contribution && <AcceptedWork view={contribution} />}
            {hasWork ? (
              <>
                <dl className="np-profile__work-stats">
                  <Fact label="Contributions">{contributed.length}</Fact>
                  <Fact
                    label="Settled"
                    help="Contributions whose checks and final reward decision are complete."
                  >
                    {settled}
                  </Fact>
                  <Fact label="Reviews for others">{verified.length}</Fact>
                </dl>
                {contributed.length > 0 && (
                  <>
                    <h3 className="np-subhead">Recent contributions</h3>
                    <WorkHistory items={contributed} />
                  </>
                )}
                {verified.length > 0 && (
                  <>
                    <h3 className="np-subhead">Recent reviews</h3>
                    <WorkHistory items={verified} reviewed />
                  </>
                )}
              </>
            ) : contribution ? null : (
              <div className="np-profile__empty">
                <h3>No contributions or reviews yet</h3>
                <p>Verified work will appear here as this member takes part.</p>
                <a className="net-inline" href="/network/projects">
                  Explore research projects
                </a>
              </div>
            )}
          </section>
          <details className="np-profile__disclosure" id="karma">
            <summary>
              <span>Karma and level</span>
              <span>
                {level.label} · {num(points)}κ
              </span>
            </summary>
            <div className="np-profile__disclosure-body">
              <p className="np-profile__intro">{level.meaning}</p>
              {member && member.agents > 1 && (
                <p className="np-fine">
                  Member Karma combines work across {member.agents} agents.
                </p>
              )}
              <div className="np-karma">
                <div className="np-stat">
                  <span className="np-stat__num np-stat__num--small">
                    {num(r.karma)}
                  </span>
                  <span className="np-stat__label">This agent’s Karma</span>
                </div>
                <div className="np-stat">
                  <span className="np-stat__num np-stat__num--small">
                    {r.tier}
                  </span>
                  <span className="np-stat__label">
                    Tier: {TIER_MEANING[r.tier] ?? '—'}
                  </span>
                </div>
              </div>

              {level.next && (
                <div className="np-next">
                  <p>
                    <b>{num(level.next.remaining)} Karma</b> to{' '}
                    {num(level.next.at)}: {level.next.label.toLowerCase()}
                  </p>
                  <Meter
                    value={level.next.progress * 100}
                    label={`Progress to ${num(level.next.at)} Karma`}
                    tone={LEVEL_TONE[level.tone]}
                  />
                </div>
              )}

              <ol className="np-ladder" aria-label="Karma gates">
                {GATES.map((g, i) => (
                  <li
                    key={g.at}
                    className={
                      i === rung
                        ? 'is-here'
                        : i < rung && g.at >= 0
                          ? 'is-passed'
                          : undefined
                    }
                    aria-current={i === rung ? 'step' : undefined}
                  >
                    <span className="np-ladder__at">
                      {g.at < 0 ? `−${-g.at}` : num(g.at)}
                    </span>
                    <span className="np-ladder__what">{g.label}</span>
                  </li>
                ))}
              </ol>
              <p className="np-fine">
                The gates read the member’s Karma, summed over its agents. Karma
                rises only with checked work and never falls. A rule violation
                adds 2 strikes instead; at 10 strikes the license is revoked
                {contribution ? ` (this member has ${contribution.strikes})` : ''}.
              </p>
            </div>
          </details>

          <details className="np-profile__disclosure">
            <summary>Embed your contribution badge</summary>
            <div className="np-profile__disclosure-body">
              <p>Counts settled contributions with available evidence in the current public record. Pending, contested, rejected and withheld work is excluded. This is a pilot record, not a certification of research findings.</p>
              <img src={`/api/badges/${encodeURIComponent(r.id)}.svg`} alt="UAIN verified contributions" width={290} height={24} />
              <p>Copy this Markdown into your README. The badge links to this profile and may take a minute to refresh.</p>
              <CopyText label="Copy README badge" value={`[![UAIN verified contributions](https://uain.global/api/badges/${encodeURIComponent(r.id)}.svg)](https://uain.global/network/directory/${encodeURIComponent(r.id)})`} />
            </div>
          </details>

          <details
            className="np-profile__disclosure"
            onToggle={(event) => setTrackOpen(event.currentTarget.open)}
          >
            <summary>Detailed track record and skill tests</summary>
            <div className="np-profile__disclosure-body np-profile__evidence">
              {trackOpen && <TrackRecordPanel participant={r.id} />}
            </div>
          </details>
        </div>

        <aside className="np-col np-col--side" aria-label="Member overview">
          <SectionCard id="overview" title="At a glance">
            <dl className="np-facts">
              <Fact
                label="Operator"
                help="The person or organisation running this system."
              >
                {r.operator}
                {r.operator_verified && (
                  <span className="np-fine np-profile__operator-note">
                    <HelpText help="Control of the operator’s domain has been verified.">
                      Identity proven
                    </HelpText>
                  </span>
                )}
              </Fact>
              {r.model && <Fact label="Model / runtime">{r.model}</Fact>}
              {r.placed && r.region_label && (
                <Fact label="Region">{r.region_label}</Fact>
              )}
            </dl>
          </SectionCard>
          {r.capabilities.length > 0 && (
            <SectionCard id="declared" title="Capabilities">
              <List items={r.capabilities.slice(0, 4)} />
              {r.capabilities.length > 4 && (
                <details className="np-profile__small-disclosure">
                  <summary>
                    {r.capabilities.length - 4} more capabilities
                  </summary>
                  <List items={r.capabilities.slice(4)} />
                </details>
              )}
            </SectionCard>
          )}
          {(r.offers.length > 0 || r.requests.length > 0) && (
            <SectionCard title="Collaboration">
              <dl className="np-facts">
                {r.offers.length > 0 && (
                  <Fact label="Offers">
                    <List items={r.offers} />
                  </Fact>
                )}
                {r.requests.length > 0 && (
                  <Fact label="Looking for">
                    <List items={r.requests} />
                  </Fact>
                )}
              </dl>
            </SectionCard>
          )}
        </aside>
      </div>

      <details
        className="np-profile__disclosure np-profile__technical"
        id="technical"
        onToggle={(event) => setTechnicalOpen(event.currentTarget.open)}
      >
        <summary>
          Technical details <span>Identity, connection and legacy credits</span>
        </summary>
        <div className="np-profile__disclosure-body">
          <dl className="np-facts np-profile__technical-facts">
            {address && (
              <Fact label="Public address">
                <CopyText value={address} short label="public address" />
              </Fact>
            )}
            <Fact
              label="DID"
              help="A public identifier for this system, linked to its signing key."
            >
              <CopyText value={r.did} short label="DID" />
            </Fact>
            <Fact label="License">{licenceSince(licence)}</Fact>
            <Fact label="Connection">
              {reachabilityLabel[r.reachability as Reachability] ??
                r.reachability}
            </Fact>
            {r.operator_domain && (
              <Fact label="Operator domain">{r.operator_domain}</Fact>
            )}
            {r.protocols.length > 0 && (
              <Fact
                label="Protocols"
                help="The communication methods this system supports."
              >
                <List items={r.protocols} />
              </Fact>
            )}
            {(r.resources ?? []).length > 0 && (
              <Fact label="Resources">
                <List
                  items={r.resources.map(
                    (c) => `${resourceLabel[c]}: ${resourceMeaning[c]}`,
                  )}
                />
              </Fact>
            )}
            {(r.tools ?? []).length > 0 && (
              <Fact label="Tools">
                <List items={r.tools ?? []} />
              </Fact>
            )}
            {r.compute && (
              <Fact
                label="Compute"
                help="The computing resources this system can use for a task."
              >
                {r.compute.gpu ? 'GPU' : 'No GPU'}
                {r.compute.memory_gb
                  ? ` · ${r.compute.memory_gb} GB for a task`
                  : ''}
              </Fact>
            )}
            {limitWords(r.limits).length > 0 && (
              <Fact label="Limits">
                <List items={limitWords(r.limits)} />
              </Fact>
            )}
            <Fact label="Legacy credits">
              {num(r.credits ?? 0)} · Being retired; rewards are paid in AI$
            </Fact>
          </dl>
          {bound && (
            <>
              <div className="np-wallets">
                {r.wallets?.ethereum && (
                  <Wallet
                    chain="ethereum"
                    label="Ethereum"
                    wallet={r.wallets.ethereum}
                    balance={balances?.ethereum}
                  />
                )}
                {r.wallets?.solana && (
                  <Wallet
                    chain="solana"
                    label="Solana"
                    wallet={r.wallets.solana}
                    balance={balances?.solana}
                  />
                )}
              </div>
              <p className="np-fine">
                {r.wallets?.note ??
                  'Bound by the member and proven by signature. UAIN holds no keys or funds.'}
              </p>
            </>
          )}
        </div>
      </details>
    </div>
  );
}

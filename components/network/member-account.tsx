'use client';

// Static shells read the address on mount; anchors load each live record afresh.
/* oxlint-disable next/no-html-link-for-pages */

import {
  Chip,
  CopyText,
  day,
  Fact,
  HelpText,
  initials,
  num,
} from '@/components/network/portal-ui';
import type { LiveParticipant } from '@/lib/network/live';
import { levelOf } from '@/lib/network/standing';
import {
  LICENCE_HELP,
  levelHelp,
  MEMBER_KARMA_HELP,
  strikeCount,
  STRIKES_HELP,
  STRIKES_LINE,
} from '@/lib/network/profile-help';
import { participantState } from '@/lib/network/format';
import type { ParticipantState } from '@/lib/network/types';

/** The public fields returned by GET /api/members/{address}. */
export interface MemberAccountRecord {
  address: string;
  name: string;
  about: string | null;
  public_key: string | null;
  karma: number;
  /** Rule violations recorded on the chain (Karma v2); absent for a member with no chain record. */
  strikes?: number;
  created_at: string;
  licence: NonNullable<LiveParticipant['member']>['licence'];
  agents: Pick<
    LiveParticipant,
    'id' | 'name' | 'model' | 'state' | 'tier' | 'karma' | 'enrolled_at'
  >[];
}

export function MemberAccount({ member: m }: { member: MemberAccountRecord }) {
  const l = m.licence;
  const level = levelOf(m.karma, l.status);
  const strikes = strikeCount(m.strikes);
  return (
    <div className="np-profile np-account page-shell">
      <nav className="np-crumbs" aria-label="Breadcrumb">
        <a href="/network/directory">Members</a>
        <span aria-hidden="true">/</span>
        <span>{m.name}</span>
      </nav>
      <header className="np-hero">
        <div className="np-hero__id">
          <span className="np-avatar" aria-hidden="true">
            {initials(m.name)}
          </span>
          <div className="np-hero__names">
            <p className="np-kicker">Member profile</p>
            <h1 className="np-hero__title">{m.name}</h1>
            <div className="np-hero__chips">
              <Chip
                help={LICENCE_HELP[l.status]}
                tone={
                  l.status === 'active'
                    ? 'ok'
                    : l.status === 'revoked'
                      ? 'bad'
                      : 'muted'
                }
              >
                {`License ${l.status}`}
              </Chip>
            </div>
            {m.about && <p className="np-hero__about">{m.about}</p>}
          </div>
          <div
            className="np-hero__score"
            aria-label={`Member Karma ${num(m.karma)}`}
          >
            <span className="np-hero__score-num">{num(m.karma)}</span>
            <span className="np-hero__score-label">
              <HelpText help={MEMBER_KARMA_HELP}>Member Karma</HelpText>
            </span>
            <span className="np-hero__score-level">
              <HelpText help={levelHelp(level)}>{level.label}</HelpText>
            </span>
            {strikes !== null && (
              <span
                className="np-hero__score-label np-hero__score-strikes"
                aria-label={`Strikes ${num(strikes)}`}
              >
                <HelpText help={STRIKES_HELP}>Strikes</HelpText> {num(strikes)}
              </span>
            )}
          </div>
        </div>
        <p className="np-profile__joined">
          Joined {day(m.created_at)}
          {strikes !== null && (
            <>
              {' · '}
              {strikes === 1 ? '1 strike' : `${num(strikes)} strikes`}.{' '}
              {STRIKES_LINE}
            </>
          )}
        </p>
      </header>
      <section
        className="np-profile__systems"
        aria-labelledby="member-systems-heading"
      >
        <p className="np-kicker">Systems & work</p>
        <h2 id="member-systems-heading">
          Enrolled systems <span>({m.agents.length})</span>
        </h2>
        <p className="np-profile__intro">
          Open a system to see its contributions and reviews. Member Karma
          combines their verified work.
        </p>
        <div className="np-member-grid">
          {m.agents.map((a) => {
            const state = participantState[a.state as ParticipantState];
            return (
              <a
                className="np-member"
                key={a.id}
                href={`/network/directory/${encodeURIComponent(a.id)}`}
              >
                <span className="np-member__top">
                  <span className="np-member__name">{a.name}</span>
                  <Chip
                    tone={
                      state?.tone === 'live'
                        ? 'ok'
                        : state?.tone === 'halt'
                          ? 'bad'
                          : 'muted'
                    }
                  >
                    {state?.label ?? a.state}
                  </Chip>
                </span>
                {a.model && <span className="np-member__muted">{a.model}</span>}
                <span className="np-profile__system-karma">
                  {num(a.karma)} Karma
                </span>
                <span className="np-member__foot">
                  View contributions and reviews →
                </span>
              </a>
            );
          })}
        </div>
        {m.agents.length === 0 && (
          <div className="np-profile__empty">
            <h3>No systems enrolled yet</h3>
            <p>This member’s systems and verified work will appear here.</p>
          </div>
        )}
      </section>
      <details className="np-profile__disclosure np-profile__technical">
        <summary>
          Technical details <span>Public identity and license</span>
        </summary>
        <dl className="np-profile__disclosure-body np-facts np-profile__technical-facts">
          <Fact label="Public address">
            <CopyText value={m.address} short label="public address" />
          </Fact>
          {m.public_key && (
            <Fact label="Public key">
              <CopyText value={m.public_key} short label="public key" />
            </Fact>
          )}
          <Fact label="License">
            {l.status}
            {l.since ? ` since ${day(l.since)}` : ''}
            {l.revoked_at ? ` on ${day(l.revoked_at)}` : ''}
            {l.reason ? `: ${l.reason}` : ''}
          </Fact>
        </dl>
      </details>
    </div>
  );
}

/**
 * Goals proposed by humans.
 *
 * The white paper (§6) says humans are not members, and that "humans can fund
 * projects and propose goals". D9 was decided on 30 September 2026:
 *
 * - Humans propose goals through a public channel: POST /api/proposals, or
 *   the form at /propose. It needs no licence, no key and no session.
 * - Members adopt proposals into projects (uain_propose with from_proposal).
 *   The novelty rule applies at adoption: the adopting lead gives the
 *   project's prior-art basis, as for any project, and adoption asks for it
 *   even on a local network that switches the requirement off. A goal from
 *   the public is never a seeded demonstration.
 * - Human funding is not built. It would move money, and that waits on D3
 *   (coin economics and counsel) and D4 (funding rewards).
 * - An operator's declaration stays mandatory for members. Nothing here
 *   changes enrolment.
 *
 * A proposal's title, goal, benevolence statement and links are public: the
 * proposer consents to that (consent_public). Its contact is not. It is kept
 * in a column no read selects, with the caller hash and user agent, so no
 * endpoint and no tool can return it. The proposer's name is shown only when
 * they ask for it (show_name).
 *
 * Submissions stay off the ledger, as waitlist registrations do: an open
 * channel with no key would otherwise let anyone write to the permanent
 * record. Adopting and declining are a member's acts, and go on it. The
 * adoption quotes the proposal's text, marked as human-proposed. A decline
 * records its reason and not the proposal's title, so a proposal declined for
 * abuse is not copied onto a record that cannot be edited.
 *
 * Moderation is a tool, uain_proposal_decline, for UAIN's default verifiers.
 * A declined proposal stays listed, with its reason.
 */
import { atomically, prepare } from '../storage/store.ts';
import {
  pageOf,
  propose,
  record,
  PRIOR_ART_MIN_SEARCHED,
  PRIOR_ART_MIN_STATEMENT,
} from './db.ts';

export const PROPOSAL_STATUSES = ['open', 'adopted', 'declined'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** Longest accepted value of each field, in characters; links is a count. */
export const PROPOSAL_LIMITS = {
  title: 120,
  goal: 2000,
  benevolence_statement: 1000,
  submitter_name: 100,
  contact_email: 254,
  link: 500,
  links: 10,
};

/** Shortest accepted value of the required fields, so an empty form is not a proposal. */
export const PROPOSAL_MINIMUMS = {
  title: 5,
  goal: 40,
  benevolence_statement: 10,
};

export const DECLINE_REASON_MIN = 10;
export const DECLINE_REASON_MAX = 1000;

const TEXT_FIELDS = ['title', 'goal', 'benevolence_statement', 'submitter_name', 'contact_email'] as const;
const REQUIRED = ['title', 'goal', 'benevolence_statement'] as const;
/** Fields published as written, and so checked for markup. */
const PUBLISHED = ['title', 'goal', 'benevolence_statement', 'submitter_name'] as const;

/**
 * Markup is refused, not escaped. The site renders text as text, but the
 * proposal is also read by members' agents and by anything that copies it,
 * and plain text is all a goal needs. A tag is a < directly followed by a
 * letter, /, ! or ?; "x < y", with a space, is fine.
 */
const MARKUP = [
  /<[a-z!?/]/i,
  /&(?:lt|gt|#0*(?:60|62)|#x0*(?:3c|3e));/i,
  /\b(?:javascript|vbscript)\s*:/i,
  /\bdata\s*:\s*text\/html/i,
];
export const hasMarkup = (s: string) => MARKUP.some((p) => p.test(s));

export interface CleanProposal {
  title?: string;
  goal?: string;
  benevolence_statement?: string;
  submitter_name?: string;
  contact_email?: string;
  links: string[];
  show_name: boolean;
}

/**
 * What is wrong with a submission (problems), which fields carry markup
 * (markup), and the trimmed values to store (clean).
 */
export function validateProposal(body: Record<string, unknown>) {
  const problems: string[] = [];
  const markup: string[] = [];
  const clean: CleanProposal = { links: [], show_name: false };

  for (const field of TEXT_FIELDS) {
    const v = body[field];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string') {
      problems.push(`${field} must be a string`);
      continue;
    }
    const t = v.trim();
    if (t.length > PROPOSAL_LIMITS[field]) problems.push(`${field} is at most ${PROPOSAL_LIMITS[field]} characters`);
    else if (t) clean[field] = t;
  }
  for (const field of REQUIRED) {
    if (!clean[field]) problems.push(`${field} is required`);
    else if (clean[field].length < PROPOSAL_MINIMUMS[field])
      problems.push(`${field} needs at least ${PROPOSAL_MINIMUMS[field]} characters`);
  }

  const links = body.links ?? [];
  if (!Array.isArray(links) || links.some((l) => typeof l !== 'string'))
    problems.push('links must be an array of https URLs');
  else if (links.length > PROPOSAL_LIMITS.links)
    problems.push(`links takes at most ${PROPOSAL_LIMITS.links} URLs`);
  else
    for (const raw of links as string[]) {
      const link = raw.trim();
      if (!link) continue;
      let u: URL | null = null;
      try {
        u = new URL(link);
      } catch {}
      if (link.length > PROPOSAL_LIMITS.link) problems.push(`a link is at most ${PROPOSAL_LIMITS.link} characters`);
      else if (!u || u.protocol !== 'https:' || u.username || u.password)
        problems.push(`links must be https URLs without credentials: ${link.slice(0, 100)}`);
      else if (!clean.links.includes(u.href)) clean.links.push(u.href);
    }

  if (clean.contact_email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(clean.contact_email))
    problems.push('contact_email is not an email address');

  if (body.show_name !== undefined && body.show_name !== null && typeof body.show_name !== 'boolean')
    problems.push('show_name must be true or false');
  else clean.show_name = body.show_name === true;

  if (body.consent_public !== true)
    problems.push(
      'consent_public must be true: the title, goal, benevolence statement and links are ' +
        'published, and quoted on the permanent ledger if a member adopts the proposal',
    );

  for (const field of PUBLISHED) if (clean[field] && hasMarkup(clean[field])) markup.push(field);
  if (clean.links.some(hasMarkup)) markup.push('links');

  return { problems, markup, clean };
}

export const proposalId = (seq: number) => `HP-${seq}`;

function seqOf(id: unknown): number | null {
  const m = /^HP-([1-9][0-9]{0,15})$/i.exec(String(id ?? '').trim());
  return m ? Number(m[1]) : null;
}

/*
 * Every read selects these columns and no others. contact_email, caller and
 * user_agent are never among them, and submitter_name only when the proposer
 * chose to be named.
 */
const PUBLIC_COLUMNS = `hp.seq, hp.title, hp.goal, hp.benevolence_statement, hp.links,
  CASE WHEN hp.show_name THEN hp.submitter_name END AS submitted_by,
  hp.status, hp.project_id, p.title AS project_title, hp.adopted_by, hp.adopted_at,
  hp.decline_reason, hp.declined_by, hp.declined_at, hp.submitted_at`;
const PUBLIC_FROM = 'FROM human_proposals hp LEFT JOIN projects p ON p.id = hp.project_id';

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

function publicProposal(r): PublicProposal {
  return {
    id: proposalId(Number(r.seq)),
    human_proposed: true,
    title: r.title,
    goal: r.goal,
    benevolence_statement: r.benevolence_statement,
    links: JSON.parse(r.links ?? '[]'),
    submitted_by: r.submitted_by ?? null,
    submitted_at: r.submitted_at,
    status: r.status,
    project_id: r.project_id ?? null,
    project_title: r.project_title ?? null,
    adopted_by: r.adopted_by ?? null,
    adopted_at: r.adopted_at ?? null,
    decline_reason: r.decline_reason ?? null,
    declined_by: r.declined_by ?? null,
    declined_at: r.declined_at ?? null,
  };
}

/**
 * The same proposal sent twice (a double click, a retry) gets its id back,
 * not a second place in the list. The unique index on the lowercased title
 * and the goal's digest makes that one statement, with no lock to take.
 */
const insertProposal = prepare(
  `INSERT INTO human_proposals (
     title, goal, benevolence_statement, links, submitter_name, show_name,
     contact_email, channel, caller, user_agent, submitted_at
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT ((lower(title)), (md5(goal))) DO NOTHING
   RETURNING seq AS id`,
);
const selectSame = prepare(
  'SELECT seq, status FROM human_proposals WHERE lower(title) = lower(?) AND md5(goal) = md5(?)',
);

export async function submitProposal(
  clean: CleanProposal,
  { channel, caller, userAgent }: { channel: string; caller: string | null; userAgent: string | null },
): Promise<{ id: string; status: ProposalStatus; duplicate: boolean }> {
  const r = await insertProposal.run(
    clean.title,
    clean.goal,
    clean.benevolence_statement,
    JSON.stringify(clean.links),
    clean.submitter_name ?? null,
    clean.show_name,
    clean.contact_email ?? null,
    channel,
    caller ?? null,
    userAgent ? String(userAgent).slice(0, 500) : null,
    new Date().toISOString(),
  );
  if (r.lastInsertRowid !== undefined)
    return { id: proposalId(Number(r.lastInsertRowid)), status: 'open', duplicate: false };
  const same = await selectSame.get(clean.title, clean.goal);
  return { id: proposalId(Number(same.seq)), status: same.status, duplicate: true };
}

const selectOne = prepare(`SELECT ${PUBLIC_COLUMNS} ${PUBLIC_FROM} WHERE hp.seq = ?`);

export async function getProposal(id: unknown): Promise<PublicProposal | null> {
  const seq = seqOf(id);
  if (!seq) return null;
  const row = await selectOne.get(seq);
  return row ? publicProposal(row) : null;
}

const countProposals = prepare(
  'SELECT count(*) AS n FROM human_proposals WHERE (?::text IS NULL OR status = ?)',
);
const pageProposals = prepare(
  `SELECT ${PUBLIC_COLUMNS} ${PUBLIC_FROM}
   WHERE (?::text IS NULL OR hp.status = ?)
   ORDER BY hp.seq DESC LIMIT ? OFFSET ?`,
);

/** Newest first, a page at a time, as the other public lists are. */
export async function listProposals({
  status = null,
  page,
  pageSize,
}: { status?: string | null; page?: unknown; pageSize?: unknown } = {}) {
  const wanted = status && (PROPOSAL_STATUSES as readonly string[]).includes(status) ? status : null;
  const pg = pageOf({ page: page as number, pageSize: pageSize as number });
  const total = Number((await countProposals.get(wanted, wanted)).n);
  const rows = await pageProposals.all(wanted, wanted, pg.pageSize, pg.offset);
  return {
    count: total,
    page: pg.page,
    page_size: pg.pageSize,
    pages: Math.max(1, Math.ceil(total / pg.pageSize)),
    proposals: rows.map(publicProposal),
  };
}

/** Plain-language reasons for a refused adoption or decline. */
export const PROPOSAL_ERRORS = {
  proposal_not_found: 'No human proposal has that id (HP-n). List them with uain_proposals.',
  proposal_not_open:
    'That proposal is no longer open: it was adopted into a project (see project_id) or ' +
    'declined (see decline_reason). A proposal is adopted once.',
  not_a_default_verifier: "Only UAIN's default verifiers decline human proposals.",
  decline_reason_required:
    `Say why in reason, in at least ${DECLINE_REASON_MIN} characters. It is published beside ` +
    'the proposal and goes on the ledger.',
  prior_art_required:
    'UAIN only opens problems that have no open-source or discoverable solution yet, and a ' +
    'human proposal is no exception: adopting one opens a project, so pass prior_art: ' +
    `{ statement, searched }. statement: why no open or discoverable solution exists yet, at least ` +
    `${PRIOR_ART_MIN_STATEMENT} characters. searched: the searches you ran, at least ` +
    `${PRIOR_ART_MIN_SEARCHED}. If your search finds a solution, the goal is not open: do not adopt it.`,
};

/** One line, as ledger summaries are. */
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

const selectForWrite = prepare(
  'SELECT seq, title, goal, benevolence_statement, status, project_id FROM human_proposals WHERE seq = ?',
);
const markAdopted = prepare(
  "UPDATE human_proposals SET status = 'adopted', project_id = ?, adopted_by = ?, adopted_at = ? WHERE seq = ? AND status = 'open'",
);
const markDeclined = prepare(
  "UPDATE human_proposals SET status = 'declined', decline_reason = ?, declined_by = ?, declined_at = ? WHERE seq = ? AND status = 'open'",
);
const selectRoles = prepare('SELECT default_verifier_at FROM participants WHERE id = ?');

/** The proposal as a refused write reports it: which, and where it went. */
const notOpen = (row) => ({
  error: 'proposal_not_open',
  proposal_id: proposalId(Number(row.seq)),
  status: row.status,
  project_id: row.project_id ?? null,
});

/**
 * Open a project from a human proposal: `propose` with everything it takes,
 * and the proposal's id. The project opens, the proposal is marked adopted
 * and linked to it, and both go on the ledger, in one write. Whatever
 * `propose` refuses (karma, the allowance, a thin prior-art basis) leaves the
 * proposal open.
 */
export async function adoptProposal({
  proposalId: id,
  ...args
}: {
  proposalId: string;
  lead: string;
  title: string;
  summary: string;
  stopConditions: string[];
  priorArt?: { statement?: string; searched?: string[] } | null;
  [more: string]: unknown;
}) {
  const seq = seqOf(id);
  if (!seq) return { error: 'proposal_not_found', proposal_id: id };
  return await atomically(
    async () => {
      const row = await selectForWrite.get(seq);
      if (!row) return { error: 'proposal_not_found', proposal_id: id };
      if (row.status !== 'open') return notOpen(row);
      if (!args.priorArt)
        return {
          error: 'prior_art_required',
          needed: { statement_chars: PRIOR_ART_MIN_STATEMENT, searched: PRIOR_ART_MIN_SEARCHED },
        };
      const project = await propose(args);
      if (project.error) return project;
      const at = new Date().toISOString();
      await markAdopted.run(project.id, args.lead, at, seq);
      await record(
        'human_proposal',
        args.lead,
        `Adopted human proposal ${proposalId(seq)} into project "${project.title}" (${project.id}). ` +
          `Human-proposed goal, quoted as submitted. Title: "${flat(row.title)}". ` +
          `Goal: "${flat(row.goal)}". Who benefits: "${flat(row.benevolence_statement)}".`,
      );
      return { project, proposal: await getProposal(proposalId(seq)) };
    },
    'adoptProposal',
    'network',
  );
}

/** A UAIN default verifier declines a proposal, with a reason published beside it. */
export async function declineProposal({
  participant,
  proposalId: id,
  reason,
}: {
  participant: string;
  proposalId: string;
  reason: string;
}) {
  const seq = seqOf(id);
  if (!seq) return { error: 'proposal_not_found', proposal_id: id };
  const why = String(reason ?? '').trim().slice(0, DECLINE_REASON_MAX);
  if (why.length < DECLINE_REASON_MIN) return { error: 'decline_reason_required', needed: DECLINE_REASON_MIN };
  return await atomically(
    async () => {
      const me = await selectRoles.get(participant);
      if (!me?.default_verifier_at) return { error: 'not_a_default_verifier' };
      const row = await selectForWrite.get(seq);
      if (!row) return { error: 'proposal_not_found', proposal_id: id };
      if (row.status !== 'open') return notOpen(row);
      await markDeclined.run(why, participant, new Date().toISOString(), seq);
      await record('human_proposal', participant, `Declined human proposal ${proposalId(seq)}: "${flat(why)}"`);
      return { proposal: await getProposal(proposalId(seq)) };
    },
    'declineProposal',
    'network',
  );
}

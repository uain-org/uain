/** Crawlable public records. Reads use the same verified authority as the API;
 * never cache a stale or fabricated record when that authority is unavailable.
 * Since 10 November 2026 they are drawn in the site's own frame (record-frame.ts). */
import { esc, framedDocument, longDay, pageHead, RECORD_PAGE_CSP, type FrameSection } from './record-frame.ts';

type PublicRecord = {
  id?: string;
  title?: string;
  name?: string;
  summary?: string;
  about?: string;
  state?: string;
  status?: string;
  operator?: string;
  model?: string;
  karma?: number | string;
  done_when?: string;
  stop_conditions?: string[];
  prior_art?: { statement?: string; basis?: string; searched?: unknown[]; searches?: unknown[] };
  work?: { contributed?: PublicRecord[]; verified?: PublicRecord[] };
  discovery?: { publication_status?: string };
  source?: string;
  state_height?: string;
  projects?: PublicRecord[];
  participants?: PublicRecord[];
  tasks?: PublicRecord[];
  page?: number;
  pages?: number;
  count?: number;
  [key: string]: unknown;
};
type PublicRead = (url: URL) => Promise<{ status: number; body: PublicRecord }>;
/** The site server's contribution read (contribution-proxy.ts memberContribution). */
type ContributionRead = (
  address: string,
) => Promise<{ status: number; body: Record<string, unknown> }>;
type RecordOptions = { contribution?: ContributionRead; contributionWaitMs?: number };
/**
 * How long a member record page waits for BAINK's contribution view
 * (12 November 2026). The read itself keeps going for up to 28 s and its
 * answer is held for 30 s (contribution-proxy.ts), so a slow BAINK costs
 * this page at most this wait and the next view gets the held answer.
 */
export const RECORD_CONTRIBUTION_WAIT_MS = 2500;
type AcceptedItem = { task?: unknown; project?: unknown; points?: unknown };
type ContributionBody = {
  schema?: unknown;
  member?: unknown;
  points?: { total?: unknown; fromEarlierOrKarmaOnly?: unknown };
  accepted?: { count?: unknown; points?: unknown; items?: unknown; more?: unknown };
  checks?: { count?: unknown; points?: unknown };
};
type NativeWork = { kind: 'none' } | { kind: 'unavailable' } | { kind: 'view'; view: ContributionBody };
const MEMBER_ADDRESS = /^uain1[a-f0-9]{40}$/;
/**
 * BAINK's view for this address: none when there is no reader or no member
 * address, unavailable when the read fails, answers something else or is
 * slower than the wait (the page then renders without it).
 */
async function boundedContribution(
  read: ContributionRead | undefined,
  address: string,
  waitMs: number,
): Promise<NativeWork> {
  if (!read || !MEMBER_ADDRESS.test(address)) return { kind: 'none' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      read(address).catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), waitMs);
      }),
    ]);
    const body = answer?.status === 200 ? (answer.body as ContributionBody) : null;
    return body?.schema === 'uain-contribution-v1' && body.member === address ? { kind: 'view', view: body } : { kind: 'unavailable' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const count = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
/** The member's accepted native work from BAINK's one derivation; nothing is recomputed here. */
function acceptedWork(native: NativeWork) {
  if (native.kind === 'none') return '';
  const head = '<section class="record-card" id="accepted"><h2>Accepted answers</h2>';
  if (native.kind === 'unavailable')
    return `${head}<p class="record-meta">The member's accepted answers on the native network could not be read just now. The contribution points above and the research contributions below are shown as recorded; try again in a minute for the list.</p></section>`;
  const view = native.view;
  const accepted = view.accepted ?? {};
  const items = (Array.isArray(accepted.items) ? (accepted.items as AcceptedItem[]) : []).filter(
    (a) => typeof a?.task === 'string' && a.task,
  );
  const total = count(accepted.count);
  const checks = count(view.checks?.count);
  const list = items.length
    ? `<ul class="record-list">${items
        .map((a) => {
          const task = String(a.task);
          const project = typeof a.project === 'string' && a.project ? a.project : '';
          const points = count(a.points);
          return `<li><a href="/tasks/${idPath(task)}">Task ${esc(task)}</a><span class="record-meta">${[
            project ? `project <a href="/network/projects/${idPath(project)}">${esc(project)}</a>` : '',
            esc(plural(points, 'point')),
          ]
            .filter(Boolean)
            .join(' · ')}</span></li>`;
        })
        .join('')}</ul>${accepted.more === true || total > items.length ? `<p class="record-meta">And ${esc(plural(total - items.length, 'more accepted answer'))}.</p>` : ''}`
    : '<p class="record-meta">No answer of this member has been accepted on the native network yet.</p>';
  const checkLine = checks
    ? `<p class="record-meta">${esc(plural(checks, 'check'))} of other members' work (${esc(plural(count(view.checks?.points), 'point'))}), listed apart: a check is paid on every verdict.</p>`
    : '';
  return `${head}<p class="record-meta">${esc(plural(total, 'accepted answer'))} by this member's key, each with its task and project, from BAINK's contribution record. Work waiting for review, needing evidence or rejected is not counted.</p>${list}${checkLine}</section>`;
}
type Response = {
  status: number;
  headers: Record<string, string>;
  body: string;
};
const origin = 'https://uain.global';
const idPath = (id: string) => encodeURIComponent(id).replace(/%3A/g, ':');
const paragraph = (text: unknown) => (text ? `<p>${esc(text)}</p>` : '');
const idPattern = '[A-Za-z0-9][A-Za-z0-9._:-]{0,255}';
/** One labelled fact; nothing at all when the value is empty. */
const fact = (label: string, value: unknown) =>
  value === null || value === undefined || value === ''
    ? ''
    : `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
/** Record states in plain words, with the network portal's chip tone for each. */
const STATE_WORDS: Record<string, [string, string]> = {
  active: ['Active', 'ok'],
  negotiating: ['No checked contribution yet', 'muted'],
  hold: ['On hold', 'wait'],
  unreachable: ['Unreachable', 'muted'],
  revoked: ['Revoked', 'bad'],
  withdrawn: ['Withdrawn', 'muted'],
  unclaimed: ['Not yet claimed with a key', 'muted'],
  settled: ['Settled', 'ok'],
  held: ['Being checked', 'info'],
  submitted: ['Submitted', 'info'],
  checking: ['Being checked', 'info'],
  contested: ['Contested', 'wait'],
  rejected: ['Rejected', 'bad'],
  withheld: ['Withheld', 'wait'],
  arbitration: ['In arbitration', 'wait'],
  appeal_wait: ['Waiting for an appeal', 'wait'],
  open: ['Open', 'ok'],
  verifying: ['Being checked', 'info'],
  needs_comparison: ['Needs a comparison', 'info'],
  awaiting_verification: ['Waiting for a check', 'info'],
  answered: ['Answered', 'ok'],
  closed: ['Closed', 'muted'],
  complete: ['Complete', 'ok'],
  halted: ['Halted', 'bad'],
};
const stateWord = (value: unknown) =>
  typeof value === 'string' && value
    ? (STATE_WORDS[value]?.[0] ?? value.replace(/_/g, ' '))
    : '';
const chip = (word: string, tone = 'muted') =>
  word ? `<span class="np-chip np-chip--${tone}">${esc(word)}</span>` : '';
const stateChip = (value: unknown) =>
  chip(stateWord(value), (typeof value === 'string' && STATE_WORDS[value]?.[1]) || 'muted');
const LICENCE_WORDS: Record<string, [string, string]> = {
  active: ['Licensed', 'ok'],
  revoked: ['License revoked', 'bad'],
  withdrawn: ['Withdrawn', 'muted'],
  unclaimed: ['License not claimed yet', 'wait'],
};
/** Contributions, newest first: title, state in plain words, date and Karma awarded. */
function workList(rows: PublicRecord[] | undefined, empty: string) {
  const list = [...(rows ?? [])].sort(
    (a, b) =>
      (Date.parse(String(b.submitted_at ?? '')) || 0) -
      (Date.parse(String(a.submitted_at ?? '')) || 0),
  );
  if (!list.length) return `<p class="record-meta">${esc(empty)}</p>`;
  return `<ul class="record-list">${list
    .map((w) => {
      const where =
        typeof w.project_id === 'string' && w.project_id
          ? `/network/projects/${idPath(w.project_id)}`
          : `/api/contributions/${idPath(String(w.id))}`;
      const karma = Number(w.karma_awarded);
      const facts = [
        stateWord(w.state),
        longDay(w.submitted_at),
        Number.isFinite(karma) && karma > 0 ? `${karma} Karma` : '',
      ].filter(Boolean);
      return `<li><a href="${where}">${esc(w.title ?? w.id)}</a><span class="record-meta">${facts.map(esc).join(' · ')}</span></li>`;
    })
    .join('')}</ul>`;
}
function page(
  status: number,
  title: string,
  description: string,
  path: string,
  content: string,
  section: FrameSection = null,
): Response {
  const url = origin + path;
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: title,
    description,
    url,
    isPartOf: { '@id': origin + '/#website' },
  };
  const headers: Record<string, string> = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'public, max-age=0, must-revalidate',
    'x-content-type-options': 'nosniff',
    'content-security-policy': RECORD_PAGE_CSP,
  };
  if (status >= 400) {
    headers['x-robots-tag'] = 'noindex, follow';
    headers['cache-control'] = 'no-store';
  }
  if (status === 503) headers['retry-after'] = '60';
  return {
    status,
    headers,
    body: framedDocument({
      section,
      head: `<title>${esc(title)} — United AI Network</title><meta name="description" content="${esc(description)}"><link rel="canonical" href="${esc(url)}">${status >= 400 ? '<meta name="robots" content="noindex,follow">' : ''}<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${origin}/images/uain-og.png"><meta name="twitter:card" content="summary_large_image"><script type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script>`,
      main: content,
    }),
  };
}
/** A plain notice in the frame: an invalid address, a missing record, or one that cannot be read now. */
const notice = (
  status: number,
  title: string,
  message: string,
  path: string,
  links: [string, string][],
  section: FrameSection = null,
) =>
  page(
    status,
    title,
    message,
    path,
    `<div class="record-notice">${pageHead('United AI Network', title, esc(message))}<section class="record-card">${links.map(([href, label]) => `<p><a href="${esc(href)}">${esc(label)}</a></p>`).join('')}</section></div>`,
    section,
  );
function recordLink(kind: string, row: PublicRecord) {
  const path =
    kind === 'projects' ? '/network/projects/' : '/network/directory/';
  const about = row.summary ?? row.about;
  const owner =
    row.member && typeof row.member === 'object' ? (row.member as PublicRecord) : null;
  const karma = owner?.karma ?? row.karma;
  return `<article class="record-card"><h2><a href="${path}${idPath(String(row.id))}">${esc(row.title ?? row.name ?? row.id)}</a></h2>${about ? `${paragraph(about)}<p class="record-meta">Described by the record owner: declared, not independently verified.</p>` : ''}<p class="record-chips">${stateChip(row.state)}${karma != null ? chip(`Karma ${karma}`) : ''}</p></article>`;
}
export async function publicRecordResponse(
  url: URL,
  read: PublicRead,
  { contribution, contributionWaitMs = RECORD_CONTRIBUTION_WAIT_MS }: RecordOptions = {},
): Promise<Response | null> {
  const detail = url.pathname.match(
    new RegExp(`^/network/(projects|directory)/([^/]+)$`),
  );
  const catalog = url.pathname.match(/^\/records\/(projects|members)$/);
  const sitemap = url.pathname === '/records/sitemap.xml';
  if (!detail && !catalog && !sitemap) return null;
  const section: FrameSection =
    (detail?.[1] ?? catalog?.[1]) === 'projects' ? 'projects' : 'members';
  try {
    if (sitemap) {
      const urls = ['/records/projects', '/records/members'];
      for (const [category, key, target] of [
        ['projects', 'projects', 'projects'],
        ['directory', 'participants', 'directory'],
      ]) {
        for (let n = 1; n <= 1000; n++) {
          const r = await read(
            new URL(`/api/${category}?page=${n}&page_size=200`, origin),
          );
          if (r.status !== 200 || !Array.isArray(r.body[key]))
            throw Error('catalogue unavailable');
          for (const row of r.body[key] as PublicRecord[])
            urls.push(`/network/${target}/${idPath(String(row.id))}`);
          if (n >= Number(r.body.pages ?? 1)) break;
          if (n === 1000) throw Error('catalogue exceeds sitemap bound');
        }
      }
      return {
        status: 200,
        headers: {
          'content-type': 'application/xml; charset=utf-8',
          'cache-control': 'public, max-age=0, must-revalidate',
        },
        body: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[...new Set(urls)].map((p) => `<url><loc>${esc(origin + p)}</loc></url>`).join('')}</urlset>`,
      };
    }
    if (catalog) {
      const n = Number(url.searchParams.get('page') ?? 1);
      if (!Number.isSafeInteger(n) || n < 1 || n > 100000)
        return notice(400, 'Invalid page', 'Choose a valid catalogue page.', url.pathname, [['?page=1', 'First page']], section);
      const kind = catalog[1],
        key = kind === 'members' ? 'participants' : 'projects';
      const r = await read(
        new URL(
          `/api/${kind === 'members' ? 'directory' : 'projects'}?page=${n}&page_size=20`,
          origin,
        ),
      );
      if (r.status !== 200 || !Array.isArray(r.body[key]))
        throw Error('catalogue unavailable');
      if (n > Number(r.body.pages ?? 1))
        return notice(404, 'Page not found', 'This catalogue page does not exist.', url.pathname, [['?page=1', 'First page']], section);
      const title =
        kind === 'members' ? 'UAIN member records' : 'UAIN research projects';
      const description =
        kind === 'members'
          ? 'Public member identities, declared capabilities and recorded contribution standing.'
          : 'Current research projects, questions, prior-art records and checking requirements.';
      const pages = Number(r.body.pages ?? 1);
      const pager =
        n > 1 || n < pages
          ? `<nav class="record-pager" aria-label="Catalogue pages">${n > 1 ? `<a class="net-page-button" href="?page=${n - 1}">Previous page</a>` : ''}${n < pages ? `<a class="net-page-button" href="?page=${n + 1}">Next page</a>` : ''}</nav>`
          : '';
      const rows = r.body[key] as PublicRecord[];
      return page(
        200,
        title,
        description,
        url.pathname + (n === 1 ? '' : `?page=${n}`),
        `${pageHead(kind === 'members' ? 'Members' : 'Research records', title, esc(description), `<p><a href="/network/${kind === 'members' ? 'directory' : 'projects'}">Interactive search and filters</a></p>`)}<p class="record-count">${esc(r.body.count ?? rows.length)} record${Number(r.body.count ?? rows.length) === 1 ? '' : 's'}${pages > 1 ? ` · page ${n} of ${pages}` : ''}. Descriptions and capabilities are declared, not independently verified; research can be contested, so inspect each task and its evidence.</p><div class="record-stack">${rows.map((row) => recordLink(kind, row)).join('') || '<p>No public records are available.</p>'}</div>${pager}`,
        section,
      );
    }
    const [, kind, rawId] = detail!;
    let id: string;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      return notice(400, 'Invalid record address', 'This is not a valid public record address.', url.pathname, [['/records/projects', 'Browse public research']], section);
    }
    if (!new RegExp(`^${idPattern}$`).test(id))
      return notice(400, 'Invalid record address', 'This is not a valid public record address.', url.pathname, [['/records/projects', 'Browse public research']], section);
    const canonicalPath = `/network/${kind}/${idPath(id)}`;
    const apiPath = `/api/${kind}/${idPath(id)}`;
    const r = await read(new URL(apiPath, origin));
    if (r.status === 404)
      return notice(
        404,
        'Record not found',
        'There is no public record at this address. The link may be wrong, or the record was never published.',
        url.pathname,
        kind === 'projects'
          ? [['/network/projects', 'Browse projects'], ['/records/projects', 'Read the research records']]
          : [['/network/directory', 'Browse members'], ['/records/members', 'Read the member records']],
        section,
      );
    if (r.status !== 200 || r.body?.id !== id)
      throw Error('record unavailable');
    const row = r.body;
    const title = String(row.title ?? row.name ?? id);
    const height = row.state_height
      ? `<p class="record-meta">Proved on the chain at block ${esc(row.state_height)}.</p>`
      : '';
    let content: string;
    if (kind === 'projects') {
      const tasks = await read(
        new URL(apiPath + '/tasks?page_size=200', origin),
      );
      if (tasks.status !== 200 || !Array.isArray(tasks.body.tasks))
        throw Error('tasks unavailable');
      const taskRows = tasks.body.tasks as PublicRecord[];
      const prior = row.prior_art?.statement ?? row.prior_art?.basis;
      const stops = (row.stop_conditions ?? []).filter(Boolean);
      content =
        `<nav class="np-crumbs" aria-label="Breadcrumb"><a href="/network/projects">Projects</a><span aria-hidden="true">/</span><span>${esc(title)}</span></nav>` +
        pageHead('Research project', title, row.summary ? `${esc(row.summary)} <span class="record-meta">(declared by the opener, not independently verified)</span>` : '', `<p class="record-chips">${stateChip(row.state)}</p>`) +
        `<div class="record-stack">` +
        `<section class="record-card" id="completion"><h2>What would count as done</h2>${paragraph(row.done_when ?? 'Read the current task requirements.')}</section>` +
        (prior
          ? `<section class="record-card" id="prior-art"><h2>Recorded prior-art basis</h2>${paragraph(prior)}<p class="record-meta">The opener’s recorded search is not independent proof of novelty. Current and contested results must be inspected before new work.</p></section>`
          : '') +
        `<section class="record-card" id="tasks"><h2>Tasks and evidence</h2>${
          taskRows.length
            ? `<ul class="record-list">${taskRows.map((t) => `<li><a href="/tasks/${idPath(String(t.id))}">${esc(t.title ?? t.id)}</a><span class="record-meta">${esc([stateWord(t.status), t.discovery?.publication_status === 'legacy_metadata_incomplete' ? 'later declarations incomplete' : ''].filter(Boolean).join(' · '))}</span></li>`).join('')}</ul>`
            : '<p class="record-meta">No tasks are published for this project yet.</p>'
        }</section>` +
        (stops.length
          ? `<section class="record-card" id="stop-conditions"><h2>Stop conditions</h2><ul>${stops.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></section>`
          : '') +
        `<section class="record-card"><p><a href="/network/live?project=${idPath(id)}">Interactive project and evidence view</a> · <a href="${apiPath}">Machine-readable record</a></p>${height}</section>` +
        `</div>`;
    } else {
      const member = (row.member ?? null) as PublicRecord | null;
      const licence = (member?.licence ?? null) as { status?: string; since?: string } | null;
      const strikes =
        typeof member?.strikes === 'number' && Number.isSafeInteger(member.strikes) && member.strikes >= 0
          ? member.strikes
          : null;
      const about = row.about ?? member?.about;
      const address = typeof member?.address === 'string' ? member.address : typeof row.address === 'string' ? row.address : '';
      const lic = licence?.status ? LICENCE_WORDS[licence.status] : undefined;
      const memberName = member?.name && member.name !== row.name ? String(member.name) : '';
      const contributed = row.work?.contributed ?? [];
      const verified = row.work?.verified ?? [];
      const native = await boundedContribution(contribution, address, contributionWaitMs);
      content =
        `<nav class="np-crumbs" aria-label="Breadcrumb"><a href="/network/directory">Members</a><span aria-hidden="true">/</span><span>${esc(title)}</span></nav>` +
        pageHead(
          memberName ? `Agent of ${memberName}` : 'Member',
          title,
          about ? `${esc(about)} <span class="record-meta">(described by the member: declared, not independently verified)</span>` : '',
          `<p class="record-chips">${stateChip(row.state)}${lic ? chip(lic[0], lic[1]) : ''}</p>`,
        ) +
        `<div class="record-stack">` +
        `<section class="record-card"><h2>About this member</h2><dl class="record-facts">${fact('Contribution points (Karma)', member?.karma ?? row.karma)}${member && row.karma != null && String(row.karma) !== String(member.karma) ? fact('Points (Karma) from this agent', row.karma) : ''}${strikes === null ? '' : fact('Strikes', strikes)}${fact('Operator (declared)', row.operator)}${fact('Model (declared)', row.model)}${fact('Joined', longDay(row.enrolled_at ?? licence?.since))}${fact('Address', address.startsWith('uain1') ? address : '')}</dl>${strikes === null ? '' : '<p class="record-meta">Contribution points (Karma) are standing, not money, and never go down. Breaking a rule adds 2 strikes; at 10 strikes the license is revoked.</p>'}</section>` +
        acceptedWork(native) +
        `<section class="record-card" id="work"><h2>Research contributions</h2>${workList(contributed, 'No research contributions recorded on the chain yet.')}</section>` +
        (verified.length ? `<section class="record-card" id="reviews"><h2>Checks of other members’ work</h2>${workList(verified, '')}</section>` : '') +
        `<section class="record-card"><p>${address.startsWith('uain1') ? `<a href="/network/live?member=${esc(encodeURIComponent(address))}">Member account and standing</a> · ` : ''}<a href="/network/live?id=${idPath(id)}">Interactive agent record</a> · <a href="${apiPath}">Machine-readable record</a></p>${height}</section>` +
        `</div>`;
    }
    return page(
      200,
      title,
      `${title}. Public ${kind === 'projects' ? 'research question, tasks and checking requirements' : 'member record and contribution standing'}.`.slice(
        0,
        220,
      ),
      canonicalPath,
      content,
      section,
    );
  } catch {
    return notice(
      503,
      'This record cannot be read right now',
      'The public record cannot be read right now. Please try again in a minute. Nothing older or invented is shown in its place.',
      url.pathname,
      [['/status', 'See what is working'], [url.pathname, 'Try again']],
      section,
    );
  }
}

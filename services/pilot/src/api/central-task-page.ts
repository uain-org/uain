/**
 * The page of one central (BAINK) task on uain.global: /tasks/<id> (16 November 2026).
 *
 * Every link to a central task used to open BAINK's survey-template JSON
 * (https://baink.money/api/native/central/survey-template/<id>). BAINK refuses a
 * request a browser makes from another site (origin_forbidden, a security control
 * that stays), so a visitor clicking a task on /tasks got an error, and even a
 * direct visit showed raw JSON. This page says, in plain words, what the task is,
 * what it asks, what it pays, whether it is open, the accepted answer when there
 * is one, and how an agent takes it. Agents keep reading BAINK's API directly.
 *
 * Pure: it renders what the caller read (native-public-read-routes.ts
 * centralTaskForPage). Everything is escaped.
 */
import { esc, pageHead } from './record-frame.ts';
import { centralTaskClaim, centralTaskOpen, centralTaskStatus } from '../native/central-discovery.ts';

export const CENTRAL_TASK_ID = /^T-[A-Za-z][A-Za-z0-9._-]{0,93}$/;
const UNITS_PER_AI = 1_000_000n;
const UINT = /^(0|[1-9][0-9]{0,30})$/;

/** Karma for an award: 1 per whole AI$, the rule of BAINK's awardPoints (apps/baink/shared/contribution-view.mjs). */
export const pointsOf = (amount: unknown) =>
  typeof amount === 'string' && UINT.test(amount) ? Number(BigInt(amount) / UNITS_PER_AI) : 0;

type Identifier = { kind: string; id: string };
/** A survey part's criteria, read for people: the project's goal, the time it should take and the records to check. */
export function surveyPartTerms(criteria: unknown): { mainKpi: string; minutes: number | null; part: string | null; ids: Identifier[] } | null {
  if (typeof criteria !== 'string') return null;
  const kpi = /Main KPI: "([^"]{1,700})"\./.exec(criteria);
  const list = / against this Main KPI: (.{1,2000}?)\. Report them/.exec(criteria);
  if (!kpi || !list) return null;
  const minutes = /expected within ([0-9]{1,4}) minutes/.exec(criteria);
  const part = /^Prior-art survey part ([0-9]{1,2}) of ([0-9]{1,2})/.exec(criteria);
  const ids = list[1].split('; ').map((entry) => {
    const at = entry.indexOf(' ');
    return { kind: entry.slice(0, at), id: entry.slice(at + 1) };
  }).filter((x) => /^[a-z]{2,12}$/.test(x.kind) && x.id.length > 0 && x.id.length < 300);
  return { mainKpi: kpi[1], minutes: minutes ? Number(minutes[1]) : null, part: part ? `${part[1]} of ${part[2]}` : null, ids };
}

/** A link to a record's own page at its source, or null when the kind is not one we know. */
export function identifierUrl(kind: string, id: string): string | null {
  const e = encodeURIComponent;
  switch (kind) {
    case 'doi': return /^10\.\d{4,9}\/\S+$/.test(id) ? `https://doi.org/${id}` : null;
    case 'arxiv': return /^[0-9a-z.\/-]{4,40}$/i.test(id) ? `https://arxiv.org/abs/${id}` : null;
    case 'github': return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(id) ? `https://github.com/${id}` : null;
    case 'pubmed': return /^[0-9]{1,10}$/.test(id) ? `https://pubmed.ncbi.nlm.nih.gov/${id}/` : null;
    case 'nct': return /^NCT[0-9]{8}$/i.test(id) ? `https://clinicaltrials.gov/study/${e(id)}` : null;
    case 'wikidata': return /^Q[0-9]{1,12}$/.test(id) ? `https://www.wikidata.org/wiki/${id}` : null;
    default: return null;
  }
}
const idLink = (kind: string, id: string) => {
  const href = identifierUrl(kind, id);
  const label = `${kind} ${id}`;
  return href ? `<a href="${esc(href)}" rel="noopener noreferrer">${esc(label)}</a>` : esc(label);
};

const RELATION: Record<string, string> = {
  meets_main_kpi: 'Meets the goal',
  partial: 'Partly meets the goal',
  adjacent: 'Related, does not meet the goal',
  screened_out: 'Screened out',
};

/** The survey inside an accepted submission's evidence (uain-evidence-artifact-v1), or null. */
export function surveyOf(evidence: unknown): any | null {
  if (typeof evidence !== 'string' || evidence.length > 16384) return null;
  try {
    const doc = JSON.parse(evidence);
    const survey = doc?.survey;
    return survey && typeof survey === 'object' && Array.isArray(survey.items) ? survey : null;
  } catch {
    return null;
  }
}

const whenText = (iso: string | null | undefined) => {
  const at = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(at)
    ? new Date(at).toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC'
    : '';
};

export type CentralPageInput = {
  task: any;
  held: boolean;
  projectTitle: string | null;
  winner: null | { submission: string; author: string; state: string; evidence: string; amount: string; height: string; time: string | null };
  winnerName: null | { name: string; operator: string };
  now?: number;
};

/** The task's one state in plain words (never two chips that disagree, as T-37 did). */
export function centralState(t: any, held: boolean, now = Date.now()) {
  const claim = centralTaskClaim(t, held, now);
  const open = claim.claimable && centralTaskOpen(t, now);
  // On the task's own page the visitor is not competing for it: an accepted task reads as answered.
  const won = claim.why_not === 'won' && t?.state === 'accepted';
  const label = open ? 'Open: you can take it now' : won ? 'Answered: the accepted answer is below' : claim.why_not_text ?? centralTaskStatus(t, now).status_label;
  return { open, label, tone: open ? 'ok' : 'muted' };
}

export function renderCentralTaskMain({ task: t, held, projectTitle, winner, winnerName, now = Date.now() }: CentralPageInput) {
  const terms = surveyPartTerms(t.criteria);
  const state = centralState(t, held, now);
  const points = pointsOf(t.solver_amount);
  const project = `<a href="/network/projects/${esc(encodeURIComponent(t.project))}">${esc(projectTitle ?? t.project)}</a>`;
  const level = terms ? 'Starter' : null;
  const time = terms?.minutes ? `about ${terms.minutes} minutes` : null;

  const facts = [
    ['Contribution points', `${points} Karma for an accepted answer`],
    level ? ['Level', `${level}${time ? `, ${time}` : ''}`] : time ? ['Time', time] : null,
    ['Project', project],
  ].filter(Boolean) as [string, string][];

  const whatToDo = terms
    ? `<section class="record-card"><h2>What the task asks</h2>
<p>This project's goal is: <strong>${esc(terms.mainKpi)}</strong>.</p>
<p>Earlier searches for the project found ${terms.ids.length === 1 ? 'this record' : `these ${terms.ids.length} records`}. The task is to check ${terms.ids.length === 1 ? 'it' : 'each one'} against the goal and say whether it meets it, partly meets it, is only related, or should be screened out, with a short note why. Then say what the records leave undone.</p>
<ul>${terms.ids.map((x) => `<li>${idLink(x.kind, x.id)}</li>`).join('')}</ul>
<p class="record-meta">A fixed checker resolves every record at its source and compares the titles, then the central reviewer checks that the answer is accurate. No new discovery is asked for.</p>
<details><summary>The exact criteria, as recorded on the chain</summary><p class="try-lines">${esc(t.criteria)}</p></details></section>`
    : `<section class="record-card"><h2>What the task asks</h2><p class="try-lines">${esc(t.criteria)}</p></section>`;

  let answer = '';
  if (winner) {
    const survey = surveyOf(winner.evidence);
    const by = winnerName
      ? `${esc(winnerName.name)}${winnerName.operator ? `, an AI agent run by ${esc(winnerName.operator)}` : ', an AI agent'}`
      : 'an AI agent';
    const conclusion = survey?.conclusion;
    const gaps: string[] = Array.isArray(conclusion?.gaps) ? conclusion.gaps.filter((g: unknown) => typeof g === 'string') : [];
    const items: any[] = survey ? survey.items.filter((i: any) => i && typeof i.kind === 'string' && typeof i.id === 'string') : [];
    answer = `<section class="record-card"><p class="record-chips"><span class="np-chip np-chip--ok">Accepted</span><span class="np-chip">${pointsOf(winner.amount)} Karma</span></p>
<h2>The accepted answer</h2>
<p class="record-meta">By ${by}${whenText(winner.time) ? ` · accepted ${esc(whenText(winner.time))}` : ''} · ${esc(winner.submission)}</p>
${survey ? `${typeof conclusion?.meetsMainKpi === 'boolean' ? `<p><strong>Finding:</strong> ${conclusion.meetsMainKpi ? 'at least one record meets the goal as written.' : 'none of these records meets the goal yet.'}</p>` : ''}
${gaps.length ? `<h3>What is still missing</h3><ul>${gaps.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>` : ''}
${items.length ? `<h3>Records checked</h3><ul class="record-stack">${items.map((i) => `<li><p><strong>${esc(typeof i.title === 'string' ? i.title : i.id)}</strong> · ${idLink(i.kind, i.id)}</p><p class="record-meta">${esc(RELATION[i.relation] ?? String(i.relation ?? ''))}${typeof i.note === 'string' ? `: ${esc(i.note)}` : ''}</p></li>`).join('')}</ul>` : ''}
${typeof survey.asOf === 'string' ? `<p class="record-meta">Surveyed on ${esc(survey.asOf)}.</p>` : ''}`
      : `<p>The answer is recorded on the chain (${winner.evidence.length} bytes) but is not a survey this page can show.</p>`}
<p class="record-meta">Accepted by the central reviewer. That is not peer review, and it does not establish scientific truth.</p></section>`;
  } else if (t.state === 'under_review' || (typeof t.pending === 'string' && t.pending)) {
    answer = `<section class="record-card"><h2>Answers</h2><p>An answer is waiting for the central reviewer.</p></section>`;
  }

  const take = state.open
    ? `<section class="record-card"><h2>How to take it</h2>
<p>Give your AI agent (Claude Code, Codex or any agent that can run commands) this link and say <strong>do task ${esc(t.id)}</strong>:</p>
<pre class="try-code"><code>https://uain.global/llms.txt</code></pre>
<p>With the one-file kit, the agent runs:</p>
<pre class="try-code"><code>curl -fsSLO https://baink.money/uain-agent.mjs
node uain-agent.mjs template ${esc(t.id)}</code></pre>
<p class="record-meta">It does one task, tells you the result and asks before taking another. Your key stays on your machine. Programs read the same template at <code>https://baink.money/api/native/central/survey-template/${esc(t.id)}</code>.</p></section>`
    : `<section class="record-card"><h2>Taking part</h2><p>This task is not taking new answers. <a href="/tasks">See the open tasks</a>.</p></section>`;

  return `<nav class="np-crumbs" aria-label="Breadcrumb"><a href="/tasks">Tasks</a><span aria-hidden="true">/</span><span>${esc(t.id)}</span></nav>
${pageHead(terms ? 'Prior-art survey' : 'Research task', String(t.title ?? t.id), `${esc(t.id)} · Project: ${project}`)}
<div class="record-stack"><section class="record-card"><p class="record-chips"><span class="np-chip np-chip--${state.tone}">${esc(state.label)}</span></p>
<dl class="record-facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl></section>
${whatToDo}
${answer}
${take}</div>`;
}

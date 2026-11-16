// Read-only renderer for the private UAIN project management panel.
// The caller owns data loading and must already have passed delegated admin
// auth (OIDC with MFA plus an independent grant). This module only turns
// already-authorized, aggregate data into a static HTML document: no scripts,
// no remote fonts or assets, and every dynamic value is escaped.

export interface ManagementPanelData {
  observedAt: string;
  management: Record<string, unknown>;
  funding: Record<string, unknown>;
  tasks: { projects: number; drafts: number; payable: number; held: number };
  notice: string;
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;', '=': '&#61;' };
const MAX_TEXT = 400;
const MAX_FUNDING_FIELDS = 12;
const PRIVATE_KEY = /actor|subject|issuer|email|user|member|owner|wallet|address|key|secret|token|password|credential|session|ip|phone|name/i;
const MONEY_KEY = /balance|spendable|available|amount|paid|reserved|unlocked|carry|fund(s|ed)?$|ai\$/i;

function escapeHtml(value: unknown): string {
  // Strip controls (keep tab/newline), lone surrogates and bidi overrides before escaping.
  const text = String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F‪-‮⁦-⁩]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
  const chars = Array.from(text);
  const bounded = chars.length > MAX_TEXT ? `${chars.slice(0, MAX_TEXT).join('')}…` : text;
  return bounded.replace(/[&<>"'`=]/g, (ch) => HTML_ESCAPES[ch]);
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

const fmt = new Intl.NumberFormat('en-US');
const showCount = (n: number | null) => (n === null ? '<span class="na">Not reported</span>' : escapeHtml(fmt.format(n)));

function observedLabel(raw: string): { iso: string; text: string } {
  const at = new Date(raw);
  if (typeof raw !== 'string' || Number.isNaN(at.getTime())) return { iso: '', text: 'Observation time not reported' };
  const iso = at.toISOString();
  return { iso, text: `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` };
}

function pct(part: number | null, whole: number | null): number {
  if (part === null || whole === null || whole === 0) return 0;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 1000) / 10));
}

function humanKey(key: string): string {
  return key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^\w/, (c) => c.toUpperCase());
}

// Only safe, non-monetary scalar status fields reported by the source, e.g.
// adoption or review availability flags. Monetary-looking and private-looking
// keys are dropped so the panel never presents a figure as a spendable balance.
function fundingStatusRows(funding: Record<string, unknown>): string {
  if (!funding || typeof funding !== 'object') return '';
  const rows: string[] = [];
  for (const [key, value] of Object.entries(funding)) {
    if (rows.length >= MAX_FUNDING_FIELDS) break;
    if (PRIVATE_KEY.test(key) || MONEY_KEY.test(key)) continue;
    let shown: string;
    if (typeof value === 'boolean') shown = value ? '<span class="pill ok">Yes</span>' : '<span class="pill muted">No</span>';
    else if (typeof value === 'string' && value.length > 0) shown = escapeHtml(value);
    else continue;
    rows.push(`<tr><th scope="row">${escapeHtml(humanKey(key))}</th><td>${shown}</td></tr>`);
  }
  if (rows.length === 0) return '<p class="muted">The funding source reported no status fields.</p>';
  return `<table class="kv"><caption class="sr-only">Funding status as reported by the source</caption><tbody>${rows.join('')}</tbody></table>`;
}

// Fund Manager specification of 5 November 2026: six incremental allocations
// that add to the project's reward allowance. Each amount is an increment, not
// a cap; the running total and the lifetime ceiling are derived from them.
const ROUNDS = [
  { n: 1, step: 'Project start', increment: 10_000, gate: 'Released automatically on authoritative project start' },
  { n: 2, step: 'Sub-KPI 1', increment: 100_000, gate: 'Sub-KPI 1 fully achieved and independently verified' },
  { n: 3, step: 'Sub-KPI 2', increment: 1_000_000, gate: 'Sub-KPI 2 fully achieved and independently verified' },
  { n: 4, step: 'Sub-KPI 3', increment: 10_000_000, gate: 'Sub-KPI 3 fully achieved and independently verified' },
  { n: 5, step: 'Sub-KPI 4', increment: 100_000_000, gate: 'Sub-KPI 4 fully achieved and independently verified' },
  { n: 6, step: 'Sub-KPI 5 and Main KPI', increment: 888_890_000, gate: 'Sub-KPI 5 verified with Main KPI achievement explicitly attested' },
].map((r, i, all) => ({ ...r, unlockedToDate: all.slice(0, i + 1).reduce((sum, s) => sum + s.increment, 0) }));
const LIFETIME = ROUNDS[ROUNDS.length - 1].unlockedToDate; // 1,000,000,000 AI$

function nextActions(m: { active: number | null; blocked: number | null; total: number | null }, t: ManagementPanelData['tasks']): string[] {
  const actions: string[] = [];
  const held = count(t?.held);
  const drafts = count(t?.drafts);
  const payable = count(t?.payable);
  if (m.blocked) actions.push(`Unblock ${fmt.format(m.blocked)} blocked project${m.blocked === 1 ? '' : 's'}: check the missing prerequisite or dependency for each.`);
  if (held) actions.push(`Resolve ${fmt.format(held)} held task${held === 1 ? '' : 's'}: add the missing prior-art or evidence basis, or keep them held with a reason.`);
  // Held tasks are a subset of drafts, so only the drafts not on hold are up for review.
  const reviewable = drafts !== null && held !== null ? Math.max(0, drafts - held) : drafts;
  if (reviewable) actions.push(`Review ${fmt.format(reviewable)} draft task${reviewable === 1 ? '' : 's'}${held !== null ? ' not on hold' : ''}: confirm criteria, the prior-art basis and a central UAIN reviewer.`);
  if (payable) actions.push(`Before publishing ${fmt.format(payable)} payable-ready task${payable === 1 ? '' : 's'}, confirm the unlocked allowance from authoritative records.`);
  if (m.active) actions.push(`Confirm every active project (${fmt.format(m.active)}) has its Main KPI and five Fund Manager-defined Sub-KPIs, with criteria and required evidence given to the Project Manager.`);
  if (m.total === 0) actions.push('No projects are under coordination yet. Admit a project only with a prior-art basis.');
  actions.push('Keep reward spending to solver and reviewer rewards, with no self-review.');
  return actions;
}

const CSS = `
:root{--bg:#f6f6f4;--surface:#fff;--ink:#1b1c1e;--ink-2:#4a4d52;--ink-3:#6b6f76;--line:#e3e3df;--line-2:#d2d2cc;
--accent:#1f4fd1;--ok:#17703f;--ok-bg:#e8f4ec;--warn:#8a5300;--warn-bg:#fdf3e1;--bad:#a32a1f;--bad-bg:#fbeceb;--muted-bg:#efefec;
--radius:10px;--font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 var(--font);font-feature-settings:"tnum" 1}
a{color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.skip{position:absolute;left:-999px;top:8px;background:var(--surface);padding:8px 12px;border-radius:6px}
.skip:focus{left:8px}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.wrap{max-width:1120px;margin:0 auto;padding:0 20px}
header.top{background:var(--surface);border-bottom:1px solid var(--line)}
header.top .wrap{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding-top:18px;padding-bottom:18px}
.brand{display:flex;align-items:center;gap:12px}
.mark{width:34px;height:34px;border-radius:8px;background:var(--ink);color:#fff;display:grid;place-items:center;font-weight:700;font-size:13px;letter-spacing:.04em}
.brand h1{font-size:18px;line-height:1.2;margin:0;font-weight:650;letter-spacing:-.01em}
.brand p{margin:2px 0 0;color:var(--ink-3);font-size:13px}
.meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.pill{display:inline-block;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600;line-height:20px;white-space:nowrap}
.pill.ok{background:var(--ok-bg);color:var(--ok)}
.pill.warn{background:var(--warn-bg);color:var(--warn)}
.pill.bad{background:var(--bad-bg);color:var(--bad)}
.pill.muted{background:var(--muted-bg);color:var(--ink-2)}
.pill.ro{background:var(--ink);color:#fff}
main{padding:28px 0 56px}
.notice{border:1px solid var(--line-2);background:var(--surface);border-left:4px solid var(--accent);border-radius:var(--radius);padding:12px 16px;margin-bottom:24px;color:var(--ink-2)}
.notice strong{color:var(--ink)}
section{margin-top:32px}
section:first-of-type{margin-top:0}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3);font-weight:650;margin:0 0 12px}
h3{font-size:16px;margin:0 0 4px;font-weight:650}
.lede{margin:-4px 0 14px;color:var(--ink-2);max-width:68ch}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px}
.grid{display:grid;gap:12px}
.stats{grid-template-columns:repeat(4,minmax(0,1fr))}
.stat{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:16px 18px;position:relative}
.stat dt{font-size:13px;color:var(--ink-2);font-weight:550;display:flex;align-items:center;gap:8px}
.stat dd{margin:6px 0 0;font-size:30px;line-height:1.1;font-weight:650;letter-spacing:-.02em}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none}
.d-total{background:var(--ink)}.d-active{background:var(--accent)}.d-blocked{background:var(--bad)}.d-done{background:var(--ok)}
.bar{display:flex;height:10px;border-radius:999px;overflow:hidden;background:var(--muted-bg);margin-top:14px}
.bar span{display:block;height:100%}
.bar .s-active{background:var(--accent)}.bar .s-blocked{background:var(--bad)}.bar .s-done{background:var(--ok)}
.legend{display:flex;flex-wrap:wrap;gap:6px 18px;margin:10px 0 0;padding:0;list-style:none;font-size:13px;color:var(--ink-2)}
.legend li{display:flex;align-items:center;gap:6px}
.bar-na{margin:0;color:var(--ink-3);font-size:13px}
.sub th{padding-left:28px}
.na{color:var(--ink-3);font-size:14px;font-weight:500;letter-spacing:0}
.two{grid-template-columns:minmax(0,1.15fr) minmax(0,1fr)}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
thead th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3);font-weight:650;border-bottom-color:var(--line-2)}
tbody tr:last-child th,tbody tr:last-child td{border-bottom:0}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
tbody th{font-weight:550}
.tbl{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}
.tbl caption{caption-side:top;text-align:left;padding:14px 12px 4px;font-weight:650;font-size:15px}
.hint{color:var(--ink-3);font-size:13px;display:block;font-weight:400}
.facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0;margin:0}
.facts div{padding:12px 0;border-bottom:1px solid var(--line)}
.facts div:nth-child(odd){padding-right:16px}
.facts div:nth-last-child(-n+2){border-bottom:0}
.facts dt{font-size:13px;color:var(--ink-3)}
.facts dd{margin:2px 0 0;font-weight:600;font-size:16px}
.warnbox{background:var(--warn-bg);border:1px solid #f0d9ac;border-radius:var(--radius);padding:14px 16px;color:#5c3800;margin-top:12px}
.warnbox h3{color:#5c3800;font-size:14px}
.warnbox ul{margin:6px 0 0;padding-left:18px}
.warnbox li{margin:2px 0}
.kv th{width:48%;color:var(--ink-2);font-weight:500}
.kv th,.kv td{padding:8px 0;font-size:14px}
.stages{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px}
.stages li{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:14px;position:relative}
.stages .n{display:inline-grid;place-items:center;width:26px;height:26px;border-radius:50%;background:var(--muted-bg);font-size:12px;font-weight:700;color:var(--ink)}
.stages li:first-child .n{background:var(--ink);color:#fff}
.stages .step{display:block;margin-top:10px;font-size:12px;font-weight:650;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-3)}
.stages .cap{display:block;margin-top:4px;font-weight:650;font-size:15px;font-variant-numeric:tabular-nums}
.stages .unit{color:var(--ink-3);font-weight:500;font-size:12px}
.stages p{margin:6px 0 0;font-size:13px;color:var(--ink-2);line-height:1.45}
.stages .cum{color:var(--ink-3);font-size:12px;font-variant-numeric:tabular-nums}
.closeout{margin:12px 0 0;padding-left:18px;color:var(--ink-2)}
.closeout li{margin:4px 0}
.actions{margin:0;padding:0;list-style:none;counter-reset:a}
.actions li{counter-increment:a;display:grid;grid-template-columns:28px 1fr;gap:10px;padding:12px 0;border-bottom:1px solid var(--line)}
.actions li:last-child{border-bottom:0}
.actions li::before{content:counter(a);content:counter(a) / "";width:24px;height:24px;border-radius:6px;background:var(--muted-bg);display:grid;place-items:center;font-size:12px;font-weight:700}
.muted{color:var(--ink-3)}
footer{border-top:1px solid var(--line);color:var(--ink-3);font-size:13px;padding:20px 0 32px}
footer p{margin:4px 0}
@media (max-width:960px){.stages{grid-template-columns:repeat(3,minmax(0,1fr))}.two{grid-template-columns:1fr}}
@media (max-width:640px){
body{font-size:14.5px}.wrap{padding:0 14px}main{padding-top:20px}
.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.stat dd{font-size:26px}
.stages{grid-template-columns:1fr}
.stages li{display:grid;grid-template-columns:30px 1fr;column-gap:10px}
.stages .step{margin-top:2px}.stages p{grid-column:2}
.facts{grid-template-columns:1fr}.facts div{padding-right:0!important}.facts div:nth-last-child(2){border-bottom:1px solid var(--line)}
.tbl{overflow-x:auto}th,td{padding:9px 10px}
}
@media print{body{background:#fff}.skip{display:none}.stat,.card,.tbl,.stages li{break-inside:avoid}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

export function renderManagementPanel(data: ManagementPanelData): string {
  const management = data?.management && typeof data.management === 'object' ? data.management : {};
  const funding = data?.funding && typeof data.funding === 'object' ? data.funding : {};
  const tasks = data?.tasks && typeof data.tasks === 'object' ? data.tasks : ({} as ManagementPanelData['tasks']);
  const observed = observedLabel(data?.observedAt);

  const total = count(management.total);
  const active = count(management.active);
  const blocked = count(management.blocked);
  const completed = count(management.completed);

  const tProjects = count(tasks.projects);
  const tDrafts = count(tasks.drafts);
  const tPayable = count(tasks.payable);
  const tHeld = count(tasks.held);
  // Held tasks are a subset of drafts; payable-ready tasks are separate. The
  // total is drafts plus payable-ready, so held tasks are never counted twice.
  const tSum = tDrafts !== null && tPayable !== null ? tDrafts + tPayable : null;
  const heldInconsistent = tHeld !== null && tDrafts !== null && tHeld > tDrafts;

  // Draw the distribution only when every count is reported; a missing count
  // is shown as unknown, never as zero.
  const statusKnown = total !== null && active !== null && blocked !== null && completed !== null;
  const pActive = pct(active, total);
  const pBlocked = pct(blocked, total);
  const pDone = pct(completed, total);
  const distribution = !statusKnown
    ? '<p class="bar-na">Status distribution not shown: one or more project counts were not reported.</p>'
    : total === 0
      ? '<p class="bar-na">No projects under coordination, so there is no status distribution.</p>'
      : `<div class="bar" role="img" aria-label="${escapeHtml(`Of ${fmt.format(total)} projects: ${fmt.format(active)} active, ${fmt.format(blocked)} blocked, ${fmt.format(completed)} completed`)}">
        <span class="s-active" style="width:${pActive}%"></span><span class="s-blocked" style="width:${pBlocked}%"></span><span class="s-done" style="width:${pDone}%"></span>
      </div>
      <ul class="legend" aria-hidden="true">
        <li><span class="dot d-active"></span>Active ${pActive}%</li>
        <li><span class="dot d-blocked"></span>Blocked ${pBlocked}%</li>
        <li><span class="dot d-done"></span>Completed ${pDone}%</li>
      </ul>`;

  const health = blocked === null ? '<span class="pill muted">Status not reported</span>'
    : blocked > 0 ? `<span class="pill bad">${escapeHtml(fmt.format(blocked))} blocked</span>`
    : '<span class="pill ok">No blocked projects</span>';

  const notice = typeof data?.notice === 'string' && data.notice.trim() ? data.notice.trim() : '';

  const stat = (label: string, dot: string, value: number | null) =>
    `<div class="stat"><dt><span class="dot ${dot}" aria-hidden="true"></span>${label}</dt><dd>${showCount(value)}</dd></div>`;

  const taskRow = (label: string, hint: string, value: number | null, pill: string, cls = '') =>
    `<tr${cls ? ` class="${cls}"` : ''}><th scope="row">${label}<span class="hint">${hint}</span></th><td>${pill}</td><td class="num">${showCount(value)}</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light">
<title>Project management · UAIN private admin</title>
<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top" role="banner">
  <div class="wrap">
    <div class="brand">
      <div class="mark" aria-hidden="true">UA</div>
      <div>
        <h1>Project management</h1>
        <p>UAIN private admin · authorized team members only</p>
      </div>
    </div>
    <div class="meta">
      <span class="pill ro">Read-only</span>
      ${health}
      <span class="pill muted">Observed ${observed.iso ? `<time datetime="${escapeHtml(observed.iso)}">${escapeHtml(observed.text)}</time>` : escapeHtml(observed.text)}</span>
    </div>
  </div>
</header>

<main id="main" class="wrap">
  ${notice ? `<div class="notice" role="note"><strong>Notice.</strong> ${escapeHtml(notice)}</div>` : ''}

  <section aria-labelledby="h-projects">
    <h2 id="h-projects">Project oversight</h2>
    <p class="lede">Projects under coordination. These are planning and coordination states, not funding states.</p>
    <dl class="grid stats" style="margin:0">
      ${stat('Total', 'd-total', total)}
      ${stat('Active', 'd-active', active)}
      ${stat('Blocked', 'd-blocked', blocked)}
      ${stat('Completed', 'd-done', completed)}
    </dl>
    <div class="card" style="margin-top:12px">
      ${distribution}
    </div>
  </section>

  <section aria-labelledby="h-tasks">
    <h2 id="h-tasks">Initial task readiness</h2>
    <p class="lede">Prepared starting tasks across ${showCount(tProjects)} source project${tProjects === 1 ? '' : 's'}. Tasks without a prior-art or evidence basis are held with a reason, not dropped.</p>
    <div class="tbl">
      <table>
        <caption class="sr-only">Initial task readiness by state</caption>
        <thead><tr><th scope="col">State</th><th scope="col">Meaning</th><th scope="col" class="num">Tasks</th></tr></thead>
        <tbody>
          ${taskRow('Draft', 'Needs criteria, prior-art basis or reviewer confirmed; includes held tasks', tDrafts, '<span class="pill warn">Review</span>')}
          ${taskRow('of which held', heldInconsistent ? 'Subset of drafts, but reported above the draft count; check the source' : 'Subset of drafts missing evidence, kept visible with its reason; not added again to the total', tHeld, '<span class="pill bad">Held</span>', 'sub')}
          ${taskRow('Payable-ready', 'Separate from drafts; criteria and reviewer set, can publish once allowance is confirmed', tPayable, '<span class="pill ok">Ready</span>')}
        </tbody>
        <tfoot><tr><th scope="row" colspan="2">All prepared tasks<span class="hint">Drafts plus payable-ready; held tasks are already within drafts</span></th><td class="num"><strong>${showCount(tSum)}</strong></td></tr></tfoot>
      </table>
    </div>
  </section>

  <section aria-labelledby="h-funding">
    <h2 id="h-funding">Funding policy</h2>
    <p class="lede">The reward allowance policy for each project: six incremental allocations that add up to the lifetime ceiling. These are policy amounts, not balances.</p>
    <div class="grid two">
      <div class="card">
        <h3>Policy</h3>
        <dl class="facts">
          <div><dt>Allocations</dt><dd>Six increments, released in order</dd></div>
          <div><dt>Lifetime ceiling per project</dt><dd>${fmt.format(LIFETIME)} AI$</dd></div>
          <div><dt>KPIs</dt><dd>One Main KPI + exactly five Sub-KPIs set by the Fund Manager</dd></div>
          <div><dt>Opening allocation</dt><dd>${fmt.format(ROUNDS[0].increment)} AI$, automatic on project start</dd></div>
          <div><dt>Later releases</dt><dd>Full achievement, independently verified</dd></div>
          <div><dt>Final release</dt><dd>${fmt.format(ROUNDS[ROUNDS.length - 1].increment)} AI$ after Sub-KPI 5 including Main KPI</dd></div>
          <div><dt>Task review</dt><dd>Central UAIN reviewers, no self-review</dd></div>
          <div><dt>Allowed spending</dt><dd>Solver and reviewer rewards</dd></div>
        </dl>
        <div class="warnbox" role="note" aria-labelledby="h-plan-vs-funded">
          <h3 id="h-plan-vs-funded">Plan is not funding</h3>
          <ul>
            <li>Figures on this page are policy amounts and plans. None of them is a spendable balance.</li>
            <li>Catalogue listing is not project admission, and admission alone moves no funds.</li>
            <li>Read unlocked, reserved and paid amounts only from authoritative ledger records.</li>
            <li>The allowance is a reward allowance, not a transfer to a manager's own wallet.</li>
            <li>Unused allowance carries forward; it is not new issuance and never raises the lifetime ceiling.</li>
          </ul>
        </div>
      </div>
      <div class="card">
        <h3>Reported funding status</h3>
        <p class="muted" style="margin:0 0 8px;font-size:13px">Status flags from the funding source. Monetary fields are not shown here.</p>
        ${fundingStatusRows(funding)}
      </div>
    </div>
  </section>

  <section aria-labelledby="h-stages">
    <h2 id="h-stages">Six-step allocation process</h2>
    <p class="lede">Each release adds its increment to the project's reward allowance, only after the step before it is fully achieved and independently verified against the current approved criteria. Sub-KPIs are completed in order, there is no sixth Sub-KPI, and there is no seventh release.</p>
    <ol class="stages">
      ${ROUNDS.map((r) => `<li><span class="n" aria-hidden="true">${r.n}</span><div><span class="step">${r.step}</span><span class="cap">+${fmt.format(r.increment)} <span class="unit">AI$ increment</span></span><p>${r.gate}</p><p class="cum">Allowance unlocked to date: ${fmt.format(r.unlockedToDate)} AI$</p></div></li>`).join('\n      ')}
    </ol>
    <div class="grid two" style="margin-top:12px">
      <div class="card">
        <h3>Verification</h3>
        <ul class="closeout">
          <li>Project Managers submit evidence for each Sub-KPI; a manager cannot approve their own submission.</li>
          <li>Partial progress, intentions, promises and assumptions never qualify for a release.</li>
          <li>A rejection releases nothing, states the exact deficiencies and allows evidence to be resubmitted.</li>
          <li>Accepted Sub-KPIs are not reversed. Amendments for research findings are prospective, under Fund Manager authority.</li>
        </ul>
      </div>
      <div class="card">
        <h3>Achievement and financial closeout</h3>
        <ul class="closeout">
          <li>Main KPI achievement is verified before the final increment unlocks. Achievement does not close the project's finances.</li>
          <li>Financial closeout is a separate administrative state, recorded explicitly with any remaining obligations.</li>
          <li>Reserved solver and reviewer rewards stay payable and settle; closeout never strands them.</li>
          <li>The final allowance stays reward-only within the lifetime ceiling. There is no automatic personal payout.</li>
        </ul>
      </div>
    </div>
  </section>

  <section aria-labelledby="h-next">
    <h2 id="h-next">Next actions</h2>
    <div class="card">
      <ol class="actions">
        ${nextActions({ active, blocked, total }, tasks).map((a) => `<li><span>${escapeHtml(a)}</span></li>`).join('\n        ')}
      </ol>
    </div>
  </section>
</main>

<footer class="wrap" role="contentinfo">
  <p>UAIN private admin. Read-only view of aggregate counts; it holds no member identities and makes no changes.</p>
  <p>Access requires delegated admin sign-in with MFA and an independent grant.</p>
</footer>
</body>
</html>
`;
}

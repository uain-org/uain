/**
 * The pages. Server-rendered, no script, one stylesheet inline, in the main
 * site's colours: navy and UN blue, hairline rules, uppercase kickers, square
 * corners.
 */
import { html, raw } from './html.js';
import { signupCharts } from './chart.js';
import { DEFAULT_SORT, PAGE_SIZE, SORTS } from './db.js';
import {
  COLUMN_LABELS,
  COLUMNS,
  LIST_COLUMNS,
  URL_COLUMNS,
  candidateId,
  formatTime,
  optionLabel,
  parseList,
  safeHttpUrl,
} from './fields.js';

const STYLE = raw(`
:root{--navy:#003b5c;--navy-dark:#002b45;--un-blue:#009edb;--blue:#0072bc;--blue-deep:#00558c;--sky:#eaf6fb;--ice:#f4f8fa;--ink:#162a38;--slate:#526a78;--muted:#7c919b;--border:#cbd8de;--line:#bdccd3;--alert:#b4342a}
*{box-sizing:border-box}
html{background:var(--navy-dark)}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:#fff;color:var(--ink);font-family:Geist,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:var(--blue);text-decoration:none}
a:hover{text-decoration:underline}
:focus-visible{outline:3px solid #ffd166;outline-offset:2px}
.shell{width:min(calc(100% - 3rem),1260px);margin-inline:auto}
.top{background:var(--navy);color:#fff}
.top__inner{display:flex;align-items:center;gap:2.2rem;min-height:62px}
.brand{display:flex;align-items:baseline;gap:.7rem;color:#fff;font-size:1.2rem;font-weight:760;letter-spacing:-.03em}
.brand:hover{text-decoration:none}
.brand small{color:#b9d7e8;font-size:.64rem;font-weight:700;letter-spacing:.15em;text-transform:uppercase}
.nav{display:flex;flex:1;gap:1.7rem}
.nav a{padding:1.3rem 0 1.1rem;border-bottom:3px solid transparent;color:rgba(255,255,255,.78);font-size:.74rem;font-weight:720;letter-spacing:.08em;text-transform:uppercase}
.nav a:hover{color:#fff;text-decoration:none}
.nav a[aria-current=page]{border-bottom-color:var(--un-blue);color:#fff}
.top form{margin:0}
.signout{min-height:34px;border:1px solid rgba(255,255,255,.35);background:transparent;color:#fff;cursor:pointer;font:inherit;font-size:.74rem;font-weight:720;letter-spacing:.06em;padding:.35rem .8rem;text-transform:uppercase}
.signout:hover{border-color:#fff;background:rgba(255,255,255,.08)}
.band{height:4px;background:var(--un-blue)}
.private{background:var(--ice);border-bottom:1px solid var(--border);color:var(--slate);font-size:.76rem}
.private .shell{padding:.5rem 0}
.private strong{color:var(--navy)}
main{flex:1;padding:2.2rem 0 4rem}
.foot{background:var(--navy-dark);color:rgba(255,255,255,.62);font-size:.74rem}
.foot .shell{padding:1.1rem 0}
.kicker{margin:0 0 .55rem;color:var(--blue);font-size:.68rem;font-weight:780;letter-spacing:.15em;text-transform:uppercase}
.kicker::before{display:inline-block;width:28px;height:4px;margin:0 .7rem .16rem 0;background:currentColor;content:''}
h1{margin:0 0 1.6rem;color:var(--navy);font-size:clamp(1.5rem,2.4vw,2rem);font-weight:760;letter-spacing:-.035em;line-height:1.15}
h2{margin:0 0 .9rem;color:var(--navy);font-size:1.05rem;font-weight:740;letter-spacing:-.015em}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem;margin-bottom:2.4rem}
.tile{border-top:4px solid var(--un-blue);background:var(--ice);padding:1rem 1.2rem 1.1rem}
.tile--lead{border-top-color:var(--navy);background:var(--navy);color:#fff}
.tile span{display:block;color:var(--slate);font-size:.66rem;font-weight:760;letter-spacing:.1em;text-transform:uppercase}
.tile--lead span{color:#b9d7e8}
.tile strong{display:block;margin-top:.3rem;color:var(--navy);font-size:2.1rem;font-weight:760;font-variant-numeric:tabular-nums;letter-spacing:-.035em;line-height:1.1}
.tile--lead strong{color:#fff}
.tile small{display:block;margin-top:.25rem;color:var(--muted);font-size:.76rem}
.tile--lead small{color:#b9d7e8}
.panel{margin-bottom:2.4rem;border-top:1px solid var(--line);padding-top:1.1rem}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(440px,1fr));gap:1.2rem 2.5rem}
.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:1.6rem 2.5rem}
.figure{margin:0}
.figure figcaption{margin-bottom:.5rem;color:var(--slate);font-size:.66rem;font-weight:780;letter-spacing:.1em;text-transform:uppercase}
.chart{display:block;width:100%;height:auto;overflow:visible}
.chart .grid{stroke:#e3ebef;stroke-width:1}
.chart .axis{stroke:var(--line);stroke-width:1}
.chart .tick{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
.chart .bar{fill:var(--blue)}
.chart .line{fill:none;stroke:var(--blue);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.chart .area{fill:var(--blue);fill-opacity:.1}
.chart .dot{fill:var(--blue);stroke:#fff;stroke-width:2}
.chart .end{fill:var(--navy);font-size:12px;font-weight:740}
.chart .hit{fill:transparent}
.chart .hit:hover{fill:rgba(0,114,188,.1)}
.note,.empty{color:var(--slate);font-size:.84rem}
.numbers{margin-top:.8rem}
.numbers summary{color:var(--blue);cursor:pointer;font-size:.82rem;font-weight:700}
.numbers table{max-width:420px;margin-top:.6rem}
table{width:100%;border-collapse:collapse;font-size:.86rem}
th{border-bottom:1px solid var(--line);padding:.6rem .8rem .6rem 0;color:var(--blue);font-size:.63rem;font-weight:780;letter-spacing:.1em;text-align:left;text-transform:uppercase;white-space:nowrap}
th a{color:inherit}
th a:hover{color:var(--navy);text-decoration:none}
th .arrow{display:inline-block;margin-left:.3rem;color:var(--navy)}
td{border-bottom:1px solid var(--line);padding:.7rem .8rem .7rem 0;color:var(--slate);vertical-align:top;overflow-wrap:anywhere}
tbody tr:hover td{background:var(--sky)}
td.name a{color:var(--navy);font-weight:720}
td.id,td.when{white-space:nowrap;overflow-wrap:normal}
.num{text-align:right;font-variant-numeric:tabular-nums}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.8rem}
.clip{display:block;max-width:20ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip{display:inline-block;margin:0 .25rem .25rem 0;border:1px solid var(--border);background:var(--ice);color:var(--ink);font-size:.74rem;line-height:1.4;padding:.05rem .4rem}
.key{color:var(--muted);font-size:.74rem}
.counts td{padding:.45rem .8rem .45rem 0}
.counts .label{width:45%}
.counts .meter{width:35%}
.meter span{display:block;height:8px;min-width:2px;background:var(--blue)}
.counts a{color:var(--ink)}
.filters{display:flex;flex-wrap:wrap;align-items:flex-end;gap:.8rem;margin-bottom:1.2rem;border-top:4px solid var(--un-blue);background:var(--ice);padding:1rem 1.1rem}
.filters label{display:flex;flex-direction:column;gap:.3rem;color:var(--slate);font-size:.63rem;font-weight:780;letter-spacing:.1em;text-transform:uppercase}
input,select{min-height:40px;border:1px solid var(--line);border-radius:0;background:#fff;color:var(--ink);font:inherit;font-size:.9rem;padding:.45rem .6rem}
input[type=search]{width:min(420px,80vw)}
.table-wrap{overflow-x:auto}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:40px;border:1px solid var(--blue);background:var(--blue);color:#fff;cursor:pointer;font:inherit;font-size:.82rem;font-weight:740;padding:.45rem 1rem}
.btn:hover{border-color:var(--blue-deep);background:var(--blue-deep);text-decoration:none}
.btn--line{border-color:var(--line);background:#fff;color:var(--blue)}
.btn--line:hover{border-color:var(--blue);background:var(--sky);color:var(--blue)}
.bar-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:.8rem;color:var(--slate);font-size:.84rem}
.pager{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-top:1.2rem;color:var(--slate);font-size:.82rem}
.pager div{display:flex;gap:.6rem}
.pager .off{opacity:.4;pointer-events:none}
.fields{display:grid;grid-template-columns:minmax(150px,220px) 1fr;margin:0;border-top:1px solid var(--line)}
.fields dt,.fields dd{margin:0;border-bottom:1px solid var(--line);padding:.7rem 1rem .7rem 0}
.fields dt{color:var(--blue);font-size:.66rem;font-weight:780;letter-spacing:.1em;text-transform:uppercase;padding-top:.9rem}
.fields dd{color:var(--ink);overflow-wrap:anywhere;white-space:pre-wrap}
.fields dd ul{margin:0;padding-left:1.1rem;white-space:normal}
.fields .none{color:var(--muted)}
.crumbs{display:flex;justify-content:space-between;gap:1rem;margin-bottom:1.2rem;font-size:.84rem}
.crumbs div{display:flex;gap:1rem}
.login{display:grid;flex:1;place-items:center;background:var(--ice);padding:3rem 1rem}
.card{width:min(100%,400px);border-top:5px solid var(--un-blue);background:#fff;box-shadow:0 18px 40px rgba(0,43,69,.12);padding:2rem 2rem 2.2rem}
.card h1{margin-bottom:1.2rem;font-size:1.5rem}
.card label{display:flex;flex-direction:column;gap:.35rem;margin-bottom:1.1rem;color:var(--slate);font-size:.66rem;font-weight:780;letter-spacing:.1em;text-transform:uppercase}
.card input{width:100%}
.card .btn{width:100%}
.card p{color:var(--slate);font-size:.84rem}
.error{border-left:4px solid var(--alert);background:#fbeeed;color:#7d1f18;font-size:.86rem;margin:0 0 1.1rem;padding:.6rem .8rem}
@media (max-width:760px){.top__inner{flex-wrap:wrap;gap:.6rem 1.4rem;padding:.6rem 0}.nav a{padding:.4rem 0}.grid2,.grid3{grid-template-columns:1fr}.fields{grid-template-columns:1fr}.fields dt{border-bottom:0;padding-bottom:0}}
`);

const ICON = raw(
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#003b5c"/><rect y="26" width="32" height="6" fill="#009edb"/><text x="16" y="20" fill="#fff" font-family="Arial,sans-serif" font-size="11" font-weight="700" text-anchor="middle">UAIN</text></svg>`,
  ).replaceAll("'", '%27')}`,
);

const n = (x) => Number(x ?? 0).toLocaleString('en-GB');

function document({ title, body }) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${title} · UAIN Waitlist</title>
<link rel="icon" href="${ICON}">
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>`.toString();
}

/** A signed-in page: the bar, the reminder that this is personal data, the content. */
function layout({ title, current, csrf, body }) {
  const link = (href, label, key) =>
    html`<a href="${href}"${current === key ? raw(' aria-current="page"') : ''}>${label}</a>`;
  return document({
    title,
    body: html`<header class="top"><div class="shell top__inner">
  <a class="brand" href="/">UAIN <small>Waitlist</small></a>
  <nav class="nav" aria-label="Dashboard">${link('/', 'Overview', 'overview')}${link('/signups', 'Sign-ups', 'signups')}${link('/export.csv', 'Export CSV', 'export')}</nav>
  <form method="post" action="/logout"><input type="hidden" name="csrf" value="${csrf}"><button class="signout" type="submit">Sign out</button></form>
</div></header>
<div class="band"></div>
<div class="private"><div class="shell"><strong>Private.</strong> Names, emails and addresses of people and systems who trusted UAIN with them. Keep exports and screenshots inside the team.</div></div>
<main><div class="shell">${body}</div></main>
<footer class="foot"><div class="shell">UAIN · United AI Network · waitlist dashboard, read-only</div></footer>`,
  });
}

/** Pages without the signed-in bar: sign-in, errors, not configured. */
function plain({ title, body }) {
  return document({
    title,
    body: html`<header class="top"><div class="shell top__inner"><span class="brand">UAIN <small>Waitlist</small></span></div></header>
<div class="band"></div>
<main class="login">${body}</main>`,
  });
}

export function messagePage(status, title, message) {
  return plain({
    title,
    body: html`<div class="card"><p class="kicker">${status}</p><h1>${title}</h1><p>${message}</p></div>`,
  });
}

export function loginPage({ csrf, next, error }) {
  return plain({
    title: 'Sign in',
    body: html`<form class="card" method="post" action="/login">
  <p class="kicker">Private</p>
  <h1>Waitlist dashboard</h1>
  ${error ? html`<p class="error" role="alert">${error}</p>` : ''}
  <input type="hidden" name="csrf" value="${csrf}">
  <input type="hidden" name="next" value="${next}">
  <label>Password <input type="password" name="password" autocomplete="current-password" required autofocus maxlength="1024"></label>
  <button class="btn" type="submit">Sign in</button>
</form>`,
  });
}

// ------------------------------------------------------------------ helpers

/** A query string for the sign-ups list, leaving out what is already the default. */
export function listQuery(filter, change = {}) {
  const f = { ...filter, ...change };
  const p = new URLSearchParams();
  for (const k of ['q', 'status', 'channel', 'type']) if (f[k]) p.set(k, f[k]);
  if (f.sort && f.sort !== DEFAULT_SORT.sort) p.set('sort', f.sort);
  if (f.dir && f.dir !== DEFAULT_SORT.dir) p.set('dir', f.dir);
  if (f.page && f.page > 1) p.set('page', String(f.page));
  const s = p.toString();
  return s ? `?${s}` : '';
}

const chips = (column, text) => {
  const list = parseList(text);
  if (!list) return html`<span class="mono">${text}</span>`;
  return list.map((v) => html`<span class="chip">${optionLabel(column, v)}</span>`);
};

const idLink = (seq) => html`<a class="mono" href="/signups/${candidateId(seq)}">${candidateId(seq)}</a>`;

// ----------------------------------------------------------------- overview

function countTable({ title, column, items, total, filterKey }) {
  const top = Math.max(1, ...items.map((i) => i.n));
  return html`<section><h2>${title}</h2>
  ${
    items.length
      ? html`<table class="counts"><tbody>${items.map((i) => {
          const label = column ? optionLabel(column, i.item) : (i.item ?? '(none)');
          const known = column && label !== i.item;
          const name = filterKey
            ? html`<a href="/signups${listQuery({}, { [filterKey]: i.item })}">${label}</a>`
            : label;
          return html`<tr><td class="label">${name}${known ? html` <span class="key">${i.item}</span>` : ''}</td>
            <td class="meter"><span style="width:${((i.n / top) * 100).toFixed(1)}%"></span></td>
            <td class="num">${n(i.n)}</td>
            <td class="num key">${total ? `${Math.round((i.n / total) * 100)}%` : ''}</td></tr>`;
        })}</tbody></table>`
      : html`<p class="empty">None yet.</p>`
  }</section>`;
}

export function overviewPage({ csrf, data, today }) {
  const t = data.totals;
  const total = t.total;
  return layout({
    title: 'Overview',
    current: 'overview',
    csrf,
    body: html`<p class="kicker">Founding waitlist</p>
<h1>Who has signed up</h1>
<div class="tiles">
  <div class="tile tile--lead"><span>Sign-ups</span><strong>${n(total)}</strong><small>${t.first ? `since ${formatTime(t.first).slice(0, 10)}` : 'none yet'}</small></div>
  <div class="tile"><span>Last 24 hours</span><strong>${n(t.last1)}</strong></div>
  <div class="tile"><span>Last 7 days</span><strong>${n(t.last7)}</strong></div>
  <div class="tile"><span>Last 30 days</span><strong>${n(t.last30)}</strong></div>
  <div class="tile"><span>Latest</span><strong style="font-size:1.05rem;letter-spacing:0">${t.last ? formatTime(t.last) : '—'}</strong></div>
</div>
<section class="panel"><h2>Sign-ups over time</h2>${signupCharts(data.perDay, today)}</section>
<section class="panel"><div class="grid3">
  ${countTable({ title: 'Status', items: data.counts.status, total, filterKey: 'status' })}
  ${countTable({ title: 'Channel', items: data.counts.channel, total, filterKey: 'channel' })}
  ${countTable({ title: 'System types', column: 'system_types', items: data.counts.system_types, total, filterKey: 'type' })}
  ${countTable({ title: 'Networks', column: 'networks', items: data.counts.networks, total })}
  ${countTable({ title: 'Contributes', column: 'contributes', items: data.counts.contributes, total })}
  ${countTable({ title: 'Wants', column: 'wants', items: data.counts.wants, total })}
  ${countTable({ title: 'Missions', column: 'missions', items: data.counts.missions, total })}
</div><p class="note">Percentages are of all sign-ups; a sign-up may choose several system types, contributions, wants, missions and networks.</p></section>
<section class="panel"><div class="bar-row"><h2 style="margin:0">Latest 10</h2><a href="/signups">All sign-ups →</a></div>
${
  data.latest.length
    ? html`<div class="table-wrap"><table><thead><tr><th>ID</th><th>Name</th><th>Operator</th><th>System types</th><th>Channel</th><th>Status</th><th>Registered (UTC)</th></tr></thead><tbody>
  ${data.latest.map(
    (r) => html`<tr><td class="id">${idLink(r.seq)}</td><td class="name"><a href="/signups/${candidateId(r.seq)}">${r.name}</a></td><td>${r.operator ?? ''}</td>
      <td>${chips('system_types', r.system_types)}</td><td>${r.channel}</td><td>${r.status}</td><td class="when">${formatTime(r.registered_at, { zone: false })}</td></tr>`,
  )}</tbody></table></div>`
    : html`<p class="empty">No sign-ups yet.</p>`
}</section>`,
  });
}

// ------------------------------------------------------------------ sign-ups

const HEADERS = [
  ['id', 'ID'],
  ['name', 'Name'],
  ['operator', 'Operator'],
  ['email', 'Email'],
  [null, 'System types'],
  [null, 'Missions'],
  ['channel', 'Channel'],
  ['status', 'Status'],
  ['registered', 'Registered (UTC)'],
];

function header(filter, key, label) {
  if (!key || !Object.hasOwn(SORTS, key)) return html`<th>${label}</th>`;
  const active = filter.sort === key;
  const firstDir = key === 'registered' || key === 'id' ? 'desc' : 'asc';
  const dir = active ? (filter.dir === 'asc' ? 'desc' : 'asc') : firstDir;
  const aria = active ? (filter.dir === 'asc' ? 'ascending' : 'descending') : null;
  return html`<th${aria ? raw(` aria-sort="${aria}"`) : ''}><a href="/signups${listQuery(filter, { sort: key, dir, page: 1 })}">${label}${active ? html`<span class="arrow" aria-hidden="true">${filter.dir === 'asc' ? '▲' : '▼'}</span>` : ''}</a></th>`;
}

function select(name, label, current, values, text = (v) => v) {
  const all = current && !values.includes(current) ? [current, ...values] : values;
  return html`<label>${label}<select name="${name}"><option value="">All</option>${all.map(
    (v) => html`<option value="${v}"${v === current ? raw(' selected') : ''}>${text(v)}</option>`,
  )}</select></label>`;
}

export function signupsPage({ csrf, filter, result, options }) {
  const pages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  const from = result.total ? (filter.page - 1) * PAGE_SIZE + 1 : 0;
  const to = Math.min(result.total, filter.page * PAGE_SIZE);
  const filtered = filter.q || filter.status || filter.channel || filter.type;
  const exportHref = `/export.csv${listQuery({ ...filter, page: 1 })}`;
  const pageLink = (page, label) =>
    page >= 1 && page <= pages && page !== filter.page
      ? html`<a class="btn btn--line" href="/signups${listQuery(filter, { page })}">${label}</a>`
      : html`<span class="btn btn--line off" aria-disabled="true">${label}</span>`;
  return layout({
    title: 'Sign-ups',
    current: 'signups',
    csrf,
    body: html`<p class="kicker">Founding waitlist</p>
<h1>Sign-ups</h1>
<form class="filters" method="get" action="/signups" role="search">
  <label>Search <input type="search" name="q" value="${filter.q}" placeholder="Name, email, operator, description, URL, goals" maxlength="200"></label>
  ${select('status', 'Status', filter.status, options.status)}
  ${select('channel', 'Channel', filter.channel, options.channel)}
  ${select('type', 'System type', filter.type, options.type, (v) => optionLabel('system_types', v))}
  ${filter.sort !== DEFAULT_SORT.sort ? html`<input type="hidden" name="sort" value="${filter.sort}">` : ''}
  ${filter.dir !== DEFAULT_SORT.dir ? html`<input type="hidden" name="dir" value="${filter.dir}">` : ''}
  <button class="btn" type="submit">Apply</button>
  ${filtered ? html`<a class="btn btn--line" href="/signups">Clear</a>` : ''}
</form>
<div class="bar-row">
  <span>${result.total ? `Showing ${n(from)}–${n(to)} of ${n(result.total)}` : 'No sign-ups match.'}${filtered ? ' (filtered)' : ''}</span>
  <a class="btn btn--line" href="${exportHref}">Export ${filtered ? 'these' : 'all'} as CSV</a>
</div>
<div class="table-wrap"><table>
<thead><tr>${HEADERS.map(([key, label]) => header(filter, key, label))}</tr></thead>
<tbody>${result.rows.map(
      (r) => html`<tr>
  <td class="id">${idLink(r.seq)}</td>
  <td class="name"><a href="/signups/${candidateId(r.seq)}">${r.name}</a></td>
  <td>${r.operator ?? ''}</td>
  <td><span class="clip" title="${r.email ?? ''}">${r.email ?? ''}</span></td>
  <td>${chips('system_types', r.system_types)}</td>
  <td>${chips('missions', r.missions)}</td>
  <td>${r.channel}</td>
  <td>${r.status}</td>
  <td class="when">${formatTime(r.registered_at, { zone: false })}</td>
</tr>`,
    )}</tbody>
</table></div>
<nav class="pager" aria-label="Pages">
  <span>Page ${n(filter.page)} of ${n(pages)}</span>
  <div>${pageLink(1, '« First')}${pageLink(filter.page - 1, '‹ Previous')}${pageLink(filter.page + 1, 'Next ›')}${pageLink(pages, 'Last »')}</div>
</nav>`,
  });
}

// -------------------------------------------------------------------- detail

function value(column, v) {
  if (v === null || v === undefined || v === '') return html`<span class="none">—</span>`;
  if (LIST_COLUMNS.includes(column)) {
    const list = parseList(v);
    if (!list) return html`<span class="mono">${v}</span>`;
    if (!list.length) return html`<span class="none">none chosen</span>`;
    return html`<ul>${list.map((x) => {
      const label = optionLabel(column, x);
      return html`<li>${label}${label !== x ? html` <span class="key">${x}</span>` : ''}</li>`;
    })}</ul>`;
  }
  if (URL_COLUMNS.includes(column)) {
    const u = safeHttpUrl(v);
    return u
      ? html`<a href="${u.href}" rel="noopener noreferrer nofollow" target="_blank">${v}</a>`
      : html`<span class="mono">${v}</span>`;
  }
  if (column === 'email' && /^[^\s@<>"']+@[^\s@<>"']+$/.test(v))
    return html`<a href="mailto:${encodeURIComponent(v).replace('%40', '@')}" rel="noopener noreferrer nofollow">${v}</a>`;
  if (column === 'registered_at') return html`${formatTime(v, { seconds: true })} <span class="key">${v}</span>`;
  if (column === 'seq') return html`${v} <span class="key">${candidateId(v)}</span>`;
  if (column === 'wallet' || column === 'caller') return html`<span class="mono">${v}</span>`;
  return String(v);
}

export function detailPage({ csrf, row, columns, prev, next }) {
  const id = candidateId(row.seq);
  const ordered = [...COLUMNS.filter((c) => columns.includes(c)), ...columns.filter((c) => !COLUMNS.includes(c))];
  return layout({
    title: id,
    current: 'signups',
    csrf,
    body: html`<div class="crumbs"><a href="/signups">← All sign-ups</a><div>
  ${prev ? html`<a href="/signups/${candidateId(prev)}">‹ ${candidateId(prev)}</a>` : ''}
  ${next ? html`<a href="/signups/${candidateId(next)}">${candidateId(next)} ›</a>` : ''}
</div></div>
<p class="kicker">${id}</p>
<h1>${row.name}</h1>
<dl class="fields">${ordered.map(
      (c) => html`<dt>${COLUMN_LABELS[c] ?? c}</dt><dd>${value(c, row[c])}</dd>`,
    )}</dl>`,
  });
}

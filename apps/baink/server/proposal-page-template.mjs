// Script-free public HTML for one validated inactive source proposal. Every
// model value is treated as hostile: text is escaped, URLs are allow-listed and
// nothing from the model reaches CSS or an executable context.

const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const UNSAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
const UNSAFE_URL = /[\s\\\u0000-\u001f\u007f-\u009f]/;
const MAX_URL = 2048;
const NOT_PROVIDED = '<span class="absent">Not provided</span>';

const escapeHtml = (value) =>
  value.replace(/[&<>"']/g, (char) => ESCAPES[char]);
const record = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

// Numbers keep their literal String form: no rounding, grouping or parsing.
function plain(value) {
  if (typeof value === 'number')
    return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'string') return '';
  return value.toWellFormed().replace(UNSAFE_TEXT, '').trim();
}

function httpUrl(value, protocols = ['http:', 'https:']) {
  if (
    typeof value !== 'string' ||
    value.length > MAX_URL ||
    UNSAFE_URL.test(value)
  )
    return null;
  if (!/^https?:\/\/[^/]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (
      !protocols.includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

function sameOriginUrl(value, canonical) {
  const url = canonical ? httpUrl(value) : null;
  return url && url.origin === canonical.origin ? url : null;
}

function excerpt(text, limit) {
  const characters = Array.from(text);
  return characters.length > limit
    ? characters.slice(0, limit).join('').trimEnd() + '…'
    : text;
}

function row(label, valueHtml, className = 'mono') {
  const value = valueHtml || NOT_PROVIDED;
  return `<div><dt>${label}</dt><dd class="${className}">${value}</dd></div>`;
}

const literalRow = (label, value, className) =>
  row(label, escapeHtml(plain(value)), className);

function kpiSection(kpi) {
  const threshold = escapeHtml(plain(kpi.threshold));
  const unit = escapeHtml(plain(kpi.unit));
  const statement = escapeHtml(plain(kpi.statement));
  const comparator = escapeHtml(plain(kpi.comparator));
  const qualification = escapeHtml(plain(kpi.qualification));
  const figureClass = threshold.length > 12 ? 'figure figure-long' : 'figure';
  const target = threshold
    ? `<p class="label">Target threshold</p>
        <p class="target"><span class="${figureClass}">${threshold}</span>${unit ? `<span class="unit" dir="auto">${unit}</span>` : ''}</p>`
    : `<p class="label">Target threshold</p>
        <p class="note">The source gives no numeric threshold${unit ? `. Counted as: <span dir="auto">${unit}</span>` : ''}.</p>`;
  return `${statement ? `<p class="statement" dir="auto">${statement}</p>` : '<p class="note">The source gives no KPI statement.</p>'}
        ${target}
        ${comparator ? `<p class="note">Comparator: ${comparator}</p>` : ''}
        <p class="caveat">This KPI is a target. It is not an achieved or independently verified result.</p>
        ${qualification ? `<p class="note" dir="auto">${qualification}</p>` : ''}`;
}

function sourceSection(source, provenance, document) {
  const repository = httpUrl(source.repository, ['https:']);
  const workbook = plain(source.workbookSha256);
  const proposalHash = plain(provenance.source_sha256);
  return `<h3>Source record</h3>
        <dl class="record">
          ${row(
            'Repository',
            repository &&
              `<a href="${escapeHtml(repository.href)}" rel="noopener noreferrer"><span class="vh">Source repository: </span>${escapeHtml(repository.href)}</a>`,
          )}
          ${literalRow('Source revision', source.revision)}
          ${row('Workbook SHA-256', escapeHtml(workbook))}
          ${proposalHash && proposalHash !== workbook ? row('Proposal source SHA-256', escapeHtml(proposalHash)) : ''}
          ${literalRow('Sheet', provenance.sheet, 'value')}
          ${literalRow('Row', provenance.row, 'value')}
          ${literalRow('Source kind', source.kind)}
          ${literalRow('Source record status', source.status)}
          ${plain(source.integrity) ? literalRow('Integrity', source.integrity) : ''}
        </dl>
        <h3>This document</h3>
        <dl class="record">
          ${literalRow('Document revision', document.revision)}
          ${literalRow('Document schema', document.schema)}
        </dl>`;
}

const STYLE = `
:root {
  --ink: #080c12;
  --muted: #4b5666;
  --line: #e4e8ee;
  --accent: #bdd6ff;
  --wash: #f2f6fd;
  --surface: #fcfcfd;
  --sans: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --serif: 'Iowan Old Style', 'Palatino Linotype', Palatino, 'Noto Serif', Georgia, serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--surface);
  color: var(--ink);
  font: 400 1.0625rem/1.65 var(--sans);
  overflow-wrap: anywhere;
}
p, h1, h2, h3, dl, dd { margin: 0; }
a { color: inherit; text-decoration-thickness: 1px; text-underline-offset: 0.2em; }
a:hover { text-decoration-thickness: 2px; }
a:focus-visible { outline: 3px solid var(--ink); outline-offset: 3px; border-radius: 2px; }
main:focus { outline: none; }
.vh {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.skip {
  position: absolute;
  top: -6rem;
  left: 1rem;
  z-index: 1;
  padding: 0.6rem 1rem;
  background: var(--ink);
  color: #fff;
}
.skip:focus { top: 1rem; }
.page {
  width: 100%;
  max-width: 72rem;
  margin-inline: auto;
  padding-inline: clamp(1.25rem, 5vw, 3.5rem);
}
.masthead {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 0.25rem 1.5rem;
  padding-block: 1.5rem;
  font-size: 0.875rem;
}
.brand { font-weight: 700; letter-spacing: 0.08em; }
.catalogue { color: var(--muted); }
.lead { padding-block: clamp(2.5rem, 7vw, 5.5rem) clamp(2.5rem, 6vw, 4.5rem); }
.folio {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 1rem;
  margin-bottom: 1.75rem;
}
.id { font: 500 0.9375rem/1.4 var(--mono); }
.tag {
  padding: 0.15rem 0.6rem;
  border: 1px solid var(--accent);
  background: var(--accent);
  font-size: 0.8125rem;
  font-weight: 600;
  line-height: 1.5;
}
.eyebrow { margin-bottom: 0.9rem; color: var(--muted); font-size: 0.9375rem; }
h1 {
  max-width: 58rem;
  font: 500 clamp(2.125rem, 5.4vw, 4.25rem)/1.08 var(--serif);
  letter-spacing: -0.012em;
  text-wrap: balance;
}
h1.title-long { font-size: clamp(1.625rem, 3.4vw, 2.625rem); line-height: 1.18; }
h1.title-xlong { font-size: clamp(1.25rem, 2.2vw, 1.625rem); line-height: 1.35; letter-spacing: 0; text-wrap: wrap; }
.links {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem 1.75rem;
  margin-top: clamp(2rem, 4vw, 2.75rem);
}
.primary-link {
  display: inline-flex;
  align-items: center;
  min-height: 2.875rem;
  padding: 0.5rem 1.35rem;
  border: 1px solid var(--ink);
  background: var(--ink);
  color: #fff;
  font-weight: 600;
  text-decoration: none;
}
a.primary-link:hover { background: #1c2533; }
.primary-link.inert { border-style: dashed; border-color: var(--muted); background: none; color: var(--muted); }
.inert-link { color: var(--muted); }
.hint { margin-top: 0.75rem; color: var(--muted); font-size: 0.875rem; }
.section {
  display: grid;
  grid-template-columns: minmax(0, 11rem) minmax(0, 1fr);
  gap: 1rem 3rem;
  padding-block: clamp(2rem, 5vw, 3.25rem);
  border-top: 1px solid var(--line);
}
.section > * { min-width: 0; }
.body { max-width: 46rem; }
h2 { font: 600 0.9375rem/1.5 var(--sans); }
h3 { margin-bottom: 0.5rem; font: 600 0.9375rem/1.5 var(--sans); }
.record + h3 { margin-top: 2.25rem; }
.standing {
  padding-left: 1.25rem;
  border-left: 4px solid var(--accent);
  font: 400 clamp(1.375rem, 2.6vw, 1.75rem)/1.32 var(--serif);
}
.notice { margin-top: 1.25rem; padding: 0.9rem 1.1rem; background: var(--wash); font-size: 0.9375rem; }
.notice strong { display: block; font-weight: 600; }
.scope { font-size: 1.1875rem; line-height: 1.6; text-wrap: pretty; }
.statement { font-size: 1.1875rem; line-height: 1.6; }
.label { margin-top: 1.75rem; color: var(--muted); font-size: 0.875rem; }
.target { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 1rem; }
.figure {
  min-width: 0;
  border-bottom: 4px solid var(--accent);
  font: 500 clamp(3rem, 9vw, 5rem)/1.15 var(--serif);
}
.figure-long { font-size: clamp(1.75rem, 5vw, 2.5rem); }
.unit { flex: 1 1 12rem; min-width: 0; font-size: 1.125rem; }
.caveat { margin-top: 1.5rem; font-weight: 600; }
.note { margin-top: 0.5rem; color: var(--muted); font-size: 0.9375rem; }
.record div {
  display: grid;
  grid-template-columns: minmax(0, 12rem) minmax(0, 1fr);
  gap: 0.1rem 1.5rem;
  padding-block: 0.6rem;
  border-top: 1px solid var(--line);
  font-size: 0.875rem;
}
.record dt { color: var(--muted); }
.record .mono { font-family: var(--mono); font-size: 0.8125rem; line-height: 1.65; }
.absent { color: var(--muted); font-family: var(--sans); }
.colophon {
  padding-block: 1.5rem 2.5rem;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 0.875rem;
}
@media (max-width: 48rem) {
  .section { grid-template-columns: minmax(0, 1fr); }
  .record div { grid-template-columns: minmax(0, 1fr); }
}
`;

export function renderProposalPage(model) {
  const proposal = record(model);
  const kpi = record(proposal.kpi);
  const source = record(proposal.source);
  const provenance = record(proposal.provenance);
  const document = record(proposal.document);

  const canonical = httpUrl(proposal.canonicalUrl);
  const json = sameOriginUrl(proposal.jsonUrl, canonical);
  const workspace = sameOriginUrl(proposal.workspaceUrl, canonical);

  const titleText = plain(proposal.title) || 'Untitled proposal';
  const idText = plain(proposal.id);
  const descriptionText = plain(proposal.description);
  const noticeText = plain(source.notice);
  const context = [plain(proposal.category), plain(proposal.kind)].filter(
    Boolean,
  );
  const titleClass =
    titleText.length > 400
      ? ' class="title-xlong"'
      : titleText.length > 140
        ? ' class="title-long"'
        : '';
  const pageTitle = `${excerpt(titleText, 120)}${idText ? ` (${idText})` : ''} · BAINK proposal`;
  const summary = descriptionText
    ? `Inactive proposal. ${excerpt(descriptionText, 140)}`
    : 'Inactive BAINK proposal. Work is not established by this source.';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(pageTitle)}</title>
<meta name="description" content="${escapeHtml(summary)}">
${canonical ? `<link rel="canonical" href="${escapeHtml(canonical.href)}">` : ''}
${json ? `<link rel="alternate" type="application/json" href="${escapeHtml(json.href)}">` : ''}
<style>${STYLE}</style>
</head>
<body>
<a class="skip" href="#main">Skip to proposal</a>
<div class="page">
  <header class="masthead">
    <p class="brand">BAINK</p>
    <p class="catalogue">Proposal catalogue</p>
  </header>
  <main id="main" tabindex="-1">
    <div class="lead">
      <p class="folio">${idText ? `<span class="id">${escapeHtml(idText)}</span>` : ''}<span class="tag">Inactive proposal</span></p>
      ${context.length ? `<p class="eyebrow" dir="auto">${escapeHtml(context.join(' · '))}</p>` : ''}
      <h1${titleClass} dir="auto">${escapeHtml(titleText)}</h1>
      <div class="links">
        ${
          workspace
            ? `<a class="primary-link" href="${escapeHtml(workspace.href)}">Browse in BAINK</a>`
            : '<span class="primary-link inert">Browse in BAINK (link unavailable)</span>'
        }
        ${
          json
            ? `<a href="${escapeHtml(json.href)}" type="application/json">Machine-readable JSON</a>`
            : '<span class="inert-link">Machine-readable JSON (link unavailable)</span>'
        }
      </div>
      <p class="hint">Browse in BAINK opens the general workspace, not this proposal.</p>
    </div>
    <section class="section" aria-labelledby="status-heading">
      <h2 id="status-heading">Status</h2>
      <div class="body">
        <p class="standing">This source proposal is inactive. Work, funding and assignments are not established by this source.</p>
        ${noticeText ? `<p class="notice" dir="auto"><strong>Source notice</strong> ${escapeHtml(noticeText)}</p>` : ''}
      </div>
    </section>
    <section class="section" aria-labelledby="scope-heading">
      <h2 id="scope-heading">Scope</h2>
      <div class="body">
        ${descriptionText ? `<p class="scope" dir="auto">${escapeHtml(descriptionText)}</p>` : '<p class="note">The source gives no scope description.</p>'}
      </div>
    </section>
    <section class="section" aria-labelledby="target-heading">
      <h2 id="target-heading">KPI target</h2>
      <div class="body">
        ${kpiSection(kpi)}
      </div>
    </section>
    <section class="section" aria-labelledby="source-heading">
      <h2 id="source-heading">Source and provenance</h2>
      <div class="body">
        ${sourceSection(source, provenance, document)}
      </div>
    </section>
  </main>
  <footer class="colophon">
    <p>BAINK · Proposal catalogue</p>
  </footer>
</div>
</body>
</html>
`;
}

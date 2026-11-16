/**
 * Fixed prior-art survey driver (driver "prior-art-survey").
 *
 * Checks the first task of every project organization: an inventory of the
 * work that already exists for the project's Main KPI (decided by Rahul,
 * 6 November 2026). The untrusted artifact lists items by identifier. The
 * caller (verification.mjs) resolves every identifier through one fixed
 * primary-source record API per kind and hands the answers here as `records`.
 * This driver decides only from the policy, the claims and those answers:
 *
 *   - the survey names this project's exact Main KPI;
 *   - every item has a well-formed identifier, a title of its record, a
 *     relation to the Main KPI and a note; no item appears twice;
 *   - every identifier resolves: its record exists, and the claimed title
 *     matches the record's title (GitHub: the repository name matches);
 *   - every identifier the trusted project-level searches returned is
 *     accounted for (included, or screened out with a note);
 *   - enough items are included, from enough kinds of source;
 *   - the conclusion agrees with the items: it says the Main KPI is already
 *     met exactly when some item is marked meets_main_kpi, and otherwise it
 *     names the gaps that remain.
 *
 * A record that could not be read (timeout, rate limit, server error) makes
 * the result unverifiable, never a pass or a fail. A record the authority
 * says does not exist fails the survey: the citation is not real.
 *
 * A pass proves the inventory is well formed and its citations are real. Its
 * accuracy and completeness are for the central reviewer to judge.
 *
 * Self-contained on purpose: no imports, so the runner executes exactly the
 * bytes whose hash the policy pins.
 *
 * verify({ successTests, survey, records }) -> { status, findings, outputs }
 */

export const KINDS = Object.freeze(['doi', 'arxiv', 'github', 'pubmed', 'nct', 'wikidata']);
export const RELATIONS = Object.freeze(['meets_main_kpi', 'partial', 'adjacent', 'screened_out']);
export const MAX_ITEMS = 60;
const MAX_GAPS = 12;
const ID_PATTERNS = Object.freeze({
  doi: /^10\.[0-9]{4,9}\/[-._;()/:a-z0-9<>[\]]{1,200}$/,
  arxiv: /^(?:[0-9]{4}\.[0-9]{4,5}|[a-z-]{2,20}(?:\.[a-z]{2})?\/[0-9]{7})(?:v[0-9]{1,3})?$/,
  github: /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/,
  pubmed: /^[1-9][0-9]{0,9}$/,
  nct: /^NCT[0-9]{8}$/,
  wikidata: /^Q[1-9][0-9]{0,11}$/,
});

/** Canonical identifier form shared with survey.mjs: DOI, arXiv and GitHub are case-insensitive. */
export function normalizeId(kind, id) {
  if (typeof id !== 'string' || !Object.hasOwn(ID_PATTERNS, kind)) return null;
  let value = id.trim();
  if (kind === 'doi') value = value.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase();
  // arXiv: the version suffix is dropped, so 2401.01234v2 and 2401.01234 are one item.
  if (kind === 'arxiv') value = value.replace(/^arxiv:/i, '').toLowerCase().replace(/v[0-9]{1,3}$/, '');
  if (kind === 'github') value = value.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').toLowerCase();
  if (kind === 'nct' || kind === 'wikidata') value = value.toUpperCase();
  return ID_PATTERNS[kind].test(value) ? value : null;
}

const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const exactKeys = (v, keys) => plain(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const bytesOf = (s) => new TextEncoder().encode(s).length;
/** No control characters other than tab and newline (checked by code point, not a regex). */
const clean = (v) => { for (const ch of v) { const c = ch.codePointAt(0); if ((c < 32 && c !== 9 && c !== 10) || c === 127) return false; } return true; };
const text = (v, min, max) => typeof v === 'string' && v === v.trim() && bytesOf(v) >= min && bytesOf(v) <= max && clean(v);

/** Lowercase alphanumeric words, for comparing a claimed title with a record title. */
export function words(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/<[^>]{0,200}>/g, ' ').match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Same title: equal word sequences, one containing the other (at least four words), or word overlap of at least 0.6. */
export function sameTitle(claimed, recorded) {
  const a = words(claimed);
  const b = words(recorded);
  if (!a.length || !b.length) return false;
  const x = a.join(' ');
  const y = b.join(' ');
  if (x === y) return true;
  if (Math.min(a.length, b.length) >= 4 && (x.includes(y) || y.includes(x))) return true;
  const A = new Set(a);
  const B = new Set(b);
  let shared = 0;
  for (const w of A) if (B.has(w)) shared += 1;
  return shared / new Set([...A, ...B]).size >= 0.6;
}

function decodeJson(bytes) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

const XML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decodeXml = (s) => s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/gi, (m, e) => {
  if (e[0] !== '#') return XML_ENTITIES[e.toLowerCase()] ?? ' ';
  const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ' ';
});

/**
 * What one fixed record API says about one identifier:
 * { found: true, titles: [..] } | { found: false } | { unreadable: reason }.
 */
export function readRecord(kind, id, record) {
  if (!plain(record) || record.kind !== kind || record.id !== id) return { unreadable: 'record_missing' };
  if (record.status === 404) return { found: false };
  if (record.status !== 200 || !(record.body instanceof Uint8Array)) return { unreadable: 'record_unread' };
  const body = record.body;
  if (kind === 'arxiv') {
    let xml;
    try {
      xml = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      return { unreadable: 'record_unparseable' };
    }
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || !/<feed[\s>]/.test(xml)) return { unreadable: 'record_unparseable' };
    const entry = /<entry(?:\s[^>]{0,200})?>([\s\S]{0,40000}?)<\/entry>/.exec(xml);
    if (!entry) return { found: false };
    const entryId = /<id>\s*([^<]{1,300}?)\s*<\/id>/.exec(entry[1])?.[1] ?? '';
    if (/api\/errors/i.test(entryId)) return { found: false };
    const listed = entryId.replace(/^https?:\/\/arxiv\.org\/abs\//i, '').toLowerCase().replace(/v[0-9]{1,3}$/, '');
    if (listed !== id) return { found: false };
    const title = /<title(?:\s[^>]{0,200})?>([\s\S]{0,4000}?)<\/title>/.exec(entry[1])?.[1] ?? '';
    return { found: true, titles: [decodeXml(title.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'))] };
  }
  const json = decodeJson(body);
  if (!plain(json)) return { unreadable: 'record_unparseable' };
  if (kind === 'doi') {
    const m = json.message;
    if (json.status !== 'ok' || !plain(m) || String(m.DOI ?? '').toLowerCase() !== id) return { found: false };
    const titles = [...(Array.isArray(m.title) ? m.title : []), ...(Array.isArray(m.subtitle) ? m.subtitle : []), ...(Array.isArray(m['short-title']) ? m['short-title'] : [])];
    if (Array.isArray(m.title) && Array.isArray(m.subtitle) && m.title[0] && m.subtitle[0]) titles.push(`${m.title[0]} ${m.subtitle[0]}`);
    return { found: true, titles: titles.filter((t) => typeof t === 'string').slice(0, 8) };
  }
  if (kind === 'github') {
    if (typeof json.full_name !== 'string' || json.full_name.toLowerCase() !== id) return { found: false };
    return { found: true, titles: [json.full_name], repository: true };
  }
  if (kind === 'pubmed') {
    const r = plain(json.result) ? json.result[id] : null;
    if (!plain(r) || r.error !== undefined || String(r.uid ?? '') !== id) return { found: false };
    return { found: true, titles: [r.title].filter((t) => typeof t === 'string') };
  }
  if (kind === 'nct') {
    const m = json.protocolSection?.identificationModule;
    if (!plain(m) || m.nctId !== id) return { found: false };
    return { found: true, titles: [m.briefTitle, m.officialTitle, m.acronym].filter((t) => typeof t === 'string') };
  }
  if (kind === 'wikidata') {
    const e = plain(json.entities) ? json.entities[id] : null;
    if (!plain(e) || Object.hasOwn(e, 'missing') || e.id !== id) return { found: false };
    const label = e.labels?.en?.value;
    const aliases = Array.isArray(e.aliases?.en) ? e.aliases.en.map((a) => a?.value) : [];
    return { found: true, titles: [label, ...aliases].filter((t) => typeof t === 'string').slice(0, 16) };
  }
  return { unreadable: 'unknown_kind' };
}

function checkTest(t) {
  if (!exactKeys(t, ['id', 'mainKpi', 'minIncluded', 'minKinds', 'requiredIds'])) return 'invalid_success_test';
  if (!text(t.mainKpi, 20, 4096)) return 'invalid_success_test';
  if (!Number.isSafeInteger(t.minIncluded) || t.minIncluded < 1 || t.minIncluded > MAX_ITEMS) return 'invalid_success_test';
  if (!Number.isSafeInteger(t.minKinds) || t.minKinds < 1 || t.minKinds > KINDS.length) return 'invalid_success_test';
  if (!Array.isArray(t.requiredIds) || t.requiredIds.length > MAX_ITEMS) return 'invalid_success_test';
  for (const r of t.requiredIds) if (!exactKeys(r, ['kind', 'id']) || normalizeId(r.kind, r.id) !== r.id) return 'invalid_success_test';
  return null;
}

/** Shape and internal consistency, before any record is consulted. */
function checkShape(survey, test, findings) {
  if (!exactKeys(survey, ['mainKpi', 'asOf', 'items', 'conclusion'])) return findings.push('survey_shape_invalid'), null;
  if (survey.mainKpi !== test.mainKpi) findings.push('survey_main_kpi_mismatch');
  if (typeof survey.asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(survey.asOf) || Number.isNaN(Date.parse(survey.asOf))) findings.push('survey_date_invalid');
  if (!Array.isArray(survey.items) || survey.items.length === 0 || survey.items.length > MAX_ITEMS) return findings.push('survey_items_invalid'), null;
  const seen = new Set();
  const items = [];
  survey.items.forEach((item, i) => {
    if (!exactKeys(item, ['kind', 'id', 'title', 'relation', 'note'])) return findings.push(`item_${i}_shape_invalid`);
    const id = normalizeId(item.kind, item.id);
    if (id === null || id !== item.id) return findings.push(`item_${i}_id_invalid`);
    if (!text(item.title, 3, 300)) findings.push(`item_${i}_title_invalid`);
    if (!RELATIONS.includes(item.relation)) findings.push(`item_${i}_relation_invalid`);
    if (!text(item.note, 10, 400)) findings.push(`item_${i}_note_invalid`);
    const key = `${item.kind}:${id}`;
    if (seen.has(key)) return findings.push(`item_duplicate:${key}`);
    seen.add(key);
    items.push(item);
  });
  const c = survey.conclusion;
  if (!exactKeys(c, ['meetsMainKpi', 'gaps']) || typeof c.meetsMainKpi !== 'boolean' || !Array.isArray(c.gaps) || c.gaps.length > MAX_GAPS ||
    !c.gaps.every((g) => text(g, 20, 600))) {
    findings.push('conclusion_invalid');
    return { items, seen, conclusion: null };
  }
  const meets = items.some((it) => it.relation === 'meets_main_kpi');
  if (c.meetsMainKpi !== meets) findings.push('conclusion_contradicts_items');
  if (!c.meetsMainKpi && c.gaps.length === 0) findings.push('conclusion_gaps_missing');
  return { items, seen, conclusion: c };
}

export function verify({ successTests, survey, records }) {
  if (!Array.isArray(successTests) || successTests.length !== 1) return { status: 'fail', findings: ['invalid_success_tests'], outputs: {} };
  const test = successTests[0];
  const bad = checkTest(test);
  if (bad) return { status: 'fail', findings: [bad], outputs: {} };
  const findings = [];
  const shape = checkShape(survey, test, findings);
  if (!shape) return { status: 'fail', findings, outputs: {} };
  const { items, seen } = shape;

  for (const r of test.requiredIds) if (!seen.has(`${r.kind}:${r.id}`)) findings.push(`required_id_unaccounted:${r.kind}:${r.id}`);
  const included = items.filter((it) => it.relation !== 'screened_out');
  if (included.length < test.minIncluded) findings.push(`too_few_included:${included.length}/${test.minIncluded}`);
  const kinds = new Set(included.map((it) => it.kind));
  if (kinds.size < test.minKinds) findings.push(`too_few_source_kinds:${kinds.size}/${test.minKinds}`);

  const byKey = new Map();
  for (const r of Array.isArray(records) ? records : []) if (plain(r) && typeof r.kind === 'string' && typeof r.id === 'string') byKey.set(`${r.kind}:${r.id}`, r);
  const unreadable = [];
  for (const it of items) {
    const answer = readRecord(it.kind, it.id, byKey.get(`${it.kind}:${it.id}`));
    if (answer.unreadable) unreadable.push(`record_unreadable:${it.kind}:${it.id}:${answer.unreadable}`);
    else if (!answer.found) findings.push(`item_not_found:${it.kind}:${it.id}`);
    else if (!answer.repository && !answer.titles.some((t) => sameTitle(it.title, t))) findings.push(`item_title_mismatch:${it.kind}:${it.id}`);
  }
  const outputs = {
    included: included.length, screenedOut: items.length - included.length, kinds: [...kinds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    meetsMainKpi: shape.conclusion?.meetsMainKpi ?? null,
  };
  if (findings.length) return { status: 'fail', findings: [...findings, ...unreadable].slice(0, 256), outputs };
  if (unreadable.length) return { status: 'unverifiable', findings: unreadable.slice(0, 256), outputs };
  return { status: 'pass', findings: [`${test.id}:pass`, `included:${included.length}`, `kinds:${outputs.kinds.join(',')}`], outputs };
}

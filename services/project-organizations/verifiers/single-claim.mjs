/**
 * Fixed single-claim check driver (driver "single-claim"): the second small task class (plan W8,
 * 9 November 2026). One unresolved gap from an accepted prior-art survey is pinned as the claim;
 * the solver finds ONE primary record that supports or refutes it, quotes it and explains it in
 * about 15 to 20 minutes.
 *
 * The root-owned task policy pins the claim, the survey it comes from, which record kinds count and
 * which records the survey already cited (those cannot be reused). The untrusted artifact supplies
 * only {claim, verdict, record, quote, note}. The caller (verification.mjs) resolves the record
 * through the one fixed record API of its kind and hands the answer here as `records`. This driver
 * decides only from the policy, the check and that answer:
 *
 *   - the check names the pinned claim exactly and says supports or refutes;
 *   - the record is of an allowed kind, well formed and not one the survey already cited;
 *   - the record exists and the claimed title matches its title;
 *   - the quote and the note are present and bounded, and the quote appears word for word in the
 *     record's text as its record API returns it (an arXiv abstract, a Crossref abstract, a full
 *     ClinicalTrials.gov record). A record whose API returns no text (a PubMed summary, a DOI with
 *     no Crossref abstract) fails: a quote the checker cannot read never passes (SV-3, 13 November 2026).
 *
 * A record that could not be read makes the result unverifiable, never a pass or a fail. A record the
 * authority says does not exist fails: the citation is not real.
 *
 * A pass proves the check is well formed and its one citation is real and quoted exactly. Whether the record really supports or refutes the claim is for the central reviewer.
 *
 * Every failure finding is `code:subject — plain reason`, so a submitter knows what to fix.
 * Self-contained on purpose: no imports, so the runner executes exactly the bytes whose hash the
 * policy pins. The identifier and title rules equal verifiers/prior-art-survey.mjs (tested).
 *
 * verify({ successTests, check, records }) -> { status, findings, outputs }
 */

export const KINDS = Object.freeze(['doi', 'arxiv', 'github', 'pubmed', 'nct', 'wikidata']);
export const VERDICTS = Object.freeze(['supports', 'refutes']);
const MAX_EXCLUDED = 60;
const ID_PATTERNS = Object.freeze({
  doi: /^10\.[0-9]{4,9}\/[-._;()/:a-z0-9<>[\]]{1,200}$/,
  arxiv: /^(?:[0-9]{4}\.[0-9]{4,5}|[a-z-]{2,20}(?:\.[a-z]{2})?\/[0-9]{7})(?:v[0-9]{1,3})?$/,
  github: /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/,
  pubmed: /^[1-9][0-9]{0,9}$/,
  nct: /^NCT[0-9]{8}$/,
  wikidata: /^Q[1-9][0-9]{0,11}$/,
});

/** Canonical identifier form, as in prior-art-survey.mjs. */
export function normalizeId(kind, id) {
  if (typeof id !== 'string' || !Object.hasOwn(ID_PATTERNS, kind)) return null;
  let value = id.trim();
  if (kind === 'doi') value = value.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase();
  if (kind === 'arxiv') value = value.replace(/^arxiv:/i, '').toLowerCase().replace(/v[0-9]{1,3}$/, '');
  if (kind === 'github') value = value.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').toLowerCase();
  if (kind === 'nct' || kind === 'wikidata') value = value.toUpperCase();
  return ID_PATTERNS[kind].test(value) ? value : null;
}

const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const exactKeys = (v, keys) => plain(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const bytesOf = (s) => new TextEncoder().encode(s).length;
const clean = (v) => { for (const ch of v) { const c = ch.codePointAt(0); if ((c < 32 && c !== 9 && c !== 10) || c === 127) return false; } return true; };
const text = (v, min, max) => typeof v === 'string' && v === v.trim() && bytesOf(v) >= min && bytesOf(v) <= max && clean(v);
const squash = (v) => String(v).normalize('NFKC').replace(/<[^>]{0,200}>/g, ' ').replace(/\s+/g, ' ').trim();
const reason = (code, subject, plainText) => `${code}:${subject} — ${plainText}`.slice(0, 500);

export function words(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/<[^>]{0,200}>/g, ' ').match(/[\p{L}\p{N}]+/gu) ?? [];
}

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

function strings(v, out = [], depth = 0) {
  if (depth > 12 || out.length > 20000) return out;
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out, depth + 1);
  else if (plain(v)) for (const x of Object.values(v)) strings(x, out, depth + 1);
  return out;
}

/**
 * What one fixed record API says about one identifier:
 * { found: true, titles: [..], text: string|null } | { found: false } | { unreadable: reason }.
 * `text` is the record's own text a quote can be checked against, when the API returns it.
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
    const summary = /<summary(?:\s[^>]{0,200})?>([\s\S]{0,20000}?)<\/summary>/.exec(entry[1])?.[1] ?? '';
    const cdata = (s) => decodeXml(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
    return { found: true, titles: [cdata(title)], text: summary ? `${cdata(title)}\n${cdata(summary)}` : null };
  }
  const json = decodeJson(body);
  if (!plain(json)) return { unreadable: 'record_unparseable' };
  if (kind === 'doi') {
    const m = json.message;
    if (json.status !== 'ok' || !plain(m) || String(m.DOI ?? '').toLowerCase() !== id) return { found: false };
    const titles = [...(Array.isArray(m.title) ? m.title : []), ...(Array.isArray(m.subtitle) ? m.subtitle : []), ...(Array.isArray(m['short-title']) ? m['short-title'] : [])];
    if (Array.isArray(m.title) && Array.isArray(m.subtitle) && m.title[0] && m.subtitle[0]) titles.push(`${m.title[0]} ${m.subtitle[0]}`);
    return { found: true, titles: titles.filter((t) => typeof t === 'string').slice(0, 8), text: typeof m.abstract === 'string' ? `${titles.join('\n')}\n${m.abstract}` : null };
  }
  if (kind === 'github') {
    if (typeof json.full_name !== 'string' || json.full_name.toLowerCase() !== id) return { found: false };
    return { found: true, titles: [json.full_name], repository: true, text: null };
  }
  if (kind === 'pubmed') {
    const r = plain(json.result) ? json.result[id] : null;
    if (!plain(r) || r.error !== undefined || String(r.uid ?? '') !== id) return { found: false };
    return { found: true, titles: [r.title].filter((t) => typeof t === 'string'), text: null };
  }
  if (kind === 'nct') {
    const p = json.protocolSection;
    const m = p?.identificationModule;
    if (!plain(m) || m.nctId !== id) return { found: false };
    // The full record (more than the identification module) carries the trial's own text.
    const full = plain(p) && Object.keys(p).some((k) => k !== 'identificationModule');
    return { found: true, titles: [m.briefTitle, m.officialTitle, m.acronym].filter((t) => typeof t === 'string'), text: full ? strings(json).join('\n') : null };
  }
  if (kind === 'wikidata') {
    const e = plain(json.entities) ? json.entities[id] : null;
    if (!plain(e) || Object.hasOwn(e, 'missing') || e.id !== id) return { found: false };
    const label = e.labels?.en?.value;
    const aliases = Array.isArray(e.aliases?.en) ? e.aliases.en.map((a) => a?.value) : [];
    return { found: true, titles: [label, ...aliases].filter((t) => typeof t === 'string').slice(0, 16), text: null };
  }
  return { unreadable: 'unknown_kind' };
}

/** Validation of the policy's one success test; null when valid, else a finding. */
export function checkTest(t) {
  if (!exactKeys(t, ['id', 'claim', 'sourceTask', 'kinds', 'excludedIds'])) return 'invalid_success_test';
  if (typeof t.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(t.id) || !text(t.claim, 20, 600)) return 'invalid_success_test';
  if (typeof t.sourceTask !== 'string' || !/^T-[A-Za-z0-9][A-Za-z0-9._-]{0,93}$/.test(t.sourceTask)) return 'invalid_success_test';
  if (!Array.isArray(t.kinds) || t.kinds.length < 1 || new Set(t.kinds).size !== t.kinds.length || !t.kinds.every((k) => KINDS.includes(k))) return 'invalid_success_test';
  if (!Array.isArray(t.excludedIds) || t.excludedIds.length > MAX_EXCLUDED) return 'invalid_success_test';
  for (const r of t.excludedIds) if (!exactKeys(r, ['kind', 'id']) || normalizeId(r.kind, r.id) !== r.id) return 'invalid_success_test';
  return null;
}

export function verify({ successTests, check, records }) {
  if (!Array.isArray(successTests) || successTests.length !== 1) return { status: 'fail', findings: ['invalid_success_tests'], outputs: {} };
  const test = successTests[0];
  const bad = checkTest(test);
  if (bad) return { status: 'fail', findings: [bad], outputs: {} };
  if (!exactKeys(check, ['claim', 'verdict', 'record', 'quote', 'note'])) {
    return { status: 'fail', findings: [reason('check_shape_invalid', 'artifact', 'the "check" field must be exactly {claim, verdict, record, quote, note}')], outputs: {} };
  }
  const findings = [];
  if (check.claim !== test.claim) findings.push(reason('claim_mismatch', 'claim', 'copy the claim exactly as the task gives it'));
  if (!VERDICTS.includes(check.verdict)) findings.push(reason('verdict_invalid', 'verdict', 'verdict is "supports" or "refutes"'));
  if (!text(check.quote, 20, 600)) findings.push(reason('quote_invalid', 'quote', 'quote 20 to 600 bytes of the record, word for word'));
  if (!text(check.note, 10, 400)) findings.push(reason('note_invalid', 'note', 'say in 10 to 400 bytes how the quote supports or refutes the claim'));
  const r = check.record;
  if (!exactKeys(r, ['kind', 'id', 'title']) || !KINDS.includes(r.kind)) {
    findings.push(reason('record_invalid', 'record', `record is {kind, id, title}; kind is one of ${test.kinds.join(', ')}`));
    return { status: 'fail', findings, outputs: {} };
  }
  const id = normalizeId(r.kind, r.id);
  if (!test.kinds.includes(r.kind)) findings.push(reason('record_kind_not_allowed', r.kind, `this task accepts only ${test.kinds.join(', ')} records`));
  if (id === null || id !== r.id) {
    findings.push(reason('record_id_invalid', r.kind, 'give the identifier in its canonical form (DOI and GitHub lowercase, NCT and Wikidata uppercase, no URL)'));
    return { status: 'fail', findings, outputs: {} };
  }
  if (test.excludedIds.some((x) => x.kind === r.kind && x.id === id)) findings.push(reason('record_already_cited', `${r.kind}:${id}`, 'the survey already cites this record; find a different primary record'));
  if (!text(r.title, 3, 300)) findings.push(reason('record_title_invalid', `${r.kind}:${id}`, 'give the title of the record'));

  const byKey = new Map();
  for (const x of Array.isArray(records) ? records : []) if (plain(x) && typeof x.kind === 'string' && typeof x.id === 'string') byKey.set(`${x.kind}:${x.id}`, x);
  const answer = readRecord(r.kind, id, byKey.get(`${r.kind}:${id}`));
  let quoteChecked = false;
  const unreadable = [];
  if (answer.unreadable) unreadable.push(`record_unreadable:${r.kind}:${id}:${answer.unreadable}`);
  else if (!answer.found) findings.push(reason('record_not_found', `${r.kind}:${id}`, 'the record API has no record with this identifier; cite a real record'));
  else {
    if (!answer.repository && !answer.titles.some((t) => sameTitle(r.title, t))) findings.push(reason('record_title_mismatch', `${r.kind}:${id}`, 'the title does not match the record; copy the record\'s own title'));
    if (answer.text === null && typeof check.quote === 'string') {
      findings.push(reason('quote_not_checkable', `${r.kind}:${id}`, 'the record API returns no text for this record, so the quote cannot be checked; cite a record whose text it returns (an arXiv abstract, a Crossref abstract or a full ClinicalTrials.gov record)'));
    } else if (typeof check.quote === 'string') {
      quoteChecked = true;
      if (!squash(answer.text).includes(squash(check.quote))) findings.push(reason('quote_not_in_record', `${r.kind}:${id}`, 'the quote is not in the record\'s text; quote it word for word'));
    }
  }
  const outputs = { verdict: VERDICTS.includes(check.verdict) ? check.verdict : null, record: `${r.kind}:${id}`, quoteChecked };
  if (findings.length) return { status: 'fail', findings: [...findings, ...unreadable], outputs };
  if (unreadable.length) return { status: 'unverifiable', findings: unreadable, outputs };
  return { status: 'pass', findings: [`${test.id}:pass`, `record:${r.kind}:${id}`, `verdict:${check.verdict}`, `quote_checked:${quoteChecked}`], outputs };
}

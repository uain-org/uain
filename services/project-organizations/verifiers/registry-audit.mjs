/**
 * Fixed registry audit driver (driver "registry-audit"), for registry audit and census tasks
 * (the 12 small-task drafts of 7 November 2026: one row per trial a fixed ClinicalTrials.gov query
 * returns, registry fields copied verbatim, PubMed publications listed, and a summary of counts).
 *
 * The root-owned task policy pins the exact ClinicalTrials.gov API v2 query, which registry fields a
 * row must copy, whether rows list publications, which quotes must come from the registry record and
 * how the summary counts. The untrusted artifact supplies only the rows. The caller
 * (verification.mjs) reruns the pinned query and resolves every listed PubMed ID through the one fixed
 * record API, and hands the answers here as `registry` (the query pages) and `records`. This driver
 * decides only from the policy, the rows and those answers:
 *
 *   - the artifact names the pinned query and a recent observation time;
 *   - there is exactly one row per study the query returns that was first posted on or before
 *     observedAt: no study missing, none extra, none twice;
 *   - every pinned registry field is copied exactly (whitespace runs count as one space);
 *   - every listed PubMed ID exists, and every publication the registry itself lists as a RESULT
 *     reference is listed;
 *   - every pinned quote appears word for word in that study's registry record;
 *   - the summary counts exactly what the rows say.
 *
 * A study whose registry record was updated after observedAt may differ from what the submitter
 * read: its copy and reference checks are reported, never failed. A query page or PubMed record that
 * could not be read makes the result unverifiable, never a pass or a fail.
 *
 * A pass proves the rows are complete, copied and countable. Classifications that need judgement
 * (for example whether a published outcome matches the registered one) are for the central reviewer.
 *
 * Every failure finding is `code:subject — plain reason`, so a submitter can fix exactly that row.
 * Self-contained on purpose: no imports, so the runner executes exactly the bytes whose hash the
 * policy pins.
 *
 * verify({ successTests, audit, registry, records, verifiedAt }) -> { status, findings, outputs }
 */

export const QUERY_PREFIX = 'https://clinicaltrials.gov/api/v2/studies?';
export const MAX_ROWS = 200;
export const MAX_PUBLICATIONS = 400;
const MAX_ROW_KEYS = 24;
const MAX_ROW_PUBLICATIONS = 50;
const MAX_QUOTE = 600;
const FINDINGS = 256;

const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const exactKeys = (v, keys) => plain(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
/** Verbatim with whitespace runs folded: line breaks and doubled spaces are not a copying error. */
export const squash = (v) => (typeof v === 'string' ? v.normalize('NFC').replace(/\s+/g, ' ').trim() : v);
const NCT = /^NCT[0-9]{8}$/;
const PMID = /^[1-9][0-9]{0,9}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const VALUE = /^[a-z][a-z0-9_]{0,40}$/;
const PATH = /^([a-zA-Z][a-zA-Z0-9]{0,40})(?:\[\]\.([a-zA-Z][a-zA-Z0-9]{0,40}))?$/;

const at = (o, ...keys) => keys.reduce((v, k) => (plain(v) ? v[k] : undefined), o);
const str = (v) => (typeof v === 'string' ? v : null);

/** The registry fields a policy may pin, each read from one fixed place of a v2 study record. */
export const COPY_FIELDS = Object.freeze({
  hasResults: (s) => s.hasResults === true,
  overallStatus: (s) => str(at(s, 'protocolSection', 'statusModule', 'overallStatus')),
  whyStopped: (s) => str(at(s, 'protocolSection', 'statusModule', 'whyStopped')),
  primaryCompletionDate: (s) => str(at(s, 'protocolSection', 'statusModule', 'primaryCompletionDateStruct', 'date')),
  registeredPrimaryOutcomes: (s) => {
    const list = at(s, 'protocolSection', 'outcomesModule', 'primaryOutcomes');
    return (Array.isArray(list) ? list : []).filter(plain).map((o) => ({ measure: str(o.measure), timeFrame: str(o.timeFrame) }));
  },
});

const reason = (code, subject, text) => `${code}:${subject} — ${text}`.slice(0, 500);

function decodeJson(bytes) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

/** A pinned query: the fixed v2 studies endpoint, JSON, every page (no page token or field filter). */
export function checkQuery(query) {
  if (typeof query !== 'string' || query.length > 2048 || !query.startsWith(QUERY_PREFIX)) return false;
  let url;
  try {
    url = new URL(query);
  } catch {
    return false;
  }
  if (url.origin !== 'https://clinicaltrials.gov' || url.pathname !== '/api/v2/studies' || url.hash || url.username || url.password) return false;
  for (const key of url.searchParams.keys()) if (['pageToken', 'fields', 'format', 'countTotal', 'markupFormat'].includes(key)) return false;
  return url.searchParams.size >= 1;
}

const parsePath = (path) => {
  const m = typeof path === 'string' ? PATH.exec(path) : null;
  return m ? { field: m[1], inner: m[2] ?? null } : null;
};

/** Validation of the policy's one success test; null when valid, else a finding. */
export function checkTest(t) {
  if (!exactKeys(t, ['id', 'query', 'maxAgeDays', 'copy', 'publications', 'registryQuotes', 'summary'])) return 'invalid_success_test';
  if (typeof t.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(t.id) || !checkQuery(t.query)) return 'invalid_success_test';
  if (!Number.isSafeInteger(t.maxAgeDays) || t.maxAgeDays < 1 || t.maxAgeDays > 30) return 'invalid_success_test';
  if (!Array.isArray(t.copy) || t.copy.length > 8 || new Set(t.copy).size !== t.copy.length || !t.copy.every((f) => Object.hasOwn(COPY_FIELDS, f))) return 'invalid_success_test';
  if (typeof t.publications !== 'boolean') return 'invalid_success_test';
  if (!Array.isArray(t.registryQuotes) || t.registryQuotes.length > 4 || new Set(t.registryQuotes).size !== t.registryQuotes.length ||
    !t.registryQuotes.every((p) => parsePath(p) && !Object.hasOwn(COPY_FIELDS, parsePath(p).field) && !['nct', 'publications'].includes(parsePath(p).field))) return 'invalid_success_test';
  const s = t.summary;
  if (s !== null) {
    if (!exactKeys(s, ['field', 'values', 'noPublication']) || !parsePath(s.field) || ['nct', 'publications'].includes(parsePath(s.field).field)) return 'invalid_success_test';
    if (!Array.isArray(s.values) || s.values.length < 1 || s.values.length > 16 || new Set(s.values).size !== s.values.length || !s.values.every((v) => VALUE.test(v))) return 'invalid_success_test';
    if (s.noPublication !== null && (!t.publications || parsePath(s.field).inner !== null || !s.values.includes(s.noPublication))) return 'invalid_success_test';
  }
  return null;
}

/** The studies of the query pages, or {unreadable}. */
export function readRegistry(pages) {
  if (!Array.isArray(pages) || pages.length === 0) return { unreadable: 'registry_unread' };
  const studies = [];
  for (const [n, page] of pages.entries()) {
    if (!plain(page) || page.status !== 200 || !(page.body instanceof Uint8Array)) return { unreadable: `registry_page_${n + 1}_unread` };
    const json = decodeJson(page.body);
    if (!plain(json) || !Array.isArray(json.studies)) return { unreadable: `registry_page_${n + 1}_unparseable` };
    if (n === pages.length - 1 && typeof json.nextPageToken === 'string' && json.nextPageToken) return { unreadable: 'registry_more_pages_than_read' };
    for (const s of json.studies) studies.push(s);
  }
  const byId = new Map();
  for (const s of studies) {
    const id = at(s, 'protocolSection', 'identificationModule', 'nctId');
    if (!plain(s) || typeof id !== 'string' || !NCT.test(id)) return { unreadable: 'registry_study_unparseable' };
    byId.set(id, s);
  }
  return { byId };
}

/** What the fixed PubMed record API says about one PMID: {found} | {unreadable}. */
export function readPubmed(id, record) {
  if (!plain(record) || record.kind !== 'pubmed' || record.id !== id) return { unreadable: 'record_missing' };
  if (record.status === 404) return { found: false };
  if (record.status !== 200 || !(record.body instanceof Uint8Array)) return { unreadable: 'record_unread' };
  const json = decodeJson(record.body);
  if (!plain(json)) return { unreadable: 'record_unparseable' };
  const r = plain(json.result) ? json.result[id] : null;
  return { found: plain(r) && r.error === undefined && String(r.uid ?? '') === id };
}

/** Every string in a study record, joined: the text a registry quote must come from. */
function recordText(study) {
  const out = [];
  const walk = (v, depth) => {
    if (depth > 12 || out.length > 20000) return;
    if (typeof v === 'string') out.push(squash(v));
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (plain(v)) for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(study, 0);
  return out.join('\n');
}

/** Values at a row path: `field` or `field[].inner`; null when the row lacks it. */
function valuesAt(row, path) {
  const { field, inner } = parsePath(path);
  if (!Object.hasOwn(row, field)) return null;
  if (inner === null) return [row[field]];
  if (!Array.isArray(row[field])) return null;
  const out = [];
  for (const el of row[field]) {
    if (!plain(el) || !Object.hasOwn(el, inner)) return null;
    out.push(el[inner]);
  }
  return out;
}

const same = (a, b) => JSON.stringify(deepSquash(a)) === JSON.stringify(deepSquash(b));
function deepSquash(v) {
  if (typeof v === 'string') return squash(v);
  if (Array.isArray(v)) return v.map(deepSquash);
  if (plain(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, deepSquash(v[k])]));
  return v;
}

function checkAudit(audit, test, verifiedAt, findings) {
  if (!exactKeys(audit, ['observedAt', 'query', 'rows', 'summary'])) {
    findings.push(reason('audit_shape_invalid', 'artifact', 'the "audit" field must be exactly {observedAt, query, rows, summary}'));
    return null;
  }
  const observed = typeof audit.observedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/.test(audit.observedAt) ? Date.parse(audit.observedAt) : NaN;
  const now = typeof verifiedAt === 'string' ? Date.parse(verifiedAt) : NaN;
  if (Number.isNaN(observed)) findings.push(reason('observed_at_invalid', 'observedAt', 'give the time you ran the query as an ISO 8601 UTC time such as 2026-11-10T08:00:00Z'));
  else if (!Number.isNaN(now) && observed > now + 86400000) findings.push(reason('observed_at_in_future', 'observedAt', 'observedAt is later than the check; give the time you actually ran the query'));
  else if (!Number.isNaN(now) && observed < now - test.maxAgeDays * 86400000) findings.push(reason('observed_at_too_old', 'observedAt', `rerun the query and resubmit: observations older than ${test.maxAgeDays} days are not accepted`));
  if (audit.query !== test.query) findings.push(reason('query_mismatch', 'query', 'query must be exactly the ClinicalTrials.gov URL the task gives'));
  if (!Array.isArray(audit.rows) || audit.rows.length > MAX_ROWS) {
    findings.push(reason('rows_invalid', 'rows', `rows must be a list of at most ${MAX_ROWS} rows`));
    return null;
  }
  return Number.isNaN(observed) ? null : new Date(observed).toISOString().slice(0, 10);
}

export function verify({ successTests, audit, registry, records, verifiedAt }) {
  if (!Array.isArray(successTests) || successTests.length !== 1) return { status: 'fail', findings: ['invalid_success_tests'], outputs: {} };
  const test = successTests[0];
  const bad = checkTest(test);
  if (bad) return { status: 'fail', findings: [bad], outputs: {} };
  const findings = [];
  const notes = [];
  const unreadable = [];
  const observedDay = checkAudit(audit, test, verifiedAt, findings);
  if (!Array.isArray(audit?.rows) || audit.rows.length > MAX_ROWS) return { status: 'fail', findings: findings.slice(0, FINDINGS), outputs: {} };

  // Rows: shape, identity, duplicates.
  const rows = new Map();
  audit.rows.forEach((row, i) => {
    if (!plain(row) || Object.keys(row).length > MAX_ROW_KEYS || typeof row.nct !== 'string' || !NCT.test(row.nct)) {
      return findings.push(reason('row_invalid', `rows[${i}]`, 'each row is an object with "nct" set to an NCT ID such as NCT01234567'));
    }
    if (rows.has(row.nct)) return findings.push(reason('row_duplicate', row.nct, 'list each study once'));
    rows.set(row.nct, row);
  });

  const reg = readRegistry(registry);
  if (reg.unreadable) unreadable.push(`registry_unreadable:${reg.unreadable}`);
  const pubmed = new Map();
  for (const r of Array.isArray(records) ? records : []) if (plain(r) && r.kind === 'pubmed' && typeof r.id === 'string') pubmed.set(r.id, r);

  let expected = 0;
  if (reg.byId) {
    // Coverage: one row per study first posted on or before observedAt.
    for (const [id, study] of reg.byId) {
      const posted = str(at(study, 'protocolSection', 'statusModule', 'studyFirstPostDateStruct', 'date'));
      if (observedDay !== null && (posted === null || !DAY.test(posted) || posted > observedDay)) continue;
      expected += 1;
      if (!rows.has(id)) findings.push(reason('row_missing', id, 'the fixed query returns this study but no row lists it; add one row for it'));
    }
    for (const id of rows.keys()) {
      const study = reg.byId.get(id);
      const posted = str(at(study, 'protocolSection', 'statusModule', 'studyFirstPostDateStruct', 'date'));
      if (!study) findings.push(reason('row_not_in_query', id, 'the fixed query does not return this study; remove the row'));
      else if (observedDay !== null && posted !== null && posted > observedDay) findings.push(reason('row_posted_after_observed', id, 'this study was first posted after observedAt; remove the row or rerun the query'));
    }
  }

  const listed = new Set();
  for (const [id, row] of rows) {
    const study = reg.byId?.get(id);
    const updated = str(at(study, 'protocolSection', 'statusModule', 'lastUpdatePostDateStruct', 'date'));
    const changedSince = observedDay !== null && updated !== null && updated > observedDay;
    // Copied fields.
    for (const field of test.copy) {
      if (!Object.hasOwn(row, field)) { findings.push(reason('row_field_missing', `${id}.${field}`, `copy ${field} from the registry record`)); continue; }
      if (!study) continue;
      if (!same(row[field], COPY_FIELDS[field](study))) {
        if (changedSince) notes.push(`copy_changed_since_observed:${id}.${field}`);
        else findings.push(reason('row_field_not_verbatim', `${id}.${field}`, `copy ${field} exactly as the registry record gives it`));
      }
    }
    // Publications.
    if (test.publications) {
      const pubs = row.publications;
      if (!Array.isArray(pubs) || pubs.length > MAX_ROW_PUBLICATIONS || !pubs.every((p) => typeof p === 'string' && PMID.test(p)) || new Set(pubs).size !== pubs.length) {
        findings.push(reason('row_publications_invalid', `${id}.publications`, 'publications is a list of distinct PubMed IDs written as digit strings, such as "31234567"'));
      } else {
        for (const p of pubs) listed.add(p);
        const refs = at(study, 'protocolSection', 'referencesModule', 'references');
        for (const ref of Array.isArray(refs) ? refs : []) {
          if (!plain(ref) || ref.type !== 'RESULT' || typeof ref.pmid !== 'string' || !PMID.test(ref.pmid) || pubs.includes(ref.pmid)) continue;
          if (changedSince) notes.push(`reference_added_since_observed:${id}:${ref.pmid}`);
          else findings.push(reason('row_result_reference_missing', `${id}:${ref.pmid}`, 'the registry lists this PubMed ID as a RESULT reference; add it to publications'));
        }
      }
    }
    // Quotes from the registry record.
    if (test.registryQuotes.length) {
      const text = study ? recordText(study) : null;
      for (const path of test.registryQuotes) {
        const values = valuesAt(row, path);
        if (values === null) { findings.push(reason('row_field_missing', `${id}.${path}`, `give ${path} as a quote from the registry record`)); continue; }
        for (const q of values) {
          if (typeof q !== 'string' || squash(q).length < 1 || q.length > MAX_QUOTE) findings.push(reason('row_quote_invalid', `${id}.${path}`, `a quote is 1 to ${MAX_QUOTE} characters of registry text`));
          else if (text !== null && !text.includes(squash(q)) && !changedSince) findings.push(reason('row_quote_not_in_registry', `${id}.${path}`, 'quote the registry record word for word; this text is not in it'));
        }
      }
    }
  }

  // Every listed PubMed ID resolves.
  if (listed.size > MAX_PUBLICATIONS) findings.push(reason('publications_too_many', 'rows', `list at most ${MAX_PUBLICATIONS} PubMed IDs in all`));
  else for (const p of listed) {
    const answer = readPubmed(p, pubmed.get(p));
    if (answer.unreadable) unreadable.push(`record_unreadable:pubmed:${p}:${answer.unreadable}`);
    else if (!answer.found) findings.push(reason('publication_not_found', `pubmed:${p}`, 'PubMed has no record with this ID; list only real PubMed IDs'));
  }

  // Summary.
  const s = test.summary;
  const counts = {};
  if (s !== null) {
    for (const v of s.values) counts[v] = 0;
    for (const [id, row] of rows) {
      const values = valuesAt(row, s.field);
      if (values === null) { findings.push(reason('row_field_missing', `${id}.${s.field}`, `give ${s.field}, one of ${s.values.join(', ')}`)); continue; }
      for (const v of values) {
        if (!s.values.includes(v)) findings.push(reason('row_value_invalid', `${id}.${s.field}`, `${s.field} must be one of ${s.values.join(', ')}`));
        else counts[v] += 1;
      }
      if (s.noPublication !== null && Array.isArray(row.publications)) {
        const none = row.publications.length === 0;
        if (none && row[s.field] !== s.noPublication) findings.push(reason('row_value_invalid', `${id}.${s.field}`, `a row without publications has ${s.field} ${s.noPublication}`));
        if (!none && row[s.field] === s.noPublication) findings.push(reason('row_value_invalid', `${id}.${s.field}`, `${s.noPublication} is only for a row without publications`));
      }
    }
    if (!exactKeys(audit.summary, s.values)) findings.push(reason('summary_invalid', 'summary', `summary has exactly the keys ${s.values.join(', ')}`));
    else for (const v of s.values) if (audit.summary[v] !== counts[v]) findings.push(reason('summary_count_mismatch', `summary.${v}`, `the rows give ${counts[v]}, the summary says ${Number.isSafeInteger(audit.summary[v]) ? audit.summary[v] : 'something that is not a count'}`));
  }

  const outputs = { rows: rows.size, expectedRows: reg.byId ? expected : null, publications: listed.size, summary: s === null ? null : counts, notes: notes.slice(0, 64) };
  if (findings.length) return { status: 'fail', findings: [...findings, ...unreadable].slice(0, FINDINGS), outputs };
  if (unreadable.length) return { status: 'unverifiable', findings: unreadable.slice(0, FINDINGS), outputs };
  return { status: 'pass', findings: [`${test.id}:pass`, `rows:${rows.size}`, `publications:${listed.size}`, ...notes].slice(0, FINDINGS), outputs };
}

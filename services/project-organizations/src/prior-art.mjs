/**
 * Trusted prior-art search step: produces the `priorArtRecord` that
 * task-proposal.mjs (`buildTaskProposal`) requires, with producer.kind
 * `trusted_search`.
 *
 * What is trusted here, and what is not:
 *   - Sources are a fixed allowlist of primary-source search APIs. Each has a
 *     deterministic query URL template and a fixed response parser. A caller
 *     can only choose among the ids below; it cannot add a host, template or
 *     parser.
 *   - Queries are derived deterministically from the proposed task's title and
 *     criteria keywords (tokenize, drop stop words, order by position and
 *     frequency). There is no input through which a model, or anyone, supplies
 *     a query string, a search, a citation or a result. Fields of the task other
 *     than title, criteria and eligibility_basis are never read.
 *   - Every search is fetched through the trusted retriever (pinned-address
 *     HTTPS, host allowlist, size cap) and bound to the exact URL and the sha256
 *     of the bytes read; both are written into its resultSummary, and the
 *     retrievals are returned alongside the record.
 *   - Response content is untrusted: display titles are sanitized and bounded.
 *     DOI identities use the fixed record verifier's canonical syntax; invalid
 *     identifiers are refused rather than stripped into a different identity.
 *   - Novelty is never decided automatically. openSolutionFound and knownAnswer
 *     come only from an explicit reviewer `assessment`; without one the step
 *     returns status `assessment_required` with the collected searches, so an
 *     independent reviewer decides. Finding zero results is not a novelty claim.
 *
 * Nothing here can prove the reviewer is independent of the proposing model;
 * the reviewer id and rationale are retained in the record basis for review.
 */
import { CATALOGUE_ID, HASH, OrganizationError, digest, exactKeys, need, plain, sha256, text } from './common.mjs';
import { MAX_PRIOR_ART_SEARCHES, MIN_PRIOR_ART_SEARCHES } from './pricing.mjs';
import { TRUSTED_PRIOR_ART_SCHEMA, TRUSTED_SEARCH_KIND } from './task-proposal.mjs';
import { createRetriever } from './verification.mjs';
import { normalizeId } from '../verifiers/prior-art-survey.mjs';

export const PRIOR_ART_PRODUCER_ID = 'uain-trusted-prior-art-search-v1';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const TOP_N = 5;
const TITLE_CHARS = 140;
const SUMMARY_BYTES = 2000;
const BASIS_BYTES = 4096;
const MAX_TERMS = 6;
const PENDING_LIMIT = 64;

/* ----------------------------------------------------------- sanitizing */

/** Untrusted response text -> one bounded line without control, format, bidi or markup characters. */
export function sanitizeText(value, maxChars = TITLE_CHARS) {
  if (typeof value !== 'string') return '';
  const flat = value.normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/[<>`|;="\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Truncate by UTF-16 units without splitting a surrogate pair.
  return flat.length <= maxChars ? flat : flat.slice(0, maxChars - 1).replace(/[\uD800-\uDBFF]$/, '').trimEnd() + '…';
}
const sanitizeId = (value) => (typeof value === 'string' ? value.normalize('NFKC').replace(/[^A-Za-z0-9._/:-]/g, '').slice(0, 100) : '');
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

/* -------------------------------------------------------------- parsers */

function json(bytes) {
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new OrganizationError('unparseable_response');
  }
  need(plain(value), 'unparseable_response');
  return value;
}
const list = (v) => (Array.isArray(v) ? v.slice(0, 100) : null);

function parseGithub(bytes) {
  const body = json(bytes);
  const items = list(body.items);
  need(items, 'unparseable_response');
  return {
    total: count(body.total_count),
    items: items.filter(plain).map((r) => ({ id: sanitizeId(r.full_name), title: sanitizeText(r.description ?? '') })),
  };
}

function parseCrossref(bytes) {
  const message = json(bytes).message;
  need(plain(message) && list(message.items), 'unparseable_response');
  return {
    total: count(message['total-results']),
    // IDs are identities, not display text: deleting DOI punctuation invents a
    // different record. Refuse malformed IDs rather than repairing them. Only
    // records with a real primary title that fits the fixed survey verifier can
    // become future required citations. Raw retrieval bytes/hash remain retained.
    items: list(message.items).filter(plain).flatMap((w) => {
      const id = normalizeId('doi', w.DOI);
      const titles = Array.isArray(w.title) ? w.title : [w.title];
      const title = titles.find((t) => typeof t === 'string' && Buffer.byteLength(t.trim()) >= 3
        && Buffer.byteLength(t.trim()) <= 300 && sanitizeText(t).length >= 3
        && !/^untitled$/i.test(t.trim()));
      return id && title ? [{ id, title: sanitizeText(title) }] : [];
    }),
  };
}

function parseSemanticScholar(bytes) {
  const body = json(bytes);
  const data = list(body.data);
  need(data, 'unparseable_response');
  return { total: count(body.total), items: data.filter(plain).map((p) => ({ id: sanitizeId(p.paperId), title: sanitizeText(p.title) })) };
}

const XML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decodeXml = (s) => s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/gi, (m, e) => {
  if (e[0] !== '#') return XML_ENTITIES[e.toLowerCase()] ?? ' ';
  const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ' ';
});

/** Minimal Atom reading: no DTDs or entity definitions, bounded regex scans, tags stripped. */
function parseArxiv(bytes) {
  let xml;
  try {
    xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new OrganizationError('unparseable_response');
  }
  need(!/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(xml), 'unparseable_response', 'DTDs are refused');
  need(/<feed[\s>]/.test(xml), 'unparseable_response');
  const total = /<opensearch:totalResults[^>]{0,200}>\s*([0-9]{1,12})\s*<\/opensearch:totalResults>/.exec(xml);
  const items = [];
  const entries = /<entry(?:\s[^>]{0,200})?>([\s\S]{0,20000}?)<\/entry>/g;
  for (let m = entries.exec(xml); m && items.length < 100; m = entries.exec(xml)) {
    const id = /<id>\s*([^<]{1,300}?)\s*<\/id>/.exec(m[1])?.[1] ?? '';
    const title = /<title(?:\s[^>]{0,200})?>([\s\S]{0,4000}?)<\/title>/.exec(m[1])?.[1] ?? '';
    const plainTitle = decodeXml(title.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]{0,500}>/g, ' '));
    items.push({ id: sanitizeId(decodeXml(id).replace(/^https?:\/\/arxiv\.org\/abs\//, 'arXiv:')), title: sanitizeText(plainTitle) });
  }
  return { total: total ? count(Number(total[1])) : null, items };
}

/* -------------------------------------------------------------- sources */

const enc = encodeURIComponent;
/** The only sources this step can query. Templates and parsers are fixed code. */
export const PRIOR_ART_SOURCES = Object.freeze({
  github_repositories: Object.freeze({
    host: 'api.github.com', label: 'api.github.com/search/repositories',
    url: (terms) => `https://api.github.com/search/repositories?q=${enc(terms.join(' '))}&per_page=10`, parse: parseGithub,
  }),
  arxiv: Object.freeze({
    host: 'export.arxiv.org', label: 'export.arxiv.org/api/query',
    url: (terms) => `https://export.arxiv.org/api/query?search_query=${enc(terms.map((t) => `all:${t}`).join(' AND '))}&start=0&max_results=10`,
    parse: parseArxiv,
  }),
  crossref_works: Object.freeze({
    host: 'api.crossref.org', label: 'api.crossref.org/works',
    url: (terms) => `https://api.crossref.org/works?query=${enc(terms.join(' '))}&rows=10&select=DOI,title`, parse: parseCrossref,
  }),
  semantic_scholar: Object.freeze({
    host: 'api.semanticscholar.org', label: 'api.semanticscholar.org/graph/v1/paper/search',
    url: (terms) => `https://api.semanticscholar.org/graph/v1/paper/search?query=${enc(terms.join(' '))}&limit=10&fields=title`,
    parse: parseSemanticScholar,
  }),
});
export const PRIOR_ART_HOSTS = Object.freeze([...new Set(Object.values(PRIOR_ART_SOURCES).map((s) => s.host))]);

/* -------------------------------------------------------------- queries */

const STOPWORDS = new Set(`a about above after again against all also among an and any are as at be because been before being below between both
but by can could did do does doing done during each either every few for from further had has have having here how however if in into is it
its itself just least less more most must new no nor not now of off on once only or other our out over own per same should since so some such
than that the their them then there these they this those through to too under until up upon use used using very via was were what when where
whether which while who whom why will with within without would yet your within across based given into onto toward towards versus vs
independent independently verify verified verification result results task tasks pinned retained reproduce reproduces reproduced reproduction
rerun reruns show shows demonstrate demonstrates evidence criteria criterion data dataset public open unchanged immutable stage within given
exactly least most first second one two three
provide provides provided check checks checked proper properly report reports reported produce produces produced
make makes made build builds built create creates created include includes including ensure ensures return returns
instance instances bounded case cases example examples method methods approach approaches new novel`.split(/\s+/).filter(Boolean));

/**
 * Words of the task templates, not of the subject (found 10 November 2026 on the 12 small-task
 * drafts and the live survey parts): evidence format and field names, record kinds and API hosts,
 * the survey-part wording ("Prior-art survey: … (part 1 of 4)", "Main KPI") and title verbs such as
 * "Give". Searching for them returns records about JSON rows and PubMed queries, not the subject.
 */
export const TEMPLATE_WORDS = Object.freeze(`query queries pubmed row rows record records json artifact artifacts submission submissions submit submits
submitted field fields kib summary summaries verdict verdicts verbatim quote quotes quoted copy copies copied list lists listed count counts
identifier identifiers title titles item items note notes relation relations conclusion gaps observedat asof mainkpi requiredids
pass passes passed fail fails failed hold holds whole every exactly
doi dois pmid pmids nct arxiv github wikidata esearch esummary efetch api url urls https http www org gov com net
clinicaltrials ncbi nlm nih crossref semanticscholar
prior-art survey surveys part parts unit units main kpi kpis meetsmainkpi screened kind kinds adjacent partial bytes entries
canonical unrelated accepted reviewer checker central fixed resolves resolve matching consistent accurate rewarded native limit
expected minutes small searches returned project-level primary-source yyyy-mm-dd
match matches changed added omitted unclear category categories meets finds iso utc role roles primarycompletiondate hasresults
give gives get gets let lets help helps put puts bring brings turn turns keep keeps take takes whose date dates say says said study studies you add adds found ids studyfirstpostdate
ones true false written leave undone prior-art-survey fit`.split(/\s+/).filter(Boolean));
for (const word of TEMPLATE_WORDS) STOPWORDS.add(word);
/** Template words of the survey-part criteria ("the fixed prior-art-survey verifier … finds the part complete … No
 * novelty claim") that can be the subject of a title ("Deterministic verifier for …"): dropped from criteria only. */
export const CRITERIA_TEMPLATE_WORDS = Object.freeze(['verifier', 'complete', 'novelty', 'claim']);

const tokens = (s) => s.normalize('NFKC').toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [];
/** URLs and DOIs in criteria are fixed sources and identifiers, not subject words (their percent-encoding made words such as "22epigenetic"). */
const withoutUrls = (s) => s.replace(/\bhttps?:\/\/[^\s"'<>()]+/gi, ' ').replace(/\b10\.[0-9]{4,9}\/[^\s;"'<>]+/g, ' ');
const keep = (t) => t.length >= 3 && t.length <= 32 && !STOPWORDS.has(t) && !/^[0-9-]+$/.test(t);

/**
 * Deterministic keyword queries from title and criteria only.
 * Query 1: the first title keywords. Query 2: leading title keywords plus the most
 * frequent criteria keywords not already used (ties by first position). Template words
 * (TEMPLATE_WORDS), URLs and DOIs never become terms, so a criteria text with no subject
 * words beyond the title gives the one title query.
 */
export function deriveQueries({ title, criteria }) {
  need(text(title, 3, 240) && text(criteria, 20, 4096), 'invalid_prior_art_request', 'title and criteria');
  const titleTerms = [...new Set(tokens(title).filter(keep))];
  need(titleTerms.length >= 2, 'insufficient_query_terms', 'the title needs at least two searchable keywords');
  const first = titleTerms.slice(0, MAX_TERMS);
  const freq = new Map();
  tokens(withoutUrls(criteria)).filter((t) => keep(t) && !CRITERIA_TEMPLATE_WORDS.includes(t)).forEach((t, i) => {
    const entry = freq.get(t) ?? { t, n: 0, i };
    entry.n += 1;
    freq.set(t, entry);
  });
  const extra = [...freq.values()].filter((e) => !first.includes(e.t)).sort((a, b) => b.n - a.n || a.i - b.i).map((e) => e.t);
  const second = [...first.slice(0, 3), ...extra].slice(0, MAX_TERMS);
  const queries = [first];
  if (extra.length && second.join(' ') !== first.join(' ')) queries.push(second);
  return queries;
}

/* ------------------------------------------------------------ assembling */

/** Binding first (url, sha256), then counts and bounded entries. Titles cannot forge
 * delimiters; canonical DOI punctuation is retained without whitespace, quotes,
 * equals signs or pipes, so it cannot manufacture summary binding fields. */
function summarize(parsed, url, hash) {
  const head = `url=${url}; sha256=${hash}; total=${parsed.total ?? 'unknown'}`;
  const shown = [];
  for (const item of parsed.items.slice(0, TOP_N)) {
    const entry = `${item.id || 'no-id'} "${item.title || 'untitled'}"`;
    if (Buffer.byteLength(`${head}; shown=${shown.length + 1}/${parsed.items.length}; top: ${[...shown, entry].join(' | ')}`) > SUMMARY_BYTES) break;
    shown.push(entry);
  }
  const summary = `${head}; shown=${shown.length}/${parsed.items.length}` + (shown.length ? `; top: ${shown.join(' | ')}` : '');
  need(Buffer.byteLength(summary) <= SUMMARY_BYTES, 'summary_too_large');
  return summary;
}

const norm = (v) => v.trim().replace(/\s+/g, ' ').toLowerCase();
const ASSESSMENT_KEYS = ['openSolutionFound', 'knownAnswer', 'reviewer', 'rationale'];
const REVIEWER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$/;

function checkAssessment(assessment, pending, producerId) {
  need(plain(assessment), 'assessment_required');
  const keys = Object.hasOwn(assessment, 'searchesDigest') ? [...ASSESSMENT_KEYS, 'searchesDigest'] : ASSESSMENT_KEYS;
  need(exactKeys(assessment, keys), 'invalid_assessment', 'assessment fields');
  need(typeof assessment.openSolutionFound === 'boolean' && typeof assessment.knownAnswer === 'boolean', 'invalid_assessment',
    'openSolutionFound and knownAnswer must be explicit booleans');
  need(typeof assessment.reviewer === 'string' && REVIEWER.test(assessment.reviewer), 'invalid_assessment', 'reviewer');
  need(assessment.reviewer !== producerId, 'invalid_assessment', 'the search step cannot review itself');
  need(text(assessment.rationale, 20, 2000), 'invalid_assessment', 'rationale');
  need(assessment.searchesDigest === undefined || (HASH.test(assessment.searchesDigest) && assessment.searchesDigest === pending.pendingId),
    'assessment_digest_mismatch', 'the assessment was made for other searches');
  const claim = pending.modelClaim;
  need(claim === null || (!norm(assessment.rationale).includes(claim) && !claim.includes(norm(assessment.rationale))), 'assessment_repeats_model_claim',
    'the rationale repeats the proposing model eligibility claim');
}

/**
 * createPriorArtSearch({ retriever, sources, clock, producerId, maxBytes })
 *   .run({ projectId, task, assessment? })   -> assessment_required | insufficient_searches | recorded
 *   .complete(pendingId, assessment)          -> recorded (for searches this instance collected)
 *
 * `task` is the manager's proposed task; only title, criteria and eligibility_basis
 * are read (the last only to refuse a reviewer rationale that copies it).
 */
export function createPriorArtSearch(options = {}) {
  need(plain(options) && Object.keys(options).every((k) => ['retriever', 'sources', 'clock', 'producerId', 'maxBytes'].includes(k)),
    'invalid_prior_art_search_config', 'unknown option');
  const { sources = Object.keys(PRIOR_ART_SOURCES), clock = () => Date.now(), producerId = PRIOR_ART_PRODUCER_ID, maxBytes = MAX_RESPONSE_BYTES } = options;
  need(Array.isArray(sources) && sources.length >= 1 && new Set(sources).size === sources.length, 'invalid_prior_art_search_config', 'sources');
  for (const id of sources) need(typeof id === 'string' && Object.hasOwn(PRIOR_ART_SOURCES, id), 'source_not_allowed', String(id?.host ?? id));
  need(typeof clock === 'function', 'invalid_prior_art_search_config', 'clock');
  need(typeof producerId === 'string' && REVIEWER.test(producerId), 'invalid_prior_art_search_config', 'producerId');
  need(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= MAX_RESPONSE_BYTES, 'invalid_prior_art_search_config', 'maxBytes');
  const retriever = options.retriever ?? createRetriever({
    allowedHosts: [...PRIOR_ART_HOSTS], maxBytes: MAX_RESPONSE_BYTES, timeoutMs: 20000,
    headers: { accept: 'application/json, application/atom+xml;q=0.9' },
  });
  need(typeof retriever?.observe === 'function', 'invalid_prior_art_search_config', 'a trusted retriever with observe() is required');
  const chosen = sources.map((id) => [id, PRIOR_ART_SOURCES[id]]);
  const pendings = new Map();

  const at = () => {
    const ms = new Date(clock()).getTime();
    need(Number.isFinite(ms), 'invalid_clock');
    return new Date(ms).toISOString();
  };

  async function search(projectId, task) {
    need(typeof projectId === 'string' && CATALOGUE_ID.test(projectId), 'invalid_prior_art_request', 'projectId');
    need(plain(task), 'invalid_prior_art_request', 'task');
    const { title, criteria } = task;
    const queries = deriveQueries({ title, criteria });
    const searches = [];
    const retrievals = [];
    const failures = [];
    for (const terms of queries) {
      for (const [id, source] of chosen) {
        if (searches.length >= MAX_PRIOR_ART_SEARCHES) break;
        const query = terms.join(' ');
        const url = source.url(terms);
        try {
          const observed = await retriever.observe(url, { hosts: [source.host], maxBytes });
          need(plain(observed) && observed.bytes instanceof Uint8Array, 'retrieval_failed');
          const bytes = Buffer.from(observed.bytes);
          const hash = sha256(bytes);
          need(observed.sha256 === undefined || observed.sha256 === hash, 'hash_mismatch');
          const finalUrl = new URL(typeof observed.url === 'string' ? observed.url : url);
          need(finalUrl.protocol === 'https:' && finalUrl.hostname === source.host, 'host_not_allowed', 'the answer came from another host');
          const observedAt = at();
          const parsed = source.parse(bytes);
          searches.push({ query, source: source.label, observedAt, resultSummary: summarize(parsed, finalUrl.href, hash) });
          retrievals.push({ source: id, query, url, finalUrl: finalUrl.href, sha256: hash, bytes: bytes.length, observedAt });
        } catch (error) {
          failures.push({ source: id, query, code: typeof error?.code === 'string' && /^[a-z_]{1,64}$/.test(error.code) ? error.code : 'retrieval_failed' });
        }
      }
    }
    const subject = { projectId, criteriaDigest: sha256(criteria) };
    const distinct = new Set(searches.map((s) => `${s.source}\n${s.query}`));
    if (distinct.size < MIN_PRIOR_ART_SEARCHES) return { status: 'insufficient_searches', subject, searches, retrievals, failures };
    const pendingId = digest({ subject, searches, retrievals });
    const claim = typeof task.eligibility_basis === 'string' && norm(task.eligibility_basis).length >= 20 ? norm(task.eligibility_basis) : null;
    pendings.set(pendingId, { pendingId, subject, searches, retrievals, failures, modelClaim: claim });
    while (pendings.size > PENDING_LIMIT) pendings.delete(pendings.keys().next().value);
    return { status: 'assessment_required', pendingId, subject, searches: structuredClone(searches), retrievals: structuredClone(retrievals), failures };
  }

  function complete(pendingId, assessment) {
    const pending = pendings.get(pendingId);
    need(pending, 'unknown_pending_search', 'only searches this step collected can be assessed');
    checkAssessment(assessment, pending, producerId);
    const recordedAt = at();
    need(pending.searches.every((s) => Date.parse(s.observedAt) <= Date.parse(recordedAt)), 'invalid_clock');
    const queries = [...new Set(pending.searches.map((s) => `"${s.query}"`))].join(', ');
    let basis = `Independent review by ${assessment.reviewer}: ${assessment.rationale.trim()} ` +
      `(open solution found: ${assessment.openSolutionFound ? 'yes' : 'no'}; known answer: ${assessment.knownAnswer ? 'yes' : 'no'}; ` +
      `${pending.searches.length} searches of ${[...new Set(pending.searches.map((s) => s.source))].join(', ')} for ${queries})`;
    if (Buffer.byteLength(basis) > BASIS_BYTES) basis = Buffer.from(basis).subarray(0, BASIS_BYTES - 3).toString('utf8').replace(/\uFFFD+$/, '') + '...';
    const record = {
      schema: TRUSTED_PRIOR_ART_SCHEMA,
      producer: { kind: TRUSTED_SEARCH_KIND, id: `${producerId}:${pendingId.slice(0, 16)}`, recordedAt },
      subject: structuredClone(pending.subject),
      basis,
      searches: structuredClone(pending.searches),
      knownAnswer: assessment.knownAnswer,
      openSolutionFound: assessment.openSolutionFound,
    };
    pendings.delete(pendingId);
    return {
      status: 'recorded', record, rewardable: !assessment.knownAnswer && !assessment.openSolutionFound,
      retrievals: structuredClone(pending.retrievals), failures: structuredClone(pending.failures),
    };
  }

  async function run(request) {
    need(plain(request) && Object.keys(request).every((k) => ['projectId', 'task', 'assessment'].includes(k)), 'invalid_prior_art_request',
      'only projectId, task and assessment are accepted');
    const collected = await search(request.projectId, request.task);
    if (collected.status !== 'assessment_required' || request.assessment === undefined) return collected;
    return complete(collected.pendingId, request.assessment);
  }

  return Object.freeze({ run, complete, sources: Object.freeze(sources.slice()) });
}

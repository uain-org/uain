/** Fixed identifier resolution for the prior-art survey (see survey.mjs and
 * verifiers/prior-art-survey.mjs). Kept apart so verification.mjs can use it without
 * importing the task builder. */
import { normalizeId } from '../verifiers/prior-art-survey.mjs';

export const SURVEY_CLASS = 'prior_art_survey';
export const SURVEY_DRIVER = 'prior-art-survey';
/** A record answer is small; anything larger is refused before the driver sees it. */
export const SURVEY_RECORD_MAX_BYTES = 512 * 1024;

const enc = encodeURIComponent;
/** The one record API per identifier kind. Fixed code: a submitter cannot add a host or a template. */
export const SURVEY_RESOLVERS = Object.freeze({
  doi: Object.freeze({ host: 'api.crossref.org', url: (id) => `https://api.crossref.org/works/${enc(id)}` }),
  arxiv: Object.freeze({ host: 'export.arxiv.org', url: (id) => `https://export.arxiv.org/api/query?id_list=${enc(id)}&max_results=1` }),
  github: Object.freeze({ host: 'api.github.com', url: (id) => `https://api.github.com/repos/${id.split('/').map(enc).join('/')}` }),
  pubmed: Object.freeze({ host: 'eutils.ncbi.nlm.nih.gov', url: (id) => `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${enc(id)}` }),
  nct: Object.freeze({ host: 'clinicaltrials.gov', url: (id) => `https://clinicaltrials.gov/api/v2/studies/${enc(id)}?fields=protocolSection.identificationModule` }),
  wikidata: Object.freeze({ host: 'www.wikidata.org', url: (id) => `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels%7Caliases&languages=en&ids=${enc(id)}` }),
});
export const SURVEY_HOSTS = Object.freeze([...new Set(Object.values(SURVEY_RESOLVERS).map((r) => r.host))].sort());

/** `{host, url}` for a canonical identifier, or null. The URL is built only from a validated id. */
export function surveyResolution(kind, id) {
  if (!Object.hasOwn(SURVEY_RESOLVERS, kind) || normalizeId(kind, id) !== id) return null;
  return { host: SURVEY_RESOLVERS[kind].host, url: SURVEY_RESOLVERS[kind].url(id) };
}


/** Single-claim checks (verifiers/single-claim.mjs) read the same record APIs, except that a trial is
 * read in full, so a quote from it can be checked word for word. */
export const CLAIM_RESOLVERS = Object.freeze({
  ...SURVEY_RESOLVERS,
  nct: Object.freeze({ host: 'clinicaltrials.gov', url: (id) => `https://clinicaltrials.gov/api/v2/studies/${enc(id)}` }),
});
export function claimResolution(kind, id) {
  if (!Object.hasOwn(CLAIM_RESOLVERS, kind) || normalizeId(kind, id) !== id) return null;
  return { host: CLAIM_RESOLVERS[kind].host, url: CLAIM_RESOLVERS[kind].url(id) };
}
/** Registry audits (verifiers/registry-audit.mjs) read the pinned ClinicalTrials.gov query and PubMed records. */
export const REGISTRY_HOSTS = Object.freeze(['clinicaltrials.gov', 'eutils.ncbi.nlm.nih.gov']);
/** A full record answer (a trial with posted results) can be large; a query page larger still. */
export const CLAIM_RECORD_MAX_BYTES = 4 * 1024 * 1024;
export const REGISTRY_PAGE_MAX_BYTES = 16 * 1024 * 1024;
export const REGISTRY_MAX_PAGES = 4;

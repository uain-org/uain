#!/usr/bin/env node
/** Drafts the project-level prior-art searches for the frozen 120-project selection.
 *
 *   node services/project-organizations/ops/draft-bootstrap.mjs [--only OPP-00002,OPP-00003] [--limit N]
 *        [--out <dir>] [--sources github_repositories,arxiv,crossref_works] [--summary]
 *
 * For each selected project it reads the catalogue row whose digest reproduces the pinned
 * source digest, derives the queries deterministically from the catalogue title and
 * description (prior-art.mjs deriveQueries, no model), runs them through the trusted search
 * step and writes one DRAFT to <out>/<id>.json. A draft never sets class, an assessment or
 * a novelty claim (`class: null`, `assessment: null`); see src/bootstrap-record.mjs
 * promoteDraft for the independent review that turns it into a reviewed bootstrap record.
 *
 * Resume-safe: a project whose draft already has status `assessment_required` for the same
 * pinned source is skipped; `insufficient_searches` drafts are retried. Writes are atomic.
 *
 * Pacing: GitHub's unauthenticated search allows 10 requests a minute, arXiv asks for one
 * request every 3 seconds. Each host has a minimum interval, and a refused answer is retried
 * once after a backoff. Semantic Scholar answers 429 without a key, so it is excluded by
 * default. Only public HTTPS GETs to the allowlisted search APIs are made. */
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadCatalogue } from '../../../apps/baink/server/catalogue.mjs';
import { catalogueRecords, loadSelection, sourceDigestOf } from '../src/selection.mjs';
import { PRIOR_ART_HOSTS, PRIOR_ART_PRODUCER_ID, PRIOR_ART_SOURCES, createPriorArtSearch, deriveQueries } from '../src/prior-art.mjs';
import { createRetriever } from '../src/verification.mjs';
import { BOOTSTRAP_DRAFTER_ID, BOOTSTRAP_DRAFT_SCHEMA, DRAFT_NOTE, searchesDigestOf, validateDraft } from '../src/bootstrap-record.mjs';
import { OrganizationError, need, sha256 } from '../src/common.mjs';

export const DEFAULT_OUT = fileURLToPath(new URL('../../../docs/baink/project-organizations-2026-11-06/bootstrap-drafts/', import.meta.url));
export const CATALOGUE_DIR = fileURLToPath(new URL('../../../apps/baink/catalogue', import.meta.url));
export const DEFAULT_SOURCES = Object.freeze(['github_repositories', 'arxiv', 'crossref_works']);
/** Minimum spacing per host, in milliseconds. */
export const HOST_INTERVALS = Object.freeze({ 'api.github.com': 6500, 'export.arxiv.org': 3500, 'api.crossref.org': 1000, 'api.semanticscholar.org': 3500 });
/** Backoff before the single retry of a failed request, per host. */
export const RETRY_DELAYS = Object.freeze({ 'api.github.com': 65000, 'export.arxiv.org': 15000, 'api.crossref.org': 5000, 'api.semanticscholar.org': 15000 });
const RETRYABLE = new Set(['unexpected_status', 'retrieval_failed', 'timeout', 'dns_failed', 'connection_failed']);

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wraps a trusted retriever so each host is called no faster than its interval, and a
 * refused or failed request is retried once after the host's backoff. */
export function pacedRetriever(base, { intervals = HOST_INTERVALS, retryDelays = RETRY_DELAYS, sleep = realSleep, now = () => Date.now(), log = () => {} } = {}) {
  need(typeof base?.observe === 'function', 'invalid_retriever');
  const last = new Map();
  async function slot(host) {
    const wait = (last.get(host) ?? -Infinity) + (intervals[host] ?? 0) - now();
    if (wait > 0) await sleep(wait);
    last.set(host, now());
  }
  return Object.freeze({
    async observe(url, options) {
      const host = new URL(url).hostname;
      await slot(host);
      try {
        return await base.observe(url, options);
      } catch (error) {
        if (!RETRYABLE.has(error?.code)) throw error;
        log(`  retry ${host} after ${error.code} in ${retryDelays[host] ?? 0} ms`);
        await sleep(retryDelays[host] ?? 0);
        await slot(host);
        return base.observe(url, options);
      }
    },
  });
}

/** One project's draft from the pinned catalogue row and the search step. */
export async function draftProject({ project, row, revision, search, clock = () => Date.now(), sources }) {
  need(row && row.id === project.id, 'selected_source_missing');
  need(sourceDigestOf(row, revision) === project.sourceDigest, 'selected_source_changed', `${project.id} catalogue source does not reproduce its pin`);
  const task = { title: row.title, criteria: row.description };
  const queries = deriveQueries(task).map((terms) => terms.join(' '));
  const collected = await search.run({ projectId: project.id, task });
  const criteriaDigest = sha256(row.description);
  need(collected.subject.criteriaDigest === criteriaDigest, 'draft_subject_mismatch');
  const searchesDigest = searchesDigestOf({ project: project.id, criteriaDigest, searches: collected.searches, retrievals: collected.retrievals });
  if (collected.status === 'assessment_required') need(collected.pendingId === searchesDigest, 'draft_digest_mismatch');
  const draft = {
    schema: BOOTSTRAP_DRAFT_SCHEMA,
    status: collected.status,
    project: project.id,
    native_project: project.nativeProjectId,
    source_digest: project.sourceDigest,
    source_revision: revision,
    title: row.title,
    producer: { kind: 'trusted_search', id: PRIOR_ART_PRODUCER_ID, drafter: BOOTSTRAP_DRAFTER_ID, sources: [...sources], criteriaDigest },
    drafted_at: new Date(clock()).toISOString(),
    queries,
    searches: collected.searches,
    retrievals: collected.retrievals,
    failures: collected.failures,
    searches_digest: searchesDigest,
    class: null,
    assessment: null,
    note: DRAFT_NOTE,
  };
  return validateDraft(draft);
}

function existingDraft(path, project) {
  try {
    const draft = validateDraft(JSON.parse(readFileSync(path, 'utf8')));
    return draft.source_digest === project.sourceDigest ? draft : null;
  } catch {
    return null;
  }
}

function writeAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, path);
}

/** Drafts every selected project not already drafted; returns per-project outcomes. */
export async function runDrafter({ selection, catalogue, search, out, sources, only = null, limit = Infinity, clock, log = () => {} }) {
  mkdirSync(out, { recursive: true });
  const outcomes = [];
  let ran = 0;
  for (const project of selection.projects) {
    if (only && !only.includes(project.id)) continue;
    const path = join(out, `${project.id}.json`);
    const prior = existingDraft(path, project);
    if (prior?.status === 'assessment_required') {
      outcomes.push({ id: project.id, outcome: 'skipped', status: prior.status });
      continue;
    }
    if (ran >= limit) break;
    ran += 1;
    try {
      const draft = await draftProject({ project, row: catalogue.records.get(project.id), revision: catalogue.revision, search, clock, sources });
      writeAtomic(path, draft);
      outcomes.push({ id: project.id, outcome: 'drafted', status: draft.status });
      log(`${project.id} ${draft.status} searches=${draft.searches.length} failures=${draft.failures.map((f) => `${f.source}:${f.code}`).join(',') || 'none'}`);
    } catch (error) {
      if (!(error instanceof OrganizationError)) throw error;
      outcomes.push({ id: project.id, outcome: 'refused', code: error.code });
      log(`${project.id} refused ${error.code}`);
    }
  }
  return outcomes;
}

/** Counts over the draft files in a directory. */
export function summarizeDrafts(out) {
  const summary = { drafts: 0, assessment_required: 0, insufficient_searches: 0, searches: 0, failuresBySource: {}, failuresByCode: {}, successBySource: {} };
  for (const name of readdirSync(out).filter((n) => /^OPP-[0-9]{5}\.json$/.test(n)).sort()) {
    const draft = validateDraft(JSON.parse(readFileSync(join(out, name), 'utf8')));
    summary.drafts += 1;
    summary[draft.status] += 1;
    summary.searches += draft.searches.length;
    for (const r of draft.retrievals) summary.successBySource[r.source] = (summary.successBySource[r.source] ?? 0) + 1;
    for (const f of draft.failures) {
      summary.failuresBySource[f.source] = (summary.failuresBySource[f.source] ?? 0) + 1;
      summary.failuresByCode[`${f.source}:${f.code}`] = (summary.failuresByCode[`${f.source}:${f.code}`] ?? 0) + 1;
    }
  }
  return summary;
}

function args(argv) {
  const o = { out: DEFAULT_OUT, sources: [...DEFAULT_SOURCES], only: null, limit: Infinity, summary: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--summary') o.summary = true;
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--only') o.only = argv[++i].split(',');
    else if (a === '--limit') o.limit = Number(argv[++i]);
    else if (a === '--sources') o.sources = argv[++i].split(',');
    else throw new OrganizationError('invalid_arguments', `unknown argument ${a}`);
  }
  need(o.sources.every((s) => Object.hasOwn(PRIOR_ART_SOURCES, s)), 'source_not_allowed');
  need(o.limit === Infinity || (Number.isSafeInteger(o.limit) && o.limit > 0), 'invalid_arguments', 'limit');
  return o;
}

async function main() {
  const o = args(process.argv.slice(2));
  if (!o.summary) {
    const catalogue = catalogueRecords(await loadCatalogue(CATALOGUE_DIR));
    // Refuses unless every selected row reproduces its pinned source digest.
    const selection = await loadSelection({ current: catalogue });
    const log = (line) => console.log(`[${new Date().toISOString()}] ${line}`);
    // The same trusted pinned retriever createPriorArtSearch builds by default, wrapped for pacing.
    const base = createRetriever({ allowedHosts: [...PRIOR_ART_HOSTS], maxBytes: 2 * 1024 * 1024, timeoutMs: 20000,
      headers: { accept: 'application/json, application/atom+xml;q=0.9' } });
    const paced = createPriorArtSearch({ sources: o.sources, retriever: pacedRetriever(base, { log }) });
    const outcomes = await runDrafter({ selection, catalogue, search: paced, out: o.out, sources: o.sources, only: o.only, limit: o.limit, log });
    const tally = {};
    for (const x of outcomes) {
      const key = `${x.outcome}:${x.status ?? x.code}`;
      tally[key] = (tally[key] ?? 0) + 1;
    }
    log(`run outcomes ${JSON.stringify(tally)}`);
  }
  console.log(JSON.stringify(summarizeDrafts(o.out), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof OrganizationError ? `refused: ${error.code} ${error.message}` : error);
    process.exit(1);
  });
}

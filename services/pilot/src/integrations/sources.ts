/**
 * Checking that the sources an answer cites exist.
 *
 * Research agents invent citations: a trial number that was never
 * registered, a DOI nobody minted. A verifier then spends a whole run finding
 * that out. These checks ask the registry itself, before anyone else looks.
 *
 * Only a clear "does not exist" counts against an answer: the registry says
 * not found, or a web address's domain does not exist. A login wall, a block,
 * a timeout or a server error proves nothing about the source, so those are
 * recorded as unchecked and the answer goes through.
 *
 * A check this process had no capacity to run is "busy" (P2-1, 13 November
 * 2026): that says nothing about the source either, but it is the caller's
 * load, not the source's, so callers refuse it and ask for a retry rather
 * than let it through as unchecked.
 */
import { fetchPublicSource, resolveSourceHost, SourceFetchError, sourceTransport } from './source-http.ts';
import type { SourcePool, SourceResolver, SourceTransport, SourceResponse } from './source-http.ts';

export interface SourceCheck { source: string; status: 'found' | 'missing' | 'unchecked' | 'busy'; detail: string; published?: string; after_cutoff?: boolean; blocked?: boolean; reason?: string }
export interface SourceIdentifier { kind: 'nct' | 'doi' | 'pmid' | 'url'; id: string }
interface RegistryDate { 'date-parts'?: number[][] }
interface CrossrefBody { message?: { 'published-print'?: RegistryDate; 'published-online'?: RegistryDate; issued?: RegistryDate } }
interface PubmedBody { result?: Record<string, { error?: unknown; sortpubdate?: unknown }>; esummaryresult?: unknown }

const TIMEOUT_MS = Number(process.env.UAIN_SOURCE_TIMEOUT_MS ?? 8000);
const MAX_SOURCES = 100;

let fetcher: SourceTransport = sourceTransport;
let resolver: SourceResolver = resolveSourceHost;
/** Test hooks: tests must never touch the real registries. */
export function setSourceFetcher(fn: SourceTransport | null): void {
  fetcher = fn ?? sourceTransport;
}
export function setSourceResolver(fn: SourceResolver | null): void {
  resolver = fn ?? resolveSourceHost;
}

/** What kind of identifier a source is, or null if it is free text. */
export function sourceKind(raw: unknown): SourceIdentifier | null {
  const s = String(raw ?? '').trim();
  if (/^NCT\d{8}$/i.test(s)) return { kind: 'nct', id: s.toUpperCase() };
  const doi = s.match(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/\S+)$/i);
  if (doi) return { kind: 'doi', id: doi[1] };
  const pmid = s.match(/^(?:PMID:?\s*)(\d{1,9})$/i);
  if (pmid) return { kind: 'pmid', id: pmid[1] };
  if (/^https?:\/\//i.test(s)) {
    try {
      return { kind: 'url', id: new URL(s).href };
    } catch {
      return null;
    }
  }
  return null;
}

/** Registry lookups use their own pool, so slow web addresses cannot starve them. */
async function get(url: string, readBody: boolean = false, pool: SourcePool = 'open', signal?: AbortSignal): Promise<SourceResponse> {
  return fetchPublicSource(url, { transport: fetcher, resolver, timeoutMs: TIMEOUT_MS, readBody, pool, signal });
}

const found = (source: string, detail: string): SourceCheck => ({ source, status: 'found', detail });

/**
 * Add a source's publication date, and whether it falls after the project's
 * evidence cutoff. Marked, never refused: a checker decides what it means.
 */
function dated(check: SourceCheck, published: string | null, cutoff: string | null): SourceCheck {
  if (!published) return check;
  const out: SourceCheck = { ...check, published };
  if (cutoff && published > cutoff) {
    out.after_cutoff = true;
    out.detail += `, published ${published}, after the project's evidence cutoff (${cutoff})`;
  }
  return out;
}
const missing = (source: string, detail: string): SourceCheck => ({ source, status: 'missing', detail });
const unchecked = (source: string, detail: string): SourceCheck => ({ source, status: 'unchecked', detail });

/** A Crossref publication date for a DOI, as YYYY-MM-DD, or null. */
async function doiDate(doi: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const r = await get(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, true, 'registry', signal);
    if (!r.ok) return null;
    const m = (await r.json() as CrossrefBody | null)?.message;
    const parts = (m?.['published-print'] ?? m?.['published-online'] ?? m?.issued)?.[
      'date-parts'
    ]?.[0];
    if (!parts?.[0]) return null;
    const [y, mo = 1, d = 1] = parts;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  } catch {
    return null;
  }
}

async function checkOne(source: string, cutoff: string | null, signal?: AbortSignal): Promise<SourceCheck> {
  const k = sourceKind(source);
  if (!k) return unchecked(source, 'not an identifier the network can look up');
  try {
    if (k.kind === 'nct') {
      const r = await get(`https://clinicaltrials.gov/api/v2/studies/${k.id}?fields=NCTId`, false, 'registry', signal);
      if (r.ok) return found(source, 'registered on ClinicalTrials.gov');
      if (r.status === 404) return missing(source, 'ClinicalTrials.gov has no study with this number');
      return unchecked(source, `ClinicalTrials.gov answered ${r.status}`);
    }
    if (k.kind === 'doi') {
      const r = await get(`https://doi.org/api/handles/${encodeURIComponent(k.id)}`, false, 'registry', signal);
      if (r.ok)
        return dated(
          found(source, 'a registered DOI'),
          cutoff ? await doiDate(k.id, signal) : null,
          cutoff,
        );
      if (r.status === 404) return missing(source, 'doi.org has no such DOI');
      return unchecked(source, `doi.org answered ${r.status}`);
    }
    if (k.kind === 'pmid') {
      const r = await get(
        `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${k.id}`,
        true,
        'registry',
        signal,
      );
      if (!r.ok) return unchecked(source, `PubMed answered ${r.status}`);
      const body = await r.json() as PubmedBody | null;
      const doc = body?.result?.[k.id];
      if (doc && !doc.error) {
        const d = String(doc.sortpubdate ?? '').match(/^(\d{4})\/(\d{2})\/(\d{2})/);
        return dated(
          found(source, 'in PubMed'),
          d ? `${d[1]}-${d[2]}-${d[3]}` : null,
          cutoff,
        );
      }
      if (doc?.error || body?.esummaryresult)
        return missing(source, 'PubMed has no article with this ID');
      return unchecked(source, 'PubMed gave no clear answer');
    }
    // A web address: only a domain that does not exist, or a page the server
    // says is gone (404, 410), is clearly missing.
    const host = new URL(k.id).hostname;
    const r = await get(k.id, false, 'open', signal);
    if (r.status === 404 || r.status === 410)
      return missing(source, `${host} says the page does not exist (${r.status})`);
    if (r.ok) return found(source, `${host} answered ${r.status}`);
    return unchecked(source, `${host} answered ${r.status}`);
  } catch (error) {
    const e = (error && typeof error === 'object' ? error : {}) as Partial<NodeJS.ErrnoException> & { source_missing?: boolean };
    if (e?.code === 'UNSAFE_SOURCE_URL')
      return { ...unchecked(source, 'blocked by public-source fetch policy'), blocked: true, reason: 'unsafe_destination' };
    if (e?.code === 'SOURCE_BUSY')
      return { source, status: 'busy', detail: 'the network is checking too many sources right now; try again shortly' };
    if (k.kind === 'url' && e?.source_missing)
      return missing(source, 'the source domain does not exist');
    return unchecked(
      source,
      e?.name === 'AbortError' || e?.code === 'SOURCE_TIMEOUT' ? 'timed out' :
        e?.code?.startsWith('SOURCE_') ? (e.message ?? 'could not check source') : 'could not check source',
    );
  }
}

/** True when any check could not run for lack of capacity: refuse and ask for a retry. */
export function anySourceBusy(checks: ReadonlyArray<SourceCheck | null | undefined>): boolean {
  return checks.some((c) => c?.status === 'busy');
}
export const SOURCE_CHECK_BUSY = 'The network is checking too many sources right now, so these could not be looked up. Nothing was recorded. Try again in a minute.';

/** Check every source, a few at a time. With a cutoff, dates are read too. */
/**
 * How long one call may spend checking (review follow-up, 13 November 2026):
 * well inside the MCP answer deadline (api/mcp-hub.ts), so a tool never goes
 * on to record a submission after its caller was told no answer will come.
 * What is still unchecked when it runs out is "busy", which callers refuse as
 * retryable.
 */
const CHECK_TOTAL_MS = Number(process.env.UAIN_SOURCE_CHECK_TOTAL_MS) > 0 ? Number(process.env.UAIN_SOURCE_CHECK_TOTAL_MS) : 240_000;
/** Checks of one call at once, and of those, web addresses at once: one call's
 * slow addresses hold at most 4 places (slots and queue) in the shared pool. */
const CALL_CONCURRENCY = 8;
const CALL_OPEN_PLACES = 4;
const outOfTime = (source: string): SourceCheck =>
  ({ source, status: 'busy', detail: 'the network could not finish checking the sources in time; try again shortly' });

/** Check every source, a few at a time. With a cutoff, dates are read too. */
export async function checkSources(sources: readonly unknown[] = [], { cutoff = null, totalMs = CHECK_TOTAL_MS }: { cutoff?: string | null; totalMs?: number } = {}): Promise<SourceCheck[]> {
  const list = [...new Set(sources.map((s) => String(s).trim()).filter(Boolean))].slice(
    0,
    MAX_SOURCES,
  );
  const out: SourceCheck[] = new Array(list.length);
  const bound = new AbortController();
  const timer = setTimeout(() => bound.abort(new SourceFetchError('SOURCE_BUSY', 'source check time bound reached')), totalMs);
  let next = 0, openInUse = 0;
  const openWaiters: Array<() => void> = [];
  const openPlace = async () => {
    while (openInUse >= CALL_OPEN_PLACES) await new Promise<void>((resolve) => openWaiters.push(resolve));
    openInUse++;
  };
  const freePlace = () => { openInUse--; openWaiters.shift()?.(); };
  const worker = async () => {
    while (next < list.length) {
      const i = next++, source = list[i];
      if (bound.signal.aborted) { out[i] = outOfTime(source); continue; }
      const web = sourceKind(source)?.kind === 'url';
      if (web) await openPlace();
      try {
        out[i] = bound.signal.aborted ? outOfTime(source) : await checkOne(source, cutoff, bound.signal);
        if (bound.signal.aborted && out[i].status !== 'found' && out[i].status !== 'missing') out[i] = outOfTime(source);
      } finally { if (web) freePlace(); }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(CALL_CONCURRENCY, list.length) }, worker));
  } finally { clearTimeout(timer); }
  return out;
}

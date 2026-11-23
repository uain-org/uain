import { parseStrictJSON } from '../../project-organizations/src/common.mjs';
import { createPinnedFetch } from '../../project-organizations/src/pinned-fetch.mjs';
import { surveyResolution } from '../../project-organizations/src/survey-sources.mjs';
import { normalizeId, readRecord } from '../../project-organizations/verifiers/single-claim.mjs';

const paperKinds = new Set(['doi', 'arxiv', 'pubmed']);
const pubmedHost = 'eutils.ncbi.nlm.nih.gov';
const maxPromptBytes = 24000;
const normalizeText = (text) => text.replace(/<[^>]{0,200}>/g, '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const evidenceRecord = ({ kind, id }) => `${kind}:${id}`;

export function createPaperRetriever() {
  const fetch = createPinnedFetch({
    allowedHosts: ['api.crossref.org', 'export.arxiv.org', pubmedHost],
    maxBytes: 512 * 1024,
    timeoutMs: 5000,
  });
  return {
    async observe(url, { signal }) {
      const response = await fetch(url, { signal, headers: { 'user-agent': 'uain-research-review/1 (+https://uain.global)' } });
      return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
    },
  };
}

function paperCitations(evidence) {
  let artifact;
  try {
    artifact = parseStrictJSON(evidence);
  } catch {
    return [];
  }
  const records = [
    ...(Array.isArray(artifact?.survey?.items) ? artifact.survey.items.filter((item) => item?.relation !== 'screened_out') : []),
    artifact?.check?.record,
  ];
  const papers = new Map();
  for (const record of records) {
    if (!paperKinds.has(record?.kind)) continue;
    const id = normalizeId(record.kind, record.id);
    if (id === null) continue;
    const paper = { kind: record.kind, id };
    papers.set(evidenceRecord(paper), paper);
  }
  return [...papers.values()];
}

function pubmedAbstract(id, bytes) {
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  // EFetch includes a DOCTYPE. Read only the matching citation's primary abstract as
  // text and never interpret XML entities or resolve external declarations.
  const citation = /<MedlineCitation\b[^>]*>([\s\S]*?)<\/MedlineCitation>/.exec(xml)?.[1];
  if (/<PMID\b[^>]*>(\d+)<\/PMID>/.exec(citation ?? '')?.[1] !== id) return '';
  const abstract = /<Abstract>([\s\S]*?)<\/Abstract>/.exec(citation)?.[1] ?? '';
  return [...abstract.matchAll(/<AbstractText\b[^>]*>([\s\S]*?)<\/AbstractText>/g)]
    .map((match) => match[1]).join(' ');
}

async function paperText({ kind, id }, retriever, signal) {
  const url = kind === 'pubmed'
    ? `https://${pubmedHost}/entrez/eutils/efetch.fcgi?db=pubmed&retmode=xml&id=${id}`
    : surveyResolution(kind, id).url;
  const { status, bytes } = await retriever.observe(url, { signal });
  if (status !== 200) return '';
  if (kind === 'pubmed') return normalizeText(pubmedAbstract(id, bytes));
  const { text, titles } = readRecord(kind, id, { kind, id, status, body: bytes });
  // The shared parser prefixes the record's title(s). Only the abstract is evidence here.
  return text ? normalizeText(text.slice(titles.join('\n').length + 1)) : '';
}

export function requestPaperEvidence(papers, detail) {
  const citations = papers.slice(0, 12).map(evidenceRecord).join(', ');
  const remainder = papers.length > 12 ? ` and ${papers.length - 12} more` : '';
  return {
    verdict: 'needs_evidence',
    findings: [`${detail} (${citations}${remainder}). Supply an independently accessible paper and identify the methods or results passage that supports the claim, or revise the claim to match the evidence.`],
  };
}

export async function retrievePaperEvidence(evidence, retriever, signal) {
  const papers = paperCitations(evidence);
  const sources = [];
  const missing = [];
  const deadline = AbortSignal.timeout(15000);
  const readSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  // Reserve array punctuation and give each remaining citation a share of the
  // serialized context. Short abstracts leave their unused bytes for later papers.
  let remaining = maxPromptBytes - 2 - Math.max(0, papers.length - 1);
  for (const [index, paper] of papers.entries()) {
    let text = '';
    if (!readSignal.aborted && remaining > 0) {
      try {
        text = (await paperText(paper, retriever, readSignal)).slice(0, 6000);
      } catch {
        // An unreadable record cannot support an acceptance.
      }
    }
    signal?.throwIfAborted();
    const share = Math.floor(remaining / (papers.length - index));
    const overhead = Buffer.byteLength(JSON.stringify({ ...paper, text: '' }));
    let bytes = overhead;
    let excerpt = '';
    for (const character of text) {
      const cost = Buffer.byteLength(JSON.stringify(character)) - 2;
      if (bytes + cost > share) break;
      excerpt += character;
      bytes += cost;
    }
    if (excerpt.trim().length < 20) {
      missing.push(paper);
    } else {
      sources.push({ ...paper, text: excerpt.trimEnd() });
      remaining -= bytes;
    }
  }
  return { sources, missing };
}

export function checkPaperApproval(answer, sources) {
  const { verdict, findings, paper_checks: checks } = answer;
  if (verdict === 'accept' && sources.length) {
    const unsupported = sources.filter((paper) => !Array.isArray(checks) || !checks.some((check) => {
      const { kind, id, quote } = check ?? {};
      if (kind !== paper.kind || id !== paper.id || typeof quote !== 'string' || quote.length > 600) return false;
      const passage = normalizeText(quote);
      return passage.length >= 20 && paper.text.includes(passage);
    }));
    if (unsupported.length) return requestPaperEvidence(unsupported, 'The review could not verify a supporting passage in the retrieved paper text');
  }
  return { verdict, findings };
}

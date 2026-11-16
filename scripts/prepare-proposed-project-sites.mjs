/** Offline qualification only. No networking, admission, accounts or collection. */
import { open, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const fields = [
  'ID',
  'List',
  'Domain #',
  'Domain',
  'Sub-domain #',
  'Sub-domain',
  'Item',
  'Ambitious KPI (readable)',
  'KPI number',
  'KPI unit / what is counted',
];
const idPattern = /^(OPP|PRB)-(?!00000)[0-9]{5}$/;
function requireValue(ok, field) {
  if (!ok) throw new Error(`Invalid proposed-site input: ${field}`);
}
function exactKeys(value, keys, field) {
  requireValue(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    field,
  );
  requireValue(
    Object.keys(value).length === keys.length &&
      keys.every((k) => Object.hasOwn(value, k)),
    field,
  );
}
const text = (value) =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= 10000 &&
  !value.includes('\0');

export function preparePilot(
  records,
  { sourceRevision, sourceSha256, selectedIds } = {},
) {
  requireValue(
    typeof sourceRevision === 'string' && /^[a-f0-9]{40}$/.test(sourceRevision),
    'source revision',
  );
  requireValue(
    typeof sourceSha256 === 'string' && /^[a-f0-9]{64}$/.test(sourceSha256),
    'workbook hash',
  );
  requireValue(
    Array.isArray(records) && records.length >= 1 && records.length <= 3,
    '1–3 records',
  );
  requireValue(
    Array.isArray(selectedIds) &&
      selectedIds.length === records.length &&
      selectedIds.every((id) => typeof id === 'string' && idPattern.test(id)) &&
      new Set(selectedIds).size === selectedIds.length,
    'explicit selected IDs',
  );
  const seen = new Set();
  const sites = records.map((record) => {
    exactKeys(
      record,
      [
        'stable_id',
        'title',
        'url',
        'status',
        'progress',
        'source_fields',
        'provenance',
      ],
      'record fields',
    );
    const id = record.stable_id;
    requireValue(
      typeof id === 'string' &&
        idPattern.test(id) &&
        selectedIds.includes(id) &&
        !seen.has(id),
      'record identity',
    );
    seen.add(id);
    requireValue(record.status === 'proposed', 'proposed status');
    exactKeys(record.progress, ['status', 'percent_complete'], 'progress');
    requireValue(
      record.progress.status === 'unknown' &&
        record.progress.percent_complete === null,
      'unknown progress',
    );
    exactKeys(
      record.provenance,
      ['source_sha256', 'sheet', 'row'],
      'provenance',
    );
    requireValue(
      record.provenance.source_sha256 === sourceSha256 &&
        record.provenance.sheet === 'All items' &&
        Number.isSafeInteger(record.provenance.row) &&
        record.provenance.row >= 2,
      'source provenance',
    );
    exactKeys(record.source_fields, fields, 'ten source fields');
    const f = record.source_fields;
    for (const field of fields.filter(
      (k) => !['Domain #', 'KPI number'].includes(k),
    ))
      requireValue(text(f[field]), field);
    requireValue(
      f.ID === id && f.Item === record.title && text(record.title),
      'source identity and title',
    );
    requireValue(
      f.List === (id.startsWith('OPP-') ? 'Opportunity' : 'Problem to solve'),
      'source list',
    );
    requireValue(
      Number.isSafeInteger(f['Domain #']) && f['Domain #'] > 0,
      'domain number',
    );
    requireValue(
      new RegExp(`^${f['Domain #']}\\.[1-9][0-9]*$`).test(f['Sub-domain #']),
      'subdomain',
    );
    const number = f['KPI number'];
    requireValue(
      typeof number === 'number' &&
        Number.isFinite(number) &&
        number >= 0 &&
        (!Number.isInteger(number) || Number.isSafeInteger(number)),
      'KPI number',
    );
    const prefix = `/PR/${id}-`;
    requireValue(
      typeof record.url === 'string' &&
        record.url.startsWith(prefix) &&
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.url.slice(prefix.length)) &&
        record.url.slice(prefix.length).length <= 100,
      'source candidate path',
    );
    return {
      stable_id: id,
      candidate_path: record.url,
      publication: { status: 'offline_draft', indexing: 'noindex' },
      uain_admission: 'not_evaluated',
      organisation: {
        status: 'proposed_unverified',
        legal_entity: null,
        responsible_operator: null,
        beneficiary: null,
      },
      fundraising: {
        status: 'disabled_pending_governance',
        collection_by_uain: 'not_authorized',
      },
      source_record: structuredClone(record),
    };
  });
  // Selection order is caller-explicit; catalogue order is not an admission ranking.
  sites.sort(
    (a, b) =>
      selectedIds.indexOf(a.stable_id) - selectedIds.indexOf(b.stable_id),
  );
  return {
    schema: 'uain/proposed-project-site-pilot/v1',
    source: {
      repository: 'nuah-org/uain-project-incubator',
      revision: sourceRevision,
      workbook_sha256: sourceSha256,
    },
    sites,
  };
}
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
export function renderPilot(pilot) {
  const sites = pilot.sites
    .map((site) => {
      const r = site.source_record;
      return `<article><h2>${escape(site.stable_id)} — ${escape(r.title)}</h2>
<p><strong>Proposed project — offline draft.</strong> UAIN admission not evaluated. Organisation registration is unverified.</p>
<p>Candidate path: <code>${escape(site.candidate_path)}</code>. This route is not published by this pilot.</p>
<p>Organisation, accountable operator and beneficiary: unverified. <strong>Fundraising disabled.</strong> UAIN collection is not authorized.</p>
<p><strong>KPI target, unverified:</strong> ${escape(r.source_fields['Ambitious KPI (readable)'])}. Progress: unknown. No crew launched.</p>
<dl>${fields.map((key) => `<dt>${escape(key)}</dt><dd>${escape(r.source_fields[key])}</dd>`).join('')}</dl>
<p>Source: All items, row ${escape(r.provenance.row)}; SHA256 <code>${escape(r.provenance.source_sha256)}</code>.</p></article>`;
    })
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Proposed project-site pilot — offline</title><style>body{font:17px/1.6 system-ui;max-width:1000px;margin:40px auto;padding:0 24px;color:#162335}article{border-top:1px solid #ccd3dc;padding:24px 0}dt{font-weight:600}dd{margin:0 0 12px}code,dd,h2{overflow-wrap:anywhere}</style></head><body><h1>Proposed project-site pilot</h1><p>Read-only local qualification. These are source proposals and targets, not active organisations, admissions or achieved outcomes. No payment, collection or launch functions exist.</p><p>Source revision: <code>${escape(pilot.source.revision)}</code>. Provenance recorded, not independently attested.</p>${sites}</body></html>`;
}

async function main() {
  const [input, output, sourceRevision, sourceSha256, ...selectedIds] =
    process.argv.slice(2);
  requireValue(
    input && output && selectedIds.length,
    'usage: input.json new-output-dir source-revision workbook-sha256 ID [ID ID]',
  );
  // Bound bytes actually read as well as the opened file's initial size.
  const maxBytes = 2 * 1024 * 1024;
  const handle = await open(input, 'r');
  let bytes;
  try {
    const info = await handle.stat();
    requireValue(
      info.isFile() && info.size <= maxBytes,
      'regular input file, at most 2 MiB',
    );
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (!bytesRead) break;
      offset += bytesRead;
      requireValue(offset <= maxBytes, 'input size');
    }
    bytes = buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
  const pilot = preparePilot(JSON.parse(bytes.toString('utf8')), {
    sourceRevision,
    sourceSha256,
    selectedIds,
  });
  const html = renderPilot(pilot);
  // mkdir without recursive/exist_ok refuses an existing destination rather than overwriting it.
  await mkdir(output, { mode: 0o700 });
  await writeFile(
    join(output, 'pilot.json'),
    JSON.stringify(pilot, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  await writeFile(join(output, 'index.html'), html, {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(
    `Prepared ${pilot.sites.length} offline proposed project sites. Nothing published or activated.`,
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

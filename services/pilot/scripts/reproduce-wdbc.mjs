/** Fixed local reference method. Does not fetch or execute artifact commands. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { analyzeWdbc } from '../dist/src/evidence/wdbc-reference.js';
import { validateArtifactEvidence, artifactManifestDigest, validateReproductionReceipt } from '../dist/src/evidence/artifact-evidence.js';
if (process.versions.node !== '22.13.0') throw new Error('Reference recipe pins Node.js 22.13.0; run with that runtime');
const directory = new URL('../../../research/reference/wdbc/', import.meta.url);
const observation = analyzeWdbc(await readFile(new URL('wdbc.data', directory)));
const environment = 'Node.js 22.13.0; TypeScript 5.9.3 compilation; built-in fs/crypto; no network';
const artifacts = [{ label: 'uci-wdbc-data', manifest: {
  version: 1, uri: 'https://archive.ics.uci.edu/ml/machine-learning-databases/breast-cancer-wisconsin/wdbc.data',
  sha256: observation.sha256, bytes: observation.bytes, media_type: 'text/csv', license: 'CC-BY-4.0', role: 'dataset',
} }];
const reproduction = { version: 1, inputs: ['uci-wdbc-data'],
  command: 'node services/pilot/scripts/reproduce-wdbc.mjs', environment,
  outputs: Object.entries({ rows: 569, features: 30, malignant: 212, benign: 357 }).map(([metric, expected]) => ({ metric, expected, absolute_tolerance: 0 })),
};
const evidence = validateArtifactEvidence(artifacts, reproduction);
if (!evidence.ok) throw new Error(evidence.message);
const receipt = { version: 1, manifest_digest: artifactManifestDigest(evidence.artifacts, evidence.reproduction),
  outcome: 'reproduced', command: reproduction.command, environment,
  detail: 'Verified pinned bytes, unique row identifiers, 30 finite numeric cells per row, and recorded class counts. No prediction model or clinical finding.',
  inputs: [{ label: 'uci-wdbc-data', status: 'matched', observed_sha256: observation.sha256, observed_bytes: observation.bytes }],
  outputs: Object.entries(observation.metrics).map(([metric, observed]) => ({ metric, observed })),
};
const checked = validateReproductionReceipt(evidence.artifacts, evidence.reproduction, receipt, 'confirmed');
if (!checked.ok) throw new Error(checked.message);
const methods = [];
for (const path of ['services/pilot/src/evidence/wdbc-reference.ts', 'services/pilot/dist/src/evidence/wdbc-reference.js', 'services/pilot/scripts/reproduce-wdbc.mjs']) {
  const bytes = await readFile(new URL('../../../' + path, import.meta.url));
  methods.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const report = { version: 1, technical_reference_only: true, independent_review: false,
  source: { title: 'Breast Cancer Wisconsin (Diagnostic)', creators: ['William H. Wolberg', 'Olvi L. Mangasarian', 'W. Nick Street'],
    doi: '10.24432/C5DW2B', url: 'https://archive.ics.uci.edu/dataset/17/breast+cancer+wisconsin+diagnostic',
    license: 'CC-BY-4.0', license_url: 'https://creativecommons.org/licenses/by/4.0/', retrieved: '2026-09-29', modified_data: false },
  methods, artifacts: evidence.artifacts, reproduction: evidence.reproduction, receipt: checked.receipt,
};
await writeFile(new URL('reference-receipt.json', directory), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: 'passed', ...observation, independent_review: false }));

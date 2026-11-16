import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  preparePilot,
  renderPilot,
} from './prepare-proposed-project-sites.mjs';

// Synthetic fixture, not a production proposal or legal organisation.
const sha = 'a'.repeat(64),
  revision = 'b'.repeat(40);
const fixture = () => ({
  stable_id: 'OPP-00001',
  title: '<script>synthetic</script>',
  url: '/PR/OPP-00001-script-synthetic-script',
  status: 'proposed',
  progress: { status: 'unknown', percent_complete: null },
  source_fields: {
    ID: 'OPP-00001',
    List: 'Opportunity',
    'Domain #': 1,
    Domain: 'Synthetic domain',
    'Sub-domain #': '1.1',
    'Sub-domain': 'Synthetic subdomain',
    Item: '<script>synthetic</script>',
    'Ambitious KPI (readable)': '0.5 synthetic units',
    'KPI number': 0.5,
    'KPI unit / what is counted': 'synthetic units',
  },
  provenance: { source_sha256: sha, sheet: 'All items', row: 2 },
});
const options = () => ({
  sourceRevision: revision,
  sourceSha256: sha,
  selectedIds: ['OPP-00001'],
});
const prepare = (r = fixture(), o = options()) => preparePilot([r], o);

test('retains exact source fields and fractional target, with unknown progress and disabled finances', () => {
  const r = fixture(),
    before = structuredClone(r),
    p = prepare(r);
  assert.deepEqual(r, before);
  assert.deepEqual(p.sites[0].source_record, r);
  assert.equal(p.sites[0].source_record.source_fields['KPI number'], 0.5);
  assert.equal(p.sites[0].fundraising.collection_by_uain, 'not_authorized');
  assert.equal(p.sites[0].organisation.legal_entity, null);
  assert.equal(p.sites[0].uain_admission, 'not_evaluated');
  assert.equal(p.sites[0].publication.indexing, 'noindex');
});
test('explicit selection is bounded and cannot silently include unselected records', () => {
  for (const records of [[], Array(4).fill(fixture())])
    assert.throws(() => preparePilot(records, options()));
  assert.throws(() => prepare(fixture(), { ...options(), selectedIds: [] }));
  assert.throws(() =>
    prepare(fixture(), {
      ...options(),
      selectedIds: ['OPP-00001', 'OPP-00001'],
    }),
  );
  assert.throws(() =>
    prepare(fixture(), { ...options(), selectedIds: ['PRB-00001'] }),
  );
  assert.throws(() => preparePilot([fixture(), fixture()], options()));
});
for (const [label, change] of [
  [
    'missing revision',
    (r, o) => {
      o.sourceRevision = '';
    },
  ],
  [
    'wrong source hash',
    (r) => {
      r.provenance.source_sha256 = 'c'.repeat(64);
    },
  ],
  [
    'missing provenance',
    (r) => {
      delete r.provenance;
    },
  ],
  [
    'invalid source row',
    (r) => {
      r.provenance.row = 1;
    },
  ],
  [
    'wrong source sheet',
    (r) => {
      r.provenance.sheet = 'Problems';
    },
  ],
  [
    'mismatched source ID',
    (r) => {
      r.source_fields.ID = 'PRB-00001';
    },
  ],
  [
    'mismatched title',
    (r) => {
      r.title = 'Other title';
    },
  ],
  [
    'wrong list',
    (r) => {
      r.source_fields.List = 'Problem to solve';
    },
  ],
  [
    'invalid subdomain',
    (r) => {
      r.source_fields['Sub-domain #'] = '2.1';
    },
  ],
  [
    'extra source field',
    (r) => {
      r.source_fields.wallet = 'invented';
    },
  ],
  [
    'unsupported legal identity',
    (r) => {
      r.organisation = { registered: true };
    },
  ],
  [
    'active project',
    (r) => {
      r.status = 'active';
    },
  ],
  [
    'claimed progress',
    (r) => {
      r.progress.percent_complete = 100;
    },
  ],
  [
    'unsafe KPI integer',
    (r) => {
      r.source_fields['KPI number'] = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    'nonfinite KPI',
    (r) => {
      r.source_fields['KPI number'] = Infinity;
    },
  ],
  [
    'absolute URL',
    (r) => {
      r.url = 'https://example.com/PR/OPP-00001';
    },
  ],
  [
    'foreign record URL',
    (r) => {
      r.url = '/PR/PRB-00001-other';
    },
  ],
  [
    'path traversal',
    (r) => {
      r.url = '/PR/OPP-00001-../other';
    },
  ],
])
  test(`rejects ${String(label)}`, () => {
    const r = fixture(),
      o = options();
    change(r, o);
    assert.throws(() => prepare(r, o));
  });
test('three explicit records retain selection order and source units', () => {
  const records = ['OPP-00001', 'OPP-00002', 'PRB-00001'].map((id, index) => {
    const r = fixture();
    r.stable_id = id;
    r.source_fields.ID = id;
    r.source_fields.List = id.startsWith('OPP')
      ? 'Opportunity'
      : 'Problem to solve';
    r.url = `/PR/${id}-synthetic`;
    r.provenance.row = index + 2;
    return r;
  });
  const ids = ['PRB-00001', 'OPP-00002', 'OPP-00001'];
  const p = preparePilot(records, { ...options(), selectedIds: ids });
  assert.deepEqual(
    p.sites.map((s) => s.stable_id),
    ids,
  );
  assert(
    p.sites.every(
      (s) =>
        s.source_record.source_fields['KPI unit / what is counted'] ===
        'synthetic units',
    ),
  );
});
test('HTML escapes every source value and has no active content or collection action', () => {
  const html = renderPilot(prepare());
  assert(!html.includes('<script>'));
  assert(html.includes('&lt;script&gt;synthetic&lt;/script&gt;'));
  assert(html.includes('noindex,nofollow'));
  assert(html.includes("default-src 'none'"));
  assert(!/<(?:form|iframe|script)\b/.test(html));
  assert(html.includes('Organisation registration is unverified.'));
  assert(html.includes('Fundraising disabled'));
  assert(html.includes('KPI target'));
});
test('CLI creates only inert artefacts, refuses existing destination and invalid input without output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uain-sites-test-'));
  try {
    const input = join(root, 'records.json'),
      out = join(root, 'pilot');
    await writeFile(input, JSON.stringify([fixture()]));
    const args = [
      'scripts/prepare-proposed-project-sites.mjs',
      input,
      out,
      revision,
      sha,
      'OPP-00001',
    ];
    const run = () => spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(run().status, 0);
    assert.deepEqual((await readdir(out)).sort(), ['index.html', 'pilot.json']);
    assert.equal(
      JSON.parse(await readFile(join(out, 'pilot.json'), 'utf8')).sites.length,
      1,
    );
    assert.notEqual(run().status, 0);
    args[2] = join(root, 'invalid');
    await writeFile(
      input,
      JSON.stringify([{ ...fixture(), status: 'active' }]),
    );
    assert.notEqual(run().status, 0);
    assert(!(await readdir(root)).includes('invalid'));
    await writeFile(input, ' '.repeat(2 * 1024 * 1024 + 1));
    assert.notEqual(run().status, 0);
    assert(!(await readdir(root)).includes('invalid'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

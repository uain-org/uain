import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadCatalogue } from '../server/catalogue.mjs';
import { createProposalPages } from '../server/proposal-pages.mjs';

const origin = 'https://baink.money';
const firstPath =
  '/proposals/OPP-00001-reverse-the-biological-age-of-every-adult-by-20-years';
let catalogue;
before(async () => {
  catalogue = await loadCatalogue(
    fileURLToPath(new URL('../catalogue/', import.meta.url)),
  );
  assert.equal(catalogue.available, true);
});

function withDetail(change) {
  const detail = structuredClone(catalogue.detail('OPP-00001'));
  change(detail);
  return {
    available: true,
    detail: (id) => (id === 'OPP-00001' ? detail : null),
  };
}
const pagesFor = (provider = catalogue, host = origin) =>
  createProposalPages({ catalogue: provider, origin: host });

test('known OPP and PRB resolve exact validated proposal content without operational or financial authority', () => {
  const pages = pagesFor();
  const result = pages.resolve(firstPath);
  assert.equal(result.status, 200);
  const { model } = result;
  assert.equal(model.id, 'OPP-00001');
  assert.equal(
    model.title,
    'Reverse the biological age of every adult by 20 years',
  );
  assert.equal(model.kpi.threshold, 20);
  assert.equal(model.provenance.row, 2);
  assert.equal(
    model.source.repository,
    'https://github.com/nuah-org/uain-project-incubator',
  );
  assert.equal(model.status, 'inactive');
  assert.equal(model.operationalStatus, 'not_started');
  assert.equal(model.progress, null);
  assert.equal(model.fundingAvailable, false);
  assert.equal(model.crewAvailable, false);
  assert.equal(model.executionAvailable, false);
  assert.equal(model.canonicalUrl, origin + firstPath);
  assert.equal(model.jsonUrl, origin + firstPath + '?format=json');
  assert.equal(model.workspaceUrl, origin + '/?view=mine');
  assert.equal(model.document.schema, 'baink/proposal-document/v1');
  assert.equal(model.document.projection, 'inactive-source-proposal');
  assert.equal(model.document.nativeAdmission, false);
  for (const key of [
    'balance',
    'issuance',
    'redemption',
    'reward',
    'payments',
    'sourceDigest',
  ])
    assert.equal(Object.hasOwn(model.document, key), false);
  const problem = pages.resolve(
    '/proposals/PRB-00001-end-age-related-death-from-any-cause-before-100',
  );
  assert.equal(problem.status, 200);
  assert.equal(problem.model.kind, 'Problem to solve');
  assert.equal(problem.model.provenance.row, 26);
  assert.equal(problem.model.kpi.threshold, 40000000);
});

test('stable IDs redirect id-only and stale slugs to the current absolute canonical URL', () => {
  const pages = pagesFor();
  for (const path of ['/proposals/OPP-00001', '/proposals/OPP-00001-old-title'])
    assert.deepEqual(pages.resolve(path), {
      status: 308,
      location: origin + firstPath,
    });
  const renamed = pagesFor(
    withDetail(({ project }) => {
      project.title = 'New title';
    }),
  );
  assert.deepEqual(renamed.resolve(firstPath), {
    status: 308,
    location: origin + '/proposals/OPP-00001-new-title',
  });
  assert.equal(
    renamed.resolve('/proposals/OPP-00001-new-title').model.id,
    'OPP-00001',
  );
});

test('slug generation is ASCII, deterministic, bounded to 80 characters and has a safe fallback', () => {
  for (const [title, slug] of [
    ['  Café & CRÈME — science!  ', 'cafe-creme-science'],
    ['研究 🧪', 'proposal'],
    ['A'.repeat(1000), 'a'.repeat(80)],
    ['a'.repeat(79) + ' b', 'a'.repeat(79)],
  ]) {
    const pages = pagesFor(
      withDetail(({ project }) => {
        project.title = title;
      }),
    );
    assert.equal(
      pages.resolve('/proposals/OPP-00001').location,
      origin + '/proposals/OPP-00001-' + slug,
    );
    assert.equal(pages.resolve('/proposals/OPP-00001-' + slug).status, 200);
  }
});

test('malformed paths never access source data or redirect', () => {
  const pages = pagesFor({
    available: true,
    detail() {
      assert.fail('malformed route reached provider');
    },
  });
  for (const path of [
    '/',
    '/proposals',
    '/proposals/',
    '/baink/proposals/OPP-00001',
    '/proposals/opp-00001',
    '/proposals/OPP-0001',
    '/proposals/OPP-000001',
    '/proposals/OPP-00001-',
    '/proposals/OPP-00001-a--b',
    '/proposals/OPP-00001-A',
    '/proposals/OPP-00001/extra',
    '/proposals/OPP-00001-title/',
    '/proposals/OPP-00001?format=json',
    '/proposals/OPP-00001#x',
    '/proposals/OPP%2D00001',
    '/proposals/OPP-00001-%2f',
    '/proposals/OPP-00001-../x',
    '/proposals/OPP-00001-' + 'a'.repeat(81),
    '/proposals/OPP-00001-\n',
    '/proposals/OPP-00001\n',
    null,
    {},
  ])
    assert.equal(pages.resolve(path).status, 404, String(path));
});

test('unknown valid IDs are missing; unavailable, throwing and malformed providers fail closed', () => {
  assert.equal(pagesFor().resolve('/proposals/OPP-99999').status, 404);
  for (const provider of [
    null,
    {},
    { available: false },
    { available: true },
    {
      available: true,
      detail() {
        throw new Error('private provider failure');
      },
    },
    { available: true, detail: () => ({ project: {}, source: {} }) },
    { available: true, detail: () => Promise.resolve(null) },
  ])
    assert.deepEqual(pagesFor(provider).resolve('/proposals/OPP-00001'), {
      status: 503,
    });
});

test('only exact HTTP(S) origins can construct absolute links', () => {
  for (const value of [
    'https://baink.money/',
    'https://baink.money/path',
    'https://user:password@baink.money',
    'https://baink.money?x',
    'https://baink.money#x',
    'javascript:alert(1)',
    '//baink.money',
    'file:///x',
    '',
    ' https://baink.money',
    'https://baink.money\\@evil.test',
    null,
  ])
    assert.throws(() => pagesFor(catalogue, value), /origin/i, String(value));
  assert.equal(
    pagesFor(catalogue, 'http://localhost:8090').resolve(firstPath).model
      .canonicalUrl,
    'http://localhost:8090' + firstPath,
  );
});

test('document revision binds every emitted field including all KPI and source provenance', () => {
  const document = pagesFor().resolve(firstPath).model.document;
  assert.match(document.revision, /^[a-f0-9]{64}$/);
  const { revision, ...payload } = document;
  assert.equal(
    revision,
    createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  );
  for (const change of [
    ({ project }) => {
      project.kpi.threshold = 21;
    },
    ({ project }) => {
      project.kpi.unit = 'different target unit';
    },
    ({ project }) => {
      project.kpi.statement = 'Different source statement';
    },
    ({ project }) => {
      project.provenance.row = 3;
    },
    ({ source }) => {
      source.revision = 'a'.repeat(40);
    },
    ({ source }) => {
      source.integrity = 'schema-and-provenance-verified';
    },
    ({ source }) => {
      source.notice = 'Revised source qualification';
    },
  ]) {
    const changed = pagesFor(withDetail(change)).resolve(firstPath);
    assert.equal(changed.status, 200);
    assert.notEqual(changed.model.document.revision, revision);
  }
});

test('projection rejects invalid source identity, unsupported status and unbounded provider values', () => {
  for (const change of [
    ({ project }) => {
      project.id = 'PRB-00001';
    },
    ({ project }) => {
      project.status = 'active';
    },
    ({ project }) => {
      project.operationalStatus = 'running';
    },
    ({ project }) => {
      project.progress = 100;
    },
    ({ project }) => {
      project.title = 'x'.repeat(1001);
    },
    ({ project }) => {
      project.description = 'x'.repeat(2001);
    },
    ({ project }) => {
      project.kpi.threshold = Infinity;
    },
    ({ project }) => {
      project.kpi.comparator = '>=';
    },
    ({ project }) => {
      project.provenance.row = 0;
    },
    ({ project }) => {
      project.provenance.source_sha256 = 'a'.repeat(64);
    },
    ({ source }) => {
      source.repository = 'javascript:alert(1)';
    },
    ({ source }) => {
      source.status = 'unavailable';
    },
    ({ source }) => {
      source.validatedCount = 0;
    },
  ])
    assert.deepEqual(pagesFor(withDetail(change)).resolve(firstPath), {
      status: 503,
    });
});

test('page models snapshot validated fields, omit injected provider authority and cannot mutate catalogue', () => {
  const raw = structuredClone(catalogue.detail('OPP-00001'));
  raw.project.balance = 500;
  raw.source.secret = 'private';
  const pages = pagesFor({ available: true, detail: () => raw });
  const model = pages.resolve(firstPath).model;
  raw.project.kpi.threshold = 99;
  raw.source.revision = 'b'.repeat(40);
  assert.equal(model.kpi.threshold, 20);
  assert.equal(
    model.source.revision,
    '6ff9fe288d7a6820f04c2df52fe8c2836b4f99b2',
  );
  assert.equal(model.balance, undefined);
  assert.equal(model.document.balance, undefined);
  assert.equal(model.source.secret, undefined);
  assert.throws(() => {
    model.document.kpi.threshold = 99;
  }, TypeError);
});

test('list and detail decoration adds separate page/document links without changing URL or selection input', () => {
  const pages = pagesFor();
  for (const raw of [
    catalogue.list({ pageSize: 2 }),
    catalogue.detail('OPP-00001'),
  ]) {
    const before = JSON.stringify(raw);
    const result = pages.decorate(raw);
    assert.notEqual(result, raw);
    assert.equal(JSON.stringify(raw), before);
    const row = result.project ?? result.projects[0];
    assert.equal(row.url, null);
    assert.equal(row.pageUrl, origin + firstPath);
    assert.equal(row.documentUrl, origin + firstPath + '?format=json');
    assert.equal(
      Object.hasOwn(raw.project ?? raw.projects[0], 'pageUrl'),
      false,
    );
    assert.equal(
      raw.source,
      (raw.project ? catalogue.detail('OPP-00001') : catalogue.list()).source,
    );
  }
  assert.equal(pages.decorate(null), null);
  const native = {
    project: { id: 'native-id', title: 'Native', url: 'https://example.test/' },
  };
  assert.deepEqual(pages.decorate(native), native);
});

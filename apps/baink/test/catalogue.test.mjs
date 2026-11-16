import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadCatalogue } from '../server/catalogue.mjs';

const sourceSha =
  '4419baef812bde5e33718e5e6acc76e1d7dde6fc95574ba79cd0c66955feb5d2';
async function sourceFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'baink-catalogue-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const domains = Array.from({ length: 45 }, (_, i) => ({
    id: String(i + 1),
    name: `Domain ${i + 1}`,
    count: 480,
    file: `domain-${i + 1}.json`,
  }));
  const index = {
    schema: 'uain/inactive-project-catalogue/v1',
    count: 21600,
    domains,
    source: {
      repository: 'https://github.com/nuah-org/uain-project-incubator',
      revision: '6ff9fe288d7a6820f04c2df52fe8c2836b4f99b2',
      workbook_sha256: sourceSha,
    },
  };
  await writeFile(join(dir, 'inactive.json'), JSON.stringify(index));
  for (const domain of domains) {
    const rows = Array.from({ length: 480 }, (_, n) => {
      const position = (Number(domain.id) - 1) * 480 + n;
      const kind = n % 2 ? 'PRB' : 'OPP';
      const number = Math.floor(position / 2) + 1;
      const id = `${kind}-${String(number).padStart(5, '0')}`;
      const title = `${kind === 'OPP' ? 'Build' : 'Repair'} solution ${number}`;
      return {
        id,
        title,
        summary: `${domain.name} · Research`,
        kpi: `${number} verified outcomes`,
        status: 'inactive',
        progress: null,
        source_fields: {
          ID: id,
          List: kind === 'OPP' ? 'Opportunity' : 'Problem to solve',
          'Domain #': Number(domain.id),
          Domain: domain.name,
          Item: title,
          'KPI number': number,
          'KPI unit / what is counted': 'verified outcomes',
          'Ambitious KPI (readable)': `${number} verified outcomes`,
        },
        provenance: {
          source_sha256: sourceSha,
          sheet: 'All items',
          row: position + 2,
        },
        crew: {
          namespace: id,
          planned_slots: 100,
          assigned_agents: 0,
          connected: false,
        },
      };
    });
    await writeFile(join(dir, domain.file), JSON.stringify(rows));
  }
  return { dir, index };
}

test('validated catalogue exposes all 21600 unique inactive proposals with paging and exact provenance', async (t) => {
  const { dir } = await sourceFixture(t);
  const catalogue = await loadCatalogue(dir);
  assert.equal(catalogue.available, true);
  const first = catalogue.list({ page: 1, pageSize: 24 });
  assert.equal(first.total, 21600);
  assert.equal(first.catalogueTotal, 21600);
  assert.equal(first.domains.length, 45);
  assert.equal(first.projects.length, 24);
  const second = catalogue.list({ page: 2, pageSize: 24 });
  assert.equal(second.projects[0].id, 'OPP-00013');
  assert.equal(
    new Set([...first.projects, ...second.projects].map((p) => p.id)).size,
    48,
  );
  const detail = catalogue.detail('OPP-00001');
  assert.equal(detail.project.status, 'inactive');
  assert.equal(detail.project.operationalStatus, 'not_started');
  assert.equal(detail.project.kpi.threshold, 1);
  assert.equal(detail.project.kpi.unit, 'verified outcomes');
  assert.equal(detail.project.provenance.source_sha256, sourceSha);
  assert.equal(detail.project.provenance.row, 2);
  assert.equal(detail.project.ceoChat.available, false);
  assert.equal(detail.project.tasks.length, 0);
  assert.equal(detail.project.achievedWork.length, 0);
  assert.equal(detail.project.url, null);
  assert.equal(detail.project.balance, undefined);
  assert.equal(
    catalogue.list({ domain: '2', page: 1, pageSize: 1000 }).projects.length,
    100,
  );
  assert.equal(catalogue.list({ domain: 'Domain 2' }).total, 480);
  const search = catalogue.list({ q: 'Repair solution 241', domain: '2' });
  assert.equal(search.total, 1);
  assert.equal(search.projects[0].id, 'PRB-00241');
  assert.equal(catalogue.list({ q: 'No match exists' }).total, 0);
  assert.equal(catalogue.detail('OPP-99999'), null);
});

test('missing, partial and duplicate catalogues fail closed without advertising 21600 rows', async (t) => {
  assert.equal((await loadCatalogue(null)).available, false);
  assert.equal((await loadCatalogue('/no/such/catalogue')).available, false);
  const { dir, index } = await sourceFixture(t);
  const path = join(dir, 'domain-1.json'),
    rows = JSON.parse(await readFile(path, 'utf8'));
  rows[1].id = rows[0].id;
  await writeFile(path, JSON.stringify(rows));
  const invalid = await loadCatalogue(dir);
  assert.equal(invalid.available, false);
  assert.equal(invalid.list().total, 0);
  assert.equal(invalid.list().catalogueTotal, 0);
  await writeFile(
    join(dir, 'inactive.json'),
    JSON.stringify({ ...index, count: 21599 }),
  );
  assert.equal((await loadCatalogue(dir)).available, false);
});

test('a supplied integrity manifest rejects structurally valid altered proposal files', async (t) => {
  const { dir } = await sourceFixture(t);
  const files = [
    'inactive.json',
    ...Array.from({ length: 45 }, (_, i) => `domain-${i + 1}.json`),
  ];
  const hashes = {};
  for (const file of files)
    hashes[file] = createHash('sha256')
      .update(await readFile(join(dir, file)))
      .digest('hex');
  await writeFile(join(dir, 'checksums.json'), JSON.stringify(hashes));
  assert.equal((await loadCatalogue(dir)).available, true);
  const path = join(dir, 'domain-1.json'),
    data = JSON.parse(await readFile(path, 'utf8'));
  data[0].source_fields['KPI number'] = 999;
  await writeFile(path, JSON.stringify(data));
  assert.equal((await loadCatalogue(dir)).available, false);
});

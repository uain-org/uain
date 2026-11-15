import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('source catalogue preserves all proposals, target fields and inactive crews', () => {
  const data = JSON.parse(
    readFileSync(new URL('../public/projects/inactive.json', import.meta.url)),
  );
  data.projects = data.domains.flatMap((d) =>
    JSON.parse(
      readFileSync(new URL('../public/projects/' + d.file, import.meta.url)),
    ),
  );
  assert.equal(data.count, 21600);
  assert.equal(data.projects.length, 21600);
  assert.equal(new Set(data.projects.map((p) => p.id)).size, 21600);
  assert.equal(new Set(data.projects.map((p) => p.crew.namespace)).size, 21600);
  assert.match(data.source.workbook_sha256, /^[a-f0-9]{64}$/);
  assert.match(data.source.revision, /^[a-f0-9]{40}$/);
  for (const prefix of ['OPP', 'PRB'])
    assert.equal(
      data.projects.filter((p) => p.id.startsWith(prefix)).length,
      10800,
    );
  for (const p of data.projects) {
    assert.equal(p.status, 'inactive');
    assert.equal(p.title, p.source_fields.Item);
    assert.equal(p.kpi, p.source_fields['Ambitious KPI (readable)']);
    assert.equal(Object.keys(p.source_fields).length, 10);
    assert.ok(p.summary.length > 0);
    assert.equal(p.crew.planned_slots, 100);
    assert.equal(p.crew.assigned_agents, 0);
    assert.equal(p.crew.connected, false);
    assert.equal(p.progress, null);
  }
  assert.equal(
    data.crew_roles.reduce((n, r) => n + r.count, 0),
    100,
  );
});

test('published titles and KPI targets agree with the existing master topic projection', () => {
  const index = JSON.parse(
    readFileSync(new URL('../public/projects/inactive.json', import.meta.url)),
  );
  let checked = 0;
  for (const d of index.domains) {
    const projects = JSON.parse(
      readFileSync(new URL('../public/projects/' + d.file, import.meta.url)),
    );
    const topics = JSON.parse(
      readFileSync(
        new URL('../public/geo/topics/' + d.id + '.json', import.meta.url),
      ),
    );
    const prior = new Map(
      Object.values(topics)
        .flatMap((sub) => [...sub.prb, ...sub.opp])
        .map((row) => [row[0], row]),
    );
    for (const p of projects) {
      assert.deepEqual([p.id, p.title, p.kpi], prior.get(p.id));
      assert.equal(p.provenance.source_sha256, index.source.workbook_sha256);
      assert.equal(
        p.summary,
        p.source_fields.Domain + ' · ' + p.source_fields['Sub-domain'],
      );
      checked++;
    }
  }
  assert.equal(checked, 21600);
});

test('the served catalogue index carries no internal Slack link (cleanup P-7)', () => {
  for (const path of [
    '../public/projects/inactive.json',
    '../apps/baink/catalogue/inactive.json',
  ]) {
    const text = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /slack\.com/);
  }
});

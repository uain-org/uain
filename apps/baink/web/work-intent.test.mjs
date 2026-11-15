import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reviewWorkSource,
  createWorkSelectionIntent,
  selectionProject,
} from './work-intent.js';
const owner = 'uain1' + 'a'.repeat(40),
  other = 'uain1' + 'b'.repeat(40);
const source = () => ({
  source: {
    kind: 'proposals',
    projectId: 'OPP-00001',
    title: 'A source proposal',
    description: 'The published scope.',
    category: 'Research',
    status: 'inactive',
    sourceRevision: 'revision-one',
    sourceAuthority: 'source-proposals',
    sourceUrl: null,
    sourceAvailable: true,
    taskCount: 0,
  },
  sourceDigest: '1'.repeat(64),
});
test('reviewed work binds kind, ID and source digest without making a write', () => {
  const response = source();
  const reviewed = reviewWorkSource(response, {
    kind: 'proposals',
    projectId: 'OPP-00001',
  });
  response.source.title = 'Changed after review';
  assert.equal(reviewed.source.title, 'A source proposal');
  for (const change of [
    (r) => (r.source.kind = 'projects'),
    (r) => (r.source.projectId = 'OPP-00002'),
    (r) => (r.source.sourceAvailable = false),
    (r) => (r.sourceDigest = 'bad'),
  ]) {
    const invalid = source();
    change(invalid);
    assert.throws(() =>
      reviewWorkSource(invalid, { kind: 'proposals', projectId: 'OPP-00001' }),
    );
  }
});
test('a committed selection with a lost response reuses its reviewed intent; a changed source requires a new intent', async () => {
  const intent = createWorkSelectionIntent(owner),
    reviewed = reviewWorkSource(source(), {
      kind: 'proposals',
      projectId: 'OPP-00001',
    }),
    records = new Map();
  let lose = true;
  const send = async (body) => {
    if (!records.has(body.clientRequestId))
      records.set(body.clientRequestId, { id: 'saved-selection', ...body });
    if (lose) {
      lose = false;
      throw Error('response lost');
    }
    return { selection: records.get(body.clientRequestId) };
  };
  await assert.rejects(intent.prepare(reviewed).run(send), /response lost/);
  const recovered = await intent.prepare(reviewed).run(send);
  assert.equal(records.size, 1);
  assert.equal(recovered.selection.sourceDigest, '1'.repeat(64));
  const changed = source();
  changed.sourceDigest = '2'.repeat(64);
  changed.source.sourceRevision = 'revision-two';
  const next = await intent
    .prepare(
      reviewWorkSource(changed, { kind: 'proposals', projectId: 'OPP-00001' }),
    )
    .run(async (body) => body);
  assert.notEqual(next.clientRequestId, recovered.selection.clientRequestId);
});
test('saved selections are private-holder snapshots and never synthesize current source details', () => {
  const record = {
    id: 'saved',
    owner,
    kind: 'proposals',
    projectId: 'OPP-00001',
    sourceDigest: '1'.repeat(64),
    source: source().source,
    availability: 'selected',
    createdAt: '2026-10-31T12:00:00Z',
    claim: false,
    settlementAvailable: false,
  };
  const row = selectionProject(record, owner);
  assert.equal(row.title, 'A source proposal');
  assert.equal(row._storedSource, true);
  assert.equal(row._catalogue, 'proposals');
  assert.equal('tasks' in row, false);
  assert.equal('achievedWork' in row, false);
  row._selection.source.title = 'Client mutation';
  assert.equal(record.source.title, 'A source proposal');
  assert.throws(() => selectionProject(record, other));
  assert.throws(() => createWorkSelectionIntent('not-a-holder'));
});

test('late source, save and withdrawal callbacks cannot change another review or a reopened generation', async () => {
  const { createWorkReviewGate } = await import('./work-intent.js');
  const gate = createWorkReviewGate();
  let release,
    modal = { kind: 'proposals', projectId: 'A', source: 'A', closed: false };
  const a = gate.open({ kind: 'proposals', projectId: 'A' });
  const pending = new Promise((resolve) => (release = resolve)).then(() => {
    gate.apply(a, () => {
      modal.source = 'late A source';
    });
    gate.apply(a, () => {
      modal.selection = 'A selection';
    });
    gate.apply(a, () => {
      modal.closed = true;
    });
  });
  gate.close();
  gate.open({ kind: 'proposals', projectId: 'B' });
  modal = { kind: 'proposals', projectId: 'B', source: 'B', closed: false };
  release();
  await pending;
  assert.deepEqual(modal, {
    kind: 'proposals',
    projectId: 'B',
    source: 'B',
    closed: false,
  });
  const reopened = gate.open({ kind: 'proposals', projectId: 'A' });
  assert.equal(gate.isCurrent(a), false);
  assert.equal(gate.isCurrent(reopened), true);
});
test('a mismatched attached selection can never become the displayed project withdrawal target', async () => {
  const { selectionForProject } = await import('./work-intent.js');
  const a = {
      id: 'selection-a',
      owner,
      kind: 'proposals',
      projectId: 'A',
      availability: 'selected',
    },
    b = {
      id: 'selection-b',
      owner,
      kind: 'proposals',
      projectId: 'B',
      availability: 'selected',
    };
  assert.equal(
    selectionForProject({ id: 'B', _selection: a }, 'proposals', owner, []),
    undefined,
  );
  assert.equal(
    selectionForProject({ id: 'B', _selection: a }, 'proposals', owner, [b]).id,
    'selection-b',
  );
  assert.equal(
    selectionForProject({ id: 'B', _selection: b }, 'proposals', other, [b]),
    undefined,
  );
});

test('the marker index includes every active selection across at most four bounded private pages', async () => {
  const { loadWorkSelectionIndex, selectionForProject } =
    await import('./work-intent.js');
  const records = Array.from({ length: 100 }, (_, i) => {
    const row = source();
    row.source.projectId = `OPP-${String(i + 1).padStart(5, '0')}`;
    return {
      id: `selection-${i}`,
      owner,
      kind: 'proposals',
      projectId: row.source.projectId,
      source: row.source,
      sourceDigest: row.sourceDigest,
      availability: 'selected',
    };
  });
  const calls = [];
  const index = await loadWorkSelectionIndex(async (page) => {
    calls.push(page);
    return {
      selections: records.slice((page - 1) * 25, page * 25),
      count: 100,
      page,
      pageSize: 25,
      pages: 4,
    };
  }, owner);
  assert.deepEqual(calls, [1, 2, 3, 4]);
  assert.equal(index.selections.length, 100);
  assert.equal(
    selectionForProject(
      { id: 'OPP-00100' },
      'proposals',
      owner,
      index.selections,
    ).id,
    'selection-99',
  );
});
test('an incomplete, cross-holder or unexpectedly large marker read remains unknown instead of claiming unselected', async () => {
  const { loadWorkSelectionIndex } = await import('./work-intent.js');
  await assert.rejects(
    loadWorkSelectionIndex(
      async () => ({
        selections: [],
        count: 101,
        page: 1,
        pageSize: 25,
        pages: 5,
      }),
      owner,
    ),
  );
  const record = {
    id: 'one',
    owner: other,
    kind: 'proposals',
    projectId: 'OPP-00001',
    source: source().source,
    sourceDigest: '1'.repeat(64),
    availability: 'selected',
  };
  await assert.rejects(
    loadWorkSelectionIndex(
      async () => ({
        selections: [record],
        count: 1,
        page: 1,
        pageSize: 25,
        pages: 1,
      }),
      owner,
    ),
  );
  await assert.rejects(
    loadWorkSelectionIndex(
      async () => ({
        selections: [],
        count: 1,
        page: 1,
        pageSize: 25,
        pages: 1,
      }),
      owner,
    ),
  );
});

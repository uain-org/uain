/**
 * Lists come a page at a time, filtered and sorted by the server. The
 * website's tables used to do that in the browser over the whole list, so the
 * reference here is their code, and the server must give the same page for
 * every search, filter and sort they offer.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { boot } from './helpers.mjs';

let t;
before(async () => {
  t = await boot();
  await seed();
});
after(async () => {
  await t.close();
});

const STOP = ['Halt if the work would require restricted data.'];

/* ---------------------------------------------- the tables' own logic */

// components/network/directory-table.tsx, before paging moved to the server.
const STATES = ['active', 'negotiating', 'hold', 'revoked', 'unreachable'];
const REACHES = ['cloud-api', 'gateway', 'agent', 'edge'];
const STATE_ORDER = ['active', 'negotiating', 'hold', 'unreachable', 'revoked'];
const asState = (s) => (STATES.includes(s) ? s : 'negotiating');
const asReach = (r) => (REACHES.includes(r) ? r : 'agent');

function directoryReference(all, { q = '', reach, standing, provides, open, sort }) {
  const term = q.trim().toLowerCase();
  const rows = all.filter((p) => {
    const place = p.placed ? p.region_label : 'Region not declared';
    const haystack = [p.name, p.operator, place, ...p.capabilities, ...p.offers]
      .join(' ')
      .toLowerCase();
    if (term && !haystack.includes(term)) return false;
    if (reach && asReach(p.reachability) !== reach) return false;
    if (standing && asState(p.state) !== standing) return false;
    if (provides && !p.resources.includes(provides)) return false;
    if (open && p.requests.length === 0) return false;
    return true;
  });
  return rows.sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name);
    if (sort === 'karma') return (b.member?.karma ?? b.karma) - (a.member?.karma ?? a.karma);
    if (sort === 'standing')
      return STATE_ORDER.indexOf(asState(a.state)) - STATE_ORDER.indexOf(asState(b.state));
    return Date.parse(b.enrolled_at) - Date.parse(a.enrolled_at);
  });
}

// components/network/project-list.tsx, the same way.
const PROJECT_LABEL = {
  proposal: 'Proposal',
  open: 'Open',
  in_progress: 'In progress',
  finished: 'Finished',
  halted: 'Halted',
};
const PROJECT_ORDER = ['in_progress', 'open', 'proposal', 'halted', 'finished'];

function projectReference(all, { q = '', status, sort }) {
  const term = q.trim().toLowerCase();
  const rows = all
    .map((p) => ({
      p,
      work: p.contributions.length,
      settled: p.contributions.reduce((n, c) => n + (c.karma_awarded ?? 0), 0),
      haystack: [
        p.title,
        p.summary,
        p.lead,
        PROJECT_LABEL[p.progress.status],
        ...p.memberIds,
        ...p.stop_conditions,
      ]
        .join(' ')
        .toLowerCase(),
    }))
    .filter((r) => (!term || r.haystack.includes(term)) && (!status || r.p.progress.status === status));
  return rows
    .sort((a, b) => {
      if (sort === 'activity') return b.work - a.work;
      if (sort === 'karma') return b.settled - a.settled;
      if (sort === 'state')
        return PROJECT_ORDER.indexOf(a.p.progress.status) - PROJECT_ORDER.indexOf(b.p.progress.status);
      if (sort === 'title') return a.p.title.localeCompare(b.p.title);
      return Date.parse(b.p.opened_at) - Date.parse(a.p.opened_at);
    })
    .map((r) => r.p);
}

/** Every page the server gives, joined up, for one query. */
async function allPages(list, key, params, pageSize) {
  const out = [];
  for (let page = 1; ; page++) {
    const r = await list({ ...params, page, pageSize });
    out.push(...r[key]);
    if (page >= r.pages) return { rows: out, count: r.count, pages: r.pages };
  }
}

/* --------------------------------------------------------------- data */

const REGIONS = ['eu-west', 'af-east', 'unstated', 'as-maritime'];
const OFFERS = [
  ['GPU cluster time'],
  ['Research and review'],
  ['Grant funding'],
  ['Sensor network hardware'],
  [],
];
const NAMES = ['alpha', 'Beta', 'gamma', 'Delta', 'epsilon', 'Zeta', 'eta', 'Theta', 'iota', 'Kappa', 'lambda', 'Mu'];

let people;
async function seed() {
  people = [];
  for (let i = 0; i < NAMES.length; i++) {
    const p = await t.enrol({
      name: NAMES[i],
      operator: i % 3 === 0 ? 'Orbital Labs' : `Operator ${i}`,
      region: REGIONS[i % REGIONS.length],
      reachability: i === 5 ? 'strange' : REACHES[i % REACHES.length],
      capabilities: i % 2 ? ['forecasting'] : ['synthesis'],
      offers: OFFERS[i % OFFERS.length],
      requests: i % 4 === 0 ? ['lab time'] : [],
    });
    people.push(p);
    // UAIN's own, so the karma thresholds do not refuse the projects and
    // work this test opens.
    for (const role of ['project-creator', 'default-verifier'])
      await t.db.setUainRole({ participant: p.id, role, on: true, by: 'operator:test' });
    // Distinct times, karma and standings, including one the website does
    // not know and one withdrawn member the directory must leave out.
    const state = ['active', 'negotiating', 'hold', 'revoked', 'unreachable', 'dormant', 'withdrawn'][i % 7];
    await t.db
      .prepare('UPDATE participants SET enrolled_at = ?, karma = ?, state = ? WHERE id = ?')
      .run(new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), (i * 37) % 11, state, p.id);
  }
}

/* -------------------------------------------------------------- tests */

describe('the directory, a page at a time', () => {
  test('every search, filter and sort gives the pages the table showed', async () => {
    // What /api/directory served whole before, as the table received it.
    const whole = (await t.db.listParticipants()).map((p) => ({
      ...p,
      placed: p.region !== 'unstated',
      region_label: p.region === 'unstated' ? 'unstated' : p.region,
    }));
    const { REGIONS: labels } = await import('../dist/src/domain/regions.js');
    for (const p of whole) if (labels[p.region]) p.region_label = labels[p.region].label;

    const cases = [];
    for (const sort of ['newest', 'name', 'karma', 'standing'])
      for (const q of ['', 'orbital', 'gpu', 'africa', 'not declared', 'ta', 'forecast'])
        cases.push({ sort, q });
    for (const reach of REACHES) cases.push({ sort: 'newest', reach });
    for (const standing of STATES) cases.push({ sort: 'karma', standing });
    for (const provides of ['intelligence', 'compute', 'financial', 'assets'])
      cases.push({ sort: 'name', provides });
    cases.push({ sort: 'standing', open: true });
    cases.push({ sort: 'newest', q: 'orbital', provides: 'compute', open: true });

    for (const c of cases) {
      const want = directoryReference([...whole], c).map((p) => p.id);
      const got = await allPages(t.db.listDirectory, 'participants', c, 3);
      assert.deepEqual(got.rows.map((p) => p.id), want, JSON.stringify(c));
      assert.equal(got.count, want.length, JSON.stringify(c));
    }
  });

  test('pages are sized, counted and clamped', async () => {
    const r = await t.db.listDirectory({ pageSize: 5 });
    assert.equal(r.participants.length, 5);
    assert.equal(r.page_size, 5);
    assert.equal(r.pages, Math.ceil(r.count / 5));
    const past = await t.db.listDirectory({ page: 99, pageSize: 5 });
    assert.equal(past.participants.length, 0);
    assert.equal(past.count, r.count);
    assert.equal((await t.db.listDirectory({ pageSize: 10_000 })).page_size, 200);
    // A search term's wildcards are taken literally.
    assert.equal((await t.db.listDirectory({ q: '%' })).count, 0);
  });

  test('the map feed places everyone and counts the unplaced', async () => {
    const m = await t.db.directoryMap();
    const members = (await t.db.listDirectory({ pageSize: 200 })).count;
    assert.equal(m.total, members);
    assert.equal(m.unplaced, m.participants.filter((p) => !p.placed).length);
    for (const p of m.participants.filter((x) => !x.placed)) assert.equal(p.lon, null);
    assert.deepEqual(Object.keys(m.participants[0]).sort(), [
      'id', 'karma', 'lat', 'lon', 'name', 'operator', 'placed', 'protocols', 'reachability', 'region', 'region_label', 'state', 'tier',
    ]);
  });

  test('over HTTP, with the same parameters the website sends', async () => {
    const r = await (await t.http('/api/directory?q=orbital&sort=name&page=1&page_size=2')).json();
    assert.equal(r.page_size, 2);
    assert.ok(r.participants.length <= 2);
    assert.ok(r.participants.every((p) => p.operator === 'Orbital Labs'));
    assert.ok(Array.isArray(r.participants[0].resources));
    const map = await t.http('/api/directory/map');
    assert.equal(map.status, 200);
  });

  test('Karma sorting ranks displayed member totals before paging', async () => {
    const first = await t.member('Directory ranking operator', 'Directory ranking first', { uain: false });
    const sibling = await t.instance(first.key, 'Directory ranking operator', 'Directory ranking second', { uain: false });
    const withdrawn = await t.instance(first.key, 'Directory ranking operator', 'Directory ranking retired', { uain: false });
    const single = await t.enrol({ name: 'Directory ranking single', operator: 'Other operator' });
    const unclaimed = await t.enrol({ name: 'Directory ranking unclaimed', operator: 'Legacy operator' });
    for (const [p, karma, hour] of [[first, 2, 1], [sibling, 8, 2], [withdrawn, 5, 3], [single, 12, 4], [unclaimed, 11, 5]]) {
      await t.db.prepare('UPDATE participants SET karma = ?, enrolled_at = ? WHERE id = ?')
        .run(karma, `2026-10-01T0${hour}:00:00.000Z`, p.id);
    }
    await t.db.prepare("UPDATE participants SET state = 'withdrawn' WHERE id = ?").run(withdrawn.id);
    await t.db.prepare('UPDATE participants SET member_id = NULL WHERE id = ?').run(unclaimed.id);
    const got = await allPages(t.db.listDirectory, 'participants', { q: 'Directory ranking', sort: 'karma' }, 1);
    assert.deepEqual(got.rows.map((p) => p.id), [sibling.id, first.id, single.id, unclaimed.id]);
    assert.deepEqual(got.rows.map((p) => p.member?.karma ?? p.karma), [15, 15, 12, 11]);
    assert.equal(got.count, 4);
    const response = await t.http('/api/directory?q=Directory%20ranking&sort=karma&page=1&page_size=1');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).participants[0].id, sibling.id);
  });
});

describe('projects, as summaries', () => {
  let projects;
  before(async () => {
    const [lead, a, b] = people.filter((p) => p.id);
    for (const m of [lead, a, b])
      await t.db.prepare("UPDATE participants SET state = 'active' WHERE id = ?").run(m.id);
    projects = [];
    for (let i = 0; i < 7; i++) {
      const p = await t.db.propose({
        lead: lead.id,
        title: ['Zinc', 'aluminium', 'Copper', 'iron', 'Gold', 'silver', 'Tin'][i],
        summary: i % 2 ? 'About reasoning.' : 'About measurement.',
        stopConditions: STOP,
      });
      projects.push(p);
      await t.db
        .prepare('UPDATE projects SET opened_at = ? WHERE id = ?')
        .run(new Date(Date.UTC(2026, 1, 1 + i)).toISOString(), p.id);
      if (i % 3 === 0) await t.db.joinProject(p.id, a.id);
      for (let k = 0; k < i % 4; k++)
        await t.db.contribute({
          contributor: lead.id,
          projectId: p.id,
          title: `Work ${k}`,
          detail: 'x',
          artifacts: [],
          karmaClaimed: 3,
        });
    }
  });

  test('every search, status and sort gives the pages the table showed', async () => {
    const whole = await t.db.listProjects();
    // A project shows a count of its members; search still finds them by id.
    const memberRows = await t.db.prepare('SELECT project_id, member_id FROM project_members').all();
    for (const p of whole) p.memberIds = memberRows.filter((m) => m.project_id === p.id).map((m) => m.member_id);
    // Guard against comparing two empty lists: the projects must exist.
    assert.ok(whole.length >= 7, `only ${whole.length} projects were opened`);
    assert.ok(whole.some((p) => p.contributions.length > 0));
    const cases = [];
    for (const sort of ['newest', 'activity', 'state', 'karma', 'title'])
      for (const q of ['', 'reasoning', 'zinc', people[0].id, 'proposal', 'halt if'])
        cases.push({ sort, q });
    for (const status of ['proposal', 'open', 'in_progress', 'finished', 'halted'])
      cases.push({ sort: 'newest', status });

    for (const c of cases) {
      const want = projectReference([...whole], c).map((p) => p.id);
      const got = await allPages(t.db.listProjectSummaries, 'projects', c, 2);
      assert.deepEqual(got.rows.map((p) => p.id), want, JSON.stringify(c));
    }
  });

  test('a project shows how many members and who joined last; the whole list is paged', async () => {
    const whole = await t.db.listProjects();
    const p = whole.reduce((a, b) => (b.members.count > a.members.count ? b : a));
    assert.ok(p.members.count >= 2, 'a project with members to page through');
    assert.equal(p.members.lead, p.lead);
    assert.ok(p.members.recent.length <= 5 && p.members.recent.length <= p.members.count);
    const seen = [];
    for (let page = 1; ; page++) {
      const r = await t.db.listProjectMembers(p.id, { page, pageSize: 1 });
      assert.equal(r.count, p.members.count);
      seen.push(...r.members.map((m) => m.member));
      if (page >= r.pages) break;
    }
    assert.equal(new Set(seen).size, p.members.count, 'every member once');
    assert.deepEqual(p.members.recent.map((m) => m.member), seen.slice(0, p.members.recent.length), 'recent is the first page');
    const byHttp = await (await t.http(`/api/projects/${p.id}/members?page_size=200`)).json();
    assert.equal(byHttp.members.length, p.members.count);
    assert.equal((await t.http('/api/projects/no-such-project/members')).status, 404);
  });

  test('a summary carries counts, not contents', async () => {
    const whole = await t.db.listProjects();
    const { projects: page } = await t.db.listProjectSummaries({ pageSize: 200 });
    for (const s of page) {
      const p = whole.find((x) => x.id === s.id);
      assert.equal(s.contributions, undefined);
      assert.equal(s.members, undefined);
      assert.equal(s.haystack, undefined);
      assert.equal(s.member_count, p.members.count);
      assert.equal(s.contribution_count, p.contributions.length);
      assert.equal(
        s.held,
        p.contributions.filter((c) => c.state === 'held' || c.state === 'contested').length,
      );
      assert.deepEqual(s.progress, p.progress);
      assert.deepEqual(s.tasks, p.tasks);
      assert.deepEqual(s.claims, p.claims);
    }
  });

  test('a new project is listed at once, not after a cache expires', async () => {
    const before = (await t.db.listProjectSummaries({})).count;
    const opened = await t.db.propose({
      lead: people[0].id,
      title: 'Fresh',
      summary: 'Just opened.',
      stopConditions: STOP,
    });
    assert.equal(opened.error, undefined, JSON.stringify(opened));
    assert.equal((await t.db.listProjectSummaries({})).count, before + 1);
  });
});

describe('contributions and totals', () => {
  test('contributions come newest first, a page at a time', async () => {
    const whole = await t.db.listContributions();
    const got = await allPages(t.db.listContributionsPage, 'contributions', {}, 4);
    assert.deepEqual(got.rows.map((c) => c.id), whole.map((c) => c.id));
    assert.ok(got.rows.every((c) => Array.isArray(c.verifications)));
  });

  test('a brief page keeps what a row shows, not the write-ups', async () => {
    const full = await t.db.listContributionsPage({ pageSize: 5 });
    const short = await t.db.listContributionsPage({ pageSize: 5, brief: true });
    assert.deepEqual(short.contributions.map((c) => c.id), full.contributions.map((c) => c.id));
    for (const c of short.contributions) {
      assert.equal(c.detail, undefined);
      assert.ok(c.verifications.every((v) => v.note === undefined));
    }
  });

  test('stats carry the totals the website used to add up itself', async () => {
    const s = await t.db.accessStats();
    const members = await t.db.listParticipants();
    assert.equal(s.members, members.length);
    assert.equal(s.projects, (await t.db.listProjects()).length);
    assert.equal(s.contributions, (await t.db.listContributions()).length);
    assert.equal(s.karma, members.reduce((n, p) => n + p.karma, 0));
  });

  test('stats count licensed systems once, independently of agent instances', async () => {
    const before = await t.db.accessStats();
    const system = await t.member('stats-count-operator', 'stats-system');
    await t.instance(system.key, 'stats-count-operator', 'stats-second-instance');
    const after = await t.db.accessStats();
    assert.equal(after.member_count, before.member_count + 1);
    assert.equal(after.members, before.members + 2, 'legacy agent total stays compatible');
    assert.ok(Array.isArray(after.agents), 'access-log breakdown stays compatible');
    const { member_id } = await t.db.prepare('SELECT member_id FROM participants WHERE id = ?').get(system.id);
    for (const state of ['revoked', 'withdrawn', 'key_pending']) {
      await t.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(state, member_id);
      assert.equal((await t.db.accessStats()).member_count, before.member_count, state);
    }
    await t.db.prepare("UPDATE members SET state = 'active', public_key = NULL WHERE id = ?").run(member_id);
    assert.equal((await t.db.accessStats()).member_count, before.member_count, 'unclaimed system');
  });
});

// Baseline 06b-6/13 and 06a-14 (13 November 2026): two inputs that reached a
// 500. Dormant under native authority, fixed in source all the same.
describe('inputs that used to throw', () => {
  test('a sort named after an Object property falls back to the default order', async () => {
    for (const sort of ['constructor', 'toString', '__proto__', 'hasOwnProperty'])
      assert.deepEqual(
        (await t.db.listDirectory({ sort, pageSize: 5 })).participants.map((p) => p.id),
        (await t.db.listDirectory({ pageSize: 5 })).participants.map((p) => p.id),
        sort,
      );
  });

  test('a null or non-object declined item is skipped, not a crash', async () => {
    const m = await t.member('Decline null operator', 'Decline null system');
    const r = await t.db.declineItems({ participant: m.id, items: [null, 7, 'task', { kind: 'task' }] });
    assert.equal(r.declined, 0);
  });
});

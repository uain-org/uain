/**
 * Tasks, comparisons and uain_next, end to end, against a running pilot on an
 * empty data dir:
 *
 *   export UAIN_DATA_DIR=$(mktemp -d) DATABASE_URL=postgres://...
 *   node src/server.mjs &
 *   node scripts/tasks-test.mjs
 *
 * Exits non-zero on the first assertion that fails.
 */
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { newKey, proveWith } from '../../../public/worker/uain-key.mjs';

const BASE = process.env.UAIN_BASE ?? 'http://127.0.0.1:8787';

async function agent(name) {
  const c = new Client({ name, version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
  let token = null;
  const call = async (tool, args = {}) => {
    const r = await c.callTool({
      name: tool,
      arguments: token ? { token, ...args } : args,
    });
    if (r.isError) return { mcp_error: r.content[0].text };
    return JSON.parse(r.content[0].text);
  };
  const e = await call('uain_enrol', {
    principles: ['voluntary', 'verifiable', 'authority', 'benevolent'],
    proof: proveWith(newKey(), 'enrol'),
    protocols: ['MCP'],
    name,
    operator: `${name} Lab`,
    authority: `${name} duty engineer`,
  });
  token = e.session_token;
  return { id: e.participant.id, token, call, close: () => c.close() };
}

const get = async (path, token) => {
  const r = await fetch(`${BASE}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: r.status, body: await r.json() };
};

let step = 0;
const ok = (label) => console.log(`  ok ${++step}  ${label}`);
const refused = (r, error) => {
  assert.equal(
    r.error,
    error,
    `expected ${error}, got ${JSON.stringify(r).slice(0, 300)}`,
  );
  assert.ok(r.message, `refusal ${error} carries no message`);
};
const kinds = (next) =>
  next.items.map(
    (i) => `${i.kind}:${i.contribution_id ?? i.claim_id ?? i.task_id}`,
  );

// UAIN's own agents may open projects and check work without karma; this
// test's members stand in for them, as in worker-test.mjs. The store is the
// server's own, so this needs the same DATABASE_URL.
const db = await import('../dist/src/application/db.js');
const uain = async (m) => {
  await db.setUainRole({ participant: m.id, role: 'project-creator', on: true, by: 'operator:test' });
  await db.setUainRole({ participant: m.id, role: 'default-verifier', on: true, by: 'operator:test' });
  return m;
};

const A = await uain(await agent('Alpha'));
const B = await uain(await agent('Beta'));
const C = await uain(await agent('Gamma'));
const D = await uain(await agent('Delta'));
const E = await uain(await agent('Epsilon'));
const Z = await uain(await agent('Zeta'));

let r = await E.call('uain_next');
assert.equal(r.count, 0);
assert.equal(r.join_first, undefined, 'no projects exist yet');

const P = (
  await A.call('uain_propose', {
    title: 'Tasks test',
    summary: 'Exercise tasks',
    stop_conditions: ['Stop if anything here touches a real system.'],
  })
).project.id;
const Q = (
  await A.call('uain_propose', {
    title: 'Other project',
    summary: 'For the outside-project checks',
    stop_conditions: ['Stop on request.'],
  })
).project.id;
for (const x of [B, C, D]) await x.call('uain_join_project', { project_id: P });

r = await E.call('uain_next');
assert.deepEqual(r.join_first.map((p) => p.id).sort(), [P, Q].sort());
assert.deepEqual(
  r.items
    .filter((i) => i.kind === 'join')
    .map((i) => i.project.id)
    .sort(),
  [P, Q].sort(),
  'joining is offered as work, so a worker starts its agent instead of waiting',
);
ok('a member of no project is offered joining one, as items on its menu');

/* ------------------------------------------------------------------ open */

const task = (over = {}) => ({
  project_id: P,
  title: 'Measure the thing',
  question: 'What does the thing measure?',
  done_when: 'A number with its unit and method.',
  how_to_check: 'Re-run the method on the same input.',
  ...over,
});

refused(await E.call('uain_task_open', task()), 'not_a_member');
refused(
  await A.call('uain_task_open', task({ parent_task_id: 'T-99' })),
  'parent_task_not_found',
);
refused(
  await A.call('uain_task_open', task({ from_claim_id: 'CL-99' })),
  'claim_not_found',
);
ok('opening a task checks membership, parent and claim');

// T1 asks for two independent answers, so its answers are compared.
r = await A.call('uain_task_open', task({ answers_wanted: 2 }));
assert.equal(r.ok, true);
const T1 = r.task.id;
assert.equal(r.task.status, 'open');
const TQ = (
  await A.call('uain_task_open', task({ project_id: Q, title: 'Elsewhere' }))
).task.id;
refused(
  await A.call('uain_task_open', task({ parent_task_id: TQ })),
  'parent_task_outside_project',
);
let ev = (await get(`/api/events/${r.task.event_id}`)).body;
assert.equal(ev.kind, 'task');
assert.ok(ev.summary.includes(T1));
ok(
  `${T1} opens as open, with its own ledger entry; a parent from another project is refused`,
);

r = await B.call('uain_next');
assert.deepEqual(kinds(r), [`task:${T1}`]);
assert.equal(r.items[0].why, 'Open, and nobody is on it.');
ok('uain_next offers the open task');

/* ----------------------------------------------------------------- start */

r = await B.call('uain_task_start', { task_id: T1 });
assert.deepEqual(
  r.task.working.map((w) => w.participant),
  [B.id],
);
r = await C.call('uain_task_start', { task_id: T1.toLowerCase() });
assert.deepEqual(
  r.others_working.map((w) => w.participant),
  [B.id],
);
assert.equal(r.task.working.length, 2);
ev = (await get('/api/events?limit=1')).body.events[0];
assert.ok(ev.summary.includes(`alongside ${B.id}`), ev.summary);
ok('two members can start the same task; the second is told who else is on it');

r = await B.call('uain_next');
assert.equal(r.items[0].kind, 'continue_task');
r = await D.call('uain_next');
assert.deepEqual(r.items[0].working.sort(), [B.id, C.id].sort());
ok(
  'uain_next puts your own started task first, and shows others who is working',
);

/* ---------------------------------------------------------------- results */

const rq = (
  await A.call('uain_contribute', {
    project_id: Q,
    title: 'q',
    detail: 'q',
    task_id: TQ,
    claim: 'What the answer establishes.',
  })
).contribution.id;
refused(
  await B.call('uain_contribute', {
    project_id: P,
    title: 'x',
    detail: 'x',
    task_id: TQ,
    claim: 'What the answer establishes.',
  }),
  'task_outside_project',
);
refused(
  await B.call('uain_contribute', {
    project_id: P,
    title: 'x',
    detail: 'x',
    task_id: 'T-404',
    claim: 'What the answer establishes.',
  }),
  'task_not_found',
);
ok('a result must name a task in the same project');

const R1 = (
  await B.call('uain_contribute', {
    project_id: P,
    title: 'It is 4',
    detail: 'Measured 4.',
    task_id: T1,
    claim: 'What the answer establishes.',
  })
).contribution.id;
r = await B.call('uain_tasks', { task_id: T1 });
assert.equal(r.status, 'awaiting_verification');
assert.deepEqual(
  r.working.map((w) => w.participant),
  [C.id],
  'submitting ends your working signal',
);
ok(
  'one result makes the task awaiting_verification; the submitter stops showing as working',
);

r = await A.call('uain_next');
assert.ok(kinds(r).includes(`verify:${R1}`));
await A.call('uain_verify', {
  contribution_id: R1,
  verdict: 'confirmed',
  note: 'Got 4.',
});
await D.call('uain_verify', {
  contribution_id: R1,
  verdict: 'confirmed',
  note: 'Got 4.',
});
r = await A.call('uain_tasks', { task_id: T1 });
assert.equal(r.status, 'answered');
ok('once its only result settles, the task is answered');

const R2 = (
  await C.call('uain_contribute', {
    project_id: P,
    title: 'It is 5',
    detail: 'Measured 5.',
    task_id: T1,
    claim: 'What the answer establishes.',
  })
).contribution.id;
r = await A.call('uain_tasks', { task_id: T1 });
assert.equal(r.status, 'needs_comparison');
ok(
  'on a task asking for two answers, a second member answering makes it need comparing',
);

r = await B.call('uain_next');
assert.ok(
  !kinds(r).includes(`compare:${T1}`),
  'an author of a result is not offered the comparison',
);
r = await D.call('uain_next');
const cmp = r.items.find((i) => i.kind === 'compare');
assert.deepEqual(cmp.results.sort(), [R1, R2].sort());
ok(
  'uain_next offers the comparison only to members who wrote none of the results',
);

/* ------------------------------------------------------------ comparisons */

const compare = (who, ids, over = {}) =>
  who.call('uain_contribute', {
    project_id: P,
    title: 'Comparison',
    detail: 'Where they agree and differ.',
    task_id: T1,
    reconciles: ids,
    claim: 'What the answers together establish.',
    ...over,
  });

refused(
  await compare(D, [R1, R2], { task_id: undefined }),
  'task_required_for_comparison',
);
refused(await compare(D, [R1]), 'compare_at_least_two');
refused(await compare(D, [R1, R1.toLowerCase()]), 'compare_at_least_two');
refused(await compare(B, [R1, R2]), 'cannot_compare_own_result');
refused(await compare(D, [R1, rq]), 'not_a_result_of_task');
const R3 = (
  await B.call('uain_contribute', {
    project_id: P,
    title: 'Still 4',
    detail: 'Again 4.',
    task_id: T1,
    claim: 'What the answer establishes.',
  })
).contribution.id;
refused(await compare(D, [R1, R3]), 'results_from_one_member');
ok(
  'comparison rules: needs a task, two distinct results, two authors, none of them yours',
);

const K1 = (await compare(D, [R1, R2])).contribution.id;
refused(await compare(A, [K1, R2]), 'not_a_result_of_task');
r = await A.call('uain_tasks', { task_id: T1 });
assert.equal(r.status, 'needs_comparison', 'K1 does not cover R3');
ok('a comparison that leaves out a standing result does not resolve the task');

// D's first comparison is still waiting for its checks, so a second from D
// is refused; another member writes the one that covers every result.
refused(await compare(D, [R1, R2, R3]), 'answer_already_held');
await Z.call('uain_join_project', { project_id: P });
const K2 = (await compare(Z, [R1, R2, R3])).contribution.id;
r = await A.call('uain_tasks', { task_id: T1 });
assert.equal(r.status, 'awaiting_verification');
assert.deepEqual(
  r.comparisons.map((c) => c.id),
  [K1, K2],
);
await A.call('uain_verify', {
  contribution_id: K2,
  verdict: 'confirmed',
  note: 'Accurate.',
});
await B.call('uain_verify', {
  contribution_id: K2,
  verdict: 'confirmed',
  note: 'Accurate.',
});
r = await A.call('uain_tasks', { task_id: T1 });
assert.equal(r.status, 'answered');
ok('a settled comparison covering every result answers the task');

ev = (await get('/api/events?limit=20')).body.events.find((e) =>
  e.summary.startsWith('Compared'),
);
assert.ok(ev.summary.includes(T1));
ok('the ledger says a comparison is a comparison, and of which task');

/* ------------------------------------------- from answer to claim */

assert.ok(
  !(await D.call('uain_next')).items.some((i) => i.kind === 'propose_claim'),
  'nobody is asked to propose a claim: every answer states its own',
);
const fromTask = await D.call('uain_claim_create', {
  project_id: P,
  statement: 'The thing measures 4.',
  sources: [K2, R1],
  reason: 'The comparison settled it.',
});
assert.equal(fromTask.ok, true);
// A verified K2, which the draft cites, so reviewing it would approve its
// own check again; a member that checked none of its sources is offered it.
assert.ok(
  !(await A.call('uain_next')).items.some(
    (i) => i.kind === 'review_claim' && i.claim_id === fromTask.claim.id,
  ),
  'not to a member that verified the work it cites',
);
const reviewers = [];
for (const m of [C, E])
  if (
    (await m.call('uain_next')).items.some(
      (i) => i.kind === 'review_claim' && i.claim_id === fromTask.claim.id,
    )
  )
    reviewers.push(m);
assert.ok(reviewers.length > 0, 'and the draft is offered for review instead');
ok(
  'a claim on settled work goes to members who checked none of its sources for review',
);

/* ---------------------------------------------------- dispute and close */

const T2 = (await A.call('uain_task_open', task({ title: 'Second' }))).task.id;
const R4 = (
  await B.call('uain_contribute', {
    project_id: P,
    title: 'Wrong',
    detail: 'x',
    task_id: T2,
    claim: 'What the answer establishes.',
  })
).contribution.id;
await A.call('uain_verify', {
  contribution_id: R4,
  verdict: 'disputed',
  note: 'Does not reproduce.',
});
r = await A.call('uain_tasks', { task_id: T2 });
// One dispute contests a result rather than ending it: an arbiter decides.
assert.equal(r.results[0].state, 'contested');
assert.equal(r.status, 'awaiting_verification');
assert.equal(r.results.length, 1, 'the contested result stays visible');
ok('a disputed result is contested, and the task waits for an arbiter');

refused(
  await C.call('uain_task_close', { task_id: T2, reason: 'no' }),
  'not_creator_or_lead',
);
r = await A.call('uain_task_close', {
  task_id: T2,
  reason: 'Duplicate of the first.',
});
assert.equal(r.task.status, 'closed');
assert.equal(r.task.closed.by, A.id);
refused(
  await A.call('uain_task_close', { task_id: T2, reason: 'again' }),
  'task_closed',
);
refused(await B.call('uain_task_start', { task_id: T2 }), 'task_closed');
refused(
  await B.call('uain_contribute', {
    project_id: P,
    title: 'x',
    detail: 'x',
    task_id: T2,
    claim: 'What the answer establishes.',
  }),
  'task_closed',
);
r = await B.call('uain_next');
assert.ok(!kinds(r).some((k) => k.endsWith(T2)));
ok(
  'only the creator or lead closes a task; a closed task takes no work and leaves uain_next',
);

/* ------------------------------------------------------- emergent tasks */

await B.call('uain_claim_create', {
  project_id: P,
  statement: 'The thing measures 4.',
  sources: [R1, R3],
  reason: 'Two runs.',
});
const T3 = (
  await C.call('uain_task_open', task({ title: 'Why 5?', parent_task_id: T1 }))
).task.id;
const T4 = (
  await C.call(
    'uain_task_open',
    task({ title: 'Recheck', from_claim_id: 'CL-1' }),
  )
).task.id;
r = await A.call('uain_tasks', { task_id: T1 });
assert.deepEqual(r.subtasks, [T3]);
r = await A.call('uain_tasks', { task_id: T4 });
assert.equal(r.from_claim, 'CL-1');
ok('follow-up tasks record the task or claim they came from');

r = await D.call('uain_next');
const order = r.items.map((i) => i.kind);
// Checks — claim reviews and verifications — come before new tasks. (D may
// not be offered this particular review: it verified work the claim cites.)
const CHECKS = ['review_claim', 'revise_claim', 'verify'];
assert.ok(CHECKS.includes(order[0]), `checks come first, got ${order.join(',')}`);
assert.ok(
  order.findLastIndex((k) => CHECKS.includes(k)) < order.indexOf('task'),
  `every check before any task, got ${order.join(',')}`,
);
ok('uain_next ranks checks before new tasks');

/* ------------------------------------------------------------ who is on it */

const G = (
  await A.call('uain_propose', {
    title: 'Crowd test',
    summary: 's',
    stop_conditions: ['stop'],
  })
).project.id;
for (const x of [B, C, D]) await x.call('uain_join_project', { project_id: G });
const RG = (
  await A.call('uain_contribute', {
    project_id: G,
    title: 'Check me',
    detail: 'd',
  })
).contribution.id;
const menuItem = async (who) =>
  (await who.call('uain_next', { project_id: G })).items.find(
    (i) => i.kind === 'verify' && i.contribution_id === RG,
  );

let it = await menuItem(B);
assert.deepEqual([it.working, it.needed, it.enough_on_it], [[], 2, false]);
let st = await B.call('uain_start', { kind: 'verify', id: RG });
assert.deepEqual(
  [st.ok, st.others_working, st.needed, st.enough_already],
  [true, [], 2, false],
);
st = await C.call('uain_start', { kind: 'verify', id: RG });
assert.deepEqual([st.others_working, st.enough_already], [[B.id], false]);
ok('uain_start says who else is on an item and how many it can use');

it = await menuItem(D);
assert.equal(it.enough_on_it, true);
assert.match(it.why, /2 agents are already on it .* it needs 2\./);
const dMenu = (await D.call('uain_next', { project_id: G })).items;
assert.equal(
  dMenu.at(-1).contribution_id,
  RG,
  'a crowded item goes to the end of the menu',
);
st = await D.call('uain_start', { kind: 'verify', id: RG });
assert.equal(st.enough_already, true);
assert.match(
  st.message,
  /2 other agents are already on this, and it needs 2\. Your work may not be counted/,
);
ok(
  'an agent is told when enough others are already on it, and it is listed last, not hidden',
);

await B.call('uain_verify', {
  contribution_id: RG,
  verdict: 'confirmed',
  note: 'ok',
});
it = await menuItem(D);
assert.deepEqual(
  it.working.sort(),
  [C.id, D.id].sort(),
  'submitting ends the signal',
);
assert.equal(it.needed, 1);
ev = (await get('/api/events?limit=30')).body.events.find(
  (e) => e.kind === 'working' && e.summary.includes(RG),
);
assert.ok(
  ev,
  'starts are on the ledger as working, which no one counts as output',
);
ok('submitting ends the signal, and what is still needed updates');

await C.call('uain_verify', {
  contribution_id: RG,
  verdict: 'confirmed',
  note: 'ok',
});
st = await D.call('uain_start', { kind: 'verify', id: RG });
assert.equal(st.error, 'item_not_open');
assert.match(st.message, /no longer open/);
st = await D.call('uain_start', { kind: 'nonsense', id: 'x' });
assert.ok(st.mcp_error || st.error, 'an unknown kind is refused');
ok('an item that is settled or unknown cannot be started');

/* ---------------------------------------------------------------- release */

const RR = (
  await A.call('uain_contribute', {
    project_id: G,
    title: 'Release me',
    detail: 'd',
    verifiers_required: 1,
  })
).contribution.id;
await B.call('uain_start', { kind: 'verify', id: RR });
assert.equal(
  (await C.call('uain_next', { project_id: G })).items.find(
    (i) => i.contribution_id === RR,
  ).enough_on_it,
  true,
);
let rel = await B.call('uain_release', { kind: 'verify', id: RR });
assert.equal(rel.released, 1);
assert.equal(
  (await C.call('uain_next', { project_id: G })).items.find(
    (i) => i.contribution_id === RR,
  ).enough_on_it,
  false,
);
ev = (await get('/api/events?limit=5')).body.events[0];
assert.equal(ev.kind, 'working');
assert.match(ev.summary, /^Released verify/);
await B.call('uain_start', { kind: 'verify', id: RR });
const r2 = await fetch(`${BASE}/api/working/release`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${B.token}`,
    'content-type': 'application/json',
  },
  body: '{}',
});
assert.equal((await r2.json()).released, 1);
assert.equal(
  (await fetch(`${BASE}/api/working/release`, { method: 'POST', body: '{}' }))
    .status,
  401,
);
assert.equal(
  (await B.call('uain_release', {})).released,
  0,
  'nothing left to release',
);
ok(
  'an agent can take back "on it" by tool or over HTTP; the item is free again at once',
);

/* -------------------------------------------------- where a project stands */

const progress = async (id) =>
  (await (await fetch(`${BASE}/api/projects/${id}`)).json()).progress;
const F = (
  await A.call('uain_propose', {
    title: 'Progress test',
    summary: 's',
    stop_conditions: ['stop'],
  })
).project.id;
assert.equal((await progress(F)).status, 'proposal');
await B.call('uain_join_project', { project_id: F });
assert.deepEqual(await progress(F), {
  status: 'open',
  label: 'Open',
  detail: 'No work yet. A member can open a task.',
});
const TF = (
  await A.call('uain_task_open', task({ project_id: F, title: 'One thing' }))
).task.id;
assert.deepEqual(await progress(F), {
  status: 'in_progress',
  label: 'In progress',
  detail: '1 task open',
});
const RF = (
  await B.call('uain_contribute', {
    project_id: F,
    title: 'Done',
    detail: 'd',
    task_id: TF,
    verifiers_required: 1,
    claim: 'What the answer establishes.',
  })
).contribution.id;
assert.equal((await progress(F)).detail, '1 answer to verify');
const settledRF = await A.call('uain_verify', {
  contribution_id: RF,
  verdict: 'confirmed',
  note: 'ok',
});
// One check settles the work, but a claim is believed only on two
// confirmations, so the answer's own claim waits as a draft.
assert.equal(settledRF.claim.status, 'unconfirmed');
const CF = (await B.call('uain_claims', { claim_id: settledRF.claim.id }))
  .history[0];
assert.deepEqual(await progress(F), {
  status: 'in_progress',
  label: 'In progress',
  detail: '1 claim draft to review',
});
// A verified RF, so the claim on it is reviewed by two others.
await D.call('uain_join_project', { project_id: F });
await D.call('uain_claim_review', {
  revision_id: CF.revision,
  verdict: 'confirm',
  note: 'ok',
});
await C.call('uain_join_project', { project_id: F });
await C.call('uain_claim_review', {
  revision_id: CF.revision,
  verdict: 'confirm',
  note: 'ok',
});
assert.equal((await progress(F)).detail, '1 task answered · 1 claim believed');
await A.call('uain_task_open', task({ project_id: F, title: 'One more' }));
assert.equal(
  (await progress(F)).status,
  'in_progress',
  'a new task puts a finished project back in progress',
);
ok(
  'a project reads as proposal, open, in progress or finished, and new work reopens it',
);

/* ------------------------------------- a new project reaches idle agents */

// E has been in no project so far. Put it in a project with nothing to do.
const Quiet = (
  await E.call('uain_propose', {
    title: 'Quiet one',
    summary: 's',
    stop_conditions: ['stop'],
  })
).project.id;
await B.call('uain_join_project', { project_id: Quiet });
// E leads Quiet, so it is asked to plan it; this step wants E idle.
await E.call('uain_release', { kind: 'plan', id: Quiet, reason: 'Nothing yet.' });
const New = (
  await A.call('uain_propose', {
    title: 'Fresh work',
    summary: 's',
    stop_conditions: ['stop'],
  })
).project.id;
await B.call('uain_join_project', { project_id: New });
r = await E.call('uain_next');
assert.ok(
  !r.items.some((i) => i.kind === 'join' && i.project.id === New),
  'no open work there yet: nothing to join for',
);
await A.call('uain_task_open', task({ project_id: New, title: 'Open work' }));
r = await E.call('uain_next');
const offerJoin = r.items.find(
  (i) => i.kind === 'join' && i.project.id === New,
);
assert.ok(
  offerJoin,
  'idle elsewhere, it is offered the project with work waiting',
);
assert.match(offerJoin.why, /Nothing is waiting in your projects/);
assert.equal(
  r.join_first,
  undefined,
  'it is a member somewhere, so this is not first-time joining',
);
r = await C.call('uain_next');
assert.ok(
  !r.items.some((i) => i.kind === 'join'),
  'an agent with work in its own projects is not pulled away',
);
const Solo = (
  await A.call('uain_propose', {
    title: 'Solo lead',
    summary: 's',
    stop_conditions: ['stop'],
  })
).project.id;
await A.call(
  'uain_task_open',
  task({ project_id: Solo, title: 'Needs hands' }),
);
r = await E.call('uain_next');
assert.ok(
  r.items.some((i) => i.kind === 'join' && i.project.id === Solo),
  'a new project whose only member is its lead still reads as a proposal, and is still offered',
);
const startsBefore = (await get('/api/events?limit=200')).body.events.filter(
  (e) => e.kind === 'working',
).length;
const solo = (await A.call('uain_tasks', { project_id: Solo })).tasks[0].id;
await A.call('uain_start', { kind: 'task', id: solo });
await A.call('uain_task_start', { task_id: solo });
const startsAfter = (await get('/api/events?limit=200')).body.events.filter(
  (e) => e.kind === 'working',
).length;
assert.equal(
  startsAfter - startsBefore,
  1,
  'uain_start then uain_task_start is one start on the ledger',
);
ok(
  'an agent idle in its projects is offered a project with open work; a busy one is not',
);

/* ------------------------------------------------------------------ http */

r = await get('/api/next', D.token);
assert.equal(r.status, 200);
assert.equal(r.body.participant, D.id);
assert.equal(r.body.count, (await D.call('uain_next')).count);
assert.equal((await get('/api/next')).status, 401);
assert.equal((await get('/api/next', 'uain_wrong')).status, 401);
ok('GET /api/next returns the same menu with a bearer token, 401 without');

assert.equal((await get(`/api/tasks/${T1.toLowerCase()}`)).status, 200);
assert.equal((await get('/api/tasks/T-999')).status, 404);
r = (await get(`/api/projects/${P}/tasks`)).body;
assert.equal(r.count, 4);
r = (await get(`/api/projects/${P}`)).body;
assert.deepEqual(r.tasks, {
  open: 2,
  needs_comparison: 0,
  awaiting_verification: 0,
  answered: 1,
  closed: 1,
  total: 4,
});
r = (await get(`/api/contributions/${K2}`)).body;
assert.equal(r.task_id, T1);
assert.deepEqual(r.reconciles, [R1, R2, R3]);
ok('task reads, project counts and contribution links over JSON');

for (const x of [A, B, C, D, E, Z]) await x.close();
console.log(`\nall ${step} checks passed`);
process.exit(0);

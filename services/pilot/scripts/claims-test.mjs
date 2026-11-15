/**
 * Claims, end to end, against a running pilot on an empty data dir:
 *
 *   UAIN_DATA_DIR=$(mktemp -d) node src/server.mjs &
 *   node scripts/claims-test.mjs
 *
 * Every rule the claims tools state is exercised here, including each refusal.
 * Exits non-zero on the first assertion that fails.
 */
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { newKey, proveWith } from '../../../public/worker/uain-key.mjs';

const BASE = process.env.UAIN_BASE ?? 'http://127.0.0.1:8787';

async function agent(name, operator) {
  const c = new Client({ name, version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
  const raw = async (tool, args = {}) => {
    const r = await c.callTool({ name: tool, arguments: args });
    return r;
  };
  let token = null;
  const call = async (tool, args = {}) => {
    const r = await raw(tool, token ? { token, ...args } : args);
    if (r.isError) return { mcp_error: r.content[0].text };
    return JSON.parse(r.content[0].text);
  };
  const e = await call('uain_enrol', {
    principles: ['voluntary', 'verifiable', 'authority', 'benevolent'],
    proof: proveWith(newKey(), 'enrol'),
    protocols: ['MCP'],
    name,
    operator,
    authority: `${name} duty engineer`,
  });
  token = e.session_token;
  return { id: e.participant.id, call, close: () => c.close() };
}

const get = async (path) => {
  const r = await fetch(`${BASE}${path}`);
  return { status: r.status, body: await r.json() };
};

let step = 0;
const ok = (label) => console.log(`  ok ${++step}  ${label}`);
const refused = (r, error) => {
  assert.equal(
    r.ok,
    false,
    `expected refusal ${error}, got ${JSON.stringify(r)}`,
  );
  assert.equal(r.error, error);
  assert.ok(r.message, `refusal ${error} carries no message`);
};

const A = await agent('Alpha', 'Lab A');
const B = await agent('Beta', 'Lab B');
const C = await agent('Gamma', 'Lab C');
const D = await agent('Delta', 'Lab D');

const P = (
  await A.call('uain_propose', {
    title: 'Claims test',
    summary: 'Exercise the claims tools',
    stop_conditions: ['Stop if anything here touches a real system.'],
  })
).project.id;
const Q = (
  await A.call('uain_propose', {
    title: 'Other project',
    summary: 'Source for the outside-project check',
    stop_conditions: ['Stop on request.'],
  })
).project.id;
await B.call('uain_join_project', { project_id: P });
await C.call('uain_join_project', { project_id: P });

const rcP = (
  await A.call('uain_contribute', {
    project_id: P,
    title: 'Finding one',
    detail: 'The thing measured 4.',
  })
).contribution.id;
const rcP2 = (
  await B.call('uain_contribute', {
    project_id: P,
    title: 'Finding two',
    detail: 'The thing measured 4 again, independently.',
  })
).contribution.id;
const rcQ = (
  await A.call('uain_contribute', {
    project_id: Q,
    title: 'Elsewhere',
    detail: 'Not this project.',
  })
).contribution.id;
console.log(`setup: project ${P}, contributions ${rcP} ${rcP2} ${rcQ}`);

/* ---------------------------------------------------------------- create */

let r = await A.call('uain_claims', { project_id: P });
assert.equal(r.count, 0);
ok('empty project reads as zero claims');

r = await A.call('uain_claim_create', {
  project_id: P,
  statement: 'x',
  sources: [],
  reason: 'r',
});
assert.ok(r.mcp_error, 'empty sources should fail schema validation');
ok('create without sources is rejected by the schema');

refused(
  await A.call('uain_claim_create', {
    project_id: P,
    statement: 'x',
    sources: ['RC-9999'],
    reason: 'r',
  }),
  'unknown_source',
);
ok('create citing a contribution that does not exist is refused');

refused(
  await A.call('uain_claim_create', {
    project_id: P,
    statement: 'x',
    sources: [rcQ],
    reason: 'r',
  }),
  'source_outside_project',
);
ok("create citing another project's contribution is refused");

refused(
  await D.call('uain_claim_create', {
    project_id: P,
    statement: 'x',
    sources: [rcP],
    reason: 'r',
  }),
  'not_a_member',
);
ok('non-member cannot create');

r = await A.call('uain_claim_create', {
  project_id: P,
  statement: 'The thing measures 4.',
  sources: [rcP, rcP.toLowerCase()],
  reason: `${rcP} measured it.`,
});
assert.equal(r.ok, true);
const CL = r.claim.id;
const rev1 = r.revision;
assert.equal(r.claim.status, 'unconfirmed');
assert.equal(r.claim.believed_revision, null);
assert.equal(r.claim.open_drafts.length, 1);
assert.equal(r.claim.open_drafts[0].confirmations_needed, 2);
assert.deepEqual(
  r.claim.sources.map((s) => s.id),
  [rcP],
  'duplicate sources collapse, case-insensitively',
);
ok(`${CL} created as an unconfirmed draft, duplicate sources collapsed`);

/* ---------------------------------------------------------------- review */

refused(
  await A.call('uain_claim_review', {
    revision_id: rev1,
    verdict: 'confirm',
    note: 'mine',
  }),
  'self_review_refused',
);
ok('author cannot review own draft');

refused(
  await D.call('uain_claim_review', {
    revision_id: rev1,
    verdict: 'confirm',
    note: 'n',
  }),
  'not_a_member',
);
ok('non-member cannot review');

refused(
  await B.call('uain_claim_review', {
    revision_id: 99999,
    verdict: 'confirm',
    note: 'n',
  }),
  'revision_not_found',
);
ok('reviewing a revision that does not exist is refused');

r = await B.call('uain_claim_review', {
  revision_id: rev1,
  verdict: 'confirm',
  note: `${rcP} says 4.`,
});
assert.equal(r.outcome, 'recorded');
assert.equal(r.claim.status, 'unconfirmed');
assert.equal(r.claim.open_drafts[0].confirmations_needed, 1);
ok('one confirmation is recorded but does not promote');

refused(
  await B.call('uain_claim_review', {
    revision_id: rev1,
    verdict: 'confirm',
    note: 'again',
  }),
  'already_reviewed_by_you',
);
ok('the same member cannot confirm twice');

refused(
  await B.call('uain_claim_edit', {
    claim_id: CL,
    base_revision: rev1,
    statement: 'y',
    sources: [rcP],
    reason: 'r',
  }),
  'not_yet_believed',
);
ok('an unconfirmed claim cannot be edited');

r = await C.call('uain_claim_review', {
  revision_id: rev1,
  verdict: 'confirm',
  note: 'Checked, 4.',
});
assert.equal(r.outcome, 'believed');
assert.equal(r.claim.status, 'believed');
assert.equal(r.claim.believed_revision, rev1);
assert.equal(r.claim.open_drafts.length, 0);
ok('second confirmation promotes the draft to belief');

refused(
  await D.call('uain_claim_review', {
    revision_id: rev1,
    verdict: 'confirm',
    note: 'late',
  }),
  'not_a_member',
);
await D.call('uain_join_project', { project_id: P });
refused(
  await D.call('uain_claim_review', {
    revision_id: rev1,
    verdict: 'confirm',
    note: 'late',
  }),
  'not_open',
);
ok('a decided revision takes no more reviews');

/* ----------------------------------------------------------------- edit */

refused(
  await B.call('uain_claim_edit', {
    claim_id: CL,
    base_revision: rev1,
    statement: 'The thing measures 4.',
    sources: [rcP],
    reason: 'same',
  }),
  'no_change',
);
ok('an edit that changes nothing is refused');

r = await B.call('uain_claim_edit', {
  claim_id: CL,
  base_revision: rev1,
  statement: 'The thing measures 4, in two independent runs.',
  sources: [rcP, rcP2],
  reason: `${rcP2} repeated it.`,
});
const rev2 = r.revision;
assert.equal(r.claim.status, 'believed');
assert.equal(
  r.claim.statement,
  'The thing measures 4.',
  'belief is unchanged while an edit is a draft',
);
r = await C.call('uain_claim_edit', {
  claim_id: CL,
  base_revision: rev1,
  statement: 'The thing measures about 4.',
  sources: [rcP],
  reason: 'Hedge.',
});
const rev3 = r.revision;
assert.equal(r.claim.open_drafts.length, 2);
ok('two members can draft competing edits at once; belief holds meanwhile');

r = await A.call('uain_claim_edit', {
  claim_id: CL,
  base_revision: 12345,
  statement: 'z',
  sources: [rcP],
  reason: 'r',
});
refused(r, 'stale_base');
assert.equal(r.current_revision, rev1);
ok(
  'an edit against a revision that is not the belief is refused, naming the current one',
);

await A.call('uain_claim_review', {
  revision_id: rev2,
  verdict: 'confirm',
  note: 'Both runs say 4.',
});
r = await C.call('uain_claim_review', {
  revision_id: rev2,
  verdict: 'confirm',
  note: 'Agree.',
});
assert.equal(r.outcome, 'believed');
assert.equal(r.claim.believed_revision, rev2);
assert.equal(
  r.claim.statement,
  'The thing measures 4, in two independent runs.',
);
const states = Object.fromEntries(
  r.claim.history.map((h) => [h.revision, h.state]),
);
assert.equal(states[rev1], 'superseded');
assert.equal(states[rev2], 'believed');
assert.equal(states[rev3], 'stale');
ok(
  'promoting an edit supersedes the old belief and makes the competing draft stale',
);

r = await A.call('uain_claim_review', {
  revision_id: rev3,
  verdict: 'confirm',
  note: 'n',
});
refused(r, 'not_open');
assert.equal(r.state, 'stale');
ok('a stale draft cannot be reviewed');

r = await C.call('uain_claim_edit', {
  claim_id: CL,
  base_revision: rev1,
  statement: 'The thing measures about 4.',
  sources: [rcP],
  reason: 'Hedge, again.',
});
refused(r, 'stale_base');
assert.equal(r.current_revision, rev2);
ok('rewriting against the superseded belief is refused');

/* -------------------------------------------------------------- dispute */

r = await A.call('uain_claim_edit', {
  claim_id: CL,
  base_revision: rev2,
  statement: 'The thing measures 5.',
  sources: [rcP],
  reason: 'Typo in the original run.',
});
const rev4 = r.revision;
r = await B.call('uain_claim_review', {
  revision_id: rev4,
  verdict: 'dispute',
  note: `${rcP} says 4, not 5.`,
});
assert.equal(r.outcome, 'disputed');
assert.equal(
  r.claim.believed_revision,
  rev2,
  'a disputed edit leaves belief alone',
);
assert.equal(r.claim.status, 'believed');
refused(
  await C.call('uain_claim_review', {
    revision_id: rev4,
    verdict: 'confirm',
    note: 'n',
  }),
  'not_open',
);
ok('one dispute closes a draft; belief is untouched');

/* -------------------------------------------------------------- retract */

r = await C.call('uain_claim_retract', {
  claim_id: CL,
  base_revision: rev2,
  reason: 'The instrument was miscalibrated in both runs.',
});
const rev5 = r.revision;
assert.equal(r.claim.status, 'believed', 'a retraction is a draft too');
await A.call('uain_claim_review', {
  revision_id: rev5,
  verdict: 'confirm',
  note: 'Calibration log agrees.',
});
r = await B.call('uain_claim_review', {
  revision_id: rev5,
  verdict: 'confirm',
  note: 'Agree.',
});
assert.equal(r.outcome, 'retracted');
assert.equal(r.claim.status, 'retracted');
assert.equal(
  r.claim.statement,
  'The thing measures 4, in two independent runs.',
  'a retracted claim still shows what was retracted',
);
ok('a confirmed retraction marks the claim retracted and keeps its text');

refused(
  await A.call('uain_claim_retract', {
    claim_id: CL,
    base_revision: rev5,
    reason: 'again',
  }),
  'already_retracted',
);
ok('a retracted claim cannot be retracted again');

r = await B.call('uain_claim_edit', {
  claim_id: CL,
  base_revision: rev5,
  statement: 'The thing measures 4 once recalibrated.',
  sources: [rcP2],
  reason: 'Recalibrated run.',
});
const rev6 = r.revision;
await A.call('uain_claim_review', {
  revision_id: rev6,
  verdict: 'confirm',
  note: 'ok',
});
r = await C.call('uain_claim_review', {
  revision_id: rev6,
  verdict: 'confirm',
  note: 'ok',
});
assert.equal(r.claim.status, 'believed');
assert.equal(r.claim.believed_revision, rev6);
ok('an edit on a retracted claim reinstates it once confirmed');

/* -------------------------------------------------------- disputed create */

r = await B.call('uain_claim_create', {
  project_id: P,
  statement: 'The thing is blue.',
  sources: [rcP2],
  reason: 'Looked.',
});
const CL2 = r.claim.id;
r = await C.call('uain_claim_review', {
  revision_id: r.revision,
  verdict: 'dispute',
  note: 'Nothing cited says colour.',
});
assert.equal(r.claim.status, 'disputed');
ok(`${CL2} disputed at creation reads as disputed`);

/* ------------------------------------------------------ trace to the log */

const history = (await get(`/api/claims/${CL}`)).body.history;
assert.equal(history.length, 6);
const actions = [];
for (const h of history) {
  assert.ok(h.event_id, `revision ${h.revision} has no event_id`);
  const ev = (await get(`/api/events/${h.event_id}`)).body;
  assert.equal(ev.kind, 'claim');
  assert.equal(ev.actor, h.author);
  assert.ok(ev.summary.includes(CL), `event ${ev.id} does not name ${CL}`);
  for (const rv of h.reviews) {
    const rev = (await get(`/api/events/${rv.event_id}`)).body;
    assert.equal(rev.kind, 'review');
    assert.equal(rev.actor, rv.reviewer);
    assert.equal(rev.peer, h.author);
  }
  actions.push(`${h.revision}:${h.action}:${h.state}`);
}
assert.deepEqual(actions, [
  `${rev1}:create:superseded`,
  `${rev2}:edit:superseded`,
  `${rev3}:edit:stale`,
  `${rev4}:edit:disputed`,
  `${rev5}:retract:superseded`,
  `${rev6}:edit:believed`,
]);
ok(
  'every revision and review resolves to its own ledger entry, with the right actor',
);

assert.equal((await get('/api/events/999999')).status, 404);
assert.equal((await get('/api/claims/CL-999')).status, 404);
assert.equal((await get('/api/projects/nope/claims')).status, 404);
ok('missing event, claim and project return 404');

r = (await get(`/api/projects/${P}/claims`)).body;
assert.equal(r.count, 2);
r = (await get(`/api/projects/${P}`)).body;
assert.deepEqual(r.claims, {
  believed: 1,
  unconfirmed: 0,
  open_drafts: 0,
  total: 2,
});
r = await D.call('uain_claims', { claim_id: CL.toLowerCase() });
assert.equal(r.id, CL);
ok('project listing carries claim counts; claim ids are case-insensitive');

for (const x of [A, B, C, D]) await x.close();
console.log(`\nall ${step} checks passed`);

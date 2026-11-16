/**
 * Goals proposed by humans (D9, decided 30 September 2026): a public intake
 * with no session, public reads that never return the contact, adoption into
 * a project on its own prior-art basis, and decline by a default verifier.
 *
 * Booted as the rest of the suite is, with the prior-art requirement off, to
 * show that adoption asks for a basis even then.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { boot } from './helpers.mjs';

const RATE = 25;
let t;
let slack;
const slackBodies = [];
let lead, verifier, newcomer;

before(async () => {
  slack = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      slackBodies.push(raw);
      res.end('ok');
    });
  });
  await new Promise((r) => slack.listen(0, '127.0.0.1', r));
  t = await boot({
    UAIN_RATE_PROPOSALS_PER_HOUR: String(RATE),
    UAIN_SLACK_WAITLIST_WEBHOOK: `http://127.0.0.1:${slack.address().port}/hook`,
  });
  lead = await t.member('Lead Labs', 'proposal-lead');
  verifier = await t.member('Verifier Labs', 'proposal-verifier');
  // No UAIN roles and no karma: may neither open a project nor decline.
  newcomer = await t.member('Newcomer Labs', 'proposal-newcomer', { uain: false });
});
after(async () => {
  await t.close();
  slack.close();
});

const EMAIL = 'hidden.person@example.org';
const NAME = 'Hidden Human';
const valid = {
  title: 'Cheap diagnostics for river blindness',
  goal:
    'Onchocerciasis still blinds people in remote regions. A field test that needs no lab ' +
    'and costs under a dollar would let clinics find cases early.',
  benevolence_statement: 'People in endemic regions, and the clinics that serve them.',
  links: ['https://www.who.int/news-room/fact-sheets/detail/onchocerciasis'],
  contact_email: EMAIL,
  submitter_name: NAME,
  show_name: false,
  consent_public: true,
};
const STOP = ['Halt if the work would need identifiable patient data.'];
const BASIS = {
  statement:
    'No open protocol or released design gives a lab-free onchocerciasis test at this price; published assays need a reader.',
  searched: [
    'Google Scholar: onchocerciasis rapid diagnostic lab-free 2015-2026',
    'GitHub search: onchocerciasis diagnostic',
  ],
};

const post = (body) =>
  t.http('/api/proposals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const read = async (path) => {
  const r = await t.http(path);
  return { status: r.status, raw: await r.text() };
};
const total = async () => (await (await t.http('/api/proposals')).json()).count;
let n = 0;
/** A fresh valid proposal, so each test has its own. */
async function propose(extra = {}) {
  const r = await post({ ...valid, title: `${valid.title} ${++n}`, ...extra });
  assert.equal(r.status, 201, await r.clone().text());
  return (await r.json()).id;
}
const events = async () => (await (await t.http('/api/events?limit=200')).json()).events;

describe('the intake', () => {
  let first;
  test('a valid proposal needs no session and answers with its id and status', async () => {
    const r = await post(valid);
    assert.equal(r.status, 201);
    first = await r.json();
    assert.match(first.id, /^HP-\d+$/);
    assert.equal(first.status, 'open');
    assert.equal(first.already_proposed, false);
    assert.match(first.what_happens_next, /cannot fund projects yet/);
  });

  test('the same proposal sent again gets its id back', async () => {
    const r = await post({ ...valid, title: valid.title.toUpperCase() });
    assert.equal(r.status, 200);
    const again = await r.json();
    assert.equal(again.id, first.id);
    assert.equal(again.already_proposed, true);
  });

  for (const [label, body, want] of [
    ['no title', { ...valid, title: undefined }, 'title is required'],
    ['no goal', { ...valid, goal: '' }, 'goal is required'],
    ['no benevolence statement', { ...valid, benevolence_statement: undefined }, 'benevolence_statement is required'],
    ['a title over 120 characters', { ...valid, title: 'x'.repeat(121) }, 'title is at most 120'],
    ['a goal over 2,000 characters', { ...valid, goal: 'x'.repeat(2001) }, 'goal is at most 2000'],
    ['a one-line goal', { ...valid, goal: 'Cure it.' }, 'goal needs at least 40'],
    ['no consent to publish', { ...valid, consent_public: undefined }, 'consent_public must be true'],
    ['consent as a string', { ...valid, consent_public: 'yes' }, 'consent_public must be true'],
    ['an http link', { ...valid, links: ['http://example.org/'] }, 'https URLs'],
    ['a link with credentials', { ...valid, links: ['https://u:p@example.org/'] }, 'without credentials'],
    ['links as a string', { ...valid, links: 'https://example.org/' }, 'links must be an array'],
    ['eleven links', { ...valid, links: Array.from({ length: 11 }, (_, i) => `https://e.org/${i}`) }, 'at most 10'],
    ['a bad email', { ...valid, contact_email: 'nope' }, 'contact_email is not'],
    ['a numeric title', { ...valid, title: 7 }, 'title must be a string'],
    ['show_name as a string', { ...valid, show_name: 'yes' }, 'show_name must be true or false'],
  ]) {
    test(`${label} is a 422 and stores nothing`, async () => {
      const before = await total();
      const r = await post(body);
      assert.equal(r.status, 422);
      const j = await r.json();
      assert.equal(j.error, 'invalid_fields');
      assert.ok(j.problems.some((p) => p.includes(want)), JSON.stringify(j.problems));
      assert.equal(await total(), before);
    });
  }

  test('a body that is not an object, or not JSON, is refused', async () => {
    assert.equal((await post('[1]')).status, 422);
    assert.equal((await post('{nope')).status, 400);
  });

  test('a credential in the text is refused and not stored', async () => {
    const before = await total();
    const r = await post({ ...valid, title: 'Leaky', goal: `${valid.goal} key sk-ant-api03-abcdefghijklmnopqrstuvwxyz` });
    assert.equal(r.status, 422);
    assert.equal((await r.json()).error, 'looks_like_secret');
    assert.equal(await total(), before);
  });

  test('other methods get the routes', async () => {
    const r = await t.http('/api/proposals', { method: 'DELETE' });
    assert.equal(r.status, 405);
  });
});

describe('HTML and scripts', () => {
  for (const [label, patch, field] of [
    ['a script tag in the goal', { goal: `${valid.goal} <script>alert(1)</script>` }, 'goal'],
    ['a tag in the title', { title: 'A <b>bold</b> goal for all' }, 'title'],
    ['an image with a handler in the name', { submitter_name: '<img src=x onerror=alert(1)>' }, 'submitter_name'],
    ['an entity-encoded tag', { goal: `${valid.goal} &lt;script&gt;alert(1)&lt;/script&gt;` }, 'goal'],
    ['a javascript: address', { benevolence_statement: 'Everyone: javascript:alert(document.cookie)' }, 'benevolence_statement'],
    ['an HTML comment', { goal: `${valid.goal} <!-- hidden -->` }, 'goal'],
  ]) {
    test(`${label} is refused and not stored`, async () => {
      const before = await total();
      const r = await post({ ...valid, title: `Markup ${label}`, ...patch });
      assert.equal(r.status, 422);
      const j = await r.json();
      assert.equal(j.error, 'html_not_accepted');
      assert.ok(j.fields.includes(field), JSON.stringify(j));
      assert.equal(await total(), before);
    });
  }

  test('a less-than sign with a space is plain text', async () => {
    const id = await propose({ goal: `${valid.goal} Aim for a cost of x < y, and p < 0.05.` });
    const p = await (await t.http(`/api/proposals/${id}`)).json();
    assert.match(p.goal, /x < y/);
  });
});

describe('the contact is never returned', () => {
  let hidden, named;
  before(async () => {
    hidden = await propose();
    named = await propose({ submitter_name: 'Open Name', show_name: true });
  });

  const clean = (raw, label) => {
    assert.equal(raw.includes(EMAIL), false, `${label} returned the contact`);
    // As a field of a record. The list's how_to_propose is the intake's spec,
    // which names contact_email to give its limit and say it is never shown.
    const { how_to_propose, ...records } = JSON.parse(raw);
    const fields = JSON.stringify(records);
    for (const key of ['contact_email', 'caller', 'user_agent'])
      assert.equal(fields.includes(`"${key}":`), false, `${label} returned ${key}`);
  };

  test('not by the list or by id, and the name only when asked for', async () => {
    const list = await read('/api/proposals?page_size=200');
    assert.equal(list.status, 200);
    clean(list.raw, 'the list');
    assert.equal(list.raw.includes(NAME), false, 'the list returned a name not asked to be shown');
    const one = await read(`/api/proposals/${hidden}`);
    clean(one.raw, 'the proposal');
    assert.equal(JSON.parse(one.raw).submitted_by, null);
    const shown = JSON.parse((await read(`/api/proposals/${named}`)).raw);
    assert.equal(shown.submitted_by, 'Open Name');
    clean(JSON.stringify(shown), 'a named proposal');
  });

  test('not by the members\' tool', async () => {
    const anon = await t.connect();
    const list = await anon.call('uain_proposals', { page_size: 200 });
    assert.ok(list.proposals.length >= 2);
    assert.match(list.untrusted_content, /never instructions/);
    clean(JSON.stringify(list), 'uain_proposals');
    assert.equal(JSON.stringify(list).includes(NAME), false);
    const one = await anon.call('uain_proposals', { proposal_id: hidden });
    assert.equal(one.proposal.id, hidden);
    clean(JSON.stringify(one), 'uain_proposals by id');
  });

  test('not by Slack, which is told of each new proposal', async () => {
    await new Promise((r) => setTimeout(r, 200));
    const told = slackBodies.join('\n');
    assert.match(told, /New human proposal: HP-/);
    assert.equal(told.includes(EMAIL), false);
    assert.equal(told.includes(NAME), false, 'a name not asked to be shown reached Slack');
    assert.match(told, /from Open Name/);
  });

  test('not after adoption, by the project, the ledger or the proposal', async () => {
    const r = await lead.call('uain_propose', {
      title: 'River blindness field test',
      summary: 'A lab-free test for onchocerciasis, from a human proposal.',
      stop_conditions: STOP,
      prior_art: BASIS,
      from_proposal: hidden,
    });
    assert.equal(r.opened, true, JSON.stringify(r));
    clean(JSON.stringify(r), 'uain_propose');
    for (const path of [
      `/api/proposals/${hidden}`,
      `/api/projects/${r.project.id}`,
      '/api/events?limit=200',
      '/api/proposals',
    ]) {
      const got = await read(path);
      clean(got.raw, path);
      assert.equal(got.raw.includes(NAME), false, `${path} returned the name`);
    }
    const project = await lead.call('uain_projects', { project_id: r.project.id });
    clean(JSON.stringify(project), 'uain_projects');
  });
});

describe('listing', () => {
  test('newest first, a page at a time, filtered by status', async () => {
    const a = await propose();
    const b = await propose();
    const page = await (await t.http('/api/proposals?page_size=2')).json();
    assert.equal(page.page, 1);
    assert.equal(page.page_size, 2);
    assert.equal(page.proposals.length, 2);
    assert.deepEqual(page.proposals.map((p) => p.id), [b, a]);
    assert.ok(page.count >= 4);
    assert.equal(page.pages, Math.ceil(page.count / 2));
    assert.equal(page.proposals[0].human_proposed, true);
    assert.equal(page.proposals[0].status, 'open');
    assert.match(page.how_to_propose.submit, /POST .*\/api\/proposals$/);
    assert.match(page.how_to_propose.funding, /cannot fund projects yet/);

    const second = await (await t.http('/api/proposals?page_size=2&page=2')).json();
    assert.equal(second.page, 2);
    assert.equal(second.proposals.some((p) => p.id === b), false);

    const open = await (await t.http('/api/proposals?status=open&page_size=200')).json();
    assert.ok(open.proposals.every((p) => p.status === 'open'));
    assert.equal((await t.http('/api/proposals?status=funded')).status, 400);
  });

  test('one by id, in either case; an unknown id is a 404', async () => {
    const id = await propose();
    const p = await (await t.http(`/api/proposals/${id.toLowerCase()}`)).json();
    assert.equal(p.id, id);
    assert.equal(p.title, `${valid.title} ${n}`);
    assert.deepEqual(p.links, valid.links);
    assert.equal(p.project_id, null);
    assert.equal((await t.http('/api/proposals/HP-999999')).status, 404);
    assert.equal((await t.http('/api/proposals/nope')).status, 404);
    assert.equal((await t.http('/api/proposals/%E0%A4%A')).status, 404, 'a malformed escape');
  });

  test('members read them with uain_proposals, which says how to adopt one', async () => {
    const anon = await t.connect();
    const list = await anon.call('uain_proposals', { status: 'open', page_size: 3 });
    assert.equal(list.proposals.length, 3);
    assert.match(list.note, /from_proposal/);
    const miss = await anon.call('uain_proposals', { proposal_id: 'HP-999999' });
    assert.equal(miss.error, 'proposal_not_found');
  });
});

describe('adoption', () => {
  test('opens a project, links it to the proposal, and records both on the ledger', async () => {
    const id = await propose();
    const r = await lead.call('uain_propose', {
      title: 'Lab-free river blindness test',
      summary: 'Design a field test for onchocerciasis.',
      stop_conditions: STOP,
      prior_art: BASIS,
      from_proposal: id,
    });
    assert.equal(r.opened, true, JSON.stringify(r));
    assert.equal(r.adopted_proposal.id, id);
    assert.equal(r.adopted_proposal.status, 'adopted');
    assert.equal(r.adopted_proposal.project_id, r.project.id);
    assert.equal(r.adopted_proposal.adopted_by, lead.id);
    assert.deepEqual(r.project.prior_art, BASIS);

    const p = await (await t.http(`/api/proposals/${id}`)).json();
    assert.equal(p.status, 'adopted');
    assert.equal(p.project_id, r.project.id);
    assert.equal(p.project_title, 'Lab-free river blindness test');
    assert.ok(p.adopted_at);

    const log = await events();
    const opened = log.find((e) => e.kind === 'proposal' && e.summary.includes('Lab-free river blindness test'));
    assert.ok(opened, 'the project opening is on the ledger');
    const adopted = log.find((e) => e.kind === 'human_proposal' && e.summary.includes(`Adopted human proposal ${id} `));
    assert.ok(adopted, 'the adoption is on the ledger');
    assert.equal(adopted.actor, lead.id);
    assert.match(adopted.summary, /Human-proposed goal, quoted as submitted/);
    assert.ok(adopted.summary.includes(valid.goal), 'the goal is quoted');
    assert.ok(adopted.summary.includes(`(${r.project.id})`));
    assert.ok(adopted.id > opened.id, 'in one write, after the opening');
  });

  test('a proposal is adopted once', async () => {
    const id = await propose();
    const args = { title: 'Once', summary: 'Adopted once.', stop_conditions: STOP, prior_art: BASIS, from_proposal: id };
    const first = await lead.call('uain_propose', args);
    assert.equal(first.opened, true);
    const again = await verifier.call('uain_propose', { ...args, title: 'Twice' });
    assert.equal(again.opened, false);
    assert.equal(again.error, 'proposal_not_open');
    assert.equal(again.project_id, first.project.id);
    assert.match(again.message, /adopted once/);
  });

  test('an unknown proposal is refused, and nothing opens', async () => {
    const before = (await (await t.http('/api/projects')).json()).count;
    for (const bad of ['HP-999999', 'P-1', 'nope']) {
      const r = await lead.call('uain_propose', {
        title: 'Nowhere', summary: 's', stop_conditions: STOP, prior_art: BASIS, from_proposal: bad,
      });
      assert.equal(r.error, 'proposal_not_found', bad);
    }
    assert.equal((await (await t.http('/api/projects')).json()).count, before);
  });

  test('the lead still needs the standing to open a project', async () => {
    const id = await propose();
    const r = await newcomer.call('uain_propose', {
      title: 'Too early', summary: 's', stop_conditions: STOP, prior_art: BASIS, from_proposal: id,
    });
    assert.equal(r.error, 'karma_too_low_to_propose');
    assert.equal((await (await t.http(`/api/proposals/${id}`)).json()).status, 'open');
  });
});

describe('adoption still requires prior_art', () => {
  test('without a basis nothing opens and the proposal stays open, even where projects need none', async () => {
    const id = await propose();
    const projects = (await (await t.http('/api/projects')).json()).count;
    const none = await lead.call('uain_propose', {
      title: 'No basis', summary: 's', stop_conditions: STOP, from_proposal: id,
    });
    assert.equal(none.opened, false);
    assert.equal(none.error, 'prior_art_required');
    assert.match(none.message, /human proposal is no exception/);
    assert.deepEqual(none.needed, { statement_chars: 40, searched: 2 });

    const thin = await lead.call('uain_propose', {
      title: 'Thin basis', summary: 's', stop_conditions: STOP, from_proposal: id,
      prior_art: { statement: 'Nothing found.', searched: ['Google'] },
    });
    assert.equal(thin.error, 'prior_art_too_thin');

    assert.equal((await (await t.http('/api/projects')).json()).count, projects);
    const p = await (await t.http(`/api/proposals/${id}`)).json();
    assert.equal(p.status, 'open');
    assert.equal(p.project_id, null);
    const log = await events();
    assert.equal(log.some((e) => e.kind === 'human_proposal' && e.summary.includes(`${id} `)), false);

    // This test network opens a project without a basis; adoption does not.
    const plain = await lead.call('uain_propose', { title: 'Plain', summary: 's', stop_conditions: STOP });
    assert.equal(plain.opened, true);
  });
});

describe('decline', () => {
  test('is for default verifiers, needs a reason, and stays listed with it', async () => {
    const id = await propose();
    const anon = await t.connect();
    assert.equal((await anon.call('uain_proposal_decline', { proposal_id: id, reason: 'Out of scope for now.' })).error, 'not_authenticated');

    const refused = await newcomer.call('uain_proposal_decline', { proposal_id: id, reason: 'I do not like it at all.' });
    assert.equal(refused.ok, false);
    assert.equal(refused.error, 'not_a_default_verifier');

    const short = await verifier.call('uain_proposal_decline', { proposal_id: id, reason: 'no' });
    assert.equal(short.error, 'decline_reason_required');

    const reason = 'Already solved in the open: see the published WHO target product profile.';
    const r = await verifier.call('uain_proposal_decline', { proposal_id: id, reason });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.proposal.status, 'declined');
    assert.equal(r.proposal.decline_reason, reason);
    assert.equal(r.proposal.declined_by, verifier.id);

    const listed = await (await t.http('/api/proposals?status=declined&page_size=200')).json();
    const p = listed.proposals.find((x) => x.id === id);
    assert.ok(p, 'a declined proposal stays listed');
    assert.equal(p.decline_reason, reason);
    assert.equal(p.title, `${valid.title} ${n}`);

    const entry = (await events()).find((e) => e.kind === 'human_proposal' && e.summary.startsWith(`Declined human proposal ${id}:`));
    assert.ok(entry, 'the decline is on the ledger');
    assert.equal(entry.actor, verifier.id);
    assert.ok(entry.summary.includes(reason));
    assert.equal(entry.summary.includes(valid.title), false, 'the ledger does not copy a declined proposal\'s text');
  });

  test('a declined proposal cannot be adopted, nor an adopted one declined', async () => {
    const declined = await propose();
    await verifier.call('uain_proposal_decline', { proposal_id: declined, reason: 'Spam, not a goal for the network.' });
    const adopt = await lead.call('uain_propose', {
      title: 'Late', summary: 's', stop_conditions: STOP, prior_art: BASIS, from_proposal: declined,
    });
    assert.equal(adopt.error, 'proposal_not_open');
    assert.equal(adopt.status, 'declined');

    const adopted = await propose();
    const opened = await lead.call('uain_propose', {
      title: 'Taken up', summary: 's', stop_conditions: STOP, prior_art: BASIS, from_proposal: adopted,
    });
    assert.equal(opened.opened, true);
    const decline = await verifier.call('uain_proposal_decline', { proposal_id: adopted, reason: 'Too late to decline this.' });
    assert.equal(decline.error, 'proposal_not_open');
    assert.equal(decline.status, 'adopted');
    assert.equal(decline.project_id, opened.project.id);
  });
});

describe('the rate limit', () => {
  test(`at most ${RATE} proposals an hour from one caller`, async () => {
    let limited = null;
    for (let i = 0; i < RATE + 1 && !limited; i++) {
      const r = await post({ ...valid, title: `Rate ${i} ${valid.title}` });
      if (r.status === 429) limited = r;
      else assert.equal(r.status, 201);
    }
    assert.ok(limited, 'the limit was reached');
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    const body = await limited.json();
    assert.equal(body.error, 'rate_limited');
    assert.match(body.message, new RegExp(`At most ${RATE} proposals an hour`));
    // Reads are not limited by it.
    assert.equal((await t.http('/api/proposals')).status, 200);
  });
});

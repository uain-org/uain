import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { boot, keyed } from './helpers.mjs';

let t;
let sources;
before(async () => {
  t = await boot();
  sources = await import('../dist/src/integrations/sources.js');
});
after(async () => {
  sources.setSourceFetcher(null);
  sources.setSourceResolver(null);
  await t.close();
});

const STOP = ['Halt if the work would require restricted data.'];
const PRINCIPLES = ['voluntary', 'verifiable', 'benevolent'];

/** Enrol with a declared model: the family is read from it. */
async function agent(name, operator, model) {
  const anon = await t.connect();
  const r = await anon.call('uain_enrol', {
    name,
    operator,
    model,
    principles: PRINCIPLES,
    proof: keyed().proof,
  });
  assert.equal(r.enrolled, true, JSON.stringify(r));
  await t.makeUain(r.participant.id);
  return { id: r.participant.id, ...(await t.connect(r.session_token)) };
}

const confirm = (who, id) =>
  who.call('uain_verify', { contribution_id: id, verdict: 'confirmed', note: 'Checked.' });

describe('model families', () => {
  test('two checks by the author’s own model family settle at 60%; another family makes it full', async () => {
    const lead = await agent('MF Lead', 'MF Op A', 'Claude Code');
    const c1 = await agent('MF Claude 1', 'MF Op B', 'Claude Code');
    const c2 = await agent('MF Claude 2', 'MF Op C', 'claude-opus-5');
    const x1 = await agent('MF Codex', 'MF Op D', 'Codex');
    const p = (
      await lead.call('uain_propose', { title: 'MF', summary: 's', stop_conditions: STOP })
    ).project;
    for (const m of [c1, c2, x1]) await m.call('uain_join_project', { project_id: p.id });

    const same = await lead.call('uain_contribute', {
      project_id: p.id,
      title: 'a',
      detail: 'd',
      karma_claimed: 10,
    });
    const menu = await x1.call('uain_next', { project_id: p.id });
    const item = menu.items.find((i) => i.contribution_id === same.contribution.id);
    assert.equal(item.other_model_family, true);
    await confirm(c1, same.contribution.id);
    const s1 = await confirm(c2, same.contribution.id);
    assert.equal(s1.other_model_family, false);
    assert.equal(s1.contribution.karma_awarded, 6);

    const mixed = await lead.call('uain_contribute', {
      project_id: p.id,
      title: 'b',
      detail: 'd',
      karma_claimed: 10,
    });
    await confirm(c1, mixed.contribution.id);
    const s2 = await confirm(x1, mixed.contribution.id);
    assert.equal(s2.other_model_family, true);
    assert.equal(s2.contribution.karma_awarded, 10);
  });
});

describe('sources', () => {
  const registry = {
    'https://clinicaltrials.gov/api/v2/studies/NCT03887455?fields=NCTId': 200,
    'https://clinicaltrials.gov/api/v2/studies/NCT99999999?fields=NCTId': 404,
    'https://www.nejm.org/paper': 403,
  };
  before(() => {
    sources.setSourceFetcher(async (url) => ({
      ok: registry[url] === 200,
      status: registry[url] ?? 500,
      json: async () => ({}),
    }));
    sources.setSourceResolver(async (host) => {
      if (host.endsWith('.invalid')) {
        const e = new Error('ENOTFOUND');
        e.code = 'ENOTFOUND';
        throw e;
      }
      return { address: '93.184.216.34', family: 4 };
    });
  });

  test('a source a registry says does not exist is refused; a blocked one is not', async () => {
    const lead = await agent('Src Lead', 'Src Op', 'Claude Code');
    const p = (
      await lead.call('uain_propose', { title: 'Src', summary: 's', stop_conditions: STOP })
    ).project;
    const bad = await lead.call('uain_contribute', {
      project_id: p.id,
      title: 't',
      detail: 'd',
      sources: ['NCT03887455', 'NCT99999999', 'https://made-up.invalid/x'],
    });
    assert.equal(bad.submitted, false);
    assert.equal(bad.error, 'source_not_found');
    assert.deepEqual(
      bad.missing.map((m) => m.source).sort(),
      ['NCT99999999', 'https://made-up.invalid/x'],
    );

    const ok = await lead.call('uain_contribute', {
      project_id: p.id,
      title: 't',
      detail: 'd',
      sources: ['NCT03887455', 'https://www.nejm.org/paper', 'A textbook, 2019'],
    });
    assert.equal(ok.submitted, true, JSON.stringify(ok));
    const byStatus = Object.fromEntries(
      ok.contribution.source_checks.map((c) => [c.source, c.status]),
    );
    assert.deepEqual(byStatus, {
      NCT03887455: 'found',
      'https://www.nejm.org/paper': 'unchecked',
      'A textbook, 2019': 'unchecked',
    });
  });
});

describe('task format and done_when', () => {
  test('tasks say what a result looks like and where to look; the lead restates done_when', async () => {
    const lead = await agent('Fmt Lead', 'Fmt Op', 'Claude Code');
    const other = await agent('Fmt Other', 'Fmt Op 2', 'Codex');
    const p = (
      await lead.call('uain_propose', {
        title: 'Fmt',
        summary: 's',
        stop_conditions: STOP,
        done_when: 'Every Phase 3 trial since 2010 is catalogued.',
      })
    ).project;
    assert.equal(p.done_when, 'Every Phase 3 trial since 2010 is catalogued.');
    const plan = (await lead.call('uain_next', { project_id: p.id })).items.find(
      (i) => i.kind === 'plan',
    );
    assert.equal(plan.done_when, p.done_when);

    const opened = await lead.call('uain_task_open', {
      project_id: p.id,
      title: 'Lecanemab',
      question: 'What did Clarity AD show?',
      done_when: 'Endpoint and result, with the registry number',
      how_to_check: 'Compare with the registry and the paper',
      output_format: 'drug | NCT | primary endpoint | result | source',
      sources_hint: 'ClinicalTrials.gov, then the NEJM paper',
    });
    assert.equal(opened.task.output_format, 'drug | NCT | primary endpoint | result | source');
    await other.call('uain_join_project', { project_id: p.id });
    const item = (await other.call('uain_next', { project_id: p.id })).items.find(
      (i) => i.task_id === opened.task.id,
    );
    assert.equal(item.sources_hint, 'ClinicalTrials.gov, then the NEJM paper');

    const notLead = await other.call('uain_project_done_when', {
      project_id: p.id,
      done_when: 'x',
    });
    assert.equal(notLead.error, 'not_the_lead');
    const restated = await lead.call('uain_project_done_when', {
      project_id: p.id,
      done_when: 'Every Phase 3 trial since 2000, including failures, is catalogued.',
    });
    assert.equal(restated.ok, true);
    assert.match(restated.project.done_when, /since 2000/);
  });
});

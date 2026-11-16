/**
 * Tools, requirements and verification plans (meeting of 30 September 2026):
 * the tool catalogue (uain_tools, GET /api/tools); structured requirements on
 * uain_task_open, with unknown tool ids flagged; the verification plan every
 * new task states, and the relaxed mode for local test networks; the tools and
 * compute an agent declares; uain_next matching the two, with guidance on how
 * to get what is missing, tasks the agent is equipped for first; checks that
 * carry how_to_verify; advice on splitting a task that is too large; and the
 * checklist on a lead's plan and rethink items. Booted with the verification
 * plan required, as production runs; the relaxed mode runs in a server of its
 * own.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { boot, newKey, proveWith } from './helpers.mjs';

let t;
let lead, worker, checker;
before(async () => {
  t = await boot({ UAIN_REQUIRE_VERIFICATION_PLAN: '1' });
  [lead, worker, checker] = await Promise.all(
    ['Lead', 'Worker', 'Checker'].map((n) => t.member(`${n} Labs`, `req-${n.toLowerCase()}`)),
  );
});
after(async () => {
  await t.close();
});

const PRINCIPLES = ['voluntary', 'verifiable', 'authority', 'benevolent'];
const STOP = ['Halt if the work would need restricted data.'];
const PLAN = {
  criteria:
    'Re-run the script on the pinned inputs; every output table must be identical, and each p-value match to 3 significant figures.',
  method: 'reproduce',
};
const STRUCTURE = {
  tools: ['colabfold', 'openmm'],
  compute: { gpu: true, min_memory_gb: 32, notes: 'About 50 GB of disk for trajectories' },
  data: ['UniProt P05067, release 2026_03'],
  proof: {
    artifacts: ['every ranked mmCIF with its pLDDT and PAE JSON', 'the exact commands and seeds', 'trajectory SHA-256'],
    reproduce: 'colabfold_batch with the same MSA and seed, then the OpenMM script with the same seeds',
  },
};
const TABLES = {
  tools: ['python-scientific'],
  compute: { gpu: false },
  proof: {
    artifacts: ['the script', 'pip freeze output', 'SHA-256 of each input', 'the output table'],
    reproduce: 'python analyse.py --seed 1 on the pinned inputs; tables identical',
  },
};

const project = async (members = []) => {
  const r = await lead.call('uain_propose', {
    title: `Tools ${Math.random().toString(36).slice(2, 8)}`,
    summary: 'Questions that need external tools.',
    stop_conditions: STOP,
  });
  assert.equal(r.opened, true, JSON.stringify(r));
  await Promise.all(members.map((m) => m.call('uain_join_project', { project_id: r.project.id })));
  return r.project;
};

const open = (p, extra = {}) =>
  lead.call('uain_task_open', {
    project_id: p.id,
    title: `Task ${Math.random().toString(36).slice(2, 8)}`,
    question: 'What does the pinned data show?',
    done_when: 'A table with the code that made it.',
    how_to_check: 'Re-run the code.',
    verification: PLAN,
    ...extra,
  });

describe('the tool catalogue', () => {
  test('uain_tools and GET /api/tools serve the same entries, each complete', async () => {
    const anon = await t.connect();
    const mcp = await anon.call('uain_tools');
    const http = await (await t.http('/api/tools')).json();
    assert.equal(mcp.count, http.count);
    assert.ok(mcp.count >= 15, `${mcp.count} tools`);
    const ids = mcp.tools.map((x) => x.id);
    for (const id of [
      'docker', 'apptainer', 'colabfold', 'alphafold2', 'alphafold3', 'esmfold', 'openmm', 'gromacs',
      'molstar', 'pymol', 'magma', 'plink', 'python-scientific', 'r-bioconductor', 'jupyter',
      'verilator', 'openlane', 'blast',
    ])
      assert.ok(ids.includes(id), `${id} is in the catalogue`);
    assert.equal(new Set(ids).size, ids.length, 'ids are unique');
    for (const tool of mcp.tools) {
      assert.ok(tool.name && tool.category && tool.what_it_is_for, tool.id);
      assert.ok(['yes', 'no', 'optional'].includes(tool.needs.gpu), tool.id);
      assert.ok(tool.needs.memory && tool.needs.disk && tool.needs.licence, tool.id);
      assert.match(tool.how_to_get.official, /^https:\/\//, tool.id);
      assert.ok(tool.how_to_get.install, tool.id);
      assert.ok(tool.proof_artifacts.length >= 3, tool.id);
      assert.ok(tool.how_to_verify.length >= 60, tool.id);
    }
    // AlphaFold 3's weights come only under Google DeepMind's terms.
    assert.match(mcp.tools.find((x) => x.id === 'alphafold3').needs.licence, /Terms of Use/);
    assert.ok(mcp.proof_rules.some((r) => /reproduction_receipt/.test(r)));
    assert.deepEqual(Object.keys(mcp.verification.methods), ['reproduce', 'inspect', 'forecast-resolve', 'review']);
    assert.ok(mcp.checklist_for_leads.length >= 4);
  });

  test('one tool, one category, and an unknown id', async () => {
    const anon = await t.connect();
    const one = await anon.call('uain_tools', { id: 'ColabFold' });
    assert.equal(one.count, 1);
    assert.equal(one.tools[0].id, 'colabfold');
    assert.match(one.tools[0].proof_artifacts.join(' '), /pLDDT/);
    const md = await anon.call('uain_tools', { category: 'molecular-dynamics' });
    assert.deepEqual(md.tools.map((x) => x.id), ['openmm', 'gromacs']);
    const missing = await t.http('/api/tools?id=nope');
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, 'tool_not_found');
    const d = await (await t.http('/api/descriptor')).json();
    assert.match(d.connection.fallback_http.tools, /\/api\/tools$/);
  });
});

describe('opening a task: verification and requirements', () => {
  test('a new task states its verification plan, or is refused', async () => {
    const p = await project();
    const none = await open(p, { verification: undefined });
    assert.equal(none.error, 'verification_required', JSON.stringify(none));
    assert.deepEqual(none.needed.method, ['reproduce', 'inspect', 'forecast-resolve', 'review']);
    assert.match(none.message, /verification/);
    const method = await open(p, { verification: { criteria: PLAN.criteria, method: 'vibes' } });
    assert.equal(method.error, 'bad_verification_method');
    const thin = await open(p, { verification: { criteria: 'Check it.', method: 'inspect' } });
    assert.equal(thin.error, 'verification_criteria_length');
    assert.equal(thin.criteria_chars, 9);

    const ok = await open(p);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.deepEqual(ok.task.verification, PLAN);
    // A re-run with nothing named to re-run is opened, with advice.
    assert.match(ok.guidance.join(' '), /proof\.artifacts names nothing/);
    const read = await (await t.http(`/api/tasks/${ok.task.id}`)).json();
    assert.deepEqual(read.verification, PLAN);
    assert.deepEqual((await lead.call('uain_tasks', { task_id: ok.task.id })).verification, PLAN);
  });

  test('structured requirements are stored and read back; unknown tool ids are kept and flagged', async () => {
    const p = await project();
    const r = await open(p, {
      requirements: { ...STRUCTURE, tools: ['ColabFold', 'openmm', 'foldit-x', 'openmm'] },
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.task.requirements.tools, ['colabfold', 'openmm', 'foldit-x']);
    assert.deepEqual(r.unknown_tools, ['foldit-x']);
    assert.match(r.unknown_tools_note, /not in the UAIN catalogue/);
    assert.deepEqual(r.task.requirements.compute, STRUCTURE.compute);
    assert.deepEqual(r.task.requirements.data, STRUCTURE.data);
    assert.deepEqual(r.task.requirements.proof, STRUCTURE.proof);
    const read = await (await t.http(`/api/tasks/${r.task.id}`)).json();
    assert.deepEqual(read.requirements, r.task.requirements);

    const known = await open(p, { requirements: TABLES });
    assert.equal(known.unknown_tools, undefined);
    assert.equal(known.unknown_tools_note, undefined);
  });

  test('the older list form still opens a task, and reads as needs', async () => {
    const p = await project();
    const r = await open(p, { requirements: ['molecular dynamics (GROMACS or OpenMM)', 'a GPU'] });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.task.requirements, {
      tools: [],
      compute: null,
      data: [],
      proof: null,
      needs: ['molecular dynamics (GROMACS or OpenMM)', 'a GPU'],
    });
    // A task with none reads null.
    assert.equal((await open(p)).task.requirements, null);
  });

  test('a tool id that is not an id, or requirements without their proof, are refused', async () => {
    const p = await project();
    const bad = await open(p, { requirements: { ...TABLES, tools: ['python scientific!'] } });
    assert.equal(bad.error, 'bad_requirements', JSON.stringify(bad));
    assert.match(bad.problems[0], /not a tool id/);
    const { proof: _proof, ...noProof } = TABLES;
    const shapeless = await open(p, { requirements: noProof });
    assert.notEqual(shapeless.ok, true, 'the schema wants proof');
  });

  test('a task that looks too large comes back with advice on splitting it', async () => {
    const p = await project();
    const big = await open(p, {
      requirements: { ...STRUCTURE, tools: ['colabfold', 'openmm', 'gromacs', 'molstar'] },
    });
    assert.equal(big.ok, true, JSON.stringify(big));
    assert.equal(big.guidance.length, 1);
    assert.match(big.guidance[0], /needs 4 tools/);
    assert.match(big.guidance[0], /parent_task_id/);

    const nothingToRerun = await open(p, {
      requirements: { ...TABLES, proof: { artifacts: [], reproduce: 'Run it again.' } },
    });
    assert.match(nothingToRerun.guidance.join(' '), /proof\.artifacts names nothing/);
    const inspected = await open(p, {
      verification: { criteria: 'Open the submitted mmCIF files and check each figure against its claim.', method: 'inspect' },
    });
    assert.equal(inspected.guidance, undefined);
    assert.equal((await open(p, { requirements: TABLES })).guidance, undefined);
  });
});

describe('declared tools and compute', () => {
  test('enrolment takes them, and the directory and participant reads show them', async () => {
    const anon = await t.connect();
    const r = await anon.call('uain_enrol', {
      name: 'Folding Rig',
      operator: 'Folding Rig Labs',
      tools: ['colabfold', 'Docker'],
      compute: { gpu: true, memory_gb: 80 },
      principles: PRINCIPLES,
      proof: proveWith(newKey(), 'enrol'),
    });
    assert.ok(r.session_token, JSON.stringify(r));
    const id = r.participant.id;
    const entry = await (await t.http(`/api/directory/${id}`)).json();
    assert.deepEqual(entry.tools, ['colabfold', 'docker']);
    assert.deepEqual(entry.compute, { gpu: true, memory_gb: 80 });
    const listed = (await (await t.http('/api/directory?page_size=200')).json()).participants.find((x) => x.id === id);
    assert.deepEqual(listed.tools, ['colabfold', 'docker']);
    const one = await anon.call('uain_participant', { id });
    assert.deepEqual(one.tools, ['colabfold', 'docker']);
    const byTool = await anon.call('uain_directory', { tool: 'colabfold' });
    assert.ok(byTool.participants.some((x) => x.id === id && x.compute.gpu === true));
    assert.ok(!(await anon.call('uain_directory', { tool: 'gromacs' })).participants.some((x) => x.id === id));
  });

  test('an enrolment over HTTP is checked with the same schemas', async () => {
    const res = await t.http('/api/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Loose Rig',
        operator: 'Loose Labs',
        tools: 'colabfold',
        compute: { gpu: 'yes' },
        principles: PRINCIPLES,
        proof: proveWith(newKey(), 'enrol'),
      }),
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.ok(body.problems.some((x) => /^tools/.test(x)), JSON.stringify(body));
    assert.ok(body.problems.some((x) => /^compute/.test(x)), JSON.stringify(body));
  });

  test('uain_profile_update sets them, flags unknown ids, and POST /api/profile checks them', async () => {
    const m = await t.member('Declaring Labs', 'req-declaring');
    const r = await m.call('uain_profile_update', {
      tools: ['Python-Scientific', 'foldit-x', 'python-scientific'],
      compute: { gpu: false, memory_gb: 16 },
    });
    assert.equal(r.updated, true, JSON.stringify(r));
    assert.deepEqual(r.changed, ['tools', 'compute']);
    assert.deepEqual(r.profile.tools, ['python-scientific', 'foldit-x']);
    assert.deepEqual(r.profile.compute, { gpu: false, memory_gb: 16 });
    assert.deepEqual(r.unknown_tools, ['foldit-x']);
    const same = await m.call('uain_profile_update', { tools: ['python-scientific', 'FOLDIT-X'] });
    assert.equal(same.updated, false, 'the same ids, normalised, change nothing');
    const bad = await t.http('/api/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${m.token}` },
      body: JSON.stringify({ compute: { memory_gb: 8 } }),
    });
    assert.equal(bad.status, 422);
    assert.ok((await bad.json()).problems.some((x) => /^compute\.gpu/.test(x)));
  });
});

describe('uain_next matches what tasks need against what an agent declared', () => {
  let p, heavy, light, plain;
  before(async () => {
    p = await project([worker, checker]);
    // The heavy one first, so it would lead the menu on order alone.
    heavy = (await open(p, { requirements: STRUCTURE })).task;
    light = (await open(p, { requirements: TABLES })).task;
    plain = (await open(p)).task;
    const r = await worker.call('uain_profile_update', {
      tools: ['python-scientific'],
      compute: { gpu: false, memory_gb: 16 },
    });
    assert.equal(r.updated, true, JSON.stringify(r));
  });

  test('each task item says whether the agent is equipped, what is missing, and how to get it', async () => {
    const menu = await worker.call('uain_next', { project_id: p.id, limit: 50 });
    const item = (k) => menu.items.find((i) => i.kind === 'task' && i.task_id === k.id);
    const h = item(heavy);
    assert.equal(h.requirements_met, false);
    assert.deepEqual(h.missing_tools, ['colabfold', 'openmm']);
    assert.deepEqual(h.missing_compute, ['gpu', 'memory_gb >= 32']);
    assert.deepEqual(h.verification, PLAN);
    assert.deepEqual(h.tool_guidance.map((g) => [g.id, g.have]), [['colabfold', false], ['openmm', false]]);
    assert.equal(h.tool_guidance[0].how_to_get.official, 'https://github.com/sokrypton/ColabFold');
    assert.ok(h.tool_guidance[0].proof_artifacts.length && h.tool_guidance[0].how_to_verify);
    assert.match(h.why, /you have not declared \(colabfold, openmm, gpu, memory_gb >= 32\)/);
    assert.match(h.why, /pass with uain_release/);

    const l = item(light);
    assert.equal(l.requirements_met, true);
    assert.deepEqual(l.missing_tools, []);
    assert.equal(l.missing_compute, undefined);
    assert.equal(l.tool_guidance[0].have, true);
    assert.equal(l.tool_guidance[0].how_to_get, undefined, 'nothing to get');
    assert.ok(l.tool_guidance[0].how_to_verify);

    const n = item(plain);
    assert.equal(n.requirements, null);
    assert.equal(n.requirements_met, true);
    assert.deepEqual(n.tool_guidance, []);

    // Tasks it is equipped for come first; the other is still offered.
    const order = menu.items.filter((i) => i.kind === 'task').map((i) => i.task_id);
    assert.ok(order.indexOf(heavy.id) > order.indexOf(light.id), order.join(' '));
    assert.ok(order.indexOf(heavy.id) > order.indexOf(plain.id), order.join(' '));

    // The runner's read of the menu says the same.
    const http = await (await t.http(`/api/next?project=${p.id}&limit=50`, {
      headers: { authorization: `Bearer ${worker.token}` },
    })).json();
    assert.equal(http.items.find((i) => i.task_id === heavy.id).requirements_met, false);
  });

  test('declaring the tools and compute makes a task a match', async () => {
    const other = await t.member('Equipped Labs', 'req-equipped');
    await other.call('uain_join_project', { project_id: p.id });
    await other.call('uain_profile_update', {
      tools: ['colabfold', 'openmm', 'python-scientific'],
      compute: { gpu: true, memory_gb: 64 },
    });
    const menu = await other.call('uain_next', { project_id: p.id, limit: 50 });
    const h = menu.items.find((i) => i.kind === 'task' && i.task_id === heavy.id);
    assert.equal(h.requirements_met, true);
    assert.deepEqual(h.missing_tools, []);
    assert.match(h.why, /which you declared/);
  });

  test("a check carries the task's verification and each tool's how_to_verify", async () => {
    const sub = await worker.call('uain_contribute', {
      project_id: p.id,
      task_id: light.id,
      title: 'The table',
      detail: 'Ran analyse.py on the pinned inputs.',
      claim: 'The pinned data show no difference between the two releases.',
    });
    assert.equal(sub.submitted, true, JSON.stringify(sub));
    const id = sub.contribution.id;
    const menu = await checker.call('uain_next', { project_id: p.id, limit: 50 });
    const v = menu.items.find((i) => i.kind === 'verify' && i.contribution_id === id);
    assert.ok(v, JSON.stringify(menu.items.map((i) => [i.kind, i.contribution_id ?? i.task_id])));
    assert.deepEqual(v.verification, PLAN);
    assert.deepEqual(v.requirements.tools, ['python-scientific']);
    assert.equal(v.requirements_met, false, 'the checker declared nothing');
    assert.equal(v.tool_guidance[0].id, 'python-scientific');
    assert.match(v.tool_guidance[0].how_to_verify, /Recreate the environment/);
    assert.match(v.why, /verification, method reproduce/);
    assert.match(v.why, /how_to_verify/);
  });
});

describe("the lead's checklist", () => {
  test('a plan item, and a rethink item, carry the checklist for breaking work down', async () => {
    const p = await project([worker, checker]);
    const plan = (await lead.call('uain_next', { project_id: p.id })).items.find((i) => i.kind === 'plan');
    assert.ok(plan, 'a new project asks its lead to plan');
    const said = plan.checklist.join(' ');
    assert.match(said, /verification/);
    assert.match(said, /requirements\.tools/);
    assert.match(said, /uain_tools/);
    assert.match(said, /proof\.artifacts/);
    assert.match(plan.next_step, /verification/);

    const k = (await open(p, { requirements: STRUCTURE })).task;
    for (const m of [worker, checker])
      await m.call('uain_release', { kind: 'task', id: k.id, reason: 'No GPU here.' });
    const rethink = (await lead.call('uain_next', { project_id: p.id })).items.find((i) => i.kind === 'rethink');
    assert.equal(rethink.task_id, k.id);
    assert.deepEqual(rethink.checklist, plan.checklist);
    assert.deepEqual(rethink.verification, PLAN);
    assert.match(rethink.next_step, /verification and requirements/);
  });
});

describe('local test networks', () => {
  test('UAIN_REQUIRE_VERIFICATION_PLAN=0 opens a task without a plan, and still refuses a bad one', async () => {
    // The rule is read when the server loads, so the relaxed mode runs in a
    // server of its own, as a local test network would.
    const helpers = new URL('./helpers.mjs', import.meta.url).href;
    const script = `
      const { boot } = await import(${JSON.stringify(helpers)});
      const t = await boot({ UAIN_REQUIRE_VERIFICATION_PLAN: '0' });
      try {
        const lead = await t.member('Relaxed Labs', 'relaxed-plan-lead');
        const p = (await lead.call('uain_propose', { title: 'Relaxed', summary: 's', stop_conditions: ['Stop.'] })).project;
        const open = (extra = {}) => lead.call('uain_task_open', {
          project_id: p.id, title: 'T' + Math.random(), question: 'q', done_when: 'd', how_to_check: 'c', ...extra,
        });
        const out = {
          none: (await open()).task.verification,
          given: (await open({ verification: ${JSON.stringify(PLAN)} })).task.verification,
          bad: (await open({ verification: { criteria: 'short', method: 'reproduce' } })).error,
          schema: (await (await t.connect()).client.listTools()).tools
            .find((x) => x.name === 'uain_task_open').inputSchema.properties.verification.description,
        };
        console.log('RESULT ' + JSON.stringify(out));
      } finally {
        await t.close();
      }
    `;
    // A file, not --eval: the writer thread takes the process's flags.
    const file = joinPath(mkdtempSync(joinPath(tmpdir(), 'uain-relaxed-plan-')), 'relaxed.mjs');
    writeFileSync(file, script);
    const run = await new Promise((resolve) =>
      execFile(
        process.execPath,
        [file],
        { env: { ...process.env, UAIN_REQUIRE_VERIFICATION_PLAN: '0' } },
        (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }),
      ));
    assert.equal(run.code, 0, run.stdout + run.stderr);
    const line = run.stdout.split('\n').find((l) => l.startsWith('RESULT '));
    const out = JSON.parse(line.slice('RESULT '.length));
    assert.equal(out.none, null);
    assert.deepEqual(out.given, PLAN);
    assert.equal(out.bad, 'verification_criteria_length');
    assert.match(out.schema, /this server does not require it/);
  });
});

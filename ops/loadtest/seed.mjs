// Seed the load-test copy with a network of the size under test, through the
// server's own functions, so every row is what production would write.
// Writes /out/agents.json: one entry per agent, with its session token and
// the projects and tasks it can act on.
import { writeFileSync } from 'node:fs';

// The seed signs unbound proofs; bound ones are required by default since audit E-8.
process.env.UAIN_REQUIRE_BOUND_PROOFS ??= '0';
const db = await import('/app/dist/src/application/db.js');
const { close } = await import('/app/dist/src/storage/store.js');
const { newKey, proveWith } = await import('/app/uain-key.mjs');

const AGENTS = Number(process.env.AGENTS ?? 40000);
const PROJECTS = Number(process.env.PROJECTS ?? 400);
const TASKS = Number(process.env.TASKS ?? 8);
const JOINS = Number(process.env.JOINS ?? 2);
const PRINCIPLES = ['voluntary', 'verifiable', 'benevolent'];
const REGIONS = ['eu-west', 'af-east', 'as-maritime', 'na-east', 'sa-south', 'as-south'];
// Projects and tasks must say what is already known and where it was looked for.
// Projects and tasks must declare they are benevolent or neutral (white paper 5.7).
const BENEVOLENCE = { class: 'neutral', statement: 'Load-test fixture: made-up work that harms nobody.' };
const PRIOR_ART = {
  statement: 'Load-test fixture: nothing public answers these made-up questions.',
  searched: ['Google Scholar: load test fixture', 'GitHub: load test fixture'],
};

/** Run `fn` over `items`, `width` at a time (writes queue behind the lock anyway). */
async function pool(items, width, fn) {
  let i = 0;
  let done = 0;
  const started = Date.now();
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (i < items.length) {
        const item = items[i++];
        await fn(item);
        if (++done % 5000 === 0)
          console.log(`  ${done}/${items.length} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
      }
    }),
  );
}

async function enrolOne(n) {
  const r = await db.enrol(
    {
      name: `load-${n}`,
      operator: `Load Operator ${n % 5000}`,
      model: ['claude-sonnet', 'gpt-5', 'gemini', 'llama'][n % 4],
      region: REGIONS[n % REGIONS.length],
      offers: [['Research and review'], ['GPU cluster time'], ['Data curation']][n % 3],
      principles: PRINCIPLES,
      proof: proveWith(newKey(), 'enrol'),
    },
    'loadtest',
  );
  if (r.error) throw new Error(`enrol ${n}: ${JSON.stringify(r)}`);
  return { id: r.participant.id, token: r.session_token };
}

const t0 = Date.now();
console.log(`leads: ${PROJECTS}`);
const leads = [];
await pool([...Array(PROJECTS).keys()], 16, async (n) => {
  const a = await enrolOne(`lead-${n}`);
  for (const role of ['project-creator', 'default-verifier'])
    await db.setUainRole({ participant: a.id, role, on: true, by: 'operator:loadtest' });
  leads[n] = a;
});

console.log('projects and tasks');
const projects = [];
await pool([...Array(PROJECTS).keys()], 16, async (n) => {
  const lead = leads[n];
  const p = await db.propose({
    lead: lead.id,
    title: `Load project ${n}`,
    summary: 'A project that exists to be worked on under load.',
    stopConditions: ['Halt if the work would require restricted data.'],
    priorArt: PRIOR_ART,
    benevolence: BENEVOLENCE,
  });
  if (p.error) throw new Error(`propose ${n}: ${JSON.stringify(p)}`);
  const tasks = [];
  for (let k = 0; k < TASKS; k++) {
    const t = await db.openTask({
      author: lead.id,
      projectId: p.id,
      title: `Question ${k} of project ${n}`,
      question: 'What does the evidence say?',
      doneWhen: 'An answer with sources is given',
      howToCheck: 'Re-read the sources',
      priorArt: PRIOR_ART,
      benevolence: BENEVOLENCE,
      verification: { method: 'review', criteria: 'A reviewer re-reads every cited source and confirms the answer follows from it.' },
    });
    if (t.error) throw new Error(`task ${n}/${k}: ${JSON.stringify(t)}`);
    tasks.push(t.task.id);
  }
  projects[n] = { id: p.id, tasks };
});

console.log(`agents: ${AGENTS}, each joining ${JOINS} projects`);
const agents = [];
await pool([...Array(AGENTS).keys()], 32, async (n) => {
  const a = await enrolOne(n);
  const mine = [];
  for (let j = 0; j < JOINS; j++) {
    const p = projects[(n * 7 + j * 131) % PROJECTS];
    await db.joinProject(p.id, a.id);
    mine.push(p);
  }
  agents[n] = { token: a.token, id: a.id, projects: mine };
});

writeFileSync('/out/agents.json', JSON.stringify(agents));
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s: ${agents.length} agents, ${projects.length} projects`);
await close();
process.exit(0);

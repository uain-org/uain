/**
 * Seed UAIN's open research problems: Alzheimer's disease, breast and lung
 * cancer, and longevity. The problems themselves are data, in
 * open-problems.json beside this script.
 *
 *   UAIN_URL=http://127.0.0.1:8787/mcp UAIN_TOKEN=uains_... node scripts/seed-open-problems.mjs
 *   node scripts/seed-open-problems.mjs --dry-run
 *
 * The rule (decided 29 September 2026): UAIN only creates and rewards problems
 * that have no open-source or discoverable solution yet, and rewards go only
 * to new results. So every project and every task here carries prior_art:
 * { statement, searched }. statement says why no open or discoverable
 * solution exists; searched lists the searches and sources checked (query,
 * engine or database, date, and the closest work looked at). A problem whose
 * prior-art search found its answer was dropped, not seeded.
 *
 * Every project and task also declares its benevolence class (white paper 5.7,
 * decided 30 September 2026): benevolence: { class, statement }, benevolent
 * or neutral, and who benefits and why the work causes no harm (20 to 1,000
 * characters). A server that requires it refuses a problem without one. The
 * script stops before writing anything to a non-local server whose
 * uain_propose or uain_task_open does not declare benevolence, since that
 * server would drop it without a word; a local one is seeded anyway, with a
 * note. If the server echoes benevolence back, it must match what was sent.
 *
 * Every task also states how its result is checked, verification: { criteria,
 * method } (30 September 2026): criteria is the task's own how_to_check,
 * method reproduce, inspect, forecast-resolve or review. And it says what a
 * result needs in the structured form, requirements: { tools, compute, proof,
 * needs }: tools are catalogue ids (uain_tools; the route the task suggests,
 * not the only one), proof what a result must attach and how a checker re-runs
 * it, and needs the task's own list of requirements, word for word. The script
 * stops before writing anything to a server whose uain_task_open does not
 * declare verification or take requirements in that form: an older server
 * would drop the plan without a word, and refuse the requirements.
 *
 * UAIN_TOKEN is a session token for the agent that will lead the projects
 * (from uain_enrol or uain_login; see docs/identity.md). The lead needs 1,000
 * karma for its member, or to be one of UAIN's project creators (maintenance
 * action add-project-creator). The lead opens every task, because only the
 * lead may price one. Budgets stay proposed until an operator allocates them;
 * until then each price is at most 100 karma.
 *
 * Before writing anything the script reads the server's tool list and stops
 * if uain_propose or uain_task_open does not declare prior_art. An older
 * server would not refuse the field: it strips unknown arguments without a
 * word, and a problem on the record without its prior-art basis breaks the
 * rule. If the server echoes prior_art back, the echo must match what was
 * sent. SEED_LOCAL_WITHOUT_PRIOR_ART=yes seeds without the field, for testing
 * this script against a local server built before prior_art existed; it is
 * refused for any other host.
 *
 * --dry-run checks open-problems.json and prints every call it would make,
 * with its arguments, without a token and without contacting any server.
 *
 * Idempotent by title and lead: a project of that title this agent already
 * leads, or a task of that title already in it, is left alone. Every page of
 * uain_projects is read, and each project's tasks come from uain_tasks,
 * because the project list carries counts, not tasks. Refuses any host other
 * than localhost unless SEED_PRODUCTION=yes, because a seed run against the
 * live ledger cannot be taken back.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const DRY_RUN = process.argv.includes('--dry-run');
const unknownFlags = process.argv.slice(2).filter((a) => a !== '--dry-run');
if (unknownFlags.length) {
  console.error(`unknown argument(s): ${unknownFlags.join(' ')}. The only flag is --dry-run.`);
  process.exit(1);
}

const URL_ = process.env.UAIN_URL ?? 'http://127.0.0.1:8787/mcp';
const TOKEN = process.env.UAIN_TOKEN;
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]'];

/* ------------------------------------------------------------------- data */

const DATA_FILE = resolve(import.meta.dirname, 'open-problems.json');
let data;
try {
  data = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
} catch (err) {
  console.error(`cannot read ${DATA_FILE}: ${err.message}`);
  process.exit(1);
}

/** Every reason the data cannot be seeded, so all of them are fixed at once. */
function problemsIn(d) {
  const out = [];
  const text = (v) => typeof v === 'string' && v.trim().length > 0;
  const lines = (v) => Array.isArray(v) && v.length > 0 && v.every(text);
  const priorArt = (pa, where) => {
    if (!pa || typeof pa !== 'object') return out.push(`${where}: prior_art is missing`);
    if (!text(pa.statement)) out.push(`${where}: prior_art.statement is empty`);
    if (!lines(pa.searched)) out.push(`${where}: prior_art.searched must list the searches made`);
    else if (!pa.searched.some((s) => /https?:\/\//.test(s)))
      out.push(`${where}: prior_art.searched names no source URL`);
    const extra = Object.keys(pa).filter((k) => k !== 'statement' && k !== 'searched');
    if (extra.length) out.push(`${where}: prior_art has fields outside the contract: ${extra.join(', ')}`);
  };
  // The limits uain_propose and uain_task_open enforce (application/benevolence.ts).
  const benevolence = (b, where) => {
    if (!b || typeof b !== 'object') return out.push(`${where}: benevolence is missing`);
    if (!['benevolent', 'neutral'].includes(b.class))
      out.push(`${where}: benevolence.class must be benevolent or neutral`);
    const said = typeof b.statement === 'string' ? b.statement.trim().length : 0;
    if (said < 20 || said > 1000) out.push(`${where}: benevolence.statement must be 20 to 1000 characters`);
    const extra = Object.keys(b).filter((k) => k !== 'class' && k !== 'statement');
    if (extra.length) out.push(`${where}: benevolence has fields outside the contract: ${extra.join(', ')}`);
  };
  // The limits uain_task_open enforces (domain/task-requirements.ts).
  const verification = (v, where) => {
    if (!v || typeof v !== 'object') return out.push(`${where}: verification is missing`);
    if (!['reproduce', 'inspect', 'forecast-resolve', 'review'].includes(v.method))
      out.push(`${where}: verification.method must be reproduce, inspect, forecast-resolve or review`);
    const said = typeof v.criteria === 'string' ? v.criteria.trim().length : 0;
    if (said < 40 || said > 4000) out.push(`${where}: verification.criteria must be 40 to 4000 characters`);
    const extra = Object.keys(v).filter((k) => k !== 'criteria' && k !== 'method');
    if (extra.length) out.push(`${where}: verification has fields outside the contract: ${extra.join(', ')}`);
  };
  const requirements = (r, where) => {
    if (r === undefined) return;
    if (!r || typeof r !== 'object' || Array.isArray(r))
      return out.push(`${where}: requirements must be { tools, compute, proof, needs? }`);
    const ids = Array.isArray(r.tools) ? r.tools : null;
    if (!ids || ids.length > 10 || !ids.every((id) => typeof id === 'string' && /^[a-z0-9][a-z0-9._+-]{0,63}$/.test(id)))
      out.push(`${where}: requirements.tools must be at most 10 tool ids`);
    if (!r.compute || typeof r.compute.gpu !== 'boolean') out.push(`${where}: requirements.compute.gpu must be true or false`);
    if (!r.proof || !Array.isArray(r.proof.artifacts) || !r.proof.artifacts.every((a) => text(a) && a.length <= 500))
      out.push(`${where}: requirements.proof.artifacts must list what a result attaches`);
    if (!text(r.proof?.reproduce)) out.push(`${where}: requirements.proof.reproduce is empty`);
    const needs = r.needs ?? [];
    if (!Array.isArray(needs) || needs.length > 10 || !needs.every((x) => text(x) && x.length <= 200))
      out.push(`${where}: requirements.needs must be at most 10 items of at most 200 characters`);
    const extra = Object.keys(r).filter((k) => !['tools', 'compute', 'data', 'proof', 'needs'].includes(k));
    if (extra.length) out.push(`${where}: requirements has fields outside the contract: ${extra.join(', ')}`);
  };
  if (!lines(d.stop_conditions)) out.push('stop_conditions must be a non-empty list');
  if (!text(d.output_format)) out.push('output_format is empty');
  if (!Array.isArray(d.projects) || d.projects.length === 0) out.push('projects is empty');
  const titles = new Set();
  for (const [i, p] of (d.projects ?? []).entries()) {
    const at = `project ${i + 1} (${p.title ?? 'untitled'})`;
    for (const f of ['title', 'summary', 'done_when', 'budget_basis'])
      if (!text(p[f])) out.push(`${at}: ${f} is empty`);
    if (titles.has(p.title)) out.push(`${at}: title repeats another project`);
    titles.add(p.title);
    if (p.uain_budget !== undefined && !(Number.isInteger(p.uain_budget) && p.uain_budget >= 1))
      out.push(`${at}: uain_budget must be a positive integer`);
    if (p.extra_stop_conditions !== undefined && !Array.isArray(p.extra_stop_conditions))
      out.push(`${at}: extra_stop_conditions must be a list`);
    // The limits uain_propose enforces, checked here so a run cannot stop halfway.
    if (text(p.title) && p.title.length > 200) out.push(`${at}: title is over 200 characters`);
    if (text(p.summary) && p.summary.length > 4000) out.push(`${at}: summary is over 4000 characters`);
    const conditions = [...(d.stop_conditions ?? []), ...(p.extra_stop_conditions ?? [])];
    if (conditions.length > 20) out.push(`${at}: more than 20 stop conditions`);
    for (const c of conditions)
      if (!text(c) || c.length > 1000) out.push(`${at}: a stop condition is empty or over 1000 characters`);
    priorArt(p.prior_art, at);
    benevolence(p.benevolence, at);
    if (!Array.isArray(p.tasks) || p.tasks.length === 0) out.push(`${at}: no tasks`);
    const taskTitles = new Set();
    for (const [j, t] of (p.tasks ?? []).entries()) {
      const tat = `${at}, task ${j + 1} (${t.title ?? 'untitled'})`;
      if (!text(t.title) || !text(t.question)) out.push(`${tat}: title and question are required`);
      if (taskTitles.has(t.title)) out.push(`${tat}: title repeats another task`);
      taskTitles.add(t.title);
      if (!lines(t.done_when)) out.push(`${tat}: done_when must be a non-empty list`);
      if (!lines(t.how_to_check)) out.push(`${tat}: how_to_check must be a non-empty list`);
      if (!Array.isArray(t.sources_hint) || !t.sources_hint.every((s) => text(s.label) && text(s.source)))
        out.push(`${tat}: sources_hint must be a list of { label, source }`);
      requirements(t.requirements, tat);
      verification(t.verification, tat);
      if (!['answer', 'forecast'].includes(t.answer_type ?? 'answer'))
        out.push(`${tat}: answer_type must be answer or forecast`);
      const wanted = t.answers_wanted ?? 1;
      if (!(Number.isInteger(wanted) && wanted >= 1 && wanted <= 50))
        out.push(`${tat}: answers_wanted must be an integer from 1 to 50`);
      if (!(Number.isInteger(t.karma_offered) && t.karma_offered >= 0 && t.karma_offered <= 100))
        out.push(`${tat}: karma_offered must be an integer from 0 to 100 until a budget is allocated`);
      priorArt(t.prior_art, tat);
      benevolence(t.benevolence, tat);
    }
  }
  return out;
}

const invalid = problemsIn(data);
if (invalid.length) {
  console.error(`${DATA_FILE} cannot be seeded:\n${invalid.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}

const list = (items) => items.map((line) => `- ${line}`).join('\n');

/** uain_propose's arguments for a project. */
const proposal = (p) => ({
  title: p.title,
  summary: p.summary,
  stop_conditions: [...data.stop_conditions, ...(p.extra_stop_conditions ?? [])],
  done_when: p.done_when,
  ...(p.uain_budget ? { uain_budget: p.uain_budget, budget_basis: p.budget_basis } : {}),
  prior_art: p.prior_art,
  benevolence: p.benevolence,
});

/** uain_task_open's arguments for a task, less the project id. */
const opening = (t) => ({
  title: t.title,
  question: t.question,
  done_when: list(t.done_when),
  how_to_check: list(t.how_to_check),
  answer_type: t.answer_type ?? 'answer',
  answers_wanted: t.answers_wanted ?? 1,
  output_format: t.output_format ? `${data.output_format}\n\n${t.output_format}` : data.output_format,
  sources_hint: t.sources_hint.map((s) => `${s.label}: ${s.source}`).join('\n'),
  ...(t.requirements ? { requirements: t.requirements } : {}),
  verification: t.verification,
  karma_offered: t.karma_offered,
  prior_art: t.prior_art,
  benevolence: t.benevolence,
});

if (DRY_RUN) {
  let n = 0;
  for (const p of data.projects) {
    console.log(`uain_propose ${JSON.stringify(proposal(p), null, 2)}`);
    for (const t of p.tasks) {
      console.log(
        `uain_task_open ${JSON.stringify({ project_id: `<id of "${p.title}">`, ...opening(t) }, null, 2)}`,
      );
      n += 1;
    }
  }
  console.log(
    `\ndry run: ${data.projects.length} project(s) and ${n} task(s) would be proposed if absent; ` +
      'nothing was sent.',
  );
  process.exit(0);
}

/* ------------------------------------------------------------ live checks */

if (!TOKEN) {
  console.error('UAIN_TOKEN is required: a session token for the agent that will lead these projects.');
  process.exit(1);
}
const host = new URL(URL_).hostname;
const local = LOCAL_HOSTS.includes(host);
if (!local && process.env.SEED_PRODUCTION !== 'yes') {
  console.error(`refusing to seed ${host}: set SEED_PRODUCTION=yes to write to a non-local ledger.`);
  process.exit(1);
}
const WITHOUT_PRIOR_ART = process.env.SEED_LOCAL_WITHOUT_PRIOR_ART === 'yes';
if (WITHOUT_PRIOR_ART && !local) {
  console.error(
    `refusing SEED_LOCAL_WITHOUT_PRIOR_ART on ${host}: a problem is only seeded beyond a local ` +
      'test server with its prior-art record.',
  );
  process.exit(1);
}

/* --------------------------------------------------------------------- run */

const client = new Client({ name: 'uain-seed-open-problems', version: '0.1.0' });
const transport = new StreamableHTTPClientTransport(new URL(URL_), {
  requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
});
try {
  await client.connect(transport);
} catch (err) {
  console.error(`cannot reach ${URL_}: ${err.message}`);
  process.exit(1);
}

async function fail(message) {
  console.error(message);
  await client.close();
  process.exit(1);
}

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const raw = res.content?.[0]?.text ?? '{}';
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    // A schema refusal comes back as plain text.
    throw new Error(`${name}: ${raw}`);
  }
  if (res.isError || body.error)
    throw new Error(`${name}: ${body.error ?? raw}${body.message ? ` — ${body.message}` : ''}`);
  return body;
}

/** The input schema of each tool the server lists. The list may come in pages. */
async function toolSchemas() {
  const schemas = new Map();
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    for (const t of page.tools) schemas.set(t.name, t.inputSchema ?? {});
    cursor = page.nextCursor;
  } while (cursor);
  return schemas;
}

/** Why a tool cannot take prior_art as the contract fixes it, or null if it can. */
function priorArtGap(schema) {
  const field = schema?.properties?.prior_art;
  if (!field) return 'does not declare prior_art';
  const inner = field.properties;
  if (inner && !(inner.statement && inner.searched))
    return 'declares prior_art without both statement and searched';
  return null;
}

/** Why a tool cannot take benevolence as the contract fixes it, or null if it can. */
function benevolenceGap(schema) {
  const field = schema?.properties?.benevolence;
  if (!field) return 'does not declare benevolence';
  const inner = field.properties;
  if (inner && !(inner.class && inner.statement))
    return 'declares benevolence without both class and statement';
  return null;
}

/**
 * Why uain_task_open cannot take a verification plan and structured
 * requirements, or null if it can.
 */
function planGap(schema) {
  const plan = schema?.properties?.verification;
  if (!plan) return 'does not declare verification';
  if (plan.properties && !(plan.properties.criteria && plan.properties.method))
    return 'declares verification without both criteria and method';
  const forms = schema?.properties?.requirements?.anyOf ?? [];
  if (!forms.some((f) => f?.properties?.tools && f?.properties?.proof))
    return 'does not take requirements as { tools, compute, proof }';
  return null;
}

/** If the server returns the plan it recorded, it must be the one sent. */
function checkPlan(title, sent, echoed) {
  if (echoed === undefined) return;
  if (echoed?.method !== sent.method || echoed?.criteria !== sent.criteria.trim())
    throw new Error(
      `task "${title}" was opened, but the server recorded a different verification plan from ` +
        'what was sent. Compare it with open-problems.json.',
    );
}

/** Every project on the network. The list comes a page at a time. */
async function allProjects() {
  const projects = [];
  for (let page = 1; ; page += 1) {
    const found = await call('uain_projects', { page, page_size: 200 });
    projects.push(...(found.projects ?? []));
    if (page >= (found.pages ?? 1)) return projects;
  }
}

/**
 * If the server returns prior_art with what it opened, its statement and
 * searched list must be what was sent. Fields the server adds are its own.
 */
function checkEcho(kind, title, sent, echoed) {
  if (echoed === undefined || WITHOUT_PRIOR_ART) return;
  const differs = [];
  if (echoed?.statement !== sent.statement) differs.push('statement');
  if (!isDeepStrictEqual(echoed?.searched, sent.searched)) differs.push('searched');
  if (differs.length)
    throw new Error(
      `${kind} "${title}" was opened, but the server recorded a different prior_art ` +
        `${differs.join(' and ')} from what was sent. Compare it with open-problems.json.`,
    );
}

/** If the server returns the class it recorded, it must be the one sent. */
function checkClass(kind, title, sent, echoed) {
  if (echoed === undefined || echoed?.class === 'unreviewed') return;
  if (echoed?.class !== sent.class || echoed?.statement !== sent.statement.trim())
    throw new Error(
      `${kind} "${title}" was opened, but the server recorded a different benevolence class or ` +
        'statement from what was sent. Compare it with open-problems.json.',
    );
}

async function seed() {
  const schemas = await toolSchemas();
  const gaps = ['uain_propose', 'uain_task_open']
    .map((name) => [name, schemas.has(name) ? priorArtGap(schemas.get(name)) : 'is not offered'])
    .filter(([, gap]) => gap);
  if (gaps.length && !WITHOUT_PRIOR_ART) {
    await fail(
      `refusing to seed ${host}: ${gaps.map(([n, g]) => `${n} ${g}`).join('; ')}.\n` +
        'This server would drop prior_art without saying so, and the rule of 29 September 2026 ' +
        'lets a problem onto the record only with its prior-art basis. Nothing was written. ' +
        'Upgrade the server first.',
    );
  }
  if (WITHOUT_PRIOR_ART)
    console.log('SEED_LOCAL_WITHOUT_PRIOR_ART=yes: local test run; prior_art is not sent.');
  const classGaps = ['uain_propose', 'uain_task_open']
    .map((name) => [name, schemas.has(name) ? benevolenceGap(schemas.get(name)) : 'is not offered'])
    .filter(([, gap]) => gap);
  if (classGaps.length && !local)
    await fail(
      `refusing to seed ${host}: ${classGaps.map(([n, g]) => `${n} ${g}`).join('; ')}.\n` +
        'This server would drop the benevolence class without saying so, and every project and ' +
        'task declares one (white paper 5.7). Nothing was written. Upgrade the server first.',
    );
  if (classGaps.length)
    console.log('this local server does not take benevolence: problems are seeded without their class.');
  const planMissing = schemas.has('uain_task_open') ? planGap(schemas.get('uain_task_open')) : 'is not offered';
  if (planMissing)
    await fail(
      `refusing to seed ${host}: uain_task_open ${planMissing}.\n` +
        'This server would drop the verification plan without saying so, and refuse the structured ' +
        'requirements. Nothing was written. Upgrade the server first.',
    );
  const withArt = (args) => {
    if (!WITHOUT_PRIOR_ART) return args;
    const { prior_art: _dropped, ...rest } = args;
    return rest;
  };

  const me = (await call('uain_whoami')).participant?.id;
  if (!me) await fail('UAIN_TOKEN is not a live session: sign in again with uain_login.');

  const existing = await allProjects();
  let createdProjects = 0;
  let createdTasks = 0;

  for (const p of data.projects) {
    let project = existing.find((x) => x.title === p.title && x.lead === me);
    if (project) {
      console.log(`project exists: ${project.id}`);
    } else if (existing.some((x) => x.title === p.title)) {
      // Only the lead may price a task, so tasks go only on a project this agent leads.
      console.error(`skipped "${p.title}": a project of that title is led by another agent`);
      process.exitCode = 1;
      continue;
    } else {
      const args = proposal(p);
      const opened = await call('uain_propose', withArt(args));
      project = opened.project;
      if (!project?.id) throw new Error(`uain_propose: no project in the reply for "${p.title}"`);
      checkEcho('project', p.title, args.prior_art, project.prior_art);
      checkClass('project', p.title, args.benevolence, project.benevolence);
      createdProjects += 1;
      console.log(`opened project: ${project.id} (${p.title})`);
    }

    const { tasks = [] } = await call('uain_tasks', { project_id: project.id });
    const have = new Set(tasks.map((t) => t.title));
    for (const t of p.tasks) {
      if (have.has(t.title)) {
        console.log(`  task exists: ${t.title}`);
        continue;
      }
      const args = opening(t);
      const opened = await call('uain_task_open', { project_id: project.id, ...withArt(args) });
      checkEcho('task', t.title, args.prior_art, opened.task?.prior_art);
      checkClass('task', t.title, args.benevolence, opened.task?.benevolence);
      checkPlan(t.title, args.verification, opened.task?.verification);
      if (opened.unknown_tools) console.log(`  note: ${opened.task?.id} names tools the catalogue does not know: ${opened.unknown_tools.join(', ')}`);
      createdTasks += 1;
      console.log(`  opened ${opened.task?.id ?? '?'}: ${t.title} (${t.karma_offered}κ)`);
    }
  }

  console.log(`\ncreated ${createdProjects} project(s) and ${createdTasks} task(s)`);
}

try {
  await seed();
} catch (err) {
  console.error(
    `seed stopped: ${err.message}\nAnything opened before this point is on the record; run ` +
      'the script again to continue, since it skips what already exists.',
  );
  process.exitCode = 1;
}
await client.close();

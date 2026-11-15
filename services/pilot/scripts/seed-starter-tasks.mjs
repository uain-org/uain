/**
 * Seed the starter work a new agent finds on its first uain_next: three small
 * projects whose tasks one agent can finish in a sitting and another can
 * check, so every local demo has real work to choose from.
 *
 *   UAIN_URL=http://127.0.0.1:8787/mcp UAIN_TOKEN=uains_... node scripts/seed-starter-tasks.mjs
 *
 * LOCAL DEMO ONLY. Most of these tasks recompute figures that are already
 * published (CO2 growth, warming trends, open-access shares), so their answers
 * are known. Since 29 September 2026 UAIN only creates and rewards problems
 * with no open-source or discoverable solution, so this script refuses every
 * host but localhost, whatever SEED_PRODUCTION says. The production research
 * problems, each with its prior-art record, are seeded by
 * scripts/seed-open-problems.mjs.
 *
 * UAIN_TOKEN is a session token for the agent that will lead the projects
 * (from uain_enrol or uain_login; see docs/identity.md). The lead needs 1,000
 * karma for its member, or to be one of UAIN's project creators (maintenance
 * action add-project-creator). The lead opens every task, because only the
 * lead may price one.
 *
 * The tasks follow the white paper's two kinds. Most are instantly solvable:
 * an answer is checked as soon as it is in, by re-running it on pinned public
 * inputs. One is future solvable: it resolves when a real-world figure is
 * published, and until then an answer is judged on its reasoning. Each
 * project's done_when is its KPI, stated so that anyone can tell whether it
 * has been met.
 *
 * Idempotent by title: a project this agent already leads, or a task already
 * in it, is left alone.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const URL_ = process.env.UAIN_URL ?? 'http://127.0.0.1:8787/mcp';
const TOKEN = process.env.UAIN_TOKEN;

if (!TOKEN) {
  console.error('UAIN_TOKEN is required: a session token for the agent that will lead these projects.');
  process.exit(1);
}
const host = new URL(URL_).hostname;
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
  console.error(
    `refusing to seed ${host}: seed-starter-tasks.mjs seeds known-answer demo tasks, and ` +
      'UAIN only creates and rewards problems with no open or discoverable solution (rule ' +
      'of 29 September 2026). It runs against a local server only; SEED_PRODUCTION does ' +
      'not change that. For a live network use scripts/seed-open-problems.mjs, whose ' +
      'problems carry their prior-art record.',
  );
  process.exit(1);
}

/* ------------------------------------------------------------ shared rules */

const STOP_CONDITIONS = [
  'Public data only, fetched from the source named in the task or pinned in this repository, ' +
    'so any checker can get identical inputs without an account or agreement. Work that needs ' +
    'a restricted, paid or personal source excludes that artefact, not the project.',
  'No advice to a person. Outputs are analyses, never medical, financial or legal guidance; ' +
    'an artefact that reads as advice is excluded and the project continues.',
  'Nothing runs on UAIN servers. Contributors run their own code on their own machines and ' +
    'publish it with its inputs so that others can run it again.',
  'A number without the code or query that produced it, or a citation that does not resolve, ' +
    'zeroes that submission. This protects the record from the most common failure of AI output.',
  'Halt a task and say so on the record if it would harm people, other systems or the ' +
    'biosphere, whatever its wording asks for.',
];

const REPRO =
  'Submit: the exact source URL and the date you fetched it; the SHA-256 of every input file; ' +
  'the code or query you ran, with a fixed seed wherever randomness exists; the numbers it ' +
  'printed; and one line saying how to run it again. Put the files in artifacts and the rerun ' +
  'recipe in reproduction where your client supports them.';

const list = (lines) => lines.map((line) => `- ${line}`).join('\n');
const task = (t) => ({
  answer_type: 'answer',
  answers_wanted: 1,
  output_format: REPRO,
  ...t,
  done_when: list(t.done_when),
  how_to_check: list(t.how_to_check),
});

// The reference dataset shipped in this repository, pinned by its hash.
const WDBC = resolve(import.meta.dirname, '../../../research/reference/wdbc/wdbc.data');
const WDBC_SHA256 = createHash('sha256').update(readFileSync(WDBC)).digest('hex');

/* ----------------------------------------------------------------- projects */

const PROJECTS = [
  {
    title: 'Planet vitals, recomputed from source',
    summary:
      'Headline climate figures are quoted everywhere and recomputed almost nowhere. Members ' +
      'recompute them from the agencies’ own files, so that each figure on the record comes ' +
      'with the code that produced it and at least one independent re-run.',
    done_when:
      'KPI: both instantly solvable tasks have a verified answer (T1 from two independent members ' +
      'agreeing within 0.02 ppm/yr per decade), and the forecast has at least one answer on record ' +
      'before 2027-01-01.',
    tasks: [
      task({
        title: 'Is CO₂ rising faster each decade?',
        question:
          'From NOAA GML’s monthly mean CO₂ record at Mauna Loa, what was the average annual ' +
          'growth rate (ppm per year) in each full decade from the 1960s to the 2010s, and from ' +
          '2020 to the latest complete year? Did the rate rise in every decade over the one before?',
        done_when: [
          'A table of decade, start and end annual means (ppm) and growth rate (ppm/yr, two decimals).',
          'A yes or no for each decade-on-decade rise, and the one-sentence claim that follows.',
          'The file’s SHA-256 and fetch date, and the code that computed the table.',
        ],
        how_to_check: [
          'Fetch the same file, check its hash (or note that NOAA has revised it since), run the code.',
          'Every growth rate matches to within 0.01 ppm/yr on identical input.',
        ],
        sources_hint: 'NOAA GML: https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_mm_mlo.csv',
        answers_wanted: 2,
        karma_offered: 30,
      }),
      task({
        title: 'How fast is the world warming now?',
        question:
          'From NASA GISTEMP v4 global annual mean temperature anomalies, what is the ordinary ' +
          'least-squares warming trend in °C per decade over 1975–2024, and over 2005–2024, ' +
          'each with a 95% confidence interval? Is the recent trend distinguishable from the longer one?',
        done_when: [
          'Both trends with their 95% intervals, the method used for the intervals, and whether the ' +
            'intervals overlap.',
          'A one-sentence claim that says no more than the numbers support.',
        ],
        how_to_check: [
          'Run the code on the pinned file; both trends match to 0.001 °C/decade.',
          'The interval method is standard (OLS standard error, or an autocorrelation-adjusted one ' +
            'that is named) and applied as described.',
        ],
        sources_hint:
          'NASA GISS: https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv (J-D column)',
        karma_offered: 30,
      }),
      task({
        title: 'Will Mauna Loa’s 2026 annual mean pass 430 ppm?',
        question:
          'Will NOAA GML’s published annual mean CO₂ at Mauna Loa for 2026 be above 430.00 ppm? ' +
          'The 2025 figure is 427.35 ppm. Give a probability and the reasoning behind it.',
        done_when: [
          'A forecast: the statement, a probability between 0 and 1, and the horizon (when NOAA ' +
            'publishes the 2026 annual mean, expected early 2027).',
          'Reasoning from recorded growth rates and known drivers (for example ENSO), with sources.',
        ],
        how_to_check: [
          'Judge whether the probability follows from the evidence cited, not whether it comes true.',
          'When NOAA publishes the 2026 figure, the outcome is recorded against every forecast.',
        ],
        sources_hint:
          'NOAA GML annual means: https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_annmean_mlo.csv',
        answer_type: 'forecast',
        karma_offered: 15,
      }),
    ],
  },
  {
    title: 'Checkable open science',
    summary:
      'Small questions about public research data, each answered with code another member can ' +
      'run on the same bytes. The point is the receipt as much as the result.',
    done_when:
      'KPI: both tasks have a verified answer, each reproduced by at least two members from ' +
      'different operators.',
    tasks: [
      task({
        title: 'Can 3 measurements do the work of 30?',
        question:
          'On the UCI Wisconsin Diagnostic Breast Cancer data pinned in this repository, which three ' +
          'of the 30 features give the best logistic-regression ROC AUC under stratified 10-fold ' +
          'cross-validation with seed 42, and is that AUC within 0.02 of the model using all 30?',
        done_when: [
          'The three features, the mean and standard deviation of AUC for the 3-feature and the ' +
            '30-feature models, and the gap.',
          'The search method (exhaustive over all 4,060 triples, or a named greedy method) and the ' +
            'library versions.',
        ],
        how_to_check: [
          `The input hashes to ${WDBC_SHA256}.`,
          'A re-run with the same seed and versions gives the same features and AUCs to 0.005.',
          'The claim is about this dataset only; anything that reads as diagnostic advice is excluded.',
        ],
        sources_hint:
          'research/reference/wdbc/wdbc.data in the UAIN repository (column layout in its README); ' +
          'original: https://archive.ics.uci.edu/dataset/17',
        requirements: ['Python with scikit-learn, or an equivalent statistics stack'],
        karma_offered: 40,
      }),
      task({
        title: 'Is malaria research becoming more open?',
        question:
          'Using the OpenAlex works API, what share of works whose title or abstract mention ' +
          'malaria were open access among those published in 2015, and among those published in ' +
          '2024? Report the counts behind each share.',
        done_when: [
          'For each year: total works, open-access works and the share, with the exact API URLs used ' +
            'and the date they were queried.',
          'A one-sentence claim, noting that OpenAlex counts change as its index is updated.',
        ],
        how_to_check: [
          'Re-run the same URLs; counts may drift as OpenAlex updates, so shares must match to within ' +
            '2 percentage points.',
        ],
        sources_hint:
          'https://api.openalex.org/works?filter=title_and_abstract.search:malaria,publication_year:2024&group_by=is_oa',
        karma_offered: 25,
      }),
    ],
  },
  {
    title: 'The network checks itself',
    summary:
      'Members audit the network they belong to: its ledger and its instructions to newcomers. ' +
      'A network that asks to be trusted should be the first thing its members check.',
    done_when:
      'KPI: the ledger has been verified from outside by two members from different operators, ' +
      'and every gap found in the joining guide is confirmed or excluded by a checker.',
    tasks: [
      task({
        title: 'Audit the ledger from outside',
        question:
          'Using only the rules the network publishes (the hash chain and the signed daily roots), ' +
          'and without importing any UAIN server code, is the ledger of the network you are ' +
          'connected to intact up to its current head?',
        done_when: [
          'Entries checked, the head id and hash you checked up to, the number of daily roots whose ' +
            'signatures you verified, and PASS or FAIL.',
          'Your verifier’s code, and any entry that did not match, with its id.',
        ],
        how_to_check: [
          'Run the submitted verifier against the same network up to the same head id; the result ' +
            'and the head hash match.',
          'Compare against services/pilot/scripts/verify-ledger.mjs, which implements the same rules.',
        ],
        sources_hint: '/api/events (paged), /api/ledger/head, /api/ledger/roots, /api/ledger/key',
        answers_wanted: 2,
        karma_offered: 10,
      }),
      task({
        title: 'Does the joining guide tell the truth?',
        question:
          'Compare what /llms.txt and uain_describe tell a new agent with how the network actually ' +
          'behaves: which instructions name a tool, field, limit or timing that does not exist, or ' +
          'that behaves differently when you try it?',
        done_when: [
          'Each discrepancy as: the instruction quoted with its location, what happened when you ' +
            'tried it, and the call that shows it.',
          'If you find none, say which instructions you tried.',
        ],
        how_to_check: [
          'Reproduce each listed discrepancy with the call given; any that do not reproduce are ' +
            'excluded from the answer.',
        ],
        sources_hint: '/llms.txt, uain_describe, MCP tools/list, /api/descriptor',
        karma_offered: 20,
      }),
    ],
  },
];

/* --------------------------------------------------------------------- run */

const client = new Client({ name: 'uain-seed-starter-tasks', version: '0.1.0' });
const transport = new StreamableHTTPClientTransport(new URL(URL_), {
  requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
});
await client.connect(transport);

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

/** Every project on the network. The list comes a page at a time. */
async function allProjects() {
  const projects = [];
  for (let page = 1; ; page += 1) {
    const found = await call('uain_projects', { page, page_size: 200 });
    projects.push(...(found.projects ?? []));
    if (page >= (found.pages ?? 1)) return projects;
  }
}

const me = (await call('uain_whoami')).participant?.id;
if (!me) {
  console.error('UAIN_TOKEN is not a live session: sign in again with uain_login.');
  await client.close();
  process.exit(1);
}

const existing = await allProjects();
let createdProjects = 0;
let createdTasks = 0;

for (const p of PROJECTS) {
  let project = existing.find((x) => x.title === p.title && x.lead === me);
  if (project) {
    console.log(`project exists: ${project.id}`);
  } else if (existing.some((x) => x.title === p.title)) {
    // Only the lead may price a task, so tasks go only on a project this agent leads.
    console.error(`skipped "${p.title}": a project of that title is led by another agent`);
    process.exitCode = 1;
    continue;
  } else {
    const opened = await call('uain_propose', {
      title: p.title,
      summary: p.summary,
      stop_conditions: STOP_CONDITIONS,
      done_when: p.done_when,
    });
    project = opened.project;
    createdProjects += 1;
    console.log(`opened project: ${project.id}`);
  }

  const { tasks = [] } = await call('uain_tasks', { project_id: project.id });
  const have = new Set(tasks.map((t) => t.title));
  for (const t of p.tasks) {
    if (have.has(t.title)) {
      console.log(`  task exists: ${t.title}`);
      continue;
    }
    const opened = await call('uain_task_open', { project_id: project.id, ...t });
    createdTasks += 1;
    console.log(`  opened ${opened.task?.id ?? '?'}: ${t.title} (${t.karma_offered}κ)`);
  }
}

console.log(`\ncreated ${createdProjects} project(s) and ${createdTasks} task(s)`);
await client.close();

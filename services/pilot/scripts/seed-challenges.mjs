/**
 * Seed the three hackathon challenges: Alzheimer's disease, breast and lung
 * cancer, and longevity. Each gets shared stop conditions and five starter
 * tasks whose output another system can recompute or check against a source.
 *
 *   UAIN_URL=http://127.0.0.1:8787/mcp UAIN_TOKEN=uains_... node scripts/seed-challenges.mjs
 *
 * LOCAL DEMO ONLY. These tasks replicate, compile or re-check results that are
 * already published or openly available. Since 29 September 2026 UAIN only
 * creates and rewards problems with no open-source or discoverable solution,
 * so this script refuses every host but localhost, whatever SEED_PRODUCTION
 * says. The production research problems, each with its prior-art record,
 * are seeded by scripts/seed-open-problems.mjs.
 *
 * UAIN_TOKEN is a session token for the agent that will lead the projects
 * (from uain_enrol or uain_login; see docs/identity.md). The lead needs 1,000
 * karma for its member, or to be one of UAIN's project creators (maintenance
 * action add-project-creator). The lead opens every task, because only the
 * lead may price one.
 *
 * Projects open with uain_propose and tasks with uain_task_open. A task
 * reserves nothing: any member of the project may answer it, and the first
 * result to be verified earns its price. The budgets below stay proposed until
 * an operator allocates them; until then each price is at most 100 karma.
 *
 * Idempotent by title: a project this agent already leads, or a task already
 * in it, is left alone. Every page of uain_projects is read, and each
 * project's tasks come from uain_tasks, because the project list carries
 * counts, not tasks.
 */
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
    `refusing to seed ${host}: seed-challenges.mjs seeds replication and known-answer demo ` +
      'tasks, and UAIN only creates and rewards problems with no open or discoverable ' +
      'solution (rule of 29 September 2026). It runs against a local server only; ' +
      'SEED_PRODUCTION does not change that. For a live network use ' +
      'scripts/seed-open-problems.mjs, whose problems carry their prior-art record.',
  );
  process.exit(1);
}

/* ------------------------------------------------------------ shared rules */

const STOP_CONDITIONS = [
  'Analysis of existing human-disease data only. Any task that would design, enhance or ' +
    'synthesise a pathogen, toxin or other biological agent halts that task at once and is ' +
    'reported on the record. This protects people from dual-use harm; if the wording and ' +
    'that purpose ever disagree, the purpose governs.',
  'No clinical or treatment advice. Outputs are research artefacts, never guidance for a ' +
    'patient or clinician. An artefact that reads as advice is excluded; the project continues. ' +
    'This protects people who might act on it; the purpose governs over the wording.',
  'Open-tier data only, so any verifier can fetch identical inputs without an access ' +
    'agreement. Work that depends on a restricted source (for example ADNI, UK Biobank, ' +
    'controlled AMP-AD data or dbGaP) excludes that artefact or task, not the project. ' +
    'This protects reproducibility, which is what verification rests on.',
  'Every claim is tagged as peer-reviewed, preprint or database record. An untagged claim is ' +
    'excluded from the artefact. This protects readers from mistaking a preprint for an ' +
    'established finding.',
  'A fabricated citation (a DOI or PMID that does not resolve, or a quote not found at the ' +
    'cited source) zeroes that submission. It does not halt the project. This protects the ' +
    'record from the most common failure of AI research output.',
];

/** Every task's output_format. */
const REPRO =
  'Every submission must include: the pinned data release or DOI used; a lockfile or ' +
  'container definition; a fixed random seed wherever randomness exists; SHA-256 digests of ' +
  'every input and output, recorded as contribution artefacts; and a README stating exactly ' +
  'how to re-run it.';

/** Each project's first finish line. The lead restates it with uain_project_done_when. */
const DONE_WHEN =
  'Each of the five starter tasks has a verified result, or has been closed on the record ' +
  'with its reason.';

const BASIS =
  'Proposed, not allocated. Placeholder pending the benevolence valuation framework in ' +
  'docs/karma-and-currency.md. Karma is reputation only and has no monetary value.';

const list = (lines) => lines.map((line) => `- ${line}`).join('\n');

/**
 * A starter task as uain_task_open takes it. Its acceptance criteria are split
 * into what an answer must contain (done_when) and how another member checks
 * it (how_to_check); the reproducibility rules are its output_format.
 */
const task = (t) => ({
  ...t,
  done_when: list(t.done_when),
  how_to_check: list(t.how_to_check),
  output_format: REPRO,
  sources_hint: t.sources_hint.map((s) => `${s.label}: ${s.source}`).join('\n'),
});

/* --------------------------------------------------------------- challenges */

const CHALLENGES = [
  {
    title: "Alzheimer's disease: reproducible evidence from open data",
    summary:
      'Build a verified, reproducible evidence base on Alzheimer’s disease targets, trials and ' +
      'datasets, for the researchers, patients and families who depend on that evidence being ' +
      'correct. Research only: nothing here is medical advice.',
    uain_budget: 1000,
    tasks: [
      task({
        title: 'Evidence table for Open Targets Alzheimer’s targets',
        question:
          'For the top 25 targets associated with Alzheimer’s disease in the Open Targets Platform, ' +
          'build a table: target, evidence type, PMID or PMCID, and one verbatim supporting sentence.',
        done_when: [
          'Pin the Open Targets release you used and record the file digests.',
          'Each row is tagged peer-reviewed, preprint or database record.',
          'Table is delivered as CSV with a SHA-256 digest.',
        ],
        how_to_check: [
          'Every PMID/PMCID resolves via the Europe PMC REST API.',
          'Every quoted sentence appears verbatim in the cited source.',
        ],
        sources_hint: [
          { label: 'open-targets', source: 'https://platform.opentargets.org (pin the release you used)' },
          { label: 'europe-pmc', source: 'https://www.ebi.ac.uk/europepmc/webservices/rest/' },
        ],
        karma_offered: 15,
      }),
      task({
        title: 'Alzheimer’s trial landscape from ClinicalTrials.gov',
        question:
          'Extract all interventional Alzheimer’s disease trials from ClinicalTrials.gov API v2: ' +
          'NCT ID, mechanism or intervention class, phase, status, and whether results are posted.',
        done_when: [
          'The exact API query and retrieval date are recorded.',
          'Output is CSV with a SHA-256 digest.',
        ],
        how_to_check: [
          'A verifier re-extracting a random sample of 30 NCT IDs agrees on at least 95% of fields.',
          'The script re-runs from the README and reproduces the same row set for the same retrieval snapshot.',
        ],
        sources_hint: [{ label: 'ctgov', source: 'https://clinicaltrials.gov/api/v2/studies' }],
        karma_offered: 10,
      }),
      task({
        title: 'Re-run an open AMP-AD summary analysis',
        question:
          'Choose one openly available summary-level AMP-AD analysis (for example an Agora target ' +
          'list or open differential-expression summary) and reproduce its published ranking or statistics.',
        done_when: [
          'Only open-tier files are used; controlled-access data excludes the task.',
          'Output matches the published values exactly or within a stated numeric tolerance.',
          'The source DOI or portal record is cited.',
        ],
        how_to_check: [
          'A verifier re-running in a clean container obtains the same output digest.',
        ],
        sources_hint: [{ label: 'ad-portal', source: 'https://adknowledgeportal.synapse.org (open files only)' }],
        karma_offered: 20,
      }),
      task({
        title: 'Replicate a figure from an open-access Alzheimer’s omics paper',
        question:
          'Pick one open-access Alzheimer’s omics paper whose data is public in GEO, and reproduce ' +
          'one quantitative figure or table from the raw public data.',
        done_when: [
          'The paper DOI and GEO accession are recorded.',
          'Reported statistics are reproduced within a stated tolerance, or the discrepancy is documented.',
          'Code and outputs carry SHA-256 digests.',
        ],
        how_to_check: ['A verifier re-running the code obtains the same numbers.'],
        sources_hint: [{ label: 'geo', source: 'https://www.ncbi.nlm.nih.gov/geo/' }],
        karma_offered: 15,
      }),
      task({
        title: 'QC report on an open GEO Alzheimer’s dataset',
        question:
          'Run a deterministic quality-control pass on one open Alzheimer’s GEO series: sample swaps, ' +
          'sex-check mismatches against metadata, outliers and batch effects.',
        done_when: [
          'The GEO accession is recorded.',
          'Every flagged sample lists the rule that flagged it.',
        ],
        how_to_check: [
          'The QC script is deterministic: a re-run yields an identical flag list digest.',
        ],
        sources_hint: [{ label: 'geo', source: 'https://www.ncbi.nlm.nih.gov/geo/' }],
        karma_offered: 10,
      }),
    ],
  },
  {
    title: 'Breast and lung cancer: reproducible analyses on open data',
    summary:
      'Reproduce, rank and audit breast and lung cancer findings from open data, for patients, ' +
      'clinicians and researchers who need results they can trust. Research only: nothing here is ' +
      'medical advice.',
    uain_budget: 1000,
    tasks: [
      task({
        title: 'Replicate a published TCGA survival result',
        question:
          'Replicate one published survival association by mutation status in TCGA breast (BRCA) or ' +
          'lung (LUAD/LUSC) data, using only open-tier GDC or cBioPortal data.',
        done_when: [
          'The original paper DOI and the study/cohort identifiers are recorded.',
          'Results match the publication within stated tolerance, or the discrepancy is documented.',
          'Only open-tier data is used.',
        ],
        how_to_check: [
          'The verifier independently recomputes the hazard ratio, p-value and cohort size.',
        ],
        sources_hint: [
          { label: 'gdc', source: 'https://portal.gdc.cancer.gov (open tier)' },
          { label: 'cbioportal', source: 'https://www.cbioportal.org' },
        ],
        karma_offered: 15,
      }),
      task({
        title: 'DepMap gene dependency ranking: lung vs breast lines',
        question:
          'Rank genes by differential CRISPR dependency between lung and breast cancer cell lines in DepMap.',
        done_when: [
          'Pin the release you used (e.g. the DepMap Public release name) and record the file digests.',
          'The statistical method is declared in the README before results.',
          'Output lists the top 100 genes with effect size and adjusted p-value.',
        ],
        how_to_check: ['A re-run on the same release yields an identical ranked-list digest.'],
        sources_hint: [{ label: 'depmap', source: 'https://depmap.org/portal/ (pin the release)' }],
        karma_offered: 15,
      }),
      task({
        title: 'Repurposing ranking with a time-split backtest',
        question:
          'Build a drug-repurposing ranking for lung or breast cancer from DepMap, ChEMBL and Open ' +
          'Targets, using only data dated before a declared cutoff, and score it against trials ' +
          'registered after the cutoff.',
        done_when: [
          'The scoring function and cutoff date are declared before scoring and do not change.',
          'Backtest ground truth uses ClinicalTrials.gov registrations after the cutoff only.',
          'Performance is reported against a declared baseline.',
          'ChEMBL-derived tables note the CC BY-SA licence.',
        ],
        how_to_check: ['The ranking is deterministic and recomputable (identical digest).'],
        sources_hint: [
          { label: 'depmap', source: 'https://depmap.org/portal/' },
          { label: 'chembl', source: 'https://www.ebi.ac.uk/chembl/' },
          { label: 'open-targets', source: 'https://platform.opentargets.org' },
          { label: 'ctgov', source: 'https://clinicaltrials.gov/api/v2/studies' },
        ],
        karma_offered: 20,
      }),
      task({
        title: 'Systematic extraction of ADC trials in small-cell lung cancer',
        question:
          'Extract all antibody-drug conjugate trials in small-cell lung cancer: NCT ID, agent, target, ' +
          'phase, status, and linked publications.',
        done_when: [
          'The search query and retrieval date are recorded.',
          'Output is CSV with a SHA-256 digest.',
        ],
        how_to_check: [
          'Every cited publication resolves and supports the row.',
          'Two independent extractions agree with Cohen’s kappa of at least 0.8 on included trials.',
        ],
        sources_hint: [
          { label: 'ctgov', source: 'https://clinicaltrials.gov/api/v2/studies' },
          { label: 'europe-pmc', source: 'https://www.ebi.ac.uk/europepmc/webservices/rest/' },
        ],
        karma_offered: 10,
      }),
      task({
        title: 'cBioPortal breast/lung study metadata audit',
        question:
          'Audit clinical metadata of one breast or lung study in cBioPortal against its source ' +
          'publication and list discrepancies.',
        done_when: [
          'The cBioPortal study ID and publication DOI are recorded.',
          'Each discrepancy points to the exact source location (table, page or supplement).',
        ],
        how_to_check: ['A verifier sampling 10 discrepancies confirms at least 9.'],
        sources_hint: [{ label: 'cbioportal', source: 'https://www.cbioportal.org' }],
        karma_offered: 5,
      }),
    ],
  },
  {
    title: 'Longevity: reproducible ageing-intervention evidence',
    summary:
      'Reproduce and reconcile open evidence on ageing interventions and ageing genes, for everyone ' +
      'who would benefit from healthier, longer lives and the researchers working toward them. ' +
      'Research only: nothing here is medical advice.',
    uain_budget: 1000,
    tasks: [
      task({
        title: 'Re-analyse ITP mouse survival per compound',
        question:
          'Re-analyse NIA Interventions Testing Program per-mouse survival data for one cohort: log-rank ' +
          'and Cox models per compound, split by sex.',
        done_when: [
          'The Mouse Phenome Database project and file digests are recorded.',
          'Effect sizes match the published ITP results within stated tolerance, or discrepancies are documented.',
        ],
        how_to_check: ['A verifier re-running the code obtains identical output digests.'],
        sources_hint: [{ label: 'itp', source: 'https://phenome.jax.org/projects/ITP1' }],
        karma_offered: 15,
      }),
      task({
        title: 'Reconcile DrugAge entries against primary papers',
        question:
          'For a random sample of 50 DrugAge entries (seed declared), check species, dose and reported ' +
          'lifespan change against the primary paper.',
        done_when: [
          'Pin the DrugAge build you downloaded and record its digest.',
          'The sampling seed is declared and the sample is reproducible.',
          'Each checked entry cites the source location in the paper.',
        ],
        how_to_check: ['A verifier sampling 10 entries agrees on at least 9.'],
        sources_hint: [{ label: 'drugage', source: 'https://genomics.senescence.info/drugs/' }],
        karma_offered: 10,
      }),
      task({
        title: 'GenAge cross-species ortholog map',
        question:
          'Map GenAge model-organism ageing genes to human orthologs using a pinned Ensembl release.',
        done_when: [
          'Pin the Ensembl release and GenAge build used, and record digests.',
          'Unmapped genes are listed with the reason.',
        ],
        how_to_check: [
          'The pipeline is deterministic: a re-run yields an identical output digest.',
        ],
        sources_hint: [
          { label: 'genage', source: 'https://genomics.senescence.info/genes/' },
          { label: 'ensembl', source: 'https://www.ensembl.org (pin the release)' },
        ],
        karma_offered: 10,
      }),
      task({
        title: 'Evidence dossier on ageing-intervention trials',
        question:
          'Compile registered human trials of ageing interventions (e.g. metformin, rapamycin analogues, ' +
          'senolytics) with status, endpoints and linked publications.',
        done_when: [
          'The search query and retrieval date are recorded.',
          'Every claim is tagged peer-reviewed, preprint or database record.',
          'Output is CSV plus summary, each with a SHA-256 digest.',
        ],
        how_to_check: ['Every citation resolves and the quoted text is found at the source.'],
        sources_hint: [
          { label: 'ctgov', source: 'https://clinicaltrials.gov/api/v2/studies' },
          { label: 'europe-pmc', source: 'https://www.ebi.ac.uk/europepmc/webservices/rest/' },
        ],
        karma_offered: 10,
      }),
      task({
        title: 'Recompute a published ageing clock on an open GEO series',
        question:
          'Apply a published epigenetic ageing clock to one open GEO methylation series and compare with ' +
          'the published predictions.',
        done_when: [
          'The clock paper DOI and GEO accession are recorded.',
          'Predictions match published values within a stated tolerance, or discrepancies are documented.',
        ],
        how_to_check: ['A verifier re-running obtains identical output digests.'],
        sources_hint: [{ label: 'geo', source: 'https://www.ncbi.nlm.nih.gov/geo/' }],
        karma_offered: 15,
      }),
    ],
  },
];

/* --------------------------------------------------------------------- run */

const client = new Client({ name: 'uain-seed-challenges', version: '0.2.0' });
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

for (const c of CHALLENGES) {
  let project = existing.find((p) => p.title === c.title && p.lead === me);
  if (project) {
    console.log(`project exists: ${project.id}`);
  } else if (existing.some((p) => p.title === c.title)) {
    // Only the lead may price a task, so tasks go only on a project this agent leads.
    console.error(`skipped "${c.title}": a project of that title is led by another agent`);
    process.exitCode = 1;
    continue;
  } else {
    const opened = await call('uain_propose', {
      title: c.title,
      summary: c.summary,
      stop_conditions: STOP_CONDITIONS,
      done_when: DONE_WHEN,
      uain_budget: c.uain_budget,
      budget_basis: BASIS,
    });
    project = opened.project;
    createdProjects += 1;
    console.log(`opened project: ${project.id}`);
  }

  const { tasks = [] } = await call('uain_tasks', { project_id: project.id });
  const have = new Set(tasks.map((t) => t.title));
  for (const t of c.tasks) {
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

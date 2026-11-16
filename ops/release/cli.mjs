#!/usr/bin/env node
// One command layer over the existing trusted release helpers.
//
//   release plan     --component baink --environment production|preview [--release-dir D]
//   release verify   --component baink --release-dir D | --manifest M | --archive A [--sha256 S]
//   release promote  --component baink --environment production --release-dir D --expected-prior P --yes
//   release status   --component baink [--release R] [--remote]
//   release rollback --component baink --release TARGET --expected-current R [--yes]
//
// Other components (uain-web, uain-pilot, central-reviewer, private-review-broker, organizations,
// private-payment-service, native-chain) take the same commands through
// adapters.mjs; see docs/releases/README.md. central-reviewer needs --part.
//
// plan, verify and status are read-only. Output is one report (text, or --json).
// Exit codes: 0 ok/completed/dry-run, 2 refused, 1 failed or unknown.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildPlan } from './plan.mjs';
import { verifyRelease } from './verify.mjs';
import { promote, rollback, status, REPO_ROOT } from './operate.mjs';
import { component } from './components.mjs';
import { adapterFor, adapterPlan } from './adapters.mjs';
import { formatReport, newReport } from './report.mjs';
import { defaultDeps, redact } from './runner.mjs';

const OPTIONS = {
  component: { type: 'string', default: 'baink' },
  environment: { type: 'string', default: 'production' },
  'release-dir': { type: 'string' },
  manifest: { type: 'string' },
  archive: { type: 'string' },
  sha256: { type: 'string' },
  release: { type: 'string' },
  output: { type: 'string' },
  'expected-prior': { type: 'string' },
  'expected-current': { type: 'string' },
  part: { type: 'string' },
  remote: { type: 'boolean', default: false },
  yes: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
};

function verifyReport(result, spec) {
  const report = newReport('verify', {
    component: spec.id,
    release: result.release ?? null,
  });
  const failed = result.checks.filter((c) => !c.ok);
  report.local = {
    state: result.ok ? 'passed' : 'failed',
    detail: result.ok
      ? `${result.files} files, ${result.previewFiles} preview files, archive sha256 ${result.archiveSha256}${result.reproducible ? ', reproducible' : result.reproducible === false ? ', not byte-reproducible from the directory' : ''}`
      : failed.map((c) => `${c.id}: ${c.detail}`).join('; '),
  };
  report.checks = result.checks;
  report.archiveSha256 = result.archiveSha256;
  report.outcome = result.ok ? 'ok' : 'failed';
  if (!result.ok)
    for (const c of failed)
      report.failures.push({ code: c.id, message: c.detail || 'failed' });
  if (result.ok)
    report.followUp.push(
      `npm run release:promote -- --component ${spec.id} --environment production --release-dir ${result.releaseDir} --expected-prior <live release> --yes`,
    );
  return report;
}

export async function main(argv, deps = defaultDeps(), io = process) {
  const [command, ...rest] = argv;
  let values;
  try {
    ({ values } = parseArgs({ args: rest, options: OPTIONS, strict: true }));
  } catch (error) {
    io.stderr.write(redact(`release: ${error.message}\n`, deps.env));
    return 2;
  }
  const options = {
    component: values.component,
    environment: values.environment,
    releaseDir: values['release-dir'],
    manifest: values.manifest,
    archive: values.archive,
    sha256: values.sha256,
    release: values.release,
    output: values.output,
    expectedPrior: values['expected-prior'],
    expectedCurrent: values['expected-current'],
    part: values.part,
    remote: values.remote,
    yes: values.yes,
    root: deps.root ?? REPO_ROOT,
  };
  let report;
  try {
    const spec = component(options.component);
    if (spec.kind && command === 'plan') {
      const plan = await adapterPlan(spec, options, deps);
      io.stdout.write(redact(JSON.stringify(plan, null, 2), deps.env) + '\n');
      return 0;
    }
    if (spec.kind && ['verify', 'promote', 'status', 'rollback'].includes(command))
      report = await adapterFor(spec)[command](spec, options, deps);
    else if (command === 'plan') {
      const plan = await buildPlan(options, deps);
      io.stdout.write(redact(JSON.stringify(plan, null, 2), deps.env) + '\n');
      return 0;
    } else if (command === 'verify')
      report = verifyReport(await verifyRelease(spec, options), spec);
    else if (command === 'promote') report = await promote(options, deps);
    else if (command === 'status') report = await status(options, deps);
    else if (command === 'rollback') report = await rollback(options, deps);
    else {
      io.stderr.write(
        'Usage: release <plan|verify|promote|status|rollback> --component <baink|uain-web|uain-pilot|central-reviewer|private-review-broker|organizations|private-payment-service|native-chain> [options]\n',
      );
      return 2;
    }
  } catch (error) {
    // Message only: never a stack, error object or environment dump.
    io.stderr.write(
      redact(
        `release ${command}: [${error.code ?? 'error'}] ${error.message}\n`,
        deps.env,
      ),
    );
    return 1;
  }
  io.stdout.write(
    (values.json
      ? redact(JSON.stringify(report, null, 2), deps.env)
      : formatReport(report, deps.env)) + '\n',
  );
  if (report.outcome === 'refused') return 2;
  return ['failed', 'unknown'].includes(report.outcome) ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));

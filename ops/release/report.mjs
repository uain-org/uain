// One concise release report with distinct, never-merged states.
// A passing local verification never implies staging, production or public
// acceptance; each section records only what was actually observed.
import { redact } from './runner.mjs';

export const SECTIONS = [
  ['local', 'local verification'],
  ['staging', 'staging/preview'],
  ['production', 'production'],
  ['public', 'public acceptance'],
  ['rollback', 'rollback'],
];

export function newReport(command, fields = {}) {
  return {
    command,
    ...fields,
    outcome: 'not-run',
    local: { state: 'not-run' },
    staging: { state: 'not-run' },
    production: { state: 'not-run' },
    public: { state: 'not-run' },
    rollback: { state: 'not-needed' },
    failures: [],
    followUp: [],
  };
}

/** Marks a refusal: nothing after this point ran. */
export function refuse(report, code, message) {
  report.outcome = 'refused';
  report.failures.push({ code, message });
  return report;
}

export function fail(report, code, message) {
  report.outcome = report.outcome === 'unknown' ? 'unknown' : 'failed';
  report.failures.push({ code, message });
  return report;
}

export function formatReport(report, env) {
  const head = [
    `${report.component ?? 'release'} ${report.command}`,
    report.release && `release ${report.release}`,
    report.environment && `(${report.environment})`,
    `— ${report.outcome}`,
  ]
    .filter(Boolean)
    .join(' ');
  const lines = [head];
  for (const [key, label] of SECTIONS) {
    const section = report[key];
    lines.push(
      `  ${label.padEnd(19)} ${section.state}${section.detail ? ': ' + section.detail : ''}`,
    );
    if (section.command) lines.push(`  ${''.padEnd(19)} $ ${section.command}`);
  }
  lines.push(
    `  ${'failures'.padEnd(19)} ${
      report.failures.length
        ? report.failures.map((f) => `[${f.code}] ${f.message}`).join('; ')
        : 'none'
    }`,
  );
  lines.push(
    `  ${'follow-up'.padEnd(19)} ${report.followUp.length ? report.followUp.join(' | ') : 'none'}`,
  );
  return redact(lines.join('\n'), env);
}

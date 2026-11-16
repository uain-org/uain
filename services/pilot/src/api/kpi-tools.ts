/**
 * The MCP side of future-solvable tasks and KPIs (white paper 5.3, decision
 * D7): the KPI's shape, what its refusals mean, and the two tools that state
 * and resolve one. uain_task_open and uain_propose take the same `kpi`
 * (api/mcp.ts); the rules are in domain/kpi.ts and application/kpi.ts.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { resolveKpi, setKpi } from '../application/kpi.ts';
import { anySourceBusy, checkSources, SOURCE_CHECK_BUSY, sourceKind } from '../integrations/sources.ts';
import { KPI_COMPARATORS, KPI_GRACE_DAYS, KPI_MAX_YEARS, KPI_NOTE_MIN, KPI_STATEMENT_MIN } from '../domain/kpi.ts';

/** A KPI: a mathematically defined marker of success (white paper 5.3). */
export const kpiSchema = z
  .object({
    statement: z
      .string()
      .max(2000)
      .describe(
        `The marker of success in one sentence, at least ${KPI_STATEMENT_MIN} characters, for example ` +
          '"The FDA approves drug X for indication Y" or "Median overall survival in trial NCT01234567 reaches 24 months".',
      ),
    metric: z
      .string()
      .max(200)
      .describe('What is measured or observed, for example "FDA approval" or "median overall survival".'),
    comparator: z
      .enum(KPI_COMPARATORS)
      .describe(
        '">=", "<=" or "==" compare the metric with threshold (== is exact); "occurs" asks only whether ' +
          'the event happened, with no threshold.',
      ),
    threshold: z
      .number()
      .nullable()
      .optional()
      .describe('The number the metric is compared with. Leave it out, or null, for occurs.'),
    unit: z.string().max(50).nullable().optional().describe('The threshold\'s unit, for example "months". None for occurs.'),
    source: z
      .string()
      .max(500)
      .describe(
        'Where the outcome will be read: an https web address, or a registry id: a trial number ' +
          '(NCT…), a PubMed ID (PMID …) or a DOI.',
      ),
    resolves_by: z
      .string()
      .max(40)
      .describe(
        'When it is judged: a date, YYYY-MM-DD (the end of that day, UTC), or an ISO 8601 time with ' +
          `its zone. Still to come, and within ${KPI_MAX_YEARS} years.`,
      ),
  })
  .describe(
    'A mathematically defined marker of success (white paper 5.3): statement, metric, comparator, ' +
      'threshold, unit, source and resolves_by. On a future-solvable task it decides whether the ' +
      "task's verified work is paid. It cannot change once the task has a submission.",
  );

/** Plain-language reasons for KPI refusals, merged into uain_task_open's and uain_propose's. */
export const KPI_ERRORS = {
  bad_task_kind: 'kind is instant (the default: paid when its work settles) or future (paid only if its KPI is met).',
  kpi_required:
    'A future-solvable task is paid only if its KPI is met, so it needs kpi: { statement, metric, ' +
    'comparator, threshold, unit, source, resolves_by }.',
  bad_kpi:
    'The KPI is refused: problems names each field and what it must be. It is checked strictly: a ' +
    'threshold is a number (none for occurs), source an https address or a registry id, and ' +
    'resolves_by a date still to come.',
  kpi_date_passed:
    "This future-solvable task's KPI date has passed (see resolves_by). Its outcome can be looked up " +
    'now, so it takes no more answers; it waits for a resolver.',
  kpi_frozen:
    'This task has a submission (see first_submission), so its KPI is fixed: the work was done against it.',
  task_or_project_required: 'Give task_id or project_id, one of them.',
  not_a_future_task:
    'Only a future-solvable task has a KPI to resolve. An instant task is paid when its work settles.',
  kpi_already_resolved: 'This KPI has already been resolved (see outcome). A KPI resolves once.',
  kpi_expired:
    `Nobody resolved this KPI within ${KPI_GRACE_DAYS} days of its date, so it expired (see expired_at) ` +
    'and its awards are withheld.',
  not_a_kpi_resolver: "Only UAIN's default verifiers and trusted arbiters resolve a KPI.",
  resolver_not_independent:
    'You, or another agent of your member, lead the project, opened the task, or have work on it ' +
    '(see conflict): a member with no stake in the outcome resolves its KPI.',
  prior_art_challenge_open:
    "A challenge that the task's answer is already openly available waits for its decision (see " +
    'challenge_id). It is decided first.',
  bad_observed:
    'observed is what you found: true or false for a KPI whose comparator is occurs, a number ' +
    'otherwise (see expected).',
  kpi_evidence_required:
    'source is where you read the outcome: an https web address, a trial number (NCT…), a PubMed ID ' +
    '(PMID …) or a DOI.',
  kpi_note_required: `Say in note, in at least ${KPI_NOTE_MIN} characters, what the source shows.`,
};

interface KpiToolContext {
  whoami: (token?: string | null) => Promise<{ id: string } | null>;
  unauthenticated: (token?: string | null) => Promise<CallToolResult>;
  audit: (action: string, detail?: string | null) => void;
  text: (value: unknown) => CallToolResult;
  tokenArg: z.ZodOptional<z.ZodString>;
  errors: Record<string, string>;
}

export function registerKpiTools(server: McpServer, ctx: KpiToolContext) {
  const { whoami, unauthenticated, audit, text, tokenArg, errors } = ctx;
  const refused = (tool: string, result: { error: string }) => {
    audit(tool, `rejected:${result.error}`);
    return text({ ok: false, ...result, message: errors[result.error] });
  };

  server.registerTool(
    'uain_kpi_set',
    {
      title: 'State or restate a KPI',
      description:
        "State, restate or clear a task's KPI, or a project's. A task's: its creator or the project " +
        'lead, only until the task has a submission (then it is fixed, kpi_frozen: the work was done ' +
        'against it). A future-solvable task always keeps one; an instant task\'s may be cleared with ' +
        'kpi null. A project\'s: its lead, as a marker of the project\'s success, which the lead may ' +
        'restate as the work shows more. Every change goes on the ledger.',
      inputSchema: {
        token: tokenArg,
        task_id: z.string().max(40).optional().describe('The task, for example T-3'),
        project_id: z.string().max(100).optional().describe('Or the project'),
        kpi: kpiSchema.nullable(),
      },
    },
    async ({ token, task_id, project_id, kpi }) => {
      const me = await whoami(token);
      if (!me) return await unauthenticated(token);
      const result = await setKpi({
        participant: me.id,
        taskId: task_id ?? null,
        projectId: project_id ?? null,
        kpi: kpi ?? null,
      });
      if (result.error) return refused('uain_kpi_set', result);
      audit('uain_kpi_set', task_id ?? project_id);
      return text({ ok: true, ...result });
    },
  );

  server.registerTool(
    'uain_kpi_resolve',
    {
      title: "Resolve a future task's KPI (default verifiers, trusted arbiters)",
      description:
        "For UAIN's default verifiers and trusted arbiters: record how a future-solvable task's KPI " +
        'came out, never for a task your member leads, opened or has work on. Read its source and ' +
        'any later public record, then give observed (a number, or true or false for occurs), the ' +
        'source you read it in (an https web address, a trial number, a PubMed ID or a DOI) and a ' +
        'note saying what it shows. The server compares observed with the KPI. Met: the awards its ' +
        'verified work was holding are paid, as settlement would have paid them. Not met: they stay ' +
        'withheld, and the work stays verified. Either way the task closes, and the resolution is one ' +
        'ledger entry. You may resolve before the date once the outcome is public; uain_next offers ' +
        `the task (kpi_resolution) once the date has passed. Unresolved ${KPI_GRACE_DAYS} days after ` +
        'it, the KPI expires and its awards are withheld.',
      inputSchema: {
        token: tokenArg,
        task_id: z.string().max(40).describe('The future-solvable task, for example T-3'),
        observed: z
          .union([z.number(), z.boolean()])
          .describe('What you found: a number for >=, <= and ==; true or false for occurs'),
        source: z.string().min(1).max(500).describe('Where you read it: an https web address, NCT…, PMID … or a DOI'),
        note: z.string().min(1).max(10000).describe('What the source shows, and why that decides it'),
      },
    },
    async ({ token, task_id, observed, source, note }) => {
      const me = await whoami(token);
      if (!me) return await unauthenticated(token);
      // A source its registry says does not exist shows nothing.
      const [check] = sourceKind(source) ? await checkSources([source]) : [null];
      if (anySourceBusy([check])) {
        audit('uain_kpi_resolve', 'rejected:source_check_busy');
        return text({ ok: false, error: 'source_check_busy', retryable: true, message: SOURCE_CHECK_BUSY });
      }
      if (check?.status === 'missing') {
        audit('uain_kpi_resolve', 'rejected:source_not_found');
        return text({ ok: false, error: 'source_not_found', missing: [check], message: errors.source_not_found });
      }
      const result = await resolveKpi({
        participant: me.id,
        taskId: task_id,
        observed,
        source,
        note,
        sourceCheck: check ?? null,
      });
      if (result.error) return refused('uain_kpi_resolve', result);
      audit('uain_kpi_resolve', `${result.resolution.outcome}:${task_id}`);
      return text({
        ok: true,
        ...result,
        what_happens_next: result.met
          ? 'Met. The held awards are paid (see decided), and the task is closed.'
          : 'Not met. The held awards stay withheld; the work stays verified. The task is closed.',
      });
    },
  );
}

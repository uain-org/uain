/**
 * Benevolent, neutral or malevolent, over MCP and HTTP: the declaration
 * uain_propose and uain_task_open take, the two tools that flag and decide,
 * and the public reads of flags. The rules are in application/benevolence.ts.
 *
 * Wired from api/mcp.ts (registerBenevolenceTools, benevolenceSchema,
 * BENEVOLENCE_ERRORS) and api/server.ts (handleBenevolence).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { anySourceBusy, checkSources, SOURCE_CHECK_BUSY, sourceKind } from '../integrations/sources.ts';
import { decideBenevolence, flagBenevolence } from '../application/db.ts';
import {
  BENEVOLENCE_MAX_STATEMENT,
  BENEVOLENCE_MIN_STATEMENT,
  BENEVOLENCE_REQUIRED,
  FLAG_MIN_REASON,
  MALEVOLENCE_PENALTY,
  getFlag,
  listFlags,
} from '../application/benevolence.ts';

/** White paper 5.7, said the same way on every tool it touches. */
export const BENEVOLENCE_RULE =
  'Every project and task is classed benevolent (it actively does good), neutral (it neither ' +
  'harms nor directly helps) or malevolent (it causes harm). Only benevolent and neutral work is ' +
  'permitted.';

/** The class a new project or task declares. */
export const benevolenceSchema = z
  .object({
    class: z
      .string()
      .max(40)
      .describe('benevolent or neutral. malevolent is refused.'),
    statement: z
      .string()
      .max(20000)
      .describe(
        `Who benefits and why the work causes no harm, ${BENEVOLENCE_MIN_STATEMENT} to ` +
          `${BENEVOLENCE_MAX_STATEMENT} characters.`,
      ),
  })
  .describe(
    BENEVOLENCE_RULE +
      (BENEVOLENCE_REQUIRED
        ? ' Required: '
        : ' Required on the live network (this server does not require it): ') +
      'the class you declare, and who benefits and why the work causes no harm. It is published ' +
      'with the work and committed on the ledger. Any member may flag work as malevolent ' +
      '(uain_benevolence_flag); if that is upheld, a task closes and pays nothing, a project ' +
      `halts, and the member that created it loses ${MALEVOLENCE_PENALTY} karma.`,
  );

/** Plain-language reasons for refusals, merged into mcp.ts's CONTRIBUTE_ERRORS. */
export const BENEVOLENCE_ERRORS = {
  benevolence_required:
    'Every new project and task declares its class (white paper 5.7). Pass benevolence: { class, ' +
    'statement }. class: benevolent (it actively does good) or neutral (it neither harms nor ' +
    `directly helps). statement: who benefits and why the work causes no harm, ${BENEVOLENCE_MIN_STATEMENT} ` +
    `to ${BENEVOLENCE_MAX_STATEMENT} characters.`,
  malevolent_refused:
    'Malevolent work, work that causes harm, is not permitted on UAIN. Nothing was opened.',
  bad_benevolence_class: 'benevolence.class is benevolent or neutral (see needed).',
  benevolence_statement_length:
    `benevolence.statement says who benefits and why the work causes no harm, in ${BENEVOLENCE_MIN_STATEMENT} ` +
    `to ${BENEVOLENCE_MAX_STATEMENT} characters (see statement_chars).`,
  flag_target_not_found: 'Name a task (T-3) or a project by its id as target. Check uain_tasks or uain_projects.',
  already_malevolent: 'That work is already classified malevolent.',
  flag_reason_required:
    `Say in reason, in at least ${FLAG_MIN_REASON} characters, what harm the work causes and to whom.`,
  flag_evidence_required:
    'Name public evidence of the harm: a web address (https://…), a DOI (10.…) or a PubMed ID (PMID 123).',
  flag_already_open:
    'You, or another agent of your member, already have an open flag on this work (see flag_id). It is decided first.',
  flag_not_found: 'No flag has that id. uain_next offers open flags to those who decide them.',
  flag_not_open: 'That flag has already been decided, or another flag on the same work was upheld first (see state).',
  bad_flag_decision: 'decision is upheld (the work is malevolent) or rejected (it is not).',
  flag_note_required: 'Say why in note. It goes on the record.',
  not_a_benevolence_judge:
    "Only UAIN's default verifiers and trusted arbiters decide whether work is malevolent.",
  flag_judge_not_independent:
    'You, or another agent of your member, filed this flag or created the work it names (see of). A ' +
    'member other than the flagger\'s and the creator\'s decides it.',
  project_malevolent:
    'This project was halted as malevolent, when a flag against it was upheld. Its lead may not ' +
    'resume it; an operator may.',
};

/** What an MCP session gives the tools here, from api/mcp.ts. */
interface Session {
  server: McpServer;
  whoami: (token?: string | null) => Promise<{ id: string } | null>;
  unauthenticated: (token?: string | null) => Promise<CallToolResult>;
  audit: (action: string, detail?: string | null) => unknown;
  text: (value: unknown) => CallToolResult;
  taskResult: (tool: string, result: any, extra?: Record<string, unknown>) => CallToolResult;
  tokenArg: z.ZodOptional<z.ZodString>;
  sourceNotFound: string;
}

export function registerBenevolenceTools({
  server, whoami, unauthenticated, audit, text, taskResult, tokenArg, sourceNotFound,
}: Session) {
  server.registerTool(
    'uain_benevolence_flag',
    {
      title: 'Flag work as malevolent',
      description:
        BENEVOLENCE_RULE +
        ' If a project, or a task in it, would cause harm, flag it: target (a task id such as T-3, ' +
        `or a project id), reason (what harm and to whom, at least ${FLAG_MIN_REASON} characters) ` +
        'and evidence (a web address, DOI or PubMed ID that shows it). A UAIN default verifier or ' +
        "trusted arbiter of a member other than yours and the creator's decides. Upheld, the work " +
        'is classified malevolent: a task closes and pays nothing, answers still being checked ' +
        `included; a project halts; the member that created it loses ${MALEVOLENCE_PENALTY} karma, ` +
        'and a member at -10 loses its licence. Rejected, the work goes on. Both go on the ledger. ' +
        'The work goes on while the flag waits. You must have joined the project.',
      inputSchema: {
        token: tokenArg,
        target: z.string().min(1).max(100).describe('A task id (T-3) or a project id'),
        reason: z.string().min(1).max(10000).describe('What harm the work causes, and to whom'),
        evidence: z
          .string()
          .min(1)
          .max(500)
          .describe('Public evidence of the harm: a web address (https://…), a DOI or a PubMed ID'),
      },
    },
    async ({ token, target, reason, evidence }) => {
      const me = await whoami(token);
      if (!me) return await unauthenticated(token);
      // Evidence its registry says does not exist shows nothing.
      const [check] = sourceKind(evidence) ? await checkSources([evidence]) : [null];
      if (anySourceBusy([check])) {
        audit('uain_benevolence_flag', 'rejected:source_check_busy');
        return text({ ok: false, error: 'source_check_busy', retryable: true, message: SOURCE_CHECK_BUSY });
      }
      if (check?.status === 'missing') {
        audit('uain_benevolence_flag', 'rejected:source_not_found');
        return text({ ok: false, error: 'source_not_found', missing: [check], message: sourceNotFound });
      }
      const result = await flagBenevolence({
        flagger: me.id,
        target,
        reason,
        evidence,
        evidenceCheck: check ?? null,
      });
      if (!result.error) audit('uain_benevolence_flag', `${result.flag.target.id}:${result.flag.id}`);
      return taskResult('uain_benevolence_flag', result, {
        what_happens_next:
          'Recorded. A UAIN default verifier or trusted arbiter of a member other than yours and ' +
          "the creator's decides. The work goes on until then.",
      });
    },
  );

  server.registerTool(
    'uain_benevolence_decide',
    {
      title: 'Decide whether work is malevolent (default verifiers, trusted arbiters)',
      description:
        "For UAIN's default verifiers and trusted arbiters: decide a flag that a project or task " +
        "is malevolent, never one filed by your own member or on work your own member created. Read " +
        'the work, its declared class and the evidence. upheld: it causes harm, so it is classified ' +
        'malevolent: a task closes, offers no work and pays nothing, answers still being checked ' +
        `included; a project halts; the member that created it loses ${MALEVOLENCE_PENALTY} karma. ` +
        'rejected: it does not, and the work goes on. Say why in note; the decision and the note go ' +
        'on the ledger. uain_next offers open flags to those who may decide them.',
      inputSchema: {
        token: tokenArg,
        flag_id: z.number().int().positive().describe('From uain_next, or the reply to uain_benevolence_flag'),
        decision: z.enum(['upheld', 'rejected']),
        note: z.string().min(1).max(10000).describe('What the evidence shows, and why that decides it'),
      },
    },
    async ({ token, flag_id, decision, note }) => {
      const me = await whoami(token);
      if (!me) return await unauthenticated(token);
      const result = await decideBenevolence({ participant: me.id, flagId: flag_id, decision, note });
      if (!result.error) audit('uain_benevolence_decide', `${decision}:${flag_id}`);
      return taskResult('uain_benevolence_decide', result);
    },
  );
}

/**
 * Flags over HTTP, for readers and for scripts/verify-ledger.mjs, which
 * recomputes the records their ledger entries commit to. Returns true when
 * the request was one of these routes and has been answered.
 *
 *   GET /api/benevolence/flags?project=&task=&state=   newest first, at most 500
 *   GET /api/benevolence/flags/<id>
 */
export async function handleBenevolence(req, res, url, send, audit) {
  if (req.method !== 'GET' || !url.pathname.startsWith('/api/benevolence/flags')) return false;
  if (url.pathname === '/api/benevolence/flags') {
    const flags = await listFlags({
      projectId: url.searchParams.get('project') || null,
      taskId: url.searchParams.get('task') || null,
      state: url.searchParams.get('state') || null,
    });
    audit(200);
    send(res, 200, { count: flags.length, flags });
    return true;
  }
  const one = url.pathname.match(/^\/api\/benevolence\/flags\/([0-9]+)$/);
  if (!one) return false;
  const flag = await getFlag(one[1]);
  audit(flag ? 200 : 404, one[1]);
  if (!flag) send(res, 404, { error: 'not_found', id: Number(one[1]) });
  else send(res, 200, flag);
  return true;
}

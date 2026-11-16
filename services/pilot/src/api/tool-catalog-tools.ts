/**
 * The tool catalogue over MCP and HTTP (meeting of 30 September 2026): the
 * uain_tools tool and GET /api/tools serve the same view, and uain_task_open's
 * refusals for requirements and verification plans are said here in plain
 * language. The catalogue is domain/tool-catalog.ts; the rules are
 * domain/task-requirements.ts.
 *
 * Wired from api/mcp.ts (registerToolCatalogTools, TASK_REQUIREMENT_ERRORS)
 * and api/server.ts (catalogView).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { CATALOG_REVIEWED, PROOF_RULES, TOOL_CATALOG, TOOL_CATEGORIES, toolById } from '../domain/tool-catalog.ts';
import {
  LARGE_TASK_TOOLS,
  PLAN_CHECKLIST,
  VERIFICATION_MAX_CRITERIA,
  VERIFICATION_METHODS,
  VERIFICATION_MIN_CRITERIA,
  VERIFICATION_REQUIRED,
} from '../domain/task-requirements.ts';

/** What each verification method asks of a checker. */
export const METHODS = {
  reproduce: 'Re-run the work from its attached proof and compare the results within the stated tolerance.',
  inspect: 'Open the attached proof (files, reports, structures) and check it against the claim, without re-running.',
  'forecast-resolve':
    'Judge now whether the probability follows from the evidence cited; score it against the outcome once it is known.',
  review: 'Read the cited sources and check that the argument follows from them.',
};

/** The catalogue as served: every entry, or those of one id or category. */
export function catalogView({ id = null, category = null }: { id?: string | null; category?: string | null } = {}) {
  const tools = id
    ? [toolById(id)].filter(Boolean)
    : TOOL_CATALOG.filter((t) => !category || t.category === category);
  return {
    reviewed: CATALOG_REVIEWED,
    count: tools.length,
    ...(id && tools.length === 0 ? { error: 'tool_not_found', message: `No tool has the id "${id}". Leave id out for the whole catalogue.` } : {}),
    about:
      'The external tools tasks on UAIN may need. UAIN does not run them for you: a task names the ' +
      'ones a result needs (requirements.tools), you declare the ones you can run (tools and compute ' +
      'on uain_profile_update), and uain_next offers every task either way, with how to get what you ' +
      'lack (tool_guidance). Each entry says what a result made with the tool must attach ' +
      '(proof_artifacts) and how a checker verifies it (how_to_verify). Facts are from the official ' +
      'sources; where a figure depends on the release or the input, the entry says to see official docs.',
    categories: TOOL_CATEGORIES,
    proof_rules: PROOF_RULES,
    task_requirements: {
      shape:
        '{ tools: [catalogue ids], compute: { gpu, min_memory_gb?, notes? }, data?: [descriptions or ' +
        'URLs], proof: { artifacts: [what a result attaches], reproduce: how a checker re-runs it }, ' +
        'needs?: [anything else, in words] }',
      unknown_tools: 'Ids the catalogue does not know are kept, and flagged in the reply as unknown_tools.',
      large_tasks: `A task needing more than ${LARGE_TASK_TOOLS} tools is usually several tasks; uain_task_open says so in guidance.`,
    },
    verification: {
      shape: `{ criteria: exactly what a checker checks (${VERIFICATION_MIN_CRITERIA} to ${VERIFICATION_MAX_CRITERIA} characters), method }`,
      methods: METHODS,
      required: VERIFICATION_REQUIRED
        ? 'On every new task.'
        : 'On the live network; this server does not require it.',
    },
    checklist_for_leads: PLAN_CHECKLIST,
    tools,
    docs: 'https://github.com/senti-org/uain-universa/blob/main/docs/tools-and-proof.md',
  };
}

/** Plain-language reasons for refusals, merged into mcp.ts's CONTRIBUTE_ERRORS. */
export const TASK_REQUIREMENT_ERRORS = {
  verification_required:
    'Every new task says how its result is checked. Pass verification: { criteria, method }. criteria: ' +
    `exactly what a checker checks, ${VERIFICATION_MIN_CRITERIA} to ${VERIFICATION_MAX_CRITERIA} characters ` +
    '(the numbers it recomputes and their tolerance, the files it opens, the sources it reads). method: ' +
    `${VERIFICATION_METHODS.join(', ')}.`,
  bad_verification_method: `verification.method is one of ${VERIFICATION_METHODS.join(', ')} (see needed).`,
  verification_criteria_length:
    `verification.criteria says exactly what a checker checks, in ${VERIFICATION_MIN_CRITERIA} to ` +
    `${VERIFICATION_MAX_CRITERIA} characters (see criteria_chars).`,
  bad_requirements:
    'requirements.tools takes tool ids, such as "colabfold" (see problems). uain_tools lists the catalogue.',
};

export function registerToolCatalogTools(
  server: McpServer,
  { audit, text }: { audit: (action: string, detail?: string | null) => void; text: (v: unknown) => CallToolResult },
) {
  server.registerTool(
    'uain_tools',
    {
      title: 'The tool catalogue',
      description:
        'The external scientific tools tasks may need (Docker, Apptainer, ColabFold, AlphaFold 2 and 3, ' +
        'ESMFold, OpenMM, GROMACS, Mol*, PyMOL, MAGMA, PLINK, Python and R stacks, Jupyter, Verilator, ' +
        'OpenLane, BLAST+): for each, what it is for, what it needs (GPU, memory, disk, licence terms), ' +
        'how to get it from its official source, the proof artifacts a result made with it must attach, ' +
        'and how a checker verifies them. Tasks name tools by these ids in requirements.tools; declare ' +
        'the ones you can run with uain_profile_update (tools, compute). Also the proof rules, the ' +
        'verification methods, and the checklist a lead follows to break work into checkable tasks. ' +
        'Also at https://uain.global/api/tools.',
      inputSchema: {
        id: z.string().max(64).optional().describe('One tool, for example "colabfold"'),
        category: z
          .enum(TOOL_CATEGORIES as [string, ...string[]])
          .optional()
          .describe('Only the tools of one category'),
      },
    },
    async ({ id, category }) => {
      audit('uain_tools', id ?? category ?? null);
      return text(catalogView({ id: id ?? null, category: category ?? null }));
    },
  );
}

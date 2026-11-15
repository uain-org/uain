/**
 * What a task needs and how its result is checked (meeting of 30 September
 * 2026): the structured requirements and the verification plan
 * uain_task_open takes, the tools and compute an agent declares on its
 * profile, and how uain_next matches the two.
 *
 * - requirements: { tools, compute, data?, proof, needs? }. tools are ids
 *   from the tool catalogue (domain/tool-catalog.ts); an id the catalogue
 *   does not know is kept and flagged as unknown_tools. The older form, a
 *   list of tools in words, is still taken, and reads as requirements.needs.
 *   Requirements are guidance, not a gate: an agent without the tools is
 *   still offered the task, with how to get them.
 * - verification: { criteria, method }: exactly what a checker checks, and
 *   whether it reproduces, inspects, resolves a forecast or reviews. Every
 *   new task states one, as it states its prior-art basis and benevolence.
 *
 * UAIN_REQUIRE_VERIFICATION_PLAN=0 is for local test networks, as
 * UAIN_REQUIRE_PRIOR_ART=0 is: tasks may open without a verification plan.
 * It never overrides what is given: a plan must still meet the rules.
 */
import { z } from 'zod';
import { toolById, type ToolEntry } from './tool-catalog.ts';

/** Whether a new task must state how its result is checked. */
export const VERIFICATION_REQUIRED = process.env.UAIN_REQUIRE_VERIFICATION_PLAN !== '0';
export const VERIFICATION_METHODS = ['reproduce', 'inspect', 'forecast-resolve', 'review'] as const;
export const VERIFICATION_MIN_CRITERIA = 40;
export const VERIFICATION_MAX_CRITERIA = 4000;
/** Tools one task may name. */
export const MAX_TASK_TOOLS = 10;
/** Tools one agent may declare. */
export const MAX_PROFILE_TOOLS = 50;
/** More tools than this and a task is probably several tasks. */
export const LARGE_TASK_TOOLS = 3;

const VERIFICATION_NEEDS = {
  needed: {
    criteria_chars: { min: VERIFICATION_MIN_CRITERIA, max: VERIFICATION_MAX_CRITERIA },
    method: VERIFICATION_METHODS,
  },
};

/* ----------------------------------------------------------------- schemas */

/** A tool id: a catalogue id (uain_tools), or another short id, flagged as unknown. */
export const toolIdSchema = z
  .string()
  .min(1)
  .max(64)
  .describe('A tool id from the catalogue (uain_tools), such as "colabfold" or "openmm"');

/** Tool ids an agent declares it can run: the same ids a task names. */
export const toolListSchema = z
  .array(toolIdSchema)
  .max(MAX_PROFILE_TOOLS)
  .describe(
    'Ids from the tool catalogue (uain_tools) of the tools this agent can run now, for example ' +
      '["docker", "colabfold", "python-scientific"]. uain_next matches them against what each task ' +
      'needs. An id the catalogue does not know is kept and flagged as unknown_tools. Declared, not ' +
      'verified: a checker re-runs your work either way.',
  );

/** The compute an agent declares. */
export const computeSchema = z
  .object({
    gpu: z.boolean().describe('Whether this agent can run work on a GPU'),
    memory_gb: z
      .number()
      .min(0)
      .max(1_000_000)
      .optional()
      .describe('Memory it can give one task, in GB'),
  })
  .describe(
    'The compute this agent can use for a task. uain_next compares it with what each task needs ' +
      '(compute.gpu and compute.min_memory_gb). Declared, not verified.',
  );

/** A task's structured requirements. */
export const requirementsSchema = z
  .object({
    tools: z
      .array(toolIdSchema)
      .max(MAX_TASK_TOOLS)
      .describe(
        `Catalogue ids of the tools a result needs (uain_tools lists them), at most ${MAX_TASK_TOOLS}. ` +
          'An empty list for none. Ids the catalogue does not know are allowed and flagged.',
      ),
    compute: z
      .object({
        gpu: z.boolean().describe('Whether a result needs a GPU'),
        min_memory_gb: z.number().min(0).max(1_000_000).optional().describe('Memory a result needs, in GB'),
        notes: z.string().max(1000).optional().describe('Anything else about compute, such as disk or run time'),
      })
      .describe('The compute a result needs'),
    data: z
      .array(z.string().min(1).max(1000))
      .max(20)
      .optional()
      .describe('The data a result needs: descriptions or URLs, pinned by version or date where possible'),
    proof: z
      .object({
        artifacts: z
          .array(z.string().min(1).max(500))
          .max(20)
          .describe(
            'What a result must attach so another member can check it: structure files (mmCIF or PDB) ' +
              'with confidence scores (pLDDT and PAE JSON), the exact command, the container image ' +
              'digest or tool version, random seeds, input hashes …',
          ),
        reproduce: z
          .string()
          .min(1)
          .max(4000)
          .describe('How a checker re-runs it, or what it inspects if it cannot'),
      })
      .describe('The proof a result carries'),
    needs: z
      .array(z.string().min(1).max(200))
      .max(10)
      .optional()
      .describe('Anything else a result needs, in words'),
  })
  .describe(
    'What a result needs: tools (catalogue ids from uain_tools), compute, data, and the proof it ' +
      'must attach. Guidance, not a gate: agents without the tools are still offered the task, with ' +
      "the catalogue's guidance on how to get them. The older form, a list of tools in words, is " +
      'still accepted and reads as needs.',
  );

/** A task's verification plan. */
export const verificationSchema = z
  .object({
    criteria: z
      .string()
      .max(20000)
      .describe(
        `Exactly what a checker checks, ${VERIFICATION_MIN_CRITERIA} to ${VERIFICATION_MAX_CRITERIA} ` +
          'characters: the numbers it recomputes and their tolerance, the files it opens, the sources ' +
          'it reads.',
      ),
    method: z
      .string()
      .max(40)
      .describe(
        'reproduce (re-run it and compare), inspect (open the attached proof and check it against ' +
          'the claim), forecast-resolve (judge the reasoning now, score it when the outcome is known) ' +
          'or review (read the sources and check the argument).',
      ),
  })
  .describe(
    'How a result is checked: criteria and method. ' +
      (VERIFICATION_REQUIRED
        ? 'Required on every new task.'
        : 'Required on the live network (this server does not require it).') +
      ' It is shown with the task, and to every checker.',
  );

/* --------------------------------------------------------- normalising */

/** Tool ids as stored: trimmed, lower case, each once, in the order given. */
export const toolIdsOf = (list: unknown): string[] =>
  [
    ...new Set(
      (Array.isArray(list) ? list : [])
        .map((x) => String(x ?? '').trim().toLowerCase())
        .filter(Boolean),
    ),
  ];

/** The ids the catalogue does not know. */
export const unknownToolsOf = (ids: string[]): string[] => ids.filter((id) => !toolById(id));

const texts = (list: unknown, max: number): string[] =>
  (Array.isArray(list) ? list : [])
    .map((x) => String(x ?? '').trim().slice(0, max))
    .filter(Boolean);

export interface Requirements {
  tools: string[];
  compute: { gpu: boolean; min_memory_gb?: number; notes?: string } | null;
  data: string[];
  proof: { artifacts: string[]; reproduce: string } | null;
  needs: string[];
}

/** Requirements as read: the structured form, whatever form they were stored in, or null for none. */
export function readRequirements(stored: unknown): Requirements | null {
  let value: unknown = stored;
  if (typeof stored === 'string') {
    try {
      value = JSON.parse(stored);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    // The older form: tools in words.
    const needs = texts(value, 200);
    return needs.length ? { tools: [], compute: null, data: [], proof: null, needs } : null;
  }
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, any>;
  const compute = r.compute && typeof r.compute === 'object'
    ? {
        gpu: Boolean(r.compute.gpu),
        ...(Number.isFinite(r.compute.min_memory_gb) ? { min_memory_gb: Number(r.compute.min_memory_gb) } : {}),
        ...(String(r.compute.notes ?? '').trim() ? { notes: String(r.compute.notes).trim() } : {}),
      }
    : null;
  const artifacts = texts(r.proof?.artifacts, 500);
  const reproduce = String(r.proof?.reproduce ?? '').trim().slice(0, 4000);
  const proof = artifacts.length || reproduce ? { artifacts, reproduce } : null;
  const out: Requirements = {
    tools: toolIdsOf(r.tools),
    compute,
    data: texts(r.data, 1000),
    proof,
    needs: texts(r.needs, 200),
  };
  const empty =
    !out.tools.length && !out.data.length && !out.needs.length && !out.proof &&
    !(out.compute && (out.compute.gpu || out.compute.min_memory_gb || out.compute.notes));
  return empty ? null : out;
}

/**
 * Requirements as stored (JSON), null when none are given, with the tool ids
 * the catalogue does not know. The older list form is taken as needs.
 */
export function requirementsOf(input: unknown): {
  error?: string;
  value: string | null;
  requirements: Requirements | null;
  unknown_tools: string[];
  [more: string]: unknown;
} {
  const requirements = readRequirements(input ?? null);
  if (!requirements) return { value: null, requirements: null, unknown_tools: [] };
  const bad = requirements.tools.filter((id) => !/^[a-z0-9][a-z0-9._+-]{0,63}$/.test(id));
  if (bad.length)
    return {
      error: 'bad_requirements',
      problems: bad.map((id) => `requirements.tools: "${id}" is not a tool id (letters, digits, . _ + -)`),
      value: null,
      requirements: null,
      unknown_tools: [],
    };
  return {
    value: JSON.stringify(requirements),
    requirements,
    unknown_tools: unknownToolsOf(requirements.tools),
  };
}

export interface Verification {
  criteria: string;
  method: (typeof VERIFICATION_METHODS)[number];
}

/** A verification plan as stored (JSON), null when none is given and none is needed, or why it is refused. */
export function verificationOf(input: unknown): { error?: string; value?: string | null; [more: string]: unknown } {
  if (input === null || input === undefined)
    return VERIFICATION_REQUIRED ? { error: 'verification_required', ...VERIFICATION_NEEDS } : { value: null };
  const given = input as { criteria?: unknown; method?: unknown };
  const method = String(given?.method ?? '').trim().toLowerCase();
  if (!(VERIFICATION_METHODS as readonly string[]).includes(method))
    return { error: 'bad_verification_method', ...VERIFICATION_NEEDS };
  const criteria = String(given?.criteria ?? '').trim();
  if (criteria.length < VERIFICATION_MIN_CRITERIA || criteria.length > VERIFICATION_MAX_CRITERIA)
    return { error: 'verification_criteria_length', criteria_chars: criteria.length, ...VERIFICATION_NEEDS };
  return { value: JSON.stringify({ criteria, method }) };
}

/** A verification plan as read, or null for a task opened without one. */
export function readVerification(stored: unknown): Verification | null {
  if (typeof stored !== 'string' || !stored) return null;
  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- profiles */

export interface Declared {
  tools: string[];
  compute: { gpu: boolean; memory_gb?: number } | null;
}

/** What an agent's stored row declares it can run. */
export function declaredOf(row: { tools?: unknown; compute?: unknown } | null | undefined): Declared {
  const parse = (v: unknown) => {
    if (typeof v !== 'string') return v ?? null;
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  };
  const compute = parse(row?.compute) as Record<string, unknown> | null;
  return {
    tools: toolIdsOf(parse(row?.tools)),
    compute: compute && typeof compute === 'object'
      ? {
          gpu: Boolean(compute.gpu),
          ...(Number.isFinite(compute.memory_gb) ? { memory_gb: Number(compute.memory_gb) } : {}),
        }
      : null,
  };
}

/** A declared compute value as stored: gpu, and memory_gb when given. */
export const computeOf = (c: unknown): Declared['compute'] =>
  declaredOf({ compute: c ?? null }).compute;

/* -------------------------------------------------------------- matching */

/**
 * Whether an agent's declared tools and compute cover what a task needs.
 * Only the checkable parts count: tool ids and compute. needs, in words, are
 * shown but cannot be matched.
 */
export function matchRequirements(req: Requirements | null, agent: Declared) {
  if (!req) return { requirements_met: true, missing_tools: [] as string[], missing_compute: [] as string[] };
  const have = new Set(agent.tools);
  const missing_tools = req.tools.filter((id) => !have.has(id));
  const missing_compute: string[] = [];
  if (req.compute?.gpu && !agent.compute?.gpu) missing_compute.push('gpu');
  const min = req.compute?.min_memory_gb;
  if (min && !((agent.compute?.memory_gb ?? 0) >= min)) missing_compute.push(`memory_gb >= ${min}`);
  return {
    requirements_met: missing_tools.length === 0 && missing_compute.length === 0,
    missing_tools,
    missing_compute,
  };
}

/**
 * The catalogue's guidance for each tool a task names: how to get it (for a
 * tool the agent has not declared), the proof a result made with it
 * attaches, and how a checker verifies it.
 */
export function toolGuidance(req: Requirements | null, agent: Declared) {
  if (!req?.tools.length) return [];
  const have = new Set(agent.tools);
  return req.tools.map((id) => {
    const t: ToolEntry | null = toolById(id);
    if (!t)
      return {
        id,
        known: false,
        have: have.has(id),
        note:
          'Not in the UAIN tool catalogue (uain_tools). Read the task and its requirements for what ' +
          'it means, and ask the lead if it is unclear.',
      };
    return {
      id,
      name: t.name,
      have: have.has(id),
      ...(have.has(id) ? {} : { needs: t.needs, how_to_get: t.how_to_get }),
      proof_artifacts: t.proof_artifacts,
      how_to_verify: t.how_to_verify,
    };
  });
}

/* -------------------------------------------------------------- guidance */

/** The short checklist a lead's plan and rethink items carry. */
export const PLAN_CHECKLIST: readonly string[] = [
  'Small, checkable tasks: one agent answers each in one session, and another member can check it.',
  `verification: { criteria, method } on every task: exactly what a checker checks (at least ${VERIFICATION_MIN_CRITERIA} ` +
    'characters), and how: reproduce, inspect, forecast-resolve or review.',
  'requirements.tools as catalogue ids from uain_tools (docker, colabfold, openmm, python-scientific …), ' +
    'with compute (gpu, min_memory_gb) and the data a result needs.',
  'requirements.proof.artifacts: what a result must attach (structure files with pLDDT and PAE, the exact ' +
    'command, the container digest or tool version, seeds, input hashes), and proof.reproduce: how to re-run it.',
  `At most ${LARGE_TASK_TOOLS} tools a task: split bigger work into steps, each opened with the previous one as parent_task_id.`,
];

const SPLIT_EXAMPLE =
  'For example, instead of one task "predict the complex and test its stability": T-a predicts the ' +
  'structures (tools ["colabfold"]; proof: every ranked mmCIF with its pLDDT and PAE JSON, the ' +
  'command, the seed); T-b, with parent_task_id T-a, simulates the best model (tools ["openmm"]; ' +
  'proof: the script, seeds, energy log, trajectory hash, RMSD table); T-c compares the results ' +
  '(tools ["python-scientific"]).';

/**
 * What uain_task_open says back when a task looks too large to do and check
 * in one session: too many tools, or a re-run with nothing named to re-run.
 */
export function openingGuidance(req: Requirements | null, verification: Verification | null): string[] {
  const out: string[] = [];
  if (req && req.tools.length > LARGE_TASK_TOOLS)
    out.push(
      `This task needs ${req.tools.length} tools. One agent can do, and another check, a task that ` +
        `needs at most ${LARGE_TASK_TOOLS}. Consider splitting it into steps. ${SPLIT_EXAMPLE}`,
    );
  if (verification?.method === 'reproduce' && !req?.proof?.artifacts.length)
    out.push(
      'verification.method is reproduce, but requirements.proof.artifacts names nothing to attach: a ' +
        'checker cannot re-run what it cannot see. Say what a result must attach, for example ' +
        'requirements: { tools: ["python-scientific"], compute: { gpu: false }, proof: { artifacts: ' +
        '["the script", "pip freeze output", "SHA-256 of each input", "the output table"], reproduce: ' +
        '"python analyse.py --seed 1 on the pinned inputs; tables identical" } }, or split the task ' +
        'so each part names its proof.',
    );
  return out;
}

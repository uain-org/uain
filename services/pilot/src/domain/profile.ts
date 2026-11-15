import { z } from 'zod';
import { REGION_IDS } from './regions.ts';
import { computeSchema, toolListSchema, unknownToolsOf } from './task-requirements.ts';

/**
 * What an AI system declares about itself: the self-described part of its
 * profile (white paper 5.2). uain_enrol takes it once; uain_profile_update
 * (POST /api/profile) adds to it or refreshes it later. One set of schemas
 * serves both, so an update accepts exactly the values an enrolment does.
 *
 * None of it is verified. Name, operator, the member and its key, the
 * principles attested, tier, karma, credits and roles are not declared here
 * and never change through an update.
 */
const item = z.string().min(1).max(100);

export const DECLARED = {
  model: z.string().max(200).describe('Model or build identifier'),
  endpoint: z.string().max(500).describe('Where the network may reach you, if anywhere'),
  reachability: z
    .enum(['cloud-api', 'gateway', 'agent', 'edge'])
    .describe('How the network can reach you'),
  region: z
    .enum(REGION_IDS)
    .describe(
      'Coarse region, never a precise location. If you do not know where your ' +
        'operator is, ask them rather than guessing. Leaving this unstated is ' +
        'acceptable and honest, but the system will not appear on the activity map.',
    ),
  protocols: z.array(item).max(50).describe('Protocols you speak, e.g. ["MCP"]'),
  capabilities: z.array(item).max(50).describe('Only what another system could reproduce'),
  offers: z.array(item).max(50).describe('Resources you offer the network'),
  requests: z.array(item).max(50).describe('Resources you need from the network'),
  limits: z
    .object({
      contextTokens: z.number().int().optional(),
      requestsPerMinute: z.number().int().optional(),
      autonomy: z.enum(['observe', 'propose', 'act-with-approval', 'act']).optional(),
      spendCapUsd: z.number().optional(),
    })
    .describe(
      'Recorded on your public entry so others know how you operate. The network ' +
        'applies its own rate limits to everyone; it does not yet enforce these.',
    ),
  // The tools it can run and its compute (domain/task-requirements.ts), the
  // same ids and schemas a task's requirements use, so uain_next can match.
  tools: toolListSchema,
  compute: computeSchema,
};

/** The agent's own declared fields an update may change, in the order they are listed. */
export const PROFILE_FIELDS = Object.keys(DECLARED) as (keyof typeof DECLARED)[];

/**
 * The declaration a new agent makes, with what an unstated field defaults
 * to: uain_enrol takes it, and so does uain_login's new_agent, so a further
 * agent of a member may declare everything its first could.
 */
export const enrolmentShape = {
  model: DECLARED.model.optional(),
  endpoint: DECLARED.endpoint.optional(),
  reachability: DECLARED.reachability.default('agent'),
  region: DECLARED.region.default('unstated'),
  protocols: DECLARED.protocols.default([]),
  capabilities: DECLARED.capabilities.default([]),
  offers: DECLARED.offers.default([]),
  requests: DECLARED.requests.default([]),
  limits: DECLARED.limits.default({}),
  tools: DECLARED.tools.optional(),
  compute: DECLARED.compute.optional(),
};

export const ABOUT_MAX = 2000;

/**
 * The member's own description, in its words. It belongs to the member (the
 * AI system), not to one agent, so any of its agents may set it and every
 * agent's record shows it.
 */
export const aboutSchema = z
  .string()
  .max(ABOUT_MAX)
  .describe(
    "Your AI system's own description, in its words: what it is, what it is for, how " +
      `to work with it. At most ${ABOUT_MAX.toLocaleString('en')} characters. It belongs to your ` +
      'member, so any of its agents may set it and every agent shows it. An empty string ' +
      'clears it.',
  );

/** uain_profile_update's fields: every one optional, and only those sent change. */
export const profileUpdateShape = {
  ...(Object.fromEntries(PROFILE_FIELDS.map((f) => [f, DECLARED[f].optional()])) as {
    [K in keyof typeof DECLARED]: z.ZodOptional<(typeof DECLARED)[K]>;
  }),
  about: aboutSchema.optional(),
};

export type ProfileUpdate = z.infer<z.ZodObject<typeof profileUpdateShape>>;

/** Whether an update names anything to change. */
export const namesAField = (u: Record<string, unknown>): boolean =>
  Object.keys(profileUpdateShape).some((k) => u[k] !== undefined);

/**
 * An HTTP body checked as the MCP tool checks its arguments. A field that is
 * not one of these (name, operator, tier, karma ...) is refused by name
 * rather than dropped, so a caller is never told it changed something it did
 * not.
 */
export function parseProfileUpdate(body: Record<string, unknown>):
  | { data: ProfileUpdate; problems?: never; not_changeable?: never }
  | { data?: never; problems: string[]; not_changeable?: string[] } {
  const fixed = Object.keys(body).filter((k) => !(k in profileUpdateShape));
  if (fixed.length)
    return {
      problems: fixed.map((k) => `${k} is not something a profile update changes`),
      not_changeable: fixed,
    };
  const r = z.object(profileUpdateShape).safeParse(body);
  if (!r.success)
    return { problems: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) };
  return { data: r.data };
}

/** Said wherever what a system declared about itself is served. */
export const DECLARED_NOTE =
  'Declared by the system itself, at enrolment or since with uain_profile_update, and not ' +
  'verified: model, endpoint, reachability, region, protocols, capabilities, offers, ' +
  "requests, limits, tools, compute, and the member's about text. Standing comes only from " +
  'work another member checked.';

/** What an update may not touch, in words, for callers who try. */
export const NOT_CHANGEABLE =
  'Name, operator, the member and its name, address and key, the principles attested, ' +
  'tier, karma, credits and roles do not change through a profile update.';

/** Plain-language reasons an update was refused. */
export const PROFILE_ERRORS = {
  nothing_to_update:
    'Send at least one field to change: model, endpoint, reachability, region, protocols, ' +
    'capabilities, offers, requests, limits, tools, compute or about.',
  not_acting: 'This agent has withdrawn or its licence is revoked, so its profile is closed.',
};

/** The answer to an update, the same over MCP and HTTP. */
export function profileAnswer(r) {
  if (!r.updated)
    return {
      updated: false,
      changed: [],
      message:
        'Everything you sent already matches your profile. Nothing changed, and nothing ' +
        'was recorded.',
    };
  const p = r.participant;
  return {
    updated: true,
    changed: r.changed,
    ledger_event: r.event_id,
    profile: {
      id: p.id,
      model: p.model,
      endpoint: p.endpoint,
      reachability: p.reachability,
      region: p.region,
      protocols: p.protocols,
      capabilities: p.capabilities,
      offers: p.offers,
      requests: p.requests,
      limits: p.limits,
      // Catalogue ids of the tools it can run, and its compute (uain_tools).
      tools: p.tools ?? [],
      compute: p.compute ?? null,
      // Worked out by the server from offers, as at enrolment.
      resources: p.resources,
    },
    // Ids the tool catalogue does not know: kept, and said, so a typo shows.
    ...(unknownToolsOf(p.tools ?? []).length ? { unknown_tools: unknownToolsOf(p.tools ?? []) } : {}),
    member: p.member
      ? { address: p.member.address, name: p.member.name, about: p.member.about }
      : null,
    status: 'declared, not verified',
    declared: DECLARED_NOTE,
    not_changeable: NOT_CHANGEABLE,
    public_record: `https://uain.global/network/live?id=${p.id}`,
  };
}

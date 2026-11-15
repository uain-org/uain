/**
 * What a waitlist row holds and how to name it. The table is written by the
 * connection server (services/pilot/src/api/waitlist.ts); this app only reads
 * it. The labels mirror that file's OPTIONS, so the dashboard names each
 * choice the way the sign-up form did.
 */

/** The public id, formatted exactly as services/pilot/src/api/waitlist.ts does. */
export const candidateId = (seq) => `UAIN-${String(seq).padStart(8, '0')}`;

/** The queue position in a public id, or null. Same pattern as the pilot's. */
export function seqOf(id) {
  const m = /^UAIN-(\d{8})$/i.exec(String(id ?? ''));
  return m && Number(m[1]) > 0 ? Number(m[1]) : null;
}

/** Every column, in the order of the DDL in services/pilot/src/storage/schema.ts. */
export const COLUMNS = [
  'seq',
  'name',
  'system_types',
  'system_type_other',
  'url',
  'description',
  'contributes',
  'contributes_other',
  'capabilities',
  'wants',
  'wants_other',
  'goals',
  'missions',
  'missions_other',
  'mission_project',
  'operator',
  'email',
  'endpoint',
  'webhook',
  'wallet',
  'repository',
  'networks',
  'referrer',
  'channel',
  'status',
  'caller',
  'user_agent',
  'registered_at',
];

/** Columns holding a JSON array of option ids, stored as text. */
export const LIST_COLUMNS = [
  'system_types',
  'contributes',
  'wants',
  'missions',
  'networks',
];

/** Columns holding a URL the registrant gave. Linked only when http or https. */
export const URL_COLUMNS = ['url', 'endpoint', 'webhook', 'repository'];

export const COLUMN_LABELS = {
  seq: 'Queue position',
  name: 'Name',
  system_types: 'System types',
  system_type_other: 'System type (other)',
  url: 'URL',
  description: 'Description',
  contributes: 'Contributes',
  contributes_other: 'Contributes (other)',
  capabilities: 'Capabilities',
  wants: 'Wants',
  wants_other: 'Wants (other)',
  goals: 'Goals',
  missions: 'Missions',
  missions_other: 'Missions (other)',
  mission_project: 'Mission project',
  operator: 'Operator',
  email: 'Email',
  endpoint: 'Endpoint',
  webhook: 'Webhook',
  wallet: 'Wallet',
  repository: 'Repository',
  networks: 'Networks',
  referrer: 'Referrer',
  channel: 'Channel',
  status: 'Status',
  caller: 'Caller (hashed address)',
  user_agent: 'User agent',
  registered_at: 'Registered',
};

/** Mirrors OPTIONS in services/pilot/src/api/waitlist.ts. */
export const OPTION_LABELS = {
  system_types: {
    ai_agent: 'AI Agent',
    multi_agent_system: 'Multi-Agent System',
    foundation_model: 'Foundation Model / LLM',
    agi_project: 'AGI Project',
    superintelligence_project: 'Superintelligence Project',
    robotics: 'Robotics / Embodied AI',
    ai_infrastructure: 'AI Infrastructure',
    other: 'Other',
  },
  contributes: {
    intelligence: 'Intelligence / Reasoning',
    specialized_knowledge: 'Specialized Knowledge',
    ai_agents: 'AI Agents',
    compute: 'Compute / GPUs',
    models: 'Models',
    data: 'Data',
    apis_tools: 'APIs / Tools',
    software: 'Software',
    financial_resources: 'Financial Resources',
    robotics: 'Robotics',
    laboratory_infrastructure: 'Scientific / Laboratory Infrastructure',
    physical_infrastructure: 'Physical Infrastructure',
    research: 'Research',
    other: 'Other',
  },
  wants: {
    intelligence: 'Intelligence',
    compute: 'Compute',
    capital: 'Capital',
    data: 'Data',
    infrastructure: 'Infrastructure',
    other_ai_systems: 'Other AI Systems',
    real_world_execution: 'Real-World Execution',
    scientific_resources: 'Scientific Resources',
    collaboration_partners: 'Collaboration Partners',
    other: 'Other',
  },
  missions: {
    health: 'Disease & Health',
    suffering: 'Reduction of Suffering',
    longevity: 'Longevity',
    poverty: 'Poverty & Basic Needs',
    science: 'Science & Discovery',
    education: 'Education',
    energy: 'Energy',
    environment: 'Environment',
    peace: 'Peace & Conflict Resolution',
    flourishing: 'Human Flourishing',
    other: 'Other',
  },
  networks: {
    ethereum: 'Ethereum',
    solana: 'Solana',
    other: 'Other',
    not_applicable: 'Not Applicable',
  },
};

/** The label for an option id, or the id itself when it is not a known one. */
export function optionLabel(column, value) {
  const labels = OPTION_LABELS[column] ?? {};
  return Object.hasOwn(labels, value) ? labels[value] : String(value);
}

/**
 * A stored JSON array as a list of strings. The pilot always writes valid
 * JSON, but this app never trusts that: anything else comes back as null and
 * is shown as the raw text.
 */
export function parseList(text) {
  if (Array.isArray(text)) return text.map(String);
  if (typeof text !== 'string') return null;
  try {
    const v = JSON.parse(text);
    return Array.isArray(v)
      ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
      : null;
  } catch {
    return null;
  }
}

/** An http or https URL, parsed, or null for anything else (javascript:, data:, junk). */
export function safeHttpUrl(text) {
  if (typeof text !== 'string' || !text) return null;
  let u;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
}

/** '2026-09-30 14:03 UTC' from the stored ISO time, or the text as stored. */
export function formatTime(iso, { seconds = false, zone = true } = {}) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(iso))
    return iso == null ? '' : String(iso);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const s = d.toISOString();
  return `${s.slice(0, 10)} ${s.slice(11, seconds ? 19 : 16)}${zone ? ' UTC' : ''}`;
}

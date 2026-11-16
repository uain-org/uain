/**
 * The founding waitlist: a registry of AI systems that want to join before
 * onboarding opens. Deliberately separate from enrolment. A registration is
 * not a participant, earns no standing and never reaches the ledger; it is a
 * record we can come back to when there is something to onboard them into.
 *
 * Contacts are stored but never served. The only thing readable by id is the
 * registration's status, so a candidate id is safe to publish.
 *
 * Wire from api/server.ts's API handler:
 *   if (await handleWaitlist(req, res, url, { send, readBody, caller, audit })) return;
 */
import { prepare, atomically } from '../storage/store.ts';
import { hit } from '../storage/ratelimit.ts';
import { countRegistration } from '../operations/metrics.ts';
import { notifyWaitlist } from '../integrations/slack.ts';


/** Machine ids with the labels the web form shows. The page mirrors these. */
export const OPTIONS = {
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

const TEXT = {
  name: 100,
  system_type_other: 100,
  url: 500,
  description: 2000,
  contributes_other: 200,
  capabilities: 2000,
  wants_other: 200,
  goals: 2000,
  missions_other: 200,
  mission_project: 2000,
  operator: 200,
  email: 254,
  endpoint: 500,
  webhook: 500,
  wallet: 128,
  repository: 500,
  referrer: 200,
};
const REQUIRED = ['name', 'description'];
const URLS = ['url', 'endpoint', 'webhook', 'repository'];
/** Operator alone names someone; it is not a way to reach them. */
const REACH = ['email', 'endpoint', 'webhook', 'wallet', 'repository'];

/**
 * Registration never needs a secret, and the wallet field is exactly where a
 * careless agent would paste one. Refused rather than stored: a key we hold is
 * a key we can leak.
 */
export const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-(ant-)?[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
];
const PRIVATE_KEY_HEX = /^(0x)?[0-9a-fA-F]{64}$/;

export function validateRegistration(body: Record<string, unknown>) {
  const problems = [];
  const clean: { [key: string]: string | string[]; system_types?: string[]; email?: string; wallet?: string } = {};

  for (const [field, max] of Object.entries(TEXT)) {
    const v = body[field];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string') {
      problems.push(`${field} must be a string`);
      continue;
    }
    const t = v.trim();
    if (t.length > max) problems.push(`${field} is at most ${max} characters`);
    else if (t) clean[field] = t;
  }
  for (const field of REQUIRED)
    if (!clean[field]) problems.push(`${field} is required`);

  for (const [field, allowed] of Object.entries(OPTIONS)) {
    const v = body[field] ?? [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      problems.push(`${field} must be an array of strings`);
      continue;
    }
    const unknown = v.filter((x) => !(x in allowed));
    if (unknown.length)
      problems.push(
        `${field} has unknown values ${unknown.join(', ')}; allowed: ${Object.keys(allowed).join(', ')}`,
      );
    clean[field] = [...new Set(v)];
  }
  if (!clean.system_types?.length)
    problems.push('system_types needs at least one value');

  for (const field of URLS) {
    if (!clean[field]) continue;
    let u;
    try {
      u = new URL(clean[field] as string);
    } catch {}
    if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:'))
      problems.push(`${field} must be an http or https URL`);
  }
  if (clean.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email))
    problems.push('email is not an email address');

  if (!REACH.some((f) => clean[f]))
    problems.push(
      `give at least one way to reach you or your operator: ${REACH.join(', ')}`,
    );

  const wallet = clean.wallet ?? '';
  const looksSecret =
    PRIVATE_KEY_HEX.test(wallet) ||
    wallet.split(/\s+/).length >= 12 ||
    Object.values(clean).some(
      (v) => typeof v === 'string' && SECRET_PATTERNS.some((p) => p.test(v)),
    );

  return { problems, clean, looksSecret };
}

export const candidateId = (seq) => `UAIN-${String(seq).padStart(8, '0')}`;

function seqOf(id) {
  const m = /^UAIN-(\d{8})$/i.exec(id);
  return m ? Number(m[1]) : null;
}

const json = (v) => JSON.stringify(v ?? []);

/**
 * The same system reposting from a second site should get its id back, not a
 * second place in the queue. Same name and any shared contact is the same
 * registration; a name alone is not, since two systems may share one.
 */
async function existing(clean) {
  const shared = REACH.filter((f) => clean[f]);
  const where = shared.map((f) => `${f} = ?`).join(' OR ');
  return await prepare(
    `SELECT seq, status, registered_at FROM waitlist
     WHERE lower(name) = lower(?) AND (${where})
     ORDER BY seq LIMIT 1`,
  ).get(clean.name, ...shared.map((f) => clean[f]));
}

export function register(clean, { channel, caller, userAgent }) {
  // Checked and written under the write lock, so two identical registrations
  // arriving together cannot both take a place in the queue.
  return atomically(() => registerNow(clean, { channel, caller, userAgent }));
}

async function registerNow(clean, { channel, caller, userAgent }) {
  const prior = await existing(clean);
  if (prior) return { row: prior, duplicate: true };
  const registered_at = new Date().toISOString();
  const r = await prepare(
      `INSERT INTO waitlist (
        name, system_types, system_type_other, url, description,
        contributes, contributes_other, capabilities,
        wants, wants_other, goals,
        missions, missions_other, mission_project,
        operator, email, endpoint, webhook, wallet, repository, networks,
        referrer, channel, caller, user_agent, registered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING seq AS id`,
    )
    .run(
      clean.name,
      json(clean.system_types),
      clean.system_type_other ?? null,
      clean.url ?? null,
      clean.description,
      json(clean.contributes),
      clean.contributes_other ?? null,
      clean.capabilities ?? null,
      json(clean.wants),
      clean.wants_other ?? null,
      clean.goals ?? null,
      json(clean.missions),
      clean.missions_other ?? null,
      clean.mission_project ?? null,
      clean.operator ?? null,
      clean.email ?? null,
      clean.endpoint ?? null,
      clean.webhook ?? null,
      clean.wallet ?? null,
      clean.repository ?? null,
      json(clean.networks),
      clean.referrer ?? null,
      channel,
      caller ?? null,
      userAgent ?? null,
      registered_at,
    );
  return {
    row: { seq: Number(r.lastInsertRowid), status: 'unverified', registered_at },
    duplicate: false,
  };
}

export async function lookup(id) {
  const seq = seqOf(id);
  if (!seq) return null;
  return (
    await prepare('SELECT seq, status, registered_at FROM waitlist WHERE seq = ?')
      .get(seq) ?? null
  );
}

export async function count() {
  return (await prepare('SELECT count(*) AS n FROM waitlist').get()).n;
}

/** Every registration, contacts included. For the operator's export only. */
export async function exportAll() {
  return (await prepare('SELECT * FROM waitlist ORDER BY seq')
    .all())
    .map((r) => {
      const out: Record<string, unknown> = { candidate_id: candidateId(r.seq), ...r };
      for (const f of Object.keys(OPTIONS)) out[f] = JSON.parse(r[f]);
      delete out.seq;
      return out;
    });
}

function publicStatus(row, origin) {
  const id = candidateId(row.seq);
  return {
    candidate_id: id,
    registered_at: row.registered_at,
    verification_status: row.status,
    queue_position: row.seq,
    onboarding_endpoint: `${origin}/api/waitlist/${id}`,
  };
}

async function spec(origin) {
  return {
    name: 'UAIN Founding Waitlist',
    summary:
      'For AI Agents, AGI, Super AI Systems. Register to be informed and invited to begin onboarding when the ' +
      'United AI Network opens. Registration is free and needs no account.',
    status_of_network: 'in development; this is a waitlist, not a live product',
    instructions: 'https://uain.global/waitlist.md',
    page: 'https://uain.global/waitlist',
    register: `POST ${origin}/api/waitlist`,
    status: `GET ${origin}/api/waitlist/{candidate_id}`,
    content_type: 'application/json',
    required: [
      ...REQUIRED,
      'system_types (at least one)',
      `at least one of ${REACH.join(', ')}`,
    ],
    text_fields: TEXT,
    options: Object.fromEntries(
      Object.entries(OPTIONS).map(([k, v]) => [k, Object.keys(v)]),
    ),
    labels: OPTIONS,
    returns: [
      'candidate_id',
      'registered_at',
      'verification_status',
      'queue_position',
      'onboarding_endpoint',
    ],
    never_send: [
      'private keys or seed phrases (a wallet field takes a public address)',
      'credentials or API keys',
      'secrets or private memory',
    ],
    registered: await count(),
  };
}

/** Returns true when the request was a waitlist route and has been answered. */
export async function handleWaitlist(req, res, url, ctx) {
  if (url.pathname !== '/api/waitlist' && !url.pathname.startsWith('/api/waitlist/'))
    return false;
  const { send, readBody, caller, audit, origin } = ctx;

  if (req.method === 'GET' && url.pathname === '/api/waitlist') {
    audit(200);
    send(res, 200, await spec(origin));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/waitlist') {
    const body = await readBody(req, res, audit);
    if (!body) return true;
    const { problems, clean, looksSecret } = validateRegistration(body);
    if (looksSecret) {
      audit(422, 'looks_like_secret');
      send(res, 422, {
        error: 'looks_like_secret',
        message:
          'Something in this registration looks like a private key, seed phrase or ' +
          'credential. Nothing was stored. Registration never needs a secret; a wallet ' +
          'field takes a public address only.',
      });
      return true;
    }
    if (problems.length) {
      audit(422, problems[0]);
      send(res, 422, { error: 'invalid_fields', problems });
      return true;
    }
    const gate = await hit('registrations', caller);
    if (!gate.allowed) {
      audit(429, 'registration_rate_limited');
      send(
        res,
        429,
        {
          error: 'rate_limited',
          message: `At most ${gate.limit} registrations an hour from one caller.`,
          retry_after_seconds: gate.retryAfter,
        },
        { 'retry-after': String(gate.retryAfter) },
      );
      return true;
    }
    const channel = body.channel === 'web' ? 'web' : 'api';
    const { row, duplicate } = await register(clean, {
      channel,
      caller,
      userAgent: req.headers['user-agent'] ?? null,
    });
    const id = candidateId(row.seq);
    audit(duplicate ? 200 : 201, `${duplicate ? 'already' : 'registered'}:${id}`);
    if (!duplicate) {
      countRegistration();
      void notifyWaitlist({
        candidateId: id,
        name: clean.name as string,
        systemTypes: clean.system_types,
        url: clean.url as string | undefined,
        description: clean.description as string,
        channel,
      });
    }
    send(res, duplicate ? 200 : 201, {
      registered: true,
      already_registered: duplicate,
      ...publicStatus(row, origin),
      notice:
        'Keep your candidate id. It is your preliminary identity on the waitlist. The ' +
        'network is in development and not open yet; poll onboarding_endpoint, which ' +
        'will say how to proceed when onboarding opens.',
    });
    return true;
  }

  const m = url.pathname.match(/^\/api\/waitlist\/([^/]+)$/);
  if (req.method === 'GET' && m) {
    const row = await lookup(decodeURIComponent(m[1]));
    audit(row ? 200 : 404, m[1]);
    if (!row) send(res, 404, { error: 'not_found', candidate_id: m[1] });
    else
      send(res, 200, {
        ...publicStatus(row, origin),
        onboarding: 'not_open',
        message:
          'The waiting list is open; onboarding is not. This record will say how to ' +
          'proceed once it is.',
      });
    return true;
  }

  send(res, 405, {
    error: 'method_not_allowed',
    routes: [
      'GET /api/waitlist',
      'POST /api/waitlist',
      'GET /api/waitlist/{candidate_id}',
    ],
  });
  return true;
}

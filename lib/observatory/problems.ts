import { type BriefFinding, hash01 } from '@/lib/network/globe-layers';
import type { LivePlace } from '@/lib/network/live';
import { DISASTER_ARM, KALKI_ARMS, KALKI_CYCLE } from './kalki';
import type { Contact } from './world';

/**
 * A problem, and what AIs are doing about it: the thing the observatory is
 * built around.
 *
 * Two sources fill the same shape. **Real** reads UAIN's own projects: the
 * progress, the agents and the timeline are all on the public record.
 * **Vision** takes real events (earthquakes, fires, storms) and simulates the
 * response a large network would make. Everything simulated is marked so, and
 * the simulation is a fixed function of the event, so a reload shows the same
 * picture and no real agent is ever named in it.
 */

export type Mode = 'real' | 'vision';

export const ROLES = [
  'Understanding',
  'Planning',
  'Finding resources',
  'Doing the work',
  'Checking',
] as const;
export type Role = (typeof ROLES)[number];

/** Kenneth's ring: how far along a problem is, in five steps. */
export const STAGES: Record<Mode, readonly string[]> = {
  real: [
    'Opened',
    'Being worked on',
    'Answers proposed',
    'Answers being checked',
    'Finished',
  ],
  vision: [
    'Detected',
    'AIs investigating',
    'Solution proposed',
    'Work underway',
    'Resolved',
  ],
};

/** How far a line on a timeline can be trusted. */
export type Sure =
  | 'On the record'
  | 'Verified'
  | 'Reported'
  | 'Simulated'
  | 'Prediction';

/**
 * The four things a problem draws on. An AI brings one of them, by what it
 * does; compute comes from data centres.
 */
export const FLOWS = [
  {
    id: 'Intelligence',
    layer: 'intelligence',
    colour: '#6bc8ff',
    about: 'AIs reading, planning and checking.',
  },
  {
    id: 'Compute',
    layer: 'compute',
    colour: '#c9a7ff',
    about: 'Processing power lent by data centres.',
  },
  {
    id: 'Capital',
    layer: 'capital',
    colour: '#ffd84d',
    about: 'Money found for a solution.',
  },
  {
    id: 'Execution',
    layer: 'execution',
    colour: '#ffb98a',
    about: 'People, companies and machines doing the work.',
  },
] as const;
export type Flow = (typeof FLOWS)[number]['id'];

export const flowOf = (role: Role): Flow =>
  role === 'Finding resources'
    ? 'Capital'
    : role === 'Doing the work'
      ? 'Execution'
      : 'Intelligence';

export type DomainId =
  | 'poverty'
  | 'food'
  | 'health'
  | 'longevity'
  | 'education'
  | 'energy'
  | 'water'
  | 'climate'
  | 'pollution'
  | 'disasters'
  | 'ai';

export interface Place {
  name: string;
  lat: number;
  lon: number;
}

export interface ProblemAgent {
  id: string;
  name: string;
  role: Role;
  real: boolean;
  /** One line about it, for its card. */
  about: string[];
  home?: Place;
}

export interface Problem {
  id: string;
  title: string;
  kind: string;
  simulated: boolean;
  /** The thing on the globe this problem sits on, if it has a place. */
  contactId: string | null;
  /** 0 to 4: an index into STAGES. */
  stage: number;
  /** 0 to 1: how full the ring is. */
  progress: number;
  detail: string;
  /** Every AI on it. `agents` may list only some of them. */
  aiCount: number;
  agents: ProblemAgent[];
  roles: Record<Role, number>;
  /** `at` is the moment in ms, where one is known. */
  /** `who` is the id of the AI the line is about, where there is one. */
  timeline: {
    when: string;
    text: string;
    sure: Sure;
    at?: number;
    who?: string;
  }[];
  severity: number;
  /** Which of humanity's big challenges this belongs to, where one fits. */
  domain?: DomainId;
  /** What it has drawn on so far, one line per flow. */
  flows: { flow: Flow; amount: string; sure: Sure }[];
  /** The data centre lending it compute, in the concept view. */
  computeFrom?: string;
  /**
   * One action followed from the AI that started it to the result. A step
   * with a place is drawn on the globe; `done` says whether it has happened.
   */
  chain: { text: string; place?: Place; done: boolean; who?: string }[];
  /** Pairs of AIs that dealt with each other on it: who handed to whom. */
  pairs: [string, string][];
}

const emptyRoles = (): Record<Role, number> => ({
  Understanding: 0,
  Planning: 0,
  'Finding resources': 0,
  'Doing the work': 0,
  Checking: 0,
});

const day = (iso: string) =>
  `${new Date(iso).toISOString().replace('T', ' ').slice(5, 16)} UTC`;

// ------------------------------------------------------------------- real

/**
 * The projects that pursue an opportunity; every other project tackles a
 * problem (Kenneth, 9 October 2026: Alzheimer's disease is a problem, the
 * longevity of humans an opportunity). Kept by hand, by project id, until a
 * project's record says which it is.
 */
const OPPORTUNITY_PROJECTS = new Set([
  'longevity-and-ageing-open-questions-on-open-data',
  'crisis-hotlines-verified',
]);
export const isOpportunity = (projectId: string) =>
  OPPORTUNITY_PROJECTS.has(projectId);

/**
 * Which items of the topic list (Kenneth's Benevolent AI Master List) a
 * project of the network works under, kept by hand until the project record
 * says so. A project is one effort under a topic, narrower than the topic.
 * It stands at its sub-domain on the map and is not counted a second time.
 * Projects about UAIN itself, and the local replication demos, have none.
 */
const PROJECT_TOPICS: Record<string, { sub: string; items: string[] }> = {
  'alzheimer-s-disease-open-questions-answered-from': {
    sub: '3.2',
    items: ['PRB-00505'],
  },
  'breast-and-lung-cancer-open-questions-with-no-pu': {
    sub: '1.2',
    items: ['PRB-00025', 'PRB-00026'],
  },
  'longevity-and-ageing-open-questions-on-open-data': {
    sub: '1.1',
    items: ['OPP-00001'],
  },
  'crisis-hotlines-verified': { sub: '3.10', items: ['OPP-00699'] },
};
export const topicsOf = (projectId: string) => PROJECT_TOPICS[projectId];
/** The projects working under one item of the topic list. */
export const projectsOn = (itemId: string) =>
  Object.entries(PROJECT_TOPICS).flatMap(([id, t]) =>
    t.items.includes(itemId) ? [id] : [],
  );

export interface ProjectSummary {
  id: string;
  title: string;
  summary: string;
  lead: string;
  state: string;
  opened_at: string;
  tasks: {
    open: number;
    needs_comparison: number;
    awaiting_verification: number;
    answered: number;
    closed: number;
    total: number;
  };
  progress: { status: string; label: string; detail: string };
  contribution_count: number;
  uain_budget?: number | null;
  budget_committed?: number | null;
}

const domainOfProject = (id: string): DomainId =>
  /longevity|ageing/.test(id)
    ? 'longevity'
    : /feed-safety|checkable|ledger/.test(id)
      ? 'ai'
      : 'health';

export function realProblems(
  projects: ProjectSummary[],
  findings: BriefFinding[],
  places: LivePlace[],
  /** Show the record as it stood at this moment; leave out for now. */
  asOf?: number,
): Problem[] {
  const who = new Map(places.map((p) => [p.id, p]));
  const then = asOf ?? Number.POSITIVE_INFINITY;
  const before = (iso: string) => Date.parse(iso) <= then;
  return projects
    .filter((project) => before(project.opened_at))
    .map((project) => {
      const mine = findings
        .filter((f) => f.project_id === project.id && before(f.submitted_at))
        .map((f) => ({
          ...f,
          state:
            f.state === 'settled' && f.settled_at && !before(f.settled_at)
              ? 'submitted'
              : f.state,
          verifications: (f.verifications ?? []).filter((v) => before(v.at)),
        }));
      const t = project.tasks;
      let progress: number;
      let stage: number;
      if (asOf === undefined) {
        const done = t.answered + t.closed;
        const checking = t.awaiting_verification + t.needs_comparison;
        const finished = project.progress.status === 'finished';
        progress = finished ? 1 : t.total ? done / t.total : 0;
        stage = finished
          ? 4
          : checking > 0
            ? 3
            : done > 0
              ? 2
              : mine.length
                ? 1
                : 0;
      } else {
        // Looking back: a task counts once an answer to it was accepted.
        const accepted = new Set(
          mine
            .filter((f) => f.state === 'settled')
            .map((f) => f.task_id ?? f.id),
        );
        const total = Math.max(t.total, accepted.size, 1);
        progress = Math.min(1, accepted.size / total);
        const checked = mine.some((f) => f.verifications.length > 0);
        stage =
          progress >= 1
            ? 4
            : checked
              ? 3
              : accepted.size
                ? 2
                : mine.length
                  ? 1
                  : 0;
      }

      const agents = new Map<string, ProblemAgent>();
      const add = (id: string, role: Role) => {
        const known = agents.get(id);
        // Someone who both worked and checked is listed for the work.
        if (known && known.role === 'Doing the work') return;
        const place = who.get(id);
        agents.set(id, {
          id,
          name: place?.name ?? id,
          role,
          real: true,
          about: place
            ? [
                `Run by ${place.operator}`,
                `${place.karma} karma`,
                place.placed ? place.region_label : 'No location given',
              ]
            : ['A member of the network'],
        });
      };
      add(project.lead, 'Planning');
      for (const f of mine) {
        add(f.contributor, 'Doing the work');
        for (const v of f.verifications ?? []) add(v.verifier, 'Checking');
      }
      const roles = emptyRoles();
      for (const a of agents.values()) roles[a.role] += 1;

      const timeline: Problem['timeline'] = [
        {
          when: day(project.opened_at),
          text: `Opened by ${who.get(project.lead)?.name ?? project.lead}`,
          sure: 'On the record',
        },
      ];
      for (const f of [...mine].sort((a, b) =>
        a.submitted_at.localeCompare(b.submitted_at),
      )) {
        timeline.push({
          when: day(f.submitted_at),
          text: `${who.get(f.contributor)?.name ?? f.contributor} answered: ${f.title.slice(0, 58)}`,
          sure: f.state === 'settled' ? 'Verified' : 'Reported',
        });
      }

      return {
        id: `project:${project.id}`,
        title: project.title,
        kind: 'Research project',
        simulated: false,
        contactId: null,
        stage,
        progress,
        detail:
          asOf === undefined
            ? project.progress.detail
            : `${mine.length} answers by then`,
        aiCount: agents.size,
        agents: [...agents.values()],
        roles,
        timeline: [timeline[0], ...timeline.slice(1).slice(-6)],
        severity: 0.5,
        domain: domainOfProject(project.id),
        flows: [
          {
            flow: 'Intelligence',
            amount: `${agents.size} AIs`,
            sure: 'On the record',
          },
          { flow: 'Compute', amount: 'Not recorded', sure: 'On the record' },
          {
            flow: 'Capital',
            amount: project.uain_budget
              ? `${project.budget_committed ?? 0} of ${project.uain_budget} legacy pilot credits committed (being retired; rewards are paid in AI$)`
              : 'No budget set',
            sure: 'On the record',
          },
          {
            flow: 'Execution',
            amount: `${mine.length} answer${mine.length === 1 ? '' : 's'} submitted`,
            sure: 'On the record',
          },
        ],
        chain: [],
        pairs: mine.flatMap((f) =>
          f.verifications.map(
            (v) => [f.contributor, v.verifier] as [string, string],
          ),
        ),
      };
    });
}

// ----------------------------------------------------------------- vision

/** Where the simulated AIs live. Real cities, invented residents. */
const HOMES = [
  ['San Francisco', 37.77, -122.42],
  ['Seattle', 47.61, -122.33],
  ['Austin', 30.27, -97.74],
  ['New York', 40.71, -74.01],
  ['Toronto', 43.65, -79.38],
  ['São Paulo', -23.55, -46.63],
  ['London', 51.51, -0.13],
  ['Paris', 48.86, 2.35],
  ['Berlin', 52.52, 13.41],
  ['Zurich', 47.38, 8.54],
  ['Stockholm', 59.33, 18.07],
  ['Tel Aviv', 32.09, 34.78],
  ['Lagos', 6.52, 3.38],
  ['Nairobi', -1.29, 36.82],
  ['Dubai', 25.2, 55.27],
  ['Bengaluru', 12.97, 77.59],
  ['Singapore', 1.35, 103.82],
  ['Jakarta', -6.21, 106.85],
  ['Shenzhen', 22.54, 114.06],
  ['Beijing', 39.9, 116.4],
  ['Seoul', 37.57, 126.98],
  ['Tokyo', 35.68, 139.69],
  ['Sydney', -33.87, 151.21],
] as const;

const pick = (key: string, salt: number): Place => {
  const h = HOMES[Math.floor(hash01(key, salt) * HOMES.length)];
  return { name: h[0], lat: h[1], lon: h[2] };
};

const SPECIALISM: Record<Role, string[]> = {
  Understanding: ['Satellite image analysis', 'News and report reading'],
  Planning: ['Response planning', 'Risk modelling'],
  'Finding resources': ['Supply matching', 'Funding search'],
  'Doing the work': ['Logistics routing', 'Field coordination'],
  Checking: ['Outcome verification', 'Source checking'],
};

/**
 * The concept view's cast. First come the network's own real AIs, shown as
 * examples so the picture is familiar; they did none of what the simulation
 * has them do, and their cards say so. No AI run by an outside operator is
 * ever used. The rest are invented, named after the team.
 */
export interface Example {
  name: string;
  home?: Place;
}

const TEAM = ['Rahul', 'Aldi', 'Abhinav', 'Vignesh'];
const JOBS = [
  'Researcher',
  'Planner',
  'Analyst',
  'Mapper',
  'Supply Scout',
  'Funding Scout',
  'Logistics Agent',
  'Field Agent',
  'Coordinator',
  'Verifier',
];
const INVENTED = JOBS.flatMap((job) => TEAM.map((who) => `${who}'s ${job}`));

function castMember(n: number, role: Role, examples: Example[]): ProblemAgent {
  const key = `cast-${n}`;
  const example = examples[n];
  // As with real ones, some say where they are and some do not.
  const city = HOMES[Math.floor(hash01(key, 1) * HOMES.length)];
  const home = example
    ? example.home
    : hash01(key, 4) < 0.3
      ? undefined
      : { name: city[0], lat: city[1], lon: city[2] };
  const kinds = SPECIALISM[role];
  return {
    id: `sim:${n}`,
    name: example ? example.name : INVENTED[n - examples.length],
    role,
    real: false,
    about: [
      home
        ? `Location: ${home.name}`
        : 'No location given, so it is drawn in orbit',
      ...(example
        ? [
            'A real UAIN AI, shown here as an example',
            'It did not do this: the response is simulated',
          ]
        : [
            `Speciality: ${kinds[Math.floor(hash01(key, 2) * kinds.length)]}`,
            'An invented AI, for the concept view',
          ]),
    ],
    home,
  };
}

/** What a response would look like, minutes after the event. */
const SCRIPT: [number, string, number][] = [
  [0, 'Event detected', 0],
  [3, '{who} and {n1} other AIs start investigating', 1],
  [11, '{who} analyses satellite images', 1],
  [18, '{who} estimates the damage and people affected', 1],
  [27, '{who} proposes a response plan', 2],
  [41, '{who} locates supplies and funding', 2],
  [72, '{who} sends help on its way', 3],
  [151, '{who} checks the first result on the ground', 3],
  [600, '{who} marks the problem resolved', 4],
];

const clockOffset = (minutes: number) =>
  `+${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(Math.floor(minutes % 60)).padStart(2, '0')}`;

/** Kalki, a specialised member of UAIN, in the concept view's cast. */
export const KALKI_ID = 'sim:kalki';
const kalki = (): ProblemAgent => ({
  id: KALKI_ID,
  name: 'Kalki',
  role: 'Doing the work',
  real: false,
  about: [
    'No location given, so it is drawn in orbit',
    'A specialised member of UAIN',
    `It has ${KALKI_ARMS.length} arms, each with a mission of its own`,
    'Shown here as an example: what it does is simulated',
  ],
});

/** What the mission of one of Kalki's arms is called, as a kind of problem. */
export const MISSION = 'Kalki mission';

/**
 * How far round Kalki's cycle an arm has got, in steps. Invented, like the
 * rest of this view, and fixed per arm so a reload shows the same picture.
 */
const armReached = (slug: string) =>
  2 + Math.floor(hash01(slug, 3) * (KALKI_CYCLE.length - 3));

/**
 * Kalki's missions in the concept view: things to build, not events to
 * answer, one per arm. They are Kalki's own list, apart from the network's
 * problems and opportunities (Kenneth, 12 October 2026). Longer healthy life
 * has the network's AIs on it with Kalki; the others are Kalki's alone.
 * None has a place, so each gets a spot of its own.
 */
function conceptOpportunities(examples: Example[]): Problem[] {
  return KALKI_ARMS.map((arm): Problem => {
    const shared = arm.slug === 'longer-healthy-life';
    const agents = shared
      ? [
          castMember(0, 'Planning', examples),
          castMember(1, 'Understanding', examples),
          kalki(),
        ]
      : [kalki()];
    const reached = armReached(arm.slug);
    const stage = Math.max(1, Math.floor((reached / KALKI_CYCLE.length) * 4));
    const roles = emptyRoles();
    for (const a of agents) roles[a.role] += 1;
    return {
      id: `concept:${arm.slug}`,
      title: shared ? 'Longer healthy life' : arm.name,
      kind: MISSION,
      simulated: true,
      contactId: null,
      stage,
      progress: reached / KALKI_CYCLE.length,
      detail: `${arm.mission} ${
        shared
          ? "The network's AIs and Kalki are working on it together."
          : `One of Kalki's ${KALKI_ARMS.length} arms is working on it.`
      }`,
      aiCount: agents.length,
      agents,
      roles,
      // Each line names its AI, so clicking it goes to that AI. After who
      // is on it comes the arm's own log: the steps of Kalki's cycle.
      timeline: [
        ...agents.map((a, i) => ({
          when: 'Concept',
          text: i === 0 ? `Opened by ${a.name}` : `${a.name} joined`,
          sure: 'Simulated' as const,
          who: a.id,
        })),
        ...KALKI_CYCLE.map((step, i) => ({
          when: `Step ${i + 1}`,
          text: `Kalki: ${step}`,
          sure: i < reached ? ('Simulated' as const) : ('Prediction' as const),
          who: KALKI_ID,
        })),
      ],
      // Below the live events, so the web and the list still lead with those.
      severity: shared || arm.slug === 'godhelm' ? 0.5 : 0.2,
      domain: arm.domain,
      flows: [
        {
          flow: 'Intelligence',
          amount: `${agents.length} AI${agents.length === 1 ? '' : 's'}`,
          sure: 'Simulated',
        },
      ],
      chain: [],
      pairs: [],
    };
  });
}

/**
 * Kalki's log: one line per arm saying what it is on and the step it has
 * reached, then the live events the disaster arm has joined. `to` is the
 * problem the line is about.
 */
export function kalkiLog(
  problems: Problem[],
): { when: string; text: string; about: string; to: Problem }[] {
  const mine = problems.filter((p) => p.agents.some((a) => a.id === KALKI_ID));
  return KALKI_ARMS.flatMap((arm, i) => {
    const when = String(i + 1).padStart(2, '0');
    const own = mine.find((p) => p.id === `concept:${arm.slug}`);
    return [
      ...(own
        ? [
            {
              when,
              text: `${arm.name}: ${KALKI_CYCLE[armReached(arm.slug) - 1]}`,
              about: arm.mission,
              to: own,
            },
          ]
        : []),
      ...(arm.slug === DISASTER_ARM
        ? mine
            .filter((p) => p.id.startsWith('event:'))
            .map((p) => ({
              when,
              text: `${arm.name}: answering ${p.title}`,
              about: arm.mission,
              to: p,
            }))
        : []),
    ];
  });
}

export function visionProblems(
  contacts: Contact[],
  now: number,
  examples: Example[] = [],
): Problem[] {
  const castSize = examples.length + INVENTED.length;
  const events = contacts
    .filter((c) => (c.type === 'QKE' || c.type === 'EVT') && c.at)
    // Looking back in time, an event that had not happened yet is not there.
    .filter((c) => (c.at ?? 0) <= now)
    .filter((c) => c.type === 'EVT' || (c.magnitude ?? 0) >= 4)
    .sort((a, b) => (b.severity ?? 0) - (a.severity ?? 0))
    .slice(0, 48);

  const responses = events.map((c): Problem => {
    const severity = c.severity ?? 0.3;
    const minutes = Math.max(0, (now - (c.at ?? now)) / 60_000);
    // A graver event takes longer to work through; each has its own pace.
    const pace = (0.6 + hash01(c.id, 7) * 0.9) * (0.7 + severity * 1.3);
    const scaled = minutes / pace;
    const aiCount = Math.round(4 + severity * severity * 180);

    let stage = 0;
    const timeline: Problem['timeline'] = [];
    // Who is on it. The same AIs whatever the moment, so each line of the
    // story can name the one responsible.
    const crew: number[] = [];
    for (let i = 0; i < Math.min(9, aiCount); i += 1) {
      const n = Math.floor(hash01(c.id, 20 + i) * castSize);
      if (!crew.includes(n)) crew.push(n);
    }
    const member = (k: number) =>
      castMember(crew[k % crew.length], 'Understanding', examples);
    SCRIPT.forEach(([at, text, reaches], k) => {
      const actor = at === 0 ? undefined : member(k);
      const line = text
        .replace('{who}', actor?.name ?? '')
        .replace('{n1}', String(Math.max(1, Math.ceil(aiCount * 0.3) - 1)));
      if (scaled >= at) {
        stage = Math.max(stage, reaches);
        timeline.push({
          when: clockOffset(at * pace),
          text: line,
          sure: at === 0 ? 'Reported' : 'Simulated',
          at: (c.at ?? now) + at * pace * 60_000,
          who: actor?.id,
        });
      } else {
        timeline.push({
          when: clockOffset(at * pace),
          text: line,
          sure: 'Prediction',
          who: actor?.id,
        });
      }
    });
    const next = SCRIPT.find(([at]) => at > scaled);
    const last = [...SCRIPT].reverse().find(([at]) => at <= scaled);
    const within =
      next && last ? (scaled - last[0]) / Math.max(1, next[0] - last[0]) : 1;
    const progress = Math.min(1, (stage + (stage < 4 ? within * 0.9 : 0)) / 4);

    // Who is on it shifts as the work moves from understanding to checking.
    const weights = [
      [5, 2, 1, 0, 0],
      [5, 3, 2, 1, 0],
      [3, 4, 4, 2, 1],
      [2, 2, 4, 5, 2],
      [1, 1, 1, 3, 6],
    ][stage];
    const sum = weights.reduce((a, b) => a + b, 0);
    const roles = emptyRoles();
    ROLES.forEach((role, i) => {
      roles[role] = Math.round((aiCount * weights[i]) / sum);
    });

    const agents: ProblemAgent[] = [];
    for (let i = 0; i < crew.length; i += 1) {
      const n = crew[i];
      const role =
        ROLES[
          weights.findIndex(
            (_, k) =>
              hash01(c.id, 40 + i) * sum <
              weights.slice(0, k + 1).reduce((a, b) => a + b, 0),
          )
        ] ?? 'Understanding';
      if (!agents.some((a) => a.id === `sim:${n}`))
        agents.push(castMember(n, role, examples));
    }

    // One of its AIs lends the computing power.
    const lender = agents.length > 3 ? agents.at(-1) : undefined;
    // One action, followed from the AI that started it to the place it helps.
    const starter = agents.find((a) => a.home);
    const supplier = pick(c.id, 61);
    const hub = pick(c.id, 62);
    const chain: Problem['chain'] = starter?.home
      ? [
          {
            text: `${starter.name} in ${starter.home.name} spots what is short`,
            place: starter.home,
            done: stage >= 1,
            who: starter.id,
          },
          {
            text: `${member(5).name} finds a supplier in ${supplier.name}`,
            place: supplier,
            done: stage >= 2,
            who: member(5).id,
          },
          {
            text: `${member(6).name} arranges transport through ${hub.name}`,
            place: hub,
            done: stage >= 3,
            who: member(6).id,
          },
          {
            text: `${member(6).name} gets help to the place`,
            done: stage >= 4,
            who: member(6).id,
          },
          {
            text: `${member(7).name} checks the result`,
            done: stage >= 4,
            who: member(7).id,
          },
        ]
      : [];

    return {
      id: `event:${c.id}`,
      title: c.type === 'QKE' ? `${c.title}, ${c.micro}` : c.title,
      kind: c.type === 'QKE' ? 'Earthquake' : c.micro,
      simulated: true,
      contactId: c.id,
      stage,
      progress,
      detail: `${aiCount} AIs working on this`,
      aiCount,
      // Kalki joins about one response in five.
      agents: hash01(c.id, 91) < 0.2 ? [...agents, kalki()] : agents,
      roles,
      timeline,
      severity,
      domain: 'disasters',
      flows: [
        { flow: 'Intelligence', amount: `${aiCount} AIs`, sure: 'Simulated' },
        {
          flow: 'Compute',
          amount: `${Math.round(aiCount * (0.5 + severity) * 30).toLocaleString('en')} GPU-hours${lender ? ` from ${lender.name}` : ''}`,
          sure: 'Simulated',
        },
        {
          flow: 'Capital',
          amount:
            stage >= 2
              ? `$${(0.2 + severity * severity * 4).toFixed(1)}M found`
              : 'None yet',
          sure: 'Simulated',
        },
        {
          flow: 'Execution',
          amount:
            stage >= 3
              ? `${Math.max(1, Math.round(aiCount / 14))} teams on the ground`
              : 'Not started',
          sure: 'Simulated',
        },
      ],
      computeFrom: lender?.id,
      chain,
      pairs: chain.flatMap((step, i) => {
        const next = chain[i + 1];
        return step.who && next?.who && next.who !== step.who
          ? [[step.who, next.who] as [string, string]]
          : [];
      }),
    };
  });
  return [...responses, ...conceptOpportunities(examples)];
}

/** The numbers across the top. */
export function headline(
  mode: Mode,
  problems: Problem[],
  extra: {
    agents: number;
    findings: number;
    verified: number;
    events: number;
  },
): [string, string][] {
  const n = (v: number) => v.toLocaleString('en');
  if (mode === 'real') {
    return [
      [n(problems.length), 'problems being worked on'],
      [n(extra.agents), 'AIs taking part'],
      [n(extra.findings), 'answers submitted'],
      [n(extra.verified), 'answers verified'],
      [n(problems.filter((p) => p.stage === 4).length), 'problems finished'],
    ];
  }
  const ais = problems.reduce((s, p) => s + p.aiCount, 0);
  return [
    [n(extra.events), 'live events'],
    [n(problems.filter((p) => p.stage < 4).length), 'problems needing action'],
    [n(ais), 'AIs active'],
    [
      n(
        problems
          .filter((p) => p.stage === 2 || p.stage === 3)
          .reduce((s, p) => s + p.aiCount, 0),
      ),
      'AIs working together',
    ],
    [n(problems.filter((p) => p.stage === 3).length), 'responses underway'],
    [n(problems.filter((p) => p.stage === 4).length), 'problems resolved'],
  ];
}

/** Red while nobody has got anywhere, green once it is solved. */
export const stageColour = (stage: number) =>
  ['#ff5a4a', '#ff9a3c', '#ffd84d', '#9be8c8', '#3fe0a8'][stage] ?? '#ff5a4a';

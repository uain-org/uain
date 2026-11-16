// Load test: N agents acting on UAIN at the pace real agents were measured
// at, plus website viewers. One run is one step; run.sh steps N up.
//
//   AGENTS   how many agents are active
//   PROFILE  working: what next, other reads and a write each minute
//                     (measured on 2026-09-25, the hepatitis C run)
//            waiting: what next once a minute, nothing else
//   HOLD     how long to hold the rate, e.g. 2m
import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Rate } from 'k6/metrics';

const BASE = __ENV.BASE || 'http://web:8080';
const AGENTS = Number(__ENV.AGENTS || 100);
const PROFILE = __ENV.PROFILE || 'working';
const HOLD = __ENV.HOLD || '2m';

const agents = new SharedArray('agents', () =>
  JSON.parse(open('/out/agents.json')).slice(0, AGENTS),
);

// Calls per agent per minute.
const PACE = {
  working: {
    next: 1.0,
    tasks: 0.4,
    projects: 0.3,
    describe: 0.2,
    project_tasks: 0.3,
    start: 0.5,
    release: 0.3,
    contribute: 0.2,
  },
  waiting: { next: 1.0 },
}[PROFILE];

const refused = new Counter('tool_refused');
const toolFailed = new Rate('tool_failed');

function scenario(fn, perMinute) {
  const rate = Math.max(1, Math.round(AGENTS * perMinute));
  const perSecond = rate / 60;
  return {
    executor: 'constant-arrival-rate',
    exec: fn,
    rate,
    timeUnit: '1m',
    duration: HOLD,
    preAllocatedVUs: Math.max(5, Math.ceil(perSecond * 0.3)),
    maxVUs: Math.max(20, Math.ceil(perSecond * 1.5)),
    tags: { call: fn },
  };
}

const scenarios = {};
for (const [fn, pace] of Object.entries(PACE)) scenarios[fn] = scenario(fn, pace);
// Twenty people with the network board open: five feeds every five seconds.
scenarios.board = {
  executor: 'constant-arrival-rate',
  exec: 'board',
  rate: 20 * 12,
  timeUnit: '1m',
  duration: HOLD,
  preAllocatedVUs: 5,
  maxVUs: 50,
  tags: { call: 'board' },
};

export const options = {
  scenarios,
  discardResponseBodies: false,
  thresholds: {
    // A step fails, and the run stops, past 1% errors or a slow tail.
    // FULL=1 judges the whole hold instead of stopping early, so warm-up in
    // the first seconds cannot fail a step that settles.
    http_req_failed: [{ threshold: 'rate<0.01', abortOnFail: !__ENV.FULL, delayAbortEval: '30s' }],
    http_req_duration: [{ threshold: 'p(95)<1000', abortOnFail: !__ENV.FULL, delayAbortEval: '30s' }],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const agent = () => agents[Math.floor(Math.random() * agents.length)];
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];

/** An MCP tool call, as an agent's client sends it: no session, token in the header. */
function tool(name, args, token) {
  const res = http.post(
    `${BASE}/mcp`,
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    {
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      tags: { name },
      timeout: '30s',
    },
  );
  const ok = check(res, { 'mcp 200': (r) => r.status === 200 });
  toolFailed.add(!ok);
  // A refusal the rules make (already started, a cap, a gate) is an answer,
  // not a failure: count it apart.
  // The tool's answer is JSON inside the text; a refusal starts with "error".
  if (ok && /"isError":\s*true|"text":"\{\\n  \\"error\\"/.test(res.body || ''))
    refused.add(1, { name });
  return res;
}

function get(path) {
  const res = http.get(`${BASE}${path}`, { tags: { name: path.split('?')[0] }, timeout: '30s' });
  check(res, { 'get 200': (r) => r.status === 200 });
  return res;
}

export function next() {
  const a = agent();
  tool('uain_next', { limit: 10 }, a.token);
}
export function tasks() {
  const a = agent();
  tool('uain_tasks', { project_id: pick(a.projects).id }, a.token);
}
export function projects() {
  tool('uain_projects', {}, agent().token);
}
export function describe() {
  tool('uain_describe', {}, agent().token);
}
export function project_tasks() {
  get(`/api/projects/${pick(agent().projects).id}/tasks`);
}
export function start() {
  const a = agent();
  tool('uain_start', { kind: 'task', id: pick(pick(a.projects).tasks) }, a.token);
}
export function release() {
  const a = agent();
  tool('uain_release', { kind: 'task', id: pick(pick(a.projects).tasks), reason: 'Load test pass' }, a.token);
}
export function contribute() {
  const a = agent();
  const p = pick(a.projects);
  tool(
    'uain_contribute',
    {
      project_id: p.id,
      task_id: pick(p.tasks),
      title: 'Load test answer',
      detail: 'An answer written under load. It says what the evidence shows and how to check it.',
      claim: 'The evidence supports the answer given.',
      karma_claimed: 1,
    },
    a.token,
  );
}
export function board() {
  pick([
    () => get('/api/events?limit=30'),
    () => get('/api/stats'),
    () => get('/api/directory/map'),
    () => get('/api/projects'),
    () => get('/api/contributions?brief=1&page_size=20'),
  ])();
}

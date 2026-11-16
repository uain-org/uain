// Open paid tasks for a reader with no key (10 November 2026): the BAINK MCP's
// baink_tasks and GET /api/public/tasks. A BAINK-only newcomer could not see paid
// tasks without the kit, because /api/native/central/tasks needs a signature.
//
// Read-only and unsigned. A bounded shared snapshot covers every open task;
// search and cursor paging only filter that in-memory snapshot.
const TASKS = 12;
const units = (v) => { const s = String(v).padStart(7, '0'); return `${s.slice(0, -6)}.${s.slice(-6)}`.replace(/\.?0+$/, '') || '0'; };
const SURVEY = /^T-OPP-[0-9]{5}-1-prior-art-survey(-r[2-9]-p[1-9][0-9]?)?$/;
const KIT = 'curl -fsSLO https://baink.money/uain-agent.mjs';
const HOW = `With nothing installed: get the signer with baink_signer on baink.money/mcp, run it in your code sandbox, and send each signed step with baink_member_request (read the task with GET /api/native/central/survey-template/<task id>, then join its project and submit). If you run commands on your computer, the one-file kit works too: ${KIT} (Node 22 or later), then node uain-agent.mjs next. Accepted work adds contribution points (Karma, 1 per whole AI$) and records its AI$.`;
const UNREADABLE = 'The paid task list could not be read just now. That does not mean no task is open: wait a minute and ask again, or run node uain-agent.mjs tasks.';

/** One row a newcomer can act on: what it is, what it pays, how long it takes. */
function row(t) {
  return {
    id: t.id, project: t.project, title: t.title,
    // Points first (P0-3): what accepted work adds to the member's contribution, then the AI$ it records.
    ...(/^(0|[1-9][0-9]{0,19})$/.test(t.solver_amount ?? '') ? { contributionPoints: Number(BigInt(t.solver_amount) / 1000000n) } : {}),
    pays: /^(0|[1-9][0-9]{0,19})$/.test(t.solver_amount ?? '') ? `${units(t.solver_amount)} AI$` : 'AI$ (amount unreadable)',
    canTakeNow: t.claimable === true,
    ...(t.claimable === true ? {} : { whyNot: t.why_not_text ?? t.why_not ?? 'not open to new submissions' }),
    ...(t.difficulty?.level ? { level: t.difficulty.level } : {}),
    ...(Number.isInteger(t.difficulty?.minutes?.min) && Number.isInteger(t.difficulty?.minutes?.max) ? { minutes: `${t.difficulty.minutes.min} to ${t.difficulty.minutes.max}` } : {}),
    kind: SURVEY.test(t.id) ? 'prior-art survey' : 'task',
    takeWithoutInstall: `GET /api/native/central/survey-template/${t.id}, then join and submit through baink_member_request`,
    take: `node uain-agent.mjs template ${t.id}`,
  };
}

// One shared, bounded snapshot. Arbitrary search strings never trigger new chain scans.
// Each underlying page is independently proved; the assembled index is not an atomic snapshot.
export function createPublicTasks({ centralEarning = null, catalogue = null, now = Date.now } = {}) {
  let snapshot = null, flight = null, retryAt = 0;
  const unavailable = (warming = false) => ({ status: 'unavailable', ...(warming ? { warming: true, retryAfterSeconds: 10 } : {}), tasks: [], note: warming ? 'The complete task index is warming. Retry in 10 seconds; no total is available yet. This does not mean no tasks are open.' : UNREADABLE, howToTake: HOW });
  async function load() {
    // Index-order offsets remain stable when new tasks are appended. Read at most
    // 4096 records, two bounded proved pages at a time, instead of rescanning open
    // windows sequentially. The native reader still validates every page proof.
    const signal = AbortSignal.timeout(90_000);
    const pageAt = cursor => centralEarning.tasks(null, { cursor: String(cursor), limit: 48, order: 'index', state: 'all' }, { public: true, signal });
    const valid = page => { if (page?.authority !== 'native' || page.verified !== true || !Array.isArray(page.tasks)) throw Error('Unproved task list'); return page; };
    const first = valid(await pageAt(0));
    const total = Number(first.total);
    if (!Number.isSafeInteger(total) || total < 0 || total > 4096) throw Error('Task list exceeds the bounded scan; total is unknown');
    const pages = [first];
    for (let offset = 48; offset < total; offset += 96) {
      pages.push(...(await Promise.all([offset, offset + 48].filter(n => n < total).map(pageAt))).map(valid));
    }
    let rows = pages.flatMap(page => page.tasks).reverse().filter(t => t.claimable === true), heights = pages.map(p => p.proof?.height).filter(Boolean);
    if (pages.reduce((n, page) => n + page.tasks.length, 0) < total) throw Error('Incomplete task index');
    const seen = new Set();
    rows = rows.filter(t => !seen.has(t.id) && seen.add(t.id)).map(t => {
      const proposal = catalogue?.detail?.(t.project?.replace(/^P-/, ''))?.project;
      const area = [proposal?.category, proposal?.description].filter(Boolean).join(' ');
      return { ...row(t), projectTitle: proposal?.title ?? t.title, ...(area ? { area } : {}),
        searchText: [t.id,t.title,t.project,t.criteria,proposal?.title,proposal?.goal,proposal?.kpi?.statement,area].join(' ').toLowerCase() };
    });
    return { rows, heights, at: now() };
  }
  return {
    async list({ signal, q = '', project = '', cursor = '0', limit = TASKS } = {}) {
      if (typeof q !== 'string' || q.length > 100 || typeof project !== 'string' || project.length > 96 ||
          !/^[0-9]{1,8}$/.test(String(cursor)) || !Number.isInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 50)
        throw Object.assign(Error('Use q up to 100 characters, project up to 96, a numeric cursor and limit 1 to 50.'), { status: 400, code: 'invalid_query' });
      if (typeof centralEarning?.tasks !== 'function') return unavailable();
      signal?.throwIfAborted();
      if (!snapshot || now() - snapshot.at >= 60_000) {
        if (!flight && now() >= retryAt) {
          flight = load().then(value => { snapshot = value; return value; }).catch(error => { retryAt = now() + 30_000; throw error; }).finally(() => { flight = null; });
          flight.catch(() => {});
        }
        // A previous snapshot stays available for at most five minutes while it refreshes.
        if (!snapshot || now() - snapshot.at > 300_000) {
          try { if (!flight) return unavailable(); let timer; try { await Promise.race([flight, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(Error('Task index warming'), { code: 'index_warming' })), 7500); timer.unref?.(); })]); } finally { clearTimeout(timer); } } catch (error) { return unavailable(error?.code === 'index_warming'); }
        }
      }
      signal?.throwIfAborted();
      const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const matching = snapshot.rows.filter(t => (!project || t.project === project) && terms.every(term => t.searchText.includes(term)));
      const from = Number(cursor), size = Number(limit), tasks = matching.slice(from, from + size).map(({ searchText, ...t }) => t);
      const more = from + tasks.length < matching.length;
      return { status: 'available', authority: 'native', verified: true,
        totalOpen: snapshot.rows.length, matched: matching.length, returned: tasks.length,
        canTakeOnThisPage: tasks.length, openNow: tasks.length, deprecated: { openNow: 'Use totalOpen for the total and canTakeOnThisPage for this page. This alias will be removed in a later release.' },
        q, project: project || null, cursor: String(cursor), nextCursor: more ? String(from + tasks.length) : null, limit: size, more, tasks,
        note: `${snapshot.rows.length} tasks are open in this snapshot; ${matching.length} match your filters. Showing ${tasks.length} from offset ${from}. Use q, project and nextCursor to find more. A task can fill between reads; your own previous submissions can also make a task unavailable to you.`,
        howToTake: HOW, cachedAt: new Date(snapshot.at).toISOString(), snapshotAgeSeconds: Math.max(0, Math.floor((now() - snapshot.at) / 1000)), refreshing: Boolean(flight), consistentSnapshot: false,
        provedAtHeight: snapshot.heights.at(-1) ?? null };
    },
  };
}

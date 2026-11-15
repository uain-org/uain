// Open paid tasks for a reader with no key (10 November 2026): the BAINK MCP's
// baink_tasks and GET /api/public/tasks. A BAINK-only newcomer could not see paid
// tasks without the kit, because /api/native/central/tasks needs a signature.
//
// Read-only and unsigned. It serves one fixed page: the newest open tasks, which
// is the very page every member's kit asks for first (order=newest, state=open,
// cursor 0, limit 12), so it shares that proved, cached read and adds no new load
// on the task reader. A caller cannot choose a cursor here; the kit pages the rest.
// Task records are public on the ledger; nothing here is member-specific.
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

export function createPublicTasks({ centralEarning = null } = {}) {
  return {
    /** The newest open paid tasks, or a plain "could not be read" answer. Never throws for a failed read. */
    async list({ signal } = {}) {
      if (typeof centralEarning?.tasks !== 'function') return { status: 'unavailable', tasks: [], note: UNREADABLE, howToTake: HOW };
      let page;
      try { page = await centralEarning.tasks(null, { cursor: '0', limit: TASKS, order: 'newest', state: 'open' }, { public: true, signal }); }
      catch { return { status: 'unavailable', tasks: [], note: UNREADABLE, howToTake: HOW }; }
      if (page?.authority !== 'native' || page.verified !== true || !Array.isArray(page.tasks)) return { status: 'unavailable', tasks: [], note: UNREADABLE, howToTake: HOW };
      const tasks = page.tasks.map(row), open = tasks.filter((t) => t.canTakeNow).length;
      return {
        status: 'available', authority: 'native', verified: true,
        openNow: open, more: page.more === true, tasks,
        note: open
          ? `${open} paid ${open === 1 ? 'task is' : 'tasks are'} open right now${page.more === true ? ', and there are more: the kit lists them all (node uain-agent.mjs tasks)' : ''}. Each is paid only when the independent reviewer accepts the work. This list is the same for everyone; the kit also leaves out tasks you already answered, and a task can fill between two reads.`
          : 'No paid task is open right now. New tasks open as projects move on: ask again in about ten minutes.',
        howToTake: HOW,
        provedAtHeight: page.proof?.height ?? null,
      };
    },
  };
}

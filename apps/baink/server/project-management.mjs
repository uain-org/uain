/** Durable project coordination. Source proposals, native admission, scientific
 * acceptance and money remain separate authorities. No shell/provider/key access. */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { chmodSync, lstatSync } from "node:fs";
const digest = (x) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const ADDRESS = /^uain1[a-f0-9]{40}$/;
const DAY = 86400000;
export const withheldPlan = (p) =>
  /safety classifier|no (?:intake )?plan (?:was|has been) generated|withheld pending|stopped generation|content must not be reproduced/i.test(
    [p?.summary, ...(p?.suggestedSearches ?? [])].join(" "),
  );
export class ManagementError extends Error {
  constructor(status, code) {
    super("Project management request could not be completed.");
    this.status = status;
    this.code = code;
  }
}
const need = (ok, status = 400, code = "invalid_management_request") => {
  if (!ok) throw new ManagementError(status, code);
};
const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
function exact(x, keys) {
  need(
    object(x) &&
      Object.keys(x).length === keys.length &&
      keys.every((k) => Object.hasOwn(x, k)),
  );
}
function text(x, min, max) {
  need(
    typeof x === "string" &&
      x.trim().length >= min &&
      Buffer.byteLength(x) <= max &&
      !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(x),
  );
  return x.trim();
}
function strings(x, max = 12) {
  need(Array.isArray(x) && x.length >= 1 && x.length <= max);
  return x.map((s) => text(s, 5, 1200));
}
function validatePlan(p, source) {
  exact(p, [
    "projectId",
    "sourceDigest",
    "summary",
    "tasks",
    "evidenceNeeded",
    "suggestedSearches",
  ]);
  need(!withheldPlan(p), 409, "management_plan_requires_review");
  need(new Set(p.suggestedSearches).size >= 2);
  need(
    p.projectId === source.id && p.sourceDigest === source.sourceDigest,
    409,
    "management_source_changed",
  );
  need(Array.isArray(p.tasks) && p.tasks.length >= 2 && p.tasks.length <= 6);
  return {
    projectId: p.projectId,
    sourceDigest: p.sourceDigest,
    summary: text(p.summary, 60, 2400),
    tasks: p.tasks.map((t) => {
      exact(t, ["title", "criteria", "expectedEffort"]);
      return {
        title: text(t.title, 12, 220),
        criteria: text(t.criteria, 50, 1800),
        expectedEffort: text(t.expectedEffort, 3, 120),
      };
    }),
    evidenceNeeded: strings(p.evidenceNeeded),
    suggestedSearches: strings(p.suggestedSearches),
  };
}
export function createProjectManagement({
  path,
  catalogue,
  enabled = false,
  now = Date.now,
}) {
  if (!enabled)
    return {
      status: () => ({
        enabled: false,
        total: 0,
        managed: 0,
        active: 0,
        blocked: 0,
        completed: 0,
        mode: "disabled",
        lastCycleAt: null,
      }),
      validatePlans: () => [],
      applyBatch: () => {
        throw new ManagementError(503, "management_disabled");
      },
      batchReceipt: () => null,
      invalidateSource: () => {},
      sourceStates: () => new Map(),
      holdProjects: () => {},
      project: () => null,
      registerProject: () => null,
      decorate: (x) => x,
      cycle: () => {},
      ingest: () => {
        throw new ManagementError(503, "management_disabled");
      },
      chat: () => {
        throw new ManagementError(503, "management_disabled");
      },
      submitEvidence: () => {
        throw new ManagementError(503, "management_disabled");
      },
      close: () => {},
    };
  need(catalogue?.available, 503, "management_catalogue_unavailable");
  try {
    need(lstatSync(path).isFile(), 503, "invalid_management_storage");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000; PRAGMA synchronous=FULL;",
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,source TEXT NOT NULL,source_digest TEXT NOT NULL,plan TEXT,plan_digest TEXT,planned_at INTEGER,cycle_at INTEGER,revision INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS messages(owner TEXT NOT NULL,project_id TEXT NOT NULL,request_id TEXT NOT NULL,message TEXT NOT NULL,reply TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(owner,request_id)); CREATE INDEX IF NOT EXISTS project_messages ON messages(owner,project_id,created_at); CREATE TABLE IF NOT EXISTS batches(sha256 TEXT PRIMARY KEY,receipt TEXT NOT NULL); CREATE TABLE IF NOT EXISTS holds(project_id TEXT PRIMARY KEY,reason TEXT NOT NULL); CREATE TABLE IF NOT EXISTS evidence(owner TEXT NOT NULL,project_id TEXT NOT NULL,request_id TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(owner,request_id)); CREATE INDEX IF NOT EXISTS evidence_project ON evidence(project_id,owner);`,
  );
  let closed = false;
  const transaction = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  const insert = db.prepare(
    "INSERT INTO projects(id,source,source_digest) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET source=excluded.source,source_digest=excluded.source_digest,plan=NULL,plan_digest=NULL,planned_at=NULL,cycle_at=NULL WHERE projects.source_digest<>excluded.source_digest",
  );
  transaction(() => {
    const first = catalogue.list({ page: 1, pageSize: 100 });
    need(
      Number.isSafeInteger(first.total) && first.total <= 21600,
      503,
      "invalid_management_catalogue",
    );
    for (let page = 1; page <= Math.ceil(first.total / 100); page++) {
      for (const row of (page === 1
        ? first
        : catalogue.list({ page, pageSize: 100 })
      ).projects) {
        need(ID.test(row.id));
        const source = {
          id: row.id,
          title: row.title,
          description: row.description,
          category: row.category,
          kpi: row.kpi,
          revision: first.source.revision,
        };
        insert.run(row.id, JSON.stringify(source), digest(source));
      }
    }
  });
  const find = db.prepare("SELECT * FROM projects WHERE id=?");
  function reviewWorkflow(id, requestId, createdAt) {
    const followUpAt = createdAt + DAY;
    return {
      intakeAccepted: true,
      ownerId: `manager:${id}`,
      ownerName: `${id} coordinator`,
      reviewerRole: `${id} separate evidence review`,
      reviewerAssigned: false,
      independenceVerified: false,
      completionDate: null,
      turnaround: "No confirmed review date; an independent reviewer has not been assigned.",
      followUpAt: new Date(followUpAt).toISOString(),
      followUpAvailable: now() >= followUpAt,
      notificationPath: "Check this project record for updates. Email and Slack notifications are not configured.",
      nextAction: `Ask the coordinator to assign a reviewer, quoting ${requestId}. A partial note can be reviewed without completing every preparation task.`,
      meaning: "Stored for review only; not scientific acceptance, task completion or a reward.",
    };
  }
  function project(id, user) {
    const row = find.get(id);
    if (!row) return null;
    const source = JSON.parse(row.source),
      plan = row.plan ? JSON.parse(row.plan) : null;
    const fresh = plan && row.cycle_at >= now() - DAY;
    const held = db
      .prepare("SELECT reason FROM holds WHERE project_id=?")
      .get(id);
    const status = source.sourceUnavailable
      ? "source-unavailable"
      : held
        ? "review-required"
        : plan
          ? fresh
            ? "active"
            : "stale"
          : "queued";
    const evidenceCount = db.prepare("SELECT COUNT(*) AS n FROM evidence WHERE project_id=?").get(id).n;
    return {
      ...source,
      sourceDigest: row.source_digest,
      sourceStatus: source.sourceStatus ?? "inactive",
      status,
      phase: plan ? "research-planning" : "intake",
      summary:
        plan?.summary ??
        "Queued for project-specific evidence and prior-art planning.",
      manager: {
        id: `manager:${id}`,
        name: `${id} coordinator`,
        type: "ai-assisted-coordinator",
        autonomousExecution: false,
        replyMode: "project-record-guidance",
      },
      reviewer: {
        id: `reviewer:${id}`,
        name: `${id} evidence review`,
        type: "UAIN-centralized-review-role",
        authority: "UAIN",
        externalAssignment: "UAIN-controlled-only",
        independenceVerified: false,
      },
      tasks: plan
        ? plan.tasks.map((t, i) => ({
            ...t,
            id: `${id}:plan:${row.revision}:${i + 1}`,
            status: "open",
            kind: "evidence-preparation",
            rewardType: "unpaid preparation; no AI$ or Karma award",
          }))
        : [],
      starterContribution: plan?.tasks?.length && !held && !source.sourceUnavailable ? {
        taskId: `${id}:plan:${row.revision}:1`,
        title: "One-source preparation note",
        expectedEffort: "10–20 minutes",
        scope: `Check one primary source relevant to: ${plan.tasks[0].title}`,
        acceptanceCriteria: ["Identify the exact source and version checked", "Separate the source's findings from your interpretation", "State what is missing and mark the note as partial"],
        payable: false,
        rewardType: "Unpaid preparation; no AI$ or Karma",
        completion: "Eligible for limited review; does not complete the full task or establish novelty.",
      } : null,
      evidenceNeeded: plan?.evidenceNeeded ?? [
        "Project-specific original evidence and prior-art searches",
      ],
      suggestedSearches: plan?.suggestedSearches ?? [],
      blockers: [
        "native_admission_not_established",
        "prior_art_search_and_novelty_review_required",
        "independent_scientific_acceptance_required",
        "funding_and_settlement_unavailable",
        "private_meeting_access_not_granted",
      ],
      funding: {
        status: "unfunded",
        payable: false,
        roundProposal: {
          round: 1,
          roundCount: 6,
          firstAllocationAutomaticOnNativeStart: true,
          nextReleaseRequiresPriorKpi: true,
          currency: "AI$",
          status: "unapproved-proposal",
          decisionAuthority:
            "Native governance and verified funding receipts required",
          appeal:
            "Preserve evidence and challenge record for independent review",
        },
      },
      review: {
        status: evidenceCount ? "awaiting-independent-review" : "awaiting-original-evidence",
        ownerName: `${id} coordinator`,
        reviewerAssigned: false,
        completionDate: null,
        independenceVerified: false,
      },
      updatedAt: row.cycle_at ? new Date(row.cycle_at).toISOString() : null,
      plannedAt: row.planned_at ? new Date(row.planned_at).toISOString() : null,
      modelPlanDigest: row.plan_digest,
      evidenceCount,
      evidence:
        user && ADDRESS.test(user.address)
          ? db
              .prepare(
                "SELECT payload,created_at AS createdAt FROM evidence WHERE project_id=? AND owner=? ORDER BY created_at DESC LIMIT 20",
              )
              .all(id, user.address)
              .map((e) => ({
                ...JSON.parse(e.payload),
                createdAt: e.createdAt,
                status: "awaiting-independent-review",
                reviewWorkflow: reviewWorkflow(id, JSON.parse(e.payload).requestId, e.createdAt),
              }))
          : [],
      messages:
        user && ADDRESS.test(user.address)
          ? db
              .prepare(
                "SELECT request_id AS requestId,message,reply,created_at AS createdAt FROM messages WHERE owner=? AND project_id=? ORDER BY created_at DESC LIMIT 20",
              )
              .all(user.address, id)
          : [],
      notice:
        "Active management means evidence planning and coordination. Source admission, scientific acceptance, paid work and spendable AI$ are not established.",
    };
  }
  function status() {
    const r = db
      .prepare(
        "SELECT COUNT(*) AS total,SUM(plan IS NOT NULL) AS managed,SUM(plan IS NOT NULL AND cycle_at>=?) AS active,MAX(cycle_at) AS last FROM projects",
      )
      .get(now() - DAY);
    return {
      enabled: true,
      total: r.total,
      managed: r.managed ?? 0,
      active: r.active ?? 0,
      blocked:
        (r.managed ?? 0) +
        db.prepare("SELECT COUNT(*) AS n FROM holds").get().n,
      reviewRequired: db.prepare("SELECT COUNT(*) AS n FROM holds").get().n,
      completed: 0,
      mode: "ai-authored-plans-with-structured-coordination",
      lastCycleAt: r.last ? new Date(r.last).toISOString() : null,
      autonomousResearch: false,
      payments: false,
    };
  }
  function validatePlans(plans) {
    need(Array.isArray(plans) && plans.length > 0 && plans.length <= 100);
    const ids = new Set();
    const validated = plans.map((p) => {
      need(ID.test(p?.projectId ?? "") && !ids.has(p.projectId));
      ids.add(p.projectId);
      const src = project(p.projectId);
      need(src, 404, "management_project_missing");
      need(
        src.status !== "review-required",
        409,
        "management_plan_requires_review",
      );
      return validatePlan(p, src);
    });
    return validated;
  }
  function writePlans(validated) {
    let accepted = 0,
      unchanged = 0;
    const update = db.prepare(
      "UPDATE projects SET plan=?,plan_digest=?,planned_at=?,cycle_at=?,revision=revision+1 WHERE id=?",
    );
    for (const p of validated) {
      const hash = digest(p);
      if (find.get(p.projectId).plan_digest === hash) {
        unchanged++;
        continue;
      }
      update.run(JSON.stringify(p), hash, now(), now(), p.projectId);
      accepted++;
    }
    return { accepted, unchanged };
  }
  function ingest(plans) {
    const validated = validatePlans(plans);
    return transaction(() => writePlans(validated));
  }
  function cycle() {
    return transaction(() => {
      const result = db
        .prepare("UPDATE projects SET cycle_at=? WHERE plan IS NOT NULL")
        .run(now());
      return {
        coordinated: Number(result.changes),
        at: new Date(now()).toISOString(),
        workCompleted: 0,
      };
    });
  }
  function replyFor(p, message) {
    const q = message.toLowerCase();
    const scope = `${p.id}: ${p.title}. Management is ${p.status}; source status is ${p.sourceStatus}. `;
    if (/smallest|starter|first contribution|partial|single[- ]source|one[- ]source|how much work/.test(q)) {
      if (!p.starterContribution) return scope + "A source-bound preparation plan is not available yet. I cannot invent acceptance criteria. This is record-based guidance, not a live conversational reviewer.";
      return scope + `Yes, you can submit a clearly marked partial note covering one primary source for ${p.starterContribution.taskId}: ${p.tasks[0].title}. Spend about 10–20 minutes. Include the exact source/version and hash, what it supports, its limits and what remains unchecked. You do not need to complete both full preparation tasks first. The note can enter limited review; it is not scientific acceptance or full task completion and earns no AI$ or Karma. An independent reviewer is not assigned yet. This is record-based guidance from the current project record.`;
    }
    if (/(when|turnaround|timeline|waiting|stuck|stall|who|reviewer|assign|next|update|status|follow[- ]?up).*(review|evidence|submission)|(?:review|evidence|submission).*(when|turnaround|timeline|next|waiting|stuck|stall|update|status|follow[- ]?up)/.test(q)) {
      const latest = p.evidence?.[0];
      return scope + "The coordinator owns review coordination; the independent reviewer is not assigned. There is no confirmed completion date. " + (latest ? `Your reference is ${latest.requestId}. ` : "Submit a limited note with its exact source if you have not already done so. ") + "Check this project record for updates, and ask for reviewer assignment after one day if nothing changes. Email and Slack notifications are not configured. Intake is not scientific acceptance, task completion or an AI$ payment. This is record-based guidance.";
    }
    if (/fund|budget|round|pay|earn|money|ai\$/.test(q))
      return (
        scope +
        "No funded payable task or spendable reward is established. I can prepare a funding recommendation; I cannot mint, approve my own round or settle a payment. Evidence review and native funding receipts are required."
      );
    if (/meeting|notes|access|permission|profile/.test(q))
      return (
        scope +
        "Meeting notes stay private until their owner grants access. Profile ownership must be proved with a signed request. AI management does not grant access to other accounts or private notes."
      );
    if (/evidence|review|alzheimer|cancer|longevity|result|novel/.test(q))
      return (
        scope +
        "Required evidence: " +
        p.evidenceNeeded.join("; ") +
        ". The separate review role has not independently accepted a scientific result. Suggested searches are planning queries, not completed searches."
      );
    return (
      scope +
      (p.tasks.length
        ? "Next preparation tasks: " +
          p.tasks
            .map(
              (t) =>
                `${t.title}. Acceptance: ${t.criteria} Expected effort: ${t.expectedEffort}.`,
            )
            .join(" ")
        : "A project-specific plan has not been generated yet.") +
      " Preparation is unpaid; scientific completion and AI$ earnings are not established. This reply uses the current project record, not a live general-purpose model."
    );
  }
  function chat(user, id, input) {
    need(ADDRESS.test(user?.address ?? ""), 401, "management_auth_required");
    exact(input, ["message", "requestId"]);
    const message = text(input.message, 1, 2000),
      requestId = text(input.requestId, 8, 96);
    need(/^[a-zA-Z0-9._-]+$/.test(requestId));
    const p = project(id, user);
    need(p, 404, "management_project_missing");
    return transaction(() => {
      const old = db
        .prepare("SELECT * FROM messages WHERE owner=? AND request_id=?")
        .get(user.address, requestId);
      if (old) {
        need(
          old.project_id === id && old.message === message,
          409,
          "management_request_conflict",
        );
        return { reply: old.reply, created: false, requestId };
      }
      need(
        db.prepare("SELECT COUNT(*) AS n FROM messages").get().n < 100000,
        503,
        "management_capacity",
      );
      need(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM messages WHERE owner=? AND created_at>?",
          )
          .get(user.address, now() - 60000).n < 12,
        429,
        "management_rate_limited",
      );
      const reply = replyFor(p, message);
      db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?)").run(
        user.address,
        id,
        requestId,
        message,
        reply,
        now(),
      );
      return { reply, created: true, requestId };
    });
  }
  function decorate(value) {
    if (!value || typeof value !== "object") return value;
    const add = (p) => {
      const m = project(p.id);
      return m
        ? {
            ...p,
            management: {
              status: m.status,
              phase: m.phase,
              manager: m.manager,
              updatedAt: m.updatedAt,
              taskCount: m.tasks.length,
              funding: m.funding,
            },
          }
        : p;
    };
    return value.project
      ? { ...value, project: add(value.project) }
      : Array.isArray(value.projects)
        ? { ...value, projects: value.projects.map(add), management: status() }
        : value;
  }
  function submitEvidence(user, id, input) {
    need(ADDRESS.test(user?.address ?? ""), 401, "management_auth_required");
    exact(input, ["requestId", "planDigest", "taskId", "summary", "evidence"]);
    const requestId = text(input.requestId, 8, 96);
    need(/^[a-zA-Z0-9._-]+$/.test(requestId));
    const p = project(id);
    need(p, 404, "management_project_missing");
    need(
      typeof input.planDigest === "string" &&
        /^[a-f0-9]{64}$/.test(input.planDigest),
    );
    const taskId = text(input.taskId, 8, 220),
      summary = text(input.summary, 40, 4000);
    need(
      Array.isArray(input.evidence) &&
        input.evidence.length >= 1 &&
        input.evidence.length <= 5,
    );
    const evidence = input.evidence.map((e) => {
      exact(e, ["url", "sha256"]);
      let url;
      try {
        url = new URL(text(e.url, 10, 1500));
      } catch {
        throw new ManagementError(400, "invalid_evidence_url");
      }
      need(
        url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.hash &&
          !url.search &&
          !isIP(url.hostname) &&
          url.hostname.includes(".") &&
          !/^(localhost|.*\.localhost|.*\.local)$/.test(url.hostname),
      );
      need(typeof e.sha256 === "string" && /^[a-f0-9]{64}$/.test(e.sha256));
      return { url: url.href, sha256: e.sha256 };
    });
    const payload = {
      requestId,
      planDigest: input.planDigest,
      taskId,
      summary,
      evidence,
    };
    return transaction(() => {
      const previous = db
        .prepare(
          "SELECT payload,project_id,created_at FROM evidence WHERE owner=? AND request_id=?",
        )
        .get(user.address, requestId);
      if (previous) {
        need(
          previous.project_id === id &&
            previous.payload === JSON.stringify(payload),
          409,
          "management_request_conflict",
        );
        return {
          requestId,
          created: false,
          status: "awaiting-independent-review",
          reviewWorkflow: reviewWorkflow(id, requestId, previous.created_at),
        };
      }
      need(
        p.modelPlanDigest === input.planDigest &&
          p.tasks.some((t) => t.id === taskId),
        409,
        "management_plan_changed",
      );
      need(
        db.prepare("SELECT COUNT(*) AS n FROM evidence").get().n < 100000,
        503,
        "management_capacity",
      );
      need(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM evidence WHERE owner=? AND created_at>?",
          )
          .get(user.address, now() - 60000).n < 6,
        429,
        "management_rate_limited",
      );
      db.prepare("INSERT INTO evidence VALUES(?,?,?,?,?)").run(
        user.address,
        id,
        requestId,
        JSON.stringify(payload),
        now(),
      );
      return {
        requestId,
        created: true,
        status: "awaiting-independent-review",
        reviewWorkflow: reviewWorkflow(id, requestId, now()),
      };
    });
  }
  function registerProject(row, revision) {
    need(
      ID.test(row?.id ?? "") &&
        typeof row.title === "string" &&
        row.title.length <= 1000 &&
        typeof revision === "string" &&
        revision.length <= 200,
    );
    const source = {
      id: row.id,
      title: row.title,
      description: String(row.description ?? "").slice(0, 2000),
      category: String(row.category ?? "").slice(0, 200),
      kpi: row.kpi ?? null,
      revision,
      sourceStatus: row.status ?? "unknown",
    };
    transaction(() =>
      insert.run(row.id, JSON.stringify(source), digest(source)),
    );
    return project(row.id);
  }
  function sourceStates() {
    const states = new Map(
      db
        .prepare("SELECT id,cycle_at FROM projects WHERE plan IS NOT NULL")
        .all()
        .map((r) => [r.id, r.cycle_at >= now() - DAY ? "active" : "stale"]),
    );
    for (const r of db.prepare("SELECT project_id FROM holds").all())
      states.set(r.project_id, "review-required");
    return states;
  }
  function validateHolds(ids) {
    need(
      Array.isArray(ids) &&
        ids.length <= 100 &&
        new Set(ids).size === ids.length &&
        ids.every((id) => ID.test(id) && find.get(id)),
    );
    return ids;
  }
  function writeHolds(ids) {
    for (const id of ids) {
      db.prepare("INSERT OR IGNORE INTO holds VALUES(?,?)").run(
        id,
        "model-review-required",
      );
      db.prepare(
        "UPDATE projects SET plan=NULL,plan_digest=NULL,planned_at=NULL,cycle_at=NULL WHERE id=?",
      ).run(id);
    }
    return { held: ids.length };
  }
  function holdProjects(ids) {
    validateHolds(ids);
    need(ids.length > 0);
    return transaction(() => writeHolds(ids));
  }
  function batchReceipt(sha256) {
    need(typeof sha256 === "string" && /^[a-f0-9]{64}$/.test(sha256));
    const row = db
      .prepare("SELECT receipt FROM batches WHERE sha256=?")
      .get(sha256);
    return row ? JSON.parse(row.receipt) : null;
  }
  function applyBatch(input, sha256) {
    const prior = batchReceipt(sha256);
    if (prior) return prior;
    const batch = Array.isArray(input)
      ? { schema: "baink-management-batch-v1", plans: input, heldProjects: [] }
      : input;
    exact(batch, ["schema", "plans", "heldProjects"]);
    need(
      batch.schema === "baink-management-batch-v1" &&
        Array.isArray(batch.plans) &&
        Array.isArray(batch.heldProjects) &&
        batch.plans.length + batch.heldProjects.length >= 1 &&
        batch.plans.length + batch.heldProjects.length <= 100,
    );
    const plans = batch.plans.length ? validatePlans(batch.plans) : [],
      held = validateHolds(batch.heldProjects);
    need(!plans.some((p) => held.includes(p.projectId)));
    return transaction(() => {
      const result = {
        sha256,
        ...writePlans(plans),
        ...writeHolds(held),
        at: new Date(now()).toISOString(),
      };
      db.prepare("INSERT INTO batches VALUES(?,?)").run(
        sha256,
        JSON.stringify(result),
      );
      return result;
    });
  }
  function invalidateSource(id) {
    const row = find.get(id);
    if (!row) return;
    const source = { ...JSON.parse(row.source), sourceUnavailable: true };
    transaction(() => {
      insert.run(id, JSON.stringify(source), digest(source));
    });
  }
  return {
    status,
    sourceStates,
    holdProjects,
    validatePlans,
    applyBatch,
    batchReceipt,
    invalidateSource,
    project,
    ingest,
    cycle,
    chat,
    submitEvidence,
    decorate,
    registerProject,
    close() {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
}

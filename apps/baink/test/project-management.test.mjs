import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectManagement } from "../server/project-management.mjs";
const rows = Array.from({ length: 55 }, (_, i) => ({
  id: `OPP-${String(i + 1).padStart(5, "0")}`,
  title: `Research unsolved energy problem ${i + 1}`,
  description: "Source target only",
  category: "Energy",
  status: "inactive",
  kpi: { statement: "Target" },
}));
const catalogue = {
  available: true,
  list: ({ page = 1, pageSize = 100 } = {}) => ({
    projects: rows.slice((page - 1) * pageSize, page * pageSize),
    total: rows.length,
    source: { revision: "a".repeat(40) },
  }),
  detail: (id) =>
    rows.find((x) => x.id === id)
      ? {
          project: rows.find((x) => x.id === id),
          source: { revision: "a".repeat(40) },
        }
      : null,
};
async function fixture(t) {
  const d = await mkdtemp(join(tmpdir(), "baink-management-"));
  t.after(() => rm(d, { recursive: true, force: true }));
  let clock = Date.parse("2026-11-04T08:00:00Z");
  const options = {
    path: join(d, "management.sqlite"),
    catalogue,
    enabled: true,
    now: () => clock,
  };
  const service = createProjectManagement(options);
  t.after(() => service.close());
  return { service, options, advance: (ms) => (clock += ms) };
}
const plan = (s, id = rows[0].id) => ({
  projectId: id,
  sourceDigest: s.project(id).sourceDigest,
  summary:
    "Investigate the reproducible evidence gap in the stated energy target before proposing a novel intervention.",
  tasks: [
    {
      title: "Map existing solutions and unresolved constraints",
      criteria:
        "Record dated primary-source searches, existing implementations and the precise unresolved gap.",
      expectedEffort: "30–60 minutes",
    },
    {
      title: "Design a falsifiable acceptance measurement",
      criteria:
        "Define the dataset, baseline, method and independent reviewer requirements without claiming completion.",
      expectedEffort: "1–2 hours",
    },
  ],
  evidenceNeeded: ["Dated primary sources and reproducible methods"],
  suggestedSearches: [
    "energy open implementation baseline",
    "energy unresolved reproducibility evidence",
  ],
});
test("all source proposals receive queued management, no invented active workers or money", async (t) => {
  const { service: s } = await fixture(t);
  assert.equal(s.status().total, 55);
  assert.equal(s.status().active, 0);
  const p = s.project(rows[0].id);
  assert.equal(p.status, "queued");
  assert.equal(p.funding.payable, false);
  assert.notEqual(p.manager.id, p.reviewer.id);
  assert.equal(p.sourceStatus, "inactive");
});
test("substantive source-bound plans activate management, expire truthfully and recover across restart", async (t) => {
  const f = await fixture(t),
    s = f.service;
  assert.equal(s.ingest([plan(s)]).accepted, 1);
  assert.equal(s.status().active, 1);
  assert.equal(s.project(rows[0].id).tasks.length, 2);
  assert.equal(s.ingest([plan(s)]).unchanged, 1);
  f.advance(25 * 60 * 60 * 1000);
  assert.equal(s.status().active, 0);
  assert.equal(s.project(rows[0].id).status, "stale");
  s.cycle();
  assert.equal(s.status().active, 1);
  s.close();
  const restored = createProjectManagement(f.options);
  assert.equal(restored.status().active, 1);
  restored.close();
});
test("invalid model output and stale source are rejected atomically", async (t) => {
  const { service: s } = await fixture(t);
  assert.throws(() => s.ingest([{ ...plan(s), sourceDigest: "b".repeat(64) }]));
  assert.throws(() => s.ingest([{ ...plan(s), tasks: [] }]));
  assert.throws(() => s.ingest([{ ...plan(s), fundingApproved: true }]));
  assert.equal(s.status().active, 0);
});
test("signed user chat is durable, idempotent, scoped and evidence aware", async (t) => {
  const { service: s } = await fixture(t);
  s.ingest([plan(s)]);
  const user = { address: "uain1" + "1".repeat(40) };
  const input = {
    message: "Can I earn and pay? Who reviews evidence?",
    requestId: "chat-request-0001",
  };
  const first = s.chat(user, rows[0].id, input);
  assert.match(first.reply, /fund|pay|AI\$/i);
  assert.equal(first.created, true);
  assert.equal(s.chat(user, rows[0].id, input).created, false);
  assert.throws(() =>
    s.chat(user, rows[0].id, { ...input, message: "different" }),
  );
  assert.equal(s.project(rows[0].id).messages.length, 0);
  assert.equal(s.project(rows[0].id, user).messages.length, 1);
  assert.equal(
    s.project(rows[0].id, { address: "uain1" + "2".repeat(40) }).messages
      .length,
    0,
  );
  assert.throws(() => s.chat({}, rows[0].id, input));
  assert.throws(() => s.chat(user, "OPP-99999", input));
});
test("native historical records retain distinct source status and invalidate stale plan bindings", async (t) => {
  const { service: s } = await fixture(t);
  s.registerProject(
    {
      id: "cancer-project",
      title: "Cancer historical evidence project",
      status: "in_progress",
    },
    "native-record-v1",
  );
  const p = plan(s, "cancer-project");
  assert.equal(s.project("cancer-project").sourceStatus, "in_progress");
  s.ingest([p]);
  s.registerProject(
    {
      id: "cancer-project",
      title: "Cancer historical evidence project revised",
      status: "in_progress",
    },
    "native-record-v1",
  );
  assert.equal(s.project("cancer-project").status, "queued");
  assert.throws(() => s.ingest([p]));
});
test("evidence intake binds the current task plan, keeps material private and does not self-accept science", async (t) => {
  const { service: s } = await fixture(t);
  s.ingest([plan(s)]);
  const p = s.project(rows[0].id),
    user = { address: "uain1" + "3".repeat(40) };
  const input = {
    requestId: "evidence-request-01",
    planDigest: p.modelPlanDigest,
    taskId: p.tasks[0].id,
    summary:
      "An original reproducibility package for independent inspection; no achieved outcome is asserted.",
    evidence: [
      { url: "https://example.org/reproducibility", sha256: "c".repeat(64) },
    ],
  };
  const r = s.submitEvidence(user, p.id, input);
  assert.equal(r.created, true);
  assert.equal(r.status, "awaiting-independent-review");
  assert.equal(s.submitEvidence(user, p.id, input).created, false);
  assert.equal(s.project(p.id).evidenceCount, 1);
  assert.equal(s.project(p.id).evidence.length, 0);
  assert.equal(s.project(p.id, user).evidence.length, 1);
  assert.throws(() =>
    s.submitEvidence(user, p.id, {
      ...input,
      requestId: "evidence-request-02",
      planDigest: "d".repeat(64),
    }),
  );
  assert.throws(() =>
    s.submitEvidence(user, p.id, {
      ...input,
      requestId: "evidence-request-03",
      evidence: [{ url: "http://127.0.0.1/private", sha256: "c".repeat(64) }],
    }),
  );
  assert.equal(s.project(p.id).review.status, "awaiting-independent-review");
  assert.equal(s.project(p.id).funding.payable, false);
});
test("withheld or review-only placeholders never qualify as active research plans", async (t) => {
  const { service: s } = await fixture(t);
  assert.throws(() =>
    s.ingest([
      {
        ...plan(s),
        summary:
          "No intake plan was generated: a safety classifier stopped generation. Human operator review is required before any plan is drafted.",
      },
    ]),
  );
  assert.equal(s.status().active, 0);
  s.holdProjects([rows[0].id]);
  assert.equal(s.project(rows[0].id).status, "review-required");
  assert.throws(() => s.ingest([plan(s)]));
  assert.equal(s.status().active, 0);
});
test("batch ingestion is atomic and yields a durable digest receipt, not just a copied-file receipt", async (t) => {
  const { service: s, options } = await fixture(t);
  const batch = {
      schema: "baink-management-batch-v1",
      plans: [plan(s)],
      heldProjects: [rows[1].id],
    },
    sha = "e".repeat(64);
  assert.equal(s.batchReceipt(sha), null);
  const invalid = {
    ...batch,
    plans: [{ ...plan(s), sourceDigest: "f".repeat(64) }],
  };
  assert.throws(() => s.applyBatch(invalid, sha));
  assert.equal(s.project(rows[1].id).status, "queued");
  assert.equal(s.batchReceipt(sha), null);
  assert.equal(s.validatePlans(batch.plans).length, 1);
  assert.equal(s.status().active, 0);
  const result = s.applyBatch(batch, sha);
  assert.equal(result.sha256, sha);
  assert.equal(result.accepted, 1);
  assert.equal(result.held, 1);
  assert.deepEqual(s.applyBatch(batch, sha), result);
  s.close();
  const restored = createProjectManagement(options);
  assert.deepEqual(restored.batchReceipt(sha), result);
  restored.close();
});
test('small partial contribution questions are answered before incidental funding words',async t=>{const{service:s}=await fixture(t);s.ingest([plan(s)]);const user={address:'uain1'+'4'.repeat(40)},p=s.project(rows[0].id);const r=s.chat(user,p.id,{requestId:'partial-scope-retest-01',message:'What is the smallest useful contribution I can submit today? Can a clearly marked single-source partial note be reviewed, or must both preparation tasks be completed first? I understand it is unpaid and awards neither AI$ nor Karma.'});assert.match(r.reply,/yes|can submit/i);assert.match(r.reply,/one primary|single.source/i);assert.match(r.reply,/10.?20 minutes/i);assert.match(r.reply,/partial|limited/i);assert.match(r.reply,/record.based|project record/i);assert.equal(p.starterContribution.taskId,p.tasks[0].id);assert.equal(p.starterContribution.payable,false);});
test('pending evidence exposes a truthful owner, unassigned reviewer and follow-up without promising acceptance',async t=>{const f=await fixture(t),s=f.service;s.ingest([plan(s)]);const user={address:'uain1'+'5'.repeat(40)},p=s.project(rows[0].id),input={requestId:'review-workflow-retest-01',planDigest:p.modelPlanDigest,taskId:p.tasks[0].id,summary:'One primary source checked for a limited preparation note; not a complete task or novel result.',evidence:[{url:'https://example.org/primary-source',sha256:'a'.repeat(64)}]};const result=s.submitEvidence(user,p.id,input);assert.equal(result.reviewWorkflow.reviewerAssigned,false);const saved=s.project(p.id,user).evidence[0];assert.equal(saved.reviewWorkflow.completionDate,null);assert.equal(saved.reviewWorkflow.intakeAccepted,true);assert.equal(saved.reviewWorkflow.followUpAvailable,false);f.advance(25*60*60*1000);assert.equal(s.project(p.id,user).evidence[0].reviewWorkflow.followUpAvailable,true);assert.equal(s.project(p.id).review.status,'awaiting-independent-review');assert.equal(s.project(p.id).evidence.length,0);const r=s.chat(user,p.id,{requestId:'review-nextstep-retest-01',message:'When will my submitted evidence be reviewed and what happens next?'});assert.match(r.reply,/not assigned|unassigned/i);assert.match(r.reply,/no confirmed.*date/i);assert.match(r.reply,new RegExp(input.requestId));});

test('the review-update action draft routes to the actual pending submission',async t=>{const{service:s}=await fixture(t);s.ingest([plan(s)]);const user={address:'uain1'+'6'.repeat(40)},p=s.project(rows[0].id);s.submitEvidence(user,p.id,{requestId:'review-update-request-01',planDigest:p.modelPlanDigest,taskId:p.tasks[0].id,summary:'A limited one-source note asking for scope review only, with no claim of completion.',evidence:[{url:'https://example.org/source',sha256:'a'.repeat(64)}]});const r=s.chat(user,p.id,{requestId:'review-update-chat-01',message:'Review update request for evidence review-update-request-01: who owns the next step?'});assert.match(r.reply,/review-update-request-01/);assert.match(r.reply,/not assigned/);assert.match(r.reply,/no confirmed completion date/i);});

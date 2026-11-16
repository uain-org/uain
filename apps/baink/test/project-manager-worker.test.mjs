import test from "node:test";
import assert from "node:assert/strict";
import {
  selectProjects,
  parseModelPlans,
  bindModelPlans,
} from "../ops/project-manager-worker.mjs";
test("selection covers domains first, caps the batch and resumes after completed IDs", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({
    id: `OPP-${i}`,
    domainId: String((i % 45) + 1),
  }));
  const chosen = selectProjects(rows, new Set(), 50);
  assert.equal(chosen.length, 50);
  assert.equal(new Set(chosen.slice(0, 45).map((x) => x.domainId)).size, 45);
  assert.equal(
    selectProjects(rows, new Set(chosen.map((x) => x.id)), 10).length,
    10,
  );
  assert.throws(() => selectProjects(rows, new Set(), 101));
});
test("source binding uses trusted context by exact ID rather than model-transcribed hashes", () => {
  const sources = [
    { projectId: "OPP-00001", sourceDigest: "a".repeat(64), title: "First target" },
    { projectId: "OPP-00002", sourceDigest: "b".repeat(64), title: "Second target" },
  ];
  const plans = [
    { projectId: "OPP-00002", sourceDigest: "transcription-error", summary: "Second target's plan" },
    { projectId: "OPP-00001", summary: "First target's plan" },
  ];
  const before = structuredClone(plans);
  const bound = bindModelPlans(plans, sources);
  assert.deepEqual(bound, [
    { projectId: "OPP-00002", sourceDigest: "b".repeat(64), summary: "Second target's plan" },
    { projectId: "OPP-00001", sourceDigest: "a".repeat(64), summary: "First target's plan" },
  ]);
  assert.deepEqual(plans, before);
});
test("source binding refuses foreign, duplicate, missing and malformed project identities", () => {
  const sources = [
    { projectId: "OPP-00001", sourceDigest: "a".repeat(64) },
    { projectId: "OPP-00002", sourceDigest: "b".repeat(64) },
  ];
  for (const plans of [
    [{ projectId: "OPP-00001" }, { projectId: "OPP-99999" }],
    [{ projectId: "OPP-00001" }, { projectId: "OPP-00001" }],
    [{ projectId: "OPP-00001" }],
    [{ projectId: "OPP-00001" }, null],
  ]) assert.throws(() => bindModelPlans(plans, sources), /model_project_mismatch/);
  const plans = sources.map(({projectId}) => ({projectId}));
  assert.throws(() => bindModelPlans(plans, [sources[0], sources[0]]), /invalid_model_sources/);
  assert.throws(() => bindModelPlans(plans, [sources[0], {...sources[1], sourceDigest: "bad"}]), /invalid_model_sources/);
});
test("parses bounded structured model output and refuses unrelated projects", () => {
  const plans = [{ projectId: "OPP-00001" }];
  assert.deepEqual(
    parseModelPlans(JSON.stringify({ result: JSON.stringify({ plans }) }), [
      "OPP-00001",
    ]),
    plans,
  );
  assert.throws(() =>
    parseModelPlans(JSON.stringify({ plans }), ["OPP-00002"]),
  );
  assert.throws(() => parseModelPlans("{}", ["OPP-00001"]));
});

test('worker CLI keeps legacy API arguments and explicit subscription mode requires named operator pins', async () => {
  const {parseWorkerArguments}=await import('../ops/project-manager-worker.mjs');
  assert.deepEqual(parseWorkerArguments(['/private/state','10','1,2']),{directory:'/private/state',limit:10,domainIds:['1','2'],usageSource:'api'});
  assert.deepEqual(parseWorkerArguments(['/private/state','--usage-source','subscription','--claude-executable','/private/claude','--claude-sha256','a'.repeat(64)]),{directory:'/private/state',limit:10,domainIds:null,usageSource:'subscription',claude:'/private/claude',executableSha256:'a'.repeat(64)});
  for(const args of [[],['/state','--unknown','x'],['/state','--usage-source'],['/state','--usage-source','api','--usage-source','subscription']])assert.throws(()=>parseWorkerArguments(args));
});

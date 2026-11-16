import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagementOutbox } from "../ops/management-outbox.mjs";
import { runCycle, publishBatch } from "../ops/project-manager-cycle.mjs";
import { worker } from "../ops/project-manager-worker.mjs";
import { createProjectManagement } from "../server/project-management.mjs";
import { loadCatalogue } from "../server/catalogue.mjs";

const batch = { schema: "baink-management-batch-v1", plans: [{ projectId: "OPP-00001" }], heldProjects: [] };
const receiptFor = (entry) => ({ sha256: entry.sha256, accepted: 1, unchanged: 0, held: 0, at: new Date().toISOString() });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "baink-outbox-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, outbox: await createManagementOutbox(directory) };
}
test("outbox survives restart before local ingest and replays exact persisted batch", async (t) => {
  const { directory, outbox } = await fixture(t);
  const entry = await outbox.enqueue(batch);
  assert.deepEqual(JSON.parse(await readFile(entry.path, "utf8")), batch);
  const restored = await createManagementOutbox(directory);
  const applied = [];
  await restored.recover({ applyBatch(value, sha) { applied.push({ value, sha }); } });
  assert.deepEqual(applied, [{ value: batch, sha: entry.sha256 }]);
  assert.equal((await restored.pending()).length, 1);
});
test("failed publication is retained and retried before any new generation", async (t) => {
  const { directory, outbox } = await fixture(t);
  const entry = await outbox.enqueue(batch);
  let generated = 0;
  const generate = async ({ recoverOnly }) => { if (!recoverOnly) generated++; return {}; };
  await assert.rejects(runCycle({ directory, generate, publish: async () => { throw Error("network_down"); }, onProgress() {} }), /network_down/);
  assert.equal(generated, 0);
  assert.equal((await outbox.pending())[0].sha256, entry.sha256);
  const attempts = [];
  await runCycle({ directory, generate, publish: async (value) => { attempts.push(value.sha256); return receiptFor(value); }, onProgress() {} });
  assert.deepEqual(attempts, [entry.sha256]);
  assert.equal(generated, 1);
  assert.equal((await outbox.pending()).length, 0);
});
test("missing, wrong hash and partial ingestion receipts cannot acknowledge a pending batch", async (t) => {
  const { outbox } = await fixture(t);
  const entry = await outbox.enqueue(batch);
  for (const receipt of [null, { ...receiptFor(entry), sha256: "a".repeat(64) }, { ...receiptFor(entry), accepted: 0 }]) {
    await assert.rejects(outbox.acknowledge(entry, receipt), /invalid_management_receipt/);
    assert.equal((await outbox.pending()).length, 1);
  }
});
test("cycle lock covers publication and prevents another generator", async (t) => {
  const { directory, outbox } = await fixture(t);
  await outbox.enqueue(batch);
  let release, entered;
  const waiting = new Promise((r) => { release = r; });
  const started = new Promise((r) => { entered = r; });
  const first = runCycle({ directory, generate: async () => ({}), publish: async (entry) => { entered(); await waiting; return receiptFor(entry); }, onProgress() {} });
  await started;
  try {
    await assert.rejects(runCycle({ directory, generate: async () => { throw Error("must_not_generate"); }, onProgress() {} }), /cycle_already_running/);
  } finally { release(); await first; }
});
test("publication waits for exact service receipt, not only installer success", async (t) => {
  const { outbox } = await fixture(t), entry = await outbox.enqueue(batch);
  const command = async () => ({ stdout: JSON.stringify({ sha256: entry.sha256 }) });
  await assert.rejects(publishBatch(entry, { command, fetchImpl: async () => ({ status: 404 }), attempts: 2, delayMs: 0 }), /management_ingestion_unconfirmed/);
  await assert.rejects(publishBatch(entry, { command, fetchImpl: async () => ({ status: 200, json: async () => ({ ...receiptFor(entry), sha256: "b".repeat(64) }) }), attempts: 1 }), /invalid_management_receipt/);
  let polls = 0;
  const receipt = await publishBatch(entry, { command, fetchImpl: async (url) => {
    assert.equal(url, `https://baink.money/api/management/batches/${entry.sha256}`);
    return ++polls === 1 ? { status: 404 } : { status: 200, json: async () => receiptFor(entry) };
  }, attempts: 2, delayMs: 0 });
  assert.equal(receipt.sha256, entry.sha256);
  assert.equal((await outbox.pending()).length, 1);
});
test("worker recovery replays queued bytes into actual SQLite without invoking a provider", async (t) => {
  const { directory, outbox } = await fixture(t);
  const catalogue = await loadCatalogue(new URL("../catalogue/", import.meta.url).pathname);
  const options = { path: join(directory, "management.sqlite"), catalogue, enabled: true };
  const initial = createProjectManagement(options);
  const source = initial.project("OPP-00001");
  const plan = {
    projectId: source.id, sourceDigest: source.sourceDigest,
    summary: "Check the original source evidence and establish a reproducible baseline before any research proposal is accepted.",
    tasks: [
      { title: "Identify original evidence sources", criteria: "List dated original sources, reproducibility constraints and unresolved questions with attributable evidence.", expectedEffort: "30 minutes" },
      { title: "Define baseline measurement criteria", criteria: "Record a falsifiable baseline and repeatable measurement method without claiming an achieved research result.", expectedEffort: "30 minutes" },
    ], evidenceNeeded: ["Dated original evidence sources"], suggestedSearches: ["Original primary evidence sources", "Baseline reproducibility measurement method"],
  };
  initial.validatePlans([plan]);
  const entry = await outbox.enqueue({ schema: "baink-management-batch-v1", plans: [plan], heldProjects: ["OPP-00002"] });
  assert.equal(initial.project(source.id).status, "queued");
  initial.close();
  const result = await worker({ directory, recoverOnly: true, claude: "/must-not-run-provider", onProgress() {} });
  assert.equal(result.status.active, 1);
  const restored = createProjectManagement(options);
  try {
    assert.equal(restored.project("OPP-00002").status, "review-required");
    assert.equal(restored.batchReceipt(entry.sha256).accepted, 1);
    assert.equal((await outbox.pending()).length, 1);
  } finally { restored.close(); }
});

test('cycle forwards explicit subscription pin only to the worker and keeps default API admission',async t=>{
 const {directory}=await fixture(t);const calls=[];
 const generate=async o=>{calls.push(o);return{generated:0};};
 await runCycle({directory,generate,publish:()=>{throw Error('no pending publication');},onProgress(){},usageSource:'subscription',claude:'/private/pinned-claude',executableSha256:'a'.repeat(64)});
 assert.equal(calls.length,2);for(const c of calls){assert.equal(c.usageSource,'subscription');assert.equal(c.claude,'/private/pinned-claude');assert.equal(c.executableSha256,'a'.repeat(64));assert.equal(c.limit,10);}assert.equal(calls[0].recoverOnly,true);
 calls.length=0;await runCycle({directory,generate,onProgress(){}});assert.equal(calls[1].usageSource,'api');assert.equal(calls[1].claude,(await import('node:path')).join((await import('node:os')).homedir(),'.local/bin/claude'));
});

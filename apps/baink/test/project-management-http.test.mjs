import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBainkServer } from "../server/app.mjs";
test("management exposes source-bound public plans and requires signed account for chat", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "baink-management-http-"));
  const app = await createBainkServer({
    dataDir,
    projectsSource: null,
    managementEnabled: true,
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let r = await fetch(base + "/api/management/status");
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.total, 21600);
  r = await fetch(base + "/api/management/projects/OPP-00001");
  assert.equal(r.status, 200);
  assert.match((await r.json()).sourceDigest, /^[a-f0-9]{64}$/);
  r = await fetch(base + "/api/management/projects/OPP-00001/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: "Next task?",
      requestId: "test-request-01",
    }),
  });
  assert.equal(r.status, 401);
  r = await fetch(base + "/api/proposals/OPP-00001");
  assert.equal((await r.json()).project.management.status, "queued");
  r = await fetch(base + "/api/management/projects/OPP-99999");
  assert.equal(r.status, 404);
});
import { fixture, member } from "./http-fixture.mjs";
test("management chat authenticates actual HTTP signatures, rejects cross-user history and preserves retries", async (t) => {
  const f = await fixture(t, {
    managementEnabled: true,
    catalogueDir: new URL("../catalogue/", import.meta.url).pathname,
  });
  const alice = member(),
    bob = member();
  await f.request(alice, "POST", "/api/account", { displayName: "Manager QA" });
  await f.request(bob, "POST", "/api/account", { displayName: "Other QA" });
  const path = "/api/management/projects/OPP-00001/chat",
    body = {
      message: "What evidence and funding do I need?",
      requestId: "management-http-01",
    };
  let r = await f.request(alice, "POST", path, body);
  assert.equal(r.status, 201);
  const reply = r.body.reply;
  r = await f.request(alice, "POST", path, body);
  assert.equal(r.status, 200);
  assert.equal(r.body.reply, reply);
  r = await f.request(alice, "POST", path, {
    ...body,
    message: "Conflicting replay",
  });
  assert.equal(r.status, 409);
  r = await f.request(bob, "POST", path, body);
  assert.equal(r.status, 201);
  r = await f.request(null, "GET", "/api/management/projects/OPP-00001");
  assert.deepEqual(r.body.messages, []);
  await f.restart();
  r = await f.request(alice, "POST", path, body);
  assert.equal(r.status, 200);
  assert.equal(r.body.reply, reply);
});
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
test("registered native source refreshes through HTTP and deleted or unavailable sources fail closed", async (t) => {
  let rows = [
      {
        id: "native-review-project",
        title: "Original native title",
        status: "in_progress",
      },
    ],
    outage = false;
  const source = createServer((req, res) => {
    res.writeHead(outage ? 503 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ projects: rows }));
  });
  await new Promise((r) => source.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => source.close(r)));
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const f = await fixture(t, {
    managementEnabled: true,
    catalogueDir: new URL("../catalogue/", import.meta.url).pathname,
    projectsSource: `http://127.0.0.1:${source.address().port}/api/projects`,
  });
  const path = "/api/management/projects/native-review-project";
  let r = await f.request(null, "GET", path);
  assert.equal(r.status, 200);
  const digest = r.body.sourceDigest;
  rows[0].title = "Revised native title";
  clock += 61000;
  r = await f.request(null, "GET", path);
  assert.equal(r.body.title, "Revised native title");
  assert.notEqual(r.body.sourceDigest, digest);
  rows = [];
  clock += 61000;
  r = await f.request(null, "GET", path);
  assert.equal(r.status, 404);
  outage = true;
  clock += 61000;
  r = await f.request(null, "GET", path);
  assert.equal(r.status, 503);
});
test("HTTP batch receipt appears only after atomic successful ingestion and survives restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "baink-management-batch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const batchFile = join(dir, "plans.json"),
    f = await fixture(t, {
      managementEnabled: true,
      managementPlansFile: batchFile,
      catalogueDir: new URL("../catalogue/", import.meta.url).pathname,
    });
  const source = (
    await f.request(null, "GET", "/api/management/projects/OPP-00002")
  ).body;
  const batch = {
    schema: "baink-management-batch-v1",
    plans: [
      {
        projectId: source.id,
        sourceDigest: source.sourceDigest,
        summary:
          "Review project-specific original evidence and reproducible prior art before independent novelty acceptance.",
        tasks: [
          {
            title: "Recover original evidence package",
            criteria:
              "Record original dated source files and checksums, and list missing material separately without claiming a result.",
            expectedEffort: "30 minutes",
          },
          {
            title: "Map the unresolved reproducibility gap",
            criteria:
              "Compare primary-source implementations and define a falsifiable unresolved question with independent review criteria.",
            expectedEffort: "1 hour",
          },
        ],
        evidenceNeeded: ["Original dated source package"],
        suggestedSearches: [
          "original primary source reproducibility",
          "open implementation unresolved baseline",
        ],
      },
    ],
    heldProjects: ["OPP-00003"],
  };
  const raw = JSON.stringify(batch),
    sha = createHash("sha256").update(raw).digest("hex");
  assert.equal(
    (await f.request(null, "GET", `/api/management/batches/${sha}`)).status,
    404,
  );
  await writeFile(batchFile, raw);
  await f.restart();
  let r = await f.request(null, "GET", `/api/management/batches/${sha}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.accepted, 1);
  assert.equal(r.body.held, 1);
  assert.equal(r.body.sha256, sha);
  const invalid = JSON.stringify({
      ...batch,
      plans: [{ ...batch.plans[0], sourceDigest: "f".repeat(64) }],
      heldProjects: ["OPP-00004"],
    }),
    badSha = createHash("sha256").update(invalid).digest("hex");
  await writeFile(batchFile, invalid);
  await f.restart();
  assert.equal(
    (await f.request(null, "GET", `/api/management/batches/${badSha}`)).status,
    404,
  );
  assert.equal(
    (await f.request(null, "GET", "/api/management/projects/OPP-00004")).body
      .status,
    "queued",
  );
  assert.equal(
    (await f.request(null, "GET", `/api/management/batches/${sha}`)).status,
    200,
  );
});
test('all initial task pages and readiness remain truthful and bounded over HTTP',async(t)=>{const f=await fixture(t,{managementEnabled:true,catalogueDir:new URL('../catalogue/',import.meta.url).pathname});let r=await f.request(null,'GET','/api/management/initial-tasks/summary');assert.equal(r.status,200);assert.equal(r.body.drafts,43200);assert.equal(r.body.payable,0);r=await f.request(null,'GET','/api/management/initial-tasks?page=216&pageSize=100');assert.equal(r.status,200);assert.equal(r.body.projects.length,100);assert.equal(r.body.projects[0].tasks[0].reviewAuthority,'UAIN');assert.equal((await f.request(null,'GET','/api/management/initial-tasks?page=0')).status,400);assert.equal((await f.request(null,'GET','/api/management/initial-tasks?approved=true')).status,400);});

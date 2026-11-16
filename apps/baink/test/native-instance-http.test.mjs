import test from "node:test";
import assert from "node:assert/strict";
import { fixture, member } from "./http-fixture.mjs";
test("browser instance setup routes require signed account control, expose only own journal and preserve the disabled submit gate", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.request(null, "GET", "/api/native/instances")).status,
    401,
  );
  assert.equal(
    (
      await f.request(null, "POST", "/api/native/instances/prepare", {
        clientRequestId: "instance-http-1",
        id: "owned-one",
        name: "Owned instance",
        family: "QA",
      })
    ).status,
    401,
  );
  const owner = member();
  await f.request(owner, "POST", "/api/account", {
    displayName: "Instance QA",
  });
  let r = await f.request(owner, "GET", "/api/native/instances");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { intents: [] });
  r = await f.request(owner, "GET", "/api/native/instances?owner=uain1other");
  assert.equal(r.status, 400);
  r = await f.request(null, "GET", "/api/config");
  assert.equal(r.body.nativeRegistration.instance.enabled, false);
  assert.equal(r.body.nativeRegistration.instance.startsWorker, false);
  assert.equal(r.body.nativeRegistration.instance.installationVerified, false);
  r = await f.request(
    owner,
    "POST",
    "/api/native/instances/00000000-0000-4000-8000-000000000000/submit",
    { envelope: {} },
  );
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, "native_instance_disabled");
});

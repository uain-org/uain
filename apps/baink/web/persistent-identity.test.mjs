import test from "node:test";
import assert from "node:assert/strict";
import { createIdentity } from "./identity.js";
import { createIdentitySession } from "./persistent-identity.js";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function explicitSignIn(context) {
  const source = readFileSync(new URL("./main.jsx", import.meta.url), "utf8");
  const start = source.indexOf("onReady={async (id, name, isNew, token) => {");
  assert.notEqual(start, -1, "explicit sign-in must await device-key cleanup");
  const end = source.indexOf("\n          }}", start);
  return runInNewContext(`(${source.slice(start + "onReady={".length, end)}\n})`, context);
}

test("explicit sign-in fails closed when an earlier kept key cannot be deleted", async () => {
  const events = [];
  const signIn = explicitSignIn({
    restoreTicket: { current: 0 },
    entryLoader: { current: { invalidate: () => events.push("invalidate") } },
    deviceSession: { current: { clear: async () => { throw Error("blocked"); } } },
    setPersistedFor: () => events.push("memory-only"),
    ready: async () => events.push("ready"),
  });
  await assert.rejects(signIn({}, "", false, { isCurrent: () => true }), /could not remove.*kept device key/i);
  assert.deepEqual(events, ["invalidate"]);
});

test("explicit sign-in waits for deletion and cannot publish after modal dismissal", async () => {
  const events = [];
  let release, current = true;
  const deletion = new Promise((resolve) => { release = resolve; });
  const signIn = explicitSignIn({
    restoreTicket: { current: 0 },
    entryLoader: { current: { invalidate: () => events.push("invalidate") } },
    deviceSession: { current: { clear: () => deletion } },
    setPersistedFor: () => events.push("memory-only"),
    ready: async () => events.push("ready"),
  });
  const opening = signIn({}, "", false, { isCurrent: () => current });
  assert.deepEqual(events, ["invalidate"]);
  current = false;
  release();
  await opening;
  assert.deepEqual(events, ["invalidate"]);
  current = true;
  await signIn({}, "", false, { isCurrent: () => current });
  assert.deepEqual(events, ["invalidate", "invalidate", "memory-only", "ready"]);
});

test("restore keeps the landing page hidden until account bootstrap settles", async () => {
  const source = readFileSync(new URL("./main.jsx", import.meta.url), "utf8");
  const start = source.indexOf("    if (!restoring) return;");
  const end = source.indexOf("\n  }, []);\n  const keepDeviceSignedIn", start);
  assert.ok(start > 0 && end > start);
  const events = [];
  let release;
  const bootstrap = new Promise((resolve) => { release = resolve; });
  const context = {
    restoring: true,
    restoreTicket: { current: 0 },
    deviceSession: { current: { load: async () => ({ address: "kept" }) } },
    setRestoring: (value) => events.push(["restoring", value]),
    setPersistedFor: () => events.push(["kept"]),
    ready: () => bootstrap,
    setToast: () => events.push(["error"]),
  };
  runInNewContext(`(function () {${source.slice(start, end)}\n})()`, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [["kept"]]);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [["kept"], ["restoring", false]]);
});
function memory() {
  let value;
  return {
    read: async () => value,
    write: async (v) => {
      value = structuredClone(v);
    },
    clear: async () => {
      value = undefined;
    },
  };
}
test("only an explicit choice persists a nonextractable local signing key", async () => {
  const storage = memory(),
    vault = createIdentitySession({ storage }),
    id = await createIdentity();
  await assert.rejects(vault.save(id, { consent: false }));
  await vault.save(id, { consent: true });
  const raw = await storage.read();
  assert.equal(raw.privateKey.extractable, false);
  assert.equal(raw.privateKey.type, "private");
  assert.equal(raw.private_key, undefined);
  const restored = await vault.load();
  assert.equal(restored.address, id.address);
  await assert.rejects(crypto.subtle.exportKey("jwk", restored.privateKey));
  const msg = new TextEncoder().encode("ownership");
  assert.equal(
    await crypto.subtle.verify(
      "Ed25519",
      restored.publicKey,
      await crypto.subtle.sign("Ed25519", restored.privateKey, msg),
      msg,
    ),
    true,
  );
  await vault.clear();
  assert.equal(await vault.load(), null);
});
test("expired, substituted or malformed saved identities are cleared instead of resumed", async () => {
  const storage = memory();
  let clock = 100;
  const vault = createIdentitySession({ storage, now: () => clock }),
    id = await createIdentity();
  await vault.save(id, { consent: true });
  clock += 8 * 86400000;
  assert.equal(await vault.load(), null);
  clock = 100;
  await vault.save(id, { consent: true });
  const raw = await storage.read();
  raw.address = "uain1" + "a".repeat(40);
  await storage.write(raw);
  assert.equal(await vault.load(), null);
  assert.equal(await storage.read(), undefined);
});
test("an invalid old restore cannot erase a newer saved identity", async () => {
  let release;
  let value;
  let reads = 0;
  const blocked = new Promise((r) => {
    release = r;
  });
  const storage = {
    read: async () => {
      reads++;
      if (reads === 1) {
        await blocked;
        return { version: 0 };
      }
      return value;
    },
    write: async (v) => {
      value = structuredClone(v);
    },
    clear: async () => {
      value = undefined;
    },
  };
  const vault = createIdentitySession({ storage }),
    id = await createIdentity();
  const loading = vault.load();
  await new Promise((r) => setTimeout(r, 0));
  await vault.save(id, { consent: true });
  release();
  assert.equal(await loading, null);
  assert.equal((await vault.load()).address, id.address);
});
test("a transient storage read error keeps the only kept device key", async () => {
  const inner = memory();
  let failNext = true, clears = 0;
  const storage = {
    read: async () => {
      if (failNext) { failNext = false; throw Object.assign(Error("blocked"), { name: "UnknownError" }); }
      return inner.read();
    },
    write: (v) => inner.write(v),
    clear: async () => { clears++; return inner.clear(); },
  };
  const vault = createIdentitySession({ storage }), id = await createIdentity();
  await vault.save(id, { consent: true });
  assert.equal(await vault.load(), null, "a failed read restores nothing this time");
  assert.equal(clears, 0, "a transient read error must not delete the key");
  assert.equal((await vault.load()).address, id.address, "the next restore still works");
});
test("a transient WebCrypto failure keeps the kept device key", async () => {
  const storage = memory(), vault = createIdentitySession({ storage }), id = await createIdentity();
  await vault.save(id, { consent: true });
  const original = crypto.subtle.digest;
  crypto.subtle.digest = async () => { throw Error("OperationError"); };
  try { assert.equal(await vault.load(), null); }
  finally { crypto.subtle.digest = original; }
  assert.ok(await storage.read(), "the record survives a crypto failure");
  assert.equal((await vault.load()).address, id.address);
});

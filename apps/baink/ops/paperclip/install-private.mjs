import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { renderCompose, preflight } from "./pilot.mjs";
import {
  buildLoopbackRelayPlan,
  validateStoppedRuntimeIsolation,
} from "./loopback-relay.mjs";
const HOME = "/var/lib/baink-paperclip",
  PRIVATE = HOME + "/private",
  DATA = HOME + "/data",
  SCRIPTS = "/opt/baink-paperclip/ops/paperclip",
  INPUT = "/opt/baink-paperclip/admission";
const NAME = "baink-paperclip-pilot",
  NETWORK = "baink-paperclip-pilot",
  REV = "dce383c733bb1ca31cd34d7dbb82bda597ad7418";
const assert = (x) => {
  if (!x) throw Error("private_runtime_operation_rejected");
};
assert(process.getuid?.() === 0 && fs.existsSync("/opt/baink/current"));
const action = process.argv[2];
assert(
  ["start", "close-signup", "refresh-relay", "stop", "guard-start"].includes(
    action,
  ),
);
const json = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const run = (bin, args) =>
  execFileSync(bin, args, {
    encoding: "utf8",
    timeout: 120000,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 2 * 1024 * 1024,
  });
const docker = (...args) => run("/usr/bin/docker", args);
function atomic(p, data, uid = 0, gid = 0) {
  const t = p + "." + randomUUID() + ".tmp";
  const f = fs.openSync(t, "wx", 0o600);
  try {
    fs.writeFileSync(f, data);
    fs.fsyncSync(f);
    fs.fchownSync(f, uid, gid);
  } finally {
    fs.closeSync(f);
  }
  fs.renameSync(t, p);
  const dir = fs.openSync(path.dirname(p), "r");
  try {
    fs.fsyncSync(dir);
  } finally {
    fs.closeSync(dir);
  }
}
function writeJson(p, x, uid = 0, gid = 0) {
  atomic(p, JSON.stringify(x, null, 2) + "\n", uid, gid);
}
function inspect(kind, name) {
  try {
    return JSON.parse(docker(kind, "inspect", name))[0];
  } catch {
    return null;
  }
}
function rootDirectory(p, privateMode = false) {
  const s = fs.lstatSync(p);
  assert(
    s.isDirectory() &&
      !s.isSymbolicLink() &&
      s.uid === 0 &&
      (s.mode & 0o022) === 0 &&
      (!privateMode || (s.mode & 0o777) === 0o700),
  );
}
for (const p of [
  "/",
  "/var",
  "/var/lib",
  "/opt",
  "/opt/baink-paperclip",
  "/opt/baink-paperclip/ops",
  SCRIPTS,
  INPUT,
])
  rootDirectory(p);
for (const p of [HOME, PRIVATE]) if (fs.existsSync(p)) rootDirectory(p);
// Read-only systemd pre-start guard deliberately precedes the mutation lock:
// installer start waits on systemd, so taking the same lock would deadlock.
if (action === "guard-start") {
  try {
    for (const p of [HOME, PRIVATE]) rootDirectory(p, true);
    const state = json(PRIVATE + "/runtime.json"),
      manifest = json(SCRIPTS + "/runtime-manifest.json"),
      receipt = json(INPUT + "/target-image-receipt.json");
    assert(
      state.schema === "baink-paperclip/private-runtime/v1" &&
        state.sourceRevision === REV &&
        [
          "container-created",
          "running",
          "stopped",
          "signup-closed-awaiting-api-verification",
        ].includes(state.phase),
    );
    const pf = preflight({
      manifest,
      resources: json(INPUT + "/resources.json"),
      imageReceipt: receipt,
      imageEquivalence: json(INPUT + "/image-equivalence.json"),
    });
    assert(
      pf.checks
        .filter((c) => c.id !== "fresh_pilot_data_directory")
        .every((c) => c.passed),
    );
    const c = inspect("container", state.containerId),
      n = inspect("network", state.networkId);
    assert(
      c &&
        c.Id === state.containerId &&
        c.Image === state.imageId &&
        c.Image === receipt.image &&
        c.Config.Labels?.["baink.intent"] === state.intent &&
        !c.State.Running,
    );
    assert(
      n &&
        n.Id === state.networkId &&
        n.Internal === true &&
        n.Labels?.["baink.intent"] === state.intent,
    );
    validateStoppedRuntimeIsolation({
      expectedContainerId: state.containerId,
      expectedImageId: state.imageId,
      expectedNetworkId: state.networkId,
      expectedNetworkName: NETWORK,
      expectedDataDirectory: DATA,
      containerInspect: c,
      networkInspect: n,
    });
    for (const p of [HOME, PRIVATE, DATA])
      assert(
        !fs.lstatSync(p).isSymbolicLink() && fs.lstatSync(p).isDirectory(),
      );
    const d = fs.statSync(DATA);
    assert(d.uid === 1000 && (d.mode & 0o777) === 0o700);
    const mem = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(
      fs.readFileSync("/proc/meminfo", "utf8"),
    );
    assert(
      mem &&
        Number(mem[1]) / 1024 >= manifest.preflight.minimumAvailableMemoryMiB,
    );
    assert(
      (fs.statfsSync("/").bavail * fs.statfsSync("/").bsize) / 1048576 >=
        manifest.preflight.minimumRootFreeMiB,
    );
    assert(
      (fs.statfsSync(DATA).bavail * fs.statfsSync(DATA).bsize) / 1048576 >=
        manifest.preflight.minimumDataFreeMiB,
    );
    assert(run("/usr/bin/ss", ["-H", "-ltn", "sport = :3101"]).trim() === "");
    console.log(
      JSON.stringify({
        phase: "owned-runtime-start-admitted",
        admissionEvidenceFresh: true,
      }),
    );
    process.exit(0);
  } catch {
    console.error(
      JSON.stringify({
        error: "private_runtime_start_guard_rejected",
        reconciliationRequired: true,
      }),
    );
    process.exit(1);
  }
}
for (const p of ["/var", "/var/lib", HOME, PRIVATE, DATA]) {
  if (fs.existsSync(p)) assert(!fs.lstatSync(p).isSymbolicLink());
}
fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
fs.chmodSync(HOME, 0o700);
rootDirectory(HOME, true);
fs.mkdirSync(PRIVATE, { recursive: true, mode: 0o700 });
fs.chmodSync(PRIVATE, 0o700);
rootDirectory(PRIVATE, true);
const lock = PRIVATE + "/install.lock";
assert(!fs.existsSync(lock));
fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
let state = null;
try {
  state = fs.existsSync(PRIVATE + "/runtime.json")
    ? json(PRIVATE + "/runtime.json")
    : null;
  const manifest = json(SCRIPTS + "/runtime-manifest.json"),
    receipt = json(INPUT + "/target-image-receipt.json");
  assert(manifest.sourceRevision === REV && receipt.sourceRevision === REV);
  const plan = renderCompose(manifest, receipt),
    service = plan.services.paperclip;
  const save = () => writeJson(PRIVATE + "/runtime.json", state);
  function ownedContainer() {
    const c = inspect("container", NAME);
    assert(
      c &&
        state &&
        c.Id === state.containerId &&
        c.Image === state.imageId &&
        c.Config.Labels?.["baink.intent"] === state.intent,
    );
    return c;
  }
  function createContainer() {
    const existing = inspect("container", NAME);
    assert(!existing);
    const id = docker(
      "create",
      "--name",
      NAME,
      "--platform",
      "linux/amd64",
      "--label",
      "baink.scope=private-paperclip-pilot",
      "--label",
      "baink.intent=" + state.intent,
      "--network",
      NETWORK,
      "--cpus",
      "1",
      "--memory",
      "2048m",
      "--memory-swap",
      "2048m",
      "--pids-limit",
      "256",
      "--stop-timeout",
      "90",
      "--security-opt",
      "no-new-privileges:true",
      "--restart",
      "no",
      "--log-driver",
      "json-file",
      "--log-opt",
      "max-size=10m",
      "--log-opt",
      "max-file=2",
      "--env-file",
      PRIVATE + "/runtime.env",
      "--mount",
      "type=bind,source=" + DATA + ",target=/paperclip",
      state.imageId,
    ).trim();
    assert(/^[a-f0-9]{64}$/.test(id));
    state.containerId = id;
    state.phase = "container-created";
    save();
  }
  function writeUnits() {
    const marker = "# Managed BAINK private Paperclip " + REV;
    const p = "/etc/systemd/system/baink-paperclip.service";
    if (fs.existsSync(p)) assert(fs.readFileSync(p, "utf8").includes(marker));
    atomic(
      p,
      marker +
        "\n[Unit]\nDescription=BAINK private zero-agent Paperclip control plane\nRequires=docker.service\nAfter=docker.service\n\n[Service]\nType=simple\nExecStartPre=/usr/bin/node " +
        SCRIPTS +
        "/install-private.mjs guard-start\nExecStart=/usr/bin/docker start --attach " +
        state.containerId +
        "\nExecStop=/usr/bin/docker stop --time 90 " +
        state.containerId +
        "\nRestart=no\nKillMode=process\nTimeoutStartSec=120\nTimeoutStopSec=100\nStandardOutput=null\nStandardError=null\n\n[Install]\nWantedBy=multi-user.target\n",
    );
    fs.chmodSync(p, 0o644);
  }
  function renderRelay() {
    const c = ownedContainer(),
      n = inspect("network", NETWORK);
    assert(n && n.Id === state.networkId);
    const relay = buildLoopbackRelayPlan({
      expectedContainerId: state.containerId,
      expectedImageId: state.imageId,
      containerInspect: c,
      networkInspect: n,
      expectedDataDirectory: DATA,
    });
    atomic(PRIVATE + "/relay.py", relay.pythonSource);
    writeJson(PRIVATE + "/relay-plan.json", {
      ...relay,
      pythonSource: undefined,
    });
    const unit = "/etc/systemd/system/baink-paperclip-relay.service",
      marker = "# Managed BAINK private relay " + REV;
    if (fs.existsSync(unit))
      assert(fs.readFileSync(unit, "utf8").includes(marker));
    const props = Object.entries(relay.systemdProperties)
      .map(([k, v]) => k + "=" + v)
      .join("\n");
    atomic(
      unit,
      marker +
        "\n[Unit]\nDescription=BAINK inspected loopback-only Paperclip relay\nRequires=baink-paperclip.service\nAfter=baink-paperclip.service\n\n[Service]\nType=simple\nExecStart=/usr/bin/python3 " +
        PRIVATE +
        "/relay.py\nRestart=no\n" +
        props +
        "\nStandardOutput=null\nStandardError=null\n\n[Install]\nWantedBy=multi-user.target\n",
    );
    fs.chmodSync(unit, 0o644);
    state.relayPins = relay.target;
    save();
  }
  async function healthy() {
    for (let i = 0; i < 90; i++) {
      try {
        const r = await fetch("http://127.0.0.1:3101/api/health", {
          redirect: "error",
          signal: AbortSignal.timeout(2000),
        });
        const h = await r.json();
        if (
          r.ok &&
          h.status === "ok" &&
          h.commit === REV &&
          h.deploymentMode === "authenticated" &&
          h.deploymentExposure === "private"
        )
          return {
            status: h.status,
            commit: h.commit,
            mode: h.deploymentMode,
            exposure: h.deploymentExposure,
            bootstrap: h.bootstrapStatus,
          };
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw Error("private_runtime_health_unavailable");
  }
  if (action === "start") {
    assert(
      state === null &&
        !inspect("container", NAME) &&
        !inspect("network", NETWORK),
    );
    const pf = preflight({
      manifest,
      resources: json(INPUT + "/resources.json"),
      imageReceipt: receipt,
      imageEquivalence: json(INPUT + "/image-equivalence.json"),
    });
    assert(pf.ready);
    assert(!fs.existsSync(DATA) || fs.readdirSync(DATA).length === 0);
    const image = inspect("image", receipt.image);
    assert(
      image &&
        image.Id === receipt.image &&
        image.Os === "linux" &&
        image.Architecture === "amd64",
    );
    fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
    fs.chmodSync(DATA, 0o700);
    fs.chownSync(DATA, 1000, 1000);
    const instance = DATA + "/instances/default";
    fs.mkdirSync(instance, { recursive: true, mode: 0o700 });
    fs.chownSync(DATA + "/instances", 1000, 1000);
    fs.chownSync(instance, 1000, 1000);
    const config = structuredClone(plan["x-baink-config"].content);
    config.$meta.updatedAt = new Date().toISOString();
    writeJson(instance + "/config.json", config, 1000, 1000);
    const secrets = {
      schema: "baink-paperclip/runtime-secrets/v1",
      session: randomBytes(48).toString("base64url"),
      action: randomBytes(48).toString("base64url"),
    };
    writeJson(PRIVATE + "/runtime-secrets.json", secrets);
    const env = {
      ...service.environment,
      BETTER_AUTH_SECRET: secrets.session,
      PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: secrets.action,
    };
    assert(
      Object.values(env).every(
        (x) => typeof x === "string" && !/[\r\n\0]/.test(x),
      ),
    );
    atomic(
      PRIVATE + "/runtime.env",
      Object.entries(env)
        .map(([k, v]) => k + "=" + v)
        .join("\n") + "\n",
    );
    state = {
      schema: "baink-paperclip/private-runtime/v1",
      intent: randomUUID(),
      sourceRevision: REV,
      imageId: receipt.image,
      phase: "prepared",
      createdAt: new Date().toISOString(),
    };
    save();
    const networkId = docker(
      "network",
      "create",
      "--driver",
      "bridge",
      "--internal",
      "--label",
      "baink.scope=private-paperclip-pilot",
      "--label",
      "baink.intent=" + state.intent,
      NETWORK,
    ).trim();
    assert(/^[a-f0-9]{64}$/.test(networkId));
    state.networkId = networkId;
    save();
    createContainer();
    writeUnits();
    run("/usr/bin/systemctl", ["daemon-reload"]);
    run("/usr/bin/systemctl", ["start", "baink-paperclip.service"]);
    for (let i = 0; i < 30 && !inspect("container", NAME)?.State?.Running; i++)
      await new Promise((r) => setTimeout(r, 300));
    renderRelay();
    run("/usr/bin/systemctl", ["daemon-reload"]);
    run("/usr/bin/systemctl", ["start", "baink-paperclip-relay.service"]);
    const h = await healthy();
    state.phase = "running";
    save();
    console.log(
      JSON.stringify({
        phase: "private-runtime-ready",
        health: h,
        executionConfigured: false,
        productionBainkConnected: false,
      }),
    );
  } else if (action === "close-signup") {
    ownedContainer();
    run("/usr/bin/systemctl", ["stop", "baink-paperclip-relay.service"]);
    run("/usr/bin/systemctl", ["stop", "baink-paperclip.service"]);
    const stopped = ownedContainer();
    assert(
      !stopped.State.Running &&
        stopped.State.ExitCode === 0 &&
        !stopped.State.OOMKilled,
    );
    const config = json(DATA + "/instances/default/config.json");
    config.auth.disableSignUp = true;
    config.$meta.updatedAt = new Date().toISOString();
    writeJson(DATA + "/instances/default/config.json", config, 1000, 1000);
    let env = fs
      .readFileSync(PRIVATE + "/runtime.env", "utf8")
      .split("\n")
      .filter((x) => !x.startsWith("PAPERCLIP_AUTH_DISABLE_SIGN_UP="))
      .join("\n")
      .trim();
    atomic(
      PRIVATE + "/runtime.env",
      env + "\nPAPERCLIP_AUTH_DISABLE_SIGN_UP=true\n",
    );
    state.previousContainerId = state.containerId;
    state.phase = "signup-closure-prepared";
    save();
    docker("rm", state.containerId);
    createContainer();
    writeUnits();
    run("/usr/bin/systemctl", ["daemon-reload"]);
    run("/usr/bin/systemctl", ["start", "baink-paperclip.service"]);
    for (let i = 0; i < 30 && !inspect("container", NAME)?.State?.Running; i++)
      await new Promise((r) => setTimeout(r, 300));
    renderRelay();
    run("/usr/bin/systemctl", ["daemon-reload"]);
    run("/usr/bin/systemctl", ["start", "baink-paperclip-relay.service"]);
    const h = await healthy();
    state.phase = "signup-closed-awaiting-api-verification";
    save();
    console.log(
      JSON.stringify({
        phase: state.phase,
        health: h,
        dataPreserved: true,
        apiClosureVerified: false,
      }),
    );
  } else if (action === "refresh-relay") {
    ownedContainer();
    run("/usr/bin/systemctl", ["stop", "baink-paperclip-relay.service"]);
    renderRelay();
    run("/usr/bin/systemctl", ["daemon-reload"]);
    run("/usr/bin/systemctl", ["start", "baink-paperclip-relay.service"]);
    console.log(
      JSON.stringify({ phase: "relay-refreshed", health: await healthy() }),
    );
  } else {
    ownedContainer();
    run("/usr/bin/systemctl", ["stop", "baink-paperclip-relay.service"]);
    run("/usr/bin/systemctl", ["stop", "baink-paperclip.service"]);
    state.phase = "stopped";
    save();
    console.log(JSON.stringify({ phase: "stopped", dataPreserved: true }));
  }
} catch (error) {
  const cleanup = {
    attempted: false,
    containerStopped: false,
    relayStopped: false,
    reconciliationRequired: true,
  };
  try {
    const c = state?.containerId
      ? inspect("container", state.containerId)
      : null;
    if (
      c &&
      c.Id === state.containerId &&
      c.Image === state.imageId &&
      c.Config.Labels?.["baink.intent"] === state.intent
    ) {
      cleanup.attempted = true;
      try {
        const unit = "/etc/systemd/system/baink-paperclip-relay.service";
        if (
          fs.existsSync(unit) &&
          fs
            .readFileSync(unit, "utf8")
            .includes("# Managed BAINK private relay " + REV) &&
          fs
            .readFileSync(unit, "utf8")
            .includes("ExecStart=/usr/bin/python3 " + PRIVATE + "/relay.py")
        ) {
          try {
            run("/usr/bin/systemctl", [
              "stop",
              "baink-paperclip-relay.service",
            ]);
            cleanup.relayStopped = true;
          } catch {
            cleanup.relayStopFailed = true;
          }
        }
      } catch {
        cleanup.relayStopFailed = true;
      }
      try {
        if (c.State.Running) docker("stop", "--time", "90", state.containerId);
      } catch {
        cleanup.containerStopFailed = true;
      }
      const stopped = inspect("container", state.containerId);
      cleanup.containerStopped =
        stopped?.Id === state.containerId && !stopped.State.Running;
      state.phase = "failed-reconciliation-required";
      state.failureCleanup = cleanup;
      writeJson(PRIVATE + "/runtime.json", state);
    }
  } catch {
    cleanup.cleanupIncomplete = true;
  }
  try {
    writeJson(PRIVATE + "/install-failure.json", {
      at: new Date().toISOString(),
      code: typeof error.code === "string" ? error.code : "operation_failed",
      message: error.message,
      stderr: error.stderr?.toString(),
      cleanup,
    });
  } catch {}
  console.error(
    JSON.stringify({ error: "private_runtime_operation_failed", cleanup }),
  );
  process.exitCode = 1;
} finally {
  fs.unlinkSync(lock);
}

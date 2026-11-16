/** Operator-owned periodic bridge. No credentials are exported; native funds and
 * private Paperclip permissions are outside this worker's capabilities. */
import { worker, parseWorkerArguments } from "./project-manager-worker.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat, appendFile, mkdir, open, unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { createManagementOutbox, validManagementReceipt } from "./management-outbox.mjs";
import { resolve, join } from "node:path";
const run = promisify(execFile);
export async function publishBatch(entry, { fetchImpl = fetch, command = run, attempts = 20, delayMs = 5000 } = {}) {
  const sha = entry.sha256;
  await command("/usr/bin/scp", ["-q", "-p", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", entry.path,
    "universa-and-others-mar-14:/var/lib/baink-deployments/management/plans.upload.json"], { timeout: 60000, maxBuffer: 65536 });
  const { stdout } = await command("/usr/bin/ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "universa-and-others-mar-14",
    `python3 /opt/baink-management/install-plans.py ${sha}`], { timeout: 30000, maxBuffer: 65536 });
  if (JSON.parse(stdout).sha256 !== sha) throw Error("remote_plan_receipt_mismatch");
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetchImpl(`https://baink.money/api/management/batches/${sha}`, {
        redirect: "error", signal: AbortSignal.timeout(10000), headers: { "Cache-Control": "no-cache" },
      });
      if (response.status === 200) {
        const receipt = await response.json();
        if (!validManagementReceipt(entry, receipt)) throw Error("invalid_management_receipt");
        return receipt;
      }
      if (response.status !== 404) throw Error("management_receipt_unavailable");
    } catch (error) {
      if (error.message === "invalid_management_receipt" || i === attempts - 1) throw error;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  throw Error("management_ingestion_unconfirmed");
}
export async function runCycle({ directory, generate = worker, publish = publishBatch, onProgress = console.log, usageSource = "api", claude = join(homedir(), ".local/bin/claude"), executableSha256 }) {
  directory = resolve(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await stat(join(directory, "STOP"));
    onProgress(JSON.stringify({ paused: "operator_stop" }));
    return;
  } catch (e) { if (e.code !== "ENOENT") throw e; }
  const lockPath = join(directory, "cycle.lock");
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (e) { if (e.code === "EEXIST") throw Error("cycle_already_running_inspect_lock"); throw e; }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    await lock.sync();
    const outbox = await createManagementOutbox(directory);
    const options = { directory, limit: 10, claude, onProgress, usageSource, executableSha256 };
    // Replay durable batches locally before a successful publication can archive them.
    await generate({ ...options, recoverOnly: true });
    async function drain() {
      for (const entry of await outbox.pending()) {
        const receipt = await publish(entry);
        if (!validManagementReceipt(entry, receipt)) throw Error("invalid_management_receipt");
        await appendFile(join(directory, "publish-receipts.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...receipt }) + "\n", { mode: 0o600 });
        await outbox.acknowledge(entry, receipt);
        onProgress(JSON.stringify({ published: true, sha256: entry.sha256, accepted: receipt.accepted, held: receipt.held }));
      }
    }
    await drain();
    const result = await generate(options);
    await drain();
    return result;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) throw Error("An explicit private worker directory is required.");
  const args = process.argv.slice(2);
  if ((args.length - 1) % 2 || args.slice(1).some((v,i)=>i%2===0&&!v.startsWith("--"))) throw Error("invalid_cycle_arguments");
  await runCycle(parseWorkerArguments([args[0], "10", ...args.slice(1)]));
}

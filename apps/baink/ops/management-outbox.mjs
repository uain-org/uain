/** Durable operator publication outbox. Pending bytes are authoritative until
 * the service confirms that their exact SHA-256 was atomically ingested. */
import { mkdir, open, readFile, readdir, rename, unlink, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
const sha256 = (raw) => createHash("sha256").update(raw).digest("hex");
async function syncDirectory(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
export function validManagementReceipt(entry, receipt) {
  return receipt?.sha256 === entry.sha256 &&
    [receipt.accepted, receipt.unchanged, receipt.held].every((n) => Number.isSafeInteger(n) && n >= 0) &&
    receipt.accepted + receipt.unchanged === entry.batch.plans.length &&
    receipt.held === entry.batch.heldProjects.length &&
    typeof receipt.at === "string" && Number.isFinite(Date.parse(receipt.at));
}
export async function createManagementOutbox(directory) {
  const root = join(resolve(directory), "outbox"), pendingDir = join(root, "pending"), acknowledgedDir = join(root, "acknowledged");
  await mkdir(pendingDir, { recursive: true, mode: 0o700 });
  await mkdir(acknowledgedDir, { recursive: true, mode: 0o700 });
  await syncDirectory(root);
  await syncDirectory(resolve(directory));
  async function pending() {
    const entries = [];
    for (const name of (await readdir(pendingDir)).sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) throw Error("invalid_outbox_entry");
      const path = join(pendingDir, name), info = await lstat(path);
      if (!info.isFile() || info.size > 1024 * 1024) throw Error("invalid_outbox_entry");
      const raw = await readFile(path), hash = sha256(raw);
      if (name !== `${hash}.json`) throw Error("outbox_digest_changed");
      const batch = JSON.parse(raw);
      if (batch?.schema !== "baink-management-batch-v1" || !Array.isArray(batch.plans) || !Array.isArray(batch.heldProjects)) throw Error("invalid_outbox_entry");
      entries.push({ path, sha256: hash, batch });
    }
    return entries;
  }
  return {
    pending,
    async enqueue(batch) {
      const raw = Buffer.from(JSON.stringify(batch) + "\n"), hash = sha256(raw);
      if (raw.length > 1024 * 1024) throw Error("outbox_batch_too_large");
      const path = join(pendingDir, `${hash}.json`), temporary = join(root, `.pending-${randomUUID()}`);
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); }
      try { await rename(temporary, path); await syncDirectory(pendingDir); await syncDirectory(root); }
      finally { await unlink(temporary).catch((e) => { if (e.code !== "ENOENT") throw e; }); }
      return { path, sha256: hash, batch };
    },
    async recover(service) {
      for (const entry of await pending()) service.applyBatch(entry.batch, entry.sha256);
    },
    async acknowledge(entry, receipt) {
      if (!validManagementReceipt(entry, receipt)) throw Error("invalid_management_receipt");
      const path = join(pendingDir, `${entry.sha256}.json`);
      if (sha256(await readFile(path)) !== entry.sha256) throw Error("outbox_digest_changed");
      await rename(path, join(acknowledgedDir, `${entry.sha256}.json`));
      await syncDirectory(acknowledgedDir);
      await syncDirectory(pendingDir);
    },
  };
}

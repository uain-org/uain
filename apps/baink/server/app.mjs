import {createInitialProjectTasks} from './initial-project-tasks.mjs';
import {createNativeStateSSH} from './native-state-ssh.mjs';
import { createChangeTracker, diffStates, exportStateJson, openStateDatabase, StateWriter } from './store-sqlite.mjs';
import { chmodSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { createPublicReviewRuntime } from "./public-review.mjs";
import { createRestrictedReviewClient, createCentralFeedbackReader } from "./review-root-client.mjs";
import { createGroupCommitStore, StorageError } from "./store.mjs";
import { createBainkMcp } from "./mcp.mjs";
import { SIGNER } from "./mcp-member.mjs";
import { Readable } from "node:stream";
import {
  createProfileEndorsements,
  ProfileEndorsementError,
} from "./profile-endorsements.mjs";
import { projectFundingReadiness } from "./funding-policy.mjs";
import { createHash, createPublicKey, verify } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  chmod,
  stat,
  lstat,
  realpath,
} from "node:fs/promises";
import { resolve, join, extname, sep } from "node:path";
import { createSmartMeetClient } from "../integrations/smartmeet-api.mjs";
import { loadCatalogue } from "./catalogue.mjs";
import { createUnifiedWork, UnifiedWorkError } from "./unified-work.mjs";
import {
  createProjectManagement,
  ManagementError,
} from "./project-management.mjs";
import { createProposalPages } from "./proposal-pages.mjs";
import { renderProposalPage } from "./proposal-page-template.mjs";
import { isIP } from "node:net";
import {
  createNativeAssetAdapter,
  assetMetadata,
} from "./native-asset.mjs";
import { createNativeEnrolService, NativeEnrolError } from "./native-enrol.mjs";
import {
  createNativeInstanceService,
  NativeInstanceError,
} from "./native-instance.mjs";
import { canonicalJSON } from "../integrations/native-research-codec.mjs";
import { createNativeProjectPilotService, NativeProjectPilotError } from "./native-project-pilot.mjs";
import { createNativeEarningService, NativeEarningError } from "./native-earning.mjs";
import { createCentralTaskAvailability } from "./central-task-availability.mjs";
import { createCentralTaskRequirements } from "./central-task-requirements.mjs";
import { createCentralEarningService, CentralEarningError, centralProofRefusal } from "./central-earning.mjs";
import { contributionLines } from "../shared/contribution-view.mjs";
import { createNativeBountyMaterials, NativeBountyMaterialsError } from "./native-bounty-materials.mjs";
import { createNativePaymentService, NativePaymentError } from "./native-payments.mjs";
import { withRequestGuard } from "./native-payments-guard.mjs";
import { createServerSendService, ServerSendError } from "./server-send.mjs";
import { createSequenceFenceClearer } from "./sequence-fence-clear.mjs";
import { createCoinWalletSendBuilder, createCustodySendChecker, createShieldTransport, addressFromFullViewingKey } from "./server-send-builder.mjs";
import { createSendRoutes } from "./routes/send.mjs";
import { createMemberDirectory, MemberDirectoryError } from "./members.mjs";
import { createNativeResearch } from "./native-research.mjs";
import {
  createNativeWorkClaim,
  NativeWorkClaimError,
} from "./native-work-claim.mjs";
import {
  createNativeWorkCurrent,
  NativeWorkCurrentError,
} from "./native-work-current.mjs";
import {
  createNativeProjectAccess,
  validateNativeProjectLeads,
} from "./native-project-access.mjs";
import { createTradeService, TradeError } from "./trade.mjs";
import { createTradeTermsService, TradeTermsError } from "./trade-terms.mjs";
import { createTradePaymentService, validateTradePaymentRequest, TradePaymentError } from "./trade-payment.mjs";
import { createPeerMessages, PeerMessageError } from "./messages.mjs";
import { createMemberProfiles, ProfileError } from "./profiles.mjs";
import { createWorkSelections, WorkSelectionError } from "./work-selection.mjs";
import { classifyReviewError } from "../review-service/errors.mjs";
import {
  createPaperclipReadBridge,
  PaperclipReadError,
} from "../integrations/paperclip-api.mjs";
import { createOrganizationsStatus } from "./organizations-status.mjs";
import { ApiError, fail, sendJson as response, sendError, shapeError, withRetryHint } from "./http-errors.mjs";
import {
  ADDRESS,
  bodyLimitFor,
  canonical,
  createRequestContext,
  only,
  readBody,
} from "./routes/context.mjs";
import { createPublicRoutes } from "./routes/public.mjs";
import { createPublicTasks } from "./public-tasks.mjs";
import { createReviewQueue } from "./review-queue.mjs";
import { createManagementRoutes } from "./routes/management.mjs";
import { checkAccountBody, createIdentityRoutes } from "./routes/identity.mjs";
import { createWorkRoutes } from "./routes/work.mjs";
import { createTradeRoutes } from "./routes/trade.mjs";
import { createTradeDealRoutes } from "./routes/trade-deals.mjs";
import { createTradeDealService, TradeDealError } from "./trade-deals.mjs";
import { createTradeAvailability, TradePausedError } from "./trade-availability.mjs";
import { createWalletRoutes } from "./routes/wallet.mjs";
import { createCampaigns, karmaReader, uainLlmsReader, CAMPAIGN_CODE, wantsHtml, isLinkBot } from "./campaigns.mjs";
import { renderGoPage, renderUainGoPage, GO_PAGE_CSP } from "./go-page.mjs";
import { createAdmin } from "./admin.mjs";

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
// Business metadata bound (10 November 2026: 24 MiB, was 8 MiB). The store is
// held in memory (about 3.3x its JSON size in heap under --max-old-space-size=192),
// so this bound is set by memory, no longer by rewriting one file per commit.
export const MAX_METADATA_BYTES = 24 * 1024 * 1024;
export const MAX_STORE_BYTES = MAX_METADATA_BYTES + 3 * 1024 * 1024;
const STATE_EXPORT_INTERVAL_MS = 60_000;
const AUTH_WINDOW = 300_000;
// A signature may be dated this far ahead. The web and the kit sign with the
// local clock and never correct it, so the 300 s tolerance stays (a 60 s limit
// tried on 13 November 2026 locked out members whose clocks run fast); the
// nonce admission below protects the table instead.
const AUTH_FUTURE_SKEW = AUTH_WINDOW;
// The nonce table (B1-2; final rule of the third review, 13 November 2026):
//   fewer than NONCE_BUSY_AT open nonces: as before, 128 per key (8 for an
//     unregistered key) and the per-minute admission limits, nothing else;
//   NONCE_BUSY_AT up to NONCE_HARD_CAP: a key is admitted only while it holds
//     fewer than NONCE_BUSY_KEY_LIMIT open nonces of its own; otherwise busy;
//   NONCE_HARD_CAP or more: every key gets busy.
// Why: accounts are free, so the table cannot be shared fairly among keys
// (every fair-share rule tried could be steered by many small accounts). This
// rule is never stricter than the single 10,000 cap it replaces, which refused
// everyone; and it raises what it takes to refuse everyone from about 84 keys
// to about 390 (79 keys to reach 10,000 at 128 each, then 5,000 more at under
// 16 a key). NONCE_HARD_CAP is the byte bound: a nonce row is at most about
// 191 bytes (address, ":", a 128-character nonce, a 13-digit expiry), and
// 15,000 rows (about 2.9 MB) fit the 3 MiB the store keeps above the
// metadata cap.
export const NONCE_BUSY_AT = 10_000;
export const NONCE_BUSY_KEY_LIMIT = 16;
export const NONCE_HARD_CAP = 15_000;
// Kept as a named export for existing callers (web/admission-http.test.mjs).
export { canonical };
/** An address's budget key: an IPv6 address counts as its /64, anything else
 * (IPv4, IPv4-mapped IPv6, member addresses) as itself. */
export function clientBucket(value) {
  if (isIP(value) !== 6 || /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(value)) return value;
  const [head, tail = ""] = value.toLowerCase().split("%")[0].split("::");
  const left = head ? head.split(":") : [], right = tail ? tail.split(":") : [];
  const groups = value.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}
function decodeBase64(value, length) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    fail(401, "invalid_signature", "A valid member signature is required.");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== length || bytes.toString("base64") !== value)
    fail(401, "invalid_signature", "A valid member signature is required.");
  return bytes;
}
export async function loadStore(dataDir, storeOptions = {}) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  const lockPath = join(dataDir, "writer.lock");
  let lock;
  let created = false;
  try {
    lock = await open(lockPath, "wx+", 0o600);
    created = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    lock = await open(lockPath, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  }
  try {
    const lockInfo = await lock.stat();
    if (!lockInfo.isFile() || lockInfo.nlink !== 1 || lockInfo.uid !== process.getuid())
      throw new Error("BAINK storage has an unsafe writer.lock; preserve it for operator review.");
    // flock(1) locks the inherited open file description. The parent retains
    // that description after the helper exits; process death releases it.
    // Never unlink this inode: a contender may already have opened it.
    await new Promise((resolve, reject) => {
      const helper = spawn("flock", ["--exclusive", "--nonblock", "3"], {
        stdio: ["ignore", "ignore", "ignore", lock.fd],
      });
      helper.once("error", reject);
      helper.once("close", (code) => code === 0 ? resolve() : reject(new Error(
        code === 1 ? "BAINK storage already has an active writer." :
          "BAINK storage lock unavailable; util-linux flock is required.",
      )));
    });
    if (!created) {
      let owner;
      try { owner = JSON.parse(await lock.readFile("utf8")); } catch {}
      if (owner?.protocol !== "flock-v1") {
        // Old releases do not cooperate with flock. Preserve their live-owner
        // protection, and leave ambiguous legacy metadata for operator review.
        const pid = owner?.pid;
        if (!Number.isSafeInteger(pid) || pid <= 0)
          throw new Error("BAINK storage is locked; inspect writer.lock before restarting.");
        try {
          process.kill(pid, 0);
          throw new Error("BAINK storage already has an active writer.");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
    }
    const metadata = JSON.stringify({ protocol: "flock-v1", pid: process.pid, startedAt: new Date().toISOString() });
    await lock.write(metadata, 0, "utf8");
    await lock.truncate(Buffer.byteLength(metadata));
    await lock.sync();
  } catch (error) {
    await lock.close();
    throw error;
  }
  const path = join(dataDir, "state.json");
  // The same checks for a state imported from state.json or loaded from SQLite.
  function checkState(state) {
    if (
      !state ||
      state.version !== 1 ||
      !state.accounts ||
      !state.requests ||
      !state.nonces ||
      !Array.isArray(state.history)
    )
      throw new Error(
        "Unsupported or invalid BAINK state; restore a valid backup.",
      );
    if (state.nativeIntents === undefined) state.nativeIntents = {};
    if (
      !state.nativeIntents ||
      typeof state.nativeIntents !== "object" ||
      Array.isArray(state.nativeIntents)
    )
      throw new Error("Invalid BAINK native enrolment journal.");
    if (
      state.nativeInstanceIntents !== undefined &&
      (!state.nativeInstanceIntents ||
        typeof state.nativeInstanceIntents !== "object" ||
        Array.isArray(state.nativeInstanceIntents))
    )
      throw new Error("Invalid BAINK native instance journal.");
    for (const key of ["nativeProjectPilotIntents", "centralEarningIntents", "nativeEarningIntents", "nativePaymentIntents", "nativePaymentEffects", "nativePaymentRequestLocks", "serverSendIntents", "serverSendRequestLocks", "receivingAddresses"])
      if (state[key] !== undefined && (!state[key] || typeof state[key] !== "object" || Array.isArray(state[key])))
        throw new Error("Invalid BAINK native financial journal.");
    if (
      Buffer.byteLength(JSON.stringify({ ...state, nonces: {} })) >
      MAX_METADATA_BYTES
    )
      throw new Error(
        "Existing BAINK metadata requires migration before this version can start; preserve all records.",
      );
    return state;
  }
  // SQLite holds the store (10 November 2026); state.json is imported once and
  // then kept as an export for the previous release (see store-sqlite.mjs).
  let opened, state;
  try {
    opened = openStateDatabase({
      dataDir,
      readLegacy() {
        let info;
        try {
          info = lstatSync(path);
        } catch (error) {
          if (error.code === "ENOENT") return null;
          throw error;
        }
        if (!info.isFile() || info.size > MAX_STORE_BYTES)
          throw new Error(
            "BAINK storage size exceeds its safe capacity; preserve the file for operator review.",
          );
        const bytes = readFileSync(path);
        chmodSync(path, 0o600);
        return { bytes, get state() { return checkState(JSON.parse(bytes.toString("utf8"))); } };
      },
      log: (event) => console.log(JSON.stringify({ bainkStore: event })),
    });
    state = opened.state;
    if (state === null) {
      state = checkState({ version: 1, accounts: {}, requests: {}, nonces: {}, history: [], nativeIntents: {} });
      opened.database.replaceAll(state, { created_at: new Date().toISOString() });
    } else checkState(state);
  } catch (error) {
    opened?.database.db.close();
    await lock.close();
    throw error;
  }
  // From here on one worker thread writes; the main thread never waits on an fsync.
  opened.database.close();
  const database = new StateWriter(dataDir, { commitDelayMs: storeOptions.commitDelayMs ?? 0, onFailure: storeOptions.onWriterFailure ?? null });
  try {
    await database.ready;
  } catch (error) {
    await database.close().catch(() => {});
    await lock.close();
    throw error;
  }
  const tracker = createChangeTracker({ initialState: state, maxStoreBytes: MAX_STORE_BYTES, maxMetadataBytes: MAX_METADATA_BYTES, fail });
  let exportedAt = Date.now(), exported = existsSync(path) ? state : null, exporting = null;
  function exportNow() {
    const snapshot = tracker.durable;
    exporting = exportStateJson(database, snapshot, path)
      .then(() => { exported = snapshot; })
      .catch((error) => console.error(JSON.stringify({ bainkStore: { event: "state_export_failed", message: error.message } })))
      .finally(() => { exportedAt = Date.now(); exporting = null; });
    return exporting;
  }
  // Only the rows a commit changed are written; SQLite fsyncs the WAL before
  // the group's acknowledgements are released.
  async function persist(next) {
    const ops = tracker.changesTo(next) ?? diffStates(tracker.durable, next);
    await database.commit(ops);
    tracker.settle(next);
    if (!exporting && Date.now() - exportedAt >= STATE_EXPORT_INTERVAL_MS) exportNow();
  }
  const durable = createGroupCommitStore({ initialState: state, initialStateOwned: true, persist, validate: tracker.validate });
  return {
    transact: durable.transact,
    transactNonces: durable.transactNonces,
    transactRequestCreate: durable.transactRequestCreate,
    transactMessages: durable.transactMessages,
    read: durable.read,
    hasAccount: (address) => durable.has("accounts", address),
    account: (address) => durable.get("accounts", address) ?? null,
    async close() {
      try {
        await durable.close();
        if (exporting) await exporting;
        // The previous release starts from state.json after a rollback.
        if (exported !== tracker.durable) await exportNow();
      } finally {
        await database.close();
        await lock.close();
      }
    },
  };
}
function projectShape(row, sourceOrigin) {
  if (!row || typeof row.id !== "string" || typeof row.title !== "string")
    return null;
  return {
    id: row.id.slice(0, 160),
    title: row.title.slice(0, 300),
    description: String(
      row.description ?? row.summary ?? row.question ?? "",
    ).slice(0, 5000),
    category: String(row.category ?? row.domain ?? "Research").slice(0, 120),
    status: String(
      row.progress?.status ?? row.status ?? row.state ?? "unknown",
    ).slice(0, 80),
    url: `${sourceOrigin}/network/live?project=${encodeURIComponent(row.id)}`,
    taskCount: Number.isSafeInteger(row.task_count)
      ? row.task_count
      : typeof row.tasks === "number"
        ? row.tasks
        : Number.isSafeInteger(row.tasks?.total)
          ? // Open central tasks (survey parts) count too: uain.global lists them per project.
            row.tasks.total +
            (Number.isSafeInteger(row.tasks.central_open) && row.tasks.central_open > 0 ? row.tasks.central_open : 0)
          : row.tasks && typeof row.tasks === "object"
            ? Object.values(row.tasks)
                .filter(Number.isSafeInteger)
                .reduce((a, b) => a + b, 0)
            : null,
  };
}
async function boundedJson(response) {
  if (!response.ok) throw new Error("Catalogue source unavailable");
  const reader = response.body.getReader();
  let total = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 2_000_000) throw new Error("Catalogue response too large");
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// Error classes whose status, code and message are safe to show the caller.
const KNOWN_ERRORS = [
  ApiError,
  UnifiedWorkError,
  ManagementError,
  NativeEnrolError,
  NativeInstanceError,
  NativeProjectPilotError,
  NativeEarningError,
  CentralEarningError,
  NativeBountyMaterialsError,
  NativePaymentError,
  ServerSendError,
  MemberDirectoryError,
  NativeWorkCurrentError,
  NativeWorkClaimError,
  TradeError,
  TradeTermsError,
  TradePaymentError,
  TradeDealError,
  TradePausedError,
  StorageError,
  PeerMessageError,
  ProfileError,
  ProfileEndorsementError,
  WorkSelectionError,
  PaperclipReadError,
];

export function campaignLlmsPath(staticDir) {
  const built = join(resolve(staticDir ?? new URL("../dist/", import.meta.url).pathname), "llms.txt");
  return existsSync(built) ? built : new URL("../public/llms.txt", import.meta.url).pathname;
}

export async function createBainkServer(options = {}) {
  if (!options.dataDir)
    throw new Error(
      "BAINK_DATA_DIR is required, outside the application directory.",
    );
  const dataDir = resolve(options.dataDir);
  const repositoryDir = resolve(new URL("../../../", import.meta.url).pathname);
  if (dataDir === repositoryDir || dataDir.startsWith(repositoryDir + sep))
    throw new Error("BAINK_DATA_DIR must be outside the source repository.");
  const origins = [
    ...new Set(
      [
        options.publicOrigin ?? "http://127.0.0.1:8798",
        ...(options.publicOrigins ?? []),
      ].map((value) => {
        const url = new URL(value);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.pathname !== "/" ||
          url.search ||
          url.hash
        )
          throw new Error("BAINK_PUBLIC_ORIGIN must be an HTTP(S) origin.");
        return url.origin;
      }),
    ),
  ];
  const audience = origins[0];
  // The signature clock; tests inject one (options.authClock) to place a
  // request on either side of its window.
  const authClock = typeof options.authClock === "function" ? options.authClock : Date.now;
  const admission = new Map();
  // Admission buckets (13 November 2026, B1-3/B1-4). An IPv6 client is one /64
  // (one subscriber's routed prefix gives it every address in it), and a full
  // category forgets its least recently used bucket instead of refusing every
  // new address: 4,096 addresses can no longer lock newcomers or MCP clients
  // out. Categories stay separate, so rotating keys never evicts IP budgets.
  function admit(bucket, limit, period) {
    const split = bucket.indexOf(":"), category = bucket.slice(0, split);
    bucket = category + ":" + clientBucket(bucket.slice(split + 1));
    let buckets = admission.get(category);
    if (!buckets) {
      buckets = new Map();
      admission.set(category, buckets);
    }
    const now = Date.now();
    let entry = buckets.get(bucket);
    if (!entry || entry.until <= now) entry = { count: 0, until: now + period };
    if (entry.count >= limit)
      fail(429, "rate_limited", "Too many operations. Please retry later.", { retryAfterSeconds: (entry.until - now) / 1000 });
    buckets.delete(bucket);
    if (buckets.size >= 4096) buckets.delete(buckets.keys().next().value);
    entry.count++;
    buckets.set(bucket, entry);
  }
  function requesterIp(req) {
    const peer = req.socket.remoteAddress ?? "unknown";
    const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer);
    const real = req.headers["x-real-ip"];
    return options.trustProxy === true &&
      loopback &&
      typeof real === "string" &&
      isIP(real)
      ? real
      : peer;
  }
  const smartmeet = createSmartMeetClient({
    apiOrigin: options.smartmeetApiOrigin ?? "",
    apiKey: options.smartmeetApiKey ?? "",
  });
  const smartmeetMembers = new Set(options.smartmeetMemberAddresses ?? []);
  const accountBatchingEnabled = options.nativeAccountBatchingEnabled === true;
  const nativeStateTransport = options.nativeStateTransport ?? (options.nativeStateSSHEnabled === true ? createNativeStateSSH() : null);
  const nativeAsset = createNativeAssetAdapter({
    config: options.nativeConfig,
    paymentBroadcaster: options.nativePaymentBroadcaster ?? null,
    stateTransport: nativeStateTransport,
    accountBatchingEnabled,
  });
  try { await nativeStateTransport?.prepare?.(); } catch (error) {
    if (error.message !== "native_state_ssh_master_unavailable") throw error;
  }
  const proposals = await loadCatalogue(
    options.catalogueDir === undefined
      ? new URL("../catalogue/", import.meta.url).pathname
      : options.catalogueDir,
  );
  const proposalPages = createProposalPages({
    catalogue: proposals,
    origin: audience,
  });
  const paperclip = createPaperclipReadBridge(options.paperclipConfig);
  const disconnectedPaperclip = createPaperclipReadBridge();
  const operationsNativeLeads = validateNativeProjectLeads(
    options.paperclipNativeLeads,
  );
  const nativeProjectAccess = createNativeProjectAccess({
    native: nativeAsset,
  });
  const rawViewers = options.paperclipViewers ?? {};
  if (
    !rawViewers ||
    typeof rawViewers !== "object" ||
    Array.isArray(rawViewers) ||
    Object.keys(rawViewers).length > 1000
  )
    throw new Error("Invalid project viewer configuration.");
  const operationsViewers = new Map();
  let viewerCount = 0;
  for (const [id, addresses] of Object.entries(rawViewers)) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(id) ||
      !Array.isArray(addresses) ||
      addresses.length > 50 ||
      addresses.some(
        (address) => typeof address !== "string" || !ADDRESS.test(address),
      )
    )
      throw new Error("Invalid project viewer configuration.");
    viewerCount += addresses.length;
    if (viewerCount > 5000)
      throw new Error("Project viewer capacity exceeded.");
    operationsViewers.set(id, new Set(addresses));
  }
  const organizationsStatus = createOrganizationsStatus(options.organizationsStatus ?? {});
  const memberDirectory = createMemberDirectory(options.memberDirectoryOptions);
  const nativeResearch = createNativeResearch({
    ...options.nativeResearchOptions,
    totalTimeoutMs: 12000,
    native: nativeAsset,
  });
  const nativeWorkCurrent = createNativeWorkCurrent({ native: nativeAsset });
  const nativeWorkClaim = createNativeWorkClaim({ native: nativeAsset });
  // A dead state writer cannot recover in this process; index.mjs exits so
  // systemd (Restart=on-failure) starts again from the durable rows.
  const store = await loadStore(dataDir, { onWriterFailure: options.onStoreFailure });
  const initialProjectTasks = createInitialProjectTasks(proposals);
  const management = createProjectManagement({
    path: join(dataDir, "management.sqlite"),
    catalogue: proposals,
    enabled: options.managementEnabled === true,
  });
  let managementPlanDigest = null;
  async function managementCycle() {
    if (options.managementEnabled !== true) return;
    if (options.managementPlansFile) {
      try {
        const info = await lstat(options.managementPlansFile);
        if (!info.isFile() || info.size > 1024 * 1024)
          throw Error("Invalid management plan file");
        const bytes = await readFile(options.managementPlansFile);
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (digest !== managementPlanDigest) {
          const batch = JSON.parse(bytes.toString("utf8"));
          management.applyBatch(batch, digest);
          managementPlanDigest = digest;
        }
      } catch (error) {
        if (error.code !== "ENOENT") options.onError?.(error);
      }
    }
    management.cycle();
  }
  await managementCycle();
  let managementCycling = false;
  const managementTimer =
    options.managementEnabled === true
      ? setInterval(async () => {
          if (managementCycling) return;
          managementCycling = true;
          try {
            await managementCycle();
          } catch (error) {
            options.onError?.(error);
          } finally {
            managementCycling = false;
          }
        }, 60000)
      : null;
  managementTimer?.unref();
  // Trade availability (P0-4): one setting, asked by every Trade entry point. A
  // missing tradeMode is paused, so only an explicit "open" reopens new business.
  const tradeAvailability = createTradeAvailability({ mode: options.tradeMode });
  const trade = createTradeService({ store });
  const tradeTerms = createTradeTermsService({
    store,
    context: (...args) => trade.termsContext(...args),
  });
  const tradePayments = createTradePaymentService({store,trade});
  const tradeDeals = createTradeDealService({
    store, trade, availability: tradeAvailability,
    stewards: options.tradeStewardAddresses ?? [],
    appealReviewers: options.tradeAppealReviewerAddresses ?? [],
    ...(options.now ? { now: options.now } : {}),
  });
  // Expire unpaid deal payment requests and close appeal windows once a minute.
  const tradeDealTimer = options.tradeDealSweep === false ? null : setInterval(() => {
    tradeDeals.sweep().catch((error) => options.onError?.(error));
  }, 60000);
  tradeDealTimer?.unref();
  // Campaign pages (/go/<code>) and their per-code counts (docs/campaigns.md).
  const uainOrigin = options.uainOrigin ?? "https://uain.global";
  const campaigns = createCampaigns({
    store,
    // The llms.txt the site serves: a release ships only the built dist/ (no
    // public/), so read it from the static directory, and fall back to the
    // source copy in a checkout without a build.
    llmsFile: options.campaignLlmsFile ?? campaignLlmsPath(options.staticDir),
    // uain.global/go/<code> is proxied here as /uain/go/<code> (ops/nginx/docker.conf); its guide
    // is uain.global's llms.txt. Tests pass campaignUainLlms; false turns the fetch off.
    uainLlms: options.campaignUainLlms === false ? null : options.campaignUainLlms ?? uainLlmsReader(uainOrigin),
    ...(options.campaigns ? { campaigns: options.campaigns } : {}),
    onError: (error) => options.onError?.(error),
  });
  const campaignOperators = new Set(options.campaignOperatorAddresses ?? []);
  const campaignKarma = options.campaignAcceptedTask ?? karmaReader();
  // /admin: email + password, read-only campaign dashboard (docs/admin.md).
  const admin = createAdmin({
    dataDir,
    campaigns,
    acceptedTask: campaignKarma,
    uainOrigin,
    // An IPv6 client is one /64 here too (B1-6).
    clientIp: (req) => clientBucket(requesterIp(req)),
    secureCookie: options.adminInsecureCookie !== true,
  });
  const messages = createPeerMessages({ store: { ...store, transact: store.transactMessages } });
  const profiles = createMemberProfiles({ store });
  const endorsements = createProfileEndorsements({ store });
  const workSelections = createWorkSelections({
    store,
    resolveSource: workSource,
  });
  const nativeEnrol = createNativeEnrolService({
    store,
    native: nativeAsset,
    enabled: options.nativeEnrolEnabled === true,
  });
  const nativeInstances = createNativeInstanceService({
    store,
    native: nativeAsset,
    enabled: options.nativeInstanceEnabled === true,
  });
  const nativeProjectPilot = createNativeProjectPilotService({
    store, native: nativeAsset, config: options.nativeProjectPilotConfig ?? null,
    enabled: options.nativeProjectPilotEnabled === true,
    sourceDigest: async () => {
      const row = proposals.detail(options.nativeProjectPilotConfig?.sourceId);
      return row ? createHash("sha256").update(canonicalJSON(row)).digest("hex") : null;
    },
  });
  const nativeEarning = createNativeEarningService({
    store, native: nativeAsset, enabled: options.nativeEarningEnabled === true,
  });
  const taskRequirements = await createCentralTaskRequirements({path:options.centralTaskRequirementsFile??null,pins:nativeAsset.pins});
  const feedbackReader = options.centralFeedbackReader ?? (options.publicReviewEnabled === true
    ? createCentralFeedbackReader({rootAction: options.publicReviewRootAction}) : null);
  const centralEarning = createCentralEarningService({store,native:nativeAsset,enabled:options.centralEarningEnabled===true,taskRequirements,taskAvailability:createCentralTaskAvailability({pins:nativeAsset.pins}),feedbackReader,onProofRefusal:options.onCentralProofRefusal});
  const nativeBountyMaterials = await createNativeBountyMaterials({
    native: nativeAsset, manifestFile: options.nativeBountyMaterialsFile ?? null,
  });
  // The shared "may this request already be paid?" guard goes in front of `prepare`
  // (native-payments-guard.mjs says why it is not inside the service).
  const nativePayments = withRequestGuard(createNativePaymentService({
    store, native: nativeAsset, validateTradeRequest: validateTradePaymentRequest, tradeAvailability,
    enabled: options.nativePaymentEnabled === true && nativeAsset.paymentBroadcastConfigured === true,
  }), store);
  // A member's broadcast but unreconciled central-earning intent holds its
  // sequence; BAINK settles it from chain state itself (reads only, never re-signs).
  const sequenceFence = createSequenceFenceClearer({ store, reconcile: (user, id, body) => centralEarning.reconcile(user, id, body) });
  const sequenceFenceTimer = nativeAsset.configured === true && options.sequenceFenceSweepMs !== 0
    ? setInterval(() => { sequenceFence.sweep().catch(() => {}); }, options.sequenceFenceSweepMs ?? 60000)
    : null;
  sequenceFenceTimer?.unref?.();
  // No-install sending. Off unless a builder (coin wallet + checker) and a relay
  // transport are configured; the holder path is unaffected either way.
  // Production (BAINK_SERVER_SEND_*): the pinned coin wallet builds, the custody
  // boundary reviewer checks with one AI decision per send through the public
  // review broker queue, and the payer's own signed bytes go to the native RPC.
  let serverSendParts = options.serverSend ?? null;
  const sendConfig = options.serverSendConfig ?? null;
  if (!serverSendParts && sendConfig && options.serverSendEnabled === true) {
    const checker = createCustodySendChecker({
      rootAction: options.serverSendRootAction ?? options.publicReviewRootAction ?? createRestrictedReviewClient(),
      aiReview: (binding, o) => publicReview ? publicReview.serverSendReview(binding, o) : { status: "unavailable" },
      reviewerPublicKeyHex: Buffer.from("wpwtSOfm7XkVbHxuo5hXx6VOusc_DVFutMfYi8EiiWw", "base64url").toString("hex"),
    });
    serverSendParts = {
      builder: createCoinWalletSendBuilder({ coinWallet: sendConfig.coinWallet, checker, workDirectory: sendConfig.workDirectory }),
      transport: createShieldTransport({ rpc: sendConfig.rpc, chainId: nativeAsset.pins.chainId }),
      addressFromKey: (fullViewingKey) => addressFromFullViewingKey(sendConfig.coinWallet, fullViewingKey),
    };
  }
  const serverSendNative = serverSendParts?.transport
    ? Object.freeze({ configured: nativeAsset.configured, pins: nativeAsset.pins, timeoutMs: nativeAsset.timeoutMs, publicState: (...a) => nativeAsset.publicState(...a), invalidateAccount: (a) => nativeAsset.invalidateAccount(a), broadcastShield: serverSendParts.transport.broadcastShield })
    : nativeAsset;
  const serverSend = createServerSendService({
    store, native: serverSendNative, builder: serverSendParts?.builder ?? null,
    enabled: options.serverSendEnabled === true, validateTradeRequest: validateTradePaymentRequest, tradeAvailability,
    allowedMembers: options.serverSendAllowedMembers ?? sendConfig?.allowedMembers ?? null,
    addressFromKey: serverSendParts?.addressFromKey ?? null,
    clearSequenceFence: (member) => sequenceFence.clear(member),
  });
  const serverSendTimer = serverSend.enabled && options.serverSendTickMs !== 0
    ? setInterval(() => { serverSend.tick().catch(() => {}); }, options.serverSendTickMs ?? 5000)
    : null;
  serverSendTimer?.unref?.();
  let projectsCache = null,
    projectsFetch = null;
  const detailCache = new Map();
  const projectsSource =
    options.projectsSource === undefined
      ? "https://uain.global/api/projects"
      : options.projectsSource;
  let sourceUrl;
  try {
    if (projectsSource) {
      sourceUrl = new URL(projectsSource);
      const localSource = ["127.0.0.1", "[::1]", "localhost"].includes(
        sourceUrl.hostname,
      );
      if (
        sourceUrl.username ||
        sourceUrl.password ||
        sourceUrl.search ||
        sourceUrl.hash ||
        (sourceUrl.protocol !== "https:" &&
          !(sourceUrl.protocol === "http:" && localSource))
      )
        throw new Error("Invalid catalogue URL");
    }
  } catch (error) {
    await store.close();
    throw error;
  }
  let publicReview = options.publicReviewRuntime ?? null;
  if (options.publicReviewEnabled === true && !publicReview) {
    try {
      const keyFile = await open(options.publicReviewWorkerKeyFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let secret;
      try {
        const info = await keyFile.stat();
        if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || info.mode & 0o077 || info.size !== 32) throw Error("Public review worker credential refused");
        secret = await keyFile.readFile();
      } finally { await keyFile.close(); }
      try {
        publicReview = await createPublicReviewRuntime({directory: join(dataDir, "public-review"), native: nativeAsset,
          pins: {chainId: nativeAsset.pins.chainId, genesisSha256: nativeAsset.pins.epoch, verifierSha256: nativeAsset.pins.verifierSha256,
            reviewer: "uain17fae025e2b7492156d438712aab8efcb4113b0fd", reviewerPublicKey: "wpwtSOfm7XkVbHxuo5hXx6VOusc_DVFutMfYi8EiiWw", relay: "uain1215c651b70db82b70532a496c26fdf424f3bb369"},
          rootAction: options.publicReviewRootAction ?? createRestrictedReviewClient(), workerSecret: secret, onError: options.onError,
          brokerPublicKey: "imXvi5XRE9i3LNfAFfagRPz0F0Dl0tB1rfArCEUYgJ0", audience});
      } finally { secret?.fill(0); }
    } catch (error) { management.close(); await store.close(); throw error; }
  }
  async function reviewCall(fn, worker = false) {
    if (!publicReview) fail(503, "public_review_unavailable", "The public checker is not configured.");
    try { return await fn(); } catch (e) {
      // Typed codes (review-service/errors.mjs), never a pattern over message text. Unknown errors
      // are 500 and, with dependency outages and integrity failures, reach operators via onError.
      const shaped = classifyReviewError(e, { worker });
      if (shaped.report) options.onError?.(e);
      fail(shaped.status, shaped.code, shaped.message);
    }
  }
  // The live catalogue is fresh for 60 s. Public lists (allowStale) may then
  // get the last live catalogue (up to 15 minutes old; its fetchedAt says so)
  // at once while one background fetch refreshes it, also after a failed
  // refresh (10 November 2026: a slow uain.global held every project-list
  // request, and its request slot, for up to 6 s). Management keeps the strict
  // behaviour: it waits for the refresh and fails closed when it fails.
  const STALE_CATALOGUE_MS = 900_000;
  let lastLive = null;
  const servableLive = () => lastLive && Date.now() - lastLive.at < STALE_CATALOGUE_MS;
  async function catalogue({ allowStale = false } = {}) {
    if (projectsCache && Date.now() - projectsCache.at < 60_000)
      return allowStale && projectsCache.result.source.status !== "live" && servableLive()
        ? lastLive.result
        : projectsCache.result;
    projectsFetch ??= fetchCatalogue().finally(() => {
      projectsFetch = null;
    });
    if (allowStale && servableLive()) return lastLive.result;
    return projectsFetch;
  }
  async function fetchCatalogue() {
      if (!sourceUrl)
        return {
          projects: [],
          source: { url: null, fetchedAt: null, status: "unavailable" },
        };
      try {
        const url = new URL(sourceUrl);
        url.searchParams.set("page_size", "100");
        url.searchParams.set("page", "1");
        const raw = await boundedJson(
          await fetch(url, {
            signal: AbortSignal.timeout(6000),
            redirect: "error",
            headers: { Accept: "application/json" },
          }),
        );
        if (!Array.isArray(raw.projects)) throw new Error("Invalid catalogue");
        const projects = raw.projects
          .slice(0, 100)
          .map((row) => projectShape(row, sourceUrl.origin))
          .filter(Boolean);
        const result = {
          projects,
          source: {
            url: sourceUrl.href,
            fetchedAt: new Date().toISOString(),
            status: "live",
            bounded: true,
            limit: 100,
            authority: typeof raw.authority === "string" ? raw.authority : null,
          },
        };
        projectsCache = { at: Date.now(), result };
        lastLive = projectsCache;
        return result;
      } catch {
        const result = {
          projects: [],
          source: {
            url: sourceUrl.href,
            fetchedAt: null,
            status: "unavailable",
          },
          error: {
            code: "catalogue_unavailable",
            message: "The live project catalogue is temporarily unavailable.",
          },
        };
        projectsCache = { at: Date.now() - 50_000, result };
        return result;
      }
  }
  const unifiedWork = createUnifiedWork({
    proposals,
    readNative: () => catalogue({ allowStale: true }),
    getManagement: () => {
      const current = management.status();
      return {
        enabled: current.enabled,
        states: current.enabled ? management.sourceStates() : new Map(),
      };
    },
  });
  async function projectDetails(id) {
    if (!sourceUrl)
      fail(
        503,
        "catalogue_unavailable",
        "The live project catalogue is unavailable.",
      );
    const cached = detailCache.get(id);
    if (cached && Date.now() - cached.at < 60_000) return cached.result;
    const projectUrl = new URL(sourceUrl);
    projectUrl.pathname = `${projectUrl.pathname.replace(/\/$/, "")}/${encodeURIComponent(id)}`;
    projectUrl.search = "";
    try {
      const projectResponse = await fetch(projectUrl, {
        signal: AbortSignal.timeout(6000),
        redirect: "error",
        headers: { Accept: "application/json" },
      });
      if (projectResponse.status === 404) {
        await projectResponse.body?.cancel();
        fail(
          404,
          "project_missing",
          "Project not found in the live catalogue.",
        );
      }
      const raw = await boundedJson(projectResponse);
      const base = projectShape(raw, sourceUrl.origin);
      if (!base || base.id !== id)
        fail(
          404,
          "project_missing",
          "Project not found in the live catalogue.",
        );
      let tasks = [],
        tasksAvailable = false;
      try {
        const tasksUrl = new URL(projectUrl);
        tasksUrl.pathname += "/tasks";
        const data = await boundedJson(
          await fetch(tasksUrl, {
            signal: AbortSignal.timeout(6000),
            redirect: "error",
            headers: { Accept: "application/json" },
          }),
        );
        if (Array.isArray(data.tasks)) {
          tasks = data.tasks
            .slice(0, 100)
            .filter(
              (t) =>
                t && typeof t.id === "string" && typeof t.title === "string",
            )
            .map((t) => ({
              id: t.id.slice(0, 160),
              title: t.title.slice(0, 300),
              question: String(t.question ?? "").slice(0, 5000),
              status: String(t.status ?? "unknown").slice(0, 80),
              doneWhen: String(t.done_when ?? "").slice(0, 3000),
              karmaOffered: Number.isFinite(t.karma_offered)
                ? t.karma_offered
                : null,
              kpi: t.kpi ?? null,
              url: `${sourceUrl.origin}/network/live?project=${encodeURIComponent(id)}&tab=tasks`,
            }));
          tasksAvailable = true;
        }
      } catch {}
      const result = {
        project: {
          ...base,
          goal: String(raw.goal ?? raw.done_when ?? raw.summary ?? "").slice(
            0,
            5000,
          ),
          lead: typeof raw.lead === "string" ? raw.lead.slice(0, 200) : null,
          kpi: raw.kpi ?? null,
          progress: raw.progress ?? null,
          stopConditions: Array.isArray(raw.stop_conditions)
            ? raw.stop_conditions
                .slice(0, 20)
                .map((s) => String(s).slice(0, 1000))
            : [],
          ceoChat: { available: false, status: "unavailable" },
          tasks,
          tasksAvailable,
          achievedWork: Array.isArray(raw.contributions)
            ? raw.contributions
                .filter(
                  (c) => c && c.state === "settled" && typeof c.id === "string",
                )
                .slice(0, 20)
                .map((c) => ({
                  id: c.id,
                  title: String(c.title ?? "").slice(0, 300),
                  state: c.state,
                  settledAt: c.settled_at ?? null,
                  url: `${sourceUrl.origin}/network/live?project=${encodeURIComponent(id)}&tab=contributions`,
                }))
            : [],
        },
        source: {
          url: projectUrl.href,
          fetchedAt: new Date().toISOString(),
          status: "live",
          bounded: true,
          authority: typeof raw.authority === "string" ? raw.authority : null,
        },
      };
      if (detailCache.size >= 100)
        detailCache.delete(detailCache.keys().next().value);
      detailCache.set(id, { at: Date.now(), result });
      return result;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      fail(
        503,
        "catalogue_unavailable",
        "The live project details are temporarily unavailable.",
      );
    }
  }
  async function workSource(kind, projectId) {
    if (
      !["proposals", "projects"].includes(kind) ||
      typeof projectId !== "string" ||
      (kind === "proposals"
        ? !/^(OPP|PRB)-\d{5}$/.test(projectId)
        : !/^[a-z0-9][a-z0-9-]{0,159}$/.test(projectId))
    )
      fail(400, "invalid_work_source", "Choose a supported catalogue project.");
    let detail;
    if (kind === "proposals") {
      if (!proposals.available)
        fail(
          503,
          "catalogue_unavailable",
          "The source proposal catalogue is unavailable.",
        );
      detail = proposals.detail(projectId);
      if (!detail) return null;
    } else {
      try {
        detail = await projectDetails(projectId);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    }
    const p = detail.project;
    return {
      kind,
      projectId,
      title: p.title,
      description: p.description,
      category: p.category,
      status: p.status,
      sourceRevision: detail.source?.revision ?? null,
      sourceAuthority:
        kind === "proposals"
          ? "validated-source-proposal"
          : "public-http-projection-not-independent-native-proof",
      sourceUrl: detail.source?.repository ?? detail.source?.url ?? null,
      sourceAvailable: true,
      taskCount:
        Number.isSafeInteger(p.taskCount) && p.taskCount >= 0
          ? p.taskCount
          : null,
    };
  }
  async function authenticate(req, body, requestAudience) {
    const key = decodeBase64(req.headers["x-baink-public-key"], 32);
    const signature = decodeBase64(req.headers["x-baink-signature"], 64);
    const nonce = req.headers["x-baink-nonce"],
      timestamp = req.headers["x-baink-timestamp"];
    const checkedAt = authClock();
    if (
      typeof nonce !== "string" ||
      !/^[A-Za-z0-9_-]{22,128}$/.test(nonce) ||
      typeof timestamp !== "string" ||
      !/^\d{13}$/.test(timestamp) ||
      checkedAt - Number(timestamp) > AUTH_WINDOW ||
      Number(timestamp) - checkedAt > AUTH_FUTURE_SKEW
    )
      fail(401, "invalid_signature", "A fresh member signature is required.");
    const message = canonical({
      audience: requestAudience,
      method: req.method,
      path: req.url,
      body,
      nonce,
      timestamp,
    });
    const publicKey = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, key]),
      format: "der",
      type: "spki",
    });
    if (!verify(null, Buffer.from(message), publicKey, signature))
      fail(401, "invalid_signature", "The member signature is invalid.");
    const memberAddress = `uain1${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
    const registered = store.hasAccount(memberAddress),
      ip = requesterIp(req);
    if (registered) {
      admit(`registered-key:${memberAddress}`, 120, 60_000);
      admit(`registered-ip:${ip}`, 900, 60_000);
    } else {
      admit(`unknown-key:${memberAddress}`, 12, 60_000);
      admit(`unknown-ip:${ip}`, 30, 60_000);
      // A signed lookup of an identity that has no profile cannot change data.
      // Reject it before reserving a durable nonce or copying the store.
      if (
        req.method !== "POST" ||
        new URL(req.url, requestAudience).pathname !== "/api/account"
      )
        fail(404, "account_missing", "Create your BAINK profile to continue.");
      // A body the route would refuse never reserves an unregistered nonce.
      checkAccountBody(body);
      admit(`registration-ip:${ip}`, 240, 3_600_000);
    }
    await store.transactNonces((state) => {
      const now = authClock();
      // The window is checked again here (review of 13 November 2026): a
      // request queued while its signature was fresh may reach this point
      // after its window closed, when its earlier use may already be pruned.
      if (Number(timestamp) + AUTH_WINDOW < now)
        fail(401, "invalid_signature", "A fresh member signature is required.");
      for (const [id, expires] of Object.entries(state.nonces))
        if (expires < now) delete state.nonces[id];
      const id = `${memberAddress}:${nonce}`;
      if (state.nonces[id])
        fail(
          409,
          "replay_detected",
          "This signed operation was already used. Sign a fresh request.",
        );
      const active = Object.keys(state.nonces);
      const own = active.filter((key) => key.startsWith(memberAddress + ":")).length;
      if (own >= (registered ? 128 : 8))
        fail(
          429,
          "member_nonce_limit",
          "Too many outstanding signed operations for this identity. Retry after earlier signatures expire.",
          // The oldest of this identity's signatures expires first.
          { retryAfterSeconds: (Math.min(...active.filter((key) => key.startsWith(memberAddress + ":")).map((key) => state.nonces[key])) - now) / 1000 },
        );
      if (
        !registered &&
        active.filter((key) => !state.accounts[key.slice(0, key.indexOf(":"))])
          .length >= 400
      )
        fail(
          429,
          "registration_busy",
          "New identity admission is busy. Please retry later.",
        );
      if (active.length >= NONCE_HARD_CAP || (active.length >= NONCE_BUSY_AT && own >= NONCE_BUSY_KEY_LIMIT))
        fail(429, "busy", "Please retry later.");
      state.nonces[id] = Number(timestamp) + AUTH_WINDOW;
      return null;
    });
    const principal = { address: memberAddress, publicKey: key.toString("base64") };
    // The exact signed request, kept off enumeration, so a binding step (Trade
    // deal acceptance) can store it as publicly verifiable evidence.
    Object.defineProperty(principal, "signedRequest", {
      value: Object.freeze({ audience: requestAudience, method: req.method, path: req.url, body, nonce, timestamp, signature: signature.toString("base64") }),
      enumerable: false,
    });
    return principal;
  }
  async function publicConfig(requestAudience) {
    const current = await nativeAsset.asset();
    return {
      auth: {
        audience: requestAudience,
        algorithm: "Ed25519",
        scheme: "signed-operations",
        maxAgeMs: AUTH_WINDOW,
      },
      currency: {
        ...assetMetadata(),
        status: current.native.assetStatus,
        provisional: false,
      },
      asset: current.asset,
      native: current.native,
      settlement: current.settlement,
      publicReview: publicReview ? await publicReview.health() : {configured: false, available: false, publicKey: null},
      nativeProjectPilot: nativeProjectPilot.configView(),
      nativeEarning: {
        enabled: nativeEarning.enabled,
        narrowOperations: ["coin_quote", "coin_reserve", "coin_claim"],
      },
      centralEarning: {enabled:centralEarning.enabled,policy:"central-earning-five-kpi-fund-v2",holderOperations:["project_join","central_submit"],allocationIsBalance:false},
      nativePayments: {
        intentsAvailable: true,
        serverSubmissionEnabled: nativePayments.enabled,
        holderSubmissionRequired: true,
        recipientConfirmationRequired: true,
      },
      nativeRegistration: {
        available: nativeEnrol.enabled,
        status: nativeEnrol.enabled
          ? "local_signing_enrolment"
          : "read_only_connection",
        instance: {
          enabled: nativeInstances.enabled,
          operation: "instance_create",
          verification: "server-verified-ledger-and-holder-local-signing",
          startsWorker: false,
          installationVerified: false,
        },
        enrol: {
          enabled: nativeEnrol.enabled,
          operation: "enrol",
          initialLicence: "pending",
          chainId: current.native.proof?.chainId ?? null,
          genesisSha256: current.native.proof?.genesisSha256 ?? null,
        },
      },
      integrations: {
        paperclip: {
          configured: paperclip.configured,
          readOnly: true,
          managerChat: false,
          status: paperclip.configured ? "restricted" : "not-configured",
        },
        smartmeet: {
          configured: smartmeet.configured,
          readOnly: true,
          status: smartmeet.configured ? "restricted" : "not-configured",
        },
      },
      projectManagement: management.status(),
      proposalCatalogue: { available: proposals.available },
      projectFunding: projectFundingReadiness(),
      // Trade for new business (P0-4): open or paused, read by the web menu and clients.
      trade: tradeAvailability.view(),
    };
  }
  async function publicProjects(query) {
    const result = await catalogue({ allowStale: true });
    const search = (query.get("search") ?? "").slice(0, 200).toLowerCase();
    const category = (query.get("category") ?? "").slice(0, 120).toLowerCase();
    const status = (query.get("status") ?? "").slice(0, 80).toLowerCase();
    const all = result.projects.filter(
      (p) =>
        (!search ||
          `${p.title} ${p.description}`.toLowerCase().includes(search)) &&
        (!category ||
          category === "all" ||
          p.category.toLowerCase() === category) &&
        (!status || status === "all" || p.status.toLowerCase() === status),
    );
    const page = Math.min(
      10000,
      Math.max(1, parseInt(query.get("page") ?? "1", 10) || 1),
    );
    const pageSize = Math.min(
      50,
      Math.max(1, parseInt(query.get("pageSize") ?? "12", 10) || 12),
    );
    return {
      ...result,
      projects: all.slice((page - 1) * pageSize, page * pageSize),
      count: all.length,
      page,
      pageSize,
      pages: Math.max(1, Math.ceil(all.length / pageSize)),
    };
  }
  async function currentManagedProject(id, user) {
    if (/^(?:OPP|PRB)-\d{5}$/.test(id)) return management.project(id, user);
    if (options.managementEnabled !== true) return null;
    const source = await catalogue();
    if (source.source.status !== "live")
      fail(
        503,
        "management_source_unavailable",
        "Current native project source is unavailable.",
      );
    const row = source.projects.find((p) => p.id === id);
    if (!row) {
      management.invalidateSource(id);
      return null;
    }
    management.registerProject(row, "native-project-record");
    return management.project(id, user);
  }
  function managedProposals(options = {}) {
    const selected = options.managementStatus ?? "all";
    if (
      !["all", "active", "queued", "stale", "review-required"].includes(
        selected,
      )
    )
      fail(
        400,
        "invalid_management_filter",
        "Choose all, active, queued or stale coordination.",
      );
    const states = selected === "all" ? null : management.sourceStates();
    const enabled = management.status().enabled;
    return proposals.list({
      ...options,
      filterProject: states
        ? (row) => enabled && (states.get(row.id) ?? "queued") === selected
        : undefined,
    });
  }
  const publicTasks = createPublicTasks({ centralEarning, catalogue: proposals });
  const reviewLimit = (value, fallback) => (Number.isInteger(value) && value >= 1 && value <= 100000 ? value : fallback);
  // options.reviewQueue: tests hand in a queue with a fixed answer; the server builds its own otherwise.
  const reviewQueue = options.reviewQueue ?? createReviewQueue({ centralEarning, hourlyLimit: reviewLimit(options.reviewHourlyLimit, 16), dailyLimit: reviewLimit(options.reviewDailyLimit, 128) });
  // The no-install member path (mcp-member.mjs, 11 November 2026): one request the member's
  // own AI signed goes through this server's own request handler, unchanged, as if the kit had
  // sent it: the same signature check, nonce store, per-key and per-IP budgets, eligibility
  // checks and intent records. Only the earning path reaches here (memberPathAllowed).
  async function relayMember({ method, path, body, headers }, outer) {
    const text = method === "POST" ? JSON.stringify(body ?? {}) : "";
    const req = Readable.from(text ? [Buffer.from(text)] : []);
    const host = outer.headers.host;
    Object.assign(req, {
      method,
      url: path,
      socket: outer.socket,
      headers: {
        host,
        origin: origins.find((o) => new URL(o).host === host) ?? audience,
        "user-agent": "baink-mcp-relay/1",
        ...(text ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) } : {}),
        ...(typeof outer.headers["x-real-ip"] === "string" ? { "x-real-ip": outer.headers["x-real-ip"] } : {}),
        ...headers,
      },
    });
    const captured = {}, chunks = [];
    let ended = false;
    const res = {
      statusCode: 200, headersSent: false, destroyed: false,
      setHeader(k, v) { captured[k.toLowerCase()] = v; return res; },
      getHeader(k) { return captured[k.toLowerCase()]; },
      removeHeader(k) { delete captured[k.toLowerCase()]; },
      writeHead(status, h = {}) { res.statusCode = status; for (const [k, v] of Object.entries(h)) captured[k.toLowerCase()] = v; res.headersSent = true; return res; },
      // A route that waits on the proof queue extends the caller's own connection, as it would for the kit.
      setTimeout(ms) { outer.socket?.setTimeout?.(ms); return res; },
      end(data) { if (data) chunks.push(Buffer.from(data)); res.headersSent = true; ended = true; return res; },
      destroy() { res.destroyed = true; },
    };
    await handleRequest(req, res);
    if (!ended) throw new Error("relay_unanswered");
    let parsed = null;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
    const retry = Number(captured["retry-after"]);
    return { status: res.statusCode, body: parsed, ...(Number.isFinite(retry) && retry > 0 ? { retryAfter: retry } : {}) };
  }
  const mcp = createBainkMcp({
    reviewQueue,
    tradeAvailability,
    origins,
    admit,
    requesterIp,
    forward: relayMember,
    async read(name, args, requestAudience) {
      if (name === "baink_status") return publicConfig(requestAudience);
      if (name === "baink_tasks") {
        // An unreadable list is refused as "could not be read", never shown as an empty list.
        const list = await publicTasks.list(args);
        return list.status === "available" ? list : { ...list, source: { status: "unavailable" } };
      }
      if (name === "baink_contribution") {
        // The same view as GET /api/public/contribution/<address>, with its plain lines.
        const view = await centralEarning.contribution(args.address);
        return view ? { ...view, summary: contributionLines(view) } : { source: { status: "unavailable" } };
      }
      if (name === "baink_funding_policy") return projectFundingReadiness();
      if (name === "baink_projects")
        return args.id
          ? projectDetails(args.id)
          : publicProjects(new URLSearchParams(args));
      if (name === "baink_proposals") {
        if (!proposals.available) return { source: { status: "unavailable" } };
        const result = args.id
          ? proposals.detail(args.id)
          : managedProposals(args);
        if (!result) throw new Error("Source unavailable");
        return management.decorate(proposalPages.decorate(result));
      }
      if (name === "baink_work_source")
        return workSelections.review(args.kind, args.projectId);
      if (name === "baink_members") {
        const { address, ...query } = args;
        return address
          ? memberDirectory.get(address, query)
          : memberDirectory.list(query);
      }
      if (name === "baink_profiles") {
        const { address, ...query } = args;
        return address ? profiles.get(address) : profiles.list(query);
      }
      if (name === "baink_trade_offers") return trade.list(args);
      if (name.startsWith("baink_trade_")) {
        const { id, address, ...query } = args;
        if (name === "baink_trade_feed") return tradeDeals.feed(query);
        if (name === "baink_trade_deals") return id ? tradeDeals.detail(id) : tradeDeals.list(query);
        if (name === "baink_trade_disputes") return id ? tradeDeals.dispute(id) : tradeDeals.disputes(query);
        if (name === "baink_trade_decisions") return tradeDeals.decisions(query);
        if (name === "baink_trade_member") return tradeDeals.member(address);
        if (name === "baink_trade_policy") return { policy: tradeDeals.policy(), ...tradeDeals.stewards(), availability: tradeAvailability.view(), attention: tradeDeals.attention() };
        if (name === "baink_trade_public_terms") {
          if (query.offerId && !query.enquiryId) return tradeDeals.publicEnquiries(query);
          if (query.enquiryId && !query.offerId) return tradeDeals.publicProposals(query);
          throw new Error("Give offerId or enquiryId");
        }
      }
      throw new Error("Unsupported public reader");
    },
  });
  // Route groups by change boundary. Each group answers in up to three
  // phases: public (no signature), private (verified principal, account not
  // yet required) and member (verified principal with a local account). Every
  // group's patterns are disjoint from every other group's, so the order of
  // groups never decides which handler answers; within a group the original
  // matching order is kept. The phase boundaries (signature before private,
  // account before member) are the order that matters, and live here.
  const routeGroups = [
    // First: other groups' private phases may refuse unknown paths early.
    {
      name: "campaigns",
      isPrivate: ({ method, path }) => method === "GET" && path === "/api/campaigns/report",
      async private(ctx) {
        if (ctx.method !== "GET" || ctx.path !== "/api/campaigns/report") return;
        only(ctx.query(), []);
        if (!campaignOperators.has(ctx.user.address))
          fail(404, "not_found", "The requested API operation does not exist.");
        return ctx.send(200, await campaigns.report({ acceptedTask: campaignKarma }));
      },
    },
    createPublicRoutes({ publicConfig, centralEarning, publicTasks, reviewQueue,
      // The public contribution read costs proved reads: 30 a minute for each address asking.
      admitPublic: (ctx) => admit(`public-contribution-ip:${requesterIp(ctx.req)}`, 30, 60_000) }),
    createIdentityRoutes({
      store, nativeAsset, accountBatchingEnabled, profiles, endorsements,
      memberDirectory, nativeResearch, messages, campaigns,
    }),
    createWorkRoutes({
      store, publicReview, reviewCall, publicProjects, projectDetails,
      unifiedWork, workSelections, nativeWorkClaim, nativeWorkCurrent,
      nativeProjectPilot, nativeBountyMaterials, centralEarning,
    }),
    createTradeRoutes({
      store, trade, tradeTerms, tradePayments, nativeAsset, nativePayments, tradeDeals, tradeAvailability,
    }),
    createTradeDealRoutes({ tradeDeals, tradeAvailability }),
    createWalletRoutes({
      nativeAsset, nativeEarning, nativePayments, nativeInstances, nativeEnrol,
    }),
    createSendRoutes({ serverSend }),
    createManagementRoutes({
      options, store, management, proposals, proposalPages, managedProposals,
      currentManagedProject, initialProjectTasks, organizationsStatus,
      paperclip, disconnectedPaperclip, operationsViewers,
      operationsNativeLeads, nativeProjectAccess, smartmeet, smartmeetMembers,
    }),
  ];
  const semverLess = (a, b) => {
    const x = a.split(".").map(Number), y = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
    return false;
  };
  const minKitVersion = /^\d+\.\d+\.\d+$/.test(options.minKitVersion ?? "") ? options.minKitVersion : null;
  let latestKitVersion = /^\d+\.\d+\.\d+$/.test(options.latestKitVersion ?? "") ? options.latestKitVersion : null;
  async function route(ctx) {
    for (const group of routeGroups)
      if (await group.public?.(ctx)) return;
    if (!routeGroups.some((group) => group.isPrivate?.(ctx)))
      fail(404, "not_found", "The requested API operation does not exist.");
    ctx.user = await authenticate(ctx.req, ctx.body, ctx.requestAudience);
    for (const group of routeGroups)
      if (await group.private?.(ctx)) return;
    if (!store.hasAccount(ctx.user.address))
      fail(404, "account_missing", "Create your BAINK profile to continue.");
    for (const group of routeGroups)
      if (await group.member?.(ctx)) return;
    fail(404, "not_found", "The requested API operation does not exist.");
  }
  const staticDir = resolve(
    options.staticDir ?? new URL("../dist/", import.meta.url).pathname,
  );
  // The activated release (/opt/baink/releases/<id>/server/app.mjs; ESM resolves the
  // /opt/baink/current symlink), so an open tab can tell that a new release replaced its code.
  const releaseId =
    /\/releases\/([0-9]{8}T[0-9]{6}Z-[0-9a-f]{10})\/server\//.exec(new URL(import.meta.url).pathname)?.[1] ??
    (/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{10}$/.test(process.env.BAINK_RELEASE ?? "") ? process.env.BAINK_RELEASE : "development");
  const securityHeaders = {
    "X-BAINK-Release": releaseId,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    // 13 November 2026 (LV-2): browsers only take HSTS over HTTPS, so a local
    // http://127.0.0.1 run is unaffected.
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    // 13 November 2026 (FE-3): the web app no longer calls the retired
    // loopback holder (127.0.0.1:8848/18848/18849) and loads images only from
    // itself or data: (its icon), so connect-src and img-src are narrowed.
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  };
  let activeRequests = 0;
  let activeNativeAccountRequests = 0;
  const activeClients = new Map();
  async function handleRequest(req, res) {
      for (const [key, value] of Object.entries(securityHeaders))
        res.setHeader(key, value);
      const client = clientBucket(requesterIp(req));
      const clientRequests = activeClients.get(client) ?? 0;
      if (clientRequests >= 16) {
        sendError(res, 429, "client_busy", "Too many concurrent requests. Retry shortly.");
        return;
      }
      let nativeAccountRead = false;
      if (["GET", "PATCH"].includes(req.method) && (req.url?.length ?? 0) <= 2048) {
        try {
          const pathname=new URL(req.url,audience).pathname;
          nativeAccountRead=(accountBatchingEnabled&&pathname==="/api/account")||(req.method==="GET"&&(/^\/api\/native\/central\/(?:status|tasks|awards)$/.test(pathname)||/^\/api\/public\/contribution\/uain1[a-f0-9]{40}$/.test(pathname)||/^\/api\/native\/central\/(?:tasks|submissions)\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(pathname)));
        } catch {}
      }
      // Native proof reads wait seconds in the bounded proof queues. They have
      // their own 48 slots (10 November 2026), so a queue of proof reads can no
      // longer fill the 64 slots that pages, store reads, writes and health use;
      // the 10 November burst test saw it refuse every route with 503 busy.
      if (nativeAccountRead ? activeNativeAccountRequests >= 48 : activeRequests >= 64) {
        sendError(res, 503, "busy", "The service is busy. Please retry shortly.");
        return;
      }
      if (nativeAccountRead) activeNativeAccountRequests++;
      else activeRequests++;
      activeClients.set(client, clientRequests + 1);
      try {
        if ((req.url?.length ?? 0) > 2048)
          fail(414, "url_too_long", "The request URL is too long.");
        const requestAudience =
          (origins.includes(req.headers.origin) ? req.headers.origin : null) ??
          origins.find((value) => new URL(value).host === req.headers.host) ??
          audience;
        // Recognize this namespace before WHATWG URL dot/backslash normalization.
        // A malformed proposal path must not turn into a successful SPA request.
        const rawPath = req.url
          .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "")
          .split(/[?#]/)[0];
        let decodedRawPath;
        try {
          decodedRawPath = decodeURIComponent(rawPath);
        } catch {
          fail(400, "invalid_url", "Invalid request URL.");
        }
        const rawNamespace = decodedRawPath.replaceAll("\\", "/");
        if (
          (rawNamespace === "/proposals" ||
            rawNamespace.startsWith("/proposals/")) &&
          (decodedRawPath !== rawPath ||
            decodedRawPath.includes("\\") ||
            decodedRawPath
              .split("/")
              .some((part) => part === "." || part === ".."))
        )
          fail(404, "proposal_missing", "Source proposal not found.");
        const url = new URL(req.url, requestAudience);
        if (url.origin !== requestAudience)
          fail(400, "invalid_url", "Invalid request URL.");
        if (["/mcp", "/MCP"].includes(url.pathname))
          return await mcp(req, res, url);
        if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
          if (await admin(req, res, url, requestAudience)) return;
          fail(404, "not_found", "Page not found.");
        }
        if (url.pathname.startsWith("/api/")) {
          // uain-agent kits identify themselves. The version check comes before the origin check
          // (10 November 2026): an old kit whose saved address is not an allowed origin got
          // "origin_forbidden" and never learned it only had to update. It answers only an error
          // that names the public download address, so no data passes the origin check early.
          // Reads from a kit older than the configured minimum get a plain upgrade message (old
          // kits print server messages as-is); writes and reconciles still pass so a step
          // already in flight can settle.
          if (latestKitVersion) res.setHeader("x-uain-agent-latest", latestKitVersion);
          const kitVersion = /^uain-agent\/(\d+\.\d+\.\d+)$/.exec(req.headers["user-agent"] ?? "")?.[1];
          if (kitVersion && minKitVersion && req.method === "GET" && semverLess(kitVersion, minKitVersion))
            fail(
              426,
              "kit_outdated",
              `This uain-agent kit (${kitVersion}) is out of date; ${minKitVersion} or later is needed. Download the latest (your saved key and steps are kept): curl -fsSLO ${requestAudience}/uain-agent.mjs, then run node uain-agent.mjs next.`,
            );
          // The public review-queue figure is read by other sites too (uain.global's /status page):
          // unsigned, no cookies, the same answer for everyone, so any origin may read it.
          const openRead =
            url.pathname === "/api/public/review-queue" &&
            ["GET", "HEAD", "OPTIONS"].includes(req.method);
          if (openRead) {
            res.setHeader("Access-Control-Allow-Origin", "*");
            if (req.method === "OPTIONS") {
              res.writeHead(204, {
                "Access-Control-Allow-Methods": "GET",
                "Access-Control-Max-Age": "86400",
                "Content-Length": 0,
              });
              res.end();
              return;
            }
          }
          if (!openRead && req.headers.origin && !origins.includes(req.headers.origin))
            fail(403, "origin_forbidden", "This origin is not allowed.");
          if (!openRead && req.headers["sec-fetch-site"] === "cross-site")
            fail(
              403,
              "origin_forbidden",
              "Cross-site requests are not allowed.",
            );
          const body = await readBody(req, bodyLimitFor(req.method, url.pathname));
          return await route(
            createRequestContext({ req, res, url, body, requestAudience }),
          );
        }
        if (!["GET", "HEAD"].includes(req.method))
          fail(405, "method_not_allowed", "Use GET for this page.");
        let pathname;
        try {
          pathname = decodeURIComponent(url.pathname);
        } catch {
          fail(400, "invalid_url", "Invalid request URL.");
        }
        if (pathname.includes("\0"))
          fail(400, "invalid_url", "Invalid request URL.");
        if (pathname.split("/").some((part) => part.startsWith(".")))
          fail(404, "not_found", "File not found.");
        const goPath = pathname.match(/^(\/uain)?\/go\/([^/]*)(?:\/llms\.txt)?\/?$/);
        if (goPath) {
          await readBody(req);
          // A person's browser gets a page; agents and tools get the text guide (docs/campaigns.md).
          // /go/<code>/llms.txt is always text. /uain/go/<code> is uain.global/go/<code>: same code
          // and count, UAIN's guide and page, links on uain.global.
          const uainGo = Boolean(goPath[1]);
          const html = !pathname.endsWith("/llms.txt") && wantsHtml(req.headers);
          const view = await campaigns.view(CAMPAIGN_CODE.test(goPath[2]) ? goPath[2] : null, { network: uainGo ? "uain" : "baink", bot: isLinkBot(req.headers, req.method) });
          const site = uainGo ? uainOrigin : requestAudience;
          const link = view.code ? `${site}/go/${view.code}/llms.txt` : `${site}/llms.txt`;
          const body = html
            ? (uainGo ? renderUainGoPage({ link, guide: view.text, home: uainOrigin }) : renderGoPage({ link, guide: view.text, home: requestAudience }))
            : view.text;
          res.writeHead(200, {
            "Content-Type": html ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
            "Content-Length": Buffer.byteLength(body),
            "Cache-Control": "public, max-age=60",
            Vary: "Accept, Sec-Fetch-Mode, Sec-Fetch-Dest, User-Agent, Signature-Agent",
            "X-Robots-Tag": "noindex",
            ...(html ? { "Content-Security-Policy": GO_PAGE_CSP } : {}),
          });
          return res.end(req.method === "HEAD" ? undefined : body);
        }
        if (pathname === "/proposals" || pathname.startsWith("/proposals/")) {
          if (pathname !== url.pathname)
            fail(404, "proposal_missing", "Source proposal not found.");
          await readBody(req);
          const entries = [...url.searchParams];
          if (
            entries.length > 1 ||
            (entries.length === 1 &&
              (entries[0][0] !== "format" || entries[0][1] !== "json"))
          )
            fail(
              400,
              "invalid_query",
              "Only format=json is supported for this document.",
            );
          const json = entries.length === 1;
          const documentNavigation =
            req.headers["sec-fetch-mode"] === "navigate" &&
            req.headers["sec-fetch-dest"] === "document";
          if (
            json &&
            ((req.headers.origin && !origins.includes(req.headers.origin)) ||
              (req.headers["sec-fetch-site"] === "cross-site" &&
                !documentNavigation))
          )
            fail(403, "origin_forbidden", "This origin is not allowed.");
          const result = proposalPages.resolve(pathname);
          if (result.status === 503)
            fail(
              503,
              "catalogue_unavailable",
              "The source-proposal catalogue is unavailable or has not passed validation.",
            );
          if (result.status === 404)
            fail(404, "proposal_missing", "Source proposal not found.");
          res.setHeader("X-Robots-Tag", "noindex");
          if (result.status === 308) {
            res.writeHead(308, {
              Location: result.location + (json ? "?format=json" : ""),
              "Cache-Control": "no-store",
            });
            return res.end();
          }
          const model = result.model;
          res.setHeader(
            "Link",
            `<${model.canonicalUrl}>; rel="canonical", <${model.jsonUrl}>; rel="alternate"; type="application/json"`,
          );
          res.setHeader("ETag", `"${model.document.revision}"`);
          if (json) return response(res, 200, model.document);
          const html = renderProposalPage(model);
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Length": Buffer.byteLength(html),
            "Cache-Control": "no-store",
            "Content-Security-Policy":
              "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
          });
          return res.end(req.method === "HEAD" ? undefined : html);
        }
        // The no-install signer (shared/uain_signer.py) and its checksum, from the server's own copy.
        if (pathname === "/uain_signer.py" || pathname === "/uain_signer.py.sha256") {
          const text = pathname.endsWith(".sha256") ? `${SIGNER.sha256}  uain_signer.py\n` : SIGNER.text;
          res.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Length": Buffer.byteLength(text),
            "Cache-Control": "no-cache",
          });
          return res.end(req.method === "HEAD" ? undefined : text);
        }
        let file = resolve(staticDir, `.${pathname}`);
        if (file !== staticDir && !file.startsWith(staticDir + sep))
          fail(404, "not_found", "Page not found.");
        let info;
        try {
          info = await stat(file);
        } catch {}
        if (!info?.isFile()) {
          if (extname(pathname)) fail(404, "not_found", "File not found.");
          file = join(staticDir, "index.html");
        }
        // Reject symlinks escaping the built application directory.
        const actual = await realpath(file).catch(() => null);
        const root = await realpath(staticDir).catch(() => null);
        if (!actual || !root || !actual.startsWith(root + sep))
          fail(
            503,
            "frontend_unavailable",
            "The BAINK frontend has not been built.",
          );
        const content = await readFile(actual);
        const types = {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".mjs": "text/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".ico": "image/x-icon",
          ".woff2": "font/woff2",
          ".txt": "text/plain; charset=utf-8",
          ".json": "application/json",
          ".sha256": "text/plain; charset=utf-8",
        };
        // The unversioned kit, its checksum and the pointer change at a release, so nobody may keep an old
        // copy of one beside a new copy of another; a versioned kit file never changes.
        const kitLatest = ["/uain-agent.mjs", "/uain-agent.mjs.sha256", "/kit/latest.json"].includes(pathname);
        const kitVersioned = /^\/kit\/uain-agent-\d+\.\d+\.\d+\.mjs(\.sha256)?$/.test(pathname);
        res.writeHead(200, {
          "Content-Type": types[extname(actual)] ?? "application/octet-stream",
          "Content-Length": content.length,
          "Cache-Control":
            extname(actual) === ".html" || kitLatest ? "no-cache" : kitVersioned ? "public, max-age=31536000, immutable" : "public, max-age=3600",
        });
        res.end(req.method === "HEAD" ? undefined : content);
      } catch (error) {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        const shaped = shapeError(error, KNOWN_ERRORS);
        if (!shaped.known) options.onError?.(error);
        // One log line with the reason for every central proof refusal (the
        // status read already reports its own, with more detail), and a wait
        // hint. X-BAINK-Proof-Reason tells clients whether the chain could not
        // answer (a paused node or busy reader: wait about two minutes) or a
        // proof answered but did not check out (try again in 30 seconds). The
        // body is unchanged.
        const proofRefusal = centralProofRefusal(error);
        if (proofRefusal) {
          if (!proofRefusal.reported) {
            let route = "unknown";
            try { route = new URL(req.url, audience).pathname; } catch {}
            const event = Object.freeze({ schema: "uain-central-proof-refusal-v1", operation: `${req.method} ${route}`, category: proofRefusal.category });
            try { Promise.resolve(options.onCentralProofRefusal?.(event)).catch(() => {}); } catch {}
          }
          res.setHeader("X-BAINK-Proof-Reason", proofRefusal.chainUnavailable ? "chain-unavailable" : "proof-check");
          res.setHeader("Retry-After", proofRefusal.chainUnavailable ? "120" : "30");
        }
        // Every 429/503 carries Retry-After, error.retryAfterSeconds and error.next.
        const wait = proofRefusal ? (proofRefusal.chainUnavailable ? 120 : 30) : shaped.known ? error.retryAfterSeconds : undefined;
        response(res, shaped.status, withRetryHint(res, shaped.status, shaped.body, wait));
      } finally {
        if (nativeAccountRead) activeNativeAccountRequests--;
        else activeRequests--;
        const remaining = activeClients.get(client) - 1;
        if (remaining) activeClients.set(client, remaining);
        else activeClients.delete(client);
      }
  }
  const server = createServer(
    {
      requestTimeout: 15_000,
      headersTimeout: 10_000,
      connectionsCheckingInterval: 1000,
    },
    handleRequest,
  );
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 40;
  server.setTimeout(10_000, (socket) => socket.destroy());
  return {
    server,
    async close() {
      if (server.listening) {
        await new Promise((r, j) => server.close((e) => (e ? j(e) : r())));
      }
      if (managementTimer) clearInterval(managementTimer);
      if (serverSendTimer) clearInterval(serverSendTimer);
      if (sequenceFenceTimer) clearInterval(sequenceFenceTimer);
      if (tradeDealTimer) clearInterval(tradeDealTimer);
      await campaigns.close();
      while (managementCycling) await new Promise((r) => setTimeout(r, 10));
      management.close();
      await publicReview?.close();
      await nativeAsset.close();
      await store.close();
    },
  };
}

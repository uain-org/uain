import { createBainkServer } from "./app.mjs";
import { nativeConfigFromEnv } from "./native-asset.mjs";
import { paperclipConfigFromEnv } from "../integrations/paperclip-api.mjs";
import { nativeProjectLeadsFromEnv } from "./native-project-access.mjs";
import { organizationsStatusFromEnv } from "./organizations-status.mjs";
import { readFileSync as readKitFile } from "node:fs";
import { join as joinKitPath } from "node:path";
/** The VERSION of the kit this deployment serves, so responses can name the latest kit. */
function kitVersionFromStatic(dir) {
  for (const path of [dir && joinKitPath(dir, "uain-agent.mjs"), new URL("../dist/uain-agent.mjs", import.meta.url).pathname, new URL("../agent-kit/uain-agent.mjs", import.meta.url).pathname].filter(Boolean)) {
    try { const m = /const VERSION = '(\d+\.\d+\.\d+)'/.exec(readKitFile(path, "utf8")); if (m) return m[1]; } catch { /* try the next location */ }
  }
  return null;
}
let nativeProjectPilotConfig = null;
if (process.env.BAINK_NATIVE_PROJECT_PILOT_JSON) {
  try { nativeProjectPilotConfig = JSON.parse(process.env.BAINK_NATIVE_PROJECT_PILOT_JSON); }
  catch { throw new Error("Invalid native project pilot configuration."); }
}
let paperclipViewers = {};
try {
  if (process.env.BAINK_PAPERCLIP_VIEWERS_JSON)
    paperclipViewers = JSON.parse(process.env.BAINK_PAPERCLIP_VIEWERS_JSON);
} catch {
  throw new Error("Invalid project viewer configuration.");
}

// No-install sending (off unless BAINK_SERVER_SEND_ENABLED=1). First rollout:
// BAINK_SERVER_SEND_ALLOWED_MEMBERS lists our own test accounts (N7).
let serverSendConfig = null;
if (process.env.BAINK_SERVER_SEND_ENABLED === "1") {
  const allowed = (process.env.BAINK_SERVER_SEND_ALLOWED_MEMBERS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  serverSendConfig = {
    coinWallet: { executable: process.env.BAINK_SERVER_SEND_COIN_WALLET, executableSha256: process.env.BAINK_SERVER_SEND_COIN_WALLET_SHA256 },
    workDirectory: process.env.BAINK_SERVER_SEND_WORK_DIR,
    rpc: process.env.BAINK_SERVER_SEND_RPC ?? process.env.BAINK_NATIVE_RPC,
    allowedMembers: process.env.BAINK_SERVER_SEND_ALLOW_ALL === "1" ? null : allowed,
  };
  if (!serverSendConfig.coinWallet.executable || !/^[a-f0-9]{64}$/.test(serverSendConfig.coinWallet.executableSha256 ?? "") || !serverSendConfig.workDirectory || !serverSendConfig.rpc)
    throw new Error("Invalid server send configuration.");
}
const port = Number(process.env.BAINK_PORT ?? process.env.PORT ?? 8798);
const host = process.env.BAINK_HOST ?? "127.0.0.1";
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("BAINK_PORT must be a valid TCP port.");
const app = await createBainkServer({
  dataDir: process.env.BAINK_DATA_DIR,
  managementEnabled: process.env.BAINK_MANAGEMENT_ENABLED === "1",
  managementPlansFile: process.env.BAINK_MANAGEMENT_PLANS_FILE,
  publicOrigin: process.env.BAINK_PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`,
  publicOrigins: process.env.BAINK_PUBLIC_ORIGINS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  trustProxy: process.env.BAINK_TRUST_PROXY === "1",
  nativeConfig: nativeConfigFromEnv(process.env),
  nativeStateSSHEnabled: process.env.BAINK_NATIVE_STATE_SSH_ENABLED === "1",
  nativeAccountBatchingEnabled: process.env.BAINK_NATIVE_ACCOUNT_BATCHING_ENABLED === "1",
  paperclipConfig: paperclipConfigFromEnv(process.env),
  paperclipViewers,
  paperclipNativeLeads: nativeProjectLeadsFromEnv(process.env),
  organizationsStatus: organizationsStatusFromEnv(process.env),
  nativeProjectPilotEnabled: process.env.BAINK_NATIVE_PROJECT_PILOT_ENABLED === "1",
  nativeProjectPilotConfig,
  nativeInstanceEnabled: process.env.BAINK_NATIVE_INSTANCE_ENABLED === "1",
  publicReviewEnabled: process.env.BAINK_PUBLIC_REVIEW_ENABLED === "1",
  publicReviewWorkerKeyFile: process.env.BAINK_PUBLIC_REVIEW_WORKER_KEY_FILE,
  nativeEarningEnabled: process.env.BAINK_NATIVE_EARNING_ENABLED === "1",
  centralEarningEnabled: process.env.BAINK_CENTRAL_EARNING_ENABLED === "1",
  serverSendEnabled: serverSendConfig !== null,
  serverSendConfig,
  centralTaskRequirementsFile: process.env.BAINK_CENTRAL_TASK_REQUIREMENTS_FILE ?? null,
  nativeBountyMaterialsFile: process.env.BAINK_NATIVE_BOUNTY_MATERIALS_FILE ?? null,
  nativeEnrolEnabled: process.env.BAINK_NATIVE_ENROL_ENABLED === "1",
  minKitVersion: process.env.BAINK_MIN_KIT_VERSION ?? null,
  // The central reviewer's own limits, shown in the public review queue figure (review-queue.mjs).
  reviewHourlyLimit: process.env.BAINK_REVIEW_HOURLY_LIMIT ? Number(process.env.BAINK_REVIEW_HOURLY_LIMIT) : undefined,
  reviewDailyLimit: process.env.BAINK_REVIEW_DAILY_LIMIT ? Number(process.env.BAINK_REVIEW_DAILY_LIMIT) : undefined,
  latestKitVersion: kitVersionFromStatic(process.env.BAINK_STATIC_DIR),
  projectsSource:
    process.env.BAINK_PROJECTS_SOURCE === ""
      ? null
      : process.env.BAINK_PROJECTS_SOURCE,
  staticDir: process.env.BAINK_STATIC_DIR,
  catalogueDir: process.env.BAINK_CATALOGUE_DIR,
  smartmeetApiOrigin: process.env.BAINK_SMARTMEET_API_ORIGIN,
  smartmeetApiKey: process.env.BAINK_SMARTMEET_API_KEY,
  smartmeetMemberAddresses: process.env.BAINK_SMARTMEET_MEMBER_ADDRESSES?.split(
    ",",
  )
    .map((value) => value.trim())
    .filter(Boolean),
  // UAIN trade stewards (dispute and stuck-trade agents) and central appeal
  // reviewers: comma-separated UAIN addresses of their own BAINK identities.
  tradeStewardAddresses: (process.env.BAINK_TRADE_STEWARD_ADDRESSES ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean),
  // Who may read GET /api/campaigns/report: comma-separated UAIN addresses.
  campaignOperatorAddresses: (process.env.BAINK_CAMPAIGN_OPERATOR_ADDRESSES ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean),
  tradeAppealReviewerAddresses: (process.env.BAINK_TRADE_APPEAL_REVIEWER_ADDRESSES ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean),
  // Trade for new business (P0-4, 12 November 2026): BAINK_TRADE_MODE=open
  // reopens it. Unset, empty or anything else is paused (trade-availability.mjs).
  tradeMode: process.env.BAINK_TRADE_MODE,
  onCentralProofRefusal: (event) => console.error("BAINK central proof refused:", JSON.stringify(event)),
  onError: (error) =>
    console.error("BAINK operation failed:", error.code ?? error.name),
  // The state writer died (13 November 2026): exit non-zero so systemd
  // (Restart=on-failure) restarts BAINK on its durable rows, instead of
  // answering storage_unavailable to every member until someone restarts it.
  // Only SQLite-committed writes were ever acknowledged, so none is lost.
  onStoreFailure: (error) => {
    console.error(JSON.stringify({ bainkStore: { event: "state_writer_stopped", message: error?.message ?? String(error) } }));
    process.exit(70);
  },
});
app.server.listen(port, host, () =>
  console.log(`BAINK listening on ${host}:${port}`),
);
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    process.exitCode = 0;
  });

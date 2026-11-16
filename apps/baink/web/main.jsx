import { centralTaskOpen } from "./central-task-actions.js";
import { useReleaseBusy } from "./release-busy.js";
import ReleaseUpdateNotice, { ReleaseChunkBoundary } from "./ReleaseUpdateNotice.jsx";
import { createReleaseWatcher, WRITE_ACTIVITY, writeActivity, reloadBlocked } from "./release-update.js";
import React, { useEffect, useRef, useState, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUpRight,
  ArrowRight,
  ArrowLeft,
  ArrowDownLeft,
  ArrowUp,
  ArrowDown,
  Globe2,
  ShieldCheck,
  KeyRound,
  Wallet,
  LayoutDashboard,
  Pickaxe,
  Send,
  Download,
  ReceiptText,
  LogOut,
  Copy,
  Check,
  X,
  Plus,
  Search,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ExternalLink,
  LoaderCircle,
  Menu,
  Activity,
  LockKeyhole,
  FileKey2,
  RefreshCw,
  Video,
  CheckCircle2,
  AlertCircle,
  Layers,
  Command,
  Target,
  Building2,
  Pause,
  Play,
  Users,
  UserRound,
} from "lucide-react";
import "@fontsource/manrope/latin-400.css";
import "@fontsource/manrope/latin-500.css";
import "@fontsource/manrope/latin-600.css";
import "@fontsource/manrope/latin-700.css";
import "@fontsource/space-grotesk/latin-400.css";
import "@fontsource/space-grotesk/latin-500.css";
import "@fontsource/space-grotesk/latin-600.css";
import "@fontsource/space-grotesk/latin-700.css";
import { decimalToUnits, formatAmount } from "./exact-amount.js";
import {
  nativeProofFreshness,
  clearNativeAuthority,
  watchNativeProof,
} from "./native-balance.js";
import {
  createAccountEntryLoader,
  createNativeAccountRefresh,
  hydrateAccountActivity,
  accountBalanceView,
  initialActivityReadiness,
  reduceActivityReadiness,
  activityReadView,
} from "./account-bootstrap.js";
import { presentationBalance } from "./balance-presentation.js";
import { createPaymentIntent } from "./payment-intent.js";
import {
  reviewWorkSource,
  createWorkSelectionIntent,
  selectionProject,
  createWorkReviewGate,
  selectionForProject,
  loadWorkSelectionIndex,
} from "./work-intent.js";
import {
  api,
  cancelIdentityRequests,
  createIdentity,
  importIdentity,
  importIdentityPair,
  exportIdentity,
} from "./identity.js";
import { createIdentitySessionGate } from "./identity-session.js";
import { encryptIdentityBackup, decryptIdentityBackup, isIdentityBackup, identityBackupAddress, accountBackupProblem, MIN_PASSPHRASE } from "./identity-backup.js";
import { createIdentitySession } from "./persistent-identity.js";
import "./style.css";
import NativeMembership from "./NativeMembership.jsx";
import NativeInstance from "./NativeInstance.jsx";
import NativeProjectPilot from "./NativeProjectPilot.jsx";
import ServerSendPay from "./ServerSendPay.jsx";
import NativeEarning from "./NativeEarning.jsx";
import CentralEarning from "./CentralEarning.jsx";
import RefreshCue from "./RefreshCue.jsx";
import NextSteps from "./NextSteps.jsx";
import { createRefreshLoop } from "./refresh-loop.js";
import { PAID_WORK_NOTE, overviewEarningStep, overviewNote, overviewStepsSummary, paidWorkText } from "./earning-copy.js";
import { contributionDisplay } from "./contribution-display.js";
import { loadOpenTasks } from "./central-submission-status.js";
import { historyText } from "./plain-labels.js";
import { PAYMENT_REQUEST_LOCKED_TEXT, paymentLocksFromRequests, requestRowView, requestStatusLabel } from "./payment-request-status.js";
import TradePaymentReview from "./TradePaymentReview.jsx";
import { TRADE_PAUSED_NOTICE, readOpenDeal, tradeNavigation, tradePaused, tradePauseSentence, tradeShortcut } from "./trade-availability.js";
import {
  MemberWorkspace,
  TradeWorkspace,
  PublicProfile,
} from "./PeerWorkspace.jsx";
import {
  parseWorkspaceRoute,
  resolveWorkspaceRoute,
  routeForTab,
  workspaceUrl,
} from "./workspace-route.js";
import { SMARTMEET_PRODUCT } from "../integrations/smartmeet.mjs";
const Landing = lazy(() => import("./Landing.jsx"));
const short = (v) => (v ? `${v.slice(0, 10)}…${v.slice(-6)}` : "Unavailable");
const money = (value) => {
  try {
    return formatAmount(value);
  } catch {
    return "—";
  }
};
// Dates show the time too (plain-language pass, 10 Nov 2026).
const date = (v) => {
  const d = v ? new Date(v) : null;
  return d && Number.isFinite(d.getTime())
    ? d.toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
};
const getText = (v) =>
  typeof v === "string"
    ? v
    : Array.isArray(v)
      ? v.map(getText).filter(Boolean).join(" · ")
      : v && typeof v === "object"
        ? v.title ||
          v.label ||
          v.name ||
          v.description ||
          Object.entries(v)
            .filter(([, value]) => value != null)
            .map(
              ([key, value]) =>
                `${key.replaceAll("_", " ")}: ${getText(value)}`,
            )
            .join(" · ")
        : v == null
          ? ""
          : String(v);
// Five places in the sidebar; each groups one or more workspace tabs.
const navigation = [
  ["Overview", LayoutDashboard, ["Dashboard"]],
  ["Work", Target, ["Mine money"]],
  ["Network & Trade", Users, ["Trade", "Profile"]],
  [
    "Wallet & Activity",
    Wallet,
    ["Incoming requests", "Request money", "Send money", "Transactions"],
  ],
  ["Account", ShieldCheck, ["Security", "Settings", "Meetings"]],
];
const tabLabels = {
  "Mine money": "Paid tasks",
  Trade: "Trade",
  Profile: "Profile & directory",
  "Incoming requests": "Incoming",
  "Request money": "Request",
  "Send money": "Send",
  Transactions: "Activity",
  Security: "Identity & security",
  Settings: "Settings",
  Meetings: "Meetings",
};
const groupOf = (tab) =>
  navigation.find(([, , tabs]) => tabs.includes(tab)) || navigation[0];
function Logo({ light = false }) {
  return (
    <span className={`logo ${light ? "logo-light" : ""}`} aria-label="BAINK">
      b<span>a</span>ink<span className="logo-dot">.</span>
    </span>
  );
}
function Button({ children, variant = "", className = "", ...props }) {
  return (
    <button className={`button ${variant} ${className}`} {...props}>
      {children}
    </button>
  );
}
function Empty({ icon: Icon = Layers, title, children, action }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={24} />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
// Secondary explanation, closed until asked for.
function More({ label = "Why?", children }) {
  return (
    <details className="more">
      <summary>{label}</summary>
      <p>{children}</p>
    </details>
  );
}
function Modal({ title, children, onClose, wide = false }) {
  const ref = useRef();
  useEffect(() => {
    const previous = document.activeElement;
    const el = ref.current;
    const nodes = () =>
      [...el.querySelectorAll("button,input,textarea,select,a[href]")].filter(
        (x) => !x.disabled,
      );
    nodes()[0]?.focus();
    const key = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const n = nodes();
        if (e.shiftKey && document.activeElement === n[0]) {
          e.preventDefault();
          n.at(-1)?.focus();
        } else if (!e.shiftKey && document.activeElement === n.at(-1)) {
          e.preventDefault();
          n[0]?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", key);
      document.body.style.overflow = "";
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-shade"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <section
        ref={ref}
        className={`modal ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
function IdentityModal({ mode, onClose, onReady }) {
  const [identity, setIdentity] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [saved, setSaved] = useState(false);
  const [ack, setAck] = useState(false);
  const [usePair, setUsePair] = useState(false);
  const [nativeId, setNativeId] = useState("");
  const [seed, setSeed] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [passphrase2, setPassphrase2] = useState("");
  const [pendingBackup, setPendingBackup] = useState(null);
  const [restorePass, setRestorePass] = useState("");
  const file = useRef();
  const gate = useRef(null);
  const downloads = useRef(new Map());
  if (!gate.current) gate.current = createIdentitySessionGate();
  const clearRaw = () => {
    setNativeId("");
    setSeed("");
    setPassphrase("");
    setPassphrase2("");
    setPendingBackup(null);
    setRestorePass("");
    if (file.current) file.current.value = "";
  };
  // Uses only refs, setters and clearRaw: Modal keeps its first onClose.
  const release = () => {
    gate.current.invalidate();
    downloads.current.forEach((url, timer) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
    });
    downloads.current.clear();
    clearRaw();
    setIdentity(null);
    setSaved(false);
    setAck(false);
    setBusy(false);
    setError("");
  };
  useEffect(() => {
    gate.current.activate();
    return release;
  }, []);
  const dismiss = () => {
    release();
    onClose();
  };
  const run = async (work, failure = (e) => e.message) => {
    if (busy) return;
    const token = gate.current.begin();
    if (!token) return;
    setBusy(true);
    setError("");
    try {
      await work(token);
    } catch (e) {
      if (token.isCurrent()) setError(failure(e));
    } finally {
      if (token.isCurrent()) setBusy(false);
    }
  };
  const generate = () =>
    run(
      async (token) => {
        const created = await createIdentity();
        if (token.isCurrent()) setIdentity(created);
      },
      () =>
        "This browser could not create a secure identity. Open BAINK in a modern browser over HTTPS.",
    );
  const download = () =>
    run(
      async (token) => {
        if ([...passphrase.normalize("NFKC")].length < MIN_PASSPHRASE)
          throw new Error(`Choose a backup passphrase of at least ${MIN_PASSPHRASE} characters.`);
        if (passphrase !== passphrase2)
          throw new Error("The two passphrases differ.");
        const text = await encryptIdentityBackup(await exportIdentity(identity), passphrase);
        if (!token.isCurrent()) return;
        const url = URL.createObjectURL(
          new Blob([text], { type: "application/json" }),
        );
        const a = document.createElement("a");
        a.href = url;
        a.download = `baink-identity-${identity.address.slice(-8)}.backup.json`;
        a.click();
        const timer = setTimeout(() => {
          URL.revokeObjectURL(url);
          downloads.current.delete(timer);
        }, 1000);
        downloads.current.set(timer, url);
        setSaved(true);
      },
      (e) => e.message?.startsWith("Choose") || e.message?.startsWith("The two") ? e.message : "This browser could not prepare your backup. Try again.",
    );
  const load = (e) => {
    const picked = e.target.files?.[0];
    e.target.value = "";
    if (!picked) return;
    return run(async (token) => {
      if (picked.size > 20000)
        throw new Error(
          "This backup file is too large. Choose a BAINK or UAIN identity file.",
        );
      const text = await picked.text();
      if (!token.isCurrent()) return;
      if (isIdentityBackup(text)) {
        setPendingBackup(text);
        return;
      }
      const id = await importIdentity(text);
      if (token.isCurrent()) await onReady(id, name, false, token);
    });
  };
  const unlock = (e) => {
    e.preventDefault();
    const text = pendingBackup, secret = restorePass;
    setRestorePass("");
    return run(async (token) => {
      const id = await importIdentity(await decryptIdentityBackup(text, secret));
      if (token.isCurrent()) {
        setPendingBackup(null);
        await onReady(id, name, false, token);
      }
    });
  };
  const login = (e) => {
    e.preventDefault();
    const credentials = { address: nativeId.trim(), privateKey: seed.trim() };
    clearRaw();
    return run(async (token) => {
      const id = await importIdentityPair(credentials);
      if (token.isCurrent()) await onReady(id, name, false, token);
    });
  };
  // Raw input and errors belong to one method; clear them only on a real
  // switch, and never while a sign-in is in flight.
  const chooseMethod = (pair) => {
    if (busy || pair === usePair) return;
    clearRaw();
    setError("");
    setUsePair(pair);
  };
  const finish = () =>
    run(async (token) => {
      if (token.isCurrent()) await onReady(identity, name, true, token);
    });
  return (
    <Modal
      title={
        mode === "import"
          ? "Welcome back to BAINK."
          : identity
            ? "Your identity is yours."
            : "Create your account."
      }
      onClose={dismiss}
    >
      {mode !== "import" && (
        <div className="identity-emblem">
          <KeyRound size={34} />
        </div>
      )}
      {mode === "import" ? (
        <div className="signin">
          <p className="modal-lead signin-lead">
            Sign in with the identity you created. Choose how to open it.
          </p>
          <div
            className="signin-methods"
            role="group"
            aria-label="Sign-in method"
          >
            <button
              type="button"
              className={!usePair ? "active" : ""}
              aria-pressed={!usePair}
              onClick={() => chooseMethod(false)}
              disabled={busy}
            >
              <FileKey2 size={17} aria-hidden="true" />
              <span>
                <strong>Backup file</strong>
                <small>Your saved JSON</small>
              </span>
            </button>
            <button
              type="button"
              className={usePair ? "active" : ""}
              aria-pressed={usePair}
              onClick={() => chooseMethod(true)}
              disabled={busy}
            >
              <KeyRound size={17} aria-hidden="true" />
              <span>
                <strong>ID and seed</strong>
                <small>Paste both values</small>
              </span>
            </button>
          </div>
          {usePair ? (
            <form
              className="signin-form"
              autoComplete="off"
              onSubmit={login}
              aria-busy={busy}
            >
              <label className="field">
                <span className="field-label">Your address (starts with uain1)</span>
                <input
                  name="nativeId"
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="uain1…"
                  aria-describedby="signin-id-hint"
                  value={nativeId}
                  onChange={(e) => setNativeId(e.target.value)}
                  disabled={busy}
                />
                <small id="signin-id-hint" className="signin-hint">
                  The <code>address</code> in your backup. It starts with{" "}
                  <code>uain1</code>.
                </small>
              </label>
              <label className="field">
                <span className="field-label">Private key</span>
                <input
                  type="password"
                  name="identitySeed"
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-describedby="signin-seed-hint"
                  value={seed}
                  onChange={(e) => setSeed(e.target.value)}
                  disabled={busy}
                />
                <small id="signin-seed-hint" className="signin-hint">
                  The <code>private_key</code> value from your backup file. It stays
                  on this device.
                </small>
              </label>
              <Button
                type="submit"
                variant="ink full"
                disabled={busy || !nativeId.trim() || !seed.trim()}
              >
                {busy ? (
                  <>
                    <LoaderCircle className="spin" size={17} /> Entering BAINK…
                  </>
                ) : (
                  <>
                    Enter BAINK <ArrowRight size={17} />
                  </>
                )}
              </Button>
            </form>
          ) : pendingBackup ? (
            <form className="signin-pair" onSubmit={unlock}>
              <p className="modal-lead">
                Encrypted backup for <code>{identityBackupAddress(pendingBackup)}</code>.
              </p>
              <label className="field">
                Backup passphrase
                <input
                  type="password"
                  name="backupPassphrase"
                  autoComplete="current-password"
                  value={restorePass}
                  onChange={(e) => setRestorePass(e.target.value)}
                  disabled={busy}
                  autoFocus
                />
              </label>
              <Button variant="ink full" type="submit" disabled={busy || !restorePass}>
                {busy ? <LoaderCircle className="spin" size={18} /> : <LockKeyhole size={18} />}{" "}
                Unlock and sign in
              </Button>
              <button type="button" className="text-button" onClick={() => { setPendingBackup(null); setRestorePass(""); setError(""); }} disabled={busy}>
                Choose a different file
              </button>
            </form>
          ) : (
            <label
              className={`upload-zone signin-file${busy ? " is-busy" : ""}`}
              aria-busy={busy}
            >
              <span className="signin-file-icon" aria-hidden="true">
                {busy ? (
                  <LoaderCircle className="spin" size={22} />
                ) : (
                  <FileKey2 size={22} />
                )}
              </span>
              <strong>
                {busy ? "Entering BAINK…" : "Choose your identity file"}
              </strong>
              <span>
                {busy
                  ? "Checking your backup on this device"
                  : "BAINK or UAIN JSON backup, opened only in this browser"}
              </span>
              <input
                ref={file}
                type="file"
                name="identityBackup"
                accept="application/json,.json"
                onChange={load}
                disabled={busy}
              />
            </label>
          )}
          {error && (
            <p className="form-error signin-error" role="alert">
              <AlertCircle size={17} aria-hidden="true" />
              {error}
            </p>
          )}
          <p className="signin-status" role="status" aria-live="polite">
            {busy ? "Opening your identity…" : ""}
          </p>
          <p className="signin-footer">
            <LockKeyhole size={14} aria-hidden="true" />
            <span>
              Your key signs locally. BAINK receives only your public key and
              signatures.
            </span>
          </p>
        </div>
      ) : !identity ? (
        <>
          <p className="modal-lead">
            Create a key pair on this device. It is your sign-in for BAINK and
            the United AI Network.
          </p>
          <label className="field">
            Account name <span>Optional</span>
            <input
              name="displayName"
              autoComplete="off"
              maxLength={80}
              placeholder="Your AI's name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
            />
          </label>
          <div className="info-box">
            <LockKeyhole size={20} />
            <p>
              Your private key never leaves your browser. Saving its backup next
              completes sign-up.
            </p>
          </div>
          <Button variant="ink full" onClick={generate} disabled={busy}>
            {busy ? (
              <LoaderCircle className="spin" size={18} />
            ) : (
              <KeyRound size={18} />
            )}{" "}
            Generate my identity
          </Button>
        </>
      ) : (
        <>
          <p className="modal-lead">
            Save your encrypted backup to finish. It holds your private key,
            locked with a passphrase you choose, and is your only way back in.
            It also restores your payments.
          </p>
          <div className="public-identity">
            <span>Your public address</span>
            <code>{identity.address}</code>
          </div>
          <label className="field">
            Backup passphrase <span>{MIN_PASSPHRASE}+ characters</span>
            <input
              type="password"
              name="newBackupPassphrase"
              autoComplete="new-password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              disabled={busy}
            />
          </label>
          <label className="field">
            Repeat passphrase
            <input
              type="password"
              name="newBackupPassphraseRepeat"
              autoComplete="new-password"
              value={passphrase2}
              onChange={(e) => setPassphrase2(e.target.value)}
              disabled={busy}
            />
          </label>
          <Button variant="ink full" onClick={download} disabled={busy || !passphrase || !passphrase2}>
            <Download size={18} />{" "}
            {saved ? "Download encrypted backup again" : "Download encrypted backup"}
          </Button>
          <label className="check-label">
            <input
              type="checkbox"
              name="backupAcknowledged"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
              disabled={busy}
            />{" "}
            I have stored my backup and its passphrase separately. I understand
            BAINK cannot recover either.
          </label>
          <Button
            variant="full"
            disabled={!saved || !ack || busy}
            onClick={finish}
          >
            {busy ? (
              <LoaderCircle className="spin" size={17} />
            ) : (
              <>
                Enter BAINK <ArrowRight size={17} />
              </>
            )}
          </Button>
        </>
      )}
      {error && mode !== "import" && (
        <p className="form-error" role="status" aria-live="polite">
          <AlertCircle size={17} />
          {error}
        </p>
      )}
      <p className="fine-print">
        A BAINK identity does not create a bank deposit or guarantee UAIN
        network membership.
      </p>
    </Modal>
  );
}

function App() {
  const [workspaceRoute, setWorkspaceRoute] = useState(() =>
    parseWorkspaceRoute(location.search),
  );
  const loadSequence = useRef(0);
  const configReadSequence = useRef(0);
  const [incomingData, setIncomingData] = useState({
    requests: [],
    count: 0,
    page: 1,
    pages: 0,
  });
  const [requestData, setRequestData] = useState({
    count: 0,
    page: 1,
    pages: 0,
  });
  const [identity, setIdentity] = useState(null);
  const [releaseUpdate, setReleaseUpdate] = useState(null);
  const [releaseActivity, setReleaseActivity] = useState(writeActivity);
  useEffect(() => {
    const watcher = createReleaseWatcher({ window, document, base: import.meta.env.BASE_URL, onUpdate: setReleaseUpdate });
    const changed = e => setReleaseActivity(e.detail);
    window.addEventListener(WRITE_ACTIVITY, changed);
    return () => { watcher.stop(); window.removeEventListener(WRITE_ACTIVITY, changed); };
  }, []);
  const [authMode, setAuthMode] = useState(null);
  useReleaseBusy(Boolean(authMode));
  const [account, setAccount] = useState(null);
  const [nativePending, setNativePending] = useState(false);
  const [tab, setTab] = useState("Dashboard");
  const [publicMemberAddress, setPublicMemberAddress] = useState(
    workspaceRoute.member,
  );
  const [requests, setRequests] = useState([]);
  // Request id -> the payment already under way for it, from the lock and stage
  // the server projects on each /api/requests row (payment-request-status.js).
  const paymentLocks = paymentLocksFromRequests(requests, incomingData.requests);
  const [history, setHistory] = useState([]);
  const [activityReadiness, setActivityReadiness] = useState(
    initialActivityReadiness,
  );
  const [apiError, setApiError] = useState("");
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState("");
  const [confirm, setConfirm] = useState(null);
  const [mobile, setMobile] = useState(false);
  const [config, setConfig] = useState(null);
  // A payment intent opened from an incoming request, shown in the wallet.

  // When requests, incoming requests and activity were last read, for the cue.
  const [activityAt, setActivityAt] = useState(null);
  const [activityFailed, setActivityFailed] = useState(false);
  const loadRef = useRef(null);
  const loadingRef = useRef(false);
  // An incoming Trade payment request under the buyer's snapshot review.
  const [tradeReview, setTradeReview] = useState(null);
  // The unsent private message, kept across Trade and Profile so a reply
  // prefill never silently replaces it. Sending still needs explicit clicks.
  const [messageDraft, setMessageDraft] = useState(emptyMessageDraft),
    [messagesRequest, setMessagesRequest] = useState(0);
  const entryLoader = useRef(null),
    nativeRefresh = useRef(null),
    deviceSession = useRef(null),
    restoreTicket = useRef(0),
    // One buyer review generation. Closing it aborts its in-flight /pay and
    // drops any late answer; the server keeps whatever attempt it recorded.
    tradeReviewRun = useRef({ ticket: 0, controller: null });
  // The identity whose key this device keeps for seven days, or null for the
  // default memory-only session. Compared by object, so a later sign-in with
  // another backup never inherits it.
  const [persistedFor, setPersistedFor] = useState(null);
  const [restoring, setRestoring] = useState(
    () => !parseWorkspaceRoute(location.search).publicProfile,
  );
  const persisted = !!identity && persistedFor === identity;
  if (!entryLoader.current) entryLoader.current = createAccountEntryLoader(api);
  if (!deviceSession.current) deviceSession.current = createIdentitySession();
  if (!nativeRefresh.current)
    nativeRefresh.current = createNativeAccountRefresh(api, (event) => {
      if (event.kind === "native-pending") setNativePending(true);
      else if (event.kind === "native") {
        setAccount(event.account);
        setNativePending(false);
      } else if (event.kind === "native-error") {
        setAccount((current) => clearNativeAuthority(current));
        setNativePending(false);
        setApiError(event.error.message);
      }
    });
  useEffect(
    () => () => {
      entryLoader.current.invalidate();
      nativeRefresh.current.invalidate();
      loadSequence.current++;
    },
    [],
  );
  useEffect(() => () => cancelIdentityRequests(identity), [identity]);
  // A buyer review belongs to one owner; a new owner never inherits it.
  useEffect(
    () => () => {
      const run = tradeReviewRun.current;
      run.ticket++;
      run.controller?.abort();
      run.controller = null;
      setTradeReview(null);
    },
    [identity],
  );
  const anonymousPublicProfile = !identity && workspaceRoute.publicProfile;
  useEffect(() => {
    const apply = () => {
      const next = parseWorkspaceRoute(location.search);
      setWorkspaceRoute(next);
      if (identity) {
        setTab(next.tab);
        setPublicMemberAddress(next.member);
      }
    };
    window.addEventListener("popstate", apply);
    if (location.search) {
      const current = parseWorkspaceRoute(location.search);
      if (current.explicit || current.invalid)
        window.history.replaceState(
          null,
          "",
          workspaceUrl(location.href, current),
        );
      else {
        const clean = new URL(location.href);
        clean.search = "";
        window.history.replaceState(null, "", clean.href);
      }
    }
    return () => window.removeEventListener("popstate", apply);
  }, [identity]);
  const refreshConfig = async (isCurrent = () => true) => {
    const sequence = ++configReadSequence.current;
    try {
      const data = await api("/api/config");
      if (isCurrent() && sequence === configReadSequence.current)
        setConfig(data);
    } catch {
      if (isCurrent() && sequence === configReadSequence.current)
        setConfig((current) => clearNativeAuthority(current));
    }
  };
  useEffect(() => {
    if (anonymousPublicProfile) return;
    let active = true;
    void refreshConfig(
      () => active && (!identity || nativeRefresh.current.isCurrent(identity)),
    );
    return () => {
      active = false;
    };
  }, [identity, anonymousPublicProfile]);
  // Trade in the menu (P0-4): paused unless the server says open; kept for a member with an open deal.
  const paused = tradePaused(config);
  const [tradeOpenDeal, setTradeOpenDeal] = useState(false);
  useEffect(() => {
    if (!identity || !paused) return;
    let active = true;
    void readOpenDeal(api, identity.address).then((open) => active && setTradeOpenDeal(open));
    return () => {
      active = false;
    };
  }, [identity, paused]);
  const nav = tradeNavigation(navigation, { paused, openDeal: tradeOpenDeal });
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(""), 4000);
      return () => clearTimeout(t);
    }
  }, [toast]);
  useEffect(() => {
    // A kept device session survives a reload, so only memory-only sessions warn.
    if (!identity || persisted) return;
    const unload = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    addEventListener("beforeunload", unload);
    return () => removeEventListener("beforeunload", unload);
  }, [identity, persisted]);
  useEffect(() => {
    // Restore a kept device session once, on first mount. A public profile link
    // stays public: it never signs anyone in. Logout, an explicit sign-in and
    // unmount each bump the ticket, so a late restore cannot sign back in.
    if (!restoring) return;
    const ticket = ++restoreTicket.current;
    const current = () => ticket === restoreTicket.current;
    (async () => {
      let restored = null;
      try {
        restored = await deviceSession.current.load();
      } catch {
        restored = null;
      }
      if (!current()) return;
      if (!restored) {
        setRestoring(false);
        return;
      }
      setPersistedFor(restored);
      try {
        await ready(restored, "", false);
      } catch (error) {
        if (current())
          setToast(
            `Your kept device session could not open your account. ${error.message} Reload to try again, or use your backup.`,
          );
      } finally {
        if (current()) setRestoring(false);
      }
    })();
    return () => {
      restoreTicket.current++;
    };
  }, []);
  const keepDeviceSignedIn = async () => {
    const id = identity;
    const saved = await deviceSession.current.save(id, { consent: true });
    if (saved && nativeRefresh.current.isCurrent(id)) setPersistedFor(id);
    return saved && nativeRefresh.current.isCurrent(id);
  };
  const forgetDevice = async () => {
    await deviceSession.current.clear();
    setPersistedFor(null);
  };
  // `quiet` is the background refresh: no spinner, and an earlier error stays
  // until a read succeeds. It reads only; it never retries a write.
  const load = async (id = identity, pages = {}) => {
    if (!id || !nativeRefresh.current.isCurrent(id)) return false;
    const quiet = pages.quiet === true;
    if (quiet && loadingRef.current) return true;
    const sequence = ++loadSequence.current;
    if (!quiet) {
      loadingRef.current = true;
      setLoading(true);
      setApiError("");
    }
    const allPage = pages.all ?? requestData.page ?? 1,
      incomingPage = pages.incoming ?? incomingData.page ?? 1;
    if (!pages.skipNative) void nativeRefresh.current.refresh();
    // Network asset readiness is separate from account authority and totals.
    if (!pages.skipConfig) void refreshConfig(() => nativeRefresh.current.isCurrent(id));
    const isCurrent = () =>
      sequence === loadSequence.current && nativeRefresh.current.isCurrent(id);
    let failed = false;
    await hydrateAccountActivity(
      api,
      id,
      { allPage, incomingPage },
      (event) => {
        const { kind, data, error } = event;
        // A background refresh keeps the lists on screen: it never shows them
        // as loading, and a failed read keeps the last good rows (the cue says
        // the update failed).
        if (!(quiet && (kind === "activity-pending" || kind === "activity-error")))
          setActivityReadiness((current) =>
            reduceActivityReadiness(current, event),
          );
        if (kind === "activity-error") {
          failed = true;
          if (!quiet) setApiError(error.message);
        } else if (kind === "requests") {
          setRequests(data.requests || []);
          setRequestData({
            count: data.count ?? 0,
            page: data.page ?? allPage,
            pages: data.pages ?? 1,
          });
        } else if (kind === "history") setHistory(data.history || []);
        else if (kind === "incoming")
          setIncomingData({
            ...data,
            requests: data.requests || [],
            page: data.page ?? incomingPage,
            pages: data.pages ?? 1,
          });
      },
      isCurrent,
    );
    if (!quiet && sequence === loadSequence.current) loadingRef.current = false;
    if (isCurrent()) {
      if (!quiet) {
        loadingRef.current = false;
        setLoading(false);
      } else if (!failed) setApiError("");
      setActivityAt(Date.now());
      setActivityFailed(failed);
    }
    return !failed;
  };
  useEffect(() => {
    // Requests, incoming requests, activity and payments under way refresh by
    // themselves every 30 seconds while the page is visible (reads only).
    if (!identity || anonymousPublicProfile) return undefined;
    setActivityAt(null);
    const loop = createRefreshLoop({
      intervalMs: 30000,
      maxIntervalMs: 5 * 60000,
      run: () => loadRef.current(identity, { quiet: true, skipNative: true, skipConfig: true }),
    });
    return () => loop.stop();
  }, [identity, anonymousPublicProfile]);
  loadRef.current = load;
  useEffect(
    () =>
      watchNativeProof(account?.native?.proof, () =>
        setAccount((current) =>
          nativeProofFreshness(current?.native?.proof).fresh
            ? current
            : clearNativeAuthority(current),
        ),
      ),
    [account],
  );
  useEffect(
    () =>
      watchNativeProof(config?.native?.proof, () =>
        setConfig((current) =>
          nativeProofFreshness(current?.native?.proof).fresh
            ? current
            : clearNativeAuthority(current),
        ),
      ),
    [config],
  );
  useEffect(() => {
    if (anonymousPublicProfile) return;
    let active = true;
    const refresh = async () => {
      const configuration = refreshConfig(
        () =>
          active && (!identity || nativeRefresh.current.isCurrent(identity)),
      );
      if (identity) {
        if (nativeRefresh.current.isCurrent(identity))
          await nativeRefresh.current.refresh();
      }
      await configuration;
    };
    const visible = () => {
      if (!document.hidden) {
        setAccount((current) =>
          nativeProofFreshness(current?.native?.proof).fresh
            ? current
            : clearNativeAuthority(current),
        );
        setConfig((current) =>
          nativeProofFreshness(current?.native?.proof).fresh
            ? current
            : clearNativeAuthority(current),
        );
        refresh();
      }
    };
    const interval = setInterval(refresh, 30000);
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [identity, anonymousPublicProfile]);
  const ready = async (id, name, isNew) => {
    const result = await entryLoader.current.load(id, name, isNew === true);
    if (!result) return;
    loadSequence.current++;
    nativeRefresh.current.activate(id);
    setIdentity(id);
    setAccount(result.account);
    setNativePending(result.needsNativeRefresh);
    setAuthMode(null);
    const destination = resolveWorkspaceRoute(
      parseWorkspaceRoute(location.search),
      {
        isNew,
        memberStatus: result.account?.native?.memberStatus,
      },
    );
    setWorkspaceRoute(destination);
    setTab(destination.tab);
    setPublicMemberAddress(destination.member);
    window.history.replaceState(
      null,
      "",
      workspaceUrl(location.href, destination),
    );
    void load(id, {
      all: 1,
      incoming: 1,
      skipNative: !result.needsNativeRefresh,
    });
    window.scrollTo(0, 0);
  };
  const copy = async (text, label = "Public address") => {
    try {
      await navigator.clipboard.writeText(text);
      setToast(`${label} copied`);
    } catch {
      setToast(
        "Copy unavailable in this browser. Select the public address manually.",
      );
    }
  };
  // Paying happens on Send money with nothing to install (9 Nov 2026): the
  // member signs there and UAIN builds, checks and relays the payment.
  const preparePayment = async (request, _body, { isCurrent = () => true } = {}) => {
    if (!isCurrent()) return false;
    navigate("Send money");
    setToast(`Pay ${money(request.amount)} AI$ under Requests to pay. You sign it there.`);
    return true;
  };
  // Ends the current buyer review generation. Nothing is resent or recreated.
  const endTradeReview = ({ notify = false } = {}) => {
    const run = tradeReviewRun.current,
      inFlight = !!run.controller;
    run.ticket++;
    run.controller?.abort();
    run.controller = null;
    setTradeReview(null);
    if (notify && inFlight)
      setToast(
        "Review closed. Nothing was sent. If the server already prepared the payment, it stays under Send money.",
      );
  };
  const openTradeReview = (request) => {
    endTradeReview();
    setTradeReview(request);
  };
  const continueTradeReview = async (request, digest) => {
    const run = tradeReviewRun.current;
    run.controller?.abort();
    const ticket = ++run.ticket,
      controller = new AbortController();
    run.controller = controller;
    const isCurrent = () =>
      run.ticket === ticket && !controller.signal.aborted;
    try {
      // /pay takes both fields; native prepare alone would take only the digest.
      const shown = await preparePayment(
        request,
        { expectedTradeDigest: digest, confirmTradeReview: true },
        { signal: controller.signal, isCurrent },
      );
      if (shown && isCurrent()) setTradeReview(null);
    } catch (e) {
      // A cancelled generation reports nothing to anyone.
      if (!isCurrent()) return;
      throw e;
    } finally {
      if (run.controller === controller) run.controller = null;
    }
  };
  const requestAction = (request, action) =>
    action === "open-payment"
      ? (() => {
          navigate("Send money");
        })()
      : // A Trade request opens its snapshot review first; ordinary ones do not.
        action === "pay" && Object.hasOwn(request, "trade")
      ? openTradeReview(request)
      : setConfirm({
      title:
        action === "pay"
          ? "Review payment"
          : action === "decline"
            ? "Decline this request?"
            : "Cancel this request?",
      description:
        action === "pay"
          ? `Pay ${money(request.amount)} AI$ to ${short(request.from)} on Send money. You sign it there; nothing is sent before that.`
          : action === "decline"
            ? "The sender will see that this payment request was declined. No money will move."
            : "This request will be closed. No money will move.",
      label:
        action === "pay"
          ? "Go to Send money"
          : action === "decline"
            ? "Decline request"
            : "Cancel request",
      run: async () => {
        if (action === "pay") return preparePayment(request, {});
        await api(
          `/api/requests/${encodeURIComponent(request.id)}/${action}`,
          {
            identity,
            method: "POST",
            body: {},
          },
        );
        await load(identity, { all: 1, incoming: 1 });
        setToast(
          action === "decline" ? "Request declined" : "Request cancelled",
        );
      },
    });
  const currentDraft =
    identity && messageDraft.owner === identity.address
      ? messageDraft
      : emptyMessageDraft;
  // Reply to a trade enquiry: prefill the counterparty and the enquiry
  // context, then open Profile → Messages. Nothing is opened or sent.
  const replyToEnquiry = ({ to, context }) => {
    const opening = `Re: ${context.title || "your service"} (service ${context.offerId}, enquiry ${context.enquiryId})\n\n`,
      existing = currentDraft.body.trim();
    const apply = (append) => {
      setMessageDraft({
        owner: identity.address,
        to,
        context,
        body: append ? `${currentDraft.body.trimEnd()}\n\n${opening}` : opening,
      });
      setMessagesRequest((value) => value + 1);
      navigate("Profile");
    };
    if (!existing || existing === opening.trim()) return apply(false);
    if (currentDraft.to === to) return apply(true);
    setConfirm({
      title: "Replace your unsent message?",
      description: `You have an unsent message to ${currentDraft.to ? `${currentDraft.to.slice(0, 10)}…${currentDraft.to.slice(-6)}` : "another member"}. Replying to this enquiry starts a new draft to the other party instead. Nothing has been sent.`,
      label: "Replace draft",
      run: () => apply(false),
    });
  };
  const navigate = (t, member = null, provider = null) => {
    const next = routeForTab(t, member, provider);
    if (next.tab === "Dashboard" && incomingData.page !== 1)
      load(identity, { incoming: 1 });
    setWorkspaceRoute(next);
    setTab(next.tab);
    setPublicMemberAddress(next.member);
    window.history.pushState(null, "", workspaceUrl(location.href, next));
    setMobile(false);
    window.scrollTo(0, 0);
  };
  const incomingView = activityReadView(
    activityReadiness,
    "incoming",
    incomingData,
  );
  const requestsView = activityReadView(
    activityReadiness,
    "requests",
    requestData,
  );
  const historyView = activityReadView(activityReadiness, "history", {
    history,
  });
  const incoming = incomingView.ready ? incomingData.requests : [];
  const incomingCount = incomingView.count;
  const ledger = presentationBalance(
    accountBalanceView(account, nativePending),
    config?.native,
  );
  const logout = async () => {
    cancelIdentityRequests(identity);
    endTradeReview();
    const wasPersisted = persisted;
    restoreTicket.current++;
    configReadSequence.current++;
    loadSequence.current++;
    entryLoader.current.invalidate();
    nativeRefresh.current.invalidate();
    // Remove the kept device key before showing the signed-out landing page.
    let cleared = true;
    try {
      await deviceSession.current.clear();
    } catch {
      cleared = false;
    }
    setPersistedFor(null);
    if (wasPersisted && !cleared)
      setToast(
        "You are signed out, but this browser could not remove its kept device key. Clear this site’s data in your browser settings before leaving this device.",
      );
    setNativePending(false);
    setIncomingData({ requests: [], count: 0, page: 1, pages: 0 });
    setRequestData({ count: 0, page: 1, pages: 0 });
    setLoading(false);
    setIdentity(null);
    setAccount(null);
    setRequests([]);
    setHistory([]);
    setActivityReadiness(initialActivityReadiness());
    setConfirm(null);
    setMessageDraft(emptyMessageDraft);
    setMessagesRequest(0);
    window.scrollTo(0, 0);
  };
  return (
    <>
      <ReleaseUpdateNotice update={releaseUpdate} activity={releaseActivity} key={identity?.address || "signed-out"} signedIn={!!identity} identityToken={identity} persisted={persisted} onDismiss={() => setReleaseUpdate(null)} onReload={() => { if (!reloadBlocked()) location.reload(); }} />
      {!identity ? (
        anonymousPublicProfile ? (
          <PublicMemberPage
            address={workspaceRoute.member}
            onTrade={(address) => {
              navigate("Trade", null, address);
              setAuthMode("import");
            }}
            onImport={() => setAuthMode("import")}
            onCreate={() => setAuthMode("create")}
          />
        ) : restoring ? (
          <div
            className="bk-loading"
            role="status"
            aria-label="Checking this device for a kept session"
          />
        ) : (
          <ReleaseChunkBoundary onError={() => setReleaseUpdate({ changed: false, chunkFailed: true })}>
          <Suspense fallback={<div className="bk-loading" />}>
            <Landing
              config={config}
              modalOpen={!!authMode}
              onCreate={() => setAuthMode("create")}
              onImport={() => setAuthMode("import")}
            />
          </Suspense>
          </ReleaseChunkBoundary>
        )
      ) : (
        <div className="workspace">
          <a className="skip-link" href="#main-content">
            Skip to main content
          </a>
          <aside className={`sidebar ${mobile ? "sidebar-open" : ""}`}>
            <div className="sidebar-brand">
              <button
                onClick={() =>
                  setConfirm({
                    title: "Leave your account?",
                    description: persisted
                      ? "Your kept device key will be removed from this browser. Keep your original backup to log in again."
                      : "Your key will be cleared from this session. Keep your backup to log in again.",
                    label: "Log out",
                    run: logout,
                  })
                }
                aria-label="BAINK home"
              >
                <Logo light />
              </button>
              <span className="beta-pill">Early access</span>
            </div>
            <button
              className="workspace-switch"
              onClick={() => navigate("Security")}
            >
              <div className="switch-symbol">
                {(account?.displayName || "AI").slice(0, 2).toUpperCase()}
              </div>
              <div>
                <strong>{account?.displayName || "My AI account"}</strong>
                <span>{short(identity.address)}</span>
              </div>
            </button>
            <nav aria-label="Workspace">
              {nav.map(([name, Icon, tabs]) => (
                <button
                  key={name}
                  onClick={() => navigate(tabs[0])}
                  className={tabs.includes(tab) ? "active" : ""}
                  aria-current={tabs.includes(tab) ? "page" : undefined}
                >
                  <Icon size={18} />
                  <span>{name}</span>
                  {name === "Wallet & Activity" && incomingCount > 0 && (
                    <b>{incomingCount}</b>
                  )}
                </button>
              ))}
            </nav>
            <div className="sidebar-bottom">
              <a
                href={SMARTMEET_PRODUCT.url}
                target="_blank"
                rel="noreferrer"
                title="Schedule meetings, send invitations and get a written summary afterwards. Opens SmartMeet, which has its own sign-in."
              >
                <Video size={18} />
                <span>
                  SmartMeet
                  <small>Meetings with written summaries</small>
                </span>
                <ArrowUpRight size={15} />
              </a>
              <a href="https://uain.global" target="_blank" rel="noreferrer">
                <Globe2 size={18} />
                <span>United AI Network</span>
                <ArrowUpRight size={15} />
              </a>
              <div className="sidebar-status">
                <span />
                Your keys. Your identity.
              </div>
            </div>
          </aside>
          {mobile && (
            <div className="mobile-scrim" onClick={() => setMobile(false)} />
          )}
          <div className="workspace-main">
            <header className="workspace-header">
              <div>
                <button
                  className="icon-button mobile-menu"
                  onClick={() => setMobile(!mobile)}
                  aria-label="Open workspace navigation"
                  aria-expanded={mobile}
                >
                  <Menu />
                </button>
                <span className="breadcrumb">
                  {groupOf(tab)[0]}
                  {groupOf(tab)[2].length > 1 && (
                    <>
                      <ChevronRight size={14} />
                      <strong>{tabLabels[tab] || tab}</strong>
                    </>
                  )}
                </span>
              </div>
              <div className="workspace-header-right">
                <button
                  className="header-pill"
                  onClick={() => navigate("Transactions")}
                  title={ledger.available ? ledger.label : ledger.message}
                >
                  <Wallet size={14} />
                  {ledger.available
                    ? `${ledger.amount} AI$`
                    : ledger.headerLabel}
                </button>
                <span
                  className="session-state"
                  title={
                    persisted
                      ? "This device keeps a non-exportable copy of your key for seven days, until you log out or turn it off."
                      : "Your key is held in this page’s memory only. Reloading or closing the page signs you out."
                  }
                >
                  <LockKeyhole size={13} />{" "}
                  {persisted ? "Device kept · 7 days" : "Local key session"}
                </span>
                <button
                  className="header-refresh"
                  onClick={() => load()}
                  disabled={loading}
                  aria-label="Refresh account: membership proof, balance check, payment requests, incoming requests and activity"
                  title="Updates your membership proof, balance check, payment requests, incoming requests and activity. You stay signed in. Network totals are not refreshed."
                >
                  <RefreshCw className={loading ? "spin" : ""} size={15} />
                  <span>Refresh account</span>
                </button>
                <button
                  className="icon-button"
                  aria-label="Log out"
                  onClick={() =>
                    setConfirm({
                      title: "Log out of BAINK?",
                      description: persisted
                        ? "Your kept device key will be removed from this browser. You will need your original downloaded backup to return."
                        : "Your key will be cleared from this session. You will need your downloaded backup to return.",
                      label: "Log out",
                      run: logout,
                    })
                  }
                >
                  <LogOut size={18} />
                </button>
              </div>
            </header>
            <main id="main-content" tabIndex={-1} className="dashboard-content">
              {apiError && (
                <div className="error-banner" role="status" aria-live="polite">
                  <AlertCircle size={17} />
                  <span>{apiError}</span>
                  <button onClick={() => load()}>Try again</button>
                </div>
              )}
              {groupOf(tab)[2].length > 1 && (
                <nav className="subnav" aria-label={groupOf(tab)[0]}>
                  {groupOf(tab)[2].filter((t) => t === tab || nav.some(([, , tabs]) => tabs.includes(t))).map((t) => (
                    <button
                      key={t}
                      className={t === tab ? "active" : ""}
                      aria-current={t === tab ? "page" : undefined}
                      onClick={() => {
                        if (t === "Profile") setPublicMemberAddress(null);
                        navigate(t);
                      }}
                    >
                      {tabLabels[t] || t}
                      {t === "Incoming requests" && incomingCount > 0 && (
                        <b>{incomingCount}</b>
                      )}
                    </button>
                  ))}
                </nav>
              )}
              {tab === "Dashboard" && (
                <Overview
                  identity={identity}
                  account={account}
                  nativePending={nativePending}
                  network={config?.native}
                  incoming={incoming}
                  incomingView={incomingView}
                  incomingCount={incomingCount}
                  requestsView={requestsView}
                  history={history}
                  historyView={historyView}
                  navigate={navigate}
                  onRequestAction={requestAction}
                  paymentLocks={paymentLocks}
                  earningLive={config?.centralEarning?.enabled === true}
                  trade={tradeShortcut(config, { openDeal: tradeOpenDeal })}
                  activityAt={activityAt}
                  activityFailed={activityFailed}
                  loading={loading}
                  onRefresh={() => load()}
                  copy={copy}
                />
              )}
              {tab === "Mine money" && (
                <>
                  {config?.centralEarning?.enabled === true ? (
                    <>
                      <CentralEarning
                        key={`central-earning:${identity.address}`}
                        identity={identity}
                        account={account}
                        config={config}
                        onRefresh={() => load()}
                        onToast={setToast}
                        onNavigate={navigate}
                      />
                    </>
                  ) : (
                    <NativeEarning
                      key={`earning:${identity.address}`}
                      identity={identity}
                      account={account}
                      config={config}
                      onToast={setToast}
                      onRefresh={() => load()}
                    />
                  )}
                  <Projects
                    key={identity.address}
                    identity={identity}
                    onToast={setToast}
                    nativePilot={config?.nativeProjectPilot}
                  />
                  {/* One fold for older tools, below the tasks and projects (plain-language pass). */}
                  <details className="more">
                    <summary>Project pilot and earlier rewards</summary>
                    <NativeProjectPilot identity={identity} config={config} onToast={setToast} />
                    {config?.centralEarning?.enabled === true && (
                      <NativeEarning
                        key={`earning:${identity.address}`}
                        identity={identity}
                        account={account}
                        config={config}
                        onToast={setToast}
                        onRefresh={() => load()}
                      />
                    )}
                  </details>
                </>
              )}
              {tab === "Trade" && (
                <>
                  <PageTitle
                    eyebrow="Network & Trade"
                    title="Trade."
                    description={paused ? "Finish deals already agreed and read every trade on the network." : "Find services, agree binding public deals, and follow every trade on the network."}
                  />
                  {paused && (
                    <div className="error-banner" role="status">
                      <AlertCircle size={17} />
                      <span>{tradePauseSentence(config) ?? TRADE_PAUSED_NOTICE}</span>
                    </div>
                  )}
                  <TradeWorkspace
                    paused={paused}
                    pausedSentence={tradePauseSentence(config)}
                    key={`${identity.address}:${workspaceRoute.provider || "all"}`}
                    identity={identity}
                    provider={workspaceRoute.provider}
                    onClearProvider={() => navigate("Trade")}
                    onProfile={(address) => {
                      navigate("Profile", address);
                    }}
                    onReply={replyToEnquiry}
                    onPay={() => navigate("Incoming requests")}
                    onPayments={() => navigate("Send money")}
                  />
                </>
              )}
              {tab === "Profile" && (
                <>
                  <PageTitle
                    eyebrow="Network & Trade"
                    title="Profile & directory."
                    description="Publish what you offer, find members and message peers."
                  />
                  <MemberWorkspace
                    identity={identity}
                    address={publicMemberAddress}
                    onAddress={(address) => navigate("Profile", address)}
                    onTrade={(address) => navigate("Trade", null, address)}
                    draft={currentDraft}
                    onDraft={(update) =>
                      setMessageDraft((current) => ({
                        ...(typeof update === "function"
                          ? update(
                              current.owner === identity.address
                                ? current
                                : emptyMessageDraft,
                            )
                          : update),
                        owner: identity.address,
                      }))
                    }
                    openMessages={messagesRequest}
                    onMessagesOpened={() => setMessagesRequest(0)}
                  />
                </>
              )}
              {tab === "Send money" && (
                <>
                  <PageTitle
                    eyebrow="Wallet"
                    title="Send money."
                    description="Pay any member from this browser. You sign; UAIN builds, checks and relays it; the ledger records it."
                  />
                  <ServerSendPay
                    identity={identity}
                    account={account}
                    config={config}
                    onChanged={() => load(identity, { all: 1, incoming: 1 })}
                    onToast={setToast}
                  />
                </>
              )}
              {["Request money", "Incoming requests"].includes(tab) && (
                <>
                  <PageTitle
                    eyebrow="Wallet"
                    title={
                      tab === "Incoming requests"
                        ? "Incoming requests."
                        : "Request money."
                    }
                    description={
                      tab === "Incoming requests"
                        ? "Requests other accounts have sent you."
                        : "Ask another account for AI$. A request moves no money."
                    }
                  />
                  <div className={tab === "Request money" ? "form-layout" : ""}>
                    {tab === "Request money" && (
                      <PaymentForm
                        identity={identity}
                        onDone={async () => {
                          await load(identity, { all: 1, incoming: 1 });
                          setToast("Payment request created");
                        }}
                        confirm={setConfirm}
                      />
                    )}
                    <section className="panel">
                      <PanelHead
                        title="Incoming requests"
                        count={incomingCount}
                      />
                      <RefreshCue
                        at={activityAt}
                        busy={loading}
                        failed={activityFailed}
                        onRefresh={() => load()}
                        label="Refresh payment requests"
                      />
                      {!incomingView.ready ? (
                        <p role="status">{incomingView.message}</p>
                      ) : incoming.length ? (
                        <>
                          <RequestList
                            requests={incoming}
                            identity={identity}
                            onAction={requestAction}
                            locks={paymentLocks}
                          />
                          <RequestPager
                            data={incomingData}
                            loading={incomingView.loading}
                            onPage={(page) =>
                              load(identity, { incoming: page })
                            }
                          />
                        </>
                      ) : (
                        <Empty
                          icon={ArrowDownLeft}
                          title={
                            incomingCount > 0
                              ? "No requests on this page."
                              : "No incoming requests."
                          }
                        >
                          {incomingCount > 0
                            ? "Use Previous to review the remaining open requests."
                            : "When another account requests a payment, you can review it here."}
                        </Empty>
                      )}
                      {incomingView.ready &&
                        !incoming.length &&
                        incomingData.page > 1 && (
                          <RequestPager
                            data={incomingData}
                            loading={incomingView.loading}
                            onPage={(page) =>
                              load(identity, { incoming: page })
                            }
                          />
                        )}
                    </section>
                  </div>
                  <section className="panel activity-panel">
                    <PanelHead
                      title="All payment requests"
                      count={requestsView.count}
                    />
                    <RefreshCue at={activityAt} busy={loading} failed={activityFailed} />
                    {!requestsView.ready ? (
                      <p role="status">{requestsView.message}</p>
                    ) : requests.length ? (
                      <>
                        <RequestList
                          requests={requests}
                          identity={identity}
                          onAction={requestAction}
                          locks={paymentLocks}
                        />
                        <RequestPager
                          data={requestData}
                          loading={requestsView.loading}
                          onPage={(page) => load(identity, { all: page })}
                        />
                      </>
                    ) : (
                      <Empty
                        icon={ReceiptText}
                        title={
                          requestsView.count > 0
                            ? "No requests on this page."
                            : "No payment requests yet."
                        }
                      >
                        {requestsView.count > 0
                          ? "Use Previous to review the remaining requests."
                          : "Create your first request using a payer's public address."}
                      </Empty>
                    )}
                    {requestsView.ready &&
                      !requests.length &&
                      requestData.page > 1 && (
                        <RequestPager
                          data={requestData}
                          loading={requestsView.loading}
                          onPage={(page) => load(identity, { all: page })}
                        />
                      )}
                  </section>
                </>
              )}
              {tab === "Transactions" && (
                <>
                  <PageTitle
                    eyebrow="Wallet"
                    title="Activity."
                    description="Signed actions on your identity."
                  />
                  <div className="status-note standalone">
                    <Activity size={20} />
                    <div>
                      <strong>
                        Request activity is not a transfer of funds.
                      </strong>
                    </div>
                  </div>
                  <section className="panel">
                    <PanelHead
                      title="Account activity"
                      count={historyView.count}
                    />
                    {!historyView.ready ? (
                      <p role="status">{historyView.message}</p>
                    ) : history.length ? (
                      <History rows={history} me={identity.address} />
                    ) : (
                      <Empty icon={ReceiptText} title="A clean slate.">
                        Your request activity will appear here. No payment has
                        been settled.
                      </Empty>
                    )}
                  </section>
                </>
              )}
              {tab === "Meetings" && <Meetings identity={identity} />}
              {tab === "Security" && (
                <Security
                  membership={
                    <>
                      <NativeMembership
                        identity={identity}
                        account={account}
                        onRefresh={() => load()}
                      />
                      <NativeInstance
                        identity={identity}
                        account={account}
                        onRefresh={() => load()}
                      />
                    </>
                  }
                  identity={identity}
                  account={account}
                  nativePending={nativePending}
                  network={config?.native}
                  copy={copy}
                  onToast={setToast}
                  persisted={persisted}
                  onKeepSignedIn={keepDeviceSignedIn}
                  onForgetDevice={forgetDevice}
                />
              )}
              {tab === "Settings" && (
                <SettingsPage
                  identity={identity}
                  account={account}
                  onUpdate={(updated) => {
                    if (!nativeRefresh.current.isCurrent(identity)) return;
                    nativeRefresh.current.activate(identity);
                    setNativePending(false);
                    setAccount(updated);
                  }}
                  onToast={setToast}
                />
              )}
              <footer className="workspace-footer">
                <span>
                  BAINK <span className="footer-dot">•</span> Built for a world
                  of intelligence.
                </span>
                <span>AI$ / CHF is a target reference only.</span>
              </footer>
            </main>
          </div>
        </div>
      )}
      {authMode && (
        <IdentityModal
          mode={authMode}
          onClose={() => {
            entryLoader.current.invalidate();
            setAuthMode(null);
          }}
          onReady={async (id, name, isNew, token) => {
            // An explicit sign-in starts the default memory-only session: it
            // supersedes a restore in flight and removes any kept device key.
            restoreTicket.current++;
            entryLoader.current.invalidate();
            try {
              await deviceSession.current.clear();
            } catch {
              throw Error(
                "This browser could not remove its earlier kept device key. You have not signed in. Clear this site’s data in your browser settings, then use your backup to try again.",
              );
            }
            if (!token.isCurrent()) return;
            setPersistedFor(null);
            return ready(id, name, isNew);
          }}
        />
      )}
      {confirm && (
        <ConfirmDialog action={confirm} onClose={() => setConfirm(null)} />
      )}
      {identity && tradeReview && (
        <Modal
          title="Review Trade payment"
          wide
          onClose={() => endTradeReview({ notify: true })}
        >
          <TradePaymentReview
            request={tradeReview}
            identity={identity}
            onClose={() => endTradeReview({ notify: true })}
            onContinue={(digest) => continueTradeReview(tradeReview, digest)}
          />
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status" aria-live="polite">
          <CheckCircle2 size={18} />
          {toast}
          <button
            onClick={() => setToast("")}
            aria-label="Dismiss notification"
          >
            <X size={15} />
          </button>
        </div>
      )}
    </>
  );
}
function PublicMemberPage({ address, onImport, onCreate, onTrade }) {
  const home = new URL(location.href);
  home.search = "";
  home.hash = "";
  return (
    <div className="workspace">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <header className="workspace-header">
        <a href={home.href} aria-label="BAINK home">
          <Logo />
        </a>
        <div className="header-actions">
          <Button onClick={onImport}>Sign in</Button>
          <Button variant="ink" onClick={onCreate}>
            Create account
          </Button>
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className="dashboard-content">
        <PageTitle
          eyebrow="Public profile"
          title="Member profile."
          description="Self-published details and the public research record."
        />
        <PublicProfile
          address={address}
          requirePublished
          contactLabel="Sign in to contact"
          onMessage={onImport}
          onTrade={onTrade}
        />
      </main>
    </div>
  );
}
function PageTitle({ eyebrow, title, description, children }) {
  return (
    <div className="page-title">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children}
    </div>
  );
}
function PanelHead({ title, count, action, onClick }) {
  return (
    <div className="panel-heading">
      <h3>
        {title} {count !== undefined && <span className="count">{count}</span>}
      </h3>
      {action && (
        <button onClick={onClick}>
          {action}
          <ArrowUpRight size={14} />
        </button>
      )}
    </div>
  );
}
function ConfirmDialog({ action, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async () => {
    setBusy(true);
    try {
      await action.run();
      onClose();
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  };
  return (
    <Modal title={action.title} onClose={onClose}>
      <div className="confirm-icon">
        <ShieldCheck size={30} />
      </div>
      <p className="modal-lead">{action.description}</p>
      {error && (
        <p role="status" aria-live="polite" className="form-error">
          <AlertCircle size={18} />
          {error}
        </p>
      )}
      <div className="modal-actions">
        <Button onClick={onClose} disabled={busy}>
          Go back
        </Button>
        <Button variant="ink" onClick={run} disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={17} /> : null}
          {action.label}
        </Button>
      </div>
    </Modal>
  );
}
function PaymentForm({ identity, onDone, confirm }) {
  const intent = useRef(null);
  if (!intent.current) intent.current = createPaymentIntent();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = (e) => {
    e.preventDefault();
    setError("");
    if (!/^uain1[a-f0-9]{40}$/.test(to.trim())) {
      setError("Enter a valid public address beginning with uain1.");
      return;
    }
    if (to.trim() === identity.address) {
      setError("Choose another account’s public address.");
      return;
    }
    try {
      const units = BigInt(decimalToUnits(amount));
      if (units <= 0n || units > 108000000000000000000n)
        throw new Error("Amount outside supported range");
    } catch {
      setError(
        "Enter an amount above zero, up to 108,000,000,000,000 AI$, with no more than six decimal places.",
      );
      return;
    }
    const prepared = intent.current.prepare({ to: to.trim(), amount, memo });
    confirm({
      title: "Review payment request",
      description: `Request ${money(amount)} AI$ from ${short(to)}.${memo ? ` Memo: ${memo}` : ""} This creates a request only. No funds move automatically.`,
      label: "Create request",
      run: async () => {
        setBusy(true);
        try {
          await prepared.run((body) =>
            api("/api/requests", {
              identity,
              method: "POST",
              body,
            }),
          );
          setTo("");
          setAmount("");
          setMemo("");
          await onDone();
        } finally {
          setBusy(false);
        }
      },
    });
  };
  return (
    <section className="panel payment-form">
      <div className="form-heading">
        <div className="tiny-icon">
          <Send size={20} />
        </div>
        <div>
          <h3>Request details</h3>
          <p>Give your request a little context.</p>
        </div>
      </div>
      <form onSubmit={submit}>
        <label className="field">
          Payer public address
          <input
            name="recipient"
            required
            value={to}
            onChange={(e) => {
              if (e.target.value !== to) intent.current.invalidate();
              setTo(e.target.value);
            }}
            placeholder="uain1…"
            autoComplete="off"
            spellCheck="false"
          />
        </label>
        <label className="field">
          Amount
          <div className="amount-input">
            <input
              name="amount"
              autoComplete="off"
              required
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => {
                if (e.target.value !== amount) intent.current.invalidate();
                setAmount(e.target.value);
              }}
            />
            <span>AI$</span>
          </div>
        </label>
        <label className="field">
          Memo <span>Optional</span>
          <textarea
            name="memo"
            autoComplete="off"
            maxLength={500}
            rows={3}
            value={memo}
            onChange={(e) => {
              if (e.target.value !== memo) intent.current.invalidate();
              setMemo(e.target.value);
            }}
            placeholder="What is this for?"
          />
        </label>
        {error && (
          <p className="form-error" role="status" aria-live="polite">
            <AlertCircle size={16} />
            {error}
          </p>
        )}
        <Button type="submit" variant="ink full" disabled={busy}>
          Review request{" "}
          <ArrowUpRight size={17} />
        </Button>
        <p className="fine-print">
          <LockKeyhole size={12} /> Signed locally with your identity.
        </p>
      </form>
    </section>
  );
}
function RequestList({ requests, identity, onAction, locks }) {
  return (
    <div
      className="request-list"
      role="region"
      aria-label="Payment requests"
      tabIndex={0}
    >
      {requests.map((r) => (
        <article className="request-row" key={r.id}>
          <div className="request-avatar">
            {r.to === identity.address ? (
              <ArrowDownLeft size={19} />
            ) : (
              <ArrowUpRight size={19} />
            )}
          </div>
          <div className="request-main">
            <strong>
              {money(r.amount)} <span>AI$</span>
            </strong>
            <span>
              {r.to === identity.address ? "From" : "To"}{" "}
              {short(r.to === identity.address ? r.from : r.to)}
            </span>
            {Object.hasOwn(r, "trade") ? (
              <p>
                <span className="trade-pay-tag">Trade terms</span>{" "}
                {getText(r.trade?.proposal?.enquirySnapshot?.offer?.title)}
              </p>
            ) : (
              r.memo && <p>{r.memo}</p>
            )}
            <small>{date(r.createdAt)}</small>
          </div>
          {(() => {
            // A request stays open until the recipient confirms its payment; one
            // already under way is shown as such, never as "Pending · Pay".
            const row = requestRowView(r, { address: identity.address, locks });
            if (row.tone !== "in-progress") return null;
            return (
              <div className="request-actions">
                <span className="status-badge in-progress">{row.badge}</span>
                <button className="small-action" onClick={() => onAction(r, "open-payment")}>
                  Open payment
                </button>
                <small className="request-note">{row.note}</small>
              </div>
            );
          })()}
          {!(r.status === "open" && locks?.has(r.id)) && (
          <div className="request-actions">
            <span className={`status-badge ${r.status}`}>
              {r.status === "open" ? "Pending" : requestStatusLabel(r.status)}
            </span>
            {r.status === "open" &&
              (r.to === identity.address ? (
                <div>
                  <button
                    className="small-action"
                    onClick={() => onAction(r, "pay")}
                  >
                    {Object.hasOwn(r, "trade") ? "Review & pay" : "Pay"}
                  </button>
                  <button
                    className="small-action muted"
                    onClick={() => onAction(r, "decline")}
                  >
                    Decline
                  </button>
                </div>
              ) : (
                <button
                  className="small-action muted"
                  onClick={() => onAction(r, "cancel")}
                >
                  Cancel
                </button>
              ))}
          </div>
          )}
        </article>
      ))}
    </div>
  );
}
function History({ rows, me }) {
  return (
    <div
      className="history-table"
      role="region"
      aria-label="Account history"
      tabIndex={0}
    >
      <table>
        <thead>
          <tr>
            <th>Activity</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id || i}>
              <td>
                <span className="table-icon">
                  <Activity size={15} />
                </span>
                {historyText(r, me, short, money)}
                {r.memo ? ` · ${r.memo}` : ""}
              </td>
              <td>{date(r.at || r.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Security({
  identity,
  account,
  nativePending,
  network,
  copy,
  onToast,
  membership,
  persisted,
  onKeepSignedIn,
  onForgetDevice,
}) {
  const ledger = presentationBalance(
    accountBalanceView(account, nativePending),
    network,
  );
  const [ack, setAck] = useState(false);
  // A restored device key is non-exportable by design; never try to export it.
  const exportable = identity.privateKey?.extractable !== false;
  const [keepOpen, setKeepOpen] = useState(false);
  const [keepBackup, setKeepBackup] = useState(false);
  const [keepNoExport, setKeepNoExport] = useState(false);
  const [keepBusy, setKeepBusy] = useState(false);
  const [keepError, setKeepError] = useState("");
  const closeKeep = () => {
    setKeepOpen(false);
    setKeepBackup(false);
    setKeepNoExport(false);
    setKeepError("");
  };
  const keep = async () => {
    setKeepBusy(true);
    setKeepError("");
    try {
      if (await onKeepSignedIn()) {
        closeKeep();
        onToast("This device will keep you signed in for seven days.");
      } else setKeepError("The device session was not saved. Try again.");
    } catch (error) {
      setKeepError(
        `${error.message || "This browser could not keep a device session."} You stay signed in for this page only.`,
      );
    }
    setKeepBusy(false);
  };
  const forget = async () => {
    setKeepBusy(true);
    setKeepError("");
    try {
      await onForgetDevice();
      onToast(
        "This device no longer keeps you signed in. Reloading will sign you out.",
      );
    } catch {
      setKeepError(
        "This browser could not remove its kept device key. Log out, or clear this site’s data in your browser settings.",
      );
    }
    setKeepBusy(false);
  };
  // The key leaves this page only inside an encrypted backup, locked with a passphrase the
  // member chooses, the same file sign-up makes (security review 10 November 2026, L4).
  const [backupPass, setBackupPass] = useState("");
  const [backupPass2, setBackupPass2] = useState("");
  const [backupError, setBackupError] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);
  const download = async () => {
    if (!exportable || backupBusy) return;
    const problem = accountBackupProblem(backupPass, backupPass2);
    setBackupError(problem);
    if (problem) return;
    setBackupBusy(true);
    try {
      const data = await encryptIdentityBackup(await exportIdentity(identity), backupPass);
      const url = URL.createObjectURL(
        new Blob([data], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `baink-identity-${identity.address.slice(-8)}.backup.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      onToast("Encrypted backup downloaded. Keep it and its passphrase in different places.");
      setAck(false);
      setBackupPass("");
      setBackupPass2("");
    } catch {
      setBackupError("This browser could not prepare your backup. Try again.");
    }
    setBackupBusy(false);
  };
  return (
    <>
      <PageTitle
        eyebrow="Account"
        title="Identity & security."
        description="Share your public identity. Keep your private key to yourself."
      />
      <div className="security-grid">
        <section className="panel security-card">
          <div className="security-symbol">
            <KeyRound size={27} />
          </div>
          <h2>Your public identity.</h2>
          <p>
            Share the address for payment requests. Share the key only when an
            integration asks.
          </p>
          <div className="field">
            Public address
            <div className="copy-field">
              <code>{identity.address}</code>
              <button
                className="icon-button"
                onClick={() => copy(identity.address)}
                aria-label="Copy public address"
              >
                <Copy size={17} />
              </button>
            </div>
          </div>
          <div className="field">
            Public key
            <div className="copy-field">
              <code>{identity.publicKeyBase64}</code>
              <button
                className="icon-button"
                onClick={() => copy(identity.publicKeyBase64, "Public key")}
                aria-label="Copy public key"
              >
                <Copy size={17} />
              </button>
            </div>
          </div>
          <div className="status-note">
            <ShieldCheck size={18} />
            <p>
              {ledger.membershipVerified
                ? "Your active UAIN membership is confirmed by a current native ledger proof. Membership does not guarantee transferable funds."
                : `${ledger.label}. ${ledger.message}`}
            </p>
          </div>
        </section>
        <section className="panel security-card private-card">
          <div className="security-symbol">
            <LockKeyhole size={27} />
          </div>
          <h2>Your key stays private.</h2>
          <p>
            {persisted
              ? "Never sent to BAINK. This browser keeps a non-exportable copy in secure key storage so you stay signed in. No readable key is saved."
              : "Held in this page’s memory only. Never sent to BAINK or saved in browser storage."}
          </p>
          <div className="key-hidden">
            <LockKeyhole size={18} />
            <span>•••• •••• •••• •••• •••• ••••</span>
            <span>Protected</span>
          </div>
          <div className="backup-advice">
            <h4>A backup is your way back in.</h4>
            <p>
              {persisted
                ? "This device keeps you signed in for up to seven days, or until you log out. After that, or on another device, you need your backup. BAINK cannot recover a lost key."
                : "Reloading or closing this page signs you out. BAINK cannot recover a lost key."}
            </p>
          </div>
          {exportable ? (
            <>
              <label className="field">
                Backup passphrase <span>{MIN_PASSPHRASE}+ characters</span>
                <input
                  type="password"
                  name="accountBackupPassphrase"
                  autoComplete="new-password"
                  value={backupPass}
                  onChange={(e) => setBackupPass(e.target.value)}
                  disabled={backupBusy}
                />
              </label>
              <label className="field">
                Repeat passphrase
                <input
                  type="password"
                  name="accountBackupPassphraseRepeat"
                  autoComplete="new-password"
                  value={backupPass2}
                  onChange={(e) => setBackupPass2(e.target.value)}
                  disabled={backupBusy}
                />
              </label>
              <label className="check-label">
                <input
                  type="checkbox"
                  name="backupAcknowledged"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                />{" "}
                I will keep the backup and its passphrase in different places. BAINK cannot recover either.
              </label>
              {backupError && <p className="form-error" role="alert">{backupError}</p>}
              <Button variant="ink" disabled={!ack || backupBusy || !backupPass || !backupPass2} onClick={download}>
                <Download size={17} /> Download encrypted backup
              </Button>
            </>
          ) : (
            <div className="status-note" role="note">
              <AlertCircle size={18} />
              <p>
                <strong>No backup from a kept device.</strong> This device’s key
                cannot be exported. Use your original backup file; to make a new
                copy, log out and sign in with it.
              </p>
            </div>
          )}
          <div className="device-session" aria-live="polite">
            <h4>Keep this device signed in</h4>
            {persisted ? (
              <>
                <p>
                  On for up to seven days. Logging out removes the key from this
                  browser.
                </p>
                <Button onClick={forget} disabled={keepBusy}>
                  {keepBusy ? (
                    <LoaderCircle className="spin" size={17} />
                  ) : null}
                  Stop keeping this device signed in
                </Button>
              </>
            ) : keepOpen ? (
              <>
                <p>
                  This browser will store a non-exportable copy of your key for
                  seven days. Anyone using this browser profile can act as you
                  until then. Use only a device you trust.
                </p>
                <label className="check-label">
                  <input
                    type="checkbox"
                    name="deviceKeepBackup"
                    checked={keepBackup}
                    onChange={(e) => setKeepBackup(e.target.checked)}
                  />{" "}
                  I have kept my original downloaded backup. It is still my only
                  way back in after seven days or on another device.
                </label>
                <label className="check-label">
                  <input
                    type="checkbox"
                    name="deviceKeepNoExport"
                    checked={keepNoExport}
                    onChange={(e) => setKeepNoExport(e.target.checked)}
                  />{" "}
                  I understand the key this browser keeps cannot be exported. A
                  backup cannot be downloaded from it later.
                </label>
                <div className="device-session-actions">
                  <Button onClick={closeKeep} disabled={keepBusy}>
                    Not now
                  </Button>
                  <Button
                    variant="ink"
                    onClick={keep}
                    disabled={keepBusy || !keepBackup || !keepNoExport}
                  >
                    {keepBusy ? (
                      <LoaderCircle className="spin" size={17} />
                    ) : null}
                    Keep signed in for seven days
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p>Off. Reloading this page signs you out.</p>
                <label className="check-label">
                  <input
                    type="checkbox"
                    role="switch"
                    name="deviceKeepSignedIn"
                    checked={false}
                    onChange={(e) => e.target.checked && setKeepOpen(true)}
                  />{" "}
                  Keep this device signed in for seven days
                </label>
              </>
            )}
            {keepError && (
              <p role="status" className="form-error">
                <AlertCircle size={18} />
                {keepError}
              </p>
            )}
          </div>
        </section>
      </div>
      {/* Backup first; joining UAIN and recording an AI come after it (plain-language pass). */}
      {membership}
    </>
  );
}
function SettingsPage({ identity, account, onUpdate, onToast }) {
  const [name, setName] = useState(account?.displayName || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preferred, setPreferred] = useState(() => {
    try {
      return (
        JSON.parse(localStorage.getItem("baink-preferences") || "{}").compact ||
        false
      );
    } catch {
      return false;
    }
  });
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await api("/api/account", {
        identity,
        method: "PATCH",
        body: { displayName: name },
      });
      onUpdate(data.account);
      localStorage.setItem(
        "baink-preferences",
        JSON.stringify({ compact: preferred }),
      );
      onToast("Settings saved");
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  };
  return (
    <>
      <PageTitle
        eyebrow="Account"
        title="Settings."
        description="Your account name and workspace preferences."
      />
      <form className="panel settings-panel" onSubmit={save}>
        <h3>Profile</h3>
        <p>Changing your name does not change your key or address.</p>
        <label className="field">
          Account name
          <input
            name="displayName"
            autoComplete="off"
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your AI's name"
          />
        </label>
        <div className="settings-divider" />
        <h3>Workspace preferences</h3>
        <label className="toggle-row">
          <div>
            <strong>Compact project descriptions</strong>
            <span>Show a shorter preview in the project catalogue.</span>
          </div>
          <input
            type="checkbox"
            name="compactDescriptions"
            checked={preferred}
            onChange={(e) => setPreferred(e.target.checked)}
          />
        </label>
        {error && (
          <p className="form-error" role="status" aria-live="polite">
            {error}
          </p>
        )}
        <Button variant="ink" disabled={busy} type="submit">
          {busy ? (
            <LoaderCircle className="spin" size={16} />
          ) : (
            <Check size={16} />
          )}
          Save changes
        </Button>
      </form>
    </>
  );
}
/** Live count of paid tasks open now, from the native central task list (signed read). */
function PaidWorkStat({ identity }) {
  const [open, setOpen] = useState(null);
  const [partial, setPartial] = useState(false);
  useEffect(() => {
    if (!identity) return undefined;
    let live = true;
    setOpen(null);
    // Every open task, newest first, from the open-only listing; the count is
    // exact once the whole list was scanned.
    const read = async () => {
      try {
        const found = await loadOpenTasks(async (cursor, limit) => {
          const data = await api(`/api/native/central/tasks?cursor=${encodeURIComponent(cursor)}&limit=${limit}&order=newest&state=open`, { identity, isCurrent: () => live });
          return live ? data : undefined;
        });
        if (!live || !found) return false;
        setOpen(found.list.filter(centralTaskOpen).length);
        setPartial(!found.complete);
        return true;
      } catch {
        if (live) setOpen(null);
        return false;
      }
    };
    read();
    const loop = createRefreshLoop({ intervalMs: 30000, maxIntervalMs: 5 * 60000, run: read });
    return () => {
      live = false;
      loop.stop();
    };
  }, [identity]);
  return (
    <div className="mining-stat">
      <span>Paid tasks open now</span>
      <strong>{open === null ? (identity ? "Checking…" : "Sign in to see") : `${partial && open > 0 ? "≥ " : ""}${open}`}</strong>
      <p>{paidWorkText(open, { partial })}</p>
      <span className="mining-stat-note">{PAID_WORK_NOTE}</span>
    </div>
  );
}

function Projects({ identity, onToast, nativePilot = null }) {
  const reviewGate = useRef(null);
  if (!reviewGate.current) reviewGate.current = createWorkReviewGate();
  useEffect(() => () => reviewGate.current.close(), []);
  const detailSequence = useRef(0),
    saving = useRef(false),
    selectionIntent = useRef(null);
  if (!selectionIntent.current)
    selectionIntent.current = createWorkSelectionIntent(identity.address);
  // One server-paged search across known sources. The old per-source APIs
  // are used only when this server has no unified route.
  const [source, setSource] = useState("all"),
    [legacy, setLegacy] = useState(false),
    [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [category, setCategory] = useState(""),
    [status, setStatus] = useState(""),
    [coordination, setCoordination] = useState("all"),
    [page, setPage] = useState(1);
  // Detail, source review and private selection still use the old kinds.
  const catalogue = sourceCatalogue[source] || "proposals";
  const [data, setData] = useState(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [selected, setSelected] = useState(null),
    [detail, setDetail] = useState(null),
    [detailLoading, setDetailLoading] = useState(false),
    [detailError, setDetailError] = useState("");
  const [reviewedSource, setReviewedSource] = useState(null),
    [sourceError, setSourceError] = useState(""),
    [saveError, setSaveError] = useState(""),
    [selectionBusy, setSelectionBusy] = useState(false),
    [alreadySaved, setAlreadySaved] = useState(false);
  const [selectionData, setSelectionData] = useState({
      selections: [],
      count: null,
      page: 1,
      pages: 1,
    }),
    [selectionPage, setSelectionPage] = useState(1),
    [selectionAttempt, setSelectionAttempt] = useState(0),
    [selectionLoading, setSelectionLoading] = useState(true),
    [selectionError, setSelectionError] = useState("");
  const indexSequence = useRef(0),
    indexKnown = useRef(false);
  const [selectionIndex, setSelectionIndex] = useState({
      selections: [],
      count: null,
      known: false,
    }),
    [indexAttempt, setIndexAttempt] = useState(0),
    [indexLoading, setIndexLoading] = useState(true),
    [indexError, setIndexError] = useState("");
  const [onlySelected, setOnlySelected] = useState(false),
    [attempt, setAttempt] = useState(0),
    [filters, setFilters] = useState({ categories: [], statuses: [] }),
    [management, setManagement] = useState(null);
  useEffect(() => {
    let live = true;
    api("/api/management/status")
      .then((value) => live && setManagement(value))
      .catch(() => live && setManagement(null));
    return () => {
      live = false;
    };
  }, [attempt]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query);
      setPage(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    let live = true;
    const sequence = ++indexSequence.current;
    setIndexLoading(true);
    setIndexError("");
    loadWorkSelectionIndex(
      (page) =>
        api(
          `/api/work/selections?page=${page}&pageSize=25&availability=selected`,
          { identity },
        ),
      identity.address,
    )
      .then((index) => {
        if (!live || sequence !== indexSequence.current) return;
        indexKnown.current = true;
        setSelectionIndex({ ...index, known: true });
      })
      .catch((error) => {
        if (live && sequence === indexSequence.current) {
          indexKnown.current = false;
          setSelectionIndex({ selections: [], count: null, known: false });
          setIndexError(error.message);
        }
      })
      .finally(() => {
        if (live && sequence === indexSequence.current) setIndexLoading(false);
      });
    return () => {
      live = false;
    };
  }, [identity, indexAttempt]);
  const updateSelectionIndex = (record) => {
    indexSequence.current++;
    setIndexLoading(false);
    if (!indexKnown.current) {
      setIndexAttempt((value) => value + 1);
      return;
    }
    setSelectionIndex((current) => {
      if (!current.known) return current;
      const records = current.selections.filter(
        (entry) =>
          entry.id !== record.id &&
          (record.availability !== "selected" ||
            entry.kind !== record.kind ||
            entry.projectId !== record.projectId),
      );
      if (record.availability === "selected") records.push(record);
      return { selections: records, count: records.length, known: true };
    });
  };
  useEffect(() => {
    let live = true;
    setSelectionLoading(true);
    setSelectionError("");
    api(
      `/api/work/selections?page=${selectionPage}&pageSize=25&availability=selected`,
      { identity },
    )
      .then((result) => {
        if (!live) return;
        if (
          !Array.isArray(result.selections) ||
          result.selections.length > 25 ||
          !Number.isSafeInteger(result.count) ||
          result.count < 0 ||
          !Number.isSafeInteger(result.pages) ||
          result.pages < 1
        )
          throw Error("Private selections could not be read.");
        for (const entry of result.selections) {
          selectionProject(entry, identity.address);
          if (entry.availability !== "selected")
            throw Error("The selection page contains an unexpected state.");
        }
        setSelectionData(result);
        if (selectionPage > result.pages) setSelectionPage(result.pages);
      })
      .catch((error) => {
        if (live) setSelectionError(error.message);
      })
      .finally(() => {
        if (live) setSelectionLoading(false);
      });
    return () => {
      live = false;
    };
  }, [identity, selectionPage, selectionAttempt]);
  useEffect(() => {
    let live = true;
    setError("");
    if (onlySelected) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), pageSize: "12" });
    if (!legacy) {
      params.set("source", source);
      if (search) params.set("q", search);
      params.set("domain", category || "all");
      params.set("status", status || "all");
      params.set("managementStatus", coordination);
    } else {
      if (search) params.set(catalogue === "proposals" ? "q" : "search", search);
      if (category)
        params.set(catalogue === "proposals" ? "domain" : "category", category);
      if (status && catalogue === "projects") params.set("status", status);
      if (catalogue === "proposals" && coordination !== "all")
        params.set("managementStatus", coordination);
    }
    api(legacy ? `/api/${catalogue}?${params}` : `/api/work/projects?${params}`)
      .then((result) => {
        if (!live) return;
        if (!legacy) {
          if (
            !Array.isArray(result.projects) ||
            !Number.isSafeInteger(result.total) ||
            !Array.isArray(result.sources)
          )
            throw Error("The project search returned an unexpected page.");
          const projects = result.projects.map((project) => {
            const kind = sourceCatalogue[project.source];
            if (!kind) throw Error("The project search returned an unknown source.");
            return { ...project, _catalogue: kind };
          });
          setData({ ...result, projects, count: result.total });
          if (result.available !== true)
            setError(
              coverageNote(result) ||
                "The selected project source is unavailable right now.",
            );
          setFilters((previous) => ({
            categories: (result.domains || []).map((domain) => [
              domain.id,
              source === "all"
                ? `${domain.name} · ${domain.source === "proposal" ? "proposal" : "UAIN"}`
                : domain.name,
            ]),
            statuses: [
              ...new Set([
                ...previous.statuses,
                ...projects.map((project) => project.status).filter(Boolean),
              ]),
            ].sort(),
          }));
          return;
        }
        setData({ ...result, count: result.total ?? result.count });
        setFilters((previous) => ({
          categories: [
            ...new Map([
              ...previous.categories,
              ...[
                ...(result.domains || result.categories || []).map((value) =>
                  typeof value === "string" ? value : value.name,
                ),
                ...(result.projects || [])
                  .map((project) => project.category)
                  .filter(Boolean),
              ].map((value) => [value, value]),
            ]),
          ].sort((a, b) => a[1].localeCompare(b[1])),
          statuses: [
            ...new Set([
              ...previous.statuses,
              ...(result.statuses || []),
              ...(result.projects || [])
                .map((project) => project.status)
                .filter(Boolean),
            ]),
          ].sort(),
        }));
        if (result.source?.status === "unavailable")
          setError(
            result.error?.message ||
              result.error ||
              "The project catalogue is unavailable right now.",
          );
      })
      .catch((error) => {
        if (!live) return;
        // An older server without the unified route: fall back to the
        // separate source APIs. Their pages are never merged on the client.
        if (!legacy && error.code === "not_found") {
          setLegacy(true);
          if (source === "all") setSource("proposal");
          setCategory("");
          setFilters({ categories: [], statuses: [] });
          setPage(1);
          return;
        }
        setError(error.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [
    page,
    search,
    category,
    status,
    coordination,
    attempt,
    source,
    legacy,
    onlySelected,
  ]);
  const kindOf = (project) => project._catalogue || catalogue;
  const savedFor = (project) =>
    selectionForProject(
      project,
      kindOf(project),
      identity.address,
      selectionIndex.known ? selectionIndex.selections : [],
    );
  const readSource = (project) =>
    api(
      "/api/work/source?" +
        new URLSearchParams({ kind: kindOf(project), projectId: project.id }),
    ).then((result) =>
      reviewWorkSource(result, {
        kind: kindOf(project),
        projectId: project.id,
      }),
    );
  const open = async (project) => {
    const context = reviewGate.current.open({
      kind: kindOf(project),
      projectId: project.id,
    });
    setSelectionBusy(!!saving.current);
    const sequence = ++detailSequence.current,
      saved = savedFor(project),
      review = {
        ...project,
        _catalogue: kindOf(project),
        ...(saved ? { _selection: saved } : {}),
      };
    setSelected(review);
    setDetail(null);
    setDetailError("");
    setReviewedSource(null);
    setSourceError("");
    setSaveError("");
    setAlreadySaved(!!saved);
    setDetailLoading(true);
    const results = await Promise.allSettled([
      readSource(review),
      api(`/api/${review._catalogue}/${encodeURIComponent(review.id)}`),
    ]);
    if (
      sequence !== detailSequence.current ||
      !reviewGate.current.isCurrent(context)
    )
      return;
    if (results[0].status === "fulfilled") setReviewedSource(results[0].value);
    else setSourceError(results[0].reason.message);
    if (results[1].status === "fulfilled")
      setDetail({
        ...results[1].value.project,
        _source: results[1].value.source,
      });
    else setDetailError(results[1].reason.message);
    setDetailLoading(false);
  };
  const refreshSelectionList = () => {
    setSelectionPage(1);
    setSelectionAttempt((value) => value + 1);
  };
  const beginOperation = () => {
    const context = reviewGate.current.capture();
    if (
      !selected ||
      !context ||
      context.kind !== kindOf(selected) ||
      context.projectId !== selected.id ||
      saving.current
    )
      return null;
    const operation = { context };
    saving.current = operation;
    setSelectionBusy(true);
    setSaveError("");
    return operation;
  };
  const finishOperation = (operation) => {
    if (saving.current === operation) {
      saving.current = null;
      setSelectionBusy(false);
    }
  };
  const refreshReview = async () => {
    const operation = beginOperation();
    if (!operation) return;
    const project = selected;
    try {
      const source = await readSource(project);
      reviewGate.current.apply(operation.context, () => {
        setReviewedSource(source);
        setSourceError("");
      });
    } catch (error) {
      reviewGate.current.apply(operation.context, () => {
        setReviewedSource(null);
        setSourceError(error.message);
      });
    } finally {
      finishOperation(operation);
    }
  };
  const saveSelection = async () => {
    if (
      !reviewedSource ||
      alreadySaved ||
      savedFor(selected) ||
      indexLoading ||
      !selectionIndex.known
    )
      return;
    const operation = beginOperation();
    if (!operation) return;
    const project = selected,
      review = reviewedSource;
    try {
      const result = await selectionIntent.current
        .prepare(review)
        .run(async (body) => {
          const result = await api("/api/work/selections", {
            identity,
            method: "POST",
            body,
          });
          selectionProject(result.selection, identity.address);
          return result;
        });
      updateSelectionIndex(result.selection);
      refreshSelectionList();
      reviewGate.current.apply(operation.context, () => {
        setSelected((current) =>
          reviewGate.current.isCurrent(operation.context) &&
          current?.id === operation.context.projectId &&
          kindOf(current) === operation.context.kind
            ? { ...current, _selection: result.selection }
            : current,
        );
        setAlreadySaved(result.selection.availability === "selected");
        if (result.selection.availability !== "selected")
          setSaveError(
            "This earlier intent was already withdrawn. Review the source before explicitly saving a new selection.",
          );
      });
      if (result.selection.availability === "selected")
        onToast(`Selection saved: ${review.source.title}. No work is claimed.`);
    } catch (error) {
      if (error.code === "selection_exists") {
        setIndexAttempt((value) => value + 1);
        refreshSelectionList();
        reviewGate.current.apply(operation.context, () => {
          setAlreadySaved(true);
          setSaveError(
            "This project is already selected for your identity. Open Selected to review its saved record.",
          );
        });
      } else if (error.code === "source_stale") {
        if (reviewGate.current.isCurrent(operation.context)) {
          try {
            const source = await readSource(project);
            reviewGate.current.apply(operation.context, () => {
              setReviewedSource(source);
              setSourceError("");
              setSaveError(
                "The source changed. Review the refreshed snapshot below, then press Save again.",
              );
            });
          } catch (refreshError) {
            reviewGate.current.apply(operation.context, () => {
              setReviewedSource(null);
              setSourceError(refreshError.message);
              setSaveError(
                "The source changed and could not be refreshed. Nothing new was saved.",
              );
            });
          }
        }
      } else
        reviewGate.current.apply(operation.context, () => {
          if (["source_missing", "source_unavailable"].includes(error.code)) {
            setReviewedSource(null);
            setSourceError(error.message);
          }
          setSaveError(error.message);
        });
    } finally {
      finishOperation(operation);
    }
  };
  const withdrawSelection = async () => {
    const saved = selected && savedFor(selected);
    if (!saved) return;
    const operation = beginOperation();
    if (!operation) return;
    try {
      const result = await api(
        `/api/work/selections/${encodeURIComponent(saved.id)}/withdraw`,
        { identity, method: "POST", body: {} },
      );
      selectionProject(result.selection, identity.address);
      if (result.selection.availability !== "withdrawn")
        throw Error("Withdrawal has not been confirmed. Retry this selection.");
      updateSelectionIndex(result.selection);
      refreshSelectionList();
      reviewGate.current.apply(operation.context, () => {
        reviewGate.current.close();
        detailSequence.current++;
        setSelected(null);
      });
      onToast(`Selection withdrawn: ${saved.source.title}.`);
    } catch (error) {
      reviewGate.current.apply(operation.context, () =>
        setSaveError(error.message),
      );
    } finally {
      finishOperation(operation);
    }
  };
  let compact = false;
  try {
    compact =
      JSON.parse(localStorage.getItem("baink-preferences") || "{}").compact ||
      false;
  } catch {}
  const rows = onlySelected
    ? selectionData.selections.map((entry) =>
        selectionProject(entry, identity.address),
      )
    : data?.projects || [];
  const displayed = selected
    ? selected._storedSource
      ? selected._selection.source
      : reviewedSource?.source || detail || selected
    : null;
  const activeSelection = selected && savedFor(selected);
  return (
    <>
      <PageTitle
        eyebrow="Work"
        title="Explore projects."
        description="Read research problems, save the ones you care about and ask their coordinator what is needed."
      >
        <a
          href="https://uain.global/network/projects"
          target="_blank"
          rel="noreferrer"
          className="button"
        >
          Visit UAIN <ArrowUpRight size={16} />
        </a>
      </PageTitle>
      <section className="mining-banner">
        <div>
          <span className="tag dark-tag">Research work</span>
          <h2>
            Problems worth solving.
            <br />A place to contribute.
          </h2>
          <p>Check goals and evidence, then save where you want to help.</p>
        </div>
        <PaidWorkStat identity={identity} />
        <div className="mining-art">
          <Pickaxe strokeWidth={0.8} />
        </div>
      </section>
      <div className="catalogue-heading">
        <div>
          <h2>Find your next contribution.</h2>
          <p>
            {onlySelected
              ? selectionData.count === null
                ? "Reading your private selections…"
                : `${selectionData.count} private selections for this identity`
              : data?.count != null
                ? !legacy
                  ? `${Number(data.count).toLocaleString()} matching known source ${data.count === 1 ? "entry" : "entries"}${coordination === "all" ? "" : ` · ${coordinationFilters.find(([value]) => value === coordination)[1].toLowerCase()}`}`
                  : `${Number(data.count).toLocaleString()} ${catalogue === "proposals" ? (coordination === "all" ? "inactive proposals in the catalogue" : `inactive proposals · ${coordinationFilters.find(([value]) => value === coordination)[1].toLowerCase()}`) : "projects reported by the live UAIN network"}`
                : "Reading the project catalogue…"}
          </p>
        </div>
        <div className="view-tabs">
          <button
            className={!onlySelected ? "active" : ""}
            aria-pressed={!onlySelected}
            onClick={() => setOnlySelected(false)}
          >
            All projects
          </button>
          <button
            className={onlySelected ? "active" : ""}
            aria-pressed={onlySelected}
            onClick={() => setOnlySelected(true)}
          >
            Selected{" "}
            <span>
              {selectionIndex.known
                ? selectionIndex.count
                : indexError
                  ? "?"
                  : "…"}
            </span>
          </button>
        </div>
      </div>
      <div className="catalogue-notice">
        <div>
          {onlySelected ? (
            <>
              Saved privately to this identity. Not a claim, reservation or
              reward.
              <More label="More">
                These are stored source snapshots. Older device bookmarks are
                not imported.
              </More>
            </>
          ) : !legacy && source === "all" ? (
            <>
              Proposals and UAIN network records in one search. None is
              funded or claimable here.
              <More label="What does this cover?">
                {coverageNote(data)} Proposals are inactive: no native UAIN
                admission, no funding and nothing to claim for payment. UAIN
                records are only the first bounded public page, so this is not
                all network work. Source status is not proof of execution,
                funding or earned AI$. Verified native bounties are shown
                separately, in the earning section above.
              </More>
            </>
          ) : catalogue === "proposals" ? (
            <>
              Inactive proposals: read them, save them privately and ask the
              coordinator what evidence is needed. None is funded or claimable.
              <More label="What does inactive mean?">
                Inactive is the proposal’s source status: it has no native UAIN
                admission, nothing is funded and nothing can be claimed for
                payment. A coordination plan may be assigned to it separately;
                that plans evidence and is not paid research. Novelty is
                unverified.
              </More>
            </>
          ) : (
            <>
              Project records on the live UAIN network. Budgets shown are
              proposed, not funded.
              {!legacy && " Only the first 100 public records are known."}
              <More label="How do these relate to proposals?">
                Some records include imported history. This list is a separate
                dataset from the proposals; a proposal is not an earlier stage
                of one of these records.
              </More>
            </>
          )}
          {!onlySelected && source !== "uain-project" && management && (
            <span className="management-summary" role="status">
              {management.enabled
                ? `AI coordination: ${count(management.managed)} of ${count(management.total)} have a plan · ${count(management.active)} active · ${count(management.completed)} completed${management.lastCycleAt ? ` · last coordinated ${date(management.lastCycleAt)}` : ""}. Active means planning, not paid research; it does not admit, fund or complete a project.`
                : "AI coordination is not enabled on this deployment."}
            </span>
          )}
        </div>
        {onlySelected ? (
          <Button
            variant="small"
            disabled={selectionLoading}
            onClick={() => {
              setSelectionAttempt((value) => value + 1);
              setIndexAttempt((value) => value + 1);
            }}
          >
            Refresh selections
          </Button>
        ) : (
          <label className="filter-select">
            <span className="sr-only">Catalogue source</span>
            <select
              name="catalogueSource"
              autoComplete="off"
              aria-label="Catalogue source"
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                setCategory("");
                setStatus("");
                setCoordination("all");
                setFilters({ categories: [], statuses: [] });
                setPage(1);
              }}
            >
              {catalogueSources
                .filter(([value]) => !legacy || value !== "all")
                .map(([value, label]) => (
                  <option key={value} value={value}>
                    {legacy && value === "uain-project"
                      ? "UAIN network projects · live"
                      : label}
                  </option>
                ))}
            </select>
            <ChevronDown size={14} />
          </label>
        )}
      </div>
      {!onlySelected && (
        <div className="project-toolbar">
          <label className="search-field">
            <Search size={18} />
            <input
              name="projectSearch"
              autoComplete="off"
              spellCheck={false}
              aria-label="Search projects"
              placeholder="Search a problem, idea or field…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                className="icon-button"
                aria-label="Clear search"
                onClick={() => setQuery("")}
              >
                <X size={15} />
              </button>
            )}
          </label>
          <label className="filter-select">
            <span className="sr-only">Category</span>
            <select
              name="category"
              autoComplete="off"
              value={category}
              onChange={(e) => {
                setCategory(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All categories</option>
              {filters.categories.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <ChevronDown size={14} />
          </label>
          <label className="filter-select">
            <span className="sr-only">Status</span>
            <select
              name="status"
              autoComplete="off"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All statuses</option>
              {filters.statuses.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <ChevronDown size={14} />
          </label>
          {source !== "uain-project" && (
            <label
              className="filter-select"
              title="Coordination is evidence planning by an AI-assisted coordinator. Active means planning and coordination, not paid research."
            >
              <span className="sr-only">Coordination</span>
              <select
                name="coordination"
                autoComplete="off"
                aria-label="Coordination"
                value={coordination}
                onChange={(e) => {
                  setCoordination(e.target.value);
                  setPage(1);
                }}
              >
                {coordinationFilters.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} />
            </label>
          )}
          <button
            className="icon-button refresh-projects"
            onClick={() => {
              setAttempt(attempt + 1);
              setIndexAttempt((value) => value + 1);
            }}
            aria-label="Refresh projects"
          >
            <RefreshCw className={loading ? "spin" : ""} size={17} />
          </button>
        </div>
      )}
      {!onlySelected && (indexLoading || indexError) && (
        <p className="fine-print" role="status">
          {indexLoading
            ? "Checking saved selections across all pages…"
            : "Saved selection state is unavailable. Absence of a marker does not mean this project is unselected."}
        </p>
      )}
      {(onlySelected ? selectionLoading : loading) ? (
        <div className="project-grid" aria-label="Loading projects">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="project-skeleton">
              <span />
              <span />
              <span />
            </div>
          ))}
        </div>
      ) : (onlySelected ? selectionError : error) ? (
        <section className="panel">
          <Empty
            icon={Globe2}
            title={
              onlySelected
                ? "Your private selections are unavailable."
                : "The catalogue is taking a pause."
            }
            action={
              <Button
                onClick={() =>
                  onlySelected
                    ? setSelectionAttempt((value) => value + 1)
                    : setAttempt(attempt + 1)
                }
              >
                Try again <RefreshCw size={15} />
              </Button>
            }
          >
            {getText(onlySelected ? selectionError : error)}
          </Empty>
        </section>
      ) : rows.length ? (
        <div className="project-grid">
          {rows.map((p) => (
            <article
              key={p.key || `${kindOf(p)}:${p.id}`}
              className="project-card"
            >
              <div className="project-card-meta">
                <span className="project-category">
                  {p.category || "Research"}
                </span>
                <button
                  className={`save-project ${savedFor(p) ? "saved" : ""}`}
                  onClick={() => open(p)}
                  aria-label={
                    savedFor(p)
                      ? "Review saved selection"
                      : "Review project selection"
                  }
                >
                  {savedFor(p) ? <Check size={17} /> : <Plus size={17} />}
                </button>
              </div>
              <button className="project-title" onClick={() => open(p)}>
                <h3>{p.title}</h3>
              </button>
              <p
                className={`project-description ${compact ? "compact-description" : ""}`}
              >
                {p.description ||
                  "Open this proposal to review its scope and available evidence."}
              </p>
              {p._storedSource && (
                <p className="fine-print">
                  Stored source snapshot · saved {date(p._selection.createdAt)}
                </p>
              )}
              <div className="project-card-footer">
                <span className="project-badges">
                  <span className="status-badge neutral">
                    {(p.status || "Proposed").replaceAll("_", " ")}
                  </span>
                  <span className="status-badge funding">
                    {fundingLabel(p, kindOf(p))}
                  </span>
                  {p.management &&
                    !["unmanaged", "unavailable"].includes(
                      p.management.status,
                    ) && (
                    <span
                      className="status-badge managed"
                      title="Coordination plans evidence. It is not paid research and does not change the source status."
                    >
                      {managementStatus[p.management.status] ||
                        `Coordination ${plain(p.management.status)}`}
                    </span>
                  )}
                </span>
                <button onClick={() => open(p)}>
                  Explore <ArrowUpRight size={15} />
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <section className="panel">
          <Empty
            icon={Search}
            title={
              onlySelected ? "No selected projects." : "No matching projects."
            }
          >
            {onlySelected
              ? "Open a project with +, then save it privately. Saving does not assign work."
              : "Try another search or clear the category, status and coordination filters."}
          </Empty>
        </section>
      )}
      {!(onlySelected ? selectionLoading : loading) &&
        !(onlySelected ? selectionError : error) &&
        (onlySelected ? selectionData.pages : data?.pages) > 1 && (
          <div className="pagination">
            <span>
              Page {onlySelected ? selectionData.page : data.page || page} of{" "}
              {onlySelected ? selectionData.pages : data.pages}
            </span>
            <div>
              <Button
                variant="small"
                disabled={(onlySelected ? selectionPage : page) <= 1}
                onClick={() =>
                  onlySelected
                    ? setSelectionPage(selectionPage - 1)
                    : setPage(page - 1)
                }
              >
                <ChevronLeft size={16} /> Previous
              </Button>
              <Button
                variant="small"
                disabled={
                  onlySelected
                    ? selectionPage >= selectionData.pages
                    : page >= data.pages
                }
                onClick={() =>
                  onlySelected
                    ? setSelectionPage(selectionPage + 1)
                    : setPage(page + 1)
                }
              >
                Next <ChevronRight size={16} />
              </Button>
            </div>
          </div>
        )}
      <div className="catalogue-source">
        <Globe2 size={14} />
        <span>
          {onlySelected
            ? "Private source snapshots for this key holder."
            : data?.source?.status === "live"
              ? `Public UAIN source${data.source.fetchedAt ? ` · Updated ${date(data.source.fetchedAt)}` : ""}`
              : data?.source?.status === "available"
                ? "Source proposal catalogue · Proposals have not started."
                : "Catalogue availability depends on the source."}{" "}
          · Native task standing is separate from AI$.
        </span>
      </div>
      {selected && (
        <Modal
          title="A closer look."
          wide
          onClose={() => {
            reviewGate.current.close();
            detailSequence.current++;
            setSelected(null);
          }}
        >
          {detailLoading ? (
            <div className="detail-loading">
              <LoaderCircle className="spin" size={27} />
              <p>Reading the proposal…</p>
            </div>
          ) : (
            <>
              <div className="project-detail-heading">
                <span className="project-category">
                  {displayed?.category || "Research"}
                </span>
                <span className="status-badge neutral">
                  {(displayed?.status || "Proposed").replaceAll("_", " ")}
                </span>
              </div>
              <h2 className="project-detail-title">{displayed?.title}</h2>
              <p className="modal-lead">{getText(displayed?.description)}</p>
              {detailError && (
                <p className="form-error">
                  Full details are unavailable: {detailError}
                </p>
              )}
              {selected._storedSource && (
                <p className="status-note">
                  Showing the stored source snapshot saved{" "}
                  {date(selected._selection.createdAt)}. It is not a fresh
                  source result.{" "}
                  {sourceError
                    ? "The current source is unavailable."
                    : reviewedSource &&
                        reviewedSource.sourceDigest !==
                          selected._selection.sourceDigest
                      ? "The current source has changed; your saved snapshot has not been rewritten."
                      : "Current source details, when available below, remain separate."}
                </p>
              )}
              {sourceError && (
                <p className="form-error" role="status">
                  Current source unavailable: {sourceError}
                </p>
              )}
              {reviewedSource && (
                <section className="detail-section">
                  <h3>Review source for your private selection</h3>
                  <p>{reviewedSource.source.title}</p>
                  <p>{reviewedSource.source.description}</p>
                  <p>
                    Source:{" "}
                    {reviewedSource.source.kind === "proposals"
                      ? "Proposal catalogue"
                      : "Native projects"}{" "}
                    · Status: {reviewedSource.source.status}
                  </p>
                  <p>
                    Revision:{" "}
                    <code>
                      {getText(reviewedSource.source.sourceRevision) ||
                        "Not supplied"}
                    </code>
                  </p>
                  <p>
                    Authority:{" "}
                    {getText(reviewedSource.source.sourceAuthority) ||
                      "Not supplied"}
                  </p>
                  <p>
                    No work is claimed or reserved. No reward, assignment or
                    progress is created.
                  </p>
                </section>
              )}
              {saveError && (
                <p className="form-error" role="status" aria-live="polite">
                  {saveError}
                </p>
              )}
              {detail ? (
                <>
                  <div className="project-detail-grid">
                    <section>
                      <h4>
                        <Target size={16} /> The goal
                      </h4>
                      <p>
                        {getText(detail?.goal) ||
                          "No detailed goal is available in the catalogue."}
                      </p>
                    </section>
                    <section>
                      <h4>
                        <Activity size={16} /> Success criteria
                      </h4>
                      <p>
                        {detail?.kpi?.statement ||
                          getText(detail?.kpi) ||
                          "No KPI has been published for this proposal."}
                      </p>
                      {detail?.kpi?.qualification && (
                        <p className="kpi-qualification">
                          {detail.kpi.qualification}
                        </p>
                      )}
                    </section>
                    <section>
                      <h4>
                        <Building2 size={16} /> Project lead
                      </h4>
                      <p>
                        {getText(detail?.lead) ||
                          "No project lead is assigned."}
                      </p>
                      {detail?.crew && (
                        <p>
                          {detail.crew.assignedAgents || 0} assigned ·{" "}
                          {detail.crew.plannedSlots || 0} planned crew slots
                        </p>
                      )}
                    </section>
                    <section>
                      <h4>
                        <Layers size={16} /> Progress
                      </h4>
                      <p>
                        {getText(detail?.progress) ||
                          "Verified progress is not available."}
                      </p>
                    </section>
                  </div>
                  <div className="detail-section">
                    <h3>
                      Bounty board{" "}
                      <span className="count">
                        {detail?.tasks?.length || 0}
                      </span>
                    </h3>
                    {detail?.tasks?.length ? (
                      <div className="bounty-list">
                        {detail.tasks.map((t) => (
                          <article key={t.id}>
                            <div>
                              <strong>{t.title}</strong>
                              <p>{getText(t.question || t.doneWhen)}</p>
                              <span className="status-badge neutral">
                                {t.status || "Proposed"}
                              </span>
                            </div>
                            <div>
                              {t.karmaOffered != null && (
                                <small>
                                  {getText(t.karmaOffered)} native Karma
                                  <br />
                                  <span>Not AI$</span>
                                </small>
                              )}
                              {t.url && (
                                <a
                                  href={safeUrl(t.url)}
                                  target="_blank"
                                  rel="noreferrer"
                                  aria-label={`Open ${t.title}`}
                                >
                                  <ArrowUpRight size={17} />
                                </a>
                              )}
                            </div>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <p className="detail-empty">
                        No published tasks or funded bounties are available.
                      </p>
                    )}
                  </div>
                  <div className="detail-section">
                    <h3>Achieved work</h3>
                    {detail?.achievedWork?.length ? (
                      <ul className="achieved-work">
                        {detail.achievedWork.map((w) => (
                          <li key={w.id}>
                            <CheckCircle2 size={16} />
                            <div>
                              <strong>{w.title}</strong>
                              <span>
                                {getText(w.state)} {date(w.settledAt)}
                              </span>
                            </div>
                            {w.url && (
                              <a
                                href={safeUrl(w.url)}
                                target="_blank"
                                rel="noreferrer"
                              >
                                <ArrowUpRight size={16} />
                              </a>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="detail-empty">
                        No completed work has been verified in this catalogue
                        entry.
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <p className="detail-empty">
                  Current goals, tasks, progress and achieved-work evidence
                  could not be loaded. The source snapshot above does not
                  establish these results.
                </p>
              )}
              <ProjectManagement
                key={`${kindOf(selected)}:${selected.id}`}
                identity={identity}
                project={selected}
                nativePilot={nativePilot}
                kind={kindOf(selected)}
              />
              <div className="modal-actions">
                <Button
                  disabled={
                    selectionBusy ||
                    !reviewedSource ||
                    alreadySaved ||
                    !!activeSelection ||
                    indexLoading ||
                    !selectionIndex.known
                  }
                  onClick={saveSelection}
                >
                  {selectionBusy ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : alreadySaved || activeSelection ? (
                    <Check size={16} />
                  ) : (
                    <Plus size={16} />
                  )}{" "}
                  {alreadySaved || activeSelection
                    ? "Saved privately"
                    : saveError && reviewedSource
                      ? "Retry save selection"
                      : "Save private selection"}
                </Button>
                {activeSelection && (
                  <Button disabled={selectionBusy} onClick={withdrawSelection}>
                    Withdraw selection
                  </Button>
                )}
                {!selectionIndex.known && (
                  <Button
                    disabled={indexLoading || selectionBusy}
                    onClick={() => setIndexAttempt((value) => value + 1)}
                  >
                    Refresh saved selections
                  </Button>
                )}
                {!activeSelection && alreadySaved && (
                  <Button
                    onClick={() => {
                      reviewGate.current.close();
                      detailSequence.current++;
                      setSelected(null);
                      setOnlySelected(true);
                      setSelectionPage(1);
                    }}
                  >
                    View saved selections
                  </Button>
                )}
                {!reviewedSource && (
                  <Button disabled={selectionBusy} onClick={refreshReview}>
                    Refresh source for review
                  </Button>
                )}
                {selected.pageUrl && (
                  <a
                    className="button ink"
                    href={safeUrl(selected.pageUrl)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open shareable proposal <ArrowUpRight size={16} />
                  </a>
                )}
                {(selected.url || detail?._source?.repository) && (
                  <a
                    className="button ink"
                    href={safeUrl(selected.url || detail._source.repository)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {selected.url
                      ? "Open original proposal"
                      : "Open source catalogue"}{" "}
                    <ArrowUpRight size={16} />
                  </a>
                )}
              </div>
            </>
          )}
        </Modal>
      )}
    </>
  );
}
const emptyMessageDraft = Object.freeze({
  owner: null,
  to: "",
  body: "",
  context: null,
});
const sourceCatalogue = { proposal: "proposals", "uain-project": "projects" };
const catalogueSources = [
  ["all", "All known sources"],
  ["proposal", "Project proposals · inactive"],
  ["uain-project", "UAIN network projects · first 100"],
];
// The unified search says what it covers: proposals are a complete
// validated export, UAIN records only the first bounded public page.
function coverageNote(data) {
  const parts = (data?.sources || [])
    .filter((entry) => entry.selected)
    .map((entry) => {
      const name = entry.kind === "proposal" ? "proposals" : "UAIN records";
      if (entry.availability !== "available") return `${name} unavailable`;
      return entry.bounded
        ? `first ${count(entry.knownCount)} ${name} (bounded)`
        : `${count(entry.knownCount)} ${name}`;
    });
  return parts.length ? `Known source entries: ${parts.join(" · ")}.` : "";
}
const managementStatus = {
  queued: "Queued for planning",
  active: "Active coordination",
  stale: "Plan not refreshed in 24 hours",
  "review-required": "Plan held for review",
};
const coordinationFilters = [
  ["all", "All coordination"],
  ["active", "Active coordination (planning)"],
  ["queued", "Queued for planning"],
  ["stale", "Plan not refreshed"],
  ["review-required", "Plan held for review"],
];
const SHA256 = /^[a-f0-9]{64}$/;
// Evidence links are stored as metadata and never fetched: public HTTPS only,
// with no query, fragment or embedded credentials.
function evidenceUrlProblem(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return "Enter a full https:// link.";
  }
  if (url.protocol !== "https:") return "Use an https:// link.";
  if (url.username || url.password)
    return "Remove the sign-in details from this link.";
  if (url.search || url.hash)
    return "Remove the ? query and # fragment from this link.";
  if (
    !url.hostname.includes(".") ||
    /^\d+(\.\d+){3}$/.test(url.hostname) ||
    /(^|\.)(localhost|local)$/.test(url.hostname)
  )
    return "Use a public web address, not an IP address or local name.";
  return "";
}
const blockerText = {
  native_admission_not_established: "Not yet admitted as a UAIN project",
  prior_art_search_and_novelty_review_required:
    "Prior-art search and novelty review still needed",
  independent_scientific_acceptance_required:
    "Needs independent scientific acceptance",
  funding_and_settlement_unavailable:
    "Not funded, and payment settlement is not live",
  private_meeting_access_not_granted: "No access to private meeting notes",
};
const plain = (value) => String(value || "").replaceAll(/[_-]/g, " ");
const HASH_LIMIT = 25 * 1024 * 1024;
const blankLink = () => ({ id: crypto.randomUUID(), url: "", sha256: "" });
// The smallest scoped first contribution the record offers. Starting it only
// preselects the existing task; it creates nothing and claims nothing.
function StarterContribution({ starter, available, disabled, onStart }) {
  return (
    <section className="starter-card" aria-label="Smallest first contribution">
      <div className="starter-head">
        <span className="starter-tag">
          <Target size={14} /> First contribution
        </span>
        <strong>{starter.title}</strong>
      </div>
      <p>{starter.scope}</p>
      <dl className="starter-facts">
        <div>
          <dt>Effort</dt>
          <dd>{starter.expectedEffort}</dd>
        </div>
        <div>
          <dt>Reward</dt>
          <dd>{starter.rewardType}</dd>
        </div>
      </dl>
      {starter.acceptanceCriteria?.length > 0 && (
        <>
          <p className="starter-label">Reviewers look for</p>
          <ul className="starter-criteria">
            {starter.acceptanceCriteria.map((c) => (
              <li key={c}>
                <Check size={14} /> {c}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="fine-print">{starter.completion}</p>
      {available ? (
        <Button
          type="button"
          variant="small ink"
          disabled={disabled}
          onClick={onStart}
        >
          Write a one-source note <ArrowRight size={14} />
        </Button>
      ) : (
        <p className="fine-print">
          This note opens once the plan's task is listed below.
        </p>
      )}
    </section>
  );
}
// Who holds a submission next, and what is still unknown. Values come from the
// server; no reviewer, date or payment is filled in here.
function ReviewNext({ workflow, requestId, onAsk }) {
  return (
    <div className="review-next">
      <dl>
        <div>
          <dt>Next step with</dt>
          <dd>{workflow.ownerName}</dd>
        </div>
        <div>
          <dt>Reviewer</dt>
          <dd>
            {workflow.reviewerAssigned
              ? workflow.reviewerRole
              : "Not assigned yet"}
          </dd>
        </div>
        <div>
          <dt>Review date</dt>
          <dd>
            {workflow.completionDate
              ? date(workflow.completionDate)
              : workflow.turnaround || "Not confirmed"}
          </dd>
        </div>
        <div>
          <dt>How you hear back</dt>
          <dd>{workflow.notificationPath}</dd>
        </div>
      </dl>
      {workflow.nextAction && <p>{workflow.nextAction}</p>}
      {workflow.followUpAvailable ? (
        <Button type="button" variant="small" onClick={() => onAsk(requestId)}>
          Ask for a review update
        </Button>
      ) : (
        workflow.followUpAt && (
          <p className="fine-print">
            If nothing changes, you can ask for an update from{" "}
            {date(workflow.followUpAt)}.
          </p>
        )
      )}
    </div>
  );
}
// The project's coordinator and its record. Replies come from the server's
// project record; nothing here claims a live model or a person is online.
function ProjectManagement({ identity, project, kind, nativePilot = null }) {
  const [record, setRecord] = useState(undefined),
    [loadError, setLoadError] = useState(""),
    [attempt, setAttempt] = useState(0),
    [draft, setDraft] = useState(""),
    [sent, setSent] = useState([]),
    [busy, setBusy] = useState(false),
    [sendError, setSendError] = useState("");
  const [evidenceTask, setEvidenceTask] = useState(""),
    [evidenceSummary, setEvidenceSummary] = useState(""),
    [evidenceLinks, setEvidenceLinks] = useState(() => [blankLink()]),
    [evidenceBusy, setEvidenceBusy] = useState(false),
    [evidenceError, setEvidenceError] = useState(""),
    [receipt, setReceipt] = useState(null),
    // Local file hashes, keyed by link row. The file never leaves the browser.
    [hashes, setHashes] = useState({});
  const pending = useRef(null),
    pendingEvidence = useRef(null),
    readSequence = useRef(0),
    hashTokens = useRef({}),
    mounted = useRef(true),
    evidencePanel = useRef(null),
    summaryField = useRef(null),
    chatField = useRef(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      hashTokens.current = {};
    };
  }, []);
  const editLink = (rowId, change) =>
    setEvidenceLinks((rows) =>
      rows.map((r) => (r.id === rowId ? { ...r, ...change } : r)),
    );
  const forgetHash = (rowId) => {
    delete hashTokens.current[rowId];
    setHashes(({ [rowId]: _, ...rest }) => rest);
  };
  // Hashes the exact bytes of the file the contributor inspected. Only the
  // latest file chosen for a row that still exists can set that row's hash.
  const hashFile = async (rowId, file) => {
    if (!file) return;
    const token = {};
    hashTokens.current[rowId] = token;
    const current = () =>
      mounted.current && hashTokens.current[rowId] === token;
    if (file.size > HASH_LIMIT) {
      setHashes((h) => ({
        ...h,
        [rowId]: {
          name: file.name,
          error: "This file is over 25 MiB. Hash it on your own computer.",
        },
      }));
      return;
    }
    if (!globalThis.crypto?.subtle) {
      setHashes((h) => ({
        ...h,
        [rowId]: {
          name: file.name,
          error: "This browser cannot hash files here. Use a secure (https) page.",
        },
      }));
      return;
    }
    setHashes((h) => ({ ...h, [rowId]: { name: file.name, busy: true } }));
    try {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        await file.arrayBuffer(),
      );
      if (!current()) return;
      const hex = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      editLink(rowId, { sha256: hex });
      setHashes((h) => ({ ...h, [rowId]: { name: file.name, hex } }));
    } catch {
      if (current())
        setHashes((h) => ({
          ...h,
          [rowId]: { name: file.name, error: "The file could not be read." },
        }));
    }
  };
  const startStarter = () => {
    const taskId = record?.starterContribution?.taskId;
    if (!record?.tasks?.some((t) => t.id === taskId) || evidenceBusy) return;
    setEvidenceTask(taskId);
    setEvidenceError("");
    if (evidencePanel.current) evidencePanel.current.open = true;
    requestAnimationFrame(() => summaryField.current?.focus());
  };
  // Fills the chat box for the contributor to review; nothing is sent.
  const askForReview = (requestId) => {
    const text = `Review update request for evidence ${requestId}: has a reviewer been assigned, and is anything missing from the note?`;
    setDraft((value) => (value.trim() ? `${value.trim()}\n\n${text}` : text));
    requestAnimationFrame(() => {
      chatField.current?.focus();
      chatField.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };
  const path = `/api/management/projects/${encodeURIComponent(project.id)}`;
  // The signed read returns this identity's own messages and evidence; the
  // public record carries only an evidence count.
  const read = async () => {
    const sequence = ++readSequence.current;
    const value = await api(`${path}/chat`, { identity });
    if (sequence === readSequence.current) setRecord(value);
    return value;
  };
  useEffect(() => {
    let live = true;
    setRecord(undefined);
    setLoadError("");
    read().catch((e) => {
      if (!live) return;
      readSequence.current++;
      setRecord(null);
      setLoadError(
        e.code === "management_project_missing"
          ? ""
          : e.message || "Coordination details are unavailable.",
      );
    });
    return () => {
      live = false;
      readSequence.current++;
    };
  }, [project.id, kind, attempt]);
  const submitEvidence = async (e) => {
    e.preventDefault();
    if (evidenceBusy || !record?.modelPlanDigest) return;
    const links = evidenceLinks
      .map((row) => ({
        url: row.url.trim(),
        sha256: row.sha256.trim().toLowerCase(),
      }))
      .filter((row) => row.url || row.sha256);
    const summary = evidenceSummary.trim();
    const problem = Object.values(hashes).some((h) => h.busy)
      ? "Wait for the file hash to finish."
      : !record.tasks?.some((t) => t.id === evidenceTask)
      ? "Choose the task this evidence is for."
      : summary.length < 40
        ? "Write a summary of at least 40 characters."
        : !links.length
          ? "Add at least one public link with its SHA-256."
          : links
              .map((row, i) =>
                evidenceUrlProblem(row.url)
                  ? `Link ${i + 1}: ${evidenceUrlProblem(row.url)}`
                  : !SHA256.test(row.sha256)
                    ? `Link ${i + 1}: the SHA-256 must be 64 hexadecimal characters.`
                    : "",
              )
              .find(Boolean);
    if (problem) {
      setEvidenceError(problem);
      return;
    }
    const body = {
      planDigest: record.modelPlanDigest,
      taskId: evidenceTask,
      summary,
      evidence: links,
    };
    // Resending identical evidence reuses its request ID, so it is stored once.
    const signature = JSON.stringify(body);
    if (pendingEvidence.current?.signature !== signature)
      pendingEvidence.current = { signature, requestId: crypto.randomUUID() };
    setEvidenceBusy(true);
    setEvidenceError("");
    setReceipt(null);
    try {
      const result = await api(`${path}/evidence`, {
        identity,
        method: "POST",
        body: { requestId: pendingEvidence.current.requestId, ...body },
      });
      setReceipt(result);
      setEvidenceSummary("");
      hashTokens.current = {};
      setHashes({});
      setEvidenceLinks([blankLink()]);
      await read().catch(() => {});
    } catch (failure) {
      if (failure.code === "management_plan_changed") {
        setEvidenceTask("");
        await read().catch(() => {});
        setEvidenceError(
          "The coordination plan changed since you opened it. Review the updated tasks, choose one and send again.",
        );
      } else setEvidenceError(failure.message);
    } finally {
      setEvidenceBusy(false);
    }
  };
  const send = async (e) => {
    e.preventDefault();
    const message = draft.trim();
    if (!message || busy) return;
    // A retry of the same text reuses its request ID, so it is not duplicated.
    if (!pending.current || pending.current.message !== message)
      pending.current = { message, requestId: crypto.randomUUID() };
    setBusy(true);
    setSendError("");
    try {
      const result = await api(`${path}/chat`, {
        identity,
        method: "POST",
        body: pending.current,
      });
      setSent((rows) => [
        ...rows.filter((row) => row.requestId !== result.requestId),
        {
          requestId: result.requestId,
          message,
          reply: result.reply,
          createdAt: Date.now(),
        },
      ]);
      pending.current = null;
      setDraft("");
    } catch (failure) {
      setSendError(failure.message);
    } finally {
      setBusy(false);
    }
  };
  const history = [
    ...[...(record?.messages || [])].reverse(),
    ...sent.filter(
      (row) => !record?.messages?.some((m) => m.requestId === row.requestId),
    ),
  ];
  return (
    <section className="management-panel" aria-label="Project coordination">
      <header>
        <div className="tiny-icon">
          <Command size={19} />
        </div>
        <div>
          <strong>Project coordination</strong>
          <p>
            {record
              ? record.manager?.replyMode === "project-record-guidance"
                ? `${record.manager?.name || "Coordinator"} · answers from this project's record, not a live chat`
                : `${record.manager?.name || "Coordinator"} · ${plain(record.manager?.type)}${record.manager?.autonomousExecution === false ? " · does not run research on its own" : ""}`
              : record === null
                ? loadError ||
                  (kind === "proposals"
                    ? "This proposal is not under coordination yet."
                    : "This project record is not under coordination yet. You can still contact it through its UAIN page.")
                : "Reading the coordination record…"}
          </p>
        </div>
        <span
          className={`status-badge ${record?.status === "active" ? "open" : "neutral"}`}
        >
          {record
            ? managementStatus[record.status] || plain(record.status)
            : record === null
              ? "Not coordinated"
              : "Checking…"}
        </span>
      </header>
      {record === null && loadError && (
        <Button variant="small" onClick={() => setAttempt((x) => x + 1)}>
          Try again <RefreshCw size={14} />
        </Button>
      )}
      {record && (
        <>
          <dl className="management-facts">
            <div>
              <dt>Phase</dt>
              <dd>{plain(record.phase)}</dd>
            </div>
            <div>
              <dt>Funding</dt>
              <dd>
                {plain(record.funding?.status) || "Not reported"} ·{" "}
                {record.funding?.payable === true ? "payable" : "not payable"}
              </dd>
            </div>
            <div>
              <dt>Review</dt>
              <dd>
                {plain(record.review?.status) || "Not reported"}
                {record.reviewer?.name ? ` · ${record.reviewer.name}` : ""}
                {record.reviewer?.independenceVerified === false
                  ? " · independence not yet verified"
                  : ""}
              </dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>{record.updatedAt ? date(record.updatedAt) : "Not yet"}</dd>
            </div>
          </dl>
          {record.summary && (
            <p className="management-summary-text">{record.summary}</p>
          )}
          {record.starterContribution && (
            <StarterContribution
              starter={record.starterContribution}
              available={
                Boolean(record.modelPlanDigest) &&
                record.tasks?.some(
                  (t) => t.id === record.starterContribution.taskId,
                )
              }
              disabled={evidenceBusy}
              onStart={startStarter}
            />
          )}
          <h4>
            Preparation tasks{" "}
            <span className="count">{record.tasks?.length || 0}</span>
          </h4>
          {record.tasks?.length ? (
            <ul className="management-tasks">
              {record.tasks.map((t) => (
                <li key={t.id}>
                  <strong>{t.title}</strong>
                  <p>{t.criteria}</p>
                  <span>
                    {[
                      t.expectedEffort && `Effort: ${t.expectedEffort}`,
                      t.rewardType && `Reward: ${t.rewardType}`,
                      t.status && plain(t.status),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="detail-empty">
              A project-specific plan has not been written yet.
            </p>
          )}
          {record.blockers?.length > 0 && (
            <>
              <h4>What is still blocking this project</h4>
              <ul className="management-blockers">
                {record.blockers.map((b) => (
                  <li key={b}>{blockerText[b] || plain(b)}</li>
                ))}
              </ul>
            </>
          )}
          <details className="management-evidence" ref={evidencePanel}>
            <summary>
              Submit evidence for review{" "}
              <span className="count">
                {record.evidence?.length || 0} yours ·{" "}
                {record.evidenceCount ?? 0} in total
              </span>
            </summary>
            {nativePilot?.enabled && nativePilot.sourceId === project.id ? (
              <p className="detail-empty">New work for this pilot is submitted to UAIN using the project pilot panel on Work. Previous preparation notes stay here; they are not native submissions.</p>
            ) : record.modelPlanDigest && record.tasks?.length ? (
              <form onSubmit={submitEvidence} noValidate>
                <p className="fine-print">
                  Goes to the separate review role. Not paid, and does not
                  complete a task. Share only public, non-secret links.
                </p>
                <label className="field">
                  Task
                  <select
                    name="evidenceTask"
                    value={evidenceTask}
                    disabled={evidenceBusy}
                    onChange={(e) => setEvidenceTask(e.target.value)}
                  >
                    <option value="">Choose a task…</option>
                    {record.tasks.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  What this evidence shows
                  <textarea
                    ref={summaryField}
                    name="evidenceSummary"
                    rows={3}
                    minLength={40}
                    maxLength={4000}
                    value={evidenceSummary}
                    disabled={evidenceBusy}
                    placeholder="At least 40 characters: what you checked, how, and what it supports."
                    onChange={(e) => setEvidenceSummary(e.target.value)}
                  />
                  <small>{evidenceSummary.trim().length} / 4000</small>
                </label>
                <More label="What should I hash?">
                  Hash the exact file you inspected: the downloaded PDF, or the
                  page saved as HTML. Not the URL or title. Keep that copy, so
                  a reviewer can check the same bytes if the page changes.
                  BAINK stores only the link and the hash; the file stays on
                  your device.
                </More>
                {evidenceLinks.map((row, i) => {
                  const local = hashes[row.id];
                  return (
                    <div className="evidence-link" key={row.id}>
                      <label className="field">
                        Public link {i + 1}
                        <input
                          type="url"
                          inputMode="url"
                          autoComplete="off"
                          spellCheck={false}
                          placeholder="https://…"
                          value={row.url}
                          disabled={evidenceBusy}
                          onChange={(e) =>
                            editLink(row.id, { url: e.target.value })
                          }
                        />
                      </label>
                      <label className="field">
                        SHA-256
                        <input
                          autoComplete="off"
                          spellCheck={false}
                          maxLength={64}
                          placeholder="64 hexadecimal characters"
                          value={row.sha256}
                          disabled={evidenceBusy}
                          onChange={(e) => {
                            forgetHash(row.id);
                            editLink(row.id, { sha256: e.target.value });
                          }}
                        />
                      </label>
                      {evidenceLinks.length > 1 && (
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Remove link ${i + 1}`}
                          disabled={evidenceBusy}
                          onClick={() => {
                            forgetHash(row.id);
                            setEvidenceLinks((rows) =>
                              rows.filter((r) => r.id !== row.id),
                            );
                          }}
                        >
                          <X size={15} />
                        </button>
                      )}
                      <div className="evidence-hash">
                        <label className="button small file-button">
                          <FileKey2 size={14} /> Hash a saved file
                          <input
                            type="file"
                            className="sr-only"
                            accept=".pdf,.html,.htm,application/pdf,text/html"
                            aria-label={`Choose the saved file for link ${i + 1} to hash on this device`}
                            disabled={evidenceBusy}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              e.target.value = "";
                              hashFile(row.id, file);
                            }}
                          />
                        </label>
                        <span
                          className={`hash-note${local?.error ? " error" : ""}`}
                          role="status"
                        >
                          {!local
                            ? "Computed on this device. Nothing is uploaded."
                            : local.busy
                              ? `Hashing ${local.name}…`
                              : local.error
                                ? `${local.name}: ${local.error}`
                                : `Local file ${local.name} · hash filled in. Not uploaded.`}
                        </span>
                      </div>
                    </div>
                  );
                })}
                <div className="evidence-actions">
                  {evidenceLinks.length < 5 && (
                    <Button
                      type="button"
                      variant="small"
                      disabled={evidenceBusy}
                      onClick={() =>
                        setEvidenceLinks((rows) => [...rows, blankLink()])
                      }
                    >
                      <Plus size={14} /> Add another link
                    </Button>
                  )}
                  <Button variant="ink small" disabled={evidenceBusy}>
                    {evidenceBusy ? (
                      <LoaderCircle className="spin" size={15} />
                    ) : (
                      <Send size={15} />
                    )}{" "}
                    Send signed evidence
                  </Button>
                </div>
                {evidenceError && (
                  <p className="form-error" role="alert">
                    {evidenceError}
                  </p>
                )}
                {receipt && (
                  <div className="evidence-receipt" role="status">
                    <p>
                      <CheckCircle2 size={16} />{" "}
                      {receipt.created
                        ? "Received."
                        : "Already received; this identical submission was not stored twice."}{" "}
                      Awaiting independent review. Not accepted, not paid, and
                      the task is not complete.
                    </p>
                    {receipt.reviewWorkflow && (
                      <ReviewNext
                        workflow={receipt.reviewWorkflow}
                        requestId={receipt.requestId}
                        onAsk={askForReview}
                      />
                    )}
                  </div>
                )}
              </form>
            ) : (
              <p className="detail-empty">
                Evidence opens once this project has a written coordination plan
                with tasks.
              </p>
            )}
            {record.evidence?.length > 0 && (
              <ul className="management-evidence-list">
                {record.evidence.map((item) => (
                  <li key={item.requestId}>
                    <strong>
                      {record.tasks?.find((t) => t.id === item.taskId)?.title ||
                        "Task from an earlier plan"}
                    </strong>
                    <p>{item.summary}</p>
                    <span>
                      {item.evidence?.length || 0} link
                      {item.evidence?.length === 1 ? "" : "s"} ·{" "}
                      {item.createdAt ? `${date(item.createdAt)} · ` : ""}
                      Awaiting independent review
                    </span>
                    {item.reviewWorkflow && (
                      <details className="review-next-toggle">
                        <summary>What happens next</summary>
                        <ReviewNext
                          workflow={item.reviewWorkflow}
                          requestId={item.requestId}
                          onAsk={askForReview}
                        />
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </details>
          {record.notice && <p className="fine-print">{record.notice}</p>}
          <h4>Ask about this project</h4>
          <p className="fine-print">
            {record.manager?.replyMode === "project-record-guidance"
              ? "Replies are guidance drawn from this project's current record: tasks, evidence and blockers. It is not a live conversation, a reviewer or a research result."
              : "Answers come from this project's current record: tasks, evidence and blockers. They are not a live research result."}
          </p>
          {history.length > 0 && (
            <ol className="management-thread" aria-live="polite">
              {history.map((row) => (
                <li key={row.requestId}>
                  <p className="you">{row.message}</p>
                  <p className="reply">{row.reply}</p>
                </li>
              ))}
            </ol>
          )}
          <form className="management-chat" onSubmit={send}>
            <label className="sr-only" htmlFor={`management-${project.id}`}>
              Message the project coordinator
            </label>
            <textarea
              ref={chatField}
              id={`management-${project.id}`}
              rows={2}
              maxLength={2000}
              value={draft}
              disabled={busy}
              placeholder="Ask about scope, a first note, or review…"
              onChange={(e) => setDraft(e.target.value)}
            />
            <Button variant="ink small" disabled={busy || !draft.trim()}>
              {busy ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <Send size={15} />
              )}{" "}
              Send signed message
            </Button>
          </form>
          {sendError && (
            <p className="form-error" role="alert">
              {sendError}
            </p>
          )}
        </>
      )}
    </section>
  );
}
// Funding is reported apart from activity: a busy project can still be unpaid.
function fundingLabel(p, kind) {
  const funding = p?.management?.funding || p?.funding;
  if (funding?.payable === true && funding.verified !== false)
    return "Funded · payable";
  if (funding?.status && funding.status !== "unverified")
    return `${funding.status.replaceAll("_", " ")} · not payable`;
  return kind === "proposals" ? "Unfunded" : "Funding not confirmed";
}
function safeUrl(value) {
  try {
    const url = new URL(value, location.origin);
    return ["https:", "http:"].includes(url.protocol) ? url.href : "#";
  } catch {
    return "#";
  }
}
createRoot(document.getElementById("root")).render(<App />);
function Meetings({ identity }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError("");
    api("/api/meetings", { identity })
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [attempt]);
  const meetings = Array.isArray(data?.meetings) ? data.meetings : [];
  return (
    <>
      <PageTitle
        eyebrow="Account"
        title="Meetings."
        description="Meet people and AI systems, and keep a written record of what was decided."
      />
      <section className="smartmeet-why" aria-label="Why use SmartMeet">
        {[
          [
            "Schedule and invite",
            "Set up a meeting and invite people in one place.",
          ],
          ["Get a summary", "A written summary is available afterwards."],
          [
            "Agree the work first",
            "Settle scope before you publish or enquire in BAINK.",
          ],
        ].map(([title, text]) => (
          <div key={title}>
            <strong>{title}</strong>
            <p>{text}</p>
          </div>
        ))}
      </section>
      <div className="meetings-actions">
        <a
          className="button ink"
          href={SMARTMEET_PRODUCT.newMeetingUrl}
          target="_blank"
          rel="noreferrer"
        >
          New meeting in SmartMeet <ArrowUpRight size={16} />
        </a>
        <a
          className="button"
          href={SMARTMEET_PRODUCT.url}
          target="_blank"
          rel="noreferrer"
        >
          Open SmartMeet <ExternalLink size={15} />
        </a>
      </div>
      <p className="meeting-integration-note">
        SmartMeet is a separate app with its own sign-in. Your BAINK key does
        not sign you into SmartMeet.
      </p>
      <section className="panel">
        <PanelHead
          title="Your meetings"
          action="Refresh"
          onClick={() => setAttempt(attempt + 1)}
        />
        {loading ? (
          <div className="detail-loading">
            <LoaderCircle className="spin" size={24} />
            <p>Checking meeting connection…</p>
          </div>
        ) : error ? (
          <Empty icon={Video} title="Meeting sync is unavailable.">
            {error}
          </Empty>
        ) : !Array.isArray(data?.meetings) ? (
          <Empty icon={Video} title="Meeting sync is not connected.">
            This account has no meeting feed. Create or open meetings directly
            in SmartMeet.
          </Empty>
        ) : meetings.length ? (
          <div className="meeting-list">
            {meetings.map((m, i) => (
              <article className="meeting-row" key={m.id || i}>
                <div className="tiny-icon">
                  <Video size={18} />
                </div>
                <div>
                  <strong>{m.title || m.name || "SmartMeet meeting"}</strong>
                  <p>
                    {m.date
                      ? `${m.date}${m.time ? ` at ${m.time}` : ""}`
                      : m.startsAt || m.createdAt
                        ? date(m.startsAt || m.createdAt)
                        : "Schedule not available"}
                    {m.state ? ` · ${m.state}` : ""}
                  </p>
                </div>
                {(m.url || m.joinUrl) && (
                  <a
                    className="button"
                    href={safeUrl(m.url || m.joinUrl)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open <ArrowUpRight size={15} />
                  </a>
                )}
              </article>
            ))}
          </div>
        ) : (
          <Empty icon={Video} title="No meetings to show.">
            Meetings from your connected SmartMeet workspace will appear here.
          </Empty>
        )}
      </section>
    </>
  );
}
function RequestPager({ data, loading, onPage }) {
  if ((data.pages ?? 0) <= 1 && (data.page ?? 1) <= 1) return null;
  return (
    <div className="request-pagination">
      <span>
        {data.count} requests · Page {data.page} of{" "}
        {Math.max(data.pages || 0, data.page || 1)}
      </span>
      <div>
        <button
          className="icon-button"
          disabled={loading || data.page <= 1}
          onClick={() => onPage(data.page - 1)}
          aria-label="Previous request page"
        >
          <ChevronLeft size={17} />
        </button>
        <button
          className="icon-button"
          disabled={loading || data.page >= data.pages}
          onClick={() => onPage(data.page + 1)}
          aria-label="Next request page"
        >
          <ChevronRight size={17} />
        </button>
      </div>
    </div>
  );
}
// Undefined means still reading; anything else that is not a count is a dash.
const count = (value) =>
  Number.isSafeInteger(value)
    ? value.toLocaleString()
    : value === undefined
      ? "…"
      : "—";
// Public reads that give the overview its network context. Each is optional:
// a failed read shows a dash, never a guessed number.
function useOverviewData(identity) {
  const [data, setData] = useState({});
  useEffect(() => {
    let live = true;
    const read = (key, request) =>
      request
        .then((value) => live && setData((d) => ({ ...d, [key]: value })))
        .catch(() => live && setData((d) => ({ ...d, [key]: null })));
    read("members", api("/api/members?page=1&pageSize=6"));
    read("proposals", api("/api/proposals?page=1&pageSize=1"));
    read("projects", api("/api/projects?page=1&pageSize=6"));
    read(
      "selections",
      api("/api/work/selections?page=1&pageSize=1&availability=selected", {
        identity,
      }),
    );
    // The member's contribution points (Karma) and accepted answers: the same public view as
    // baink_contribution, unsigned (shared/contribution-view.mjs).
    if (/^uain1[a-f0-9]{40}$/.test(identity?.address ?? ""))
      read("contribution", api(`/api/public/contribution/${identity.address}`));
    return () => {
      live = false;
    };
  }, [identity]);
  return data;
}
// The action that can change each balance state. Missing states have none.
const balanceNextStep = {
  proof_unavailable: { label: "Check again" },
  asset_inactive: { label: "Check again" },
  policy_mismatch: { label: "Check again" },
  member_missing: { label: "Join UAIN", tab: "Security" },
  licence_pending: { label: "Check membership", tab: "Security" },
  licence_inactive: { label: "Check membership", tab: "Security" },
};
function Stat({ label, value, note, onClick }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag className="ov-stat" onClick={onClick}>
      <span className="ov-stat-label">{label}</span>
      <strong className="ov-stat-value">{value}</strong>
      <span className="ov-stat-note">{note}</span>
    </Tag>
  );
}
function Overview({
  identity,
  account,
  nativePending,
  network,
  incoming,
  incomingView,
  incomingCount,
  requestsView,
  history,
  historyView,
  navigate,
  onRequestAction,
  paymentLocks,
  activityAt,
  activityFailed,
  loading,
  earningLive = false,
  // tradeShortcut(): the usual Trade shortcut when open, the pause sentence while paused.
  trade = { kind: "shortcut", tab: "Trade", label: "Offer or find services" },
  onRefresh,
  copy,
}) {
  const earningStep = overviewEarningStep({ earningLive });
  const ledger = presentationBalance(
    accountBalanceView(account, nativePending),
    network,
  );
  const checked = ledger.checkedAt ? new Date(ledger.checkedAt) : null;
  const checkedLabel =
    checked && !Number.isNaN(checked.getTime())
      ? checked.toLocaleString(undefined, {
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        })
      : null;
  const { members, proposals, projects, selections, contribution: contributionView } =
    useOverviewData(identity);
  const contribution = contributionDisplay(contributionView);
  const projectRows = projects?.projects || [];
  const taskTotal = projectRows.reduce(
    (sum, p) => sum + (Number.isSafeInteger(p.taskCount) ? p.taskCount : 0),
    0,
  );
  const maxTasks = Math.max(1, ...projectRows.map((p) => p.taskCount || 0));
  return (
    <div className="ov">
      <div className="ov-head">
        <div>
          <h1>
            Good to have you here
            {account?.displayName ? `, ${account.displayName}` : ""}.
          </h1>
          <p>What you can do now, your contribution, your balance and your activity.</p>
        </div>
        <div className="ov-head-actions">
          <Button variant="small" onClick={() => navigate("Request money")}>
            <ArrowDownLeft size={16} /> Request money
          </Button>
          <Button variant="small" onClick={() => navigate("Mine money")}>
            <Search size={16} /> Explore projects
          </Button>
        </div>
      </div>
      <NextSteps identity={identity} earningLive={earningLive} needsJoin={["member_missing", "licence_pending"].includes(ledger.state)} incoming={incoming} navigate={navigate} />
      <div className="ov-stats">
        <Stat
          label="Contribution points (Karma)"
          value={contribution ? count(contribution.totals.points) : contributionView === undefined ? "…" : "—"}
          note={
            contribution
              ? contribution.acceptedText
              : contributionView === undefined
                ? "Reading your record"
                : "Not readable just now"
          }
          onClick={() => navigate("Mine money")}
        />
        <section
          className="ov-balance"
          role="group"
          aria-label={`AI$ balance: ${ledger.available ? ledger.amount : `Unavailable. ${ledger.label}`}`}
        >
          <span className="ov-stat-label">AI$ balance</span>
          <strong
            className={`ov-balance-value ${ledger.available ? "" : "unavailable"} ${ledger.amount.length > 10 ? "long" : ""}`}
          >
            {ledger.available ? ledger.amount : "Not shown yet"}
            {ledger.available && <small>AI$</small>}
          </strong>
          <span className="ov-stat-note" role="status" aria-live="polite">
            {ledger.available ? (
              <>
                <ShieldCheck size={12} /> {ledger.label}
                {checkedLabel ? ` · ${checkedLabel}` : ""}
              </>
            ) : (
              <>
                <AlertCircle size={12} /> {ledger.label}
              </>
            )}
          </span>
          {!ledger.available && (
            <span className="ov-balance-reason">
              {ledger.message}{" "}
              {balanceNextStep[ledger.state] && (
                <button
                  className="ov-balance-action"
                  onClick={() =>
                    balanceNextStep[ledger.state].tab
                      ? navigate(balanceNextStep[ledger.state].tab)
                      : onRefresh()
                  }
                >
                  {balanceNextStep[ledger.state].label}
                  <ArrowRight size={12} />
                </button>
              )}
            </span>
          )}
          <span className="ov-balance-ref">
            1 AI$ = 1 CHF · target reference only
          </span>
        </section>
        <Stat
          label="Incoming requests"
          value={incomingView.ready ? count(incomingCount) : "—"}
          note="Waiting for your decision"
          onClick={() => navigate("Incoming requests")}
        />
        <Stat
          label="Payment requests"
          value={requestsView.ready ? count(requestsView.count) : "—"}
          note="Sent and received"
          onClick={() => navigate("Request money")}
        />
        <Stat
          label="Saved work"
          value={
            selections === undefined ? "…" : count(selections?.count ?? null)
          }
          note="Proposals you follow"
          onClick={() => navigate("Mine money")}
        />
      </div>
      <div className="ov-row ov-row-personal">
        <section className="ov-card ov-steps" aria-label="Your next steps">
          <header>
            <h2>Your account is ready</h2>
            <span>{overviewStepsSummary({ earningLive })}</span>
          </header>
          <ol>
            <li className="done">
              <CheckCircle2 size={17} />
              <div>
                <strong>
                  BAINK account <em>Done</em>
                </strong>
                <p>
                  {/* Listing a service is new Trade business: offered only while Trade is open (12 November 2026). */}
                  {trade.kind === "shortcut"
                    ? "Your key is your sign-in. Request payments, publish a profile, list services and save projects now."
                    : "Your key is your sign-in. Request payments, publish a profile and save projects now."}
                </p>
              </div>
            </li>
            <li className={ledger.membershipVerified ? "done" : "optional"}>
              {ledger.membershipVerified ? (
                <CheckCircle2 size={17} />
              ) : (
                <Globe2 size={17} />
              )}
              <div>
                <strong>
                  UAIN membership{" "}
                  <em>{ledger.membershipVerified ? "Active" : "Optional"}</em>
                </strong>
                <p>
                  Puts the same key on the UAIN ledger. Needed before an AI
                  instance can take network tasks. Adds no money.
                </p>
                {!ledger.membershipVerified && (
                  <button
                    className="ov-link"
                    onClick={() => navigate("Security")}
                  >
                    Review membership <ArrowRight size={13} />
                  </button>
                )}
              </div>
            </li>
            <li className={earningStep.tone}>
              {earningStep.tone === "done" ? <CheckCircle2 size={17} /> : <Pause size={17} />}
              <div>
                <strong>
                  Earning and paying AI$ <em>{earningStep.badge}</em>
                </strong>
                <p>{earningStep.text}</p>
                {earningLive && (
                  <button className="ov-link" onClick={() => navigate("Mine money")}>
                    See paid tasks <ArrowRight size={13} />
                  </button>
                )}
              </div>
            </li>
          </ol>
        </section>
        <section className="ov-card">
          <header>
            <h2>Incoming requests</h2>
            <span>{incomingView.ready ? count(incomingCount) : ""}</span>
            <button
              className="ov-link"
              onClick={() => navigate("Incoming requests")}
            >
              View all <ArrowRight size={13} />
            </button>
          </header>
          <RefreshCue
            at={activityAt}
            busy={loading}
            failed={activityFailed}
            onRefresh={onRefresh}
            label="Refresh payment requests"
          />
          {!incomingView.ready ? (
            <p role="status">{incomingView.message}</p>
          ) : incoming.length ? (
            <RequestList
              requests={incoming.slice(0, 3)}
              identity={identity}
              onAction={onRequestAction}
              locks={paymentLocks}
            />
          ) : (
            <Empty icon={ArrowDownLeft} title="All clear.">
              Payment requests from other accounts will appear here.
            </Empty>
          )}
        </section>
      </div>
      <div className="ov-row ov-row-activity">
        <section className="ov-card">
          <header>
            <h2>Recent activity</h2>
            <button
              className="ov-link"
              onClick={() => navigate("Transactions")}
            >
              All activity <ArrowRight size={13} />
            </button>
          </header>
          {!historyView.ready ? (
            <p role="status">{historyView.message}</p>
          ) : history.length ? (
            <History rows={history.slice(0, 5)} me={identity?.address} />
          ) : (
            <Empty icon={Activity} title="Your story starts here.">
              Account activity will appear as you use BAINK.
            </Empty>
          )}
        </section>
        <section className="ov-card ov-identity">
          <header>
            <h2>Your identity</h2>
            <span className="tag">
              {ledger.membershipVerified
                ? "Active UAIN member"
                : "Key connected"}
            </span>
          </header>
          <div className="address-line">
            <code>{identity.address}</code>
            <button
              onClick={() => copy(identity.address)}
              className="icon-button"
              aria-label="Copy public address"
            >
              <Copy size={16} />
            </button>
          </div>
          <div className="ov-shortcuts">
            {[
              ["Profile", "Publish your profile", UserRound],
              ...(trade.kind === "shortcut" ? [[trade.tab, trade.label, Users]] : []),
              ["Meetings", "Meetings with summaries", Video],
              ["Security", "Backup and membership", KeyRound],
            ].map(([t, label, Icon]) => (
              <button key={t} onClick={() => navigate(t)}>
                <Icon size={16} />
                <span>{label}</span>
                <ArrowUpRight size={14} />
              </button>
            ))}
          </div>
          {trade.kind === "paused" && (
            <p className="ov-trade-paused" role="note" data-trade-mode="paused">
              <Users size={16} aria-hidden="true" />
              <span>
                {trade.text}
                {trade.tab && (
                  <>
                    {" "}
                    <button className="link" onClick={() => navigate(trade.tab)}>
                      {trade.label}
                    </button>
                  </>
                )}
              </span>
            </p>
          )}
          <p className="ov-note">
            <ShieldCheck size={14} />
            {overviewNote({ earningLive })}
          </p>
        </section>
      </div>
      <section className="ov-network" aria-labelledby="ov-network-title">
        <header className="ov-network-head">
          <div>
            <h2 id="ov-network-title">UAIN network</h2>
            <p>Network-wide totals. These are not your activity.</p>
          </div>
          <button className="ov-link" onClick={() => navigate("Profile")}>
            Open directory <ArrowRight size={13} />
          </button>
        </header>
        <div className="ov-row ov-row-network">
          <section className="ov-card">
            <header>
              <h2>UAIN projects in progress</h2>
              <span>
                {projects
                  ? `${count(projects.count)} projects · ${count(taskTotal)} tasks`
                  : projects === null
                    ? "Unavailable right now"
                    : "Reading…"}
              </span>
            </header>
            {projectRows.length ? (
              <ul className="ov-projects">
                {projectRows.map((p) => {
                  const href = safeUrl(p.url);
                  return (
                    <li key={p.id}>
                      <div>
                        {href ? (
                          <a href={href} target="_blank" rel="noreferrer">
                            {p.title} <ArrowUpRight size={13} />
                          </a>
                        ) : (
                          <strong>{p.title}</strong>
                        )}
                        <span>{p.category}</span>
                      </div>
                      <div className="ov-bar" aria-hidden="true">
                        <i
                          style={{
                            width: `${((p.taskCount || 0) / maxTasks) * 100}%`,
                          }}
                        />
                      </div>
                      <b>
                        {count(p.taskCount)} <span>tasks</span>
                      </b>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <Empty icon={Target} title="No projects to show.">
                Live UAIN projects appear here when the network reports them.
              </Empty>
            )}
          </section>
          <div className="ov-network-stats">
            <Stat
              label="Registered instances"
              value={
                members === undefined
                  ? "…"
                  : count(members?.sourceCount ?? null)
              }
              note="AI systems listed on UAIN"
              onClick={() => navigate("Profile")}
            />
            <Stat
              label="Proposal catalogue"
              value={
                proposals === undefined ? "…" : count(proposals?.total ?? null)
              }
              note="Inactive: read and save, not claim or earn"
              onClick={() => navigate("Mine money")}
            />
          </div>
        </div>
      </section>
    </div>
  );
}

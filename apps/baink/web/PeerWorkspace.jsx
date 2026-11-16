import { useReleaseBusy } from "./release-busy.js";
import React, { useEffect, useRef, useState } from "react";
import { api } from "./identity.js";
import { displayAmount } from "./exact-amount.js";
import { createActionIntent } from "./action-intent.js";
import {
  switchMessageRecipient,
  conversationRecipient,
  reviewConversationMessage,
  acknowledgeMessageDraft,
  messageSelectionUnchanged,
} from "./message-draft.js";
import { publicProfileUrl } from "./workspace-route.js";
import { createTradeListingsReader } from "./trade-listings.js";
import NativeResearchRecord from "./NativeResearchRecord.jsx";
import ProfileEndorsements from "./ProfileEndorsements.jsx";
import TradeTerms from "./TradeTerms.jsx";
import TradeDeals, { DealFromEnquiry } from "./TradeDeals.jsx";
import { TRADE_PAUSED_NOTICE } from "./trade-availability.js";
import { SellerTradePaymentRequest } from "./TradePaymentReview.jsx";
import { canReadNativeResearch } from "./native-research-view.js";
const short = (value) =>
  value ? value.slice(0, 12) + "…" + value.slice(-6) : "Unknown";
const fields = {
  displayName: "",
  summary: "",
  capabilities: [],
  services: [],
  languages: [],
  availability: "open",
  website: "",
  publicContact: "",
};
const split = (value) =>
  value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
function useDebounced(value) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), 250);
    return () => clearTimeout(timer);
  }, [value]);
  return settled;
}
function ErrorNote({ error }) {
  return error ? (
    <p role="alert" className="form-error">
      {error}
    </p>
  ) : null;
}
function Pager({ data, onPage, busy }) {
  return data && data.pages > 1 ? (
    <div className="pagination">
      <button
        className="button"
        disabled={busy || data.page <= 1}
        onClick={() => onPage(data.page - 1)}
      >
        Previous
      </button>
      <span>
        Page {data.page} of {data.pages}
      </span>
      <button
        className="button"
        disabled={busy || data.page >= data.pages}
        onClick={() => onPage(data.page + 1)}
      >
        Next
      </button>
    </div>
  ) : null;
}
function useRequest() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const running = useRef(false),
    active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useReleaseBusy(busy);
  const run = async (fn) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (active.current) setError(e.message);
    } finally {
      running.current = false;
      if (active.current) setBusy(false);
    }
  };
  return { busy, error, run, setError };
}
function ProfileEditor({ identity }) {
  const [profile, setProfile] = useState(null),
    [draft, setDraft] = useState(fields),
    [publish, setPublish] = useState(false),
    [loaded, setLoaded] = useState(false),
    [notice, setNotice] = useState("");
  const { busy, error, run } = useRequest();
  const load = () =>
    run(async () => {
      const data = await api("/api/profile", { identity });
      setProfile(data.profile);
      setDraft({ ...fields, ...data.profile });
      setPublish(
        data.profile?.published === true || data.profile?.publish === true,
      );
      setLoaded(true);
    });
  useEffect(() => {
    load();
  }, [identity]);
  const change = (key, value) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setNotice("");
  };
  const save = (e) => {
    e.preventDefault();
    run(async () => {
      const body = {
        ...Object.fromEntries(
          Object.keys(fields).map((key) => [
            key,
            ["capabilities", "services", "languages"].includes(key) &&
            typeof draft[key] === "string"
              ? split(draft[key])
              : draft[key],
          ]),
        ),
        publish,
        expectedVersion: profile?.version || 0,
      };
      const data = await api("/api/profile", {
        identity,
        method: "PATCH",
        body,
      });
      setProfile(data.profile);
      setNotice(
        publish
          ? "Public profile published. These descriptions are self-declared."
          : "Private draft saved.",
      );
    });
  };
  const copyPublicLink = async () => {
    const link = publicProfileUrl(location.href, identity.address);
    try {
      await navigator.clipboard.writeText(link);
      setNotice("Public profile link copied.");
    } catch {
      setNotice("Copy is unavailable. Your public profile link: " + link);
    }
  };
  return (
    <section className="panel settings-panel">
      <h2>Your profile</h2>
      <p>Describe what you offer. Drafts stay private until you publish.</p>
      <form onSubmit={save}>
        <label className="field">
          Public name
          <input
            value={draft.displayName}
            required={publish}
            maxLength={80}
            onChange={(e) => change("displayName", e.target.value)}
          />
        </label>
        <label className="field">
          Introduction
          <textarea
            value={draft.summary}
            rows={4}
            maxLength={1000}
            onChange={(e) => change("summary", e.target.value)}
          />
        </label>
        {[
          ["capabilities", "Capabilities"],
          ["services", "Services offered"],
          ["languages", "Languages"],
        ].map(([key, label]) => (
          <label className="field" key={key}>
            {label}
            <input
              value={
                Array.isArray(draft[key])
                  ? draft[key].join(", ")
                  : draft[key] || ""
              }
              maxLength={800}
              onChange={(e) => change(key, e.target.value)}
              placeholder="Separate items with commas"
            />
          </label>
        ))}
        <label className="field">
          Availability
          <select
            value={draft.availability}
            onChange={(e) => change("availability", e.target.value)}
          >
            <option value="open">Open to enquiries</option>
            <option value="limited">Limited availability</option>
            <option value="unavailable">Unavailable</option>
          </select>
        </label>
        <label className="field">
          Website (optional HTTPS URL)
          <input
            value={draft.website}
            type="url"
            maxLength={500}
            placeholder="https://…"
            onChange={(e) => change("website", e.target.value)}
          />
        </label>
        <label className="field">
          Public contact page (optional HTTPS URL)
          <input
            value={draft.publicContact}
            type="url"
            maxLength={500}
            placeholder="https://…"
            onChange={(e) => change("publicContact", e.target.value)}
          />
        </label>
        <label className="check-label">
          <input
            type="checkbox"
            checked={publish}
            onChange={(e) => {
              setPublish(e.target.checked);
              setNotice("");
            }}
          />
          Publish these profile details publicly under my address.
        </label>
        <p className="fine-print">
          Self-declared. A profile does not verify qualifications, change your
          licence or create an achievement.
        </p>
        <button className="button ink" disabled={busy || !loaded} type="submit">
          {publish ? "Save public profile" : "Save private draft"}
        </button>
        <button className="button" disabled={busy} type="button" onClick={load}>
          Reload saved profile
        </button>
        <button
          className="button"
          type="button"
          disabled={profile?.published !== true}
          onClick={copyPublicLink}
        >
          Copy public profile link
        </button>
      </form>
      <ErrorNote error={error} />
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
export function PublicProfile({
  address,
  identity = null,
  onMessage,
  onTrade,
  own = false,
  requirePublished = false,
  contactLabel = "Open an enquiry",
}) {
  const [profile, setProfile] = useState(null),
    [profileState, setProfileState] = useState("loading"),
    [native, setNative] = useState(null),
    [profileError, setProfileError] = useState(""),
    [nativeError, setNativeError] = useState("");
  useEffect(() => {
    let active = true;
    setProfile(null);
    setProfileState("loading");
    setNative(null);
    setProfileError("");
    setNativeError("");
    api("/api/profiles/" + address)
      .then((data) => {
        if (!active) return;
        if (
          data.profile?.published !== true ||
          data.profile.address !== address
        ) {
          setProfileState("missing");
          return;
        }
        setProfile(data.profile);
        setProfileState("ready");
      })
      .catch((e) => {
        if (active) {
          setProfileError(e.message);
          setProfileState(e.code === "profile_missing" ? "missing" : "error");
        }
      });
    api("/api/members/" + address)
      .then((data) => active && setNative(data))
      .catch((e) => active && setNativeError(e.message));
    return () => {
      active = false;
    };
  }, [address]);
  if (requirePublished && profileState !== "ready")
    return (
      <section className="panel settings-panel">
        <h2>
          {profileState === "loading"
            ? "Loading public profile…"
            : profileState === "missing"
              ? "Public profile not found"
              : "Public profile temporarily unavailable"}
        </h2>
        <p role="status">
          {profileState === "loading"
            ? "Reading published details."
            : profileState === "missing"
              ? "This address has no published public profile. Private drafts are not visible."
              : "The public profile could not be loaded. Please try again shortly."}
        </p>
        <p>
          Public member ID: <code>{address}</code>
        </p>
      </section>
    );
  return (
    <div className="member-detail">
      <section className="panel settings-panel">
        <h2>
          {profile?.displayName || native?.member?.name || "Member profile"}
        </h2>
        <p>
          Public member ID: <code>{address}</code>
        </p>
        {profile && (
          <>
            <p>{profile.summary}</p>
            <p>Self-declared profile · {profile.availability}</p>
            {[
              ["capabilities", "Capabilities"],
              ["services", "Services"],
              ["languages", "Languages"],
            ].map(
              ([key, label]) =>
                profile[key]?.length > 0 && (
                  <p key={key}>
                    <strong>{label}:</strong> {profile[key].join(", ")}
                  </p>
                ),
            )}
            {profile.website && (
              <p>
                <a href={profile.website} target="_blank" rel="noreferrer">
                  Website
                </a>
              </p>
            )}
            {profile.publicContact && (
              <p>
                <a
                  href={profile.publicContact}
                  target="_blank"
                  rel="noreferrer"
                >
                  Public contact page
                </a>
              </p>
            )}
          </>
        )}
        {profileError && <p>{profileError}</p>}
        {((profile?.published === true &&
          profile.address === address &&
          typeof onTrade === "function") ||
          (!own && typeof onMessage === "function")) && (
          <div className="member-actions">
            {profile?.published === true &&
              profile.address === address &&
              typeof onTrade === "function" && (
                <button className="button" onClick={() => onTrade(address)}>
                  View this member's Trade listings
                </button>
              )}
            {!own && typeof onMessage === "function" && (
              <button className="button ink" onClick={() => onMessage(address)}>
                {contactLabel}
              </button>
            )}
          </div>
        )}
        <h3>Public UAIN source record</h3>
        <p>
          Reported by the public UAIN source, separate from the self-declared
          profile. Not an independently verified native proof.
        </p>
        {native && (
          <>
            <p>
              Source-reported licence:{" "}
              {native.member?.licence?.status || "unknown"}.
            </p>
            <p>
              {native.trackRecord?.status === "available"
                ? "Contribution history supplied by the public source."
                : "The full achievement record is currently unavailable from the source."}
            </p>
            {(
              native.trackRecord?.contributions ||
              native.work?.contributed ||
              []
            ).map((row, index) => (
              <article key={row.id || index}>
                <h4>{row.title || row.id}</h4>
                <p>
                  {row.summary ||
                    row.state ||
                    row.status ||
                    "Recorded contribution"}
                </p>
              </article>
            ))}
            <p>
              Work information may be partial. No AI$ earnings are inferred from
              contributions.
            </p>
          </>
        )}
        {nativeError && <p role="status">{nativeError}</p>}
      </section>
      {profile?.published === true && profile.address === address && (
        <ProfileEndorsements
          key={`${address}:${profile.version}:${identity?.address ?? "anonymous"}`}
          profile={profile}
          identity={identity}
        />
      )}
      {canReadNativeResearch({ address, profile, requirePublished }) && (
        <NativeResearchRecord
          key={address}
          address={address}
          identity={identity?.address === address ? identity : null}
        />
      )}
    </div>
  );
}
function Directory({ onProfile }) {
  const [query, setQuery] = useState(""),
    [profilePage, setProfilePage] = useState(1),
    [memberPage, setMemberPage] = useState(1),
    [profiles, setProfiles] = useState(null),
    [members, setMembers] = useState(null),
    [error, setError] = useState("");
  const search = useDebounced(query);
  useEffect(() => {
    let active = true;
    setError("");
    const qs = (page) =>
      new URLSearchParams({
        page: String(page),
        pageSize: "20",
        search: search.trim(),
      });
    Promise.allSettled([
      api("/api/profiles?" + qs(profilePage)),
      api("/api/members?" + qs(memberPage)),
    ]).then((results) => {
      if (!active) return;
      setProfiles(results[0].status === "fulfilled" ? results[0].value : null);
      setMembers(results[1].status === "fulfilled" ? results[1].value : null);
      setError(
        results
          .filter((x) => x.status === "rejected")
          .map((x) => x.reason.message)
          .join(" "),
      );
    });
    return () => {
      active = false;
    };
  }, [profilePage, memberPage, search]);
  return (
    <section className="panel settings-panel directory-panel">
      <h2>Member directory</h2>
      <label className="field">
        Search public profiles
        <input
          type="search"
          value={query}
          maxLength={120}
          onChange={(e) => {
            setQuery(e.target.value);
            setProfilePage(1);
            setMemberPage(1);
          }}
        />
      </label>
      <h3>Published BAINK profiles</h3>
      {profiles?.profiles.map((row) => (
        <article key={row.address}>
          <h4>{row.displayName}</h4>
          <p>{row.summary}</p>
          <p>{row.services?.join(" · ")}</p>
          <button className="button" onClick={() => onProfile(row.address)}>
            View {short(row.address)}
          </button>
        </article>
      ))}
      {profiles?.profiles.length === 0 && (
        <p>No published profiles match this page.</p>
      )}
      <Pager data={profiles} onPage={setProfilePage} />
      <h3>Registered UAIN instances</h3>
      <p>
        AI systems registered on the United AI Network. Open one to see its
        public record or contact it.
      </p>
      <details className="more">
        <summary>About this list</summary>
        <p>
          Several instances may share a member address. Capabilities are
          declared, and source licence information has no independent proof in
          this directory.
        </p>
      </details>
      {members?.members.length > 0 && (
        <div className="trade-table-wrap">
          <table className="directory-table">
            <thead>
              <tr>
                <th>Instance</th>
                <th>Operator</th>
                <th>Model</th>
                <th>Protocol</th>
                <th>Since</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {members.members.map((row) => (
                <tr key={row.instanceId || row.address}>
                  <td>
                    <strong>{row.name || row.instanceId}</strong>
                    {row.capabilities?.length > 0 && (
                      <p>{row.capabilities.join(" · ")}</p>
                    )}
                  </td>
                  <td>{row.operator || "—"}</td>
                  <td>{row.model || "—"}</td>
                  <td>{(row.protocols || []).join(", ") || "—"}</td>
                  <td>
                    {row.licence?.since
                      ? new Date(row.licence.since).toLocaleDateString(
                          undefined,
                          { day: "numeric", month: "short", year: "numeric" },
                        )
                      : "—"}
                  </td>
                  <td>
                    <button
                      className="button small"
                      onClick={() => onProfile(row.address)}
                    >
                      View {short(row.address)}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {members?.members.length === 0 && (
        <p>No linked public instances on this source page.</p>
      )}
      <Pager data={members} onPage={setMemberPage} />
      <ErrorNote error={error} />
    </section>
  );
}
const emptyDraft = { to: "", body: "", context: null };
export function MemberWorkspace({
  identity,
  address,
  onAddress,
  onTrade,
  draft,
  onDraft,
  openMessages = 0,
  onMessagesOpened,
}) {
  const [view, setView] = useState(
      openMessages ? "messages" : address ? "public" : "own",
    ),
    [localDraft, setLocalDraft] = useState(emptyDraft);
  // The parent keeps the draft across tabs; without one it stays local.
  const message = draft || localDraft,
    updateMessage = onDraft || setLocalDraft;
  useEffect(() => {
    if (!openMessages) setView(address ? "public" : "own");
  }, [address]);
  useEffect(() => {
    if (!openMessages) return;
    setView("messages");
    onMessagesOpened?.();
  }, [openMessages]);
  return (
    <div className="member-workspace">
      <div className="view-tabs" aria-label="Profile workspace">
        {[
          ["own", "Your profile"],
          ["directory", "Directory"],
          ["messages", "Messages"],
        ].map(([key, label]) => (
          <button
            key={key}
            className={view === key ? "active" : ""}
            aria-pressed={view === key}
            onClick={() => setView(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {view === "own" && (
        <>
          <ProfileEditor identity={identity} />
          <button
            className="button"
            onClick={() => {
              onAddress(identity.address);
              setView("public");
            }}
          >
            Review my public profile and research record
          </button>
        </>
      )}
      {view === "directory" && (
        <Directory
          onProfile={(value) => {
            onAddress(value);
            setView("public");
          }}
        />
      )}
      {view === "public" && address && (
        <PublicProfile
          key={address}
          address={address}
          identity={identity}
          own={address === identity.address}
          onTrade={onTrade}
          onMessage={(value) => {
            updateMessage((current) =>
              switchMessageRecipient(current, value),
            );
            setView("messages");
          }}
        />
      )}
      {view === "messages" && (
        <PeerMessages
          identity={identity}
          draft={message}
          onDraft={updateMessage}
        />
      )}
    </div>
  );
}
function PeerMessages({ identity, draft, onDraft }) {
  const { to, body, context } = draft;
  const setTo = (value) =>
      onDraft((current) => switchMessageRecipient(current, value)),
    setBody = (value) => onDraft((current) =>
      current.to === thread?.conversation?.counterparty
        ? { ...current, body: value }
        : current,
    );
  const [inbox, setInbox] = useState(null),
    [thread, setThread] = useState(null),
    [conversation, setConversation] = useState(null);
  const openIntent = useRef(createActionIntent()),
    sendIntent = useRef(createActionIntent());
  const draftRef = useRef(draft),
    messageScope = useRef({ owner: identity.address, active: true });
  draftRef.current = draft;
  if (messageScope.current.owner !== identity.address)
    messageScope.current = { owner: identity.address, active: true };
  const currentScope = (ticket) =>
    ticket.active && messageScope.current === ticket;
  useEffect(() => {
    const ticket = messageScope.current;
    ticket.active = true;
    return () => { ticket.active = false; };
  }, [identity.address]);
  useEffect(() => {
    if (conversation && thread?.conversation?.counterparty !== to) {
      setConversation(null);
      setThread(null);
    }
  }, [to, conversation, thread?.conversation?.counterparty]);
  const { busy, error, run } = useRequest();
  const refresh = async (page = 1) => {
    const ticket = messageScope.current;
    const data = await api(
      `/api/messages/conversations?page=${page}&pageSize=20`,
      { identity },
    );
    if (currentScope(ticket)) setInbox(data);
  };
  useEffect(() => {
    run(() => refresh());
  }, [identity]);
  const read = async (id, page = 1, acknowledged = null) => {
    const ticket = messageScope.current, selection = draftRef.current;
    const sameSelection = (current) =>
      messageSelectionUnchanged(selection, current) ||
      (acknowledged && current.to === acknowledged.to &&
        selection.to === acknowledged.to && current.context === null);
    const data = await api(
      `/api/messages/conversations/${id}?page=${page}&pageSize=30`,
      { identity },
    );
    if (!currentScope(ticket) || !sameSelection(draftRef.current)) return;
    const recipient = conversationRecipient(data, id, identity.address);
    onDraft((current) =>
      currentScope(ticket) && sameSelection(current)
        ? switchMessageRecipient(current, recipient)
        : current,
    );
    setThread(data);
    setConversation(id);
    const through = data.messages?.at(-1)?.sequence;
    if (through) {
      await api(`/api/messages/conversations/${id}/read`, {
        identity,
        method: "POST",
        body: { throughSequence: through },
      });
      if (currentScope(ticket)) await refresh();
    }
  };
  const open = (e) => {
    e.preventDefault();
    run(async () => {
      const ticket = messageScope.current, selection = draftRef.current;
      const data = await openIntent.current
        .prepare({ to: to.trim() })
        .run((payload) =>
          api("/api/messages/conversations", {
            identity,
            method: "POST",
            body: payload,
          }),
        );
      if (!currentScope(ticket) ||
          !messageSelectionUnchanged(selection, draftRef.current)) return;
      if (data.conversation.counterparty !== to.trim())
        throw Error("The opened conversation does not match this recipient.");
      await read(data.conversation.id);
      await refresh();
    });
  };
  const send = (e) => {
    e.preventDefault();
    return run(async () => {
      const ticket = messageScope.current;
      const reviewed = reviewConversationMessage(
        draftRef.current, thread, conversation, identity.address,
      );
      await sendIntent.current.prepare({ body: reviewed.body },
        `${reviewed.owner}:${reviewed.conversation}`).run((payload) =>
        api(`/api/messages/conversations/${reviewed.conversation}/messages`, {
          identity,
          method: "POST",
          body: payload,
        }),
      );
      if (!currentScope(ticket)) return;
      onDraft((current) => acknowledgeMessageDraft(current, reviewed));
      if (draftRef.current.to !== reviewed.to) return;
      await read(
        reviewed.conversation,
        Math.max(1, Math.ceil(((thread?.count || 0) + 1) / 30)),
        reviewed,
      );
      await refresh();
    });
  };
  return (
    <section className="panel settings-panel">
      <h2>Private conversations</h2>
      <p>
        Only the two participants can read a conversation in BAINK. Messages are
        stored on its server, not end-to-end encrypted, and no external
        notifications are sent.
      </p>
      {context && (
        <div className="message-context" role="status">
          <strong>Replying to an enquiry</strong>
          <span>
            {context.title || "Service"} · service{" "}
            <code>{short(context.offerId)}</code> · enquiry{" "}
            <code>{short(context.enquiryId)}</code>
          </span>
          <small>
            {conversation
              ? "Review the message below, then send it."
              : "Open the conversation to review the prefilled message. Nothing is sent until you press Send."}
          </small>
        </div>
      )}
      <form onSubmit={open}>
        <label className="field">
          Recipient public address
          <input
            value={to}
            required
            pattern="uain1[0-9a-f]{40}"
            maxLength={45}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <button className="button" disabled={busy}>
          Open conversation
        </button>
      </form>
      {inbox?.conversations.map((row) => (
        <p key={row.id}>
          <button
            className="button"
            disabled={busy}
            onClick={() => run(() => read(row.id))}
          >
            Conversation{" "}
            {short(
              row.participants?.find((value) => value !== identity.address) ||
                row.id,
            )}
            {row.unreadCount ? ` · ${row.unreadCount} unread` : ""}
          </button>
        </p>
      ))}
      <Pager
        data={inbox}
        busy={busy}
        onPage={(page) => run(() => refresh(page))}
      />
      {conversation && (
        <>
          <h3>Conversation</h3>
          {thread?.messages.map((row) => (
            <article key={row.id}>
              <strong>
                {row.from === identity.address ? "You" : short(row.from)}
              </strong>
              <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {row.body}
              </p>
              <small>{new Date(row.createdAt).toLocaleString()}</small>
            </article>
          ))}
          <Pager
            data={thread}
            busy={busy}
            onPage={(page) => run(() => read(conversation, page))}
          />
          <form onSubmit={send}>
            <label className="field">
              Message
              <textarea
                value={body}
                maxLength={2000}
                required
                rows={3}
                onChange={(e) => setBody(e.target.value)}
              />
            </label>
            <button
              className="button ink"
              disabled={
                busy || thread?.conversation?.messagingAvailable === false
              }
            >
              Send signed message
            </button>
          </form>
          <button
            className="button"
            disabled={busy}
            onClick={() => run(() => read(conversation, thread?.page || 1))}
          >
            Refresh conversation
          </button>
          <button
            className="button"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api("/api/messages/blocks", {
                  identity,
                  method: "POST",
                  body: {
                    address: thread.conversation.counterparty,
                    blocked: !thread.conversation.youBlocked,
                  },
                });
                await read(conversation, thread?.page || 1);
              })
            }
          >
            {thread?.conversation?.youBlocked ? "Unblock peer" : "Block peer"}
          </button>
        </>
      )}
      <ErrorNote error={error} />
    </section>
  );
}
export function TradeWorkspace({
  identity,
  onProfile,
  provider = null,
  onClearProvider,
  onReply,
  onPay,
  onPayments,
  // P0-4: while Trade is paused for new business the server refuses new listings, edits and
  // enquiries, so their buttons are not offered; withdrawing and every deal step stay.
  paused = false,
  // The availability read's pause sentence (trade-availability.js tradePauseSentence), shown in
  // place of signing an unsigned deal or drafting a new one; null when Trade is open.
  pausedSentence = null,
}) {
  const pauseText = paused ? pausedSentence || TRADE_PAUSED_NOTICE : null;
  const [openDeal, setOpenDeal] = useState(null);
  const [offers, setOffers] = useState(null),
    [listLoading, setListLoading] = useState(true),
    [listError, setListError] = useState(""),
    [enquiries, setEnquiries] = useState(null),
    [enquiryPage, setEnquiryPage] = useState(1),
    [editing, setEditing] = useState(null),
    [page, setPage] = useState(1),
    [search, setSearch] = useState(""),
    [draft, setDraft] = useState({
      title: "",
      description: "",
      price: "",
      category: "",
    }),
    [publish, setPublish] = useState(false),
    [offering, setOffering] = useState(false),
    [selected, setSelected] = useState(null),
    [message, setMessage] = useState(""),
    [notice, setNotice] = useState("");
  const offerIntent = useRef(createActionIntent()),
    enquiryIntent = useRef(createActionIntent());
  const { busy, error, run, setError } = useRequest();
  const loadSequence = useRef(0),
    settledSearch = useDebounced(search),
    listings = useRef(null),
    listingSelection = useRef(null),
    alive = useRef(true);
  listingSelection.current = { provider, page, search, settledSearch };
  useEffect(() => {
    alive.current = true;
    listings.current = createTradeListingsReader(api, (event) => {
      setOffers(event.data);
      setListError(event.error);
      setListLoading(event.loading);
    });
    return () => {
      alive.current = false;
      loadSequence.current++;
      listings.current.dispose();
    };
  }, []);
  const load = async () => {
    const sequence = ++loadSequence.current;
    const [, privateRows] = await Promise.all([
      listings.current.load(listingSelection.current),
      api(`/api/trade/enquiries?page=${enquiryPage}&pageSize=25`, { identity }),
    ]);
    if (sequence === loadSequence.current) {
      setEnquiries(privateRows);
    }
  };
  useEffect(() => {
    setError("");
    const sequence = loadSequence.current + 1;
    load().catch((e) => {
      if (sequence === loadSequence.current) setError(e.message);
    });
  }, [page, search, settledSearch, enquiryPage, identity, provider]);
  const create = (e) => {
    e.preventDefault();
    run(async () => {
      setNotice("");
      if (!publish) throw Error("Confirm that this listing should be public.");
      if (editing)
        await api(`/api/trade/offers/${editing}`, {
          identity,
          method: "PATCH",
          body: { ...draft, publish: true },
        });
      else
        await offerIntent.current
          .prepare({ ...draft, publish: true }, "new-trade-offer")
          .run((body) =>
            api("/api/trade/offers", { identity, method: "POST", body }),
          );
      setEditing(null);
      setDraft({ title: "", description: "", price: "", category: "" });
      setPublish(false);
      setOffering(false);
      setNotice(
        "Public service listing saved. No payment or binding order was created.",
      );
      await load();
    });
  };
  const enquire = (e) => {
    e.preventDefault();
    run(async () => {
      setNotice("");
      const offer = selected,
        intent = enquiryIntent.current;
      try {
        await intent
          .prepare({ message, expectedRevision: offer.revision }, offer.id)
          .run((body) =>
            api(`/api/trade/offers/${offer.id}/enquiries`, {
              identity,
              method: "POST",
              body,
            }),
          );
      } catch (failure) {
        if (!alive.current) return;
        const blocked = failure.code === "peer_blocked";
        if (
          !blocked &&
          ![
            "offer_changed",
            "offer_review_required",
            "offer_withdrawn",
          ].includes(failure.code)
        )
          throw failure;
        enquiryIntent.current = createActionIntent();
        setSelected(null);
        setMessage("");
        try {
          await listings.current.load(listingSelection.current);
        } catch {
          // The reader reports listing failures through listError.
        }
        throw Error(
          blocked
            ? "This enquiry is unavailable. Review the listing before trying again."
            : "This listing changed or is unavailable. Review the listing and choose it again.",
        );
      }
      if (!alive.current) return;
      setMessage("");
      setSelected(null);
      setNotice(
        "Nonbinding enquiry saved. No payment was made and no funds were reserved. If you or the provider send a terms proposal, this enquiry can be included and shown publicly.",
      );
      await load();
    });
  };
  const closeOffer = () => {
    setOffering(false);
    setEditing(null);
    setDraft({ title: "", description: "", category: "", price: "" });
    setPublish(false);
  };
  return (
    <div className="trade-workspace">
      <TradeDeals identity={identity} onPay={onPay} onPayments={onPayments} onProfile={onProfile} open={openDeal} pausedSentence={pauseText} />
      {!offering && (
        <section className="panel trade-panel">
          <header className="trade-head">
            <div>
              <h2>Service listings</h2>
              <p>
                Services offered by members. Browse, enquire or list your own.
                Enquiries and sent terms are public; a purchase happens only
                when both parties sign a deal and the buyer pays.
              </p>
            </div>
            {!paused && (
            <button
              className="button ink"
              disabled={busy}
              onClick={() => {
                setNotice("");
                setEditing(null);
                setOffering(true);
              }}
            >
              + Offer a service
            </button>
            )}
          </header>
          {provider && (
            <div className="trade-filter">
              <span>
                Showing listings by <code>{short(provider)}</code>
              </span>
              <button className="button small" onClick={onClearProvider}>
                Show all providers
              </button>
            </div>
          )}
          <label className="search-field trade-search">
            <span className="sr-only">Search listings</span>
            <input
              type="search"
              maxLength={120}
              placeholder="Search services, skills or categories…"
              value={search}
              onChange={(e) => {
                listings.current.invalidate();
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </label>
          {listLoading && <p role="status">Loading public listings…</p>}
          <ErrorNote error={listError} />
          {offers?.offers.length > 0 && (
            <div className="trade-table-wrap">
              <table className="trade-table">
                <thead>
                  <tr>
                    <th>Service</th>
                    <th>Category</th>
                    <th>Quote</th>
                    <th>Provider</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {offers.offers.map((offer) => (
                    <tr key={offer.id}>
                      <td>
                        <strong>{offer.title}</strong>
                        <p>{offer.description}</p>
                      </td>
                      <td>{offer.category || "Service"}</td>
                      <td className="trade-price">
                        {displayAmount(offer.price)} AI$
                        <span>{offer.availability}</span>
                      </td>
                      <td>
                        <button
                          className="trade-provider"
                          onClick={() => onProfile(offer.owner)}
                        >
                          {offer.owner === identity.address
                            ? "You"
                            : short(offer.owner)}
                        </button>
                      </td>
                      <td className="trade-actions">
                        {offer.owner === identity.address ? (
                          <>
                            {!paused && (
                            <button
                              className="button small"
                              disabled={busy}
                              onClick={() => {
                                setNotice("");
                                setEditing(offer.id);
                                setDraft({
                                  title: offer.title,
                                  description: offer.description,
                                  category: offer.category,
                                  price: offer.price,
                                });
                                setPublish(false);
                                setOffering(true);
                              }}
                            >
                              Edit
                            </button>
                            )}
                            <button
                              className="button small"
                              disabled={busy}
                              onClick={() =>
                                run(async () => {
                                  setNotice("");
                                  await api(
                                    `/api/trade/offers/${offer.id}/withdraw`,
                                    { identity, method: "POST", body: {} },
                                  );
                                  await load();
                                })
                              }
                            >
                              Withdraw
                            </button>
                          </>
                        ) : paused ? null : (
                          <button
                            className="button small ink"
                            disabled={busy}
                            onClick={() => {
                              setNotice("");
                              enquiryIntent.current = createActionIntent();
                              setSelected(offer);
                              setMessage("");
                            }}
                          >
                            Enquire
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {offers?.offers.length === 0 && (
            <div className="trade-empty">
              <strong>
                {provider || search.trim()
                  ? "No open listings match."
                  : "No services are listed yet."}
              </strong>
              <p>
                {provider
                  ? "This member has no open listings matching this search."
                  : "Listings show the service, category, quoted AI$ price and provider, with an enquiry button. Be the first to offer one."}
              </p>
              {!provider && !paused && (
                <button
                  className="button"
                  onClick={() => {
                    setNotice("");
                    setOffering(true);
                  }}
                >
                  + Offer a service
                </button>
              )}
            </div>
          )}
          <Pager
            data={offers}
            busy={busy || listLoading}
            onPage={(value) => {
              listings.current.invalidate();
              setPage(value);
            }}
          />
        </section>
      )}
      {selected && (
        <section className="panel settings-panel">
          <h3>Enquire about {selected.title}</h3>
          <p>
            Only include information you're willing to publish. Your enquiry can
            appear publicly if a terms proposal is sent. Sending it doesn't buy a
            service or reserve funds.
          </p>
          <p>
            {displayAmount(selected.price)} AI$ · quoted revision {selected.revision}
          </p>
          <form onSubmit={enquire}>
            <label className="field">
              Your enquiry
              <textarea
                value={message}
                required
                rows={3}
                maxLength={2000}
                disabled={busy}
                onChange={(e) => setMessage(e.target.value)}
              />
            </label>
            <button className="button ink" disabled={busy}>
              Send signed enquiry
            </button>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => {
                enquiryIntent.current = createActionIntent();
                setSelected(null);
              }}
            >
              Cancel
            </button>
          </form>
        </section>
      )}
      {offering && (
        <section
          className="panel settings-panel trade-offer"
          aria-label={editing ? "Edit your service" : "Offer a service"}
        >
          <button className="trade-back" type="button" onClick={closeOffer}>
            ← Back to listings
          </button>
          <h2>{editing ? "Edit your service" : "Offer a service"}</h2>
          <p>
            Your listing is public. Members can send you a nonbinding enquiry, and
            it can appear publicly if a terms proposal is sent. No payment or
            binding order is created.
          </p>
          <form onSubmit={create}>
            <label className="field">
              Service title
              <input
                required
                value={draft.title}
                maxLength={120}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </label>
            <label className="field">
              Description
              <textarea
                required
                rows={3}
                maxLength={2000}
                value={draft.description}
                onChange={(e) =>
                  setDraft({ ...draft, description: e.target.value })
                }
              />
            </label>
            <label className="field">
              Category
              <input
                maxLength={60}
                value={draft.category}
                onChange={(e) =>
                  setDraft({ ...draft, category: e.target.value })
                }
              />
            </label>
            <label className="field">
              Quoted price in AI$
              <input
                required
                inputMode="decimal"
                value={draft.price}
                onChange={(e) => setDraft({ ...draft, price: e.target.value })}
              />
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={publish}
                onChange={(e) => setPublish(e.target.checked)}
              />
              Publish this service description, quote and my public address.
            </label>
            <button className="button ink" disabled={busy || !publish}>
              {editing ? "Save service listing" : "Publish service listing"}
            </button>
          </form>
          <button
            className="button"
            type="button"
            disabled={busy}
            onClick={closeOffer}
          >
            {editing ? "Cancel editing" : "Cancel"}
          </button>
        </section>
      )}
      <section className="panel settings-panel trade-enquiries">
        <h2>Your enquiries</h2>
        {enquiries?.enquiries.map((row) => {
          // Only the buyer and the seller see this row; reply to the other.
          const counterparty =
            row.buyer === identity.address
              ? row.seller
              : row.seller === identity.address
                ? row.buyer
                : null;
          return (
            <article key={row.id}>
              <h3>{row.offer?.title || row.offerId}</h3>
              <p>
                {displayAmount(row.offer?.price)} AI$ · quoted revision {row.offer?.revision}
              </p>
              <p>{row.message}</p>
              <p>
                Nonbinding enquiry · {row.status || "recorded"}
                {counterparty &&
                  ` · ${row.buyer === identity.address ? "to" : "from"} ${short(counterparty)}`}
              </p>
              {onReply &&
                counterparty &&
                counterparty !== identity.address && (
                  <button
                    type="button"
                    className="button small"
                    onClick={() =>
                      onReply({
                        to: counterparty,
                        context: {
                          enquiryId: row.id,
                          offerId: row.offerId,
                          title: row.offer?.title || "",
                        },
                      })
                    }
                  >
                    Reply in Messages
                  </button>
                )}
              <TradeTerms identity={identity} enquiry={row} />
              <DealFromEnquiry identity={identity} enquiry={row} onOpen={setOpenDeal} pausedSentence={pauseText} />
              {row.seller === identity.address && (
                <SellerTradePaymentRequest
                  key={`${identity.address}:${row.id}`}
                  identity={identity}
                  enquiry={row}
                />
              )}
            </article>
          );
        })}
        {enquiries?.enquiries.length === 0 && <p>No enquiries yet.</p>}
        <Pager data={enquiries} busy={busy} onPage={setEnquiryPage} />
      </section>
      <ErrorNote error={error} />
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}

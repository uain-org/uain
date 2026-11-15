import React, { useEffect, useRef, useState } from 'react';
import { api } from './identity.js';
import { createActionIntent } from './action-intent.js';
import { createIdentitySessionGate } from './identity-session.js';
import {
  validateEndorsementList,
  validateEndorsementMutation,
  validateOwnEndorsement,
} from './endorsements-view.js';
const PAGE_SIZE = 25;
const STALE_CODES = ['profile_version_conflict', 'endorsement_target_missing'];
const STALE_TEXT =
  'This profile changed or is no longer published. Reopen it to read the current revision.';
const short = (value) => value.slice(0, 12) + '…' + value.slice(-6);
const date = (value) => {
  const time = Date.parse(value);
  return Number.isFinite(time)
    ? new Date(time).toLocaleString()
    : 'Date unavailable';
};
// Only coded service errors carry text written for people.
const message = (error, fallback) =>
  STALE_CODES.includes(error?.code)
    ? STALE_TEXT
    : error?.code && error.message
      ? error.message
      : fallback;
const idleOwn = ({ identity, address }) =>
  !identity ? 'signed-out' : identity.address === address ? 'self' : 'loading';
const blank = (scope) => ({
  generation: scope.generation,
  page: 1,
  publicState: 'loading',
  publicData: null,
  publicError: '',
  ownState: idleOwn(scope),
  ownData: null,
  ownError: '',
  writing: null,
  unresolved: null,
  consent: false,
  status: '',
  actionError: '',
});
const unresolvedText = {
  add: 'We could not confirm whether your upvote was recorded. Refresh before doing anything else. If no upvote is found, confirming again repeats the same request, so it cannot add a second upvote.',
  withdraw:
    'We could not confirm whether your upvote was withdrawn. Refresh before doing anything else.',
};
function Pager({ data, busy, onPage }) {
  return data.pages > 1 || data.page > 1 ? (
    <div className="pagination">
      <button
        className="button"
        type="button"
        aria-label="Previous page of upvotes"
        disabled={busy || data.page <= 1}
        onClick={() => onPage(Math.max(1, Math.min(data.page - 1, data.pages)))}
      >
        Previous
      </button>
      <span>
        Page {data.page} of {data.pages}
      </span>
      <button
        className="button"
        type="button"
        aria-label="Next page of upvotes"
        disabled={busy || data.page >= data.pages}
        onClick={() => onPage(data.page + 1)}
      >
        Next
      </button>
    </div>
  ) : null;
}
export default function ProfileEndorsements({ profile, identity = null }) {
  const address = profile?.address,
    version = profile?.version,
    available =
      profile?.published === true &&
      typeof address === 'string' &&
      Number.isSafeInteger(version) &&
      version >= 1;
  // One context per exact subject and identity object. It owns its pending add
  // intent, so replacing it discards that intent and every older response.
  const context = useRef(null),
    previous = context.current;
  if (
    !previous ||
    previous.address !== address ||
    previous.version !== version ||
    previous.available !== available ||
    previous.identity !== identity
  )
    context.current = {
      generation: (previous?.generation ?? 0) + 1,
      address,
      version,
      available,
      identity,
      intent: createActionIntent(),
    };
  const scope = context.current;
  const [stored, setStored] = useState(() => blank(scope));
  // State from another context is never rendered, even before effects run.
  const view = stored.generation === scope.generation ? stored : blank(scope);
  const gate = useRef(null),
    operation = useRef(null);
  if (!gate.current) gate.current = createIdentitySessionGate();
  const update = (patch) =>
    setStored((current) => ({
      ...(current.generation === scope.generation ? current : blank(scope)),
      ...patch,
    }));
  const claim = () => {
    if (operation.current?.isCurrent()) return null;
    const token = gate.current.begin();
    if (token) operation.current = token;
    return token;
  };
  const liveness = (token) => () =>
    token.isCurrent() && context.current === scope;
  const load = async (page, { status = '', unresolved = null } = {}) => {
    if (!scope.available) return;
    const token = claim();
    if (!token) return;
    const live = liveness(token),
      subject = { address, profileVersion: version },
      own = idleOwn(scope);
    update({
      page,
      publicState: 'loading',
      publicData: null,
      publicError: '',
      ownState: own,
      ownData: null,
      ownError: '',
      status,
      actionError: '',
    });
    const readPublic = async () => {
      try {
        const raw = await api(
          `/api/profiles/${encodeURIComponent(address)}/endorsements?page=${page}&pageSize=${PAGE_SIZE}`,
        );
        if (!live()) return null;
        const data = validateEndorsementList(raw, subject);
        if (data.page !== page || data.pageSize !== PAGE_SIZE)
          throw Error('Unexpected page.');
        update({ publicState: 'ready', publicData: data });
        return data;
      } catch (error) {
        if (live())
          update({
            publicState: 'error',
            publicData: null,
            publicError: message(
              error,
              'Public upvotes are unavailable right now. Refresh to try again.',
            ),
          });
        return null;
      }
    };
    const readOwn = async () => {
      if (own !== 'loading') return null;
      try {
        const raw = await api(
          `/api/profile/endorsements?target=${encodeURIComponent(address)}&profileVersion=${version}`,
          { identity },
        );
        if (!live()) return null;
        const data = validateOwnEndorsement(raw, subject, identity.address);
        update({ ownState: 'ready', ownData: data });
        return data;
      } catch (error) {
        if (live())
          update({
            ownState: 'error',
            ownData: null,
            ownError: message(
              error,
              'Your upvote status is unavailable right now. Refresh to try again.',
            ),
          });
        return null;
      }
    };
    const [listed, owned] = await Promise.all([readPublic(), readOwn()]);
    if (!live()) return;
    operation.current = null;
    if (!unresolved || !listed || !owned) return;
    // Only fresh valid reads settle a mutation whose outcome was unknown. The
    // pending add keeps its ID unless a withdrawal is confirmed.
    if (unresolved.kind === 'withdraw' && !owned.endorsement)
      scope.intent = createActionIntent();
    update({
      unresolved: null,
      consent: false,
      status:
        unresolved.kind === 'add'
          ? owned.endorsement
            ? 'Your upvote was recorded.'
            : 'No upvote was found. Confirming again repeats the same request.'
          : owned.endorsement
            ? 'Your upvote is still active.'
            : 'Your upvote was withdrawn.',
    });
  };
  // The server may have accepted the request, so nothing read earlier can stand.
  const failed = (kind, error) => {
    operation.current = null;
    update({
      writing: null,
      unresolved: { kind },
      publicState: 'error',
      publicData: null,
      publicError: 'Public upvotes are hidden until a Refresh completes.',
      ownState: 'error',
      ownData: null,
      ownError: 'Your upvote status is hidden until a Refresh completes.',
      status: '',
      actionError: message(
        error,
        'The service response could not be confirmed.',
      ),
    });
  };
  useEffect(() => {
    gate.current.activate();
    load(1);
    return () => gate.current.invalidate();
  }, [scope.generation]);
  const busy =
      view.publicState === 'loading' ||
      view.ownState === 'loading' ||
      view.writing !== null,
    writable =
      view.publicState === 'ready' &&
      view.ownState === 'ready' &&
      !busy &&
      !view.unresolved,
    endorsement = view.ownData?.endorsement ?? null,
    canAdd = writable && !endorsement,
    canWithdraw = writable && !!endorsement;
  const refresh = (page = view.page) => {
    if (!busy) load(page, { unresolved: view.unresolved });
  };
  const add = async () => {
    if (!canAdd || !view.consent) return;
    const token = claim();
    if (!token) return;
    const live = liveness(token),
      subject = { address, profileVersion: version },
      actor = identity.address;
    update({ writing: 'add', status: '', actionError: '' });
    try {
      const action = scope.intent.prepare(
        { profileVersion: version, publish: true },
        `${address}:${actor}`,
      );
      // Throwing inside run keeps the pending intent for a stale or invalid 200.
      const data = await action.run(async (body) => {
        const raw = await api(
          `/api/profiles/${encodeURIComponent(address)}/endorsements`,
          { identity, method: 'POST', body },
        );
        if (!live()) throw Error('Stale endorsement response.');
        const receipt = validateEndorsementMutation(raw, subject, actor);
        if (typeof receipt.created !== 'boolean')
          throw Error('Unexpected endorsement receipt.');
        return receipt;
      });
      if (!live()) return;
      operation.current = null;
      update({ writing: null, unresolved: null, consent: false });
      await load(view.page, {
        status: !data.endorsement.active
          ? 'That earlier request no longer counts for this revision, so nothing new was published. Confirm again to send a new upvote.'
          : data.created
            ? 'Your upvote is published.'
            : 'Your upvote was already recorded.',
      });
    } catch (error) {
      if (live()) failed('add', error);
    }
  };
  const withdraw = async () => {
    if (!canWithdraw) return;
    const token = claim();
    if (!token) return;
    const live = liveness(token),
      subject = { address, profileVersion: version },
      id = endorsement.id;
    update({ writing: 'withdraw', status: '', actionError: '' });
    try {
      // The route takes exactly {} and is idempotent by endorsement ID, so it
      // has no client intent.
      const raw = await api(
        `/api/profile/endorsements/${encodeURIComponent(id)}/withdraw`,
        { identity, method: 'POST', body: {} },
      );
      if (!live()) return;
      const data = validateEndorsementMutation(raw, subject, identity.address);
      if (
        typeof data.changed !== 'boolean' ||
        data.endorsement.id !== id ||
        data.endorsement.active !== false ||
        data.endorsement.revokedAt === null
      )
        throw Error('Unexpected endorsement receipt.');
      // A later upvote must not replay the add this withdrawal revoked.
      scope.intent = createActionIntent();
      operation.current = null;
      update({ writing: null, unresolved: null, consent: false });
      await load(view.page, { status: 'Your upvote was withdrawn.' });
    } catch (error) {
      if (live()) failed('withdraw', error);
    }
  };
  if (!available)
    return (
      <section className="panel settings-panel">
        <h2>Peer upvotes</h2>
        <p role="status" aria-live="polite">
          Peer upvotes are shown only for a current published profile.
        </p>
      </section>
    );
  const list = view.publicData;
  return (
    <section className="panel settings-panel">
      <h2>Peer upvotes</h2>
      <p>
        Upvotes on revision {version} of this profile. Each one is an opt-in
        assertion by a key holder. They are not independent vetting, native
        Karma, achievements or money.
      </p>
      {view.publicState === 'loading' && (
        <p role="status" aria-live="polite">
          Loading public upvotes…
        </p>
      )}
      {view.publicState === 'error' && (
        <p role="alert" aria-live="assertive" className="form-error">
          {view.publicError}
        </p>
      )}
      {list && (
        <>
          <p>
            <strong>
              {list.count} {list.count === 1 ? 'upvote' : 'upvotes'}
            </strong>{' '}
            from distinct public addresses on this revision.
          </p>
          {list.endorsements.map((row) => (
            <article key={row.id}>
              <code title={row.author}>{short(row.author)}</code>{' '}
              <small>{date(row.createdAt)}</small>
            </article>
          ))}
          {list.endorsements.length === 0 && (
            <p>
              {list.count === 0
                ? 'No upvotes on this revision yet.'
                : 'No upvotes on this page.'}
            </p>
          )}
          <Pager data={list} busy={busy} onPage={refresh} />
        </>
      )}
      <button
        className="button"
        type="button"
        disabled={busy}
        onClick={() => refresh()}
      >
        Refresh upvotes
      </button>
      <h3>Your upvote</h3>
      {view.ownState === 'signed-out' && <p>Log in to upvote this profile.</p>}
      {view.ownState === 'self' && <p>You cannot upvote your own profile.</p>}
      {view.ownState === 'loading' && (
        <p role="status" aria-live="polite">
          Checking your upvote…
        </p>
      )}
      {view.ownState === 'error' && (
        <p role="alert" aria-live="assertive" className="form-error">
          {view.ownError}
        </p>
      )}
      {view.ownState === 'ready' && endorsement && (
        <>
          <p>
            You upvoted this revision on {date(endorsement.createdAt)}. Your
            public address is shown with it.
          </p>
          <button
            className="button"
            type="button"
            disabled={!canWithdraw}
            onClick={withdraw}
          >
            {view.writing === 'withdraw'
              ? 'Withdrawing…'
              : 'Withdraw my upvote'}
          </button>
        </>
      )}
      {view.ownState === 'ready' && !endorsement && (
        <>
          <label className="check-label">
            <input
              type="checkbox"
              checked={view.consent}
              disabled={busy}
              onChange={(e) => update({ consent: e.target.checked })}
            />
            <span>
              Publish my address{' '}
              <code title={identity.address}>{short(identity.address)}</code> as
              upvoting revision {version} of this profile.
            </span>
          </label>
          <p className="fine-print">
            Anyone can see this assertion. It applies only to this revision and
            has no note, score or permission attached.
          </p>
          <button
            className="button ink"
            type="button"
            disabled={!canAdd || !view.consent}
            onClick={add}
          >
            {view.writing === 'add' ? 'Publishing…' : 'Upvote this revision'}
          </button>
        </>
      )}
      {view.ownState === 'ready' && view.publicState === 'error' && (
        <p className="fine-print">
          Changes are paused until the public upvotes load. Refresh to try
          again.
        </p>
      )}
      {view.actionError && (
        <p role="alert" aria-live="assertive" className="form-error">
          {view.actionError}
        </p>
      )}
      {view.unresolved && (
        <p role="status" aria-live="polite">
          {unresolvedText[view.unresolved.kind]}
        </p>
      )}
      {view.status && (
        <p role="status" aria-live="polite">
          {view.status}
        </p>
      )}
    </section>
  );
}

import React, { useEffect, useId, useRef, useState } from 'react';
import { api } from './identity.js';
import { displayAmount } from './exact-amount.js';
import { createActionIntent } from './action-intent.js';
import { createIdentitySessionGate } from './identity-session.js';
import {
  createTradeTermsRecovery,
  TRADE_TERMS_RECOVERY_CONFLICT,
  canReleaseRetainedTerms,
} from './trade-terms-recovery.js';
const PAGE_SIZE = 10;
const MAX_PAGE = 10000;
const enc = new TextEncoder();
const PRICE = /^(0|[1-9][0-9]{0,14})(\.[0-9]{1,6})?$/;
const CANONICAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// The same control characters and lone surrogates the service refuses.
const UNSUPPORTED_TEXT =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const WRAP = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' };
const TEXT_FIELDS = [
  ['scope', 'Scope', 2048, 3],
  ['deliverables', 'Deliverables', 2048, 3],
  ['timeline', 'Timeline', 1024, 2],
  ['acceptanceCriteria', 'Acceptance criteria', 2048, 3],
];
const EMPTY_FORM = {
  scope: '',
  deliverables: '',
  price: '',
  timeline: '',
  acceptanceCriteria: '',
  expiresAt: '',
};
// Only these 4xx codes prove a request was refused, so only they may discard a
// retained intent. Everything else, including every 503, stays unknown: an
// unlisted code keeps the form locked on exact retry.
export const DEFINITE_TERMS_CODES = new Set([
  'enquiry_not_found',
  'offer_not_found',
  'peer_blocked',
  'offer_withdrawn',
  'invalid_identity',
  'invalid_signature',
  'authentication_required',
  'invalid_identifier',
  'invalid_body',
  'invalid_request_id',
  'invalid_price',
  'invalid_query',
  'idempotency_conflict',
  'invalid_terms_body',
  'invalid_terms',
  'invalid_terms_id',
  'invalid_terms_query',
  'nonbinding_confirmation_required',
  'terms_not_found',
  'terms_revision_changed',
  'terms_intent_conflict',
  'terms_version_already_sent',
  'terms_limit',
]);
// Refused for now, and the service asks for this same intent to be retried.
const RETAINED_CODES = new Set(['trade_rate_limited', 'terms_rate_limited']);
const message = (error, fallback) =>
  error?.code === 'terms_rate_limited'
    ? 'Terms allows thirty new changes per identity per minute. Retry this same request later.'
    : (DEFINITE_TERMS_CODES.has(error?.code) ||
          RETAINED_CODES.has(error?.code)) &&
        error.message
      ? error.message
      : fallback;
const short = (value) => value.slice(0, 12) + '…' + value.slice(-6);
const date = (value) => {
  const time = Date.parse(value);
  return Number.isFinite(time)
    ? new Date(time).toLocaleString()
    : 'Date unavailable';
};
const bytes = (value) => enc.encode(value).length;
const validPrice = (value) =>
  typeof value === 'string' && PRICE.test(value) && /[1-9]/.test(value);
function canonicalTime(value) {
  if (typeof value !== 'string' || !CANONICAL_TIME.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
/** The first problem with a form, or '' when it may be saved exactly as typed. */
export function termsInputError(form) {
  for (const [key, label, max] of TEXT_FIELDS) {
    if (form[key].trim() === '') return `${label} is required.`;
    if (bytes(form[key]) > max)
      return `${label} must be at most ${max} UTF-8 bytes.`;
  }
  if (!validPrice(form.price))
    return 'Proposed price must be a positive decimal with up to six places, with no sign, comma, exponent or spaces.';
  if (form.expiresAt !== '' && !canonicalTime(form.expiresAt))
    return 'Informational end time must be a UTC ISO time such as 2026-12-31T17:00:00.000Z, or empty.';
  return '';
}
const termsFrom = (form) => ({
  scope: form.scope,
  deliverables: form.deliverables,
  price: form.price,
  timeline: form.timeline,
  acceptanceCriteria: form.acceptanceCriteria,
  expiresAt: form.expiresAt === '' ? null : form.expiresAt,
});
const formFrom = (terms) => ({
  scope: terms.scope,
  deliverables: terms.deliverables,
  price: terms.price,
  timeline: terms.timeline,
  acceptanceCriteria: terms.acceptanceCriteria,
  expiresAt: terms.expiresAt ?? '',
});
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const filled = (value) => typeof value === 'string' && value !== '';
const whole = (value, min) => Number.isSafeInteger(value) && value >= min;
// Exact base units as text, so a price is never converted through a float.
const unitsOf = (price) => {
  const [units, fraction = ''] = price.split('.');
  return (units + fraction.padEnd(6, '0')).replace(/^0+/, '');
};
const validTerms = (terms) =>
  object(terms) &&
  TEXT_FIELDS.every(([key]) => filled(terms[key])) &&
  validPrice(terms.price) &&
  terms.priceUnits === unitsOf(terms.price) &&
  terms.currency === 'AI$' &&
  (terms.expiresAt === undefined ||
    terms.expiresAt === null ||
    canonicalTime(terms.expiresAt));
const sameTerms = (a, b) =>
  TEXT_FIELDS.every(([key]) => a[key] === b[key]) &&
  a.price === b.price &&
  a.priceUnits === b.priceUnits &&
  a.currency === b.currency &&
  (a.expiresAt ?? null) === (b.expiresAt ?? null);
/** Whether returned terms are what the service's normalize makes of submitted.
 * Text compares trimmed and price compares as exact base units, so a legitimate
 * normalization passes. Submitted terms the service would refuse never match. */
export function returnedTermsMatchRequest(returned, submitted) {
  try {
    if (
      !validTerms(returned) ||
      !object(submitted) ||
      !Object.keys(submitted).every((key) => Object.hasOwn(EMPTY_FORM, key)) ||
      !TEXT_FIELDS.every(
        ([key]) =>
          Object.hasOwn(submitted, key) &&
          typeof submitted[key] === 'string' &&
          !UNSUPPORTED_TEXT.test(submitted[key]),
      ) ||
      !Object.hasOwn(submitted, 'price') ||
      typeof submitted.price !== 'string'
    )
      return false;
    const expiresAt = submitted.expiresAt ?? null;
    if (expiresAt !== null && !canonicalTime(expiresAt)) return false;
    return (
      termsInputError({ ...submitted, expiresAt: expiresAt ?? '' }) === '' &&
      TEXT_FIELDS.every(([key]) => returned[key] === submitted[key].trim()) &&
      returned.priceUnits === unitsOf(submitted.price) &&
      (returned.expiresAt ?? null) === expiresAt
    );
  } catch {
    return false;
  }
}
const validSnapshot = (saved, enquiry) =>
  object(saved) &&
  saved.id === enquiry.id &&
  saved.kind === 'nonbinding-enquiry' &&
  saved.offerId === enquiry.offerId &&
  saved.buyer === enquiry.buyer &&
  saved.seller === enquiry.seller &&
  saved.message === enquiry.message &&
  saved.createdAt === enquiry.createdAt &&
  saved.binding === false &&
  saved.settlementAvailable === false &&
  object(saved.offer) &&
  saved.offer.title === enquiry.offer.title &&
  saved.offer.price === enquiry.offer.price &&
  saved.offer.priceUnits === enquiry.offer.priceUnits &&
  saved.offer.currency === 'AI$' &&
  saved.offer.revision === enquiry.offer.revision;
const validRecord = (row, kind, enquiry) =>
  object(row) &&
  row.kind === kind &&
  filled(row.id) &&
  row.enquiryId === enquiry.id &&
  filled(row.author) &&
  row.binding === false &&
  row.settlementAvailable === false &&
  validSnapshot(row.enquirySnapshot, enquiry) &&
  validTerms(row.terms);
const validDraft = (row, enquiry, address) =>
  validRecord(row, 'nonbinding-terms-draft', enquiry) &&
  row.author === address &&
  whole(row.revision, 1) &&
  (row.lastSentRevision === null ||
    (whole(row.lastSentRevision, 1) && row.lastSentRevision <= row.revision)) &&
  filled(row.createdAt) &&
  filled(row.updatedAt);
const validProposal = (row, enquiry) =>
  validRecord(row, 'nonbinding-terms-proposal', enquiry) &&
  (row.author === enquiry.buyer || row.author === enquiry.seller) &&
  filled(row.draftId) &&
  whole(row.draftRevision, 1) &&
  filled(row.sentAt);
function validatedList(raw, page, enquiry, address) {
  if (
    !object(raw) ||
    !Array.isArray(raw.drafts) ||
    !Array.isArray(raw.proposals) ||
    raw.drafts.length + raw.proposals.length > PAGE_SIZE ||
    !whole(raw.draftCount, raw.drafts.length) ||
    !whole(raw.proposalCount, raw.proposals.length) ||
    raw.page !== page ||
    raw.pageSize !== PAGE_SIZE ||
    !whole(raw.pages, 1) ||
    raw.pages > MAX_PAGE ||
    raw.pages !==
      Math.max(1, Math.ceil((raw.draftCount + raw.proposalCount) / PAGE_SIZE)) ||
    !raw.drafts.every((row) => validDraft(row, enquiry, address)) ||
    !raw.proposals.every((row) => validProposal(row, enquiry))
  )
    throw Error('Unexpected terms list.');
  return raw;
}
// Reading the property can itself throw, and there is no fallback store: a
// blocked session store must refuse work, never quietly weaken recovery.
function sessionRecovery() {
  try {
    return createTradeTermsRecovery(globalThis.sessionStorage);
  } catch {
    return createTradeTermsRecovery(null);
  }
}
// The same core fields the service snapshots. Only public strings: never the
// identity object or its keys.
const recoveryScopeOf = (identity, enquiry) => ({
  address: identity.address,
  publicKeyBase64: identity.publicKeyBase64,
  enquiry: {
    id: enquiry.id,
    kind: enquiry.kind,
    offerId: enquiry.offerId,
    buyer: enquiry.buyer,
    seller: enquiry.seller,
    message: enquiry.message,
    offer: {
      title: enquiry.offer.title,
      price: enquiry.offer.price,
      priceUnits: enquiry.offer.priceUnits,
      currency: enquiry.offer.currency,
      revision: enquiry.offer.revision,
    },
    createdAt: enquiry.createdAt,
    binding: enquiry.binding,
    settlementAvailable: enquiry.settlementAvailable,
  },
});
// Only reads. A restored request waits for its button, however often this runs.
function restore(scope) {
  try {
    const request = scope.recovery.read(scope.recoveryScope);
    scope.retained = request && { ...request, restored: true };
    scope.recoveryError = '';
  } catch (error) {
    scope.recoveryError = error.message;
  }
}
const blank = (scope) => ({
  generation: scope.generation,
  open: false,
  page: 1,
  listState: 'idle',
  list: null,
  listError: '',
  form: EMPTY_FORM,
  selected: null,
  dirty: false,
  superseded: false,
  reviewed: null,
  confirmed: false,
  pending: null,
  unresolved: scope.retained?.kind ?? null,
  status: '',
  actionError: '',
});
const clearBlockedText =
  'The service answered this request, but this browser could not clear its saved copy. Editing stays paused. Retry repeats the same request once session storage works.';
const unresolvedText = {
  create:
    'We could not confirm whether this draft was saved. Retry repeats the same request, so it cannot create a second draft. Editing is paused until it resolves.',
  update:
    'We could not confirm whether this draft revision was saved. Retry repeats the same request, so it cannot save twice. Editing is paused until it resolves.',
  send: 'We could not confirm whether this proposal was sent. Retry repeats the same request, so it cannot send twice. Editing is paused until it resolves.',
};
const pendingText = {
  create: 'Saving private draft…',
  update: 'Saving private draft…',
  send: 'Sending nonbinding proposal…',
};
function Pager({ data, busy, onPage }) {
  return data.pages > 1 || data.page > 1 ? (
    <div className="pagination">
      <button
        className="button"
        type="button"
        aria-label="Previous page of terms"
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
        aria-label="Next page of terms"
        disabled={busy || data.page >= Math.min(data.pages, MAX_PAGE)}
        onClick={() => onPage(data.page + 1)}
      >
        Next
      </button>
    </div>
  ) : null;
}
// The two prices are labelled apart everywhere, and both stay the exact strings
// the service returned for signing and comparison. Display only drops trailing
// fractional zeros ("1.100000" shows as "1.1"), the same exact quantity.
function Prices({ price, quote }) {
  return (
    <>
      <div className="request-main">
        <strong style={{ overflowWrap: 'anywhere' }}>
          {displayAmount(price)} <span>AI$</span>
        </strong>
        <span>Proposed price, nonbinding</span>
      </div>
      <p className="fine-print">
        Original enquiry quote: {displayAmount(quote.price)} AI$ · quoted revision{' '}
        {quote.revision}
      </p>
    </>
  );
}
function SavedTerms({ terms, quote }) {
  return (
    <>
      <Prices price={terms.price} quote={quote} />
      {TEXT_FIELDS.map(([key, label]) => (
        <div key={key}>
          <p>
            <strong>{label}</strong>
          </p>
          <p style={WRAP}>{terms[key]}</p>
        </div>
      ))}
      {terms.expiresAt && (
        <p className="fine-print">
          Informational end time: <code>{terms.expiresAt}</code>. Reaching this
          time changes nothing by itself.
        </p>
      )}
    </>
  );
}
export default function TradeTerms({ identity = null, enquiry = null }) {
  const address = identity?.address,
    available =
      typeof address === 'string' &&
      object(enquiry) &&
      filled(enquiry.id) &&
      object(enquiry.offer) &&
      enquiry.binding === false &&
      enquiry.settlementAvailable === false &&
      (address === enquiry.buyer || address === enquiry.seller);
  // Compared by value: the parent replaces row objects on every list read, and
  // that must not reset work on an unchanged enquiry.
  const recoveryScope = available ? recoveryScopeOf(identity, enquiry) : null,
    snapshot = recoveryScope ? JSON.stringify(recoveryScope) : '';
  // One context per identity object and exact enquiry. Replacing it discards the
  // intents and every older response. A retained request survives in session
  // storage for this same signer and enquiry, and only for them.
  const context = useRef(null),
    previous = context.current;
  if (
    !previous ||
    previous.identity !== identity ||
    previous.snapshot !== snapshot
  ) {
    context.current = {
      generation: (previous?.generation ?? 0) + 1,
      identity,
      snapshot,
      intents: new Map(),
      retained: null,
      page: 1,
      recovery: sessionRecovery(),
      recoveryScope,
      recoveryError: '',
      // Completed list reads, and the count at the last unresolved attempt:
      // a retained request may be released only after a newer list read.
      reads: 0,
      readsAtFailure: 0,
      lastCode: null,
    };
    if (recoveryScope) restore(context.current);
  }
  const scope = context.current;
  const [stored, setStored] = useState(() => blank(scope));
  // State from another context is never rendered, even before effects run.
  const view = stored.generation === scope.generation ? stored : blank(scope);
  const gate = useRef(null),
    operation = useRef(null),
    panelId = useId();
  if (!gate.current) gate.current = createIdentitySessionGate();
  const update = (patch) =>
    setStored((current) => {
      const base =
        current.generation === scope.generation ? current : blank(scope);
      return {
        ...base,
        ...(typeof patch === 'function' ? patch(base) : patch),
      };
    });
  // The ref refuses a second operation synchronously, whatever a closure saw.
  const claim = () => {
    if (operation.current?.isCurrent()) return null;
    const token = gate.current.begin();
    if (token) operation.current = token;
    return token;
  };
  const liveness = (token) => () =>
    token.isCurrent() && context.current === scope;
  useEffect(() => {
    gate.current.activate();
    operation.current = null;
    // Cleanup killed any running work, so its own finally can never publish. A
    // request that may have reached the service stays retained for exact retry.
    setStored((current) =>
      current.generation === scope.generation &&
      (current.listState === 'loading' || current.pending)
        ? {
            ...current,
            listState:
              current.listState === 'loading' ? 'idle' : current.listState,
            pending: null,
            unresolved: scope.retained?.kind ?? current.unresolved,
          }
        : current,
    );
    return () => gate.current.invalidate();
  }, [scope.generation]);
  const load = async (page, { status = '' } = {}) => {
    const token = claim();
    if (!token) return;
    const live = liveness(token);
    scope.page = page;
    update({
      page,
      listState: 'loading',
      list: null,
      listError: '',
      status,
      actionError: '',
    });
    try {
      const raw = await api(
        `/api/trade/enquiries/${encodeURIComponent(enquiry.id)}/terms?page=${page}&pageSize=${PAGE_SIZE}`,
        { identity },
      );
      if (!live()) return;
      const data = validatedList(raw, page, enquiry, address);
      operation.current = null;
      scope.reads += 1;
      update((current) => {
        const listed = data.drafts.find(
          (row) => row.id === current.selected?.id,
        );
        // Never rebase edits or a review onto a revision saved elsewhere.
        return {
          listState: 'ready',
          list: data,
          ...(listed && listed.revision !== current.selected.revision
            ? { superseded: true, reviewed: null, confirmed: false }
            : listed
              ? { selected: listed }
              : {}),
        };
      });
    } catch (error) {
      if (!live()) return;
      operation.current = null;
      update({
        listState: 'error',
        listError: message(
          error,
          'Terms are unavailable right now. Refresh to try again.',
        ),
      });
    }
  };
  // Only a validated acknowledgement or a definite refusal reaches this, and only
  // from a live token, so a stale response can never erase a saved request. If
  // the saved copy cannot be cleared the lock stays, because forgetting it here
  // would hide a record the next mount would still restore.
  const forget = (request) => {
    try {
      scope.recovery.clear(scope.recoveryScope, request.body.clientRequestId);
      scope.retained = null;
      return true;
    } catch {
      update({
        pending: null,
        unresolved: request.kind,
        actionError: clearBlockedText,
      });
      return false;
    }
  };
  const attempt = async (exact, token) => {
    const live = liveness(token),
      fresh = !scope.retained;
    let persisted = null;
    update({ pending: exact.kind, status: '', actionError: '' });
    try {
      // Throwing inside run keeps the intent for a stale or malformed success.
      const saved = await exact.action.run(async (body) => {
        if (!live()) throw Error('Stale terms response.');
        const request = {
          kind: exact.kind,
          draftId: exact.draftId,
          body,
          reviewedTerms: exact.reviewedTerms,
        };
        // Nothing leaves the browser until this exact request can outlive us.
        scope.recovery.write(scope.recoveryScope, request);
        persisted = request;
        scope.retained ??= request;
        scope.recoveryError = '';
        const raw = await api(exact.path, {
          identity,
          method: exact.method,
          body,
        });
        if (!live()) throw Error('Stale terms response.');
        return exact.receipt(raw);
      });
      if (!live()) return;
      operation.current = null;
      if (!forget(persisted)) return;
      scope.intents.delete(exact.key);
      exact.settle(saved);
    } catch (error) {
      if (!live()) return;
      operation.current = null;
      // The write refused before any HTTP. A fresh intent was never sent, so it
      // goes and editing continues. A retained one may already have been sent,
      // so it stays locked. Another request in the way is taken over, locked.
      if (!persisted) {
        if (fresh) scope.intents.delete(exact.key);
        if (error?.code === TRADE_TERMS_RECOVERY_CONFLICT) restore(scope);
        update({
          pending: null,
          unresolved: scope.retained?.kind ?? null,
          actionError: error.message,
        });
        return;
      }
      if (DEFINITE_TERMS_CODES.has(error?.code)) {
        if (!forget(persisted)) return;
        scope.intents.delete(exact.key);
        update((current) => ({
          pending: null,
          unresolved: null,
          reviewed: null,
          confirmed: false,
          actionError: message(error, ''),
          // The listed rows are stale too, so nothing old can be reopened.
          ...(error.code === 'terms_revision_changed'
            ? { superseded: true, listState: 'idle', list: null }
            : {}),
          ...(error.code === 'terms_version_already_sent' && current.selected
            ? {
                selected: {
                  ...current.selected,
                  lastSentRevision: current.selected.revision,
                },
              }
            : {}),
        }));
        return;
      }
      scope.lastCode = typeof error?.code === 'string' ? error.code : null;
      scope.readsAtFailure = scope.reads;
      update({
        pending: null,
        unresolved: exact.kind,
        actionError: message(
          error,
          'The service response could not be confirmed.',
        ),
      });
    }
  };
  const mutate = (request) => {
    const token = claim();
    if (!token) return;
    const exact = {
      ...request,
      ...routeFor({ ...request, body: request.fields }),
    };
    if (!scope.intents.has(exact.key))
      scope.intents.set(exact.key, createActionIntent());
    attempt(
      {
        ...exact,
        action: scope.intents.get(exact.key).prepare(request.fields, exact.key),
      },
      token,
    );
  };
  // Only ever repeats the retained request: same body, same clientRequestId.
  // The route is rebuilt here, so nothing from an older mount is held.
  const retry = () => {
    const retained = scope.retained;
    if (!retained) return;
    const token = claim();
    if (!token) return;
    attempt(
      {
        ...retained,
        ...routeFor(retained),
        action: { run: (send) => send(structuredClone(retained.body)) },
      },
      token,
    );
  };
  // An unrecognised error must not lock editing for good. After a fresh list
  // read the member may drop the retained copy; nothing is sent.
  const releasable = canReleaseRetainedTerms({
    retained: scope.retained,
    lastCode: scope.lastCode,
    readsAtFailure: scope.readsAtFailure,
    reads: scope.reads,
    pending: Boolean(view.pending) || view.listState === 'loading',
  });
  const release = () => {
    const retained = scope.retained;
    if (!releasable || !retained || operation.current?.isCurrent()) return;
    if (!forget(retained)) return;
    scope.intents.clear();
    scope.lastCode = null;
    update({
      pending: null,
      unresolved: null,
      reviewed: null,
      confirmed: false,
      actionError: '',
      status:
        'The retained request was released. If it did reach the service, it appears in the list above. Nothing was sent.',
    });
  };
  const settleDraft = (draft) => {
    update({
      form: formFrom(draft.terms),
      selected: draft,
      dirty: false,
      superseded: false,
      reviewed: null,
      confirmed: false,
      pending: null,
      unresolved: null,
    });
    load(scope.page, {
      status: `Private draft saved as revision ${draft.revision}. Only you can see it.`,
    });
  };
  // Everything needed to send or settle a request, from its serializable fields.
  const routeFor = ({ kind, draftId, body, reviewedTerms }) => {
    if (kind === 'create')
      return {
        key: `create:${enquiry.id}`,
        path: `/api/trade/enquiries/${encodeURIComponent(enquiry.id)}/terms`,
        method: 'POST',
        receipt: (raw) => {
          if (
            !validDraft(raw?.draft, enquiry, address) ||
            raw.draft.revision !== 1 ||
            raw.draft.lastSentRevision !== null ||
            !returnedTermsMatchRequest(raw.draft.terms, body.terms)
          )
            throw Error('Unexpected draft receipt.');
          return raw.draft;
        },
        settle: settleDraft,
      };
    const id = draftId,
      expectedRevision = body.expectedRevision;
    if (kind === 'update')
      return {
        key: `update:${id}:${expectedRevision}`,
        path: `/api/trade/terms/${encodeURIComponent(id)}`,
        method: 'PATCH',
        receipt: (raw) => {
          if (
            !validDraft(raw?.draft, enquiry, address) ||
            raw.draft.id !== id ||
            raw.draft.revision !== expectedRevision + 1 ||
            !returnedTermsMatchRequest(raw.draft.terms, body.terms)
          )
            throw Error('Unexpected draft receipt.');
          return raw.draft;
        },
        settle: settleDraft,
      };
    return {
      key: `send:${id}:${expectedRevision}`,
      path: `/api/trade/terms/${encodeURIComponent(id)}/send`,
      method: 'POST',
      receipt: (raw) => {
        if (
          !validProposal(raw?.proposal, enquiry) ||
          raw.proposal.author !== address ||
          raw.proposal.draftId !== id ||
          raw.proposal.draftRevision !== expectedRevision ||
          !sameTerms(raw.proposal.terms, reviewedTerms)
        )
          throw Error('Unexpected proposal receipt.');
        return raw.proposal;
      },
      settle: () => {
        update({
          form: EMPTY_FORM,
          selected: null,
          dirty: false,
          superseded: false,
          reviewed: null,
          confirmed: false,
          pending: null,
          unresolved: null,
        });
        load(scope.page, {
          status:
            'Nonbinding proposal sent. It cannot be edited. No funds moved.',
        });
      },
    };
  };
  const toggle = () => {
    if (view.open) {
      if (scope.retained) return;
      // Saved state stays; the read still running must not publish after this.
      gate.current.invalidate();
      gate.current.activate();
      operation.current = null;
      update((current) => ({
        open: false,
        listState: current.listState === 'loading' ? 'idle' : current.listState,
      }));
      return;
    }
    update({ open: true });
    load(view.page);
  };
  const change = (key, value) => {
    if (scope.retained) return;
    update((current) => ({
      form: { ...current.form, [key]: value },
      dirty: true,
      reviewed: null,
      confirmed: false,
      status: '',
      actionError: '',
    }));
  };
  const reset = (selected, form, superseded = false) =>
    update({
      selected,
      form,
      dirty: false,
      superseded,
      reviewed: null,
      confirmed: false,
      status: '',
      actionError: '',
    });
  const choose = (draft) => {
    if (!scope.retained) reset(draft, formFrom(draft.terms));
  };
  const startNew = () => {
    if (!scope.retained) reset(null, EMPTY_FORM);
  };
  const discard = () => {
    if (scope.retained) return;
    reset(
      view.selected,
      view.selected ? formFrom(view.selected.terms) : EMPTY_FORM,
      view.superseded,
    );
  };
  const locked = view.pending !== null || view.unresolved !== null,
    busy = locked || view.listState === 'loading',
    ready = view.listState === 'ready',
    selected = view.selected,
    canSave = ready && !locked && view.dirty && !view.superseded,
    alreadySent = !!selected && selected.lastSentRevision === selected.revision,
    canReview =
      ready &&
      !locked &&
      !!selected &&
      !view.dirty &&
      !view.superseded &&
      !alreadySent,
    isReviewed =
      canReview &&
      view.reviewed?.id === selected.id &&
      view.reviewed.revision === selected.revision;
  const save = (e) => {
    e.preventDefault();
    if (!canSave) return;
    const problem = termsInputError(view.form);
    if (problem) {
      update({ actionError: problem, status: '' });
      return;
    }
    const terms = termsFrom(view.form);
    if (!selected) {
      mutate({
        kind: 'create',
        draftId: null,
        fields: { terms },
        reviewedTerms: null,
      });
      return;
    }
    mutate({
      kind: 'update',
      draftId: selected.id,
      fields: { expectedRevision: selected.revision, terms },
      reviewedTerms: null,
    });
  };
  const review = () => {
    if (canReview)
      update({
        reviewed: {
          id: selected.id,
          revision: selected.revision,
          terms: selected.terms,
        },
        confirmed: false,
        status: '',
        actionError: '',
      });
  };
  const send = () => {
    if (!isReviewed || !view.confirmed) return;
    mutate({
      kind: 'send',
      draftId: selected.id,
      fields: {
        expectedRevision: selected.revision,
        confirmNonbinding: true,
      },
      reviewedTerms: view.reviewed.terms,
    });
  };
  if (!available)
    return (
      <p className="fine-print">
        Terms are available only to the two participants in this enquiry.
      </p>
    );
  const quote = enquiry.offer,
    counterparty = address === enquiry.buyer ? enquiry.seller : enquiry.buyer,
    list = view.list;
  return (
    <>
      <button
        className="button"
        type="button"
        aria-expanded={view.open}
        aria-controls={panelId}
        disabled={view.open && locked}
        onClick={toggle}
      >
        {view.open ? 'Hide terms' : 'Propose terms'}
      </button>
      <div id={panelId} hidden={!view.open}>
        {view.open && (
          <>
            <div className="status-note standalone" style={{ marginTop: 16 }}>
              <p>
                Terms here are a nonbinding proposal only. They move no money,
                reserve no funds, settle nothing and create no commitment.
              </p>
            </div>
            <div className="meetings-actions">
              <button
                className="button small"
                type="button"
                disabled={busy}
                onClick={() => load(view.page)}
              >
                Refresh terms
              </button>
            </div>
            {view.listState === 'loading' && (
              <p role="status" aria-live="polite">
                Loading terms…
              </p>
            )}
            {view.listState === 'error' && (
              <p role="alert" aria-live="assertive" className="form-error">
                {view.listError}
              </p>
            )}
            {scope.recoveryError && (
              <p role="alert" aria-live="assertive" className="form-error">
                {scope.recoveryError}
              </p>
            )}
            {list && (
              <>
                <h4>
                  Sent nonbinding proposals{' '}
                  <span className="count">{list.proposalCount}</span>
                </h4>
                <p className="fine-print">
                  Visible to you and the other participant. Sent records cannot
                  be edited.
                </p>
                {list.proposals.map((row) => (
                  <article key={row.id}>
                    <p>
                      <strong>
                        Sent by{' '}
                        {row.author === address ? 'you' : short(row.author)}
                      </strong>{' '}
                      <small>
                        {date(row.sentAt)} · from draft revision{' '}
                        {row.draftRevision}
                      </small>
                    </p>
                    <SavedTerms
                      terms={row.terms}
                      quote={row.enquirySnapshot.offer}
                    />
                  </article>
                ))}
                {list.proposals.length === 0 && (
                  <p>
                    {list.proposalCount === 0
                      ? 'No proposals sent yet.'
                      : 'No proposals on this page.'}
                  </p>
                )}
                <h4>
                  Your private drafts{' '}
                  <span className="count">{list.draftCount}</span>
                </h4>
                {list.drafts.map((row) => (
                  <article key={row.id}>
                    <p>
                      <strong>Revision {row.revision}</strong>{' '}
                      <small>
                        Saved {date(row.updatedAt)}
                        {row.lastSentRevision === row.revision &&
                          ' · already sent'}
                      </small>
                    </p>
                    <Prices
                      price={row.terms.price}
                      quote={row.enquirySnapshot.offer}
                    />
                    <div className="meetings-actions">
                      <button
                        className="button small"
                        type="button"
                        aria-label={`Open draft revision ${row.revision}`}
                        disabled={
                          busy ||
                          view.dirty ||
                          (selected?.id === row.id &&
                            selected.revision === row.revision)
                        }
                        onClick={() => choose(row)}
                      >
                        {selected?.id === row.id &&
                        selected.revision === row.revision
                          ? 'Open'
                          : 'Open draft'}
                      </button>
                    </div>
                  </article>
                ))}
                {list.drafts.length === 0 && (
                  <p>
                    {list.draftCount === 0
                      ? 'No private drafts yet.'
                      : 'No drafts on this page.'}
                  </p>
                )}
                {view.dirty && list.drafts.length > 0 && (
                  <p className="fine-print">
                    Save or discard your edits before opening another draft.
                  </p>
                )}
                <Pager data={list} busy={busy} onPage={load} />
              </>
            )}
            <h4>
              {selected
                ? `Edit private draft, revision ${selected.revision}`
                : 'New private draft'}
            </h4>
            <p className="fine-print">
              Original enquiry quote: {displayAmount(quote.price)} AI$ · quoted revision{' '}
              {quote.revision}. Only you can see a draft until you send it.
            </p>
            <form onSubmit={save}>
              {TEXT_FIELDS.map(([key, label, max, rows]) => (
                <label className="field" key={key}>
                  {label}
                  <span>
                    {bytes(view.form[key])} of {max} bytes
                  </span>
                  <textarea
                    value={view.form[key]}
                    required
                    rows={rows}
                    disabled={locked}
                    onChange={(e) => change(key, e.target.value)}
                  />
                </label>
              ))}
              <label className="field">
                Proposed price in AI$
                <input
                  value={view.form.price}
                  required
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={locked}
                  onChange={(e) => change('price', e.target.value)}
                />
              </label>
              <label className="field">
                Informational end time, optional
                <input
                  value={view.form.expiresAt}
                  placeholder="2026-12-31T17:00:00.000Z"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={locked}
                  onChange={(e) => change('expiresAt', e.target.value)}
                />
              </label>
              <p className="fine-print">
                Use an exact UTC ISO time. It is for information only: reaching
                it changes nothing by itself.
              </p>
              <div className="meetings-actions" style={{ marginTop: 16 }}>
                <button className="button ink" disabled={!canSave}>
                  {view.pending === 'create' || view.pending === 'update'
                    ? 'Saving…'
                    : 'Save private draft'}
                </button>
                {view.dirty && (
                  <button
                    className="button"
                    type="button"
                    disabled={locked}
                    onClick={discard}
                  >
                    Discard edits
                  </button>
                )}
                {selected && (
                  <button
                    className="button"
                    type="button"
                    disabled={locked || view.dirty}
                    onClick={startNew}
                  >
                    Start a new draft
                  </button>
                )}
              </div>
            </form>
            {view.superseded && (
              <p role="status" aria-live="polite">
                A newer revision of this draft was saved elsewhere. Refresh
                terms, discard any edits and open the newer revision to
                continue.
              </p>
            )}
            {alreadySent && !view.dirty && (
              <p className="fine-print">
                Revision {selected.revision} was already sent and cannot be sent
                again. Edit and save a new revision to send different terms.
              </p>
            )}
            {selected && view.dirty && (
              <p className="fine-print">
                Save these edits as a new revision before reviewing them.
              </p>
            )}
            {selected && !view.dirty && !isReviewed && (
              <div className="meetings-actions" style={{ marginTop: 16 }}>
                <button
                  className="button"
                  type="button"
                  disabled={!canReview}
                  onClick={review}
                >
                  Review saved revision {selected.revision}
                </button>
              </div>
            )}
            {isReviewed && (
              <>
                <h4>Review saved revision {selected.revision}</h4>
                <p className="fine-print">
                  This is exactly what the other participant,{' '}
                  <code title={counterparty}>{short(counterparty)}</code>, will
                  receive.
                </p>
                <SavedTerms
                  terms={view.reviewed.terms}
                  quote={selected.enquirySnapshot.offer}
                />
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={view.confirmed}
                    disabled={locked}
                    onChange={(e) => update({ confirmed: e.target.checked })}
                  />
                  <span>
                    Send revision {selected.revision} as a nonbinding proposal.
                    I understand it cannot be edited afterwards, moves no money
                    and creates no commitment.
                  </span>
                </label>
                <button
                  className="button ink"
                  type="button"
                  disabled={!view.confirmed || locked}
                  onClick={send}
                >
                  {view.pending === 'send'
                    ? 'Sending…'
                    : 'Send nonbinding proposal'}
                </button>
              </>
            )}
            {view.pending && (
              <p role="status" aria-live="polite">
                {pendingText[view.pending]}
              </p>
            )}
            {view.actionError && (
              <p role="alert" aria-live="assertive" className="form-error">
                {view.actionError}
              </p>
            )}
            {view.unresolved && !view.pending && (
              <>
                {scope.retained?.restored && (
                  <p role="status" aria-live="polite">
                    <strong>A previous request needs an exact retry</strong>
                  </p>
                )}
                <p role="status" aria-live="polite">
                  {unresolvedText[view.unresolved]}
                </p>
                <button
                  className="button ink"
                  type="button"
                  disabled={view.listState === 'loading'}
                  onClick={retry}
                >
                  Retry the same request
                </button>
                {releasable ? (
                  <button className="button" type="button" onClick={release}>
                    Release and edit again
                  </button>
                ) : (
                  <button
                    className="button"
                    type="button"
                    disabled={view.listState === 'loading'}
                    onClick={() => load(scope.page)}
                  >
                    Check saved terms
                  </button>
                )}
                <p className="fine-print">
                  If retrying keeps failing, check the saved terms list first. You can
                  then release this request and edit again; nothing is sent.
                </p>
              </>
            )}
            {view.status && (
              <p role="status" aria-live="polite">
                {view.status}
              </p>
            )}
          </>
        )}
      </div>
    </>
  );
}

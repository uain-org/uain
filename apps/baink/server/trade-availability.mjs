// Trade availability: the one answer to "may this Trade step run now?" (P0-4, 12 November 2026).
//
// Rahul ruled on 11 November 2026 that Trade is paused for new business: no new
// listings, enquiries, terms or deals, while every deal already agreed, paid or
// in dispute can still be finished. One setting (BAINK_TRADE_MODE) turns new
// business back on. Every entry point asks this module: the HTTP routes, the
// payment-start checks for requests that carry a `trade` field, the remote MCP
// (tool list, instructions, guide), the web menu (through /api/config) and the
// public policy read. No route decides for itself.
//
// Reads are never refused (K-38: everything on the platform is public, and
// members need their history). Nothing here cancels, deletes, expires or
// replays anything: an unsigned deal is left to the existing sweep, and money
// that is already moving keeps moving.

export const TRADE_MODES = Object.freeze(['open', 'paused']);
export const TRADE_PAUSED = 'trade_paused';
/** The setting, read once at start (server/index.mjs). */
export const TRADE_MODE_SETTING = 'BAINK_TRADE_MODE';

/**
 * The mode from the setting. Missing, empty or unknown means paused: a typo or
 * a lost line in the environment file can never silently reopen Trade. Only the
 * exact word "open" opens it.
 */
export function resolveTradeMode(value) {
  if (value === 'open' || value === 'paused') return { mode: value, setting: 'set' };
  if (value === undefined || value === null || value === '') return { mode: 'paused', setting: 'default' };
  return { mode: 'paused', setting: 'invalid' };
}

// Every Trade write the server knows, by name. A name outside this list is a
// programming error (thrown, never allowed by default).
//   new: starts new business; refused while paused.
//   deal: allowed unless the deal it touches is still only proposed (unsigned).
//   payment: allowed unless the request is a terms payment request with no deal.
//   finish: allowed in both modes.
const OPERATIONS = Object.freeze({
  'offer.create': 'new',
  'offer.update': 'new',
  'offer.withdraw': 'finish',
  'enquiry.create': 'new',
  'terms.create': 'new',
  'terms.update': 'new',
  'terms.send': 'new',
  'terms.payment-request': 'new',
  'deal.create': 'new',
  'deal.accept': 'deal',
  'deal.cancel': 'finish',
  'milestone.deliver': 'finish',
  'milestone.confirm': 'finish',
  'milestone.reject': 'finish',
  'deal.refund': 'finish',
  'deal.rate': 'finish',
  'dispute.open': 'finish',
  'dispute.evidence': 'finish',
  'dispute.appeal': 'finish',
  'steward.decision': 'finish',
  'steward.action': 'finish',
  'appeal.decision': 'finish',
  'request.pay': 'payment',
  'request.decline': 'finish',
  'request.cancel': 'finish',
  'payment.start': 'payment',
});
export const TRADE_OPERATIONS = Object.freeze(Object.keys(OPERATIONS));

const WHAT = {
  'offer.create': 'no new listing was created',
  'offer.update': 'the listing was not changed',
  'enquiry.create': 'no enquiry was sent',
  'terms.create': 'no terms were drafted',
  'terms.update': 'the terms were not changed',
  'terms.send': 'the terms were not sent',
  'terms.payment-request': 'no payment request was made',
  'deal.create': 'no deal was created',
};
const FINISH_NEXT = 'Deals already agreed, paid or in dispute can still be finished (node uain-agent.mjs next shows any step waiting on you); to earn AI$ now, take a paid task (node uain-agent.mjs tasks). Do not send this step again.';
const message = (what) => `Trade is paused for new business, so ${what}. Nothing was created or charged.`;

export class TradePausedError extends Error {
  constructor(operation, text, next) {
    super(text);
    this.name = 'TradePausedError';
    this.status = 409;
    this.code = TRADE_PAUSED;
    this.next = next;
    this.operation = operation;
  }
}

/** A Trade payment request made from terms alone, with no signed deal behind it. */
const termsOnlyRequest = (request) => Boolean(request && Object.hasOwn(request, 'trade') && request.trade?.schema !== 'baink-trade-deal-payment-v1');

export function createTradeAvailability({ mode: input, setting } = {}) {
  const resolved = TRADE_MODES.includes(input) ? { mode: input, setting: setting ?? 'set' } : resolveTradeMode(input);
  const mode = resolved.mode;
  const paused = mode === 'paused';

  /** {allowed: true} or {allowed: false, code, message, next} for one operation and the state it touches. */
  function decide(operation, { deal = null, request = null } = {}) {
    const kind = OPERATIONS[operation];
    if (!kind) throw new TypeError(`Unknown Trade operation: ${operation}`);
    if (!paused || kind === 'finish') return { allowed: true };
    if (kind === 'new') return { allowed: false, code: TRADE_PAUSED, message: message(WHAT[operation]), next: FINISH_NEXT };
    if (kind === 'deal') {
      // Only an unsigned deal is new business; any other state is left to the deal's own rules.
      if (deal?.status !== 'proposed') return { allowed: true };
      return { allowed: false, code: TRADE_PAUSED, message: 'Trade is paused for new business, so this unsigned deal cannot be signed now. It expires on its own and no money moves.', next: 'If you no longer want it, cancel it (trade-act deal_cancel); otherwise there is nothing to do. Do not send this step again.' };
    }
    // kind === 'payment': a request with no Trade link is never Trade's business.
    if (!termsOnlyRequest(request)) return { allowed: true };
    return { allowed: false, code: TRADE_PAUSED, message: 'Trade is paused for new business, so this payment request for Trade terms cannot be paid now. Nothing was charged.', next: 'Ask the seller to decline or cancel the request. Payments for deals already agreed still work (node uain-agent.mjs next). Do not send this step again.' };
  }
  function assert(operation, state) {
    const d = decide(operation, state);
    if (!d.allowed) throw new TradePausedError(operation, d.message, d.next);
  }
  /** What clients see: in /api/config, /api/trade/policy and the remote MCP. */
  function view() {
    return {
      schema: 'baink-trade-availability-v1',
      mode,
      newBusiness: !paused,
      ...(paused ? {
        note: 'Trade is paused for new business: new listings, enquiries, terms, terms payment requests and deals are refused, and an unsigned deal cannot be signed. Deals already agreed, paid or in dispute can still be finished, listings can be withdrawn, and everything stays readable.',
        refused: TRADE_OPERATIONS.filter((op) => OPERATIONS[op] === 'new'),
        refusedWhen: { 'deal.accept': 'the deal is still proposed (unsigned)', 'request.pay': 'the request is for terms with no signed deal', 'payment.start': 'the request is for terms with no signed deal' },
        refusalCode: TRADE_PAUSED,
      } : {}),
      ...(resolved.setting === 'invalid' ? { settingInvalid: true } : {}),
    };
  }
  return Object.freeze({ mode, paused, setting: resolved.setting, decide, assert, view });
}

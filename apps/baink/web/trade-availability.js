// Trade in the menu while BAINK pauses it for new business (P0-4, 12 November 2026).
// The server owns the decision (/api/config `trade`, from server/trade-availability.mjs);
// this file only decides what the menu shows. A member with no open deal no longer
// sees Trade in the menu; a member with one keeps a way in, with a short notice, and a
// direct ?view=trade link always opens and explains.

/** Deal states a member may still have a step in. */
export const OPEN_DEAL_STATES = Object.freeze(['proposed', 'agreed', 'paid', 'disputed', 'refunded']);
export const TRADE_PAUSED_NOTICE =
  'Trade is paused for new business: new listings, enquiries, terms and deals are not accepted. Deals already agreed, paid or in dispute can still be finished here, and every listing and deal stays readable.';

/** Paused unless the server says new business is open; an unread config shows no Trade entry. */
export const tradePaused = (config) => config?.trade?.newBusiness !== true;

/**
 * The sentence to show in place of a new-business control (12 November 2026): the server's
 * own `note` from the availability read (/api/config `trade`), or this file's notice when the
 * read has none. Null when Trade is open, so every control comes back on its own.
 */
export function tradePauseSentence(config) {
  if (!tradePaused(config)) return null;
  const note = config?.trade?.note;
  return typeof note === 'string' && note.trim() ? note.trim() : TRADE_PAUSED_NOTICE;
}

/**
 * The Overview's Trade shortcut. Open: the usual "Offer or find services" button. Paused: the
 * pause sentence instead, since the server refuses new listings, enquiries and deals; a member
 * with an open deal also gets a way in to finish it.
 */
export function tradeShortcut(config, { openDeal = false } = {}) {
  const sentence = tradePauseSentence(config);
  if (!sentence) return { kind: 'shortcut', tab: 'Trade', label: 'Offer or find services' };
  return { kind: 'paused', text: sentence, ...(openDeal ? { tab: 'Trade', label: 'Finish your open deal' } : {}) };
}

export const hasOpenDeal = (deals, address) =>
  Array.isArray(deals) &&
  deals.some((d) => (d?.seller === address || d?.buyer === address) && OPEN_DEAL_STATES.includes(d?.status));

/** The sidebar groups with Trade removed when it is paused and the member has no open deal. */
export function tradeNavigation(navigation, { paused, openDeal }) {
  if (!paused || openDeal) return navigation;
  return navigation
    .map(([name, icon, tabs]) => (tabs.includes('Trade') ? [name === 'Network & Trade' ? 'Network' : name, icon, tabs.filter((t) => t !== 'Trade')] : [name, icon, tabs]))
    .filter(([, , tabs]) => tabs.length > 0);
}

/** Reads the member's deals once (public, K-38) to know whether Trade stays in the menu. */
export async function readOpenDeal(read, address) {
  try {
    const data = await read(`/api/trade/deals?member=${encodeURIComponent(address)}&pageSize=50`);
    return hasOpenDeal(data?.deals, address);
  } catch {
    // Unreadable: keep the way in, so a member with an open deal is never cut off.
    return true;
  }
}

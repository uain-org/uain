/** First-party, tab-session attribution, expires after 24 hours. */
const KEY = 'uain.campaign.ref';
export const validRef = (ref: unknown): ref is string => typeof ref === 'string' && /^[A-Za-z0-9_-]{12,80}$/.test(ref);
export function campaignRef(): { ref: string; isTest: boolean } | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const current = params.get('ref');
  if (validRef(current)) {
    const value = {ref:current,isTest:params.get('campaign_test')==='1',expires:Date.now()+86400000};
    try { sessionStorage.setItem(KEY,JSON.stringify(value)); } catch { /* Storage can be disabled. */ }
    return value;
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (saved && validRef(saved.ref) && saved.expires > Date.now() && typeof saved.isTest==='boolean') return saved;
    sessionStorage.removeItem(KEY);
  } catch { /* Ignore unavailable or malformed storage. */ }
  return null;
}

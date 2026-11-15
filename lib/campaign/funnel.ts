/** Anonymous on-page funnel counts: one request per stage, tab and day, no visitor identifier. */
import { campaignRef } from '@/lib/campaign/ref';
import { apiBase } from '@/lib/network/api-base';

/** Visitors without a campaign ref share one aggregate bucket. */
export const ORGANIC_REF = 'organic-visitor';

export function countStage(stage: string) {
  const captured = campaignRef();
  const ref = captured?.ref ?? ORGANIC_REF;
  const isTest = captured?.isTest ?? false;
  const marker = `uain.campaign.funnel.${ref}.${stage}.${new Date().toISOString().slice(0, 10)}`;
  try {
    if (sessionStorage.getItem(marker)) return;
    sessionStorage.setItem(marker, '1');
  } catch { /* Storage can be disabled; count anyway. */ }
  // A blocked analytics request must never interrupt the page.
  void fetch(`${apiBase()}/api/campaign/visit`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref, stage, is_test: isTest }), keepalive: true,
  }).catch(() => undefined);
}

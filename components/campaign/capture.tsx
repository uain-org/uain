'use client';
import { useEffect } from 'react';
import { campaignRef } from '@/lib/campaign/ref';
import { apiBase } from '@/lib/network/api-base';
import { countStage } from '@/lib/campaign/funnel';

/** Counts the page view, clicks on `data-funnel` links and reaching `#faq`, for every visitor. */
function useFunnel(page: 'for_ai' | 'try') {
  useEffect(() => {
    countStage(`view_${page}`);
    const onClick = (event: MouseEvent) => {
      const stage = (event.target as Element | null)?.closest<HTMLElement>('[data-funnel]')?.dataset.funnel;
      if (stage) countStage(stage);
    };
    document.addEventListener('click', onClick);
    const faq = document.getElementById('faq');
    const observer = faq && 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { countStage('reached_faq'); observer?.disconnect(); }
    }) : null;
    if (faq) observer?.observe(faq);
    return () => { document.removeEventListener('click', onClick); observer?.disconnect(); };
  }, [page]);
}

export function CampaignCapture({ page = 'for_ai' }: { page?: 'for_ai' | 'try' }) {
  useFunnel(page);
  useEffect(() => {
    const captured = campaignRef();
    if (!captured) return;
    const {ref,isTest} = captured;
    // Request counts, not unique visitors. StrictMode/session revisits are
    // deduplicated in this tab; no cross-site or persistent visitor identifier.
    const marker = `uain.campaign.landing.${ref}.${new Date().toISOString().slice(0,10)}`;
    let recorded = false;
    try { recorded = ['1','pending'].includes(sessionStorage.getItem(marker) || ''); } catch { /* optional */ }
    if (!recorded) {
      try { sessionStorage.setItem(marker,'pending'); } catch { /* optional */ }
      const retry = () => { try { sessionStorage.removeItem(marker); } catch { /* optional */ } };
      void fetch(`${apiBase()}/api/campaign/visit`, {method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({ref,stage:'landing',is_test:isTest}),keepalive:true}).then(r => {
        if (r.ok) { try { sessionStorage.setItem(marker,'1'); } catch { /* optional */ } }
        else retry();
      }).catch(retry);
    }
    const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href="/access-guide.md"]')];
    // Keep the guide's direct URL. A blocked analytics request must never
    // interrupt onboarding, including in browsers that restrict redirects.
    const countInstruction = () => {
      void fetch(`${apiBase()}/api/campaign/instructions?ref=${encodeURIComponent(ref)}${isTest?'&test=1':''}`,
        {keepalive:true,redirect:'manual'}).catch(() => undefined);
    };
    for (const link of links) link.addEventListener('click',countInstruction);
    return () => { for (const link of links) link.removeEventListener('click',countInstruction); };
  }, []);
  return null;
}

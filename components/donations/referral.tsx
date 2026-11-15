'use client';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
const COOKIE = 'uain_referral';
export function readReferral(): Record<string, string> {
  try {
    const value = document.cookie
      .split('; ')
      .find((x) => x.startsWith(COOKIE + '='))
      ?.slice(COOKIE.length + 1);
    const parsed: unknown = value ? JSON.parse(decodeURIComponent(value)) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => typeof value === 'string'),
    );
  } catch {
    return {};
  }
}
export function captureReferral() {
  const query = new URLSearchParams(location.search);
  const prior = readReferral();
  // First referring system wins for 30 days. It is attribution, never authority.
  if (prior.referred_by) return;
  const id = query.get('referred_by');
  const validId = id && /^[a-zA-Z0-9_-]{1,100}$/.test(id) ? id : null;
  // An earlier campaign without a system must not hide the first system referral.
  if ((prior.utm_source || prior.source) && !validId) return;
  const next: Record<string, string> = {
    landing_path: location.pathname.slice(0, 200),
    ...prior,
  };
  if (validId) {
    next.referred_by = validId;
    next.referral_landing_path = location.pathname.slice(0, 200);
  }
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign']) {
    const v = query.get(key);
    if (v && !next[key]) next[key] = v.slice(0, 200);
  }
  if (document.referrer && !next.source) {
    try {
      const u = new URL(document.referrer);
      if (u.origin !== location.origin) next.source = u.hostname;
    } catch {}
  }
  if (!next.referred_by && !next.utm_source && !next.source) return;
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie =
    COOKIE +
    '=' +
    encodeURIComponent(JSON.stringify(next)) +
    '; Path=/; Max-Age=2592000; SameSite=Lax' +
    secure;
}
export function ReferralCapture() {
  const pathname = usePathname();
  useEffect(() => {
    captureReferral();
  }, [pathname]);
  return null;
}

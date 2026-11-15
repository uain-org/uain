/**
 * Where the pilot's HTTP API lives.
 *
 * Production nginx and the development server both proxy /api, so the browser
 * uses its current origin on every port. Development defaults to the live
 * production API; UAIN_DEV_API selects a different backend in vite.config.ts.
 *
 * Its own module so the shared feed can use it without importing live.ts,
 * which imports the feed back.
 */
export function apiBase() {
  if (typeof window === 'undefined') return '';
  const configured = process.env.NEXT_PUBLIC_UAIN_API;
  if (configured) return configured.replace(/\/$/, '');
  return '';
}

const ADDRESS = /^uain1[a-f0-9]{40}$/;
const TABS = new Map([
  ['dashboard', 'Dashboard'],
  ['mine', 'Mine money'],
  ['trade', 'Trade'],
  ['profile', 'Profile'],
  ['send', 'Send money'],
  ['request', 'Request money'],
  ['incoming', 'Incoming requests'],
  ['transactions', 'Transactions'],
  ['security', 'Security'],
  ['settings', 'Settings'],
  ['meetings', 'Meetings'],
]);
function route(
  view = 'dashboard',
  member = null,
  { explicit = false, invalid = false, provider = null } = {},
) {
  return Object.freeze({
    view,
    tab: TABS.get(view),
    member,
    provider,
    explicit,
    invalid,
    publicProfile: view === 'profile' && member !== null,
  });
}
const fallback = () => route('dashboard', null, { invalid: true });
function validTargets(view, member, provider) {
  return (
    TABS.has(view) &&
    (member == null ||
      (view === 'profile' &&
        typeof member === 'string' &&
        ADDRESS.test(member))) &&
    (provider == null ||
      (view === 'trade' &&
        typeof provider === 'string' &&
        ADDRESS.test(provider)))
  );
}
export function parseWorkspaceRoute(search = '') {
  if (typeof search !== 'string' || search.length > 2048) return fallback();
  const query = new URLSearchParams(search);
  if (
    ['view', 'member', 'provider'].some((key) => query.getAll(key).length > 1)
  )
    return fallback();
  const view = query.get('view'),
    member = query.get('member'),
    provider = query.get('provider');
  if (view === null)
    return member === null && provider === null ? route() : fallback();
  if (!validTargets(view, member, provider)) return fallback();
  return route(view, member, { explicit: true, provider });
}
export function routeForTab(tab, member = null, provider = null) {
  const view = [...TABS].find(([, label]) => label === tab)?.[0];
  if (!validTargets(view, member, provider)) return fallback();
  return route(view, member, { explicit: true, provider });
}
export function resolveWorkspaceRoute(
  intent,
  { isNew = false, memberStatus } = {},
) {
  if (intent?.invalid) return routeForTab('Dashboard');
  if (intent?.explicit) {
    if (!validTargets(intent.view, intent.member, intent.provider))
      return routeForTab('Dashboard');
    return route(intent.view, intent.member ?? null, {
      explicit: true,
      provider: intent.provider ?? null,
    });
  }
  // Everyone lands on the Overview, which answers "what can I do now?" and
  // leads a new member to Join UAIN (plain-language pass, 10 Nov 2026).
  void isNew;
  void memberStatus;
  return routeForTab('Dashboard');
}
export function workspaceUrl(base, intent) {
  const url = new URL(base);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new TypeError('A public HTTP(S) page location is required.');
  const safe = resolveWorkspaceRoute({ ...intent, explicit: true });
  url.search = '';
  url.hash = '';
  url.searchParams.set('view', safe.view);
  if (safe.member) url.searchParams.set('member', safe.member);
  if (safe.provider) url.searchParams.set('provider', safe.provider);
  return url.href;
}
export function publicProfileUrl(base, address) {
  if (typeof address !== 'string' || !ADDRESS.test(address))
    throw new TypeError('A complete public UAIN address is required.');
  return workspaceUrl(base, routeForTab('Profile', address));
}

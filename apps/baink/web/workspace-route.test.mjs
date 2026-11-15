import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWorkspaceRoute,
  resolveWorkspaceRoute,
  routeForTab,
  workspaceUrl,
  publicProfileUrl,
} from './workspace-route.js';
const member = 'uain1' + 'a'.repeat(40);
test('public profile URLs select one complete existing public address without a new identifier', () => {
  const route = parseWorkspaceRoute(`?view=profile&member=${member}`);
  assert.equal(route.tab, 'Profile');
  assert.equal(route.member, member);
  assert.equal(route.publicProfile, true);
  assert.equal(route.explicit, true);
  for (const bad of [
    'uain1' + 'a'.repeat(39),
    member + 'a',
    'UAIN1' + 'a'.repeat(40),
    member + '&other=x',
    '__proto__',
    'https://elsewhere.test',
  ])
    assert.equal(
      parseWorkspaceRoute('?view=profile&member=' + encodeURIComponent(bad))
        .tab,
      'Dashboard',
    );
});
test('only exact allowlisted workspace choices survive login; with no choice everyone lands on the Overview', () => {
  for (const [view, tab] of [
    ['trade', 'Trade'],
    ['mine', 'Mine money'],
    ['profile', 'Profile'],
    ['incoming', 'Incoming requests'],
    ['security', 'Security'],
  ]) {
    const intent = parseWorkspaceRoute('?view=' + view);
    assert.equal(
      resolveWorkspaceRoute(intent, { isNew: true, memberStatus: 'missing' })
        .tab,
      tab,
    );
  }
  assert.equal(
    resolveWorkspaceRoute(parseWorkspaceRoute(''), {
      isNew: true,
      memberStatus: 'missing',
    }).tab,
    'Dashboard',
  );
  assert.equal(
    resolveWorkspaceRoute(parseWorkspaceRoute(''), {
      isNew: false,
      memberStatus: 'missing',
    }).tab,
    'Dashboard',
  );
  assert.equal(
    resolveWorkspaceRoute(
      parseWorkspaceRoute(`?view=profile&member=${member}`),
      { isNew: false },
    ).member,
    member,
  );
});
test('invalid, duplicate, oversized and prototype-named intents fail to Dashboard without redirect execution', () => {
  for (const query of [
    '?view=__proto__',
    '?view=constructor',
    '?view=toString',
    '?view=Trade',
    '?view=trade&view=mine',
    '?view=profile&member=' + member + '&member=' + member,
    '?view=trade&member=' + member,
    '?view=https://elsewhere.test',
    '?view=' + 'x'.repeat(2100),
  ]) {
    const route = parseWorkspaceRoute(query);
    assert.equal(route.tab, 'Dashboard');
    assert.equal(route.publicProfile, false);
    assert.equal(
      resolveWorkspaceRoute(route, { isNew: true, memberStatus: 'missing' })
        .tab,
      'Dashboard',
    );
  }
  assert.equal({}.polluted, undefined);
  assert.equal(
    parseWorkspaceRoute('?view=trade&next=https://elsewhere.test').tab,
    'Trade',
  );
  assert.equal(routeForTab('__proto__').tab, 'Dashboard');
});
test('share URLs preserve deployment pathname and discard unrelated tokens, keys, hashes and redirect targets', () => {
  for (const base of [
    'https://baink.money/',
    'https://aidollar.money/baink/',
  ]) {
    const link = publicProfileUrl(
      base + '?token=do-not-forward&private_key=never#secret',
      member,
    );
    const parsed = new URL(link);
    assert.equal(parsed.pathname, new URL(base).pathname);
    assert.equal(parsed.search, `?view=profile&member=${member}`);
    assert.equal(parsed.hash, '');
    assert.equal([...parsed.searchParams].length, 2);
    assert.equal(parseWorkspaceRoute(parsed.search).member, member);
  }
  assert.equal(
    workspaceUrl(
      'https://baink.money/?returnTo=https://evil.test',
      routeForTab('Trade'),
    ),
    'https://baink.money/?view=trade',
  );
  assert.throws(() => publicProfileUrl('javascript:alert(1)', member));
  assert.throws(() =>
    publicProfileUrl('https://name:secret@baink.money/', member),
  );
  assert.throws(() =>
    publicProfileUrl('https://baink.money/', 'not-an-address'),
  );
});
test('provider Trade intent survives sign-in and preview URLs without becoming a profile member target', () => {
  const intent = parseWorkspaceRoute(`?view=trade&provider=${member}`);
  assert.equal(intent.tab, 'Trade');
  assert.equal(intent.provider, member);
  assert.equal(intent.member, null);
  assert.equal(intent.publicProfile, false);
  const destination = resolveWorkspaceRoute(intent, {
    isNew: true,
    memberStatus: 'missing',
  });
  assert.equal(destination.provider, member);
  assert.equal(
    workspaceUrl(
      'https://aidollar.money/baink/?token=discard#private',
      destination,
    ),
    `https://aidollar.money/baink/?view=trade&provider=${member}`,
  );
  assert.equal(
    workspaceUrl('https://baink.money/', routeForTab('Trade', null, member)),
    `https://baink.money/?view=trade&provider=${member}`,
  );
  assert.equal(
    workspaceUrl(
      'https://baink.money/?view=trade&provider=' + member,
      routeForTab('Trade'),
    ),
    'https://baink.money/?view=trade',
  );
});
test('Trade provider filters reject malformed, duplicate, mixed and wrong-view targets', () => {
  for (const query of [
    `?view=profile&provider=${member}`,
    `?view=mine&provider=${member}`,
    `?provider=${member}`,
    `?view=trade&provider=${member}&provider=${member}`,
    `?view=trade&provider=${member}&member=${member}`,
    '?view=trade&provider=__proto__',
    '?view=trade&provider=constructor',
    '?view=trade&provider=https%3A%2F%2Felsewhere.test',
    '?view=trade&provider=' + 'a'.repeat(2050),
    '?view=trade&provider=' + member + 'a',
    '?view=trade&provider=' + member.toUpperCase(),
    '?view=trade&provider=',
  ]) {
    const parsed = parseWorkspaceRoute(query);
    assert.equal(parsed.tab, 'Dashboard', query);
    assert.equal(parsed.invalid, true, query);
    assert.equal(resolveWorkspaceRoute(parsed).provider, null);
  }
  assert.equal(routeForTab('Profile', member, member).invalid, true);
  assert.equal(
    resolveWorkspaceRoute({
      explicit: true,
      view: 'trade',
      provider: '__proto__',
    }).tab,
    'Dashboard',
  );
  assert.equal(
    parseWorkspaceRoute(`?view=profile&member=${member}`).provider,
    null,
  );
});

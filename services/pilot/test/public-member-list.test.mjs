import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memberRow, queryNativePublicRows } from '../dist/src/native/public-query.js';

// The member list (10 November 2026): one row per member, agents grouped under it,
// members without an agent (joined through the kit) included.
const kit = { address: 'uain1kit', name: 'Kit member', operator: 'Testor', karma: 1960, strikes: 0, licence: { status: 'active', since: null }, created_at: null };
const owner = { address: 'uain1own', name: 'aldisenti', operator: 'aldisenti', karma: 161, strikes: 2, licence: { status: 'active', since: '2026-09-28T07:29:35Z' }, created_at: null };
const agent = (id, extra = {}) => ({ id, name: id, karma: 3, state: 'active', address: 'uain1own', enrolled_at: '2026-09-21T03:48:25Z', capabilities: ['reading sources'], resources: ['intelligence'], reachability: 'agent', ...extra });

test('a member row carries its agents, the earliest known join date and no invented date', () => {
  const row = memberRow(owner, [agent('claude-code-2'), agent('claude-code', { enrolled_at: '2026-09-20T00:00:00Z' })]);
  assert.equal(row.id, 'uain1own');
  assert.deepEqual(row.agents.map((a) => a.id), ['claude-code', 'claude-code-2']);
  assert.equal(row.joined_at, '2026-09-20T00:00:00Z');
  assert.deepEqual(row.resources, ['intelligence']);
  assert.equal(row.strikes, 2);
  const lone = memberRow(kit, []);
  assert.equal(lone.joined_at, null, 'no date on the record, none shown');
  assert.deepEqual(lone.agents, []);
});

test('the list searches agent names, filters by license, resource and route, and sorts by Karma', () => {
  const rows = [memberRow(owner, [agent('claude-code')]), memberRow(kit, []), memberRow({ ...kit, address: 'uain1rev', name: 'Revoked', karma: 5, licence: { status: 'revoked' } }, [])];
  const list = (q) => queryNativePublicRows(new URL('https://uain.global/api/members?' + q), rows);
  assert.deepEqual(list('sort=karma').members.map((m) => m.id), ['uain1kit', 'uain1own', 'uain1rev']);
  assert.deepEqual(list('q=claude-code').members.map((m) => m.id), ['uain1own']);
  assert.deepEqual(list('standing=revoked').members.map((m) => m.id), ['uain1rev']);
  assert.deepEqual(list('provides=intelligence').members.map((m) => m.id), ['uain1own']);
  assert.deepEqual(list('reach=agent').members.map((m) => m.id), ['uain1own']);
  assert.equal(list('page_size=1&page=2').pages, 3);
});

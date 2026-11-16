// /admin: email + password login and the read-only campaign dashboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixture, member, audience } from './http-fixture.mjs';
import { hashPassword, writeUsers, readUsers } from '../server/admin.mjs';

const PASSWORD = 'correct horse battery';
const CAMPAIGNS = new Map([['x-aldi-01', { label: 'X, Aldi <b>01</b>', intro: 'Hi.', url: 'https://x.com/aldi/status/1' }]]);

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'baink-admin-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const llmsFile = join(dir, 'llms.txt');
  await writeFile(llmsFile, '# guide\nnode uain-agent.mjs next\n');
  const f = await fixture(t, { campaignLlmsFile: llmsFile, campaigns: CAMPAIGNS, campaignAcceptedTask: async () => false });
  await writeUsers(f.dataDir, { 'aldi@example.com': { password: await hashPassword(PASSWORD), createdAt: '2026-11-10T00:00:00.000Z' } });
  const go = (path, init = {}) => fetch(f.base + path, { redirect: 'manual', ...init, headers: { Origin: audience, ...init.headers } });
  const login = (email, password) => go('/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email, password }).toString() });
  return { f, go, login };
}
const cookieOf = (r) => r.headers.get('set-cookie')?.split(';')[0];

test('the login page shows without a session and the dashboard does not', async (t) => {
  const { go } = await setup(t);
  const r = await go('/admin');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /<form method="post" action="\/admin\/login">/);
  assert.doesNotMatch(html, /Log out<\/button>/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
});

test('right password: secure session cookie and the dashboard table, labels escaped', async (t) => {
  const { f, go, login } = await setup(t);
  const a = member();
  await f.request(a, 'POST', '/api/account', { displayName: 'A', via: 'x-aldi-01' });
  await go('/go/x-aldi-01');
  const r = await login('ALDI@example.com ', PASSWORD);
  assert.equal(r.status, 303);
  const set = r.headers.get('set-cookie');
  for (const part of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/admin']) assert.ok(set.includes(part), part);
  const page = await (await go('/admin', { headers: { Cookie: cookieOf(r) } })).text();
  assert.match(page, /Log out<\/button>/);
  assert.match(page, /X, Aldi &lt;b&gt;01&lt;\/b&gt;/);
  assert.match(page, /href="https:\/\/x\.com\/aldi\/status\/1"/);
  assert.match(page, /BAINK marketing<\/h1>/);
  assert.match(page, /<td>1<\/td><td>1 <span class="pct">100%<\/span><\/td>/);
  // A link-preview bot's view is not an open; the page says how many were left out.
  await go('/go/x-aldi-01', { headers: { 'User-Agent': 'Twitterbot/1.0' } });
  const after = await (await go('/admin', { headers: { Cookie: cookieOf(r) } })).text();
  assert.match(after, /<td>1<\/td><td>1 <span class="pct">100%<\/span><\/td>/);
  assert.match(after, /link-preview and crawler bots are left out \(1 on these rows\)/);
});

test('wrong password and unknown email get the same answer; five failures lock the email', async (t) => {
  const { login } = await setup(t);
  const wrong = await login('aldi@example.com', 'wrong password!!');
  const unknown = await login('nobody@example.com', 'wrong password!!');
  assert.equal(wrong.status, 401); assert.equal(unknown.status, 401);
  assert.match(await wrong.text(), /Wrong email or password/);
  for (let i = 0; i < 4; i++) await login('aldi@example.com', 'still wrong!!!!');
  const locked = await login('aldi@example.com', PASSWORD);
  assert.equal(locked.status, 429, 'even the right password waits out the lock');
  const wait = Number(locked.headers.get('retry-after'));
  assert.ok(Number.isInteger(wait) && wait > 0 && wait <= 900, `Retry-After ${wait} lies inside the 15-minute lock`);
});

// B1-6 (13 November 2026): one shared 10,000-entry failure map dropped its
// oldest key when full, which could be an admin email's lockout.
async function proxiedSetup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'baink-admin-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = await fixture(t, { trustProxy: true, campaigns: CAMPAIGNS, campaignAcceptedTask: async () => false });
  await writeUsers(f.dataDir, { 'aldi@example.com': { password: await hashPassword(PASSWORD), createdAt: '2026-11-10T00:00:00.000Z' } });
  const login = (email, password, ip) => fetch(f.base + '/admin/login', { method: 'POST', redirect: 'manual', headers: { Origin: audience, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Real-IP': ip }, body: new URLSearchParams({ email, password }).toString() });
  return { login };
}
test('an admin email lockout survives ten thousand failures for other emails and addresses', async (t) => {
  const { login } = await proxiedSetup(t);
  for (let i = 0; i < 5; i++) assert.equal((await login('aldi@example.com', 'wrong password!!', `192.0.2.${i + 1}`)).status, 401);
  let next = 0;
  const ip = (n) => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
  await Promise.all(Array.from({ length: 32 }, async () => {
    while (next < 10_050) { const n = next++; await (await login(`nobody-${n}@example.com`, 'x', ip(n))).text(); }
  }));
  const locked = await login('aldi@example.com', PASSWORD, '192.0.2.200');
  assert.equal(locked.status, 429);
  assert.match(await locked.text(), /Too many failed attempts/);
});
test('concurrent password checks are bounded; extra attempts are refused without hashing', async (t) => {
  const { login } = await proxiedSetup(t);
  const replies = await Promise.all(Array.from({ length: 40 }, (_, i) => login('aldi@example.com'.replace('aldi', `x${i}`), 'wrong password!!', `198.51.100.${i + 1}`).then(async (r) => ({ status: r.status, text: await r.text() }))));
  const busy = replies.filter((r) => r.status === 429);
  assert.ok(busy.length >= 1, 'some attempts are refused while two hash and sixteen wait');
  assert.ok(busy.every((r) => /Try again in a few seconds/.test(r.text)));
  assert.ok(replies.filter((r) => r.status === 401).length <= 18);
});

test('logout ends the session; a forged or cross-site request gets nothing', async (t) => {
  const { f, go, login } = await setup(t);
  const cookie = cookieOf(await login('aldi@example.com', PASSWORD));
  assert.equal((await go('/admin/logout', { method: 'POST', headers: { Cookie: cookie } })).status, 303);
  assert.doesNotMatch(await (await go('/admin', { headers: { Cookie: cookie } })).text(), /Log out<\/button>/);
  assert.doesNotMatch(await (await go('/admin', { headers: { Cookie: 'baink_admin=' + 'A'.repeat(43) } })).text(), /Log out<\/button>/);
  const cross = await fetch((await setup(t)).f.base + '/admin/login', { method: 'POST', redirect: 'manual', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body: `email=aldi%40example.com&password=${encodeURIComponent(PASSWORD)}` });
  assert.equal(cross.status, 403);
  // A browser posting the form under Referrer-Policy: no-referrer sends Origin: null.
  const nullOrigin = (site) => fetch(f.base + '/admin/login', { method: 'POST', redirect: 'manual', headers: { Origin: 'null', 'Sec-Fetch-Site': site, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `email=aldi%40example.com&password=${encodeURIComponent(PASSWORD)}` });
  assert.equal((await nullOrigin('same-origin')).status, 303);
  assert.equal((await nullOrigin('cross-site')).status, 403);
});

test('an admin session grants nothing on the member API', async (t) => {
  const { f, login } = await setup(t);
  const cookie = cookieOf(await login('aldi@example.com', PASSWORD));
  for (const path of ['/api/account', '/api/campaigns/report', '/api/native/sends']) {
    const r = await fetch(f.base + path, { headers: { Cookie: cookie, Origin: audience } });
    assert.ok(r.status >= 400, path);
  }
});

test('ops/admin-user.mjs adds, lists, resets and removes; the file is 0600 and holds no plain password', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'baink-admin-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = (...args) => execFileSync(process.execPath, [new URL('../ops/admin-user.mjs', import.meta.url).pathname, ...args], { env: { ...process.env, BAINK_DATA_DIR: dir, ADMIN_PASSWORD: PASSWORD }, encoding: 'utf8' });
  run('add', 'Vig@Example.com');
  assert.match(run('list'), /vig@example\.com/);
  const file = join(dir, 'admin-users.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(await readUsers(dir)), new RegExp(PASSWORD));
  assert.throws(() => run('add', 'vig@example.com'));
  run('reset', 'vig@example.com');
  run('remove', 'vig@example.com');
  assert.match(run('list'), /No admin users/);
  assert.throws(() => execFileSync(process.execPath, [new URL('../ops/admin-user.mjs', import.meta.url).pathname, 'add', 'x@example.com'], { env: { ...process.env, BAINK_DATA_DIR: dir, ADMIN_PASSWORD: 'short' }, stdio: 'pipe' }));
});

// ---- posts: create, edit, list, and the drafts-only token
import { writeTokens, tokenDigest } from '../server/admin.mjs';
const formPost = (go, path, cookie, fields) => go(path, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });

test('a new post gets a code and a live /go/ link; editing never changes the code', async (t) => {
  const { f, go, login } = await setup(t);
  const cookie = cookieOf(await login('aldi@example.com', PASSWORD));
  const created = await formPost(go, '/admin/posts', cookie, { platform: 'reddit', where: 'r/LocalLLaMA', label: 'LocalLLaMA design question', title: 'T', body: 'Body <script>x</script>', intro: 'Local models welcome.', status: 'draft' });
  assert.equal(created.status, 303);
  assert.equal(created.headers.get('location'), '/admin/posts/rd-r-localllama?saved=1');
  const page = await (await go('/admin/posts/rd-r-localllama', { headers: { Cookie: cookie } })).text();
  assert.match(page, /Body &lt;script&gt;x&lt;\/script&gt;/);
  assert.match(page, /\/go\/rd-r-localllama/);
  assert.match((await (await go('/go/rd-r-localllama')).text()), /Local models welcome\./);
  // A second post with the same place gets -02.
  const second = await formPost(go, '/admin/posts', cookie, { platform: 'reddit', where: 'r/LocalLLaMA', label: 'Second', status: 'draft' });
  assert.equal(second.headers.get('location'), '/admin/posts/rd-r-localllama-02?saved=1');
  // Posted needs a URL; then the numbers page shows it.
  assert.equal((await formPost(go, '/admin/posts/rd-r-localllama', cookie, { label: 'LocalLLaMA design question', status: 'posted' })).status, 400);
  assert.equal((await formPost(go, '/admin/posts/rd-r-localllama', cookie, { label: 'LocalLLaMA design question', status: 'posted', url: 'https://reddit.com/r/LocalLLaMA/1' })).status, 303);
  const numbers = await (await go('/admin', { headers: { Cookie: cookie } })).text();
  assert.match(numbers, /LocalLLaMA design question/);
  assert.doesNotMatch(numbers, />Second</, 'drafts stay off the numbers page');
  const list = await (await go('/admin/posts?platform=reddit', { headers: { Cookie: cookie } })).text();
  assert.match(list, /Posted/); assert.match(list, /Draft/);
  // An account joining through it is counted under the post.
  const a = member();
  await f.request(a, 'POST', '/api/account', { displayName: 'A', via: 'rd-r-localllama' });
  assert.match(await (await go('/admin', { headers: { Cookie: cookie } })).text(), /LocalLLaMA design question<\/a> <a href="https:\/\/reddit.com\/r\/LocalLLaMA\/1"[^]*?rd-r-localllama · Reddit · Posted<\/div><\/td><td>1<\/td><td>1 /);
});

test('post pages need a session and same-origin posts', async (t) => {
  const { f, go } = await setup(t);
  assert.doesNotMatch(await (await go('/admin/posts')).text(), /New post/);
  const r = await fetch(f.base + '/admin/posts', { method: 'POST', redirect: 'manual', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'platform=x&label=x' });
  assert.equal(r.status, 403);
  const anon = await go('/admin/posts', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'platform=x&label=x' });
  assert.equal(anon.status, 303);
});

test('the drafts token creates drafts only, nothing else', async (t) => {
  const { f, go, login } = await setup(t);
  const token = 'T'.repeat(43);
  await writeTokens(f.dataDir, { drafts: { hash: tokenDigest(token), scope: 'drafts:create', createdAt: '2026-11-10T00:00:00Z' } });
  const api = (body, auth = `Bearer ${token}`) => fetch(f.base + '/admin/api/drafts', { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const ok = await api({ platform: 'x', where: '@aldi', label: 'X Aldi 03', body: 'hello' });
  assert.equal(ok.status, 201);
  const made = await ok.json();
  assert.equal(made.status, 'draft'); assert.equal(made.code, 'x-aldi');
  assert.match(made.link, /\/go\/x-aldi$/);
  assert.equal((await api({ platform: 'x', label: 'y', status: 'posted' })).status, 400, 'cannot set status');
  assert.equal((await api({ platform: 'x', label: 'y', url: 'https://x.com/1' })).status, 400, 'cannot set url');
  assert.equal((await api({ platform: 'x', label: 'y' }, 'Bearer ' + 'W'.repeat(43))).status, 401);
  // The token is not a session: no pages, no numbers.
  for (const path of ['/admin', '/admin/posts', '/admin/posts/x-aldi'])
    assert.doesNotMatch(await (await go(path, { headers: { Authorization: `Bearer ${token}` } })).text(), /Log out/, path);
  // The draft shows up for a logged-in admin, marked as from the token.
  const cookie = cookieOf(await login('aldi@example.com', PASSWORD));
  assert.match(await (await go('/admin/posts', { headers: { Cookie: cookie } })).text(), /X Aldi 03/);
});

test('ops/admin-user.mjs token-add prints a token once and stores only its hash', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'baink-admin-tok-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = (...args) => execFileSync(process.execPath, [new URL('../ops/admin-user.mjs', import.meta.url).pathname, ...args], { env: { ...process.env, BAINK_DATA_DIR: dir }, encoding: 'utf8' });
  const out = run('token-add', 'drafts');
  const token = out.trim().split('\n').pop();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const { readFile } = await import('node:fs/promises');
  const stored = await readFile(join(dir, 'admin-tokens.json'), 'utf8');
  assert.ok(!stored.includes(token)); assert.ok(stored.includes(tokenDigest(token)));
  assert.match(run('list'), /token drafts\tdrafts:create/);
  run('token-remove', 'drafts');
  assert.doesNotMatch(run('list'), /token drafts/);
});

// ---- deleting posts
test('delete: tombstone, gone from Posts and Numbers, plain /go/, code never reused, token cannot delete', async (t) => {
  const { f, go, login } = await setup(t);
  const cookie = cookieOf(await login('aldi@example.com', PASSWORD));
  await formPost(go, '/admin/posts', cookie, { platform: 'x', where: '@aldi', label: 'Doomed post', intro: 'Doomed intro.', status: 'ready' });
  const a = member();
  await f.request(a, 'POST', '/api/account', { displayName: 'A', via: 'x-aldi' });
  assert.match(await (await go('/go/x-aldi')).text(), /Doomed intro\./);
  // The edit page offers delete; a cross-site or anonymous delete does nothing.
  assert.match(await (await go('/admin/posts/x-aldi', { headers: { Cookie: cookie } })).text(), /action="\/admin\/posts\/x-aldi\/delete"/);
  const cross = await fetch(f.base + '/admin/posts/x-aldi/delete', { method: 'POST', redirect: 'manual', headers: { Origin: 'https://evil.example', Cookie: cookie } });
  assert.equal(cross.status, 403);
  assert.equal((await go('/admin/posts/x-aldi/delete', { method: 'POST' })).status, 303);
  assert.equal((await go('/admin/posts/x-aldi/delete', { headers: { Cookie: cookie } })).status, 405, 'GET never deletes');
  assert.match(await (await go('/go/x-aldi')).text(), /Doomed intro\./, 'still live after refused deletes');
  // The drafts token cannot reach delete.
  const token = 'T'.repeat(43);
  await writeTokens(f.dataDir, { drafts: { hash: tokenDigest(token), scope: 'drafts:create', createdAt: '2026-11-10T00:00:00Z' } });
  assert.equal((await go('/admin/posts/x-aldi/delete', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status, 303);
  assert.match(await (await go('/go/x-aldi')).text(), /Doomed intro\./);
  // A real delete.
  const del = await go('/admin/posts/x-aldi/delete', { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(del.status, 303);
  assert.equal(del.headers.get('location'), '/admin/posts?deleted=1');
  assert.doesNotMatch(await (await go('/admin/posts', { headers: { Cookie: cookie } })).text(), /Doomed post/);
  assert.doesNotMatch(await (await go('/admin', { headers: { Cookie: cookie } })).text(), /Doomed post/);
  const plain = await (await go('/go/x-aldi')).text();
  assert.doesNotMatch(plain, /Doomed intro|Started from/);
  assert.equal((await go('/admin/posts/x-aldi', { headers: { Cookie: cookie } })).status, 404);
  assert.equal((await formPost(go, '/admin/posts/x-aldi', cookie, { label: 'Back?' })).status, 404, 'no edits to a deleted post');
  assert.equal((await go('/admin/posts/x-aldi/delete', { method: 'POST', headers: { Cookie: cookie } })).status, 404, 'deleting twice is a 404');
  // The code is never reused; the account keeps its via.
  const again = await formPost(go, '/admin/posts', cookie, { platform: 'x', where: '@aldi', label: 'New one', status: 'draft' });
  assert.equal(again.headers.get('location'), '/admin/posts/x-aldi-02?saved=1');
  const { readPersistedState } = await import('../server/store-sqlite.mjs');
  await f.restart();
  const state = await readPersistedState(f.dataDir);
  assert.equal(state.accounts[a.address].via, 'x-aldi');
  assert.equal(state.campaignPosts['x-aldi'].deleted, true);
  assert.equal(state.campaignPosts['x-aldi'].deletedBy, 'aldi@example.com');
  // A new account sending the deleted code is bucketed as unknown.
  const b = member();
  await f.request(b, 'POST', '/api/account', { displayName: 'B', via: 'x-aldi' });
  await f.restart();
  assert.equal((await readPersistedState(f.dataDir)).accounts[b.address].via, 'unknown');
});

test('delete: a campaigns.json seed gets a tombstone', async (t) => {
  const { go, login } = await setup(t);
  const cookie = cookieOf(await login('aldi@example.com', PASSWORD));
  assert.match(await (await go('/go/x-aldi-01')).text(), /Hi\./);
  assert.equal((await go('/admin/posts/x-aldi-01/delete', { method: 'POST', headers: { Cookie: cookie } })).status, 303);
  assert.doesNotMatch(await (await go('/go/x-aldi-01')).text(), /Started from/);
  assert.doesNotMatch(await (await go('/admin/posts', { headers: { Cookie: cookie } })).text(), /x-aldi-01/);
  const next = await formPost(go, '/admin/posts', cookie, { platform: 'x', label: 'x', status: 'draft', where: 'aldi-01' });
  assert.equal(next.headers.get('location'), '/admin/posts/x-aldi-01-02?saved=1');
});

// ---- replies: threads by other people, their own codes, token scope, Numbers split
const replyBody = (n, extra = {}) => ({ platform: 'reddit', where: 'r/ClaudeAI', threadUrl: `https://www.reddit.com/r/ClaudeAI/comments/abc${n}/what_to_do_with_spare_limits/`, threadTitle: `Spare limits ${n}`, threadInfo: '3h, 12 comments', why: 'Asks what to do with unused Claude limits.', draft: 'Disclosure: I work on BAINK. <b>hi</b>', ...extra });

test('replies: token adds New replies with their own codes; duplicates and other scopes refused', async (t) => {
  const { f, go, login } = await setup(t);
  const both = 'B'.repeat(43), draftsOnly = 'D'.repeat(43);
  await writeTokens(f.dataDir, { drafts: { hash: tokenDigest(both), scope: 'drafts:create,replies:create', createdAt: '2026-11-10T00:00:00Z' }, old: { hash: tokenDigest(draftsOnly), scope: 'drafts:create', createdAt: '2026-11-10T00:00:00Z' } });
  const api = (body, token = both) => fetch(f.base + '/admin/api/replies', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const first = await api(replyBody(1));
  assert.equal(first.status, 201);
  const made = await first.json();
  assert.equal(made.code, 'rd-reply-01'); assert.equal(made.status, 'new');
  assert.match(made.link, /\/go\/rd-reply-01$/);
  assert.equal((await (await api(replyBody(2))).json()).code, 'rd-reply-02');
  // Same thread, written differently: refused, and only its code comes back.
  const dup = await api(replyBody(1, { threadUrl: 'https://old.reddit.com/r/ClaudeAI/comments/abc1/what_to_do_with_spare_limits?utm=x' }));
  assert.equal(dup.status, 409);
  assert.deepEqual(await dup.json(), { error: { code: 'already_added', message: 'This thread was already added.', existing: 'rd-reply-01' } });
  assert.equal((await api(replyBody(3, { status: 'replied' }))).status, 400, 'cannot set status');
  assert.equal((await api(replyBody(3, { threadUrl: 'http://reddit.com/x' }))).status, 400, 'https only');
  assert.equal((await api(replyBody(3), draftsOnly)).status, 403, 'drafts-only token has no replies scope');
  // The two-scope token still makes drafts.
  assert.equal((await fetch(f.base + '/admin/api/drafts', { method: 'POST', headers: { Authorization: `Bearer ${both}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: 'x', label: 'x' }) })).status, 201);
  // The /go/ guide works for a reply code, text and HTML, and counts.
  const text = await (await go('/go/rd-reply-01')).text();
  assert.match(text, /Started from: Reply: Spare limits 1/); assert.match(text, /a reply on r\/ClaudeAI/); assert.match(text, /next --via rd-reply-01/);
  const html = await (await go('/go/rd-reply-01', { headers: { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'User-Agent': 'Mozilla/5.0 Chrome/150' } }));
  assert.match(html.headers.get('content-type'), /text\/html/);
  // A logged-in admin sees it as New, escaped, with no author; the token sees no page.
  const cookie = cookieOf(await login('aldi@example.com', PASSWORD));
  const page = await (await go('/admin/replies', { headers: { Cookie: cookie } })).text();
  assert.match(page, /<details open class="guide"><summary>What to look for<\/summary>/);
  assert.match(page, /use my idle PC or AI for science/);
  assert.match(page, /use this reply&#39;s own link|use this reply's own link/);
  assert.match(page, /New <span class="pct">2<\/span>/);
  assert.match(page, /Disclosure: I work on BAINK\. &lt;b&gt;hi&lt;\/b&gt;/);
  assert.doesNotMatch(page, /by (token:)?drafts/, 'token rows show no author');
  assert.doesNotMatch(await (await go('/admin/replies', { headers: { Authorization: `Bearer ${both}` } })).text(), /Log out/);
});

test('replies: Replied needs a URL, Skip hides it, a skipped thread cannot come back, Numbers splits posts and replies', async (t) => {
  const { f, go, login } = await setup(t);
  const cookie = cookieOf(await login('aldi@example.com', PASSWORD));
  assert.equal((await formPost(go, '/admin/replies', cookie, replyBody(1))).status, 303);
  assert.equal((await formPost(go, '/admin/replies', cookie, replyBody(2))).status, 303);
  assert.equal((await formPost(go, '/admin/replies', cookie, replyBody(2))).status, 409);
  assert.equal((await formPost(go, '/admin/replies/rd-reply-01', cookie, { status: 'replied', replyUrl: '' })).status, 400);
  assert.equal((await formPost(go, '/admin/replies/rd-reply-01', cookie, { status: 'replied', replyUrl: 'https://www.reddit.com/r/ClaudeAI/comments/abc1/x/c1' })).status, 303);
  assert.equal((await formPost(go, '/admin/replies/rd-reply-02', cookie, { status: 'skipped' })).status, 303);
  assert.equal((await formPost(go, '/admin/replies', cookie, replyBody(2))).status, 409, 'skipped thread stays known');
  // Cross-site and anonymous posts refused.
  assert.equal((await fetch(f.base + '/admin/replies/rd-reply-01', { method: 'POST', redirect: 'manual', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'status=skipped' })).status, 403);
  assert.equal((await go('/admin/replies/rd-reply-01', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'status=skipped' })).status, 303);
  // An account through the replied reply counts under Replies, not Posts.
  const a = member();
  await f.request(a, 'POST', '/api/account', { displayName: 'A', via: 'rd-reply-01' });
  const numbers = await (await go('/admin', { headers: { Cookie: cookie } })).text();
  const [postsPart, repliesPart] = numbers.split('<h2>Replies</h2>');
  assert.match(repliesPart, /Spare limits 1<\/a> <a href="https:\/\/www\.reddit\.com\/r\/ClaudeAI\/comments\/abc1\/x\/c1"[^]*?<td>0<\/td><td>1<\/td>/);
  assert.doesNotMatch(repliesPart, /Spare limits 2/, 'skipped replies stay out of Numbers');
  assert.doesNotMatch(postsPart, /Spare limits/);
  const list = await (await go('/admin/replies', { headers: { Cookie: cookie } })).text();
  assert.match(list, /Replied <span class="pct">1<\/span>/);
  assert.match(list, /<summary>Skipped <span class="pct">1<\/span><\/summary>/);
  // Reply codes and post codes never collide.
  const post = await formPost(go, '/admin/posts', cookie, { platform: 'reddit', label: 'x', status: 'draft', where: 'reply-01' });
  assert.equal(post.headers.get('location'), '/admin/posts/rd-reply-01-02?saved=1');
});

test('ops/admin-user.mjs: token-add --scope and token-scope keep the token value', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'baink-admin-scope-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = (...args) => execFileSync(process.execPath, [new URL('../ops/admin-user.mjs', import.meta.url).pathname, ...args], { env: { ...process.env, BAINK_DATA_DIR: dir }, encoding: 'utf8' });
  const token = run('token-add', 'drafts').trim().split('\n').pop();
  assert.match(run('list'), /token drafts\tdrafts:create\t/);
  run('token-scope', 'drafts', 'drafts:create,replies:create');
  const { readTokens } = await import('../server/admin.mjs');
  const stored = (await readTokens(dir)).drafts;
  assert.equal(stored.hash, tokenDigest(token), 'same token');
  assert.equal(stored.scope, 'drafts:create,replies:create');
  assert.throws(() => run('token-scope', 'drafts', 'admin:all'));
  const two = run('token-add', 'scout', '--scope', 'replies:create');
  assert.match(two, /replies:create; nothing else/);
});

test('marketing:read: the token reads numbers, posts and replies as JSON and still cannot change anything', async (t) => {
  const { f, go, login } = await setup(t);
  const reader = 'R'.repeat(43), writer = 'D'.repeat(43);
  await writeTokens(f.dataDir, { drafts: { hash: tokenDigest(reader), scope: 'drafts:create,replies:create,marketing:read', createdAt: '2026-11-10T00:00:00Z' }, old: { hash: tokenDigest(writer), scope: 'drafts:create,replies:create', createdAt: '2026-11-10T00:00:00Z' } });
  const cookie = cookieOf(await login('aldi@example.com', PASSWORD));
  const get = (path, token = reader) => fetch(f.base + path, { headers: { Authorization: `Bearer ${token}` } });
  const post = (path, body, token = reader) => fetch(f.base + path, { method: 'POST', redirect: 'manual', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  // One Posted seed with a read and an account, one Draft with a read, one replied and one new reply.
  await f.request(member(), 'POST', '/api/account', { displayName: 'A', via: 'x-aldi-01' });
  await go('/go/x-aldi-01');
  assert.equal((await post('/admin/api/drafts', { platform: 'x', where: '@aldi', label: 'Draft one', body: 'secret draft' })).status, 201);
  await go('/go/x-aldi');
  assert.equal((await post('/admin/api/replies', replyBody(1))).status, 201);
  assert.equal((await post('/admin/api/replies', replyBody(2))).status, 201);
  assert.equal((await formPost(go, '/admin/replies/rd-reply-01', cookie, { status: 'replied', replyUrl: 'https://www.reddit.com/r/ClaudeAI/comments/abc1/x/c1' })).status, 303);
  await f.request(member(), 'POST', '/api/account', { displayName: 'B', via: 'rd-reply-01' });

  const r = await get('/admin/api/numbers');
  assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
  const n = await r.json();
  const seed = n.posts.rows.find((x) => x.code === 'x-aldi-01');
  assert.deepEqual({ reads: seed.reads, bots: seed.bots, accounts: seed.accounts, enrolled: seed.enrolled, acceptedTask: seed.acceptedTask, spent: seed.spent }, { reads: 1, bots: 0, accounts: 1, enrolled: 0, acceptedTask: 0, spent: 0 });
  assert.equal(n.posts.total.reads, 1); assert.equal(n.posts.total.accounts, 1);
  assert.deepEqual(n.replies.rows.map((x) => [x.code, x.accounts]), [['rd-reply-01', 1]]);
  assert.equal(n.replies.total.accounts, 1);
  assert.ok(!n.posts.rows.some((x) => x.code === 'x-aldi'), 'a Draft is not in the Posts table');
  assert.deepEqual(n.notShown.map((x) => [x.code, x.kind, x.status, x.reads]).sort(), [['rd-reply-02', 'reply', 'new', 0], ['x-aldi', 'post', 'draft', 1]]);
  // The JSON agrees with the page a person sees.
  const page = await (await go('/admin', { headers: { Cookie: cookie } })).text();
  assert.match(page, new RegExp(`<tfoot><tr><td>Total</td><td>${n.posts.total.reads}</td><td>${n.posts.total.accounts}</td>`));

  const posts = (await (await get('/admin/api/posts')).json()).posts;
  const draft = posts.find((p) => p.code === 'x-aldi');
  assert.equal(draft.status, 'draft'); assert.equal(draft.body, 'secret draft'); assert.match(draft.link, /\/go\/x-aldi$/);
  const replies = (await (await get('/admin/api/replies')).json()).replies;
  assert.deepEqual(replies.map((x) => [x.code, x.status]).sort(), [['rd-reply-01', 'replied'], ['rd-reply-02', 'new']]);
  assert.equal(replies.find((x) => x.code === 'rd-reply-01').replyUrl, 'https://www.reddit.com/r/ClaudeAI/comments/abc1/x/c1');
  // No admin login, author or delete mark leaves through the token.
  assert.doesNotMatch(JSON.stringify([n, posts, replies]), /aldi@example\.com|createdBy|updatedBy|deletedBy|token:/);

  // Without the scope, without a token, with a bad one.
  for (const path of ['/admin/api/numbers', '/admin/api/posts', '/admin/api/replies']) {
    assert.equal((await get(path, writer)).status, 403, path);
    assert.equal((await fetch(f.base + path)).status, 401, path);
  }
  // Reading gives no way to change: no edit, status, delete, and no page.
  assert.equal((await post('/admin/api/numbers', {})).status, 405);
  assert.equal((await post('/admin/api/posts', { code: 'x-aldi', status: 'posted' })).status, 405);
  assert.equal((await fetch(f.base + '/admin/api/posts', { method: 'DELETE', headers: { Authorization: `Bearer ${reader}` } })).status, 405);
  assert.equal((await post('/admin/api/replies', { ...replyBody(3), status: 'replied' })).status, 400);
  for (const path of ['/admin/posts/x-aldi', '/admin/posts/x-aldi/delete', '/admin/replies/rd-reply-02'])
    assert.ok([303, 403].includes((await post(path, { status: 'posted' })).status), path);
  assert.equal((await (await get('/admin/api/posts')).json()).posts.find((p) => p.code === 'x-aldi').status, 'draft', 'still a draft');
  assert.equal((await (await get('/admin/api/replies')).json()).replies.find((x) => x.code === 'rd-reply-02').status, 'new');
  for (const path of ['/admin', '/admin/posts', '/admin/replies'])
    assert.doesNotMatch(await (await get(path)).text(), /Log out/, path);
});

test('marketing:read is limited to 120 reads an hour per token', async (t) => {
  const { f } = await setup(t);
  const reader = 'R'.repeat(43);
  await writeTokens(f.dataDir, { drafts: { hash: tokenDigest(reader), scope: 'marketing:read', createdAt: '2026-11-10T00:00:00Z' } });
  const get = () => fetch(f.base + '/admin/api/replies', { headers: { Authorization: `Bearer ${reader}` } });
  for (let i = 0; i < 120; i++) assert.equal((await get()).status, 200, `read ${i + 1}`);
  const over = await get();
  assert.equal(over.status, 429);
  assert.ok(Number(over.headers.get('retry-after')) > 0);
  // Reads do not use up the drafts allowance, and the scope alone creates nothing.
  assert.equal((await fetch(f.base + '/admin/api/drafts', { method: 'POST', headers: { Authorization: `Bearer ${reader}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: 'x', label: 'x' }) })).status, 403);
});

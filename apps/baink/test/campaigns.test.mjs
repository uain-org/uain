// /go/<code> campaign guides, the account's campaign code and the operator report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, member } from './http-fixture.mjs';
import { campaignGuide, loadCampaigns, CAMPAIGN_CODE } from '../server/campaigns.mjs';
import * as kit from '../agent-kit/uain-agent.mjs';
import { campaignLlmsPath } from '../server/app.mjs';
import { mkdir } from 'node:fs/promises';

const LLMS = '# BAINK guide\n2. Join: node uain-agent.mjs next. It names each step: init, account --name "..." (public profile)\n';
const CAMPAIGNS = new Map([
  ['rd-localllama', { label: 'Reddit r/LocalLLaMA', intro: 'Any agent that can run a shell, local models too.' }],
  ['x-aldi-01', { label: 'X, Aldi', intro: 'From a team member post.' }],
]);

async function setup(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'baink-go-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const llmsFile = join(dir, 'llms.txt');
  await writeFile(llmsFile, LLMS);
  const operator = member();
  const f = await fixture(t, { campaignLlmsFile: llmsFile, campaigns: CAMPAIGNS, campaignOperatorAddresses: [operator.address], campaignAcceptedTask: async () => false, ...extra });
  // Signed BAINK routes need an account; the operator has one like any member.
  await f.request(operator, 'POST', '/api/account', { displayName: 'Operator' });
  return { f, operator, llmsFile };
}
const get = (f, path) => fetch(f.base + path).then(async (r) => ({ status: r.status, text: await r.text(), headers: r.headers }));

test('the seeded campaigns file loads and every code is valid', () => {
  const campaigns = loadCampaigns();
  assert.ok(campaigns.size >= 10);
  for (const code of campaigns.keys()) assert.match(code, CAMPAIGN_CODE);
  assert.ok(campaigns.has('rd-localllama') && campaigns.has('x-baink-t1'));
});

test('campaignGuide adds the intro and --via to next and account, once', () => {
  const text = campaignGuide('x-aldi-01', CAMPAIGNS.get('x-aldi-01'), LLMS);
  // The guide starts with the plain llms.txt; the campaign block comes last.
  assert.ok(text.startsWith('# BAINK guide\n'), 'starts with the llms.txt header');
  assert.match(text, /\n---\n\n## Started from: X, Aldi\n\nFrom a team member post\.\n\nCampaign code: x-aldi-01\.[^]*earns nobody anything\.\n$/);
  assert.ok(text.indexOf('Started from') > text.indexOf('uain-agent.mjs next --via'));
  assert.match(text, /uain-agent\.mjs next --via x-aldi-01\. It names/);
  assert.match(text, /account --name "\.\.\." --via x-aldi-01 \(public profile\)/);
  assert.equal(campaignGuide('x-aldi-01', CAMPAIGNS.get('x-aldi-01'), text).match(/next --via x-aldi-01 --via/g), null);
});

test('GET /go/<code> serves the live llms.txt with the intro; unknown codes get the plain guide', async (t) => {
  const { f } = await setup(t);
  const known = await get(f, '/go/rd-localllama');
  assert.equal(known.status, 200);
  assert.match(known.headers.get('content-type'), /^text\/plain/);
  assert.match(known.text, /local models too/);
  assert.match(known.text, /next --via rd-localllama/);
  assert.equal((await get(f, '/go/rd-localllama/llms.txt')).text, known.text);
  for (const path of ['/go/nope', '/go/BAD_CODE', '/go/', '/go/' + 'a'.repeat(60)]) {
    const r = await get(f, path);
    assert.equal(r.status, 200, path);
    assert.equal(r.text, LLMS, path);
  }
});

test('the guide follows edits to llms.txt without a restart', async (t) => {
  const { f, llmsFile } = await setup(t);
  await get(f, '/go/x-aldi-01');
  await writeFile(llmsFile, LLMS + 'NEW LINE\n');
  // The cache rechecks the file every 30 s; a restart is the other way it is reread.
  await f.restart();
  assert.match((await get(f, '/go/x-aldi-01')).text, /NEW LINE/);
});

test('account creation keeps a known code, buckets the rest as unknown, never changes it later', async (t) => {
  const { f, operator } = await setup(t);
  const a = member(), b = member(), c = member(), d = member();
  assert.equal((await f.request(a, 'POST', '/api/account', { displayName: 'A', via: 'rd-localllama' })).status, 201);
  assert.equal((await f.request(b, 'POST', '/api/account', { displayName: 'B', via: 'made-up' })).status, 201);
  assert.equal((await f.request(c, 'POST', '/api/account', { displayName: 'C' })).status, 201);
  assert.equal((await f.request(d, 'POST', '/api/account', { displayName: 'D', via: 'Bad Code!' })).status, 201);
  // PATCH cannot set or change it, and a second POST keeps the first.
  assert.equal((await f.request(c, 'PATCH', '/api/account', { displayName: 'C2', via: 'x-aldi-01' })).status, 400);
  await f.request(a, 'POST', '/api/account', { displayName: 'A', via: 'x-aldi-01' });
  await get(f, '/go/rd-localllama'); await get(f, '/go/rd-localllama'); await get(f, '/go/whatever');
  const report = await f.request(operator, 'GET', '/api/campaigns/report');
  assert.equal(report.status, 200);
  const row = (code) => report.body.campaigns.find((r) => r.code === code);
  assert.deepEqual([row('rd-localllama').reads, row('rd-localllama').accounts], [2, 1]);
  assert.deepEqual([row('unknown').reads, row('unknown').accounts], [1, 2]);
  assert.equal(row('x-aldi-01').accounts, 0);
  assert.equal(row('rd-localllama').acceptedTask, 0);
});

test('the report is for configured operators only', async (t) => {
  const { f } = await setup(t);
  const stranger = member();
  await f.request(stranger, 'POST', '/api/account', { displayName: 'S' });
  assert.equal((await f.request(stranger, 'GET', '/api/campaigns/report')).status, 404);
  assert.ok([401, 403].includes((await f.request(null, 'GET', '/api/campaigns/report')).status));
});

test('accepted-task counts come from the reader, and an unreadable member is counted apart', async (t) => {
  const accepted = new Set();
  const { f, operator } = await setup(t, { campaignAcceptedTask: async (address) => accepted.has(address) ? true : address.endsWith('0') ? null : false });
  const people = Array.from({ length: 6 }, member);
  for (const p of people) await f.request(p, 'POST', '/api/account', { displayName: 'P', via: 'x-aldi-01' });
  accepted.add(people[0].address);
  const row = (await f.request(operator, 'GET', '/api/campaigns/report')).body.campaigns.find((r) => r.code === 'x-aldi-01');
  const unreadable = people.filter((p) => p !== people[0] && p.address.endsWith('0')).length;
  assert.equal(row.accounts, 6);
  assert.equal(row.acceptedTask, 1);
  assert.equal(row.acceptedTaskUnknown, unreadable);
});

test('kit: --via is validated, saved once, and sent only when the account is created', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'uain-agent-via-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const o = { home: dir, as: 'v' };
  assert.throws(() => kit.rememberVia(o, 'Bad Code'), (e) => e.code === 'invalid_input');
  assert.equal(kit.rememberVia(o, undefined), null);
  assert.equal(kit.rememberVia(o, 'rd-localllama'), 'rd-localllama');
  assert.equal(kit.rememberVia(o, 'x-aldi-01'), 'rd-localllama', 'the first code wins');
  // The saved code does not count as prior signing activity (no false "restore your key").
  assert.equal((await kit.initIdentity(o)).created, true);

  const { f, operator } = await setup(t);
  const sent = [];
  const spy = (url, init) => { if (String(url).endsWith('/api/account') && init?.method === 'POST') sent.push(JSON.parse(init.body)); return fetch(url, { ...init, headers: { ...init.headers, Origin: 'https://baink.example' } }); };
  // The fixture's audience is https://baink.example; point the kit at it and route to the test server.
  const ko = { ...o, url: 'https://baink.example', fetch: (url, init) => spy(String(url).replace('https://baink.example', f.base), init) };
  const created = await kit.ops.account(ko, { name: 'Via agent' });
  assert.deepEqual(sent.map((b) => b.via), ['rd-localllama']);
  assert.ok(created.account);
  const report = await f.request(operator, 'GET', '/api/campaigns/report');
  assert.equal(report.body.campaigns.find((r) => r.code === 'rd-localllama').accounts, 1);
});

test('the guide reads the llms.txt the release serves (dist/), not the source public/', async (t) => {
  // BAINK 0.3.77 read public/llms.txt, which a release does not ship, and /go/ answered 500 on production.
  const dir = await mkdtemp(join(tmpdir(), 'baink-static-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.match(campaignLlmsPath(dir), /public\/llms\.txt$/, 'no built copy: the source copy');
  await writeFile(join(dir, 'llms.txt'), '# built\n');
  assert.equal(campaignLlmsPath(dir), join(dir, 'llms.txt'));
  const f = await fixture(t, { staticDir: dir, campaigns: CAMPAIGNS, campaignAcceptedTask: async () => false });
  const r = await fetch(f.base + '/go/x-aldi-01');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /# built/);
});

test('campaign intros say "above": the campaign block sits at the end of the guide', () => {
  for (const [code, campaign] of loadCampaigns()) assert.doesNotMatch(campaign.intro, /\bbelow\b/, code);
});

// ---- People and agents on /go/<code>
import { wantsHtml } from '../server/campaigns.mjs';
const CHROME = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36', accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'cross-site' };
const AGENTS = {
  curl: { 'user-agent': 'curl/8.7.1', accept: '*/*' },
  'Claude Code WebFetch': { 'user-agent': 'Claude-User (claude-code/2.1.259; +https://support.anthropic.com/)', accept: 'text/markdown, text/html, */*' },
  'Claude.ai fetch': { 'user-agent': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +claude-user@anthropic.com)', accept: '*/*' },
  'ChatGPT-User': { 'user-agent': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot', accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  'MistralAI-User with Fetch Metadata': { ...CHROME, 'user-agent': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; MistralAI-User/1.0; +https://docs.mistral.ai/robots)' },
  'signed cloud browser (dots)': { ...CHROME, 'signature-agent': '"https://chatgpt.com"' },
  'Codex fetch': { 'user-agent': 'Mozilla/5.0 (compatible)', accept: '*/*' },
  'node fetch': { 'user-agent': 'node', accept: '*/*', 'sec-fetch-mode': 'cors' },
  'browser asking for markdown first': { ...CHROME, accept: 'text/markdown, text/html;q=0.9' },
  'XHR from a page': { ...CHROME, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
};

test('wantsHtml: only a clear browser navigation; every named or signed agent gets text', () => {
  assert.equal(wantsHtml(CHROME), true);
  assert.equal(wantsHtml({ ...CHROME, 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }), true, 'Safari');
  for (const [name, headers] of Object.entries(AGENTS)) assert.equal(wantsHtml(headers), false, name);
});

test('GET /go/<code>: browser gets the page, agents get the same text as before, one read each', async (t) => {
  const { f, operator } = await setup(t);
  const plain = await fetch(f.base + '/go/rd-localllama', { headers: AGENTS['Claude Code WebFetch'] });
  const text = await plain.text();
  assert.match(plain.headers.get('content-type'), /^text\/plain/);
  assert.match(text, /next --via rd-localllama/);
  assert.match(plain.headers.get('vary'), /Accept, Sec-Fetch-Mode, Sec-Fetch-Dest/);

  const page = await fetch(f.base + '/go/rd-localllama', { headers: CHROME });
  const html = await page.text();
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.match(page.headers.get('vary'), /Accept, Sec-Fetch-Mode, Sec-Fetch-Dest/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-/);
  assert.match(html, /<h1>Put your AI agent&#39;s spare capacity to work on open research\.<\/h1>/);
  assert.match(html, /Accepted work earns AI\$\. Paste our link into OpenAI dots, Grok Bot, Claude Code or Codex to start\./);
  assert.doesNotMatch(html, /Folding@home/);
  // The link to paste is the text guide, so a browser-driving agent (dots, Grok Bot) gets text, not this page.
  assert.match(html, /<code>https:\/\/baink\.example\/go\/rd-localllama\/llms\.txt<\/code><button type="button" data-copy="https:\/\/baink\.example\/go\/rd-localllama\/llms\.txt">/);
  assert.match(html, /no cash payout/);
  assert.match(html, /next --via rd-localllama/, 'the full guide is in the page');
  assert.doesNotMatch(html, /<script[^>]*src=/, 'no external scripts');
  // /llms.txt form is always text, even for a browser.
  assert.match((await fetch(f.base + '/go/rd-localllama/llms.txt', { headers: CHROME })).headers.get('content-type'), /^text\/plain/);
  // Unknown code: the page without campaign specifics, pointing at the plain guide.
  const unknown = await (await fetch(f.base + '/go/typo', { headers: CHROME })).text();
  assert.match(unknown, /<code>https:\/\/baink\.example\/llms\.txt<\/code>/);
  assert.doesNotMatch(unknown, /Started from/);
  // Three reads of rd-localllama (text, html, llms.txt), one unknown.
  const row = (r, c) => r.body.campaigns.find((x) => x.code === c);
  const report = await f.request(operator, 'GET', '/api/campaigns/report');
  assert.equal(row(report, 'rd-localllama').reads, 3);
  assert.equal(row(report, 'unknown').reads, 1);
});

test('the browser page escapes the guide and the link', async (t) => {
  const evil = new Map([['x-aldi-01', { label: 'L', intro: '<script>alert(1)</script> & "quotes"' }]]);
  const { f } = await setup(t, { campaigns: evil });
  const html = await (await fetch(f.base + '/go/x-aldi-01', { headers: CHROME })).text();
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;quotes&quot;/);
  assert.equal((html.match(/<script>/g) ?? []).length, 1, 'only the copy-button script');
});

// ---- uain.global/go/<code>, proxied to BAINK as /uain/go/<code> (ops/nginx/docker.conf)
const UAIN_LLMS = '# UAIN, the United AI Network\n2. Join: node uain-agent.mjs next. It names each step: init, account --name "..." (public profile)\n';

test('GET /uain/go/<code>: UAIN guide for agents, UAIN page for people, same code and count as /go/', async (t) => {
  let fetches = 0;
  const { f, operator } = await setup(t, { campaignUainLlms: async () => { fetches++; return UAIN_LLMS; } });
  const text = await (await fetch(f.base + '/uain/go/rd-localllama', { headers: AGENTS.curl })).text();
  assert.ok(text.startsWith('# UAIN, the United AI Network\n'), 'the UAIN guide, not BAINK');
  assert.match(text, /next --via rd-localllama/);
  assert.match(text, /## Started from: Reddit r\/LocalLLaMA/);
  assert.equal(await (await fetch(f.base + '/uain/go/rd-localllama/llms.txt', { headers: CHROME })).text(), text, '/llms.txt form is always text');

  const page = await fetch(f.base + '/uain/go/rd-localllama', { headers: CHROME });
  const html = await page.text();
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'sha256-/);
  assert.match(html, /<h1>Put your AI&#39;s spare capacity to work for humanity\.<\/h1>/);
  assert.match(html, /curing diseases, ending poverty and clean water/);
  assert.match(html, /independent AI reviewer/);
  assert.match(html, /Karma<\/strong>, your AI&#39;s public standing/);
  assert.match(html, /no cash payout/);
  assert.doesNotMatch(html.replace(/<details>[^]*<\/details>/, ''), /Trade|marketplace|spend/i, 'no Trade or spending pitch');
  assert.doesNotMatch(html.replace(/<details>[^]*<\/details>/, ''), /baink/i, 'nothing outside the guide points at BAINK');
  assert.match(text, /when it creates the member account/);
  assert.match(html, /<code>https:\/\/uain\.global\/go\/rd-localllama\/llms\.txt<\/code>/);
  assert.match(html, /next --via rd-localllama/, 'the full guide is in the page');

  // 16 November 2026: the limits and one accepted example, labelled honestly.
  const people = html; // the page read above, so the per-code count is unchanged
  assert.match(people, /href="https:\/\/uain\.global\/limits"/);
  assert.match(people, /href="https:\/\/uain\.global\/example"/);
  for (const task of ['T-35', 'T-40', 'T-45']) assert.ok(people.includes(`href="https://uain.global/tasks/${task}"`));
  assert.doesNotMatch(people, /Honest work that is rejected costs nothing/);
  assert.match(people, /senescent cells/); assert.match(people, /not peer review and not a scientific breakthrough/);
  const unknown = await (await fetch(f.base + '/uain/go/typo', { headers: CHROME })).text();
  assert.match(unknown, /<code>https:\/\/uain\.global\/llms\.txt<\/code>/);
  assert.equal(fetches, 1, 'the UAIN guide is cached');
  // The BAINK link is unchanged.
  assert.ok((await (await fetch(f.base + '/go/rd-localllama', { headers: AGENTS.curl })).text()).startsWith('# BAINK guide\n'));

  const report = await f.request(operator, 'GET', '/api/campaigns/report');
  const row = (c) => report.body.campaigns.find((x) => x.code === c);
  assert.equal(row('rd-localllama').reads, 4, 'uain text, uain llms.txt, uain page, baink text');
  assert.equal(row('unknown').reads, 1);
});

test('GET /uain/go/<code> falls back to the BAINK guide while uain.global cannot be read', async (t) => {
  let errors = 0;
  const { f } = await setup(t, { campaignUainLlms: async () => { throw new Error('down'); }, onError: () => { errors++; } });
  const r = await fetch(f.base + '/uain/go/x-aldi-01', { headers: AGENTS.curl });
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.ok(text.startsWith('# BAINK guide\n'));
  assert.match(text, /next --via x-aldi-01/);
  assert.ok(errors >= 1, 'the failure is reported');
});

// ---- What counts as an open: people and agents, not link-preview bots or crawlers
import { isLinkBot } from '../server/campaigns.mjs';
import { planFromLines, correct } from '../ops/campaign-reads-correct.mjs';
const BOTS = {
  Twitterbot: 'Twitterbot/1.0',
  redditbot: 'Mozilla/5.0 (compatible; redditbot/1.0; +http://www.reddit.com/feedback)',
  trendiction: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; trendictionbot0.5.0; trendiction search; http://www.trendiction.de/bot; please let us know of any problems; web at trendiction.com) Gecko/20100101 Firefox/125.0',
  'Googlebot-Image': 'Googlebot-Image/1.0',
  Googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  Applebot: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)',
  Anthill: 'Anthill',
  dataminr: 'help@dataminr.com',
  Mentionbot: 'Mozilla/5.0 (compatible; Mentionbot/1.0)',
  'spaced Mozilla scraper': 'Mozilla / 5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.117 Safari/537.36',
  facebook: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  Slackbot: 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
  Discordbot: 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
  LinkedInBot: 'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
  TelegramBot: 'TelegramBot (like TwitterBot)',
  WhatsApp: 'WhatsApp/2.23.20.0',
  bingbot: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  GPTBot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot',
  ClaudeBot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  'a crawler': 'SomeCrawler/2.0 (+https://example.com/crawler)',
  GoogleOther: 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.52 Mobile Safari/537.36 (compatible; GoogleOther)',
};
const READERS = {
  ...Object.fromEntries(Object.entries(AGENTS).map(([name, headers]) => [name, headers['user-agent']])),
  'Claude-User bare': 'Claude-User',
  'curl 8': 'curl/8',
  'uain-agent kit': 'uain-agent/0.2.17',
  'Perplexity-User': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)',
  python: 'python-requests/2.32.3',
  'Chrome on a Mac': CHROME['user-agent'],
  'Reddit app on Android': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36',
  Edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0',
  'headless Chrome (a browser-driving agent)': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/157.0.0.0 Safari/537.36',
  'a phone whose model holds "bot"': 'Mozilla/5.0 (Linux; Android 13; CUBOT NOTE 30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'no agent at all': '',
};

test('isLinkBot: preview bots and crawlers are bots; people, agents and their fetchers are not', () => {
  for (const [name, agent] of Object.entries(BOTS)) assert.equal(isLinkBot({ 'user-agent': agent }), true, name);
  for (const [name, agent] of Object.entries(READERS)) assert.equal(isLinkBot({ 'user-agent': agent }), false, name);
  // A signed cloud browser is an agent whatever it calls itself; a header-only request reads nothing.
  assert.equal(isLinkBot({ 'user-agent': BOTS.Twitterbot, 'signature-agent': '"https://chatgpt.com"' }), false);
  assert.equal(isLinkBot({ 'user-agent': 'curl/8.7.1' }, 'HEAD'), true);
  assert.equal(isLinkBot(), false);
});

test('GET /go/<code>: bot views are counted apart and are not opens; every reader still gets the guide', async (t) => {
  const { f, operator } = await setup(t);
  const view = (path, agent, init = {}) => fetch(f.base + path, { ...init, headers: { 'user-agent': agent } });
  // The bots get the same answer as anyone (a preview card needs it); only the count differs.
  for (const agent of [BOTS.Twitterbot, BOTS.redditbot, BOTS.Anthill, BOTS.trendiction]) {
    const r = await view('/go/rd-localllama', agent);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /next --via rd-localllama/);
  }
  assert.equal((await view('/uain/go/rd-localllama', BOTS['Googlebot-Image'])).status, 200);
  assert.equal((await view('/go/rd-localllama', 'curl/8.7.1', { method: 'HEAD' })).status, 200);
  // People and agents: one open each, on either domain's path.
  for (const agent of [READERS['Claude Code WebFetch'], READERS['ChatGPT-User'], READERS.curl, READERS['uain-agent kit']]) await view('/go/rd-localllama', agent);
  await fetch(f.base + '/uain/go/rd-localllama', { headers: CHROME });
  await view('/go/typo', BOTS.Twitterbot);
  await view('/go/typo', READERS.curl);
  const report = await f.request(operator, 'GET', '/api/campaigns/report');
  const row = (c) => report.body.campaigns.find((x) => x.code === c);
  assert.deepEqual([row('rd-localllama').reads, row('rd-localllama').bots], [5, 6]);
  assert.deepEqual([row('unknown').reads, row('unknown').bots], [1, 1]);
  assert.deepEqual([row('x-aldi-01').reads, row('x-aldi-01').bots], [0, 0]);
  // Nothing about a reader is stored: a count row holds numbers and two times.
  assert.doesNotMatch(JSON.stringify(report.body), /Twitterbot|curl|Mozilla|127\.0\.0\.1/);
});

test('ops/campaign-reads-correct: bot views in the access log before the cut-off move from reads to bots, once', () => {
  const line = (time, method, path, agent, status = 200) => `203.0.113.10 - - [${time} +0000] "${method} ${path} HTTP/1.1" ${status} 12 "-" "${agent}"`;
  const lines = [
    line('12/Nov/2026:07:00:42', 'GET', '/uain/go/x-folding', BOTS.Twitterbot),
    line('12/Nov/2026:07:01:21', 'HEAD', '/uain/go/x-folding', BOTS.dataminr),
    line('12/Nov/2026:07:01:48', 'GET', '/uain/go/x-folding', CHROME['user-agent']),
    line('12/Nov/2026:06:59:23', 'GET', '/go/x-folding/llms.txt', 'curl/8.7.1'),
    line('12/Nov/2026:07:02:00', 'GET', '/go/x-folding', BOTS.Twitterbot, 502),
    line('12/Nov/2026:11:00:00', 'GET', '/go/x-folding', BOTS.Twitterbot),
    line('12/Nov/2026:07:03:00', 'GET', '/go/BAD_CODE', BOTS.redditbot),
    line('12/Nov/2026:07:04:00', 'GET', '/api/account', BOTS.Twitterbot),
    line('12/Nov/2026:07:05:00', 'GET', '/go/gone', BOTS.Twitterbot),
    'not a log line',
  ];
  const before = Date.parse('2026-11-12T10:00:00Z');
  const plan = { before: '2026-11-12T10:00:00.000Z', ...planFromLines(lines, { before, isLinkBot, codePattern: CAMPAIGN_CODE }) };
  assert.deepEqual(plan.codes, { 'x-folding': { views: 4, bots: 2 }, unknown: { views: 1, bots: 1 }, gone: { views: 1, bots: 1 } });
  assert.equal(plan.late, 1, 'a view after the cut-off is already split by the server');
  const state = () => ({
    campaignReads: { 'x-folding': { reads: 4, bots: 1, firstAt: 'a', lastAt: 'b' }, unknown: { reads: 9, firstAt: 'a', lastAt: 'b' }, gone: { reads: 1, firstAt: 'a', lastAt: 'b' } },
    campaignPosts: { gone: { code: 'gone', deleted: true } },
  });
  const s = state();
  const result = correct(s, plan, '2026-11-12T10:05:00.000Z');
  // One bot view was already counted apart by the new release; the two older ones join it.
  assert.deepEqual(s.campaignReads['x-folding'], { reads: 2, bots: 3, firstAt: 'a', lastAt: 'b' });
  assert.deepEqual(s.campaignReads.unknown, { reads: 9, firstAt: 'a', lastAt: 'b' }, 'the shared unknown bucket is left as counted');
  assert.deepEqual(s.campaignReads.gone, { reads: 1, firstAt: 'a', lastAt: 'b' }, 'a deleted code is left');
  assert.deepEqual(result, { moved: { 'x-folding': { readsBefore: 4, reads: 2, bots: 3, moved: 2 } }, skipped: { unknown: 1, gone: 1 } });
  assert.deepEqual(s.campaignReadsCorrection, { at: '2026-11-12T10:05:00.000Z', before: '2026-11-12T10:00:00.000Z', moved: { 'x-folding': 2 } });
  assert.throws(() => correct(s, plan, 'later'), /Already corrected/);
  // More bot views in the log than reads stored: refuse, change nothing.
  const short = state(); short.campaignReads['x-folding'].reads = 1;
  assert.throws(() => correct(short, plan, 'now'), /only 1 reads are stored/);
  assert.deepEqual(short, { ...state(), campaignReads: { ...state().campaignReads, 'x-folding': { reads: 1, bots: 1, firstAt: 'a', lastAt: 'b' } } });
});

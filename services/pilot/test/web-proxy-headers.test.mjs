import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// ops/nginx/docker.conf is the web image's nginx (the Dockerfile copies it).
// Two things in it fail silently, so they are checked from the text (13
// November 2026):
//  - A location that proxies to the pilot without X-Forwarded-For hands the
//    pilot the web pod as the caller, or lets a client-sent header stand in
//    for the real address (the pilot counts hops from the right).
//  - nginx drops every inherited add_header in a location that has its own, so
//    each such location must carry the whole security header set again.
const text = readFileSync(new URL('../../../ops/nginx/docker.conf', import.meta.url), 'utf8');

const SET = [
  'X-Content-Type-Options',
  'X-Frame-Options',
  'Referrer-Policy',
  'Permissions-Policy',
  'Content-Security-Policy',
  'Content-Security-Policy-Report-Only',
];

// The server's direct directives and each location's own lines, with nested
// blocks (an `if`) counted as part of the location.
function parse(source) {
  const server = [];
  const locations = [];
  let current = null;
  let depth = 0;
  for (const raw of source.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    const start = /^location\s+(.+?)\s*\{$/.exec(line);
    if (start && !current) {
      current = { name: start[1], lines: [] };
      depth = 1;
      continue;
    }
    if (current) {
      current.lines.push(line);
      depth += opens - closes;
      if (depth === 0) {
        current.lines.pop();
        locations.push(current);
        current = null;
      }
    } else {
      server.push(line);
    }
  }
  assert.equal(current, null, 'every location block is closed');
  return { server, locations };
}

const { server, locations } = parse(text);
const headerNames = (lines) => lines.map((l) => /^add_header\s+(\S+)/.exec(l)?.[1]).filter(Boolean);

test('the parser sees the locations of the file', () => {
  assert.ok(locations.length > 20, `found ${locations.length} locations`);
  assert.ok(locations.some((l) => l.name === '/mcp'));
});

test('every location that proxies to the pilot forwards X-Forwarded-For', () => {
  const proxied = locations.filter((l) => l.lines.some((x) => /^proxy_pass\s+http:\/\/pilot\b/.test(x)));
  assert.ok(proxied.length >= 8, `found ${proxied.length} pilot locations`);
  const missing = proxied
    .filter((l) => !l.lines.includes('proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;'))
    .map((l) => l.name);
  assert.deepEqual(missing, [], 'pilot locations without X-Forwarded-For $proxy_add_x_forwarded_for');
});

test('the server and every location with its own add_header carry the whole security header set', () => {
  assert.deepEqual(SET.filter((h) => !headerNames(server).includes(h)), [], 'server level');
  const own = locations.filter((l) => headerNames(l.lines).length);
  assert.ok(own.length >= 13, `found ${own.length} locations with add_header`);
  for (const l of own) {
    const names = headerNames(l.lines);
    assert.deepEqual(SET.filter((h) => !names.includes(h)), [], `location ${l.name}`);
  }
});

test('the set is never sent twice and HSTS is left to the front door', () => {
  for (const block of [{ name: 'server', lines: server }, ...locations]) {
    const names = headerNames(block.lines).map((n) => n.toLowerCase());
    assert.equal(new Set(names).size, names.length, `${block.name} repeats an add_header name`);
    assert.ok(!names.includes('strict-transport-security'), `${block.name} adds HSTS beside the front door`);
  }
  assert.match(text, /^\s*server_tokens off;/m);
});

// 16 November 2026 (Rahul: "Use UAIN throughout"): uain.global serves the kit and the
// signer by passing BAINK's own files on, so the bytes and checksums are the qualified ones.
test('the kit and signer are served on uain.global from BAINK, read only, with no credentials', () => {
  const files = locations.filter((l) => l.name.startsWith('~ ^/(?:uain-agent') || l.name.startsWith('~ ^/kit/'));
  assert.equal(files.length, 2, 'one location for the kit and signer, one for versioned kit files');
  const re = (l) => new RegExp(l.name.replace(/^~\s+/, ''));
  for (const path of ['/uain-agent.mjs', '/uain-agent.mjs.sha256', '/uain_signer.py', '/uain_signer.py.sha256'])
    assert.ok(re(files[0]).test(path), path);
  for (const path of ['/kit/latest.json', '/kit/uain-agent-0.9.12.mjs', '/kit/uain-agent-0.9.12.mjs.sha256'])
    assert.ok(re(files[1]).test(path), path);
  for (const path of ['/uain-agent.mjs.bak', '/kit/../mcp', '/kit/other.mjs', '/uain_signer.pyc'])
    assert.ok(!files.some((l) => re(l).test(path)), path + ' is not passed on');
  for (const l of files) {
    for (const line of [
      'limit_except GET { deny all; }',
      'set $baink_files https://baink.money;',
      'proxy_pass $baink_files$uri;',
      'proxy_ssl_verify on;',
      'proxy_set_header Host baink.money;',
      'proxy_set_header Cookie "";',
      'proxy_set_header Authorization "";',
      'proxy_hide_header Set-Cookie;',
      'proxy_set_header X-Forwarded-For "";',
    ]) assert.ok(l.lines.includes(line), `${l.name}: ${line}`);
    assert.ok(!l.lines.some((x) => x.includes('$proxy_add_x_forwarded_for')), `${l.name} passes on no client-sent X-Forwarded-For`);
    assert.equal(headerNames(l.lines).length, 0, 'BAINK\'s own Cache-Control passes through; the site-wide security headers are inherited');
  }
  // A regex location is matched in file order: these come before any other that could take .mjs or .py.
  const first = locations.findIndex((l) => l.name.startsWith('~'));
  assert.ok(locations.indexOf(files[0]) <= first + 1 && locations.indexOf(files[1]) <= first + 1, 'the file locations are the first regex locations');
});

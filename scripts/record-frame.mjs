#!/usr/bin/env node
/**
 * Cuts the site's frame into fragments for the pages the connection server
 * renders (10 November 2026). Run after `vinext build` (package.json build:web).
 *
 * app/network/record-frame is the network layout with nothing in it. From its
 * built page this writes, under <dist>/_record-frame/:
 *
 *   head.html                 style sheet links, font preloads, the font faces,
 *                             and the font variables the layout sets on <body>
 *   header.html               the skip link and the site header
 *   header-tasks.html,        the same with the matching navigation link marked
 *   header-projects.html,     as the current page
 *   header-members.html
 *   footer.html               the site footer
 *   unavailable.html          a whole page for nginx to send when the
 *                             connection server does not answer (502, 504)
 *
 * and removes the frame page itself, so it is never served as a page. The web
 * nginx splices the fragments into the server's pages (ssi in
 * ops/nginx/docker.conf); the server sends its plain template in their place
 * when they are missing. Any piece that cannot be found stops the build, so a
 * changed layout cannot ship a broken frame unnoticed.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const dist = process.argv[2] ?? 'dist/client';
const source = join(dist, 'network', 'record-frame.html');
const html = await readFile(source, 'utf8');

function fail(message) {
  console.error(`record-frame: ${message} (${source})`);
  process.exit(1);
}

function between(text, start, end, what) {
  const i = text.indexOf(start);
  if (i < 0) fail(`no ${what}`);
  const j = text.indexOf(end, i);
  if (j < 0) fail(`no end of ${what}`);
  return text.slice(i, j + end.length);
}

const head = html.slice(0, html.indexOf('</head>'));
if (!head) fail('no </head>');
const sheets = [...head.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/g)].map((m) => m[0]);
if (!sheets.length) fail('no style sheet links');
const preloads = [...head.matchAll(/<link\b[^>]*\brel="preload"[^>]*\bas="font"[^>]*>/g)].map((m) => m[0]);
const fonts = head.match(/<style data-vinext-fonts>[\s\S]*?<\/style>/)?.[0];
if (!fonts) fail('no font faces');
// The layout puts the font variables on <body> by class; the server's <body>
// has no classes, so set the same declarations on body directly.
const bodyClasses = (html.match(/<body\b[^>]*\bclass="([^"]*)"/)?.[1] ?? '').split(/\s+/).filter(Boolean);
const variables = [];
for (const name of bodyClasses) {
  const rule = fonts.match(new RegExp(`\\.${name.replace(/[^\w-]/g, '')}\\s*\\{([^}]*)\\}`));
  if (rule) variables.push(rule[1].trim());
}
if (!variables.some((v) => v.includes('--font-geist-sans'))) fail('no font variable for the body');
const headFragment = [...sheets, ...preloads, fonts, `<style>body{${variables.join(' ')}}</style>`].join('\n');

const body = html.slice(html.indexOf('<body'));
const skip = between(body, '<a class="skip-link"', '</a>', 'skip link');
const header = between(body, '<header class="masthead', '</header>', 'site header');
const footer = between(body, '<footer class="site-footer', '</footer>', 'site footer');
for (const [name, part] of [['header', header], ['footer', footer]])
  if (/<script\b/i.test(part)) fail(`a script in the ${name}`);

/** Marks the navigation links to `path` (desktop and phone menus) as the current page. */
function current(part, path) {
  const marked = part.replace(
    new RegExp(`<a((?![^>]*aria-current)[^>]*\\bhref="${path}")`, 'g'),
    '<a aria-current="page"$1',
  );
  if (marked === part) fail(`no navigation link to ${path}`);
  return marked;
}

const unavailable = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Temporarily unavailable — United AI Network</title><meta name="robots" content="noindex">
<link rel="icon" href="/favicon.svg">
${headFragment}
</head><body>${skip}${header}<main id="main" class="record-page"><div class="page-shell record-notice">
<header class="np-pagehead"><div><p class="np-kicker">United AI Network</p><h1>This page cannot be read right now</h1>
<p class="record-lead">The public record behind this page is not answering. Please try again in a minute. Nothing older or invented is shown in its place.</p></div></header>
<section class="record-card"><p><a href="/status">See what is working</a></p><p><a href="/">Back to the homepage</a></p></section>
</div></main>${footer}</body></html>
`;

const out = join(dist, '_record-frame');
await mkdir(out, { recursive: true });
const files = {
  'head.html': headFragment,
  'header.html': skip + header,
  'header-tasks.html': skip + current(header, '/tasks'),
  'header-projects.html': skip + current(header, '/network/projects'),
  'header-members.html': skip + current(header, '/network/directory'),
  'footer.html': footer,
  'unavailable.html': unavailable,
};
for (const [name, text] of Object.entries(files)) await writeFile(join(out, name), text + '\n');
await rm(source);
await rm(join(dist, 'network', 'record-frame.txt'), { force: true });
console.log(`record-frame: wrote ${Object.keys(files).length} fragments to ${out} (${sheets.length} style sheets)`);

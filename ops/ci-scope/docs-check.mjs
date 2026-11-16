#!/usr/bin/env node
/**
 * Fast check for a prose-only change (ops/ci-scope/classify.mjs mode `prose`):
 * secret patterns, merge-conflict markers and relative links that point at
 * nothing. Only the lines the change adds are checked, so an old broken link
 * elsewhere in a long register never blocks an unrelated edit.
 *
 *   git diff -U0 --no-color --no-renames BASE HEAD > change.patch
 *   node docs-check.mjs --repo <checkout> --diff change.patch
 *
 * Self-contained (node built-ins only); the workflows run the base branch's
 * copy in a no-network, read-only container.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SECRET_PATTERNS = [
  ['private key block', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Slack webhook', /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{8,}/],
  ['Anthropic or OpenAI key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['private JWK member', /"d"\s*:\s*"[A-Za-z0-9_-]{43,}"/],
];

const CONFLICT = /^(?:<{7}|>{7})(?: |$)|^={7}$/;
const LINK = /!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

/** Added lines per file from a `git diff -U0` patch. */
export function addedLines(patch) {
  const files = new Map();
  let current = null;
  let line = 0;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const target = raw.slice(4).trim();
      current = target === '/dev/null' ? null : target.replace(/^b\//, '');
      if (current && !files.has(current)) files.set(current, []);
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (current && raw.startsWith('+')) {
      files.get(current).push({ line, text: raw.slice(1) });
      line += 1;
    }
  }
  return files;
}

/** Relative link targets that do not exist in the checkout. */
export function brokenLinks(file, text, exists) {
  const broken = [];
  for (const m of text.matchAll(LINK)) {
    let target = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('//')) continue;
    target = target.split('#')[0].split('?')[0];
    if (!target) continue;
    try {
      target = decodeURIComponent(target);
    } catch {
      broken.push(m[1]);
      continue;
    }
    const resolved = target.startsWith('/') ? normalize(target.slice(1)) : normalize(join(dirname(file), target));
    if (resolved.startsWith('..') || !exists(resolved)) broken.push(m[1]);
  }
  return broken;
}

export function check(patch, exists) {
  const problems = [];
  for (const [file, lines] of addedLines(patch)) {
    let fence = false;
    for (const { line, text } of lines) {
      for (const [name, re] of SECRET_PATTERNS) {
        if (re.test(text)) problems.push(`${file}:${line}: possible ${name}; never commit credentials`);
      }
      if (CONFLICT.test(text)) problems.push(`${file}:${line}: merge-conflict marker`);
      if (/^\s*(```|~~~)/.test(text)) fence = !fence;
      if (!fence && file.endsWith('.md')) {
        for (const target of brokenLinks(file, text, exists)) problems.push(`${file}:${line}: link target not found: ${target}`);
      }
    }
  }
  return problems;
}

export async function checkReleaseStatus(patch, repo) {
  // Inspect Git headers as well as old/new markers: empty and binary additions
  // have no hunks, and deleted records still need their remaining pointers
  // checked. The prose classifier does not admit changes to the renderer;
  // this is the existing unchanged, built-ins-only validator in the read-only,
  // network-disabled checkout. build() neither observes production nor writes.
  if (!/^(?:diff --git a\/docs\/releases\/|(?:---|\+\+\+) [ab]\/docs\/releases\/)/m.test(patch)) return [];
  try {
    const { build } = await import(pathToFileURL(join(repo, 'ops/docs/render-status.mjs')).href);
    const expected = build(repo);
    if (readFileSync(join(repo, 'docs/releases/CURRENT.md'), 'utf8') !== expected) throw Error('stale');
    return [];
  } catch {
    // Do not echo invalid field values, record contents or parser exceptions.
    return ['release status: invalid records, evidence, pointers or generated view; run node ops/docs/render-status.mjs --check'];
  }
}

async function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const repo = arg('--repo');
  const diff = arg('--diff');
  if (!repo || !diff) {
    process.stderr.write('usage: docs-check.mjs --repo <checkout> --diff <patch>\n');
    process.exit(2);
  }
  const patch = readFileSync(diff, 'utf8');
  const problems = check(patch, (p) => existsSync(join(repo, p)));
  if (!problems.length) problems.push(...await checkReleaseStatus(patch, repo));
  for (const p of problems) process.stdout.write(`::error::${p}\n`);
  process.stdout.write(problems.length ? `docs check: ${problems.length} problem(s)\n` : 'docs check: added lines have no secret patterns, conflict markers or broken relative links\n');
  process.exit(problems.length ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main(process.argv.slice(2));

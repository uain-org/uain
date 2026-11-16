#!/usr/bin/env node
// Fails when a *.test.mjs file under a package is not selected by that
// package's `npm test` globs, so a new test directory cannot silently drop out
// of CI (16 BAINK files had, until 9 November 2026).
//
//   node ops/ci/test-globs-check.mjs apps/baink
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';

const root = process.argv[2];
if (!root) throw new Error('usage: test-globs-check.mjs <package directory>');
const script = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts?.test ?? '';
const selected = new Set();
for (const word of script.split(/\s+/)) {
  const match = /^(?:(.+)\/)?\*\.test\.mjs$/.exec(word);
  if (match) selected.add(match[1] ?? '.');
}
if (!selected.size) throw new Error(`${root}: npm test selects no *.test.mjs glob`);
const missing = [];
for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.test.mjs')) continue;
  const file = relative(root, join(entry.parentPath ?? entry.path, entry.name));
  if (file.split('/').includes('node_modules')) continue;
  if (!selected.has(dirname(file))) missing.push(file);
}
if (missing.length) {
  console.error(`${root}: npm test does not select:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
console.log(`${root}: npm test selects every *.test.mjs (${selected.size} directories)`);

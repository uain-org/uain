#!/usr/bin/env node
// The build id an image carries, and how to read one back.
//
//   node ops/docs/build-id.mjs <component> <file>
//
// writes {"schema":1,"component":…,"commit":…,"built_at":…} to <file>. The
// website build puts it at /build.json (package.json build:web) and the
// connection server's image at /app/build.json, served as /api/build
// (services/pilot/Dockerfile). `commit` is the source commit the image was
// built from, given as UAIN_SOURCE_COMMIT (a docker --build-arg); without it
// the image does not know its commit and says null. Nothing is guessed.
//
// `node ops/docs/render-status.mjs --observe` reads both back (its
// parseBuildId) to observe the `uain` component. This file stays
// self-contained: the connection server's image copies it alone.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUILD_ID_SCHEMA = 1;
const COMMIT = /^[0-9a-f]{40}$/;
const COMPONENT = /^[a-z][a-z0-9-]{0,39}$/;

/** The record for a build made now. An absent or malformed commit is null. */
export function buildId(component, { env = process.env, now = () => new Date() } = {}) {
  if (!COMPONENT.test(component ?? '')) throw new Error('component must be a short lower-case name');
  const given = String(env.UAIN_SOURCE_COMMIT ?? '').trim();
  return {
    schema: BUILD_ID_SCHEMA,
    component,
    commit: COMMIT.test(given) ? given : null,
    built_at: now().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

export function main(argv, { env = process.env, now, stderr = process.stderr } = {}) {
  const [component, file] = argv;
  if (argv.length !== 2 || !file) {
    stderr.write('usage: node ops/docs/build-id.mjs <component> <file>\n');
    return 2;
  }
  let record;
  try {
    record = buildId(component, { env, now });
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 2;
  }
  if (String(env.UAIN_SOURCE_COMMIT ?? '').trim() && record.commit === null)
    stderr.write('build id: UAIN_SOURCE_COMMIT is not a 40-hex commit; writing commit null\n');
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o644 });
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));

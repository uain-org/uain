// The files BAINK serves for the one-file kit, all made from the same bytes at build time
// (10 November 2026: a tester's guide carried a checksum that no longer matched the download).
//
//   uain-agent.mjs                      the current kit (as before)
//   uain-agent.mjs.sha256               its SHA-256, in `shasum -c` form
//   kit/uain-agent-<version>.mjs        the same bytes at an address that names the version
//   kit/uain-agent-<version>.mjs.sha256 its SHA-256
//   kit/latest.json                     {version, file, sha256, bytes}: what a guide points to
//
// Guides point to these instead of writing a digest by hand. A version's bytes never change:
// agent-kit/versions.json records each released version's digest, and kit-files.test.mjs fails
// when the kit changes without a new version.
import { createHash } from 'node:crypto';

export const kitVersion = (bytes) => /^const VERSION = '(\d+\.\d+\.\d+)';$/m.exec(Buffer.from(bytes).toString('utf8'))?.[1] ?? null;
export const kitSha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** [fileName, content] pairs for the build. */
export function kitFiles(bytes) {
  const version = kitVersion(bytes), sha256 = kitSha256(bytes);
  if (!version) throw new Error('The kit has no VERSION line.');
  const named = `kit/uain-agent-${version}.mjs`;
  return [
    ['uain-agent.mjs', bytes],
    ['uain-agent.mjs.sha256', `${sha256}  uain-agent.mjs\n`],
    [named, bytes],
    [`${named}.sha256`, `${sha256}  uain-agent-${version}.mjs\n`],
    ['kit/latest.json', JSON.stringify({ schema: 'uain-agent-kit-v1', version, file: named, sha256, bytes: Buffer.byteLength(bytes) }, null, 2) + '\n'],
  ];
}

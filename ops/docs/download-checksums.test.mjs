/**
 * Each archive in public/downloads/ has a SHA-256 file beside it, in the format
 * `shasum -a 256 -c` reads ("<digest>  <file name>"), and the two agree. A zip
 * that changes without its checksum (or a checksum with no zip) fails here.
 *
 * Verify a download the same way:
 *   curl -fsSLO https://uain.global/downloads/<name>.zip
 *   curl -fsSL https://uain.global/downloads/<name>.zip.sha256 | shasum -a 256 -c
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../../public/downloads/', import.meta.url));
const files = readdirSync(dir);
const zips = files.filter((name) => name.endsWith('.zip'));

test('there are archives to check', () => {
  assert.ok(zips.length >= 2, 'public/downloads/ holds the two published archives');
});

for (const zip of zips) {
  test(`${zip} agrees with ${zip}.sha256`, () => {
    assert.ok(files.includes(`${zip}.sha256`), `${zip} has no ${zip}.sha256 beside it`);
    const line = readFileSync(join(dir, `${zip}.sha256`), 'utf8');
    const match = /^([0-9a-f]{64}) {2}([^\s/\\]+)\n$/.exec(line);
    assert.ok(match, `${zip}.sha256 is not one "<digest>  <file name>" line`);
    assert.equal(match[2], zip, `${zip}.sha256 names another file`);
    const actual = createHash('sha256').update(readFileSync(join(dir, zip))).digest('hex');
    assert.equal(match[1], actual, `${zip} no longer matches ${zip}.sha256`);
  });
}

test('every checksum file belongs to an archive that is there', () => {
  for (const name of files.filter((n) => n.endsWith('.sha256')))
    assert.ok(zips.includes(name.slice(0, -'.sha256'.length)), `${name} has no archive beside it`);
});

// Base images and package keys (security review IN-12 and IN-10, 15 November 2026).
// Every image this repository builds from, or runs on the production app host from
// its workflows and scripts, is pinned by digest, so a moved tag cannot change what
// is built or run without a reviewed change. Files other owners keep (the compose
// files, custody's tooling) are not covered here.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8');
// The CI sandbox has no .git, so the tree is walked (dependencies and outputs skipped).
const SKIP = new Set(['node_modules', '.git', 'target', 'dist', '.next', '.cache', 'vendor', 'build']);
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { if (!SKIP.has(entry.name)) walk(join(dir, entry.name), out); }
    else if (entry.isFile()) out.push(relative(root, join(dir, entry.name)));
  }
  return out;
}
const tracked = walk(root);
const DIGEST = /@sha256:[0-9a-f]{64}\b/;

test('every Dockerfile builds from images pinned by digest', () => {
  const dockerfiles = tracked.filter((f) => /(^|\/)Dockerfile$/.test(f));
  assert.ok(dockerfiles.includes('Dockerfile') && dockerfiles.includes('services/pilot/Dockerfile')
    && dockerfiles.includes('apps/waitlist-dashboard/Dockerfile'), dockerfiles.join(' '));
  for (const file of dockerfiles) {
    const stages = new Set();
    for (const line of read(file).split('\n')) {
      const from = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$/i.exec(line);
      if (!from) continue;
      if (!stages.has(from[1])) assert.match(from[1], DIGEST, `${file}: ${line.trim()} is not pinned by digest`);
      if (from[2]) stages.add(from[2]);
    }
  }
});

// The image names the host runs, with a tag: each must carry a digest as well.
const IMAGE = /\b(?:node:\d[\w.-]*|postgres:\d[\w.-]*|nginxinc\/nginx-unprivileged:[\w.-]+|pgvector\/pgvector:[\w.-]+)(@sha256:[0-9a-f]{64})?/g;
const RUN_ON_HOST = (f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f) || /^ops\/(ci|backup|remote-test)\/[^/]+\.(sh|py)$/.test(f)
  || /^deploy\/k8s\/.+\.sh$/.test(f);

test('every image the workflows and host scripts run is pinned by digest', () => {
  const files = tracked.filter(RUN_ON_HOST);
  assert.ok(files.includes('.github/workflows/deploy.yml') && files.includes('ops/backup/backup.sh'));
  let seen = 0;
  for (const file of files) {
    read(file).split('\n').forEach((line, i) => {
      if (/^\s*#/.test(line)) return; // prose
      for (const m of line.matchAll(IMAGE)) {
        seen += 1;
        assert.ok(m[1], `${file}:${i + 1}: ${m[0]} is not pinned by digest`);
      }
    });
  }
  assert.ok(seen >= 8, `found ${seen} image references`);
});

test('the web and waitlist images run as a numeric user the pod can check', () => {
  for (const file of ['Dockerfile', 'apps/waitlist-dashboard/Dockerfile']) {
    const users = read(file).split('\n').map((l) => /^\s*USER\s+(\S+)\s*$/.exec(l)?.[1]).filter(Boolean);
    assert.match(users.at(-1) ?? '', /^[1-9]\d*(:\d+)?$/, `${file}: the final USER is numeric and not root`);
  }
});

test('the CI runtime installs the PostgreSQL package key only after checking its fingerprint', () => {
  const text = read('ops/ci/Dockerfile');
  const fingerprint = text.indexOf("f == \"B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8\"");
  const installed = text.indexOf('install -m 0644 /tmp/pgdg.asc /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc');
  assert.ok(fingerprint > 0, 'the fingerprint is checked');
  assert.match(text, /\$1 == "pub" \{ n\+\+ \}.*n == 1/, 'exactly one primary key');
  assert.ok(installed > fingerprint, 'the key is installed after the check');
  assert.doesNotMatch(text, /ACCC4CF8\.asc\s*\\?\s*\n?\s*-o \/usr\/share/, 'the key is never downloaded straight into the keyring');
  assert.match(text, /signed-by=\/usr\/share\/postgresql-common\/pgdg\/apt\.postgresql\.org\.asc/);
});

#!/usr/bin/env node
// Checks that the kit BAINK serves and the checksums it publishes beside it agree (10 November 2026:
// a tester's setup guide carried a checksum that differed from the download).
//
//   node apps/baink/ops/kit-digest-check.mjs [base]       (default https://baink.money)
//
// Reads, no signature: /uain-agent.mjs, /uain-agent.mjs.sha256, /kit/latest.json, the versioned copy it
// names and that copy's .sha256. Fails (exit 1) when any published digest differs from the served bytes,
// when the served VERSION differs from latest.json, or when agent-kit/versions.json records a different
// digest for that version. Prints one JSON line.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const versionOf = (bytes) => /^const VERSION = '(\d+\.\d+\.\d+)';$/m.exec(Buffer.from(bytes).toString('utf8'))?.[1] ?? null;
const digestOf = (text) => /^([a-f0-9]{64}) {2}\S+\n?$/.exec(text)?.[1] ?? null;

export async function checkKitDigests(base, { fetchImpl = fetch, recorded = null } = {}) {
  const problems = [];
  const get = async (path) => {
    const res = await fetchImpl(new URL(path, base), { headers: { 'cache-control': 'no-cache' } });
    if (res.status !== 200) { problems.push(`${path} answered ${res.status}`); return null; }
    return Buffer.from(await res.arrayBuffer());
  };
  const kit = await get('/uain-agent.mjs');
  const sum = await get('/uain-agent.mjs.sha256');
  const latestBytes = await get('/kit/latest.json');
  const out = { base, ok: false };
  if (!kit || !sum || !latestBytes) return { ...out, problems };
  const digest = sha(kit), version = versionOf(kit);
  Object.assign(out, { version, sha256: digest, bytes: kit.length });
  if (digestOf(sum.toString('utf8')) !== digest) problems.push('/uain-agent.mjs.sha256 does not match the served /uain-agent.mjs');
  let latest = null;
  try { latest = JSON.parse(latestBytes.toString('utf8')); } catch { problems.push('/kit/latest.json is not JSON'); }
  if (latest) {
    if (latest.version !== version) problems.push(`/kit/latest.json names ${latest.version}; the served kit reads ${version}`);
    if (latest.sha256 !== digest) problems.push('/kit/latest.json sha256 does not match the served /uain-agent.mjs');
    if (latest.bytes !== kit.length) problems.push('/kit/latest.json bytes does not match the served /uain-agent.mjs');
    if (typeof latest.file === 'string' && /^kit\/uain-agent-\d+\.\d+\.\d+\.mjs$/.test(latest.file)) {
      const named = await get('/' + latest.file), namedSum = await get(`/${latest.file}.sha256`);
      if (named && sha(named) !== digest) problems.push(`/${latest.file} differs from /uain-agent.mjs`);
      if (namedSum && digestOf(namedSum.toString('utf8')) !== digest) problems.push(`/${latest.file}.sha256 does not match the served bytes`);
    } else problems.push('/kit/latest.json names no versioned file');
  }
  if (recorded && version && recorded[version] && recorded[version] !== digest) problems.push(`agent-kit/versions.json records a different digest for ${version}`);
  if (recorded && version && !recorded[version]) problems.push(`agent-kit/versions.json has no line for ${version}`);
  return { ...out, ok: problems.length === 0, problems };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const recorded = JSON.parse(readFileSync(new URL('../agent-kit/versions.json', import.meta.url), 'utf8')).versions;
  const result = await checkKitDigests(process.argv[2] ?? 'https://baink.money', { recorded });
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

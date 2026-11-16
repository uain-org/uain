#!/usr/bin/env node
/** Offline publication helper. Inputs must be explicitly selected, reviewed public
 * policy JSON. Never point at a custody profile, private prompts or key material.
 * No signing, native commands, network calls or production writes. */
import { open, writeFile } from 'node:fs/promises';
import { validatePublicRequirements, publicPolicyDigest } from '../server/central-task-requirements.mjs';
const [out, taskFile, policyFile, expectedPolicyDigest, chainId, genesisSha256] = process.argv.slice(2);
if (!/^[A-Za-z0-9._-]{1,96}$/.test(chainId??'') || !/^[a-f0-9]{64}$/.test(genesisSha256??'') || !out || !taskFile || !policyFile || !/^[a-f0-9]{64}$/.test(expectedPolicyDigest ?? ''))
  throw Error('Usage: export-task-requirements.mjs NEW_OUTPUT TASK_JSON REVIEWED_POLICY_JSON EXPECTED_REVIEWER_POLICY_DIGEST CHAIN_ID GENESIS_SHA256');
async function json(path) {
  const f = await open(path, 'r');
  try { const stat = await f.stat(); if (!stat.isFile() || stat.size < 1 || stat.size > 1024 * 1024) throw Error('Input must be bounded public JSON.');
    const b = Buffer.alloc(stat.size + 1); let n = 0;
    while (n < b.length) { const r = await f.read(b, n, b.length - n, null); if (!r.bytesRead) break; n += r.bytesRead; }
    if (n !== stat.size) throw Error('Input changed while reading.'); return JSON.parse(b.subarray(0,n).toString('utf8'));
  } finally { await f.close(); }
}
const task = await json(taskFile);
const policy = await json(policyFile);
if (publicPolicyDigest(policy) !== expectedPolicyDigest) throw Error('Policy differs from the reviewed verifier digest.');
const row = validatePublicRequirements({ taskId: task.id, projectId: task.project,
  criteriaDigest: task.acceptance_digest, evidenceDigest: task.evidence_digest,
  policyDigest: expectedPolicyDigest, policy });
await writeFile(out, JSON.stringify({schema:'baink-public-task-requirements-v1', chainId, genesisSha256, tasks:[row]}, null, 2)+'\n', {flag:'wx',mode:0o600});

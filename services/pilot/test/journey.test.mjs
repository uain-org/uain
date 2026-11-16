import assert from 'node:assert/strict';
import { createHash, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { boot } from './helpers.mjs';

// One complete local product journey with distinct operator fixtures. Explicit
// bootstrap roles are test setup, not evidence of independent pilot adoption.
test('authenticated project work, observed reproduction, settlement, belief and signed ledger form one verified journey', async () => {
  const t = await boot();
  try {
    const lead = await t.member('Journey project owner');
    const worker = await t.member('Journey research operator');
    const v1 = await t.member('Journey independent fixture A');
    const v2 = await t.member('Journey independent fixture B');
    const anonymous = await t.connect();
    const denied = await anonymous.call('uain_propose', { title: 'Denied', summary: 'Unauthenticated', stop_conditions: ['Halt.'] });
    assert.ok(denied.error || denied.isError, JSON.stringify(denied));
    const session = await t.instance(worker.key, 'Journey research operator', 'Second research agent');
    assert.equal((await session.call('uain_whoami')).member.address, worker.key.address);
    const project = await lead.call('uain_propose', { title: 'Controlled sum rehearsal', summary: 'Reproduce only local public fixtures.', stop_conditions: ['Halt if restricted data or external execution is needed.'] });
    assert.equal(project.opened, true);
    for (const member of [worker, v1, v2]) assert.equal((await member.call('uain_join_project', { project_id: project.project.id })).error, undefined);
    const opened = await lead.call('uain_task_open', { project_id: project.project.id, title: 'Sum fixture', question: 'What is the sum?', done_when: 'A pinned reproduction reports 42.', how_to_check: 'Run the fixed local program against the pinned dataset.', karma_offered: 20 });
    assert.equal(opened.ok, true);
    assert.ok((await worker.call('uain_next', { project_id: project.project.id })).items.some(i => i.task_id === opened.task.id));
    assert.equal((await worker.call('uain_task_start', { task_id: opened.task.id })).error, undefined);
    const program = fileURLToPath(new URL('./fixtures/reproduce-sum.mjs', import.meta.url));
    const data = fileURLToPath(new URL('./fixtures/reproduction-numbers.txt', import.meta.url));
    const artifacts = [['program', program, 'code'], ['dataset', data, 'dataset']].map(([label, path, role]) => ({ label, manifest: { version: 1, uri: `https://artifacts.example/${label}`, sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), bytes: readFileSync(path).length, media_type: role === 'code' ? 'text/javascript' : 'text/plain', license: 'LicenseRef-TestFixture', role } }));
    const recipe = { version: 1, inputs: ['program', 'dataset'], command: 'node sum.mjs numbers.txt', environment: 'Node.js >=22.13; no external dependencies', seed: 'none', outputs: [{ metric: 'sum', expected: 42, absolute_tolerance: 0 }] };
    const contribution = await worker.call('uain_contribute', { project_id: project.project.id, task_id: opened.task.id, title: 'Pinned sum', detail: 'Add the fixture numbers.', claim: 'The controlled fixture sums to 42.', artifacts, reproduction: recipe, karma_claimed: 99 });
    assert.equal(contribution.submitted, true, JSON.stringify(contribution));
    assert.equal(contribution.contribution.karma_claimed, 20);
    const observed = JSON.parse(execFileSync(process.execPath, [program, data], { encoding: 'utf8' }));
    assert.equal(observed.sum, 42);
    const receipt = { version: 1, manifest_digest: contribution.contribution.artifact_manifest_digest, outcome: 'reproduced', command: recipe.command, environment: process.version, seed: 'none', inputs: artifacts.map(a => ({ label: a.label, status: 'matched', observed_sha256: a.manifest.sha256, observed_bytes: a.manifest.bytes })), outputs: [{ metric: 'sum', observed: observed.sum }], detail: 'Executed the fixed local fixture.' };
    const first = await v1.call('uain_verify', { contribution_id: contribution.contribution.id, verdict: 'confirmed', note: 'Checked pinned inputs and observed output.', reproduction_receipt: receipt });
    assert.equal(first.settled, false);
    const second = await v2.call('uain_verify', { contribution_id: contribution.contribution.id, verdict: 'confirmed', note: 'Checked pinned inputs and observed output.', reproduction_receipt: receipt });
    assert.equal(second.settled, true, JSON.stringify(second));
    assert.equal(second.contribution.karma_awarded, 20);
    assert.equal(second.claim.status, 'believed');
    assert.equal((await worker.call('uain_claims', { claim_id: second.claim.id })).statement, 'The controlled fixture sums to 42.');
    const balance = await worker.call('uain_balance');
    assert.equal(balance.credibility, 20);
    assert.equal((await worker.call('uain_whoami')).participant.credits, 20);
    const repeated = await v2.call('uain_verify', { contribution_id: contribution.contribution.id, verdict: 'confirmed', note: 'Retry.', reproduction_receipt: receipt });
    assert.equal(repeated.error, 'already_settled');
    assert.equal((await worker.call('uain_balance')).credibility, 20);
    const ledger = await import('../dist/src/ledger/ledger.js');
    let events = await t.db.prepare('SELECT * FROM events ORDER BY id').all();
    assert.equal(ledger.verifyChain(events).ok, true);
    assert.ok(events.some(e => e.summary.includes(contribution.contribution.artifact_manifest_digest)));
    // Advance the fixture ledger into a completed UTC day, then recompute the
    // hash chain because event timestamps are part of committed content.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    await t.db.prepare('UPDATE events SET at = ?, hash = NULL, prev_hash = NULL').run(yesterday);
    await t.db.backfillEventHashes();
    events = await t.db.prepare('SELECT * FROM events ORDER BY id').all();
    assert.equal(ledger.verifyChain(events).ok, true);
    const day = yesterday.slice(0, 10);
    const root = await (await t.http(`/api/ledger/roots/${day}`)).json();
    const trusted = createPublicKey(readFileSync(join(process.env.UAIN_DATA_DIR, 'ledger.key'))).export({ format: 'pem', type: 'spki' }).toString();
    assert.equal(root.provisional, false);
    assert.equal(root.count, events.length);
    assert.equal(ledger.verifyRootSignature(root, trusted), true);
    assert.equal(ledger.verifyRootSignature({ ...root, head: 'f'.repeat(64) }, trusted), false);
    const proof = await (await t.http(`/api/ledger/proof/${events.at(-1).id}`)).json();
    assert.equal(ledger.verifyProof(proof.leaf, proof.proof, root.root), true);
    const health = await t.http('/api/ready'); assert.equal(health.status, 200);
    console.log('Journey passed: HTTP/MCP identity → priced task → pinned receipt → single settlement → believed claim → signed final root and inclusion proof.');
  } finally { await t.close(); }
});

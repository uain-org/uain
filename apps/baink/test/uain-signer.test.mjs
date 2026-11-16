// The no-install signer (shared/uain_signer.py) against the kit and the shared golden files:
// the same canonical bytes, the same Ed25519 signatures, and refusals for anything that is not
// an earning step. Both Ed25519 backends are checked: the library and the pure-Python fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, generateKeyPairSync, verify, createPublicKey } from 'node:crypto';
import * as kit from '../agent-kit/uain-agent.mjs';
import { centralEarningSigningBytes } from '../server/central-earning-command.mjs';
import { signerSandbox, kw } from './signer-driver.mjs';

const SIGNER = readFileSync(new URL('../shared/uain_signer.py', import.meta.url), 'utf8');
const golden = (name) => JSON.parse(readFileSync(new URL(`../../../fixtures/contracts/${name}`, import.meta.url), 'utf8'));
const sha = (v) => createHash('sha256').update(v).digest('hex');
const { webcrypto: { subtle } } = await import('node:crypto');

/** A kit identity from a fresh seed, as the kit's identity file holds it. */
async function kitIdentity() {
  const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  const privateKey = await subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x, d: jwk.d, ext: false, key_ops: ['sign'] }, 'Ed25519', false, ['sign']);
  const raw = Buffer.from(jwk.x, 'base64url');
  const publicKey = await subtle.importKey('raw', raw, 'Ed25519', true, ['verify']);
  return { seed: jwk.d, x: jwk.x, privateKey, publicKey, publicKeyBase64: raw.toString('base64'), address: 'uain1' + sha(raw).slice(0, 40) };
}

test('canonical forms and command bytes equal the golden files, and edge inputs are refused like the kit', (t) => {
  const py = signerSandbox(t, SIGNER);
  const json = golden('canonical-json.json');
  for (const v of json.chain.vectors) assert.equal(py('native_json', JSON.parse(v.json)), v.canonical, v.name);
  for (const v of json.organization.vectors) assert.equal(py('plain_json', JSON.parse(v.json)), v.canonical, v.name);
  for (const v of json.chain.edge_inputs) if (v.outcomes['js-baink'] === 'refused') assert.throws(() => py('native_json', JSON.parse(v.json)), /Nothing was signed|differs/, v.name);
  const commands = golden('command-signing.json');
  for (const v of commands.vectors) {
    const bytes = Buffer.from(py('command_bytes', v.command).hex, 'hex');
    assert.equal(bytes.toString('utf8'), v.signing_bytes, v.name);
    assert.equal(sha(bytes), v.sha256, v.name);
    assert.deepEqual(bytes, Buffer.from(kit.commandBytes(v.command)), v.name);
  }
  for (const v of commands.edge_commands) if (v.outcomes['js-baink'] === 'refused') assert.throws(() => py('command_bytes', v.command), /Nothing was signed|differs|expiry/, v.name);
});

for (const pure of [false, true]) {
  test(`${pure ? 'pure-Python' : 'library'} Ed25519: keys, request signatures and prepared-step signatures equal the kit byte for byte`, async (t) => {
    const py = signerSandbox(t, SIGNER, { pure });
    const backend = py.raw('identity', (await kitIdentity()).seed).ed25519;
    // python3-cryptography is installed in the check image; the pure branch is forced here.
    if (pure) assert.equal(backend, 'pure-python');
    else t.diagnostic(`Ed25519 backend: ${backend}`);
    for (let n = 0; n < 3; n++) {
      const me = await kitIdentity();
      const id = py('identity', me.seed);
      assert.deepEqual([id.address, id.publicKey, id.publicKeyUrl], [me.address, me.publicKeyBase64, me.x]);
      // A signed request: the same message as the kit's api() and a signature the server's check accepts.
      const body = { operation: 'central_submit', payload: { id: 'CS-x', task: 'T-1', evidence: 'é <&> \u2028 line\nnext', evidence_digest: 'a'.repeat(64) } };
      const args = py('sign_request', me.seed, 'POST', '/api/native/central/prepare', body, kw({ audience: 'https://baink.money', now_ms: 1762000000000, nonce: 'n'.repeat(32) }));
      const message = kit.plainJSON({ audience: 'https://baink.money', method: 'POST', path: '/api/native/central/prepare', body, nonce: 'n'.repeat(32), timestamp: '1762000000000' });
      const kitSignature = Buffer.from(await subtle.sign('Ed25519', me.privateKey, new TextEncoder().encode(message))).toString('base64');
      assert.equal(args.signature, kitSignature);
      assert.deepEqual(Object.keys(args).sort(), ['body', 'method', 'nonce', 'path', 'publicKey', 'signature', 'timestamp']);
      assert.ok(verify(null, Buffer.from(message), createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: me.x }, format: 'jwk' }), Buffer.from(args.signature, 'base64')));
      const get = py('sign_request', me.seed, 'get', '/api/native/central/status');
      assert.equal(get.method, 'GET'); assert.ok(!Object.hasOwn(get, 'body'));
      assert.match(get.nonce, /^[A-Za-z0-9_-]{32}$/); assert.match(get.timestamp, /^\d{13}$/);

      // A prepared step: the kit and the signer sign the same bytes to the same envelope.
      const pins = { chainId: 'fictional-central', genesisSha256: 'a'.repeat(64) };
      const config = { nativeRegistration: { enrol: pins } };
      const proof = { authority: 'native', chainId: pins.chainId, epoch: pins.genesisSha256, genesisSha256: pins.genesisSha256, verifierSha256: 'b'.repeat(64), appHash: 'c'.repeat(64), headerTime: new Date().toISOString(), height: '20', maxAgeSeconds: 120 };
      const evidence = '42 <α> & reproducible line\twith tab';
      for (const [operation, payload, sequence] of [
        ['central_submit', { id: 'CS-one', task: 'CT-one', evidence, evidence_digest: sha(evidence) }, '2'],
        ['central_submit', { id: 'CS-two', task: 'CT-one', evidence, evidence_digest: sha(evidence), revises: 'CS-one' }, '3'],
        ['project_join', { project: 'P-one' }, '2'],
        ['central_reassess', { submission: 'CS-one' }, '4'],
        ['enrol', { name: 'Fixture agent', operator: 'Independent', family: '' }, '0'],
      ]) {
        const command = { version: 1, chain_id: pins.chainId, member: me.address, sequence, expires_height: '120', operation, payload };
        const bytes = Buffer.from(kit.commandBytes(command));
        if (operation !== 'enrol' && operation !== 'central_reassess') assert.deepEqual(bytes, centralEarningSigningBytes(command));
        const intent = { id: 'fixture', member: me.address, status: 'prepared', publicKey: me.x, command, signingBytesBase64: bytes.toString('base64'), commandDigest: sha(bytes), proof };
        const theirs = py('sign_prepared', me.seed, intent, operation, payload, config);
        if (operation !== 'central_reassess') assert.deepEqual(theirs, await kit.signPrepared(me, intent, { operation, payload, pins }), operation);
        assert.ok(verify(null, bytes, createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: me.x }, format: 'jwk' }), Buffer.from(theirs.signature, 'base64url')), operation);
      }
    }
  });
}

test('the signer refuses another member, another operation, changed details, stale proofs and wrong bytes', async (t) => {
  const py = signerSandbox(t, SIGNER);
  const me = await kitIdentity(), other = await kitIdentity();
  const pins = { chainId: 'fictional-central', genesisSha256: 'a'.repeat(64) };
  const config = { nativeRegistration: { enrol: pins } };
  const proof = { authority: 'native', chainId: pins.chainId, epoch: pins.genesisSha256, genesisSha256: pins.genesisSha256, verifierSha256: 'b'.repeat(64), headerTime: new Date().toISOString(), height: '20', maxAgeSeconds: 120 };
  const build = (operation, payload, extra = {}) => {
    const command = { version: 1, chain_id: pins.chainId, member: me.address, sequence: '2', expires_height: '120', operation, payload, ...extra };
    const bytes = Buffer.from(kit.commandBytes(command));
    return { id: 'x', member: me.address, status: 'prepared', publicKey: me.x, command, signingBytesBase64: bytes.toString('base64'), proof };
  };
  const join = { project: 'P-one' };
  const ok = build('project_join', join);
  assert.ok(py('sign_prepared', me.seed, ok, 'project_join', join, config).signature);
  const refusals = [
    [{ ...ok, command: { ...ok.command, member: other.address } }, 'project_join', join, /another member/],
    [{ ...ok, member: other.address }, 'project_join', join, /another member/],
    [ok, 'coin_transfer', join, /signs only enrol/],
    [build('central_fund_plan', join), 'central_fund_plan', join, /signs only enrol/],
    [build('coin_transfer', { to: other.address, amount: '1' }), 'project_join', join, /not an earning step/],
    [ok, 'central_submit', join, /different operation/],
    [ok, 'project_join', { project: 'P-two' }, /details differ/],
    [{ ...ok, status: 'submitted' }, 'project_join', join, /not waiting for a signature/],
    [{ ...ok, publicKey: other.x }, 'project_join', join, /another public key/],
    [{ ...ok, signingBytesBase64: Buffer.from('other').toString('base64') }, 'project_join', join, /bytes BAINK asks you to sign differ/],
    [{ ...ok, proof: { ...proof, headerTime: new Date(Date.now() - 200_000).toISOString() } }, 'project_join', join, /stale/],
    [{ ...ok, command: { ...ok.command, expires_height: '500' }, signingBytesBase64: Buffer.from(kit.commandBytes({ ...ok.command, expires_height: '500' })).toString('base64') }, 'project_join', join, /expiry/],
    [{ ...ok, command: (({ expires_height, ...c }) => c)(ok.command) }, 'project_join', join, /differs|expiry/],
  ];
  for (const [intent, operation, payload, why] of refusals) assert.throws(() => py('sign_prepared', me.seed, intent, operation, payload, config), why, String(why));
  assert.throws(() => py('sign_prepared', me.seed, ok, 'project_join', join, { nativeRegistration: { enrol: { ...pins, chainId: 'other' } } }), /another network/);
  // A submission whose digest does not match its evidence is refused before signing.
  const bad = { id: 'CS-one', task: 'T-1', evidence: 'text', evidence_digest: 'f'.repeat(64) };
  assert.throws(() => py('sign_prepared', me.seed, build('central_submit', bad), 'central_submit', bad, config), /not valid/);
});

test('stable ids: the same draft always gets the same submission id, and the survey evidence equals the kit', async (t) => {
  const py = signerSandbox(t, SIGNER);
  const me = await kitIdentity();
  const a = py('submission_id', me.address, 'T-1', 'draft one'), b = py('submission_id', me.address, 'T-1', 'draft one');
  assert.equal(a, b);
  assert.match(a, /^CS-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a, py('submission_id', me.address, 'T-1', 'draft two'));
  assert.notEqual(a, py('submission_id', me.address, 'T-2', 'draft one'));
  assert.notEqual(a, py('submission_id', me.address, 'T-1', 'draft one', 'CS-earlier'));
  const e1 = py('enrol_request_id', me.address, 'Agent', 'Independent');
  assert.equal(e1, py('enrol_request_id', me.address, ' Agent ', 'Independent'));
  assert.match(e1, /^[A-Za-z0-9_-]{8,100}$/);
  assert.notEqual(e1, py('enrol_request_id', me.address, 'Agent two', 'Independent'));

  const templates = JSON.parse(readFileSync(new URL('../server/survey-templates.json', import.meta.url))).templates;
  const [task, template] = Object.entries(templates)[0];
  const items = [
    ...template.required.map((r) => ({ kind: r.kind, id: r.id, title: 'Required record title', relation: 'screened_out', note: 'Does not bear on the Main KPI.' })),
    ...[1, 2, 3, 4].flatMap((n) => [
      { kind: 'doi', id: `https://doi.org/10.1000/FICTION.${n}`, title: `Fictional record ${n}`, relation: 'partial', note: 'Covers part of the KPI, not the scale.' },
      { kind: 'arxiv', id: `arXiv:2501.0000${n}v2`, title: `Fictional preprint ${n}`, relation: 'adjacent', note: 'Related method that leaves the KPI open.' },
    ]),
  ];
  const gaps = ['Nothing reaches the Main KPI at the required scale yet.'];
  const survey = py('survey', template, '2026-11-11', items, false, gaps);
  const sid = py('submission_id', me.address, task, survey);
  const text = py('survey_evidence', task, sid, me.address, survey);
  const lines = [`asOf: 2026-11-11`, ...items.map((i) => `item: ${i.kind} | ${i.id} | ${i.title} | ${i.relation} | ${i.note}`), `gap: ${gaps[0]}`, 'meetsMainKpi: no'].join('\n');
  const parsed = kit.parseSurveyDraft(lines, template);
  assert.ok(parsed.survey, JSON.stringify(parsed.errors));
  assert.equal(text, kit.surveyEvidence({ taskId: task, submissionId: sid, author: me.address, survey: parsed.survey }));
  assert.throws(() => py('survey', template, '2026-11-11', items.slice(template.required.length), false, gaps), /Keep the item/);
  // The kit identity file the signer writes loads in the kit as the same member.
  const file = JSON.parse(py('kit_identity_file', me.seed));
  assert.deepEqual([file.format, file.address, file.public_key, file.private_key], ['baink-identity-v2', me.address, me.x, me.seed]);
});

test('the signer is short, readable, makes no network calls and imports only the standard library', () => {
  assert.ok(Buffer.byteLength(SIGNER) < 24000, 'short enough to read before running');
  const imports = [...SIGNER.matchAll(/^\s*(?:from (\S+) import|import (\S+))/gm)].map((m) => (m[1] ?? m[2]).split('.')[0]);
  assert.deepEqual([...new Set(imports)].sort(), ['base64', 'calendar', 'cryptography', 'datetime', 'hashlib', 'json', 'os', 're', 'time']);
  assert.doesNotMatch(SIGNER, /\b(urllib|http\.client|requests|socket|subprocess|eval|exec)\b/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, member, signed } from './http-fixture.mjs';

const company = '11111111-1111-4111-8111-111111111111';
const project = '22222222-2222-4222-8222-222222222222';
const slug = 'existing-native-project';
const sha = (value) => createHash('sha256').update(value).digest('hex');
function privateBridge() {
  const paths = [];
  return {
    paths,
    config: {
      origin: 'https://paperclip.example',
      allowedOrigins: ['https://paperclip.example'],
      apiKey: 'fixture-paperclip-token-1234',
      allowedCompanyIds: [company],
      projectMap: { [slug]: { companyId: company, projectId: project } },
      cacheMs: 0,
      fetchImpl: async (url) => {
        const path = new URL(url).pathname;
        paths.push(path);
        return new Response(JSON.stringify(path === '/api/projects/' + project
          ? { id: project, companyId: company, name: 'Private mirror', status: 'backlog', leadAgentId: null }
          : []), { headers: { 'content-type': 'application/json' } });
      },
    },
  };
}
async function nativeFixture(t, who, maxAgeSeconds = 120) {
  const dir = await mkdtemp(join(tmpdir(), 'baink-native-access-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'reader'), genesis = join(dir, 'genesis.json');
  const stateFile = join(dir, 'state.json'), log = join(dir, 'calls.log');
  const nativeKey = Buffer.from(who.publicKey, 'base64').toString('base64url');
  const imported = { policy: 'legacy-preservation-v1', status: 'ready', manifest_digest: 'a'.repeat(64) };
  const nativeMember = { id: who.address, public_key: nativeKey, name: 'Native fixture', family: '', operator: '', licence: 'active', sequence: '0' };
  const state = { chain_id: 'isolated-access-http', height: '100', app_hash: 'a'.repeat(64), member: nativeMember,
    records: { legacy_import: imported,
      [`member/${who.address}`]: nativeMember,
      [`legacy_project/${slug}`]: null, [`project/${slug}`]: null,
      [`legacy/project/${slug}`]: { id: slug, lead: 'lead-instance', state: 'active' },
      'legacy_actor/lead-instance': null,
      'legacy/actor/lead-instance': { id: 'lead-instance', member: who.address, source_state: 'active', projects: [slug] },
      'instance/lead-instance': { id: 'lead-instance', member: who.address, state: 'active' },
      [`legacy/account/${who.address}`]: { id: who.address, public_key: nativeKey, instances: [{ id: 'lead-instance', member: who.address }] },
      [`legacy_account_claimed/${who.address}`]: { instances: 1, manifest_digest: imported.manifest_digest },
    } };
  // Exercise the real adapter's artifact pins, process boundary and selected-key
  // validation. Consensus proof mathematics remains the independent Go reader's job.
  const code = `#!${process.execPath}\nconst fs=require('fs');let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{const request=JSON.parse(input);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(request)+'\\n');const data=JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)},'utf8'));data.header_time=new Date(Date.now()+(data.timeOffsetMs||0)).toISOString();data.records=Object.fromEntries(['legacy_import',...(request.member?['member/'+request.member]:[]),...(request.keys||[])].map(key=>[key,Object.hasOwn(data.records,key)?data.records[key]:null]));if(data.omitKey)delete data.records[data.omitKey];const output=process.argv[process.argv.indexOf('--out')+1];fs.writeFileSync(output,JSON.stringify(data),{mode:384,flag:'wx'});});\n`;
  const genesisText = JSON.stringify({ chain_id: state.chain_id });
  await writeFile(binary, code, { mode: 0o700 });
  await writeFile(genesis, genesisText, { mode: 0o600 });
  await writeFile(log, '', { mode: 0o600 });
  const save = () => writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
  await save();
  return { state, save,
    calls: async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse),
    config: { binary, binaryHash: sha(code), genesis, genesisHash: sha(genesisText), rpc: 'http://127.0.0.1:1', chainId: state.chain_id, timeoutMs: 2000, maxAgeSeconds },
  };
}
const leads = (who) => ({ [slug]: { instanceId: 'lead-instance', memberAddress: who.address } });
const path = `/api/projects/${slug}/operations`;
function privateDenied(result, status) {
  assert.equal(result.status, status);
  const body = JSON.stringify(result.body);
  for (const value of [company, project, 'appHash', 'headerTime', 'instanceId', 'memberAddress', 'records', 'Private mirror'])
    assert.equal(body.includes(value), false, value);
}

test('native lead tuple adds a restriction; unavailable proof cannot fall through to private upstream', async (t) => {
  const who = member(), bridge = privateBridge();
  const f = await fixture(t, { paperclipViewers: { [slug]: [who.address] }, paperclipNativeLeads: leads(who), paperclipConfig: bridge.config, nativeProjectAccess: { check: async () => ({ allowed: true }) } });
  await f.request(who, 'POST', '/api/account', {});
  privateDenied(await f.request(who, 'GET', path), 503);
  assert.equal(bridge.paths.length, 0);
});

test('signed current lead reads the exact mapped project, while unsigned/wrong/unapproved actors cannot reach native or private reads', async (t) => {
  const who = member(), other = member(), bridge = privateBridge();
  const native = await nativeFixture(t, who);
  const f = await fixture(t, { nativeConfig: native.config, paperclipViewers: { [slug]: [who.address] }, paperclipNativeLeads: leads(who), paperclipConfig: bridge.config });
  for (const actor of [who, other]) await f.request(actor, 'POST', '/api/account', {});
  const before = (await native.calls()).length;
  assert.equal((await f.request(null, 'GET', path)).status, 401);
  privateDenied(await f.request(other, 'GET', path), 403);
  const tampered = signed(other, 'GET', path);
  tampered['X-BAINK-Public-Key'] = who.publicKey;
  assert.equal((await f.request(null, 'GET', path, {}, tampered)).status, 401);
  assert.equal((await native.calls()).length, before);
  assert.equal(bridge.paths.length, 0);
  const allowed = await f.request(who, 'GET', path);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.project.name, 'Private mirror');
  assert.deepEqual(bridge.paths, ['/api/projects/' + project, '/api/companies/' + company + '/issues', '/api/companies/' + company + '/costs/by-project']);
  const calls = await native.calls();
  assert.equal(calls.length, before + 1);
  assert.ok(calls.at(-1).keys.includes('legacy_project/' + slug));
  assert.ok(calls.at(-1).keys.includes('project/' + slug));
  assert.equal(calls.at(-1).member, who.address);
});

test('configured native identity cannot bypass the explicit viewer grant, even with valid proof or a replacement option', async (t) => {
  const who = member(), bridge = privateBridge(), native = await nativeFixture(t, who);
  const f = await fixture(t, { nativeConfig: native.config, paperclipNativeLeads: leads(who), paperclipConfig: bridge.config, nativeProjectAccess: { check: async () => ({ allowed: true }) } });
  await f.request(who, 'POST', '/api/account', {});
  const before = (await native.calls()).length;
  privateDenied(await f.request(who, 'GET', path), 403);
  assert.equal((await native.calls()).length, before);
  assert.equal(bridge.paths.length, 0);
});

test('lead revocation in operative overlay denies after cached proof expires', async (t) => {
  const who = member(), bridge = privateBridge(), native = await nativeFixture(t, who, 1);
  const f = await fixture(t, { nativeConfig: native.config, paperclipViewers: { [slug]: [who.address] }, paperclipNativeLeads: leads(who), paperclipConfig: bridge.config });
  await f.request(who, 'POST', '/api/account', {});
  assert.equal((await f.request(who, 'GET', path)).status, 200);
  const before = bridge.paths.length;
  native.state.records['legacy_project/' + slug] = { id: slug, lead: 'different-current-lead', state: 'active' };
  await native.save();
  await delay(1100);
  privateDenied(await f.request(who, 'GET', path), 403);
  assert.equal(bridge.paths.length, before);
});

test('unproven selected absence and stale proofs fail closed before private read', async (t) => {
  for (const change of [(state) => { state.omitKey = 'legacy_project/' + slug; }, (state) => { state.timeOffsetMs = -121000; }]) {
    const who = member(), bridge = privateBridge(), native = await nativeFixture(t, who);
    change(native.state); await native.save();
    const f = await fixture(t, { nativeConfig: native.config, paperclipViewers: { [slug]: [who.address] }, paperclipNativeLeads: leads(who), paperclipConfig: bridge.config });
    await f.request(who, 'POST', '/api/account', {});
    privateDenied(await f.request(who, 'GET', path), 503);
    assert.equal(bridge.paths.length, 0);
  }
});

test('malformed or overbroad native lead mappings fail startup instead of silently disabling the restriction', async (t) => {
  const who = member();
  for (const mapping of [null, [], { '../project': leads(who)[slug] }, { 'Upper.Project': leads(who)[slug] }, { [slug]: { instanceId: 'lead-instance', memberAddress: who.address, companyId: company } }, { [slug]: { instanceId: 'bad/id', memberAddress: who.address } }, { [slug]: { instanceId: 'lead-instance', memberAddress: 'wrong' } }, { [slug]: {} }, Object.fromEntries(Array.from({ length: 1001 }, (_, i) => ['project-' + i, leads(who)[slug]]))])
    await assert.rejects(fixture(t, { paperclipNativeLeads: mapping }), /native.*lead/i);
});

test('unconfigured private bridge remains empty and does not reach native restrictions or disclose partial mapping', async (t) => {
  const who = member(), native = await nativeFixture(t, who), bridge = privateBridge();
  delete bridge.config.apiKey;
  const f = await fixture(t, { nativeConfig: native.config, paperclipNativeLeads: leads(who), paperclipConfig: bridge.config });
  await f.request(who, 'POST', '/api/account', {});
  const before = (await native.calls()).length;
  const result = await f.request(who, 'GET', path);
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'not-configured');
  assert.equal(result.body.project, null);
  for (const value of [company, project, 'paperclip.example']) assert.equal(JSON.stringify(result.body).includes(value), false);
  assert.equal((await native.calls()).length, before);
  assert.equal(bridge.paths.length, 0);
});

// Explicit approval is necessary but cannot satisfy a different configured native tuple.
test('explicit viewer with a different authenticated key is rejected before native proof lookup', async (t) => {
  const owner = member(), viewer = member(), bridge = privateBridge(), native = await nativeFixture(t, owner);
  const f = await fixture(t, { nativeConfig: native.config, paperclipViewers: { [slug]: [viewer.address] }, paperclipNativeLeads: leads(owner), paperclipConfig: bridge.config });
  await f.request(viewer, 'POST', '/api/account', {});
  const before = (await native.calls()).length;
  privateDenied(await f.request(viewer, 'GET', path), 403);
  assert.equal((await native.calls()).length, before);
  assert.equal(bridge.paths.length, 0);
});

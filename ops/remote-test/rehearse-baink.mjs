#!/usr/bin/env node
// BAINK store rehearsal: the code production runs now writes a store, the new
// code starts on it and writes its new sections, then the old code starts again
// on the result (the rollback case). Fictional keys and a throwaway data
// directory only; no native reader, no production state.
//
//   node ops/remote-test/rehearse-baink.mjs <old apps/baink dir> <new apps/baink dir>
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [oldDir, newDir] = process.argv.slice(2).map(p => resolve(p));
assert.ok(oldDir && newDir, 'usage: rehearse-baink.mjs <old apps/baink> <new apps/baink>');
const audience = 'https://baink.example';
const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v);
function member() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519'), raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { privateKey, raw, publicKey: raw.toString('base64'), address: 'uain1' + createHash('sha256').update(raw).digest('hex').slice(0, 40) };
}
const dataDir = await mkdtemp(join(tmpdir(), 'baink-rehearsal-'));
let app, base;
async function start(dir) {
  const { createBainkServer } = await import(pathToFileURL(join(dir, 'server/app.mjs')).href + '?v=' + dir.length + Math.random());
  app = await createBainkServer({ dataDir, publicOrigin: audience, projectsSource: null, catalogueDir: null });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
}
async function call(who, method, path, body = {}) {
  const nonce = randomBytes(24).toString('base64url'), timestamp = String(Date.now());
  const signature = sign(null, Buffer.from(canonical({ audience, method, path, body, nonce, timestamp })), who.privateKey).toString('base64');
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: audience, 'X-BAINK-Public-Key': who.publicKey, 'X-BAINK-Nonce': nonce, 'X-BAINK-Timestamp': timestamp, 'X-BAINK-Signature': signature }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: await r.json() };
}
const seller = member(), buyer = member();
const out = { old: {}, new: {}, rollback: {} };
try {
  await start(oldDir);
  for (const [who, name] of [[seller, 'Rehearsal seller'], [buyer, 'Rehearsal buyer']]) assert.equal((await call(who, 'POST', '/api/account', { displayName: name })).status, 201);
  const created = await call(seller, 'POST', '/api/requests', { to: buyer.address, amount: '2', memo: 'rehearsal request', clientRequestId: 'rehearsal-request-1' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const requestId = created.body.request.id;
  out.old.request = created.body.request.status;
  await app.close();

  await start(newDir);
  const listed = await call(buyer, 'GET', '/api/requests?direction=incoming');
  assert.equal(listed.status, 200);
  const row = listed.body.requests.find(r => r.id === requestId);
  assert.equal(row.status, 'open', 'an old request stays open after the upgrade');
  // Requests written before expiries existed (pre-0.3.47) get the legacy grace; newer ones keep theirs.
  if (created.body.request.expiresAt) assert.equal(row.expiresAt, created.body.request.expiresAt, 'an old request keeps its expiry');
  else assert.ok(Date.parse(row.expiresAt) >= Date.parse('2026-11-17T00:00:00Z'), 'old requests get the legacy grace');
  out.new.oldRequest = { status: row.status, expiresAt: row.expiresAt };
  const sends = await call(buyer, 'GET', '/api/native/sends');
  assert.equal(sends.status, 200); assert.equal(sends.body.enabled, false);
  const fresh = await call(seller, 'POST', '/api/requests', { to: buyer.address, amount: '3', memo: 'new-code request', clientRequestId: 'rehearsal-request-2' });
  assert.equal(fresh.status, 201); assert.ok(fresh.body.request.expiresAt, 'new requests store an expiry');
  const refused = await call(buyer, 'POST', '/api/native/sends', { intent: {}, signature: 'x' });
  assert.equal(refused.status, 503, 'sending stays off unless configured');
  out.new.newRequestExpiresAt = fresh.body.request.expiresAt; out.new.sendsEnabled = false; out.new.sendCreateWhileOff = refused.body.error?.code ?? refused.status;
  await app.close();
  const state = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8'));
  out.new.stateKeys = Object.keys(state).sort();

  await start(oldDir); // rollback
  const back = await call(buyer, 'GET', '/api/requests?direction=incoming');
  assert.equal(back.status, 200);
  assert.deepEqual(back.body.requests.map(r => r.id).sort(), [requestId, fresh.body.request.id].sort());
  const cancel = await call(seller, 'POST', `/api/requests/${fresh.body.request.id}/cancel`, {});
  assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
  out.rollback = { starts: true, requests: back.body.requests.length, cancelAfterRollback: cancel.body.request.status };
  await app.close();
  console.log(JSON.stringify({ result: 'passed', ...out }, null, 2));
} catch (error) {
  console.error(error); process.exitCode = 1;
  await app?.close().catch(() => {});
} finally { await rm(dataDir, { recursive: true, force: true }); }

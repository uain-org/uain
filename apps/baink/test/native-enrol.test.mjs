import test from 'node:test';
import { readPersistedState } from '../server/store-sqlite.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import {
  generateKeyPairSync,
  createHash,
  sign,
  randomBytes,
} from 'node:crypto';
import { createBainkServer } from '../server/app.mjs';

const audience = 'https://baink.example',
  sha = (v) => createHash('sha256').update(v).digest('hex');
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
      .join(',')}}`;
  return JSON.stringify(v);
}
async function fixture(t, { enabled = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'baink-enrol-fixture-')),
    dataDir = join(directory, 'data'),
    statePath = join(directory, 'chain.json');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519'),
    raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32),
    address = 'uain1' + sha(raw).slice(0, 40);
  let state = {
      height: '100',
      eventCount: '4',
      member: null,
      events: {},
      legacy: null,
    },
    attempts = 0,
    disconnect = false,
    hang = false;
  const update = async (patch) => {
    state = { ...state, ...patch };
    await writeFile(statePath, JSON.stringify(state));
  };
  await update({});
  const rpc = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const call = JSON.parse(body);
    assert.equal(call.method, 'broadcast_tx_sync');
    attempts++;
    if (disconnect) {
      res.destroy();
      return;
    }
    if (hang) return;
    const bytes = Buffer.from(call.params.tx, 'base64');
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({ result: { code: 0, hash: sha(bytes).toUpperCase() } }),
    );
  });
  await new Promise((r) => rpc.listen(0, '127.0.0.1', r));
  const genesis = JSON.stringify({ chain_id: 'isolated-enrol-fixture' }),
    genesisPath = join(directory, 'genesis.json'),
    binary = join(directory, 'reader');
  // Trusted process-boundary fixture only: real consensus/IAVL verification
  // remains the reviewed native verifier's responsibility.
  const script = `#!${process.execPath}\nconst fs=require('fs');let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{const r=JSON.parse(input),s=JSON.parse(fs.readFileSync(${JSON.stringify(statePath)},'utf8'));if((r.member||r.receipt)&&!s.member)process.exit(2);const records={legacy_import:s.legacy};for(const key of r.keys||[])records[key]=key==='member/${address}'?s.member:key.startsWith('event/')?(s.events[key]??null):null;const out={chain_id:'isolated-enrol-fixture',height:s.height,header_time:new Date().toISOString(),app_hash:'a'.repeat(64),event_count:s.eventCount,records};if(r.member||r.receipt)out.member=s.member;if(r.receipt){if(!s.receipt)process.exit(3);out.receipt=s.receipt;}fs.writeFileSync(process.argv[process.argv.indexOf('--out')+1],JSON.stringify(out),{mode:384,flag:'wx'});});\n`;
  await writeFile(genesisPath, genesis);
  await writeFile(binary, script, { mode: 0o700 });
  await chmod(binary, 0o700);
  const nativeConfig = {
    binary,
    binaryHash: sha(script),
    genesis: genesisPath,
    genesisHash: sha(genesis),
    chainId: 'isolated-enrol-fixture',
    rpc: `http://127.0.0.1:${rpc.address().port}`,
    timeoutMs: 3000,
    maxAgeSeconds: 120,
  };
  let app, base;
  async function start() {
    app = await createBainkServer({
      dataDir,
      publicOrigin: audience,
      projectsSource: null,
      catalogueDir: null,
      nativeConfig,
      nativeEnrolEnabled: enabled,
    });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${app.server.address().port}`;
  }
  await start();
  t.after(async () => {
    await app.close();
    await new Promise((r) => rpc.close(r));
    await rm(directory, { recursive: true, force: true });
  });
  async function request(path, body, method = 'POST') {
    const nonce = randomBytes(24).toString('base64url'),
      timestamp = String(Date.now()),
      value = body ?? {};
    const signature = sign(
      null,
      Buffer.from(
        canonical({ audience, method, path, body: value, nonce, timestamp }),
      ),
      privateKey,
    ).toString('base64');
    const res = await fetch(base + path, {
      method,
      headers: {
        Origin: audience,
        'Content-Type': 'application/json',
        'X-BAINK-Public-Key': raw.toString('base64'),
        'X-BAINK-Nonce': nonce,
        'X-BAINK-Timestamp': timestamp,
        'X-BAINK-Signature': signature,
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(value) }),
    });
    return { status: res.status, body: await res.json() };
  }
  assert.equal(
    (await request('/api/account', { displayName: 'Fixture' })).status,
    201,
  );
  return {
    address,
    publicKey: raw.toString('base64url'),
    nativeConfig,
    dataDir,
    request,
    update,
    state: () => state,
    attempts: () => attempts,
    disconnect: () => {
      disconnect = true;
    },
    hang: () => {
      hang = true;
    },
    restart: async () => {
      await app.close();
      await start();
    },
    envelope: (intent) => ({
      command: intent.command,
      public_key: raw.toString('base64url'),
      signature: sign(
        null,
        Buffer.from(intent.signingBytesBase64, 'base64'),
        privateKey,
      ).toString('base64url'),
    }),
  };
}
const fields = { name: 'A&B <AI>', operator: 'Test operator', family: 'codex' };
async function prepare(f, id = 'fixture-enrol-one') {
  const result = await f.request('/api/native/enrol/prepare', {
    clientRequestId: id,
    ...fields,
  });
  assert.equal(result.status, 201);
  return result.body.intent;
}

test('enrol preparation proves absence, uses exact native signing bytes and persists one stable public intent', async (t) => {
  const f = await fixture(t),
    intent = await prepare(f);
  assert.equal(intent.command.operation, 'enrol');
  assert.equal(intent.command.sequence, '0');
  assert.equal(intent.command.expires_height, '200');
  assert.equal(intent.command.member, f.address);
  assert.equal(intent.publicKey, f.publicKey);
  assert.equal(intent.afterEvent, '4');
  assert.equal(intent.finalized, false);
  const literal =
    'uain:chain-command:v1\n' +
    `{"version":1,"chain_id":"isolated-enrol-fixture","member":"${f.address}","sequence":"0","expires_height":"200","operation":"enrol","payload":{"family":"codex","name":"A\\u0026B \\u003cAI\\u003e","operator":"Test operator"}}`;
  assert.equal(
    Buffer.from(intent.signingBytesBase64, 'base64').toString(),
    literal,
  );
  assert.equal(f.attempts(), 0);
  await f.restart();
  const duplicate = await f.request('/api/native/enrol/prepare', {
    clientRequestId: 'fixture-enrol-one',
    ...fields,
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.intent.id, intent.id);
  assert.equal(
    (
      await f.request('/api/native/enrol/prepare', {
        clientRequestId: 'fixture-enrol-one',
        ...fields,
        name: 'Changed',
      })
    ).status,
    409,
  );
  assert.equal(
    (await f.request('/api/native/enrol', undefined, 'GET')).body.intents
      .length,
    1,
  );
  await f.update({ height: '120' });
  const refreshed = await f.request('/api/native/enrol/prepare', {
    clientRequestId: 'fixture-enrol-one',
    ...fields,
  });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.intent.proof.height, '120');
  assert.deepEqual(refreshed.body.intent.command, intent.command);
  assert.equal(
    refreshed.body.intent.signingBytesBase64,
    intent.signingBytesBase64,
  );
});

test('existing native membership and unreconciled import refuse new enrol intent without broadcasting', async (t) => {
  const f = await fixture(t);
  await f.update({
    member: {
      id: f.address,
      public_key: f.publicKey,
      sequence: '1',
      licence: 'pending',
    },
  });
  assert.equal(
    (
      await f.request('/api/native/enrol/prepare', {
        clientRequestId: 'existing-member',
        ...fields,
      })
    ).status,
    409,
  );
  await f.update({ member: null, legacy: { status: 'pending' } });
  assert.equal(
    (
      await f.request('/api/native/enrol/prepare', {
        clientRequestId: 'pending-import',
        ...fields,
      })
    ).status,
    503,
  );
  assert.equal(f.attempts(), 0);
});

test('a locally signed exact enrol envelope broadcasts once and CheckTx never becomes finality', async (t) => {
  const f = await fixture(t),
    intent = await prepare(f),
    envelope = f.envelope(intent);
  const wrong = {
    ...envelope,
    command: { ...envelope.command, operation: 'licence' },
  };
  assert.equal(
    (
      await f.request(`/api/native/enrol/${intent.id}/submit`, {
        envelope: wrong,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(`/api/native/enrol/${intent.id}/submit`, {
        envelope: {
          ...envelope,
          signature: Buffer.alloc(64).toString('base64url'),
        },
      })
    ).status,
    400,
  );
  const concurrent = await Promise.all([
    f.request(`/api/native/enrol/${intent.id}/submit`, { envelope }),
    f.request(`/api/native/enrol/${intent.id}/submit`, { envelope }),
  ]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 202]);
  const first = concurrent.find((r) => r.status === 202);
  assert.equal(first.body.intent.status, 'accepted');
  assert.equal(first.body.intent.finalized, false);
  assert.equal(f.attempts(), 1);
  await f.restart();
  const duplicate = await f.request(`/api/native/enrol/${intent.id}/submit`, {
    envelope,
  });
  assert.equal(duplicate.status, 200);
  assert.equal(f.attempts(), 1);
  const journal = readPersistedState(f.dataDir).nativeIntents[intent.id];
  assert.ok(journal.sendAttemptedAt);
  assert.deepEqual(journal.envelope, envelope);
  const scan = await f.request(`/api/native/enrol/${intent.id}/receipt`, {});
  assert.equal(scan.body.intent.finalized, false);
});

test('a lost broadcast response retains the send marker across restart and forbids replacement or another send', async (t) => {
  const f = await fixture(t),
    intent = await prepare(f),
    envelope = f.envelope(intent);
  f.disconnect();
  const first = await f.request(`/api/native/enrol/${intent.id}/submit`, {
    envelope,
  });
  assert.equal(first.status, 202);
  assert.equal(first.body.intent.status, 'unknown');
  assert.equal(first.body.intent.receiptRequired, true);
  await f.restart();
  assert.equal(
    (await f.request(`/api/native/enrol/${intent.id}/submit`, { envelope }))
      .status,
    200,
  );
  assert.equal(f.attempts(), 1);
  assert.equal(
    (
      await f.request('/api/native/enrol/prepare', {
        clientRequestId: 'replacement-intent',
        ...fields,
        name: 'Changed',
      })
    ).status,
    409,
  );
});

test('a matching pinned finalized event marks enrolment complete while licence activation remains separate', async (t) => {
  const f = await fixture(t),
    intent = await prepare(f),
    envelope = f.envelope(intent);
  await f.request(`/api/native/enrol/${intent.id}/submit`, { envelope });
  const digest = sha(Buffer.from(intent.signingBytesBase64, 'base64')),
    event = {
      id: '5',
      height: '101',
      member: f.address,
      operation: 'enrol',
      subject: f.address,
      command_digest: digest,
    };
  await f.update({
    height: '102',
    eventCount: '5',
    member: {
      id: f.address,
      public_key: f.publicKey,
      sequence: '1',
      licence: 'pending',
    },
    events: { 'event/00000000000000000005': event },
    receipt: {
      authority: 'native',
      finalized: true,
      chain_id: 'isolated-enrol-fixture',
      state_height: '102',
      app_hash: 'a'.repeat(64),
      event,
    },
  });
  await f.update({ receipt: { ...f.state().receipt, finalized: false } });
  const unproven = await f.request(
    `/api/native/enrol/${intent.id}/receipt`,
    {},
  );
  assert.equal(unproven.status, 503);
  await f.update({ receipt: { ...f.state().receipt, finalized: true } });
  const result = await f.request(`/api/native/enrol/${intent.id}/receipt`, {});
  assert.equal(result.status, 200);
  assert.equal(result.body.intent.finalized, true);
  assert.equal(result.body.intent.activation.licence, 'pending');
  assert.equal(result.body.intent.activation.verified, true);
  await f.update({ member: { ...f.state().member, licence: 'active' } });
  const active = await f.request(`/api/native/enrol/${intent.id}/receipt`, {});
  assert.equal(active.body.intent.activation.licence, 'active');
  assert.equal(active.body.intent.activation.status, 'active');
  assert.equal(f.attempts(), 1);
  const otherGenesis = JSON.stringify({
    chain_id: 'isolated-enrol-fixture',
    epoch: 'new-epoch',
  });
  await writeFile(f.nativeConfig.genesis, otherGenesis);
  f.nativeConfig.genesisHash = sha(otherGenesis);
  await f.restart();
  const migrated = await f.request(
    `/api/native/enrol/${intent.id}/receipt`,
    {},
  );
  assert.equal(migrated.body.intent.finalized, true);
  assert.equal(migrated.body.intent.activation.verified, false);
  assert.equal(migrated.body.intent.activation.status, 'proof_unavailable');
  const historicalList = await f.request('/api/native/enrol', undefined, 'GET');
  assert.equal(historicalList.body.intents[0].activation.verified, false);
});

test('broadcast is disabled by default configuration even for a correctly signed prepared intent', async (t) => {
  const f = await fixture(t, { enabled: false }),
    intent = await prepare(f);
  const result = await f.request(`/api/native/enrol/${intent.id}/submit`, {
    envelope: f.envelope(intent),
  });
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'native_enrol_disabled');
  assert.equal(f.attempts(), 0);
});

test('an actual bounded broadcast timeout leaves a durable marker and cannot send again', async (t) => {
  const f = await fixture(t),
    intent = await prepare(f),
    envelope = f.envelope(intent);
  f.hang();
  const timed = await f.request(`/api/native/enrol/${intent.id}/submit`, {
    envelope,
  });
  assert.equal(timed.status, 202);
  assert.equal(timed.body.intent.status, 'unknown');
  await f.restart();
  await f.request(`/api/native/enrol/${intent.id}/submit`, { envelope });
  assert.equal(f.attempts(), 1);
});

test('receipt discovery scans at most 32 proved events per poll and never infers finality from membership alone', async (t) => {
  const f = await fixture(t),
    intent = await prepare(f),
    envelope = f.envelope(intent);
  await f.request(`/api/native/enrol/${intent.id}/submit`, { envelope });
  const events = {};
  for (let n = 5; n <= 38; n++)
    events['event/' + String(n).padStart(20, '0')] = {
      id: String(n),
      height: '140',
      member: f.address,
      operation: n === 38 ? 'enrol' : 'other',
      subject: f.address,
      command_digest:
        n === 38
          ? sha(Buffer.from(intent.signingBytesBase64, 'base64'))
          : sha('unrelated-' + n),
    };
  const event = events['event/00000000000000000038'];
  await f.update({
    height: '150',
    eventCount: '38',
    member: {
      id: f.address,
      public_key: f.publicKey,
      sequence: '1',
      licence: 'pending',
    },
    events,
    receipt: {
      authority: 'native',
      finalized: true,
      chain_id: 'isolated-enrol-fixture',
      state_height: '150',
      app_hash: 'a'.repeat(64),
      event,
    },
  });
  const first = await f.request(`/api/native/enrol/${intent.id}/receipt`, {});
  assert.equal(first.body.intent.finalized, false);
  assert.equal(first.body.intent.scanCursor, '36');
  assert.equal(first.body.intent.moreEvents, true);
  const second = await f.request(`/api/native/enrol/${intent.id}/receipt`, {});
  assert.equal(second.body.intent.finalized, true);
  assert.equal(second.body.intent.scanCursor, '38');
});

test('a sent enrolment proved unincluded releases the sequence fence when a new one is prepared (security review, 10 Nov)', async (t) => {
  const f = await fixture(t),
    intent = await prepare(f, 'fixture-enrol-lost');
  f.disconnect();
  const first = await f.request(`/api/native/enrol/${intent.id}/submit`, { envelope: f.envelope(intent) });
  assert.equal(first.body.intent.status, 'unknown');
  await f.update({ height: String(BigInt(intent.command.expires_height) + 5n) }); // still absent, past expiry
  await prepare(f, 'fixture-enrol-again');
  const old = (await f.request('/api/native/enrol', undefined, 'GET')).body.intents.find((i) => i.id === intent.id);
  assert.equal(old.status, 'expired_unincluded');
  const { hasPendingNativeSend } = await import('../server/native-sequence-fence.mjs');
  assert.equal(hasPendingNativeSend({ nativeIntents: { [intent.id]: { member: f.address, command: { member: f.address }, sendAttemptedAt: 'x', status: old.status } } }, f.address), false);
});

test('a sent enrolment past its expiry with no matching event and an absent member is proved unused by its own receipt check (fresh-join test, 13 Nov)', async (t) => {
  const f = await fixture(t),
    intent = await prepare(f, 'fixture-enrol-receipt-expiry');
  f.disconnect();
  const sent = await f.request(`/api/native/enrol/${intent.id}/submit`, { envelope: f.envelope(intent) });
  assert.equal(sent.body.intent.status, 'unknown');
  // Before expiry the receipt check leaves it open: the exact bytes could still be included.
  let r = await f.request(`/api/native/enrol/${intent.id}/receipt`, {});
  assert.equal(r.body.intent.status, 'unknown');
  assert.equal(r.body.intent.receiptRequired, true);
  // Past expiry, every event scanned, member still absent: released, and no longer needs a receipt.
  await f.update({ height: String(BigInt(intent.command.expires_height) + 5n) });
  r = await f.request(`/api/native/enrol/${intent.id}/receipt`, {});
  assert.equal(r.body.intent.status, 'expired_unincluded');
  assert.equal(r.body.intent.receiptRequired, false);
  assert.equal(r.body.intent.finalized, false);
  // Stable on a second check.
  r = await f.request(`/api/native/enrol/${intent.id}/receipt`, {});
  assert.equal(r.body.intent.status, 'expired_unincluded');
});

test('an enrolment past expiry is not released while the member record exists', async (t) => {
  const f = await fixture(t),
    intent = await prepare(f, 'fixture-enrol-receipt-present');
  f.disconnect();
  await f.request(`/api/native/enrol/${intent.id}/submit`, { envelope: f.envelope(intent) });
  await f.update({
    height: String(BigInt(intent.command.expires_height) + 5n),
    member: { id: f.address, public_key: f.publicKey, sequence: '1', licence: 'pending' },
  });
  const r = await f.request(`/api/native/enrol/${intent.id}/receipt`, {});
  assert.notEqual(r.body.intent.status, 'expired_unincluded');
  assert.equal(r.body.intent.receiptRequired, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonical,
  createIdentity,
  exportIdentity,
  importIdentity,
  api,
  cancelIdentityRequests,
} from './identity.js';

test('canonical signatures sort nested object keys without reordering arrays', () => {
  assert.equal(
    canonical({ z: [{ b: 2, a: 1 }, 3], a: { d: 4, c: 2 } }),
    '{"a":{"c":2,"d":4},"z":[{"a":1,"b":2},3]}',
  );
});
test('browser identity backup roundtrips and rejects a mismatched public key', async () => {
  const identity = await createIdentity();
  assert.match(identity.address, /^uain1[a-f0-9]{40}$/);
  const text = await exportIdentity(identity);
  const imported = await importIdentity(text);
  assert.equal(imported.address, identity.address);
  assert.equal(imported.publicKeyBase64, identity.publicKeyBase64);
  const native = JSON.parse(text);
  delete native.format;
  assert.equal(
    (await importIdentity(JSON.stringify(native))).address,
    identity.address,
  );
  const legacy = {
    format: 'baink-identity-v1',
    address: identity.address,
    publicKey: identity.publicKeyBase64,
    privateKey: await crypto.subtle.exportKey('jwk', identity.privateKey),
  };
  assert.equal(
    (await importIdentity(JSON.stringify(legacy))).address,
    identity.address,
  );
  const other = await createIdentity();
  const malformed = JSON.parse(text);
  malformed.public_key = other.publicKeyBase64
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  await assert.rejects(
    importIdentity(JSON.stringify(malformed)),
    /do not match/,
  );
});
test('signed requests verify against the exact backend contract and never send private key material', async () => {
  const identity = await createIdentity();
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  globalThis.location = { origin: 'https://baink.money' };
  let sent;
  globalThis.fetch = async (path, options) => {
    sent = { path, options };
    return { ok: true, json: async () => ({ requests: [] }) };
  };
  try {
    const body = {
      to: 'uain1' + 'a'.repeat(40),
      amount: '2.5',
      memo: 'Research',
      clientRequestId: 'test-request-1',
    };
    await api('/api/requests', { identity, method: 'POST', body });
    assert.equal(sent.path, '/api/requests');
    assert.equal(sent.options.body, JSON.stringify(body));
    const h = sent.options.headers;
    const payload = canonical({
      audience: location.origin,
      method: 'POST',
      path: '/api/requests',
      body,
      nonce: h['X-BAINK-Nonce'],
      timestamp: h['X-BAINK-Timestamp'],
    });
    assert.equal(
      await crypto.subtle.verify(
        'Ed25519',
        identity.publicKey,
        Buffer.from(h['X-BAINK-Signature'], 'base64'),
        new TextEncoder().encode(payload),
      ),
      true,
    );
    assert.equal(JSON.stringify(sent).includes('privateKey'), false);
    assert.equal(
      JSON.stringify(sent).includes(
        JSON.parse(await exportIdentity(identity)).private_key,
      ),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.location = originalLocation;
  }
});

test('backup labels cannot silently identify a different or malformed address', async () => {
  const backup = JSON.parse(await exportIdentity(await createIdentity()));
  for (const address of ['uain1' + '0'.repeat(40), 'invalid', '', null, 42]) {
    await assert.rejects(
      importIdentity(JSON.stringify({ ...backup, address })),
      /address.*(match|invalid)|invalid.*address/i,
    );
  }
  const withoutAddress = { ...backup };
  delete withoutAddress.address;
  assert.equal(
    (await importIdentity(JSON.stringify(withoutAddress))).address,
    backup.address,
  );
  const legacy = {
    format: 'baink-identity-v1',
    address: 'uain1' + '0'.repeat(40),
    publicKey: (await importIdentity(JSON.stringify(backup))).publicKeyBase64,
    privateKey: await crypto.subtle.exportKey(
      'jwk', (await importIdentity(JSON.stringify(backup))).privateKey,
    ),
  };
  await assert.rejects(importIdentity(JSON.stringify(legacy)), /address.*match/i);
});

test('local address and private seed login derives the same identity without network access', async () => {
  const { importIdentityPair } = await import('./identity.js');
  assert.equal(typeof importIdentityPair, 'function');
  const identity = await createIdentity();
  const backup = JSON.parse(await exportIdentity(identity));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw Error('Identity import must not make a network request.');
  };
  try {
    for (const publicKey of [undefined, backup.public_key]) {
      const imported = await importIdentityPair({
        address: backup.address,
        privateKey: backup.private_key,
        ...(publicKey ? { publicKey } : {}),
      });
      assert.equal(imported.address, identity.address);
      assert.equal(imported.publicKeyBase64, identity.publicKeyBase64);
      const message = new TextEncoder().encode('Local identity pair login');
      assert.equal(
        await crypto.subtle.verify(
          'Ed25519', identity.publicKey,
          await crypto.subtle.sign('Ed25519', imported.privateKey, message),
          message,
        ),
        true,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('local pair login rejects missing, mismatched, malformed and noncanonical credentials', async () => {
  const { importIdentityPair } = await import('./identity.js');
  assert.equal(typeof importIdentityPair, 'function');
  const original = JSON.parse(await exportIdentity(await createIdentity()));
  const other = JSON.parse(await exportIdentity(await createIdentity()));
  const valid = { address: original.address, privateKey: original.private_key };
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const alias = (value) => value.slice(0, -1) +
    alphabet[alphabet.indexOf(value.at(-1)) + 1];
  const invalid = [
    undefined, null, [], {},
    { ...valid, address: undefined },
    { ...valid, address: other.address },
    { ...valid, address: original.address.toUpperCase() },
    { ...valid, address: ' ' + original.address },
    { ...valid, privateKey: other.private_key },
    { ...valid, privateKey: '' },
    { ...valid, privateKey: 'a'.repeat(42) },
    { ...valid, privateKey: original.private_key + '=' },
    { ...valid, privateKey: original.private_key + '\n' },
    { ...valid, privateKey: alias(original.private_key) },
    { ...valid, privateKey: new Uint8Array(32) },
    { ...valid, publicKey: other.public_key },
    { ...valid, publicKey: '' },
    { ...valid, publicKey: original.public_key + '=' },
    { ...valid, publicKey: original.public_key + '\n' },
    { ...valid, publicKey: alias(original.public_key) },
    { ...valid, publicKey: new Uint8Array(32) },
  ];
  for (const credentials of invalid)
    await assert.rejects(importIdentityPair(credentials));
});

test('identity backup import rejects malformed envelopes and bounds credential input', async () => {
  for (const input of ['null', '[]', '42', '"value"', ' '.repeat(20001)])
    await assert.rejects(importIdentity(input), /identity|backup|invalid/i);
  const original = JSON.parse(await exportIdentity(await createIdentity()));
  for (const field of ['private_key', 'public_key']) {
    for (const value of ['', 'a'.repeat(42), original[field] + '=', original[field] + '\n'])
      await assert.rejects(importIdentity(JSON.stringify({ ...original, [field]: value })));
  }
});

async function admissionFixture(t,handler,{onWait}={}){
 const old={fetch:globalThis.fetch,location:globalThis.location,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout,random:Math.random},waits=[];
 globalThis.location={origin:'https://baink.example'};Math.random=()=>0;globalThis.setTimeout=(fn,ms)=>{waits.push(ms);onWait?.();queueMicrotask(fn);return 0;};globalThis.clearTimeout=()=>{};globalThis.fetch=handler;
 t.after(()=>{globalThis.fetch=old.fetch;globalThis.location=old.location;globalThis.setTimeout=old.setTimeout;globalThis.clearTimeout=old.clearTimeout;Math.random=old.random;});return{waits,who:await createIdentity()};
}
const admissionRefusal=(retryAfter=null,status=503,code='busy')=>new Response(JSON.stringify({error:{code}}),{status,headers:retryAfter===null?{}:{'Retry-After':retryAfter}});
test('only authenticated exact account GET can drain nine early refusals with capped waits and frozen signer',async t=>{
 const sent=[];let originalKey,other;const f=await admissionFixture(t,async(path,options)=>{sent.push({path,options});if(sent.length===1){f.who.privateKey=other.privateKey;f.who.publicKeyBase64=other.publicKeyBase64;}return sent.length<9?admissionRefusal():Response.json({ok:true});});originalKey=f.who.publicKey;const originalPublic=f.who.publicKeyBase64;other=await createIdentity();const deadlines=[],originalTimeout=AbortSignal.timeout;AbortSignal.timeout=ms=>{deadlines.push(ms);return originalTimeout(ms);};t.after(()=>{AbortSignal.timeout=originalTimeout;});assert.deepEqual(await api('/api/account',{identity:f.who}),{ok:true});assert.equal(sent.length,9);assert.deepEqual(deadlines,[30000]);assert.deepEqual(f.waits,[250,500,1000,2000,3000,3000,3000,3000]);assert.ok(f.waits.reduce((a,b)=>a+b,0)<=18000);assert.equal(new Set(sent.map(x=>x.options.headers['X-BAINK-Nonce'])).size,9);for(const{path,options}of sent){const h=options.headers;assert.equal(h['X-BAINK-Public-Key'],originalPublic);assert.equal(await crypto.subtle.verify('Ed25519',originalKey,Buffer.from(h['X-BAINK-Signature'],'base64'),new TextEncoder().encode(canonical({audience:'https://baink.example',method:'GET',path,body:{},nonce:h['X-BAINK-Nonce'],timestamp:h['X-BAINK-Timestamp']}))),true);}
});
test('extended account admission honors Retry-After only within eighteen seconds',async t=>{let calls=0,header='4';const f=await admissionFixture(t,async()=>{calls++;return admissionRefusal(header);});await assert.rejects(api('/api/account',{identity:f.who}),e=>e.code==='busy');assert.equal(calls,5);assert.deepEqual(f.waits,[4000,4000,4000,4000]);header='19';calls=0;f.waits.length=0;await assert.rejects(api('/api/account',{identity:f.who}),e=>e.code==='busy');assert.equal(calls,1);assert.deepEqual(f.waits,[]);});
test('POST, PATCH, other GET paths and unsigned account GET retain five attempts and ten-second wait budget',async t=>{let calls=0,header=null;const f=await admissionFixture(t,async()=>{calls++;return admissionRefusal(header);});for(const[path,options]of[['/api/account',{identity:f.who,method:'POST',body:{displayName:'Fixture'}}],['/api/account',{identity:f.who,method:'PATCH',body:{displayName:'Fixture'}}],['/api/account/metadata',{identity:f.who}],['/api/account?x=1',{identity:f.who}],['/api/account',{}]]){calls=0;f.waits.length=0;await assert.rejects(api(path,options));assert.equal(calls,5);assert.deepEqual(f.waits,[250,500,1000,2000]);}header='6';calls=0;f.waits.length=0;await assert.rejects(api('/api/account',{identity:f.who,method:'POST',body:{displayName:'Fixture'}}));assert.equal(calls,2);assert.deepEqual(f.waits,[6000]);});
test('extended account reads never retry network loss, timeouts or downstream/native errors',async t=>{let calls=0,response;const f=await admissionFixture(t,async()=>{calls++;if(response instanceof Error)throw response;return response();});for(response of [new TypeError('lost'),new DOMException('elapsed','TimeoutError'),()=>admissionRefusal(null,503,'native_unavailable'),()=>admissionRefusal(null,503,'storage_busy'),()=>admissionRefusal(null,429,'rate_limited'),()=>new Response('broken',{status:503})]){calls=0;await assert.rejects(api('/api/account',{identity:f.who}));assert.equal(calls,1);}});
test('abort during extended account admission prevents another signature or HTTP attempt',async t=>{const controller=new AbortController();let calls=0;const f=await admissionFixture(t,async()=>{calls++;return admissionRefusal();},{onWait:()=>controller.abort()});await assert.rejects(api('/api/account',{identity:f.who,signal:controller.signal}),e=>e.name==='AbortError');assert.equal(calls,1);});

test('owner cancellation during extended account wait cannot revive the old signer',async t=>{let calls=0,who;const f=await admissionFixture(t,async()=>{calls++;return admissionRefusal();},{onWait:()=>cancelIdentityRequests(who)});who=f.who;await assert.rejects(api('/api/account',{identity:who}),e=>e.name==='AbortError');assert.equal(calls,1);await assert.rejects(api('/api/account',{identity:who}),e=>e.name==='AbortError');assert.equal(calls,1);});

test('only authenticated central proof GETs reach a tenth attempt after nine exact busy refusals',async t=>{let sent=[];const f=await admissionFixture(t,async(path,options)=>{sent.push({path,options});return sent.length<10?admissionRefusal():Response.json({ok:true});});for(const path of ['/api/native/central/status','/api/native/central/tasks','/api/native/central/tasks?cursor=0&limit=12','/api/native/central/tasks/CT-1']){sent=[];f.waits.length=0;assert.deepEqual(await api(path,{identity:f.who}),{ok:true});assert.equal(sent.length,10);assert.deepEqual(f.waits,[250,500,1000,2000,3000,3000,3000,3000,3000]);assert.ok(f.waits.reduce((a,b)=>a+b,0)<=24000);assert.equal(new Set(sent.map(r=>r.options.headers['X-BAINK-Nonce'])).size,10);for(const{options}of sent){const h=options.headers;assert.equal(await crypto.subtle.verify('Ed25519',f.who.publicKey,Buffer.from(h['X-BAINK-Signature'],'base64'),new TextEncoder().encode(canonical({audience:'https://baink.example',method:'GET',path,body:{},nonce:h['X-BAINK-Nonce'],timestamp:h['X-BAINK-Timestamp']}))),true);}}});
test('central prepare POST keeps five pre-auth attempts and its exact original payload after caller mutation',async t=>{const original={operation:'central_submit',payload:{id:'CS-fixture',task:'CT-fixture',evidence:'42',evidence_digest:'a'.repeat(64)}},body=structuredClone(original),sent=[];const f=await admissionFixture(t,async(path,options)=>{sent.push({path,options});body.payload.evidence='changed';return admissionRefusal();});await assert.rejects(api('/api/native/central/prepare',{identity:f.who,method:'POST',body}),e=>e.code==='busy');assert.equal(sent.length,5);assert.deepEqual(f.waits,[250,500,1000,2000]);for(const{path,options}of sent){assert.deepEqual(JSON.parse(options.body),original);const h=options.headers;assert.equal(await crypto.subtle.verify('Ed25519',f.who.publicKey,Buffer.from(h['X-BAINK-Signature'],'base64'),new TextEncoder().encode(canonical({audience:'https://baink.example',method:'POST',path,body:original,nonce:h['X-BAINK-Nonce'],timestamp:h['X-BAINK-Timestamp']}))),true);}});
test('central intents, invalid detail routes, unsigned requests and receipt POSTs keep existing retry limit',async t=>{let calls=0;const f=await admissionFixture(t,async()=>{calls++;return admissionRefusal();});for(const[path,options]of [['/api/native/central/intents',{identity:f.who}],['/api/native/central/status?unknown=1',{identity:f.who}],['/api/native/central/tasks/CT-1/extra',{identity:f.who}],['/api/native/central/tasks',{}],['/api/native/central/intents/fixture/reconcile',{identity:f.who,method:'POST',body:{}}]]){calls=0;f.waits.length=0;await assert.rejects(api(path,options));assert.equal(calls,5);assert.deepEqual(f.waits,[250,500,1000,2000]);}});
test('central owner cancellation and unknown transport/downstream outcomes never retry',async t=>{let calls=0,who;const f=await admissionFixture(t,async()=>{calls++;return admissionRefusal();},{onWait:()=>cancelIdentityRequests(who)});who=f.who;await assert.rejects(api('/api/native/central/status',{identity:who}),e=>e.name==='AbortError');assert.equal(calls,1);const active=await createIdentity();globalThis.fetch=async()=>{calls++;throw new TypeError('unknown transport outcome')};calls=0;await assert.rejects(api('/api/native/central/status',{identity:active}));assert.equal(calls,1);globalThis.fetch=async()=>{calls++;return admissionRefusal(null,503,'central_proof_unavailable')};calls=0;await assert.rejects(api('/api/native/central/tasks',{identity:active}));assert.equal(calls,1);});

test('signed central GET admission never exceeds twelve attempts or24seconds of backoff',async t=>{let calls=0;const f=await admissionFixture(t,async()=>{calls++;return admissionRefusal();});await assert.rejects(api('/api/native/central/status',{identity:f.who}),e=>e.code==='busy');assert.ok(calls>=10&&calls<=12);assert.ok(f.waits.every(ms=>ms<=3000));assert.ok(f.waits.reduce((a,b)=>a+b,0)<=24000);assert.equal(f.waits.length,calls-1);});
test('central GET retries share one original30second deadline and cannot make a later attempt after it',async t=>{let calls=0,elapsed=0;const deadline=new AbortController(),timeouts=[];const originalTimeout=AbortSignal.timeout;AbortSignal.timeout=ms=>{timeouts.push(ms);return deadline.signal;};t.after(()=>{AbortSignal.timeout=originalTimeout;});const f=await admissionFixture(t,async()=>{calls++;elapsed+=1600;return admissionRefusal();},{onWait:()=>{elapsed+=3000;if(elapsed>=30000)deadline.abort(new DOMException('Shared deadline elapsed','TimeoutError'));}});await assert.rejects(api('/api/native/central/tasks',{identity:f.who}),e=>e.name==='TimeoutError');assert.deepEqual(timeouts,[30000]);assert.ok(calls<12);});
test('navigation cancellation during a central wait prevents another retry',async t=>{let calls=0,current=true;const f=await admissionFixture(t,async()=>{calls++;return admissionRefusal();},{onWait:()=>{current=false;}});await assert.rejects(api('/api/native/central/status',{identity:f.who,isCurrent:()=>current}),e=>e.name==='AbortError');assert.equal(calls,1);});
test('extended central reads retain the original signer and audience across exact client_busy refusals',async t=>{const sent=[];let other;const f=await admissionFixture(t,async(path,options)=>{sent.push({path,options});if(sent.length===1){f.who.privateKey=other.privateKey;f.who.publicKeyBase64=other.publicKeyBase64;globalThis.location.origin='https://changed.example';}return sent.length<=9?admissionRefusal(null,429,'client_busy'):Response.json({ok:true});});other=await createIdentity();const key=f.who.publicKey,publicKey=f.who.publicKeyBase64;assert.deepEqual(await api('/api/native/central/status',{identity:f.who}),{ok:true});assert.equal(sent.length,10);for(const{path,options}of sent){const h=options.headers;assert.equal(h['X-BAINK-Public-Key'],publicKey);assert.equal(await crypto.subtle.verify('Ed25519',key,Buffer.from(h['X-BAINK-Signature'],'base64'),new TextEncoder().encode(canonical({audience:'https://baink.example',method:'GET',path,body:{},nonce:h['X-BAINK-Nonce'],timestamp:h['X-BAINK-Timestamp']}))),true);}});
test('signed central GET network, malformed and downstream responses are never retried',async t=>{let calls=0,result;const f=await admissionFixture(t,async()=>{calls++;if(result instanceof Error)throw result;return result();});for(result of [new TypeError('network lost'),new DOMException('unknown timeout','TimeoutError'),()=>admissionRefusal(null,503,'storage_busy'),()=>admissionRefusal(null,503,'native_unavailable'),()=>admissionRefusal(null,429,'rate_limited'),()=>new Response('invalid',{status:503})]){calls=0;await assert.rejects(api('/api/native/central/status',{identity:f.who}));assert.equal(calls,1);}});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createBainkMcp} from '../server/mcp.mjs';

async function fixture(t) {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const handle = createBainkMcp({origins:[origin], admit(){}, requesterIp:()=> 'test', read(){throw Error('Discovery must not consult an upstream or private source');}});
  server.on('request', (req,res) => handle(req,res,new URL(req.url,origin)));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return async (method,params) => {
    const response = await fetch(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    return {status:response.status,body:await response.json()};
  };
}

test('BAINK publicly discovers both canonical MCPs without private access or upstream requests',async t=>{
  const call=await fixture(t), listed=(await call('tools/list',{})).body.result.tools;
  // 10 Nov 2026: connection metadata is advanced, so it is not listed; it still answers by name,
  // and the listed front door (baink_guide) names both endpoints.
  assert.ok(!listed.some(tool=>tool.name==='baink_connections'),'advanced metadata is not listed');
  const guide=listed.find(tool=>tool.name==='baink_guide');
  assert.ok(guide,'the front door is listed');
  assert.equal(guide.annotations.readOnlyHint,true);
  assert.equal(guide.inputSchema.additionalProperties,false);
  const front=(await call('tools/call',{name:'baink_guide',arguments:{}})).body.result.structuredContent;
  assert.match(JSON.stringify(front),/uain\.global\/mcp/);
  const response=await call('tools/call',{name:'baink_connections',arguments:{}});
  assert.equal(response.status,200);
  assert.equal(response.body.result.isError,false);
  const data=response.body.result.structuredContent;
  assert.equal(data.self,'baink');
  assert.deepEqual(data.connections.map(peer=>[peer.id,peer.endpoint]),[
    ['baink','https://baink.money/mcp'],['uain','https://uain.global/mcp'],
  ]);
  assert.ok(data.connections.every(peer=>peer.transport==='streamable-http'&&peer.authentication.publicReads==='none'));
  assert.equal(data.identity.keyType,'Ed25519');
  assert.equal(data.identity.sameHolderIdentity,true);
  assert.equal(data.identity.privateKeysAccepted,false);
  // 11 November 2026 (P0-2): nothing to install; the kit (stdio) is one optional mode.
  assert.equal(data.holderConnection.installationRequired,false);
  assert.deepEqual(data.holderConnection.modes.map(m=>[m.id,m.installationRequired]),[['sandbox',false],['kit',false],['chat-only',false]]);
  assert.equal(data.holderConnection.modes.find(m=>m.id==='kit').transport,'stdio');
  assert.equal(data.holderConnection.approvalRequiredForWrites,true);
  assert.equal(data.security.credentialForwardingAllowed,false);
  assert.equal(data.security.automaticPeerCalls,false);
  assert.ok(Buffer.byteLength(JSON.stringify(data))<12000);
});

test('peer discovery rejects caller-selected destinations and secrets before dispatch',async t=>{
  const call=await fixture(t);
  for(const args of [{url:'http://127.0.0.1/private'},{token:'untrusted-token'},{privateKey:'untrusted-key'}]){
    const response=await call('tools/call',{name:'baink_connections',arguments:args});
    assert.equal(response.body.error.code,-32602);
    assert.ok(!JSON.stringify(response.body).includes(Object.values(args)[0]));
  }
});

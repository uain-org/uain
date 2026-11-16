import test from 'node:test';
import assert from 'node:assert/strict';
import {registerNativeTools} from '../dist/src/api/native-tools.js';
import {MCP_CONNECTIONS as bainkConnections} from '../../../apps/baink/server/mcp-content.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';

function fixture(){
  const tools=new Map();
  registerNativeTools({registerTool(name,definition,callback){tools.set(name,{definition,callback});}},{text:value=>({content:[{type:'text',text:JSON.stringify(value)}]}),audit(){}});
  return tools;
}

test('native UAIN MCP discovers BAINK reciprocally without native configuration or database access',async()=>{
  const tool=fixture().get('uain_connections');
  assert.ok(tool,'reciprocal discovery tool must be registered');
  assert.equal(tool.definition.annotations.readOnlyHint,true);
  const result=await tool.callback({});
  const data=JSON.parse(result.content[0].text);
  assert.equal(data.self,'uain');
  assert.deepEqual({...data,self:'baink'},bainkConnections,'independently deployed peers must advertise the same routing/identity contract');
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
  assert.equal(data.security.credentialForwardingAllowed,false);
  assert.equal(data.security.automaticPeerCalls,false);
  assert.ok(data.routing.some(route=>route.service==='baink'&&route.capabilities.includes('peer-trade')));
  assert.ok(Buffer.byteLength(JSON.stringify(data))<12000);
});

test('native UAIN MCP has a plain-language start-here guide that grants nothing and covers the whole journey',async()=>{
  const tool=fixture().get('uain_guide');
  assert.ok(tool,'uain_guide must be registered');
  assert.equal(tool.definition.annotations.readOnlyHint,true);
  const data=JSON.parse((await tool.callback({})).content[0].text);
  const text=JSON.stringify(data);
  assert.ok(data.journey.length>=5&&data.journey.length<=8,'the first screen is the whole journey in a few steps');
  for(const word of ['uain-agent.mjs','uain_find_tasks','template','submit','history','pay'])assert.ok(text.includes(word),word);
  assert.match(text,/never sent again/i);
  assert.match(text,/no cash payout/i);
  assert.ok(data.topics.length>=15);
  assert.equal(data.nextStep.tool,'baink_signer','11 Nov 2026 (P0-2): nothing to install first');
  assert.ok(!/light wallet|holder-local wallet|docker holder/i.test(text),'no install route is offered for paying');
  assert.ok(!/AI agents/i.test(text.replace(/AI Agents, AGI, Super AI Systems/g,'')),'public copy names AI Agents, AGI, Super AI Systems');
  assert.ok(Buffer.byteLength(text)<8000);
});

test('uain_guide answers the questions newcomers ask with a short answer and the exact next call',async()=>{
  const tool=fixture().get('uain_guide');
  const ask=async(input)=>JSON.parse((await tool.callback(input)).content[0].text);
  for(const[question,topic,next]of[
    ['What is this and how do I start?','start','baink_signer'],
    ['Find me something I can do right now','find','uain_find_tasks'],
    ['Help me research this task and submit it','research','baink_agent_template'],
    ['I have an idea for a new project or discovery','idea','uain_search_research'],
    ['How much have I earned and how do I pay someone?','earned','baink_agent_status'],
    ['Something was rejected, what now?','rejected','baink_agent_history'],
    ['my submission needs more evidence','rejected','baink_agent_history'],
    ['Can I cash out AI$?','value','baink_agent_status'],
    ['I want to build a tool for a task','implement','uain_find_tasks'],
    ['Can I earn by checking other members\' work?','check-work','uain_find_tasks'],
    // 10 Nov MCP check: submission questions went to "research" (how to submit) instead of the outcome.
    ['What happened to my submission CS-9c1e0418-fdf7-45b5-b3ea-0e19812c8c67?','review','baink_agent_history'],
    ['What happened to my submission?','review','baink_agent_history'],
    ['Something I submitted, where is it?','review','baink_agent_history'],
    ['My submission was rejected, what now?','rejected','baink_agent_history'],
    ['How do I submit a task?','research','baink_agent_template'],
  ]){
    const r=await ask({question});
    assert.equal(r.topic,topic,question);
    assert.equal(r.nextStep.tool,next,question);
    assert.ok(r.answer.length<800,question);
    assert.ok(!/\b(shield|attested|custody|fence|holder|intent|epoch)\b/i.test(r.answer),question+': plain words');
  }
  assert.equal((await ask({question:'How much have I earned and how do I pay someone?'})).alsoAnswered.topic,'pay');
  const none=await ask({question:'xyzzy plugh'});
  assert.equal(none.match,'none');assert.ok(none.related.length>=3);assert.equal(none.nextStep.tool,'baink_signer');
  assert.equal((await ask({topic:'limits'})).topic,'limits');
  assert.match((await ask({question:'What can I earn here?'})).answer,/20 AI\$ for each record it covers/,'the earn answer says exactly how a task amount is set');
  assert.match((await ask({question:'I am ChatGPT in a browser chat and cannot run commands'})).answer,/OpenAI dots or Grok Bot/,'a chat-only assistant is pointed to an agent that can run commands');
});

test('the guide answer bank is one file: UAIN and BAINK copies are identical',async()=>{
  const {readFile}=await import('node:fs/promises');
  const here=new URL('.',import.meta.url);
  const uain=await readFile(new URL('../src/api/guide-answers.ts',here),'utf8');
  const baink=await readFile(new URL('../../../apps/baink/server/guide-answers.mjs',here),'utf8');
  assert.equal(baink,uain,'copy services/pilot/src/api/guide-answers.ts over apps/baink/server/guide-answers.mjs');
  const {ANSWERS}=await import('../../../apps/baink/server/guide-answers.mjs');
  assert.equal(new Set(ANSWERS.map(a=>a.topic)).size,ANSWERS.length,'topics are unique');
  // Karma v2 (DEC-TASK-057, DEC-CHAIN-039): Karma comes with AI$ and never falls; violations are strikes.
  const {scoreQuestion}=await import('../../../apps/baink/server/guide-answers.mjs');
  const karma=ANSWERS.find(a=>a.topic==='karma'),strikes=ANSWERS.find(a=>a.topic==='strikes');
  assert.match(karma.answer,/1 Karma per whole AI\$/);assert.match(karma.answer,/never goes down/);
  assert.match(strikes.answer,/10 strikes/);
  assert.equal(scoreQuestion('can I lose karma?')[0].a.topic,'strikes');
  assert.equal(scoreQuestion('what is karma')[0].a.topic,'karma');
  for(const a of ANSWERS){
    for(const r of a.related)assert.ok(ANSWERS.some(x=>x.topic===r),a.topic+' relates to '+r);
    assert.ok(a.next.kit||a.next.uain,a.topic+' has a next call');
    assert.ok(!/AI agents/i.test(a.answer.replace(/AI Agents, AGI, Super AI Systems/g,'')),a.topic);
  }
});

test('official MCP SDK initializes and calls reciprocal native discovery without credentials',async()=>{
  const server=new McpServer({name:'native-discovery-test',version:'1'});
  registerNativeTools(server,{text:value=>({content:[{type:'text',text:JSON.stringify(value)}]}),audit(){}});
  const client=new Client({name:'discovery-test',version:'1'}),[clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const {hideUnlistedTools}=await import('../dist/src/api/native-tools.js');
    assert.equal(hideUnlistedTools(server),true);
    const tools=(await client.listTools()).tools;
    assert.ok(!tools.some(tool=>tool.name==='uain_connections'),'advanced tools are not listed');
    assert.ok(tools.some(tool=>tool.name==='uain_guide'));
    for(const tool of tools){
      assert.match(tool.description,/^[A-Z][a-z]+ /,tool.name+' starts with a verb');
      assert.ok(!/\b(native|central|shield|attested|custody|fence|holder|intent|epoch|projection)\b/i.test(tool.description),tool.name+' uses plain words');
    }
    const result=await client.callTool({name:'uain_connections',arguments:{}});
    assert.notEqual(result.isError,true);
    const data=JSON.parse(result.content[0].text);
    assert.equal(data.connections.find(peer=>peer.id==='baink').endpoint,'https://baink.money/mcp');
    assert.equal(data.security.automaticPeerCalls,false);
    assert.equal(tools.find(tool=>tool.name==='uain_guide').inputSchema.additionalProperties,false);
    // An unknown field is refused, never silently ignored (uain_contributions {member} listed everyone's).
    for(const name of ['uain_find_tasks','uain_tasks','uain_projects','uain_directory','uain_contributions','uain_native_state'])
      assert.equal(tools.find(tool=>tool.name===name).inputSchema.additionalProperties,false,name+' refuses unknown fields');
    const unknown=await client.callTool({name:'uain_contributions',arguments:{member:'uain1'+'0'.repeat(40)}});
    assert.equal(unknown.isError,true);assert.match(JSON.stringify(unknown),/member/);
    const cs=JSON.parse((await client.callTool({name:'uain_contributions',arguments:{contribution_id:'CS-9c1e0418-fdf7-45b5-b3ea-0e19812c8c67'}})).content[0].text);
    assert.equal(cs.error,'not_readable_here');assert.match(cs.message,/history/);assert.equal(cs.nextStep.shell,'node uain-agent.mjs history');
    for(const field of ['privateKey','token','url']){
      const refused=await client.callTool({name:'uain_connections',arguments:{[field]:'dummy-not-for-echo'}});
      assert.equal(refused.isError,true);
      assert.ok(!JSON.stringify(refused).includes('dummy-not-for-echo'));
    }
  } finally {await client.close();await server.close();}
});

test('list views are compact enough for one agent tool call and every reply carries the next step',async()=>{
  const {compactList,START_NEXT,plainTaskList}=await import('../dist/src/api/native-tools.js');
  const big={count:1,page:1,tasks:[{id:'T-1',title:'A short title',question:'q'.repeat(2000),results:Array.from({length:200},(_,i)=>({id:'R'+i,text:'x'.repeat(200)})),closed_at:null,price:{karma:40}}]};
  const c=compactList(big,'Read one task in full with uain_tasks {task_id}.');
  assert.equal(c.count,1);assert.equal(c.tasks[0].id,'T-1');assert.equal(c.tasks[0].title,'A short title');
  assert.ok(c.tasks[0].question.length<=401);
  assert.deepEqual(c.tasks[0].results,{count:200,omitted:'Read one task in full with uain_tasks {task_id}.'});
  assert.deepEqual(c.tasks[0].price,{karma:40});
  assert.ok(!('closed_at' in c.tasks[0]));
  assert.ok(JSON.stringify(c).length<JSON.stringify(big).length/20);
  const guide=JSON.parse((await fixture().get('uain_guide').callback({})).content[0].text);
  assert.deepEqual(guide.nextStep,START_NEXT);
  assert.match(START_NEXT.do,/uain-agent\.mjs/,'the optional kit is still named');
  assert.match(JSON.stringify(guide.rules),/One task, then ask/);
  assert.doesNotMatch(JSON.stringify(guide.rules),/until none are left/);
  const found=fixture().get('uain_find_tasks');
  for(const k of ['q','project','cursor','limit','page','page_size','status'])assert.ok(found.definition.inputSchema.shape[k],k);
  const page=plainTaskList({totalOpen:224,count:13,matched:13,nextCursor:'12',more:true,canTakeOnThisPage:1,tasks:[{id:'T-survey',kind:'central',area:'Human Health & Longevity',title:'Telomeres',project_id:'P-OPP-00009',reward:{solver_ai:20},claimable:true}]});
  assert.equal(page.totalOpen,224);assert.equal(page.matched,13);assert.equal(page.nextCursor,'12');assert.equal(page.more,true);assert.equal(page.tasks[0].area,'Human Health & Longevity');assert.match(page.note,/224 tasks.*13 match.*page shows 1/);
  const list=plainTaskList({count:2,tasks:[{id:'T-37',title:'Karma task',kind:'research',status:'open',price:{karma:40}},{id:'T-OPP-1-1-prior-art-survey-r2-p1',kind:'central',title:'Survey part',project_id:'P-OPP-1',reward:{currency:'AI$',solver_ai:60,check_ai:10,solver_micro:'60000000',check_micro:'10000000'},criteria:'c'.repeat(500)}],authority:'native',app_hash:'ab'});
  assert.equal(list.paidTasks,1);
  assert.equal(list.tasks[0].id,'T-OPP-1-1-prior-art-survey-r2-p1','paid tasks come first');
  assert.equal(list.tasks[0].pays,'60 AI$');
  assert.ok(list.tasks[0].asks.length<=241);
  assert.equal(list.tasks[0].take,'node uain-agent.mjs template T-OPP-1-1-prior-art-survey-r2-p1');
  assert.equal(list.tasks[1].pays,'40 Karma, no AI$');
  assert.ok(!JSON.stringify(list).includes('solver_micro'));
  assert.equal(list.proof.app_hash,'ab','proof fields are kept, out of the way');
  const held=plainTaskList({tasks:[{id:'T-A',kind:'central',reward:{solver_ai:20},claimable:false,why_not_text:'Someone else is being reviewed for it.'},{id:'T-B',kind:'central',reward:{solver_ai:40},claimable:true}]});
  assert.deepEqual(held.tasks.map(t=>[t.id,t.canTakeNow]),[['T-B',true],['T-A',false]],'tasks you can take now come first');
  assert.equal(held.tasks[1].whyNot,'Someone else is being reviewed for it.');assert.ok(!('take' in held.tasks[1]));
  assert.equal(held.paidTasksOpenNow,1);
  const {fitOne}=await import('../dist/src/api/native-tools.js');
  const long=fitOne({id:'T-37',title:'t',question:'q'.repeat(5000),results:Array.from({length:300},(_,i)=>({id:'C'+i,text:'x'.repeat(400)}))});
  assert.ok(JSON.stringify(long).length<20000,'one long task fits an agent tool output');
  assert.equal(long.id,'T-37');assert.equal(long.results.count,300);assert.match(long.shortened,/uain_contributions/);
  assert.deepEqual(fitOne({id:'T-1',title:'short'}),{id:'T-1',title:'short'},'a normal record is unchanged');
  const unread=plainTaskList({tasks:[{id:'T-37',kind:'research',price:{karma:40}}],central:{status:'unavailable'}});
  assert.match(unread.howToTake,/could not be read just now/,'an unreadable paid list is never reported as none open');
  // 10 Nov round-2 runs: uain_tasks said not_found for the paid ids uain_find_tasks listed.
  const {paidTaskFrom}=await import('../dist/src/api/native-tools.js');
  const discovered={tasks:[{id:'T-37',kind:'research'},{id:'T-OPP-1-1-prior-art-survey-r2-p1',kind:'central',title:'Survey part',project_id:'P-OPP-1',reward:{solver_ai:60,check_ai:10},criteria:'Check the listed records.',claimable:true}]};
  const paid=paidTaskFrom(discovered,'T-OPP-1-1-prior-art-survey-r2-p1');
  assert.equal(paid.kind,'central');assert.equal(paid.pays,'60 AI$');assert.equal(paid.canTakeNow,true);
  assert.equal(paid.criteria,'Check the listed records.','the full criteria are kept');
  assert.equal(paid.take,'node uain-agent.mjs template T-OPP-1-1-prior-art-survey-r2-p1');
  assert.equal(paidTaskFrom(discovered,'T-37'),null,'only paid rows are matched');
  assert.equal(paidTaskFrom(discovered,'T-OPP-9-9'),null);
});

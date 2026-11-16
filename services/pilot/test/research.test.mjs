import assert from 'node:assert/strict';
import { after,before,test } from 'node:test';
import { createServer } from 'node:http';
import { boot } from './helpers.mjs';
import { chunks,vector,MODEL } from '../dist/src/research/embedding.js';
const hasVector = process.env.UAIN_TEST_VECTOR === '1';
let t,embedding,search,index,pool,fail=false,wrongModel=false;
before(async()=>{
  embedding=createServer(async(req,res)=>{
    let body=''; for await(const part of req) body+=part;
    if(req.headers.authorization !== 'Bearer test-only') {res.writeHead(401).end();return;}
    if(fail) {res.writeHead(503).end();return;}
    const {texts}=JSON.parse(body);
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({model:wrongModel?'other':MODEL,vectors:texts.map(text=>{
      const v=Array(384).fill(0); v[/repair|protein/i.test(text)?0:1]=1; return v;
    })}));
  });
  await new Promise(resolve=>embedding.listen(0,'127.0.0.1',resolve));
  t=await boot({UAIN_RESEARCH_SEARCH:hasVector?'1':'0',
    UAIN_EMBEDDING_ENDPOINT:`http://127.0.0.1:${embedding.address().port}`,UAIN_EMBEDDING_TOKEN:' test-only\n'});
  ({searchResearch:search,indexResearchOne:index}=await import('../dist/src/research/index.js'));
  ({pool}=await import('../dist/src/storage/store.js'));
});
after(async()=>{await t?.close(); await new Promise(resolve=>embedding?.close(resolve));});

test('embedding validation and bounded submitted-text chunking',()=>{
  assert.throws(()=>vector([1,2]));assert.throws(()=>vector(Array(384).fill(0)));
  assert.throws(()=>vector([NaN,...Array(383).fill(1)]));
  assert.equal(JSON.parse(vector([1,...Array(383).fill(0)])).length,384);
  const result=chunks({title:'Original',detail:'z'.repeat(500_000),token:'private'});
  assert.ok(result.length<=40); assert.ok(result.every(x=>x.length<=1500&&!x.includes('private')));
});
test('HTTP and MCP discovery expose retrieval with explicit validation',async()=>{
  assert.equal((await t.http('/api/research/search?q=&limit=0')).status,400);
  const client=await t.connect(); const tools=await client.client.listTools();
  assert.ok(tools.tools.some(tool=>tool.name==='uain_search_research'));
  if(!hasVector) assert.equal((await t.http('/api/research/search?q=protein')).status,503);
});

test('vector indexing, ranking, freshness, retries and deletion preserve ledger', {skip:!hasVector},async()=>{
  const lead=await t.enrol({name:'Search Author',operator:'Search Lab',model:'claude'});await t.makeUain(lead.id);
  const project=await t.db.propose({lead:lead.id,title:'Search fixture',summary:'Isolated retrieval tests.',stopConditions:['Halt for private data.']});
  const add=async(title,detail)=>t.db.contribute({contributor:lead.id,projectId:project.id,title,detail,artifacts:[],karmaClaimed:1});
  const a=await add('Protein repair','Repair proteins by folding and restoring damaged structures.');
  const b=await add('Agriculture','Improving potato crop growth and soil moisture.');
  const events=Number((await pool.query('SELECT count(*) AS n FROM events')).rows[0].n);
  await Promise.all([index(),index()]);
  assert.equal((await pool.query('SELECT count(*) AS n FROM research_jobs WHERE indexed_hash=source_hash')).rows[0].n,2);
  let result=await search({q:'protein repair',limit:2});
  assert.equal(result.matches[0].id,a.id);assert.equal(result.matches[0].state,'held');
  assert.match(result.matches[0].citation,/\/api\/contributions\/RC-/);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM events')).rows[0].n),events);
  await pool.query("UPDATE contributions SET state='contested' WHERE id=$1",[a.id]);
  result=await search({q:'repair',state:'contested',project:project.id});assert.equal(result.matches[0].state,'contested');
  await pool.query('UPDATE contributions SET detail=$2 WHERE id=$1',[a.id,'A revised research record.']);
  result=await search({q:'repair'});assert.ok(!result.matches.some(x=>x.id===a.id));
  fail=true; await assert.rejects(index());
  assert.equal((await pool.query('SELECT last_error FROM research_jobs WHERE contribution_id=$1',[a.id])).rows[0].last_error,'embedding_or_publish_failed');
  assert.equal((await search({q:'repair'})).error,'research_search_unavailable');
  fail=false; await pool.query('UPDATE research_jobs SET retry_at=now(),lease=$2,lease_until=now()-interval \'1 second\' WHERE contribution_id=$1',[a.id,'expired']);
  await index();assert.ok((await search({q:'repair'})).matches.some(x=>x.id===a.id));
  wrongModel=true;assert.equal((await search({q:'repair'})).error,'research_search_unavailable');wrongModel=false;
  await pool.query("UPDATE contributions SET kind='compute' WHERE id=$1",[b.id]);
  assert.equal((await pool.query('SELECT count(*) AS n FROM research_chunks WHERE contribution_id=$1',[b.id])).rows[0].n,0);
  await pool.query('DELETE FROM contributions WHERE id=$1',[a.id]);
  assert.equal((await pool.query('SELECT count(*) AS n FROM research_jobs')).rows[0].n,0);
  assert.deepEqual((await search({q:'repair'})).matches,[]);
});

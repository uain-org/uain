import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import { boot } from './helpers.mjs';
const pair=await generateKeyPair('EdDSA',{extractable:true});
const system=await boot({ADMIN_DELEGATION_KEYS:JSON.stringify({'https://campaign.test':await exportSPKI(pair.publicKey)})});
after(()=>system.close());
const {pool}=await import('../dist/src/storage/store.js');
const ref='campaignFixture20261019';
async function token() { return new SignJWT({actor:{issuer:'https://id.test',subject:'campaign-reader'},product:'uain',capability:'overview:read',grantVersion:1}).setProtectedHeader({alg:'EdDSA',typ:'admin-delegation+jwt'}).setIssuer('https://campaign.test').setAudience('uain-admin').setSubject('campaign-reader').setIssuedAt().setExpirationTime('90s').sign(pair.privateKey); }
const visit=(body)=>system.http('/api/campaign/visit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});

test('traffic stays anonymous, test requests stay separate, export needs a local admin grant',async()=>{
  assert.equal((await visit({ref:'bad',stage:'landing',is_test:false})).status,422);
  assert.equal((await visit({ref,stage:'enrolment',is_test:false})).status,422);
  assert.equal((await visit({ref,stage:'landing',is_test:false})).status,202);
  assert.equal((await visit({ref,stage:'landing',is_test:false})).status,202);
  assert.equal((await visit({ref,stage:'landing',is_test:true})).status,202);
  const instructions=await system.http(`/api/campaign/instructions?ref=${ref}&test=1`,{redirect:'manual'});
  assert.equal(instructions.status,302);
  assert.equal(instructions.headers.get('location'),'/access-guide.md');
  const headers={authorization:`Bearer ${await token()}`};
  assert.equal((await system.http('/api/campaign/attribution',{headers})).status,403);
  await pool.query("INSERT INTO portal_admin_grants VALUES('https://id.test','campaign-reader','overview:read',NULL)");
  const response=await system.http('/api/campaign/attribution?since=2026-01-01',{headers});
  assert.equal(response.status,200);
  assert.match(response.headers.get('cache-control'),/no-store/);
  const data=await response.json();
  assert.equal(data.rows.find(r=>r.ref===ref&&r.stage==='landing'&&!r.is_test).count,2);
  assert.equal(data.rows.find(r=>r.ref===ref&&r.stage==='landing'&&r.is_test).count,1);
  assert.equal(data.rows.find(r=>r.ref===ref&&r.stage==='instructions_requested').is_test,true);
  assert.ok(data.unsupported_stages.includes('enrolment'));
  const columns=(await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='campaign_daily'")).rows.map(r=>r.column_name).sort();
  assert.deepEqual(columns,['count','day','is_test','ref','stage']);
  assert.equal((await system.http('/api/campaign/attribution?since=2026-02-31',{headers})).status,422);
  await pool.query('UPDATE portal_admin_grants SET revoked_at=now()');
  assert.equal((await system.http('/api/campaign/attribution',{headers})).status,403);
});

test('funnel steps and poll answers are counted apart from attribution rows',async()=>{
  await pool.query('UPDATE portal_admin_grants SET revoked_at=NULL');
  assert.equal((await visit({ref:'organic-visitor',stage:'poll_cost',is_test:false})).status,202);
  assert.equal((await visit({ref,stage:'click_try',is_test:false})).status,202);
  assert.equal((await visit({ref,stage:'poll_free_text',is_test:false})).status,422);
  const data=await (await system.http('/api/campaign/attribution?since=2026-01-01',{headers:{authorization:`Bearer ${await token()}`}})).json();
  assert.equal(data.funnel_rows.find(r=>r.ref==='organic-visitor'&&r.stage==='poll_cost').count,1);
  assert.equal(data.funnel_rows.find(r=>r.ref===ref&&r.stage==='click_try').count,1);
  assert.equal(data.rows.some(r=>r.stage.startsWith('poll_')||r.stage.startsWith('click_')),false);
});

test('waitlist attribution counts existing rows without turning registration into membership',async()=>{
  await pool.query('UPDATE portal_admin_grants SET revoked_at=NULL');
  const registration={name:'Campaign fixture',description:'Test-only waitlist registration',system_types:['ai_agent'],email:'fixture@example.org',referrer:'campaign:'+ref,channel:'web'};
  const post=()=>system.http('/api/waitlist',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(registration)});
  assert.equal((await post()).status,201);
  assert.equal((await post()).status,200);
  const response=await system.http('/api/campaign/attribution?since=2026-01-01',{headers:{authorization:`Bearer ${await token()}`}});
  const data=await response.json();
  assert.equal(data.rows.find(r=>r.ref===ref&&r.stage==='waitlist').count,1);
  assert.equal(JSON.stringify(data).includes('fixture@example.org'),false);
});

test('the anonymous poll takes POST only: no DELETE is offered or accepted (10 November 2026)',async()=>{
  const pre=await system.http('/api/campaign/visit',{method:'OPTIONS'});
  assert.equal(pre.status,204);
  assert.equal(pre.headers.get('access-control-allow-methods'),'POST, OPTIONS');
  assert.notEqual((await system.http('/api/campaign/visit',{method:'DELETE'})).status,202);
  assert.doesNotMatch((await system.http('/api/projects',{method:'OPTIONS'})).headers.get('access-control-allow-methods'),/DELETE/);
  assert.match((await system.http('/mcp',{method:'OPTIONS'})).headers.get('access-control-allow-methods'),/DELETE/,'MCP clients end sessions with DELETE');
});

// P2-2 (13 November 2026): any 12-80 character ref made a new row, so a script
// could grow the table without bound and, past 10,000 rows, the export threw.
test('a flood of invented refs is folded, and the export still answers',async()=>{
  const {countCampaign,campaignCounts,CAMPAIGN_REFS_PER_DAY}=await import('../dist/src/api/campaign.js');
  const today=new Date().toISOString().slice(0,10);
  for (let i=0;i<CAMPAIGN_REFS_PER_DAY+50;i++) await countCampaign(`floodref${String(i).padStart(8,'0')}`,'landing',false);
  await countCampaign(ref,'landing',false); // a ref already counted today keeps its own row
  const refs=(await pool.query('SELECT count(DISTINCT ref)::int AS n FROM campaign_daily WHERE day=$1',[today])).rows[0].n;
  assert.ok(refs<=CAMPAIGN_REFS_PER_DAY+1,`refs today: ${refs}`);
  const overflow=(await pool.query("SELECT sum(count)::int AS n FROM campaign_daily WHERE day=$1 AND ref='overflow-refs'",[today])).rows[0].n;
  assert.ok(overflow>=50,`overflow: ${overflow}`);
  // Rows already in the table (older days, written before the cap) past the old 10,000-row trip.
  await pool.query(`INSERT INTO campaign_daily(day,ref,stage,is_test,count)
    SELECT to_char(date '2026-02-01' + (i % 60),'YYYY-MM-DD'),'oldref'||lpad(i::text,10,'0'),'landing',false,1
    FROM generate_series(1,10050) AS i`);
  const data=await campaignCounts('2026-01-01');
  assert.ok(data.rows.filter(r=>r.stage!=='waitlist').length+data.funnel_rows.length<=10000);
  assert.equal(data.truncated,true);
  assert.ok(data.rows.some(r=>r.ref===ref&&r.stage==='landing'));
  assert.equal(typeof data.rows[0].count,'number');
  const response=await system.http('/api/campaign/attribution?since=2026-01-01',{headers:{authorization:`Bearer ${await token()}`}});
  assert.equal(response.status,200);
});

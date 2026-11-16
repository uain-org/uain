import {test} from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
const central=await import('../dist/src/native/central-discovery.js').catch(()=>({}));
const holds=await import('../dist/src/native/central-task-holds.js').catch(()=>({}));
const query=await import('../dist/src/native/public-query.js').catch(()=>({}));
const reading=await import('../dist/src/native/public-read.js').catch(()=>({}));
const sha=s=>createHash('sha256').update(s).digest('hex');
const pins={chainId:'c',epoch:'e'.repeat(64)};
function task(id,project,over={}){const criteria='Report the existing work for '+id;return{id,project,title:'Survey for '+id,criteria,acceptance_digest:sha(criteria),eligibility:'new',eligibility_digest:'1'.repeat(64),solver_amount:'50000000',reviewer_amount:'5000000',evidence_digest:'2'.repeat(64),state:'open',pending:'',winner:'',reserved:'55000000',paid:'0',...over}}
function store(tasks){const records={central_task_count:String(tasks.length)};tasks.forEach((t,i)=>{records['central_task_index/'+String(i+1).padStart(20,'0')]={id:t.id,project:t.project};records['central_task/'+t.id]=t});return records}
const reader=(records,calls=[])=>async keys=>{calls.push(keys);assert.ok(keys.length<=600);return Object.fromEntries(keys.map(k=>[k,records[k]??null]))};

test('pilot hold list is an exact copy of the BAINK operator hold file',async()=>{
 const baink=JSON.parse(await readFile(new URL('../../../apps/baink/server/central-task-holds.json',import.meta.url),'utf8'));
 assert.deepEqual(JSON.parse(JSON.stringify(holds.CENTRAL_TASK_HOLDS)),baink,'update services/pilot/src/native/central-task-holds.ts from apps/baink/server/central-task-holds.json');
});

test('central discovery lists only open, fully funded tasks with nothing pending, newest first',async()=>{
 const tasks=[task('T-OPP-00001-1-prior-art-survey','P-1'),task('T-unfunded','P-1',{state:'open_unfunded',reserved:'0'}),task('T-pending','P-1',{pending:'S-1'}),task('T-won','P-1',{state:'accepted',winner:'S-2',pending:'',reserved:'0',paid:'55000000'}),task('T-short','P-1',{reserved:'54999999'}),task('T-OPP-00005-1-prior-art-survey-r2-p1','P-2',{solver_amount:'1500000',reviewer_amount:'250000',reserved:'1750000'}),task('T-hidden','P-hidden')];
 const result=await central.centralDiscovery(reader(store(tasks)),{pins,isProjectVisible:id=>id!=='P-hidden',projectTitle:async id=>id==='P-2'?'Second project':null});
 assert.equal(result.status,'available');assert.equal(result.total,'7');assert.equal(result.truncated,false);
 assert.deepEqual(result.rows.map(r=>r.id),['T-OPP-00005-1-prior-art-survey-r2-p1','T-OPP-00001-1-prior-art-survey']);
 assert.deepEqual(result.rows[0],{id:'T-OPP-00005-1-prior-art-survey-r2-p1',kind:'central',authority:'native',project_id:'P-2',project_title:'Second project',title:'Survey for T-OPP-00005-1-prior-art-survey-r2-p1',status:'open',status_label:'Open',claimable:true,why_not:null,why_not_text:null,payout:'immediate',
  reward:{currency:'AI$',solver_ai:1.5,check_ai:0.25,solver_micro:'1500000',check_micro:'250000'},criteria:tasks[5].criteria,acceptance_digest:tasks[5].acceptance_digest,eligibility:'new',
  how_to_contribute:{via:'BAINK',mcp:'https://baink.money/mcp',template:'https://baink.money/api/native/central/survey-template/T-OPP-00005-1-prior-art-survey-r2-p1',steps:'claimable: true means you can take it now. Enrol at baink.money with your own key, join the project, draft from the template, submit; central UAIN review pays AI$.'}});
 assert.equal(result.rows[1].project_title,undefined,'an unknown project title is omitted, never invented');
 assert.equal(result.rows[1].reward.solver_ai,50);
 assert.equal(central.centralDiscoveryRow(task('T-other','P-1')).how_to_contribute.template,undefined,'only prior-art surveys carry a template');
});

test('central discovery says why unlisted tasks cannot be taken, and a 0-score rejection leaves the task not funded',async()=>{
 const tasks=[task('T-open','P-1'),task('T-unfunded','P-1',{state:'open_unfunded',reserved:'0'}),task('T-rejected','P-1',{state:'open_unfunded',reserved:'0',paid:'5000000'}),task('T-pending','P-1',{state:'under_review',pending:'S-1'}),task('T-won','P-1',{state:'accepted',winner:'S-2',reserved:'0',paid:'55000000'}),task('T-short','P-1',{reserved:'54999999'}),task('T-hidden','P-hidden',{pending:'S-3'})];
 const result=await central.centralDiscovery(reader(store(tasks)),{pins,isProjectVisible:id=>id!=='P-hidden'});
 assert.deepEqual(result.rows.map(r=>[r.id,r.claimable,r.why_not]),[['T-open',true,null]]);
 assert.deepEqual(result.not_claimable,{won:1,under_review:1,not_funded:3},'hidden projects are not counted');
 for(const [t,why] of [[tasks[2],'not_funded'],[tasks[3],'under_review'],[tasks[4],'won'],[task('T-x','P-1',{state:'retired'}),'closed']]){const c=central.centralTaskClaim(t);assert.equal(c.claimable,false);assert.equal(c.why_not,why);assert.match(c.why_not_text,/\w/);}
 assert.equal(central.centralTaskClaim(tasks[0],true).why_not,'on_hold');assert.equal(central.centralTaskClaim(tasks[0]).claimable,true);
});

test('central-task-states-v1: contests list until closes_at with plain labels; conditional tasks name their condition',async()=>{
 const now=Date.parse('2026-11-10T00:00:00Z'),s=n=>String(Math.floor(now/1000)+n);
 const contest=task('T-contest','P-1',{state:'contest_open',mode:'contest',closes_at:s(3600),select_by:s(3600+259200),max_entries:'20',entries:'3',hash_version:2});
 const conditional=task('T-cond','P-1',{payout:'conditional',condition:'The named bill passes into law.',resolves_by:'1798761600',hash_version:2});
 assert.equal(central.centralTaskOpen(contest,now),true);
 assert.deepEqual(central.centralTaskClaim(contest,false,now),{claimable:true,why_not:null,why_not_text:null});
 assert.equal(central.centralTaskStatus(contest,now).status_label,'Contest: best entry by 2026-11-10 01:00 UTC wins');
 assert.equal(central.centralTaskClaim(contest,false,now+3600*1000).why_not,'contest_closed');
 assert.match(central.centralTaskStatus(contest,now+3600*1000).status_label,/^Judging entries; the winner is chosen by 2026-11-13 01:00 UTC$/);
 assert.equal(central.centralTaskClaim({...contest,entries:'20'},false,now).why_not,'contest_full');
 assert.equal(central.centralTaskClaim(contest,true,now).why_not,'on_hold');
 assert.equal(central.centralTaskStatus(conditional,now).status_label,'Open: paid only if this happens: The named bill passes into law. (by 2027-01-01 00:00 UTC)');
 const won={...conditional,state:'conditional_approved',winner:'S-1',reserved:'50000000',paid:'5000000'};
 assert.equal(central.centralTaskClaim(won).why_not,'won_conditionally');assert.match(central.centralTaskClaim(won).why_not_text,/condition/);
 assert.equal(central.centralTaskStatus(won).status_label,'Approved if this happens: The named bill passes into law. (by 2027-01-01 00:00 UTC)');
 for(const [state,label] of [['conditional_expired','Not paid: the condition did not happen in time'],['no_winner','Contest closed with no winner'],['accepted','Approved'],['under_review','Being checked'],['open_unfunded','Not funded yet']])assert.equal(central.centralTaskStatus(task('T-s','P-1',{state})).status_label,label);
 const row=central.centralDiscoveryRow(contest);
 assert.equal(row.mode,'contest');assert.equal(row.max_entries,20);assert.equal(row.entries,3);assert.equal(row.payout,'immediate');assert.match(row.closes_at,/UTC$/);
 const crow=central.centralDiscoveryRow(conditional);
 assert.equal(crow.payout,'conditional');assert.equal(crow.condition,'The named bill passes into law.');assert.equal(crow.resolves_by,'2027-01-01 00:00 UTC');assert.equal(crow.status,'open');
 const later=task('T-later','P-1',{state:'contest_open',mode:'contest',closes_at:String(Math.floor(Date.now()/1000)+86400),select_by:String(Math.floor(Date.now()/1000)+86400*4),max_entries:'2',entries:'0'});
 const result=await central.centralDiscovery(reader(store([later,won])),{pins});
 assert.deepEqual(result.rows.map(r=>[r.id,r.status]),[['T-later','contest_open']]);
 assert.deepEqual(result.not_claimable,{won_conditionally:1});
});

test('BAINK operator holds hide exact matching tasks only on the pinned chain',async()=>{
 const policy=holds.CENTRAL_TASK_HOLDS,hold=policy.holds[0],held={...task(hold.taskId,hold.projectId),acceptance_digest:hold.criteriaDigest,evidence_digest:hold.evidenceDigest};
 const live={chainId:policy.chainId,epoch:policy.genesisSha256};
 assert.equal(central.centralTaskHeld(held,live),true);
 assert.equal(central.centralTaskHeld(held,pins),false,'another chain is not held');
 assert.equal(central.centralTaskHeld({...held,evidence_digest:'3'.repeat(64)},live),false,'a changed task is not held');
 assert.equal(central.centralTaskHeld(task('T-OPP-00005-1-prior-art-survey-r2-p1','P-OPP-00005'),live),false);
});

test('central reads are bounded to the newest 512 and fail soft on a malformed proof',async()=>{
 const many=Array.from({length:520},(_,i)=>task('T-'+i,'P-1')),calls=[];
 const result=await central.centralDiscovery(reader(store(many),calls),{pins});
 assert.equal(result.status,'available');assert.equal(result.read,512);assert.equal(result.truncated,true);assert.equal(result.rows[0].id,'T-519');assert.equal(result.rows.at(-1).id,'T-8');
 assert.equal(calls.length,33,'count, then 512 index keys and 512 records in reads of at most 32 keys');assert.ok(calls.every(k=>k.length<=32));
 const empty=await central.centralDiscovery(reader({}),{pins});assert.deepEqual([empty.status,empty.rows.length,empty.total],['available',0,'0']);
 const records=store([task('T-1','P-1')]);records['central_task/T-1']={...records['central_task/T-1'],criteria:'changed'};
 assert.deepEqual(await central.centralDiscovery(reader(records),{pins}),{status:'unavailable',rows:[]});
 assert.deepEqual(await central.centralDiscovery(async()=>{throw Error('verifier down')},{pins}),{status:'unavailable',rows:[]});
});

test('the proved public reader serves central keys in batches of at most 32',async()=>{
 const records=store(Array.from({length:40},(_,i)=>task('T-'+i,'P-1'))),sizes=[];
 const r=reading.createNativePublicReader({epoch:'e',query:async()=>({rows:[]}),read:async s=>{sizes.push(s.keys.length);return{chain_id:'c',height:'1',records:Object.fromEntries(s.keys.map(k=>[k,records[k]??null]))}}});
 const result=await central.centralDiscovery(async keys=>(await r.records(keys)).records,{pins});
 assert.equal(result.rows.length,40);assert.ok(sizes.every(n=>n<=32));
});

// T-36, not T-37: T-37 is closed to new work since 10 November 2026 (native/public-read.ts).
test('discovery merges central rows into open/all pages with exact counts and filters',async()=>{
 const legacy={id:'T-36',project_id:'P',title:'Legacy question',question:'Unresolved exact question?',done_when:'Publish exact reproducible measurements',how_to_check:'Reproduce from pinned public sources',status:'open',kind:'instant',results:[],prior_art:{statement:'No published measurement answers this question',searched:['actual literature search','actual public repository search']},verification:null,benevolence:{class:'unreviewed'},prior_art_challenges:[],benevolence_flags:[],novelty:'stated',research_policy:'legacy',submission:{state:'open'}};
 const projects={P:{id:'P',title:'Legacy project',state:'active',research_policy:'legacy',work_count:0,work_limit:128,benevolence_flags:[],prior_art:legacy.prior_art,benevolence:null}};
 const found=await central.centralDiscovery(reader(store([task('T-OPP-00005-1-prior-art-survey-r2-p1','P-2'),task('T-OPP-00006-1-prior-art-survey-r2-p1','P-3')])),{pins,projectTitle:async()=>'Org project'});
 const run=(q,c=found)=>query.queryNativePublicRows(new URL('https://uain.invalid/api/tasks?discover=1'+q),[legacy],projects,'2026-11-09T00:00:00Z',c);
 const base=run('&status=open');const legacyOnly=query.queryNativePublicRows(new URL('https://uain.invalid/api/tasks?discover=1&status=open'),[legacy],projects,'2026-11-09T00:00:00Z');
 assert.equal(legacyOnly.count,1,'the legacy row is discoverable in this fixture');
 assert.equal(base.count,3);assert.deepEqual(base.tasks.map(t=>t.id),['T-36','T-OPP-00006-1-prior-art-survey-r2-p1','T-OPP-00005-1-prior-art-survey-r2-p1']);
 assert.deepEqual(base.tasks[0],legacyOnly.tasks[0],'legacy row shape is unchanged');
 assert.deepEqual(base.central,{status:'available',listed:2,read:2,total:'2',truncated:false,via:'BAINK'});
 const page=run('&status=open&page_size=2&page=2');assert.deepEqual([page.count,page.pages,page.tasks.length,page.tasks[0].id],[3,2,1,'T-OPP-00005-1-prior-art-survey-r2-p1']);
 assert.deepEqual(run('&q=00006').tasks.map(t=>t.id),['T-OPP-00006-1-prior-art-survey-r2-p1'],'q matches central ids and titles');
 assert.equal(run('&q=survey for t-opp-00005').count,1);
 assert.equal(run('&status=all').count,3);
 const answered=run('&status=answered');assert.equal(answered.tasks.some(t=>t.kind==='central'),false);assert.equal(answered.central,undefined);
 assert.equal(run('&status=open&project=P-3').count,1);
 const down=run('&status=open',{status:'unavailable',rows:[]});assert.equal(down.count,1);assert.deepEqual(down.central,{status:'unavailable'});
 const catalogue=query.queryNativePublicRows(new URL('https://uain.invalid/api/tasks'),[legacy],projects,'2026-11-09T00:00:00Z',found);
 assert.equal(catalogue.count,1);assert.equal(catalogue.central,undefined,'the non-discovery catalogue is unchanged');
});

test('uain_find_tasks says in plain words that paid tasks come first and how to take them',async()=>{
 const source=await readFile(new URL('../src/api/native-tools.ts',import.meta.url),'utf8'),line=source.split('\n').find(l=>l.includes("registerTool('uain_find_tasks'"));
 const description=line.match(/description:'([^']*)'/)[1];
 assert.match(description,/paid ones first/);assert.match(description,/AI\$/);assert.match(description,/how to take it/);
 assert.doesNotMatch(description,/\b(central|native|proved|finalized)\b/i,'no internal words in what a member sees');
 assert.doesNotMatch(description.replace(/AI Agents, AGI, Super AI Systems/g,''),/AI agents/i);
});

test('project rows count their open central tasks without changing other task counts',()=>{
 const rows=[{id:'P-OPP-00005',tasks:{open:0,total:0}},{id:'P-OPP-00242',tasks:{open:1,total:2}}];
 const out=central.withCentralOpenCounts(rows,[{project_id:'P-OPP-00005'},{project_id:'P-OPP-00005'},{project_id:'P-OPP-99999'}]);
 assert.deepEqual(out.map(r=>r.tasks),[{open:0,total:0,central_open:2},{open:1,total:2,central_open:0}]);
 assert.deepEqual(rows[0].tasks,{open:0,total:0});
});

test('proved central results are reused for 30 seconds, and only available ones are kept',async()=>{
 let loads=0;const load=async()=>({status:'available',rows:[{n:++loads}]});
 const a=await central.cachedCentralDiscovery('k1',load,1000),b=await central.cachedCentralDiscovery('k1',load,1000+central.CENTRAL_CACHE_MS-1);
 assert.equal(loads,1);assert.deepEqual(b.rows,a.rows);assert.equal(b.cached_at,new Date(1000).toISOString());
 const stale=await central.cachedCentralDiscovery('k1',load,1000+central.CENTRAL_CACHE_MS);assert.deepEqual(stale.rows,a.rows,'a stale result answers at once');await new Promise(r=>setImmediate(r));assert.equal(loads,2,'one background refresh');
 const fresh=await central.cachedCentralDiscovery('k1',load,1000+central.CENTRAL_CACHE_MS+1);assert.deepEqual(fresh.rows,[{n:2}]);
 await central.cachedCentralDiscovery('k1',load,1000+central.CENTRAL_CACHE_MS+central.CENTRAL_STALE_MS+1);assert.equal(loads,3,'too old: proved again before answering');
 let bad=0;const unavailable=async()=>(bad++,{status:'unavailable',rows:[]});
 await central.cachedCentralDiscovery('k2',unavailable,5000);await central.cachedCentralDiscovery('k2',unavailable,5001);assert.equal(bad,2);
});

test('a changed visibility version, chain or epoch misses the central cache, and discovery shows cached_at',async()=>{
 let loads=0;const load=async()=>({status:'available',rows:[],read:0,total:'0',truncated:false,n:++loads});
 const key=(chain,epoch,visibility)=>JSON.stringify(['tasks',chain,epoch,visibility]);
 await central.cachedCentralDiscovery(key('c','e',1),load,1000);await central.cachedCentralDiscovery(key('c','e',1),load,1001);assert.equal(loads,1);
 await central.cachedCentralDiscovery(key('c','e',2),load,1002);assert.equal(loads,2);
 await central.cachedCentralDiscovery(key('c2','e',1),load,1003);await central.cachedCentralDiscovery(key('c','e2',1),load,1004);assert.equal(loads,4);
 const hit=await central.cachedCentralDiscovery(key('c','e2',1),load,1005);
 const page=query.queryNativePublicRows(new URL('https://uain.invalid/api/tasks?discover=1&status=open'),[],{},'2026-11-09T00:00:00Z',hit);
 assert.equal(page.central.cached_at,new Date(1004).toISOString());
});

test('rows proved in separate reads carry their heights and the page says it is not one snapshot',async()=>{
 const records={},crit='criteria text',digest=createHash('sha256').update(crit).digest('hex');
 const task=(id)=>({id,project:'P-OPP-00005',title:id,criteria:crit,acceptance_digest:digest,evidence_digest:'e'.repeat(64),solver_amount:'60000000',reviewer_amount:'10000000',reserved:'70000000',paid:'0',state:'open',pending:'',winner:'',eligibility:'new'});
 records.central_task_count='2';records['central_task_index/'+'2'.padStart(20,'0')]={id:'T-B',project:'P-OPP-00005'};records['central_task_index/'+'1'.padStart(20,'0')]={id:'T-A',project:'P-OPP-00005'};
 records['central_task/T-A']=task('T-A');records['central_task/T-B']=task('T-B');
 // Each read is its own proof at a later height, as when events land between batches.
 let height=100;const heights=new Map();const read=async keys=>{height+=5;for(const k of keys)heights.set(k,String(height));return Object.fromEntries(keys.map(k=>[k,records[k]]))};
 const out=await central.centralDiscovery(read,{pins:{chainId:'c',epoch:'e'},heightOf:k=>heights.get(k)});
 assert.equal(out.status,'available');assert.deepEqual(out.rows.map(r=>r.proved_height),['115','115']);
 assert.deepEqual(out.proved_heights,{min:'115',max:'115'});assert.equal(out.consistent_snapshot,false);
 const page=query.queryNativePublicRows(new URL('https://uain.invalid/api/tasks?discover=1&status=open'),[],{},'2026-11-09T00:00:00Z',out);
 assert.equal(page.central.consistent_snapshot,false);assert.deepEqual(page.central.proved_heights,{min:'115',max:'115'});
 const strict=await central.centralDiscovery(read,{pins:{chainId:'c',epoch:'e'}});assert.equal(strict.consistent_snapshot,undefined);assert.equal(strict.rows[0].proved_height,undefined);
});

test('central reads never ask the native bridge for more than 32 keys at once',async()=>{
 const many=Array.from({length:134},(_,i)=>task('T-'+i,'P-1')),calls=[];
 const result=await central.centralDiscovery(async keys=>{calls.push(keys.length);if(keys.length>32)throw Error('bounded public keys required');return Object.fromEntries(keys.map(k=>[k,store(many)[k]??null]))},{pins});
 assert.equal(result.status,'available');assert.equal(result.rows.length,134);assert.ok(calls.every(n=>n<=32),String(calls));
});

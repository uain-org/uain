// /tasks status tabs (16 November 2026): open, answered, under review and closed, each with its
// count, for original-policy tasks and central (BAINK) tasks alike.
import {test} from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const query=await import('../dist/src/native/public-query.js');
const central=await import('../dist/src/native/central-discovery.js');
const sha=s=>createHash('sha256').update(s).digest('hex');
function ctask(id,over={}){const criteria='Report the existing work for '+id;return{id,project:'P-OPP-1',title:'Survey for '+id,criteria,acceptance_digest:sha(criteria),eligibility:'new',eligibility_digest:'1'.repeat(64),solver_amount:'40000000',reviewer_amount:'5000000',evidence_digest:'2'.repeat(64),state:'open',pending:'',winner:'',reserved:'45000000',paid:'0',...over}}
function store(tasks){const r={central_task_count:String(tasks.length)};tasks.forEach((t,i)=>{r['central_task_index/'+String(i+1).padStart(20,'0')]={id:t.id,project:t.project};r['central_task/'+t.id]=t});return r}
const reader=records=>async keys=>Object.fromEntries(keys.map(k=>[k,records[k]??null]));
const pins={chainId:'c',epoch:'e'};
const legacy=(id,status)=>({id,project_id:'P',title:'Original '+id,question:'Exact question?',done_when:'Exact output',how_to_check:'Reproduce',status,kind:'instant',results:status==='answered'?[{id:'RC-'+id,state:'settled'}]:[],price:status==='answered'?{won_by:'RC-'+id}:undefined,prior_art:{statement:'No published answer',searched:['actual literature search','actual repository search']},verification:null,benevolence:{class:'unreviewed'},prior_art_challenges:[],benevolence_flags:[],novelty:'stated',research_policy:'legacy',submission:{state:status==='closed'?'closed':'open',count:1,limit:128,malevolent:false}});
const projects={P:{id:'P',title:'Original project',state:'active',research_policy:'legacy',work_count:1,work_limit:128,prior_art:{statement:'basis',searched:['actual project literature search','actual project repository search']},benevolence:{class:'unreviewed'},benevolence_flags:[]}};

test('central tasks that are not open land in the tab their state belongs to',async()=>{
 const tasks=[ctask('T-open'),ctask('T-won',{state:'accepted',winner:'CS-1'}),ctask('T-review',{state:'under_review',pending:'CS-2'}),ctask('T-unfunded',{state:'open_unfunded',reserved:'0'}),ctask('T-closed',{state:'closed'})];
 const out=await central.centralDiscovery(reader(store(tasks)),{pins});
 assert.deepEqual(out.rows.map(r=>r.id),['T-open'],'open rows are unchanged');
 assert.deepEqual(Object.fromEntries(out.history.map(r=>[r.id,r.status])),{'T-won':'answered','T-review':'under_review','T-unfunded':'closed','T-closed':'closed'});
 const won=out.history.find(r=>r.id==='T-won');assert.equal(won.read_only,true);assert.equal(won.winner,'CS-1');assert.equal(won.claimable,false);assert.equal(won.status_label,'Answered');
 assert.deepEqual(out.not_claimable,{won:1,under_review:1,not_funded:1,closed:1},'not_claimable counts are unchanged');
});

test('every tab lists its tasks and reports all four counts from one read',async()=>{
 const tasks=[ctask('T-open'),ctask('T-won',{state:'accepted',winner:'CS-1'}),ctask('T-review',{state:'under_review',pending:'CS-2'}),ctask('T-closed',{state:'closed'})];
 const c=await central.centralDiscovery(reader(store(tasks)),{pins});
 const rows=[legacy('T-1','open'),legacy('T-2','answered'),legacy('T-3','awaiting_verification'),legacy('T-4','needs_comparison'),legacy('T-5','closed')];
 const ask=(status,extra='')=>query.queryNativePublicRows(new URL('https://uain.invalid/api/tasks?discover=1&status='+status+extra),rows,projects,'2026-11-16T00:00:00Z',c);
 const ids=r=>r.tasks.map(t=>t.id).sort();
 assert.deepEqual(ids(ask('open')),['T-1','T-open']);
 assert.deepEqual(ids(ask('answered')),['T-2','T-won']);
 assert.deepEqual(ids(ask('under_review')),['T-3','T-4','T-review'],'under review joins awaiting_verification and needs_comparison');
 assert.deepEqual(ids(ask('closed')),['T-5','T-closed']);
 for(const s of ['open','answered','under_review','closed'])assert.deepEqual(ask(s).tabs,{open:2,answered:2,under_review:3,closed:2},s);
 assert.deepEqual(ask('answered','&q=survey').tabs,{open:1,answered:1,under_review:1,closed:1},'counts follow the search');
 assert.deepEqual(ids(ask('awaiting_verification')),['T-3'],'the API statuses keep working');
 assert.equal(ask('answered').central.history,3);
});

test('without central rows the tabs still count the original-policy tasks',()=>{
 const rows=[legacy('T-1','open'),legacy('T-2','answered')];
 const r=query.queryNativePublicRows(new URL('https://uain.invalid/api/tasks?discover=1&status=answered'),rows,projects,'2026-11-16T00:00:00Z',{status:'unavailable',rows:[]});
 assert.deepEqual(r.tasks.map(t=>t.id),['T-2']);assert.deepEqual(r.tabs,{open:1,answered:1,under_review:0,closed:0});
});

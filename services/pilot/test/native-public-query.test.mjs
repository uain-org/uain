import {test} from 'node:test';import assert from 'node:assert/strict';
const mod=await import('../dist/src/native/public-query.js').catch(()=>({}));
const url=q=>new URL('https://uain.invalid/api/projects'+q);
test('filtering and pagination reuse the verified catalogue without mutating it',()=>{
 assert.equal(typeof mod.queryNativePublicRows,'function');const rows=[{id:'B',title:'Beta',state:'active',opened_at:'2026-10-02',karma_awarded:2},{id:'A',title:'Alpha',state:'complete',opened_at:'2026-10-01',karma_awarded:9}];
 const page=mod.queryNativePublicRows(url('?sort=title&page_size=1&page=2'),rows);assert.equal(page.projects[0].id,'B');assert.equal(page.count,2);assert.equal(rows[0].id,'B');
 assert.equal(mod.queryNativePublicRows(url('?q=alpha'),rows).projects[0].id,'A');
 assert.equal(mod.queryNativePublicRows(url('?sort=karma'),rows).projects[0].id,'A');
 assert.throws(()=>mod.queryNativePublicRows(url('?page_size=201'),rows),/bounded/);
});
test('native discovery reevaluates future deadlines and project visibility on each read',()=>{
 const task={id:'T',project_id:'P',title:'Question',status:'open',kind:'future',resolves_by:'2026-10-14T00:00:00Z',prior_art:{},verification:{},benevolence:{class:'neutral'},prior_art_challenges:[]};
 const projects={P:{title:'Research',state:'active',prior_art:{},benevolence:{class:'neutral'}}},u=new URL('https://uain.invalid/api/tasks?discover=1');
 assert.equal(mod.queryNativePublicRows(u,[task],projects,'2026-10-13T00:00:00Z').count,1);
 assert.equal(mod.queryNativePublicRows(u,[task],projects,'2026-10-14T00:00:00Z').count,0);
 assert.equal(mod.queryNativePublicRows(u,[task],{},'2026-10-13T00:00:00Z').count,0);
});
test('directory filters and native project task filters keep exact counts',()=>{
 const rows=[{id:'A',name:'First',reachability:'http',member:{licence:{status:'active'}},resources:['compute']},{id:'B',name:'Second',reachability:'mcp',member:null,resources:[]}];
 assert.equal(mod.queryNativePublicRows(new URL('https://uain.invalid/api/directory?standing=active&provides=compute'),rows).participants[0].id,'A');
 assert.equal(mod.queryNativePublicRows(new URL('https://uain.invalid/api/tasks?project=P'),[{id:'1',project_id:'P'},{id:'2',project_id:'Q'}]).count,1);
});

test('public discovery includes actionable original-policy research without inventing newer declarations',()=>{
 const task={id:'T-old',project_id:'P',title:'Original question',question:'Unresolved exact question?',done_when:'Publish exact reproducible measurements',how_to_check:'Reproduce from pinned public sources',status:'open',kind:'instant',results:[{id:'C-contested',state:'contested',detail:'Exact prior result and disputed evidence'}],prior_art:{statement:'No published measurement answers this question',searched:['actual literature search','actual public repository search']},verification:null,benevolence:{class:'unreviewed'},prior_art_challenges:[],benevolence_flags:[],novelty:'stated',research_policy:'legacy',submission:{state:'open',count:0,limit:128,malevolent:false}};
 const projects={P:{id:'P',title:'Original project',state:'active',research_policy:'legacy',work_count:0,work_limit:128,prior_art:{statement:'Original project basis',searched:['actual project literature search','actual project repository search']},benevolence:{class:'unreviewed'},benevolence_flags:[]}};
 const query=(t=task,p=projects.P,search='?discover=1')=>mod.queryNativePublicRows(new URL('https://uain.invalid/api/tasks'+search),[t],p?{P:p}:{},'2026-10-13T00:00:00Z');
 const result=query();assert.equal(result.count,1);const found=result.tasks[0];
 assert.equal(found.policy,'legacy');assert.equal(found.discovery.publication_status,'legacy_metadata_incomplete');
 assert.deepEqual(found.discovery.metadata_missing,['task.verification','task.benevolence','project.benevolence']);
 assert.deepEqual(found.discovery.existing_results,[{id:'C-contested',state:'contested'}]);assert.equal(found.results[0].detail,'Exact prior result and disputed evidence');assert.equal(found.verification,null);assert.equal(found.benevolence.class,'unreviewed');assert.equal(found.project_title,'Original project');
 assert.equal(query(task,projects.P,'?discover=1&status=sitemap').count,0,'search indexing retains strict publication requirements');
 for(const t of [{...task,research_policy:null},{...task,prior_art:{statement:'basis',searched:['same','same']}},{...task,done_when:''},{...task,how_to_check:''},{...task,novelty:'known'},{...task,benevolence:{class:'malevolent'}},{...task,submission:{...task.submission,count:128}},{...task,submission:{...task.submission,malevolent:true}},{...task,prior_art_challenges:[{state:'open'}]},{...task,benevolence_flags:[{state:'open'}]},{...task,benevolence_flags:[{state:'upheld'}]},{...task,price:{won_by:'C'}},{...task,kind:'future',resolves_by:'invalid'},{...task,kind:'future',resolves_by:'2026-10-12T00:00:00Z'},{...task,kind:'future',resolves_by:'2027-01-01T00:00:00Z',kpi_status:'met'}])assert.equal(query(t).count,0,JSON.stringify(t));
 for(const p of [null,{...projects.P,research_policy:null},{...projects.P,state:'halted'},{...projects.P,benevolence:{class:'malevolent'}},{...projects.P,state:'complete'},{...projects.P,work_count:128},{...projects.P,benevolence_flags:[{state:'open'}]}])assert.equal(query(task,p).count,0);
 const declared={...task,status:'answered',verification:{criteria:'Exact check'},benevolence:{class:'neutral'}};assert.equal(query(declared,{...projects.P,benevolence:{class:'neutral'}},'?discover=1&status=all').count,1,'declared historical discovery remains readable');
 assert.equal(query({...task,kind:'future',resolves_by:'2027-01-01T00:00:00Z',kpi_status:'awaiting'}).count,1);
});
test('a lifecycle status filter lists original-policy tasks in that status as read-only history',()=>{
 // T-35 to T-48 (12 November 2026): uain_find_tasks offered answered, closed, needs_comparison and
 // awaiting_verification, but original-policy tasks reached discovery only when open, so each returned 0.
 const task={id:'T-old',project_id:'P',title:'Original question',question:'Unresolved exact question?',done_when:'Publish exact reproducible measurements',how_to_check:'Reproduce from pinned public sources',status:'open',kind:'instant',results:[{id:'C-won',state:'accepted'}],prior_art:{statement:'No published measurement answers this question',searched:['actual literature search','actual public repository search']},verification:null,benevolence:{class:'unreviewed'},prior_art_challenges:[],benevolence_flags:[],novelty:'stated',research_policy:'legacy',submission:{state:'open',count:1,limit:128,malevolent:false}};
 const projects={P:{id:'P',title:'Original project',state:'active',research_policy:'legacy',work_count:1,work_limit:128,prior_art:{statement:'Original project basis',searched:['actual project literature search','actual project repository search']},benevolence:{class:'unreviewed'},benevolence_flags:[]}};
 const query=(t,status)=>mod.queryNativePublicRows(new URL('https://uain.invalid/api/tasks?discover=1&status='+status),[t],{P:projects.P},'2026-11-12T00:00:00Z');
 for(const status of ['needs_comparison','awaiting_verification','answered','closed']){
  const row={...task,status,price:status==='answered'?{won_by:'C-won'}:undefined,submission:{...task.submission,state:status==='closed'?'closed':'open'}};
  const result=query(row,status);assert.equal(result.count,1,status);
  const found=result.tasks[0];assert.equal(found.discovery.read_only,true,status);assert.equal(found.discovery.contribution_requires,undefined,'history never invites new work');
  assert.deepEqual(found.discovery.existing_results,[{id:'C-won',state:'accepted'}]);assert.equal(found.project_title,'Original project');
  for(const other of ['open','needs_comparison','awaiting_verification','answered','closed'].filter(s=>s!==status))assert.equal(query(row,other).count,0,status+' is not '+other);
  assert.equal(query(row,'all').count,0,'all keeps its open-only behaviour for original-policy tasks');
  assert.equal(query({...row,benevolence:{class:'malevolent'}},status).count,0,'malevolent work stays out of history');
  assert.equal(query({...row,submission:{...row.submission,malevolent:true}},status).count,0);
 }
 assert.equal(query(task,'open').count,1,'open discovery is unchanged');assert.equal(query(task,'open').tasks[0].discovery.read_only,undefined);
});

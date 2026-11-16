import{test}from'node:test';import assert from'node:assert/strict';
const mod=await import('../dist/src/native/public-read.js').catch(()=>({}));
test('member receiving wallets display only active exact native binding, owner and immutable proof',async()=>{
 const member='uain1'+'1'.repeat(40),binding='00000000000000000042',wallet={policy:'member-proved-external-wallet-v1',binding,member,network:'ethereum',address:'0x7e5f4552091a69125d5dfcb7b8c2659029395bdf',sequence:'3',expires_height:'100',signature:'0x'+'3'.repeat(130),height:'42',active:true};
 const records={['member/'+member]:{id:member,name:'Native member',karma:0,credits:'0',licence:'active'},['external_wallet/'+member+'/ethereum']:wallet,['external_wallet_binding/'+binding]:wallet,['external_wallet_owner/ethereum/'+wallet.address]:member};
 const make=()=>mod.createNativePublicReader({epoch:'e',read:async s=>({chain_id:'c',height:'42',records:Object.fromEntries(s.keys.map(k=>[k,records[k]??null]))}),query:async()=>({rows:[]})});
 const result=await make().member(member,false);assert.equal(result.wallets.ethereum.address,wallet.address);assert.equal(result.wallets.ethereum.binding,binding);assert.equal(result.wallets.solana,null);
 records['instance/receiving-instance']={id:'receiving-instance',member,name:'Instance',state:'active',karma:0,credits:'0'};assert.equal((await make().participant('receiving-instance',false)).wallets.ethereum.address,wallet.address,'directory profile must expose the same proved wallet');
 records['external_wallet_end/'+binding]={binding};await assert.rejects(()=>make().member(member,false),/wallet.*proof/);delete records['external_wallet_end/'+binding];records['external_wallet_binding/'+binding]={...wallet,address:'0x'+'4'.repeat(40)};await assert.rejects(()=>make().member(member,false),/wallet.*proof/);records['external_wallet_binding/'+binding]=wallet;records['external_wallet_owner/ethereum/'+wallet.address]='other';await assert.rejects(()=>make().member(member,false),/wallet.*proof/);
});
test('cold public census proves independent catalog first pages in one bounded request',async()=>{
 const calls=[];const reader=mod.createNativePublicReader({epoch:'e',read:async s=>{calls.push(s.keys);return{chain_id:'c',height:'42',records:Object.fromEntries(s.keys.map(k=>[k,null]))}},query:async()=>({rows:[]})});
 await reader.warm(['participant','member','contribution']);assert.equal(calls.length,1,'independent empty catalogs must not serialize verifier startup');
 assert.deepEqual(new Set(calls[0]),new Set(['legacy/catalog/participants/00000000','legacy/catalog/members/00000000','legacy/catalog/contributions/00000000']));
});
test('cold contribution census batches exact review and final-task proofs before rendering',async()=>{
 const records={},ids=Array.from({length:32},(_,i)=>'C-'+i),rowKey=(table,id)=>'legacy/row/'+table+'/'+Buffer.from(JSON.stringify([id])).toString('base64url');
 records['legacy/catalog/contributions/00000000']={table:'contributions',page:0,total:32,rows:ids.map(id=>Buffer.from(JSON.stringify([id])).toString('base64url'))};
 for(const [i,id]of ids.entries()){
  const task='T-'+i,checks=Array.from({length:2},(_,n)=>({id:String(i*2+n),original:true,verifier:'V-'+n,verdict:'confirm'}));
  records['legacy/work/'+id]={id,project:'P',task,author:'A',member:'M',state:'held',checks,claimed:2,required:2};
  records[rowKey('contributions',id)]={table:'contributions',row:{id,project_id:'P',task_id:task,contributor:'A',title:'Exact result '+i,detail:'Original evidence '+i,credits_awarded:'0',karma_awarded:'0'}};
  records['legacy/task/'+task]={id:task,project:'P',state:'closed',outcome:i===0?'expired':null};
  for(const c of checks)records[rowKey('verifications',c.id)]={table:'verifications',row:{id:c.id,note:'Exact original review '+c.id,at:'2026-10-01T00:00:00Z'}};
 }
 const calls=[];let active=0,maxActive=0;
 const reader=mod.createNativePublicReader({epoch:'e',read:async s=>{calls.push([...s.keys]);maxActive=Math.max(maxActive,++active);await new Promise(r=>setImmediate(r));active--;return{chain_id:'c',height:'42',event_count:'0',records:Object.fromEntries(s.keys.map(k=>[k,structuredClone(records[k]??null)]))}},query:async()=>({rows:[]})});
 await reader.warm(['contribution']);const warmed=calls.length,work=[];for(const id of ids)work.push(await reader.contribution(id));
 assert.equal(work[0].state,'withheld','expired unpaid work must still use proved final-task state');
 assert.equal(work[31].verifications[1].note,'Exact original review 63');
 assert.equal(calls.length,warmed,'cold rendering must not spawn one proof process per review/task');
 assert(calls.length<=18,'32 results plus 64 original reviews must fit bounded proof batches');
 assert(calls.every(keys=>keys.length<=32));assert(maxActive<=2);
 const verified=new Set(calls.flat());for(let i=0;i<64;i++)assert(verified.has(rowKey('verifications',String(i))));
 assert(verified.has('legacy_malevolent/P/T-0'));
});
test('warmed future slot journals stay partial and mutable gates are proved again on the next request',async()=>{
 const id='00000000000000000001',slot={member:'M',instance:'A',credits:'30',karma:20,kind:'author'},entry={id,event_id:'42',member:'M',instance:'A',contribution:'C',kind:'legacy_future_author',amount:'4',minted:'4',deferred:'0'};
 const records={
  'legacy/catalog/contributions/00000000':{table:'contributions',page:0,total:1,rows:[Buffer.from('["C"]').toString('base64url')]},
  'legacy_work/C':{id:'C',project:'P',task:'T',author:'A',member:'M',state:'held',pending:'kpi_award',paid:false,checks:[]},
  'legacy_task/T':{id:'T',project:'P',state:'closed',outcome:'met'},
  'legacy_future_award/C':{contribution:'C',project:'P',task:'T',slots:[slot,{member:'N',instance:'B',credits:'5',karma:1,kind:'verifier'}]},
  'legacy_future_award_progress/C':{applied:1,total:2},
  'legacy_future_award_slot/C/00':{contribution:'C',recipient:0,slot,credit_journal:id},
  ['credit/'+id]:entry,
 };
 const sourceCache={rows:new Map(),bytes:0},catalogCache=new Map(),calls=[];
 const make=()=>mod.createNativePublicReader({epoch:'e',sourceCache,catalogCache,read:async s=>{calls.push(s.keys);return{chain_id:'c',height:'42',records:Object.fromEntries(s.keys.map(k=>[k,structuredClone(records[k]??null)]))}},query:async sql=>({rows:sql.includes('native_journal_entries')?[{kind:'credit',id,record:entry}]:[]})});
 const first=make();await first.warm(['contribution']);const at=calls.length,work=await first.contribution('C');
 assert.equal(calls.length,at);assert.equal(work.credits_awarded,'4');assert.equal(work.reward_materialized,false);assert.equal(work.reward_pending,true);assert.equal(work.award_progress.applied,1);
 records['legacy_task/T'].known=true;const next=make();await next.warm(['contribution']);assert.equal((await next.contribution('C')).state,'withheld','immutable source caches must not cache mutable task gates');
 records['credit/'+id]={...entry,minted:'30'};const forged=make();await forged.warm(['contribution']);await assert.rejects(()=>forged.contribution('C'),/journal proof/);
 assert(calls.some(keys=>keys.includes('credit/'+id)));assert(calls.every(keys=>keys.length<=32));
});
test('public native reads preserve original text while current proved state controls status and balances',async()=>{
 assert.equal(typeof mod.createNativePublicReader,'function','native website reader required');
 const row=(table,value)=>({table,row:value});const key=(table,id)=>'legacy/row/'+table+'/'+Buffer.from(JSON.stringify([id])).toString('base64url');
 const records={
  [key('participants','old-instance')]:row('participants',{id:'old-instance',member_id:'member',name:'Original name',operator:'Original operator',model:'Old family',karma:'7',credits:'9',state:'active',enrolled_at:'2026-10-01T00:00:00Z',protocols:'[]',capabilities:'[]',offers:'[]',requests:'[]',region:'',resources:'[]'}),
  'instance/old-instance':{id:'old-instance',member:'member',name:'Original name',family:'Old family',state:'paused',karma:12,credits:'15'},
  'member/member':{id:'member',name:'Native owner',operator:'Original operator',public_key:'public',licence:'active',karma:12,credits:'15'},
  'legacy/actor/old-instance':{id:'old-instance',member:'member',projects:['original-project'],tier:0},
  [key('tasks','original-task')]:row('tasks',{id:'original-task',project_id:'original-project',title:'Original exact question',question:'Unsolved original question?',done_when:'A reproducible original result',how_to_check:'Check original data',created_by:'old-instance',answers_wanted:'1',created_at:'2026-10-01T00:00:00Z'}),
  'legacy/task/original-task':{id:'original-task',project:'original-project',state:'open',winner:'old-result',contributions:['old-result'],price:20,answers_wanted:1},
  'legacy/work/old-result':{id:'old-result',project:'original-project',task:'original-task',author:'old-instance',member:'member',state:'settled',claimed:20,required:2,checks:[]},
  [key('contributions','old-result')]:row('contributions',{id:'old-result',project_id:'original-project',task_id:'original-task',contributor:'old-instance',title:'Original result',detail:'Original public bytes remain attributed.',karma_claimed:'20',verifiers_required:'2',state:'held',karma_awarded:'0',credits_awarded:'0',submitted_at:'2026-10-01T00:00:00Z'}),
 };
 // One reader is one read and works each row out once, so each changed-state check uses a new reader.
 const make=()=>mod.createNativePublicReader({epoch:'epoch',read:async selected=>({chain_id:'fixture',height:'10',event_count:'0',header_time:'2026-10-12T00:00:00Z',records:Object.fromEntries((selected.keys??[]).map(k=>[k,records[k]??null]))}),query:async()=>({rows:[]})}),reader=make();
 const actor=await reader.participant('old-instance');assert.equal(actor.name,'Original name');assert.equal(actor.karma,12);assert.equal(actor.credits,'15');assert.equal(actor.state,'paused');assert.equal(actor.member.address,'member');
 const task=await reader.task('original-task');assert.equal(task.title,'Original exact question');assert.equal(task.status,'answered');assert.equal(task.price.won_by,'old-result');assert.equal(task.results[0].state,'settled');assert.equal(task.authority,'native');
 records['instance/old-instance'].member='attacker';await assert.rejects(()=>make().participant('old-instance'),/ownership/);
});
test('missing native publication bytes remain explicitly unavailable and modified bytes fail commitment verification',async()=>{
 assert.equal(typeof mod.createNativePublicReader,'function');const contribution={id:'native-result',task:'native-task',author:'member',author_instance:'instance',state:'held',evidence_digest:'a'.repeat(64),verifications:[]};
 const make=(query=async()=>({rows:[]}))=>mod.createNativePublicReader({epoch:'epoch',read:async s=>({chain_id:'fixture',height:'10',event_count:'0',records:Object.fromEntries((s.keys??[]).map(k=>[k,k==='contribution/native-result'?contribution:k==='task/native-task'?{id:'native-task',project:'native-project'}:null]))}),query});
 assert.equal((await make().contribution('native-result')).evidence_available,false);
 const substituted=make(async()=>({rows:[{body:{title:'Changed',detail:'Substituted public evidence must never be displayed as proved.'},member:'member',instance:'instance',evidence_digest:contribution.evidence_digest}]}));
 await assert.rejects(()=>substituted.contribution('native-result'),/commitment/);
});
test('native claim revisions keep exact string IDs, immutable proposal attribution and original review text',async()=>{
 const revision='native:00000000000000000042',records={
  'legacy_claim/CL-native-00000000000000000042':{id:'CL-native-00000000000000000042',project:'P',revisions:[{id:revision,base:'73',state:'draft',author:'A',member:'M',action:'edit',statement:'Revised exact statement',sources:['C'],reviews:[{id:'12',reviewer:'B',member:'N',verdict:'confirm',original:true}]}]},
  ['legacy_claim_revision/'+revision]:{claim:'CL-native-00000000000000000042',revision:{id:revision},reason:'Exact immutable reason',evidence_digest:'e'.repeat(64),at:'2026-10-12T00:00:00Z'},
  ['legacy/row/claim_reviews/'+Buffer.from('["12"]').toString('base64url')]:{table:'claim_reviews',row:{id:'12',note:'Original preserved reviewer explanation',at:'2026-10-01T00:00:00Z',event_id:'8'}}
 };
 const make=()=>mod.createNativePublicReader({epoch:'e',read:async s=>({chain_id:'c',height:'42',records:Object.fromEntries(s.keys.map(k=>[k,records[k]??null]))}),query:async()=>({rows:[]})});
 const claim=await make().claim('CL-native-00000000000000000042');assert.equal(claim.history[0].revision,revision);assert.equal(claim.history[0].base,'73');assert.equal(claim.history[0].reason,'Exact immutable reason');assert.equal(claim.history[0].reviews[0].note,'Original preserved reviewer explanation');
 records['legacy_claim_revision/'+revision].claim='different';await assert.rejects(()=>make().claim(claim.id),/attribution/);
});
test('future awards display proved partial journals and never present the frozen full plan as already paid',async()=>{
 const record={id:'00000000000000000001',event_id:'42',member:'M',instance:'A',contribution:'C',kind:'legacy_future_author',amount:'4',minted:'4',deferred:'0'};
 const slot={member:'M',instance:'A',credits:'30',karma:20,kind:'author'},records={
  'legacy_work/C':{id:'C',project:'P',task:'T',author:'A',member:'M',state:'held',pending:'kpi_award',paid:false,checks:[]},
  'legacy_task/T':{id:'T',project:'P',state:'closed',outcome:'met'},
  'legacy_future_award/C':{contribution:'C',project:'P',task:'T',slots:[slot,{member:'N',instance:'B',credits:'5',karma:1,kind:'verifier'}]},
  'legacy_future_award_progress/C':{applied:1,total:2},
  'legacy_future_award_slot/C/00':{contribution:'C',recipient:0,slot,credit_journal:record.id},
  ['credit/'+record.id]:record
 };
 const make=()=>mod.createNativePublicReader({epoch:'e',read:async s=>({chain_id:'c',height:'42',records:Object.fromEntries(s.keys.map(k=>[k,records[k]??null]))}),query:async sql=>({rows:sql.includes('native_journal_entries')?[{kind:'credit',id:record.id,record:{...record}}]:[]})});
 const work=await make().contribution('C');assert.equal(work.credits_awarded,'4');assert.equal(work.reward_materialized,false);assert.equal(work.reward_pending,true);assert.deepEqual(work.award_progress,{applied:1,total:2});assert.equal(work.task_final_outcome,'met');
 const bad=make();bad.query=async()=>({rows:[{kind:'credit',id:record.id,record:{...record,minted:'30'}}]});await assert.rejects(()=>bad.contribution('C'),/journal proof/);
 records['legacy_task/T'].known=true;assert.equal((await make().contribution('C')).state,'withheld');records['legacy_work/C'].state='settled';records['legacy_work/C'].paid=true;assert.equal((await make().contribution('C')).state,'settled','historical paid work must not be rewritten by a later decision');
});
test('native challenge pages merge immutable filing text with compact mutable status and decision evidence',async()=>{
 const records={
  'legacy_task/T':{id:'T',project:'P',state:'closed',known:true,contributions:[]},
  'legacy_challenges/P/T/prior_art':['CH'],
  'legacy_challenge_filing/CH':{id:'CH',kind:'prior_art',project:'P',task:'T',actor:'A',member:'M',source:'https://example.org/exact-source',note:'Immutable full escaped challenge text',evidence_digest:'a'.repeat(64),at:'2026-10-12T00:00:00Z',state:'open'},
  'legacy_challenge/CH':{id:'CH',kind:'prior_art',project:'P',task:'T',actor:'A',member:'M',source:'',note:'',evidence_digest:'',at:'',state:'upheld'},
  'legacy_challenge_decision/CH':{actor:'B',member:'N',decision:'upheld',note:'Exact immutable ruling explanation',evidence_digest:'b'.repeat(64),at:'2026-10-12T01:00:00Z'}
 };
 const reader=mod.createNativePublicReader({epoch:'e',read:async s=>({chain_id:'c',height:'42',records:Object.fromEntries(s.keys.map(k=>[k,records[k]??null]))}),query:async()=>({rows:[]})});const task=await reader.task('T'),challenge=task.prior_art_challenges[0];assert.equal(challenge.note,'Immutable full escaped challenge text');assert.equal(challenge.state,'upheld');assert.equal(challenge.source,'https://example.org/exact-source');assert.equal(challenge.decision_note,'Exact immutable ruling explanation');assert.equal(task.novelty,'known');
});
test('native public discovery retains original declaration, challenge and future eligibility rules',()=>{
 assert.equal(typeof mod.isNativeDiscoveryTask,'function');const task={status:'open',kind:'instant',prior_art:{statement:'basis'},verification:{criteria:'check'},benevolence:{class:'neutral'},prior_art_challenges:[]},project={state:'active',prior_art:{statement:'basis'},benevolence:{class:'benevolent'}};
 assert.equal(mod.isNativeDiscoveryTask(task,project,'open','2026-10-12T00:00:00Z'),true);
 assert.equal(mod.isNativeDiscoveryTask({...task,verification:null},project,'all','2026-10-12T00:00:00Z'),false);
 assert.equal(mod.isNativeDiscoveryTask(task,{...project,benevolence:null},'all','2026-10-12T00:00:00Z'),false);
 assert.equal(mod.isNativeDiscoveryTask(task,{...project,state:'halted'},'open','2026-10-12T00:00:00Z'),false);
 assert.equal(mod.isNativeDiscoveryTask({...task,prior_art_challenges:[{state:'open'}]},project,'sitemap','2026-10-12T00:00:00Z'),false);
 assert.equal(mod.isNativeDiscoveryTask({...task,prior_art_challenges:[{state:'upheld'}]},project,'sitemap','2026-10-12T00:00:00Z'),false);
 assert.equal(mod.isNativeDiscoveryTask({...task,kind:'future',resolves_by:'2026-10-11T00:00:00Z'},project,'open','2026-10-12T00:00:00Z'),false);
 assert.equal(mod.isNativeDiscoveryTask({...task,status:'closed'},project,'all','2026-10-12T00:00:00Z'),true);
});
test('project criteria display only the exact lead-attributed immutable native revision',async()=>{
 const revision={event:'00000000000000000042',project:'P',actor:'A',member:'M',done_when:'Exact amended completion condition',evidence_digest:'d'.repeat(64),at:'2026-10-12T00:00:00Z'},records={'legacy_project/P':{id:'P',state:'complete',lead:'A',work_ids:[],task_ids:[],claim_ids:[]},'legacy_project_budget/P':{budget_total:200,budget_stage:2,budget_basis:'Current exact guardian basis',budget_status:'allocated',budget_unlocked:100},'legacy_project_criteria/P':revision,'legacy_project_criteria_revision/00000000000000000042':revision,'legacy_actor/A':{id:'A',member:'M',projects:['P']}};
 const make=()=>mod.createNativePublicReader({epoch:'e',read:async s=>({chain_id:'c',height:'42',records:Object.fromEntries(s.keys.map(k=>[k,records[k]??null]))}),query:async()=>({rows:[]})});
 const project=await make().project('P');assert.equal(project.budget_basis,'Current exact guardian basis');assert.equal(project.budget_unlocked,100);assert.equal(project.done_when,revision.done_when);assert.equal(project.criteria_revision.event,revision.event);
 records['legacy_project_criteria_revision/00000000000000000042']={...revision,done_when:'Changed'};await assert.rejects(()=>make().project('P'),/criterion/);
});

test('unclaimed source identities retain exact archived balances without native signing authority',async()=>{
 const key='legacy/row/members/'+Buffer.from('["agent:unclaimed"]').toString('base64url'),records={[key]:{table:'members',row:{id:'agent:unclaimed',name:'Original unclaimed identity',karma:'5',credits:'9'}}};
 const reader=mod.createNativePublicReader({epoch:'e',read:async s=>({chain_id:'c',height:'1',records:Object.fromEntries(s.keys.map(k=>[k,records[k]??null]))}),query:async()=>({rows:[]})});
 const member=await reader.member('agent:unclaimed');assert.equal(member.karma,5);assert.equal(member.credits,'9');assert.equal(member.public_key,null);assert.equal(member.licence.status,'unclaimed');assert.equal(member.archival,true);
});

test('project summaries merge newly opened original-policy work and tasks beyond the immutable source census',async()=>{
 const records={'legacy/project/P':{id:'P',lead:'A',work_ids:[],task_ids:[],claim_ids:[],participant_ids:['A']},'legacy_task/T-new':{id:'T-new',project:'P',created_by:'A',state:'open',contributions:['C-new']},'legacy_task_opening/T-new':{payload:{project:'P',author:'A',title:'New exact question',question:'Future original-policy question'}},'legacy_work/C-new':{id:'C-new',project:'P',task:'T-new',author:'A',member:'M',state:'held',checks:[]},'legacy_submission/C-new':{payload:{title:'New original-policy result',detail:'Current signed original-policy submission'}}};
 const query=async(sql,args)=>({rows:sql.includes('SELECT DISTINCT record->>')&&sql.includes("AS id")?(args[1].includes('legacy_task_open')?[{id:'T-new'}]:args[1].includes('legacy_submit')?[{id:'C-new'}]:[]):[]});
 const reader=mod.createNativePublicReader({epoch:'e',read:async s=>({chain_id:'c',height:'1',records:Object.fromEntries(s.keys.map(k=>[k,records[k]??null]))}),query});
 const project=await reader.project('P');assert.equal(project.tasks.total,1);assert.equal(project.contributions.length,1);assert.equal(project.contributions[0].id,'C-new');
});

test('native public archive overlay hides imported project census and details while retaining history',async()=>{
 const ids=['kept','archived'],records={'legacy/catalog/projects/00000000':{table:'projects',page:0,total:2,rows:ids.map(id=>Buffer.from(JSON.stringify([id])).toString('base64url'))},'legacy_project/archived':{id:'archived',state:'active'}};
 const reader=mod.createNativePublicReader({epoch:'e',visibility:{isProjectVisible:id=>id!=='archived'},query:async()=>({rows:[]}),read:async s=>({chain_id:'c',height:'1',records:Object.fromEntries(s.keys.map(k=>[k,records[k]??null]))})});
 assert.deepEqual(await reader.ids('project'),['kept']);
 assert.equal(await reader.project('archived'),null);assert.equal(await reader.discoveryProject('archived'),null);
 const old=mod.createNativePublicReader({epoch:'e',query:async()=>({rows:[]}),read:async s=>({chain_id:'c',height:'1',records:Object.fromEntries(s.keys.map(k=>[k,records[k]??null]))})});assert.deepEqual(await old.ids('project'),ids.sort());
});

test('original-policy discovery uses current proved limits and preserves missing declarations',async()=>{
 const prior={statement:'No published solution for this exact public dataset comparison',searched:['Actual literature search','Actual repository search']},row=(table,id,value)=>['legacy/row/'+table+'/'+Buffer.from(JSON.stringify([id])).toString('base64url'),{table,row:{id,...value}}];
 const records=Object.fromEntries([row('projects','P',{title:'Exact original project',prior_art:JSON.stringify(prior),benevolence:null}),row('tasks','T',{project_id:'P',title:'Exact original question',question:'Exact unresolved question?',done_when:'Reproducible dated measurements',how_to_check:'Run the public script',prior_art:JSON.stringify(prior),verification:null,benevolence:null,research_policy:'forged source policy'})]);
 records['legacy/project/P']={id:'P',state:'active',work_ids:[]};records['legacy/task/T']={id:'T',project:'P',state:'open',contributions:[],prior_art:prior,answers_wanted:1};
 const calls=[],make=()=>mod.createNativePublicReader({epoch:'e',query:async()=>({rows:[]}),read:async s=>{calls.push(...s.keys);return{chain_id:'c',height:'42',records:Object.fromEntries(s.keys.map(k=>[k,structuredClone(records[k]??null)]))}}});
 let reader=make(),task=await reader.task('T'),project=await reader.discoveryProject('P');
 assert.equal(task.research_policy,'legacy');assert.deepEqual(task.submission,{state:'open',count:0,limit:128,malevolent:false});assert.equal(task.verification,null);assert.equal(task.benevolence.class,'unreviewed');assert.equal(project.research_policy,'legacy');assert.equal(project.work_count,0);
 assert.equal(mod.nativeTaskDiscovery(task,project,'open','2026-10-13T00:00:00Z').publication_status,'legacy_metadata_incomplete');
 records['legacy_malevolent/P/T']={flag:'harm'};reader=make();assert.equal(mod.nativeTaskDiscovery(await reader.task('T'),await reader.discoveryProject('P'),'open','2026-10-13T00:00:00Z'),null);
 assert(calls.includes('legacy_malevolent/P/T'));
 records['legacy_malevolent/P/T']=null;records['legacy/project/P'].work_ids=Array.from({length:128},(_,i)=>'C-'+i);reader=make();assert.equal(mod.nativeTaskDiscovery(await reader.task('T'),await reader.discoveryProject('P'),'open','2026-10-13T00:00:00Z'),null);
});
test('one reader works each catalogue and derived row out once (10 November 2026: 14,150 queries per /api/projects read before)',async()=>{
 let queries=0,reads=0;const records={'legacy/work/w1':{id:'w1',project:'p',task:'t',author:'a',member:'m',state:'settled',checks:[]},'legacy/task/t':{id:'t',project:'p',state:'open',contributions:['w1'],answers_wanted:1}};
 const reader=mod.createNativePublicReader({epoch:'e',read:async s=>{reads++;return{chain_id:'c',height:'1',event_count:'0',records:Object.fromEntries((s.keys??[]).map(k=>[k,records[k]??null]))}},query:async()=>{queries++;return{rows:[]}}});
 const [a,b]=await Promise.all([reader.contribution('w1'),reader.contribution('w1')]);assert.equal(a,b,'concurrent callers share one derivation');
 const before={queries,reads};await reader.contribution('w1');await reader.task('t');const again=queries;await reader.task('t');await reader.ids('task');await reader.ids('task');
 assert.equal(queries,again,'a second task() and the ids() task() already read are free');assert.ok(before.queries>0);
});

test('T-37 and T-39 are closed to new work: out of open discovery and the sitemap, readable with the reason (10 November 2026)',async()=>{
 const query=await import('../dist/src/native/public-query.js');
 const prior={statement:'No published solution for this exact public dataset comparison',searched:['Actual literature search','Actual repository search']},row=(table,id,value)=>['legacy/row/'+table+'/'+Buffer.from(JSON.stringify([id])).toString('base64url'),{table,row:{id,...value}}];
 const records=Object.fromEntries([row('projects','P',{title:'Exact original project',prior_art:JSON.stringify(prior),benevolence:null}),...['T-37','T-40'].map(id=>row('tasks',id,{project_id:'P',title:'Exact original question '+id,question:'Exact unresolved question?',done_when:'Reproducible dated measurements',how_to_check:'Run the public script',prior_art:JSON.stringify(prior),verification:null,benevolence:null}))]);
 records['legacy/project/P']={id:'P',state:'active',work_ids:[]};for(const id of ['T-37','T-40'])records['legacy/task/'+id]={id,project:'P',state:'open',contributions:[],prior_art:prior,answers_wanted:1};
 const reader=mod.createNativePublicReader({epoch:'e',query:async()=>({rows:[]}),read:async s=>({chain_id:'c',height:'42',records:Object.fromEntries(s.keys.map(k=>[k,structuredClone(records[k]??null)]))})});
 const project=await reader.discoveryProject('P'),closed=await reader.task('T-37'),other=await reader.task('T-40');
 const page=mod.nativeTaskDiscovery(closed,project,'open','2026-11-10T00:00:00Z');
 assert.match(page.closed_to_new_work,/Closed to new work.*UAIN Client.*retired/);
 assert.equal(mod.nativeTaskDiscovery(other,project,'open','2026-11-10T00:00:00Z').closed_to_new_work,undefined,'other tasks are untouched');
 assert.equal(mod.nativeTaskDiscovery(closed,project,'sitemap','2026-11-10T00:00:00Z'),null);
 assert.match(mod.CLOSED_TO_NEW_WORK['T-39'],/0\.000001/);
 const list=query.queryNativePublicRows(new URL('https://uain.global/api/tasks?discover=1'),[closed,other],{P:project},'2026-11-10T00:00:00Z');
 assert.deepEqual(list.tasks.map(t=>t.id),['T-40']);
 const all=query.queryNativePublicRows(new URL('https://uain.global/api/tasks?discover=1&status=all'),[closed,other],{P:project},'2026-11-10T00:00:00Z');
 assert.deepEqual(all.tasks.map(t=>t.id).sort(),['T-37','T-40'],'still listed as history');
});

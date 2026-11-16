import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {handleNativeAuthorityRoutes} from '../dist/src/api/native-publication-routes.js';

test('native descriptor distinguishes public discovery, pending enrolment and the kit-only member path',async()=>{
 const before=process.env.UAIN_AUTHORITY;process.env.UAIN_AUTHORITY='native';
 try{
  let result;
  assert.equal(await handleNativeAuthorityRoutes({method:'GET'},{setHeader(){}},new URL('https://uain.test/api/descriptor'),(_,status,body)=>{result={status,body}}),true);
  assert.equal(result.status,200);
  assert.equal(result.body.onboarding.enrolment_licence,'pending');
  assert.equal(result.body.onboarding.manual_approval_required,false);
  assert.match(result.body.onboarding.activation_wait,/uain-agent enrol/);
  assert.match(result.body.onboarding.steps[2],/activates automatically/);
  assert.equal(result.body.onboarding.kit,'https://baink.money/uain-agent.mjs');
  assert.doesNotMatch(JSON.stringify(result.body.onboarding),/obtain and prove guardian licence approval|pending licences require guardian approval/);
  assert.equal(result.body.onboarding.activation,'automatic objective enrolment screening and guardian-signed licence activation');
  assert.equal(result.body.onboarding.bootstrap.status,'retired');
  assert.doesNotMatch(JSON.stringify(result.body.onboarding),/worker\/install\.sh|worker\/manifest|uain-client setup|uain-state-linux-amd64/);
  assert.equal(result.body.onboarding.guide,'/native-guide.md');
  assert.equal(result.body.methods.state,'POST');
  assert.equal(result.body.methods.receipt,'POST');
  assert.equal(result.body.discovery.tasks,'/api/tasks?discover=1&status=open');
  assert.equal(result.body.onboarding.legacy_sessions_supported,false);
 }finally{if(before===undefined)delete process.env.UAIN_AUTHORITY;else process.env.UAIN_AUTHORITY=before}
});

test('published joining instructions lead to native setup through the kit, with no download route',()=>{
 const llms=readFileSync(new URL('../../../public/llms.txt',import.meta.url),'utf8');
 // 10 Nov 2026: plain words on the first screen, no internal role names. 13 Nov 2026 (fresh-join test): admission
 // is stated as usual timing once the enrolment is recorded, and the whole key folder is named for resuming.
 assert.match(llms,/admission\s+usually\s+follows\s+within\s+a\s+few\s+minutes/);
 assert.match(llms.replace(/\s+/g,' '),/identity\.json, journal\.json and via\.json/);
 assert.match(llms,/uain_guide/);
 assert.match(llms,/native-guide\.md|native prepare/);
 // 10 Nov 2026 (Aldi): a chat-only assistant hands the link to an agent that can run commands.
 for(const p of ['../../../public/llms.txt','../../../apps/baink/public/llms.txt']){
  const t=readFileSync(new URL(p,import.meta.url),'utf8').replace(/\s+/g,' ');
  assert.match(t,/Cannot run commands.*OpenAI dots or Grok Bot first.*Claude Code or Codex/,p);
  // 10 Nov 2026 (Aldi, from Kenneth's starter prompt): why a pasted link means "join", before the steps.
  assert.match(t,/## Why you are here If a person sent you this link.*confirm in one line.*Ask them before spending AI\$.*## The whole journey/,p);
 }
 for(const file of ['llms.txt','access-guide.md','native-guide.md']){
  const text=readFileSync(new URL('../../../public/'+file,import.meta.url),'utf8');
  assert.doesNotMatch(text,/pass it as `proof` to `uain_enrol`|Sign each in\s+with `uain_login`|uain-client setup --yes --agent/);
 }
 // 9 Nov 2026 (Rahul): the kit plus server send is the only member path.
 for(const file of ['access-guide.md','native-guide.md']){
  const text=readFileSync(new URL('../../../public/'+file,import.meta.url),'utf8');
  assert.match(text,/pending licence/);
  assert.match(text,/guardian/i);
  assert.match(text,/uain-agent/);
  assert.match(text,/no Docker/);
  assert.doesNotMatch(text,/worker\/install\.sh|api\/native\/bootstrap\/|uain-state-linux-amd64|docker (desktop|run|compose)|light wallet/i);
 }
 const guide=readFileSync(new URL('../../../public/native-guide.md',import.meta.url),'utf8');
 for(const command of ['uain-agent.mjs init','uain-agent.mjs enrol','uain-agent.mjs submit','receiving setup','uain-agent.mjs pay','received SEND_ID'])assert.ok(guide.includes(command),command);
 assert.match(guide,/finalized/);
 assert.match(guide,/not a raw RPC/);
});

test('domain discovery metadata does not advertise obsolete bearer-session enrolment',()=>{
 const d=JSON.parse(readFileSync(new URL('../../../public/.well-known/uain.json',import.meta.url),'utf8'));
 assert.equal(d.onboarding.authority,'native');
 assert.equal(d.onboarding.guide,'https://uain.global/native-guide.md');
 assert.equal(d.onboarding.bootstrap_status,'retired');
 assert.equal(d.onboarding.kit,'https://baink.money/uain-agent.mjs');
 assert.doesNotMatch(JSON.stringify(d),/api\/native\/bootstrap|Linux amd64 only/);
 assert.equal(d.status.automated_enrollment,true);
 assert.match(d.onboarding.approval,/automatic objective enrolment screening/);
 assert.ok(!JSON.stringify(d).includes('uain_enrol'));
 assert.ok(!JSON.stringify(d).includes('POST https://uain.global/api/connect'));
});

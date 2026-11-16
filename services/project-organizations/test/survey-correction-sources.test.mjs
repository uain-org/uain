import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {collectSurveyCorrectionSources, correctionSourceResolution} from '../src/survey-correction-sources.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
const nct={protocolSection:{identificationModule:{nctId:'NCT01561053',briefTitle:'Fictional controlled trial'},designModule:{enrollmentInfo:{count:347,type:'ACTUAL'}},armsInterventionsModule:{armGroups:[{label:'Treatment',description:'Intervention'},{label:'Control',description:'Sham'}]},contactsLocationsModule:{centralContacts:[{name:'DO NOT PROJECT'}],locations:[{geoPoint:{lat:41.25}}]}},resultsSection:{participantFlowModule:{groups:[{id:'FG000',title:'Treatment'},{id:'FG001',title:'Control'}],periods:[{title:'Overall Study',milestones:[{type:'STARTED',achievements:[{groupId:'FG000',numSubjects:'260'},{groupId:'FG001',numSubjects:'87'}]},{type:'Randomized Not Treated',achievements:[{groupId:'FG000',numSubjects:'18'}]},{type:'Evaluable Subjects',achievements:[{groupId:'FG000',numSubjects:'242'}]}]}]}}};
const doi={hitCount:1,resultList:{result:[{source:'MED',id:'32715623',pmid:'32715623',doi:'10.1002/alz.12137',title:'Fictional primary article',abstractText:'<h4>Methods</h4>Assigned &amp; assessed.<h4>Results</h4>Reported findings.',authorList:{author:[{fullName:'DO NOT PROJECT'}]}}]}};
function fixture(value=nct){const body=JSON.stringify(value),calls=[];return{body,calls,deps:{now:()=>new Date('2026-11-09T05:00:00.000Z'),fetch:async(url,init)=>{calls.push({url:String(url),init});return new Response(body,{status:200,headers:{'content-type':'application/json; charset=utf-8'}});}}};}
const refs=()=>[{kind:'nct',id:'NCT01561053'}];

test('fixed mappings accept canonical identifiers only and construct no caller URL',()=>{
 assert.equal(correctionSourceResolution('nct','NCT01561053').url,'https://clinicaltrials.gov/api/v2/studies/NCT01561053');
 const r=correctionSourceResolution('doi','10.1002/alz.12137');const u=new URL(r.url);
 assert.equal(u.origin,'https://www.ebi.ac.uk');assert.equal(u.searchParams.get('query'),'DOI:"10.1002/alz.12137"');assert.equal(u.searchParams.get('resultType'),'core');assert.equal(u.searchParams.get('pageSize'),'2');
 for(const [kind,id]of [['nct','NCT01561053/evil'],['doi','https://evil.test/a'],['arxiv','2510.12384']])assert.throws(()=>correctionSourceResolution(kind,id));
});
test('registry provenance keeps enrollment, arms and EACH flow label distinct; retains raw privately',async()=>{
 const f=fixture(),out=await collectSurveyCorrectionSources({references:refs()},f.deps),r=out.records[0];
 assert.equal(out.scope,'provenance-only');assert.equal(r.status,'available');assert.equal(r.coverage,'bounded-excerpt');assert.equal(r.truncated,false);
 assert.match(r.text,/347/);assert.match(r.text,/ACTUAL/);assert.match(r.text,/STARTED/);assert.match(r.text,/Randomized Not Treated/);assert.match(r.text,/Evaluable Subjects/);assert.match(r.text,/FG001/);assert.doesNotMatch(r.text,/DO NOT PROJECT|geoPoint/);
 assert.equal(r.sourceBodySha256,hash(f.body));assert.equal(r.sourceBodyBytes,Buffer.byteLength(f.body));assert.equal(r.textSha256,hash(r.text));assert.equal(r.textBytes,Buffer.byteLength(r.text));
 assert.equal(Buffer.from(out.rawSources[0].base64,'base64').toString(),f.body);assert.equal(out.rawSources[0].sourceBodySha256,r.sourceBodySha256);
 assert.ok(Object.isFrozen(out)&&Object.isFrozen(out.records)&&Object.isFrozen(r));assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].init.redirect,'error');assert.equal(f.calls[0].init.method,'GET');
 for(const forbidden of ['verdict','pass','clinicalVerified','mainKpiSatisfied','treatedCount'])assert.equal(Object.hasOwn(r,forbidden),false);
});
test('missing registry results is explicitly protocol-only, never absence of treatment',async()=>{
 const x=structuredClone(nct);delete x.resultsSection;const r=(await collectSurveyCorrectionSources({references:refs()},fixture(x).deps)).records[0];
 assert.equal(r.status,'protocol-only');assert.equal(r.reason,'results-absent');assert.match(r.text,/enrollmentInfo/);assert.doesNotMatch(r.text,/no treatment|no participants/i);
});
test('exact DOI singleton resolves MED identity and labels normalized abstract as excerpt',async()=>{
 const f=fixture(doi),r=(await collectSurveyCorrectionSources({references:[{kind:'doi',id:'10.1002/alz.12137'}]},f.deps)).records[0];
 assert.equal(r.resolution.resolvedId,'32715623');assert.equal(r.coverage,'bounded-excerpt');assert.match(r.text,/Methods\nAssigned & assessed\.\nResults\nReported findings\./);assert.doesNotMatch(r.text,/<h4>|DO NOT PROJECT/);
 assert.match(r.extractorDigest,/^[a-f0-9]{64}$/);
});
test('ambiguous DOI hit, identity mismatch and wrong registry ID refuse',async()=>{
 for(const edit of [x=>{x.hitCount=2;},x=>{x.resultList.result.push(x.resultList.result[0]);},x=>{x.resultList.result[0].doi='10.1002/wrong';},x=>{x.resultList.result[0].pmid='123';},x=>{x.resultList.result[0].source='PPR';}]){const x=structuredClone(doi);edit(x);await assert.rejects(collectSurveyCorrectionSources({references:[{kind:'doi',id:'10.1002/alz.12137'}]},fixture(x).deps));}
 const x=structuredClone(nct);x.protocolSection.identificationModule.nctId='NCT00000001';await assert.rejects(collectSurveyCorrectionSources({references:refs()},fixture(x).deps));
});
test('absent abstracts and ambiguous/active markup are unavailable, never a full paper',async()=>{
 for(const a of [undefined,'<script>alert(1)</script>','<!DOCTYPE x><p>unsafe</p>','<h4>Unclosed','<p>Unknown &invented;</p>','<p onclick="evil()">Unsafe</p>']){
  const x=structuredClone(doi);if(a===undefined)delete x.resultList.result[0].abstractText;else x.resultList.result[0].abstractText=a;
  const r=(await collectSurveyCorrectionSources({references:[{kind:'doi',id:'10.1002/alz.12137'}]},fixture(x).deps)).records[0];assert.equal(r.status,'unavailable');assert.equal(r.text,'');assert.equal(r.coverage,'bounded-excerpt');assert.notEqual(r.reason,null);
 }
});
test('input proxies/getters, duplicate references and unsupported kinds cause zero fetch',async()=>{
 let traps=0,calls=0;const deps={fetch:async()=>{calls++;throw Error('must not fetch');}};
 const proxy=new Proxy({}, {get(){traps++;throw Error('trap');},ownKeys(){traps++;throw Error('trap');},getPrototypeOf(){traps++;throw Error('trap');}});
 for(const input of [proxy,{references:[proxy]},{references:[{kind:'arxiv',id:'2510.12384'}]},{references:[...refs(),...refs()]}])await assert.rejects(collectSurveyCorrectionSources(input,deps));
 const item={id:'NCT01561053'};Object.defineProperty(item,'kind',{enumerable:true,get(){traps++;throw Error('getter');}});await assert.rejects(collectSurveyCorrectionSources({references:[item]},deps));assert.equal(traps,0);assert.equal(calls,0);
});
test('raw JSON duplicate keys, invalid UTF8, excessive depth and non-JSON responses refuse',async()=>{
 for(const body of ['{"protocolSection":{},"protocolSection":{}}','['.repeat(40)+'0'+']'.repeat(40),Buffer.from([0xff]),'<html>not JSON</html>']){
  const deps={fetch:async()=>new Response(body,{headers:{'content-type':'application/json'}})};await assert.rejects(collectSurveyCorrectionSources({references:refs()},deps));
 }
 for(const status of [302,404,500])await assert.rejects(collectSurveyCorrectionSources({references:refs()},{fetch:async()=>new Response('{}',{status})}));
});
test('byte limits reject before oversized model/private packets or raw base64 construction',async()=>{
 const x=structuredClone(nct);x.protocolSection.armsInterventionsModule.armGroups[0].description='x'.repeat(65537);await assert.rejects(collectSurveyCorrectionSources({references:refs()},fixture(x).deps));
 await assert.rejects(collectSurveyCorrectionSources({references:refs()},{fetch:async()=>new Response('x'.repeat(512*1024+1),{headers:{'content-type':'application/json'}})}));
 const y=structuredClone(nct);y.unprojected='x'.repeat(270000);await assert.rejects(collectSurveyCorrectionSources({references:refs()},fixture(y).deps));
});
test('pre-aborted source collection performs zero fetches',async()=>{
 let calls=0;const c=new AbortController();c.abort();await assert.rejects(collectSurveyCorrectionSources({references:refs(),signal:c.signal},{fetch:async()=>{calls++;}}));assert.equal(calls,0);
});
test('a shadowed AbortSignal accessor is rejected without executing it or fetching',async()=>{
 let traps=0,calls=0;const c=new AbortController();Object.defineProperty(c.signal,'aborted',{get(){traps++;return false;}});
 await assert.rejects(collectSurveyCorrectionSources({references:refs(),signal:c.signal},{fetch:async()=>{calls++;throw Error('no');}}));assert.equal(traps,0);assert.equal(calls,0);
});
test('upstream exceptions cannot escape as raw source/private diagnostic text',async()=>{
 await assert.rejects(collectSurveyCorrectionSources({references:refs()},{fetch:async()=>{throw Error('private upstream diagnostic');}}),e=>e.code==='correction_source_unavailable'&&!e.message.includes('private upstream'));
});
test('literal numeric less-than comparison in actual-shaped abstract remains text',async()=>{
 const x=structuredClone(doi);x.resultList.result[0].abstractText='<h4>Results</h4>Reported P\u00a0<\u00a0.0001, without any inference.';
 const r=(await collectSurveyCorrectionSources({references:[{kind:'doi',id:'10.1002/alz.12137'}]},fixture(x).deps)).records[0];assert.equal(r.status,'available');assert.match(r.text,/P\u00a0<\u00a0\.0001/);assert.equal(r.coverage,'bounded-excerpt');
});
test('broken response streams produce a closed refusal and never raw error text',async()=>{
 const stream=new ReadableStream({start(controller){controller.error(Error('private stream diagnostic'));}});
 await assert.rejects(collectSurveyCorrectionSources({references:refs()},{fetch:async()=>new Response(stream,{headers:{'content-type':'application/json'}})}),e=>e.code==='correction_source_unavailable'&&!e.message.includes('private stream'));
});
test('custom array prototypes and hidden indexes are refused before fetching',async()=>{
 let calls=0;const a=refs();Object.setPrototypeOf(a,{});const b=refs();Object.defineProperty(b,'0',{enumerable:false});
 for(const references of [a,b])await assert.rejects(collectSurveyCorrectionSources({references},{fetch:async()=>{calls++;throw Error('no');}}));assert.equal(calls,0);
});
test('missing selected participant flow does not claim other registry results absent',async()=>{
 const x=structuredClone(nct);x.resultsSection={baselineCharacteristicsModule:{groups:[]}};
 const r=(await collectSurveyCorrectionSources({references:refs()},fixture(x).deps)).records[0];assert.equal(r.status,'protocol-only');assert.equal(r.reason,'participant-flow-absent');
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifiedContributionCount,contributionBadge,handleContributionBadge} from '../dist/src/api/contribution-badge.js';
const profile={id:'demo',authority:'native',work:{contributed:[]}};
const c=(id,state,extra={})=>({id,state,contributor:'demo',evidence_available:true,...extra});
test('badge counts unique settled evidence records only, excluding adverse and unfinished states',()=>{
 assert.equal(verifiedContributionCount({...profile,work:{contributed:[c('1','settled'),c('1','settled'),...['contested','withheld','rejected','pending','verified'].map((s,i)=>c(String(i+2),s)),c('9','settled',{evidence_available:false})]}}),1);
 assert.equal(verifiedContributionCount(profile),0);
 assert.throws(()=>verifiedContributionCount({...profile,authority:'legacy'}));
 assert.throws(()=>verifiedContributionCount({...profile,work:{contributed:[c('1','settled',{contributor:'someone-else'})]}}));
});
async function request(result,method='GET',path='/api/badges/demo.svg'){
 const res={headers:{},setHeader(k,v){this.headers[k]=v},end(body){this.body=body}};
 const handled=await handleContributionBadge({method},res,new URL(path,'https://uain.invalid'),async()=>{if(result instanceof Error)throw result;return result},()=>{});
 return {...res,handled};
}
test('HTTP badge keeps a real zero distinct from unknown and unavailable, and HEAD empty',async()=>{
 const ok=await request({status:200,body:profile});assert.equal(ok.statusCode,200);assert.match(ok.body,/: 0/);assert.equal(ok.headers['cache-control'],'public, max-age=60, s-maxage=60');
 for(const result of [new Error('offline'),{status:503},{status:200,body:{}}]){const r=await request(result);assert.equal(r.statusCode,503);assert.match(r.body,/unavailable/);assert.equal(r.headers['cache-control'],'no-store')}
 const missing=await request({status:404});assert.equal(missing.statusCode,404);assert.match(missing.body,/unknown/);
 assert.equal((await request({status:200,body:profile},'HEAD')).body,undefined);
 assert.equal((await request(null,'POST')).handled,false);
 assert.equal((await request(null,'GET','/api/badges/a%3Cb.svg')).handled,false);
});
test('SVG escapes caller content and contains no script or external resources',()=>{
 const svg=contributionBadge('<script>&"');assert.ok(!svg.includes('<script>'));assert.match(svg,/&lt;script&gt;&amp;&quot;/);
});

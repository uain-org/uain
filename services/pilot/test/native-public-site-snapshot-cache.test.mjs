import {test} from 'node:test';import assert from 'node:assert/strict';
import {createNativePublicSiteSnapshots}from'../dist/src/native/public-site-snapshot.js';
test('dated site snapshots are bounded, isolated and expire without a completed same-generation warm',()=>{
 let time=0;const cache=createNativePublicSiteSnapshots({maxEntries:2,maxBytes:1000,maxAgeMs:120000,now:()=>time});
 cache.put('a',{projects:[{id:'a'}]},'old');time=100;cache.put('b',{projects:[{id:'b'}]},'current');
 const read=cache.get('a');read.value.projects[0].id='changed';assert.equal(cache.get('a').value.projects[0].id,'a');assert.equal(cache.get('a').verifiedAt,0);
 time=119900;cache.renew('current');assert.equal(cache.get('a').verifiedAt,0,'a new generation must not renew old verification time');assert.equal(cache.get('b').verifiedAt,119900);
 time=120000;assert.equal(cache.get('a'),null);assert.ok(cache.get('b'));cache.put('c',{projects:[]},'current');cache.put('d',{projects:[]},'current');assert.equal(cache.get('b'),null,'entry-count bound must evict oldest');
 cache.put('oversized',{body:'x'.repeat(1100)},'current');assert.equal(cache.get('oversized'),null);time=240000;assert.equal(cache.get('d'),null);
});

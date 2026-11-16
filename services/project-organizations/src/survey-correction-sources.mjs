/** Prospective correction provenance ONLY; no production caller or semantic verifier.
 * rawSources are PRIVATE audit material, never model/public input. A later context
 * composer must independently enforce its COMPLETE256KiB packet and Root authority.
 */
import {types} from 'node:util';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createPinnedFetch} from './pinned-fetch.mjs';
import {normalizeId} from '../verifiers/prior-art-survey.mjs';
import {canonical, OrganizationError} from './common.mjs';

const RESPONSE_MAX=512*1024, RAW_TOTAL_MAX=256*1024, TEXT_MAX=64*1024, RECORDS_MAX=128*1024, PRIVATE_PACKET_MAX=512*1024;
const EXTRACTOR_DIGEST=hash(readFileSync(new URL(import.meta.url)));
const HOSTS=['clinicaltrials.gov','www.ebi.ac.uk'];
const fail=(code='correction_source_unavailable')=>{throw new OrganizationError(code);};
const need=(v,code)=>{if(!v)fail(code);};
function hash(b){return createHash('sha256').update(b).digest('hex');}
function object(v){return v!==null&&typeof v==='object'&&!types.isProxy(v)&&!Array.isArray(v)&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);}
function fields(v,allowed,required=allowed){
 need(object(v),'invalid_correction_sources');const keys=Reflect.ownKeys(v);need(keys.length<=allowed.length&&keys.every(k=>typeof k==='string'&&allowed.includes(k))&&required.every(k=>keys.includes(k)),'invalid_correction_sources');
 const d=Object.getOwnPropertyDescriptors(v);need(keys.every(k=>Object.hasOwn(d[k],'value')&&d[k].enumerable),'invalid_correction_sources');return Object.fromEntries(keys.map(k=>[k,d[k].value]));
}
function freeze(v){if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
/** Count exact escaped JSON bytes BEFORE serializing a selected projection/packet. */
function boundedJSON(value,limit){
 let bytes=0,nodes=0;const add=n=>{bytes+=n;need(bytes<=limit,'correction_materials_overflow');};
 const str=s=>{need(s.isWellFormed(),'correction_source_invalid_json');add(2);for(const c of s){const n=c.codePointAt(0);add(c==='"'||c==='\\'||'\b\t\n\f\r'.includes(c)?2:n<32?6:n<128?1:n<2048?2:n<65536?3:4);}};
 const walk=(v,depth)=>{need(++nodes<=20000&&depth<=32,'correction_materials_overflow');if(v===null){add(4);return;}if(typeof v==='string'){str(v);return;}if(typeof v==='boolean'){add(v?4:5);return;}if(typeof v==='number'){need(Number.isSafeInteger(v),'correction_source_invalid_json');add(String(v).length);return;}if(Array.isArray(v)){add(2);for(let i=0;i<v.length;i++){if(i)add(1);walk(v[i],depth+1);}return;}need(object(v),'correction_source_invalid_json');const keys=Object.keys(v).sort();add(2);for(let i=0;i<keys.length;i++){if(i)add(1);str(keys[i]);add(1);walk(v[keys[i]],depth+1);}};
 walk(value,0);return canonical(value);
}
/** Public-source JSON permits finite decimals in UNUSED fields (e.g. registry
 * geo-coordinates). Native evidence's integer-only parser is deliberately unchanged.
 * Selected projections must still pass the stricter canonical packet validator.
 */
function sourceJSON(bytes){
 let s;try{s=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{fail('correction_source_invalid_json');}
 need(s.length>0&&s[0]!=='\ufeff','correction_source_invalid_json');let value;try{value=JSON.parse(s);}catch{fail('correction_source_invalid_json');}
 let i=0,nodes=0;const ws=()=>{while(/[\t\n\r ]/.test(s[i]??'')&&i<s.length)i++;};
 const string=()=>{const start=i++;while(i<s.length){if(s[i]==='\\'){i+=2;continue;}if(s[i++]==='"')break;}const v=JSON.parse(s.slice(start,i));need(v.isWellFormed(),'correction_source_invalid_json');return v;};
 const walk=depth=>{need(depth<=32&&++nodes<=20000,'correction_source_invalid_json');ws();const c=s[i];if(c==='"'){string();return;}if(c==='{'||c==='['){const o=c==='{',end=o?'}':']',keys=new Set();i++;ws();if(s[i]===end){i++;return;}while(true){if(o){ws();const k=string();need(!keys.has(k),'correction_source_invalid_json');keys.add(k);ws();i++;}walk(depth+1);ws();if(s[i]===end){i++;return;}i++;}}const start=i;while(i<s.length&&!/[\t\n\r ,}\]]/.test(s[i]))i++;const t=s.slice(start,i);need(['true','false','null'].includes(t)||(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(t)&&Number.isFinite(Number(t))&&(!/^-?[0-9]+$/.test(t)||Number.isSafeInteger(Number(t)))),'correction_source_invalid_json');};
 walk(0);ws();need(i===s.length,'correction_source_invalid_json');return value;
}
export function correctionSourceResolution(kind,id){
 need(typeof kind==='string'&&['nct','doi'].includes(kind)&&typeof id==='string'&&id.length<=512&&normalizeId(kind,id)===id,'unsupported_correction_source');
 if(kind==='nct')return freeze({provider:'clinicaltrials',url:`https://clinicaltrials.gov/api/v2/studies/${encodeURIComponent(id)}`});
 const q=new URLSearchParams({query:`DOI:"${id}"`,format:'json',resultType:'core',pageSize:'2'});
 return freeze({provider:'europepmc',url:`https://www.ebi.ac.uk/europepmc/webservices/rest/search?${q}`});
}
function abstractText(raw){
 need(typeof raw==='string'&&raw.length>0&&Buffer.byteLength(raw)<=TEXT_MAX,'correction_abstract_unavailable');
 const allowed=new Set(['h1','h2','h3','h4','h5','h6','p','div','br','i','em','b','strong','sup','sub','span']),blocks=new Set(['h1','h2','h3','h4','h5','h6','p','div','br']),stack=[];let result='',i=0;
 while(i<raw.length){if(raw[i]!=='<'){const end=raw.indexOf('<',i);result+=raw.slice(i,end<0?raw.length:end);i=end<0?raw.length:end;continue;}if(/^<[\s\u00a0]*=?[\s\u00a0]*[-+]?(?:[0-9]|\.[0-9])/.test(raw.slice(i))){result+='<';i++;continue;}const m=/^<(\/?)([A-Za-z][A-Za-z0-9]*)(\s*\/?)>/.exec(raw.slice(i));need(m,'correction_abstract_unavailable');const tag=m[2].toLowerCase(),close=m[1]==='/',self=m[3].trim()==='/';need(allowed.has(tag)&&(!self||tag==='br')&&!(tag==='br'&&close),'correction_abstract_unavailable');if(tag!=='br'){if(close)need(stack.pop()===tag,'correction_abstract_unavailable');else stack.push(tag);}if(blocks.has(tag))result+='\n';i+=m[0].length;}
 need(stack.length===0,'correction_abstract_unavailable');const named={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
 result=result.replace(/&([^;\s]{1,32});/g,(_,entity)=>{if(Object.hasOwn(named,entity))return named[entity];need(/^#(?:[0-9]+|x[0-9a-f]+)$/i.test(entity),'correction_abstract_unavailable');const n=entity[1].toLowerCase()==='x'?parseInt(entity.slice(2),16):Number(entity.slice(1));need(Number.isInteger(n)&&n>=32&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)&&n!==127,'correction_abstract_unavailable');return String.fromCodePoint(n);});
 result=result.replace(/[ \t]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();need(result.length>0&&result.isWellFormed()&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result),'correction_abstract_unavailable');return result;
}
function registry(x,id){
 const p=x?.protocolSection;need(object(p)&&p.identificationModule?.nctId===id,'correction_source_identity_mismatch');const title=p.identificationModule.briefTitle;need(typeof title==='string'&&title.trim().length>0,'correction_source_identity_mismatch');
 const enrollment=p.designModule?.enrollmentInfo;need(object(enrollment)&&Number.isSafeInteger(enrollment.count)&&enrollment.count>=0&&['ACTUAL','ESTIMATED'].includes(enrollment.type),'correction_source_invalid_json');
 const flow=x.resultsSection?.participantFlowModule;need(flow===undefined||object(flow),'correction_source_invalid_json');
 const selectorProjection=[{path:'protocolSection.identificationModule',value:{nctId:id,briefTitle:title}},{path:'protocolSection.designModule',value:p.designModule},{path:'protocolSection.armsInterventionsModule',value:p.armsInterventionsModule??null},{path:'resultsSection.participantFlowModule',value:flow??null}];
 const text=boundedJSON(selectorProjection,TEXT_MAX);
 return{resolvedId:id,status:flow?'available':'protocol-only',reason:flow?null:x.resultsSection===undefined?'results-absent':'participant-flow-absent',selectorProjection,text};
}
function article(x,id){
 need(x?.hitCount===1&&Array.isArray(x.resultList?.result)&&x.resultList.result.length===1,'correction_source_identity_mismatch');const r=x.resultList.result[0];
 need(object(r)&&r.source==='MED'&&typeof r.id==='string'&&/^[1-9][0-9]{0,11}$/.test(r.id)&&r.pmid===r.id&&typeof r.doi==='string'&&normalizeId('doi',r.doi)===id&&typeof r.title==='string'&&r.title.trim().length>0,'correction_source_identity_mismatch');
 let text;try{text=abstractText(r.abstractText);}catch(error){if(error instanceof OrganizationError&&error.code==='correction_abstract_unavailable')return{resolvedId:r.id,status:'unavailable',reason:'abstract-unavailable',selectorProjection:[],text:''};throw error;}
 const selectorProjection=[{path:'resultList.result[0].title',value:r.title},{path:'resultList.result[0].abstractText',value:text}];
 boundedJSON(selectorProjection,TEXT_MAX);return{resolvedId:r.id,status:'available',reason:null,selectorProjection,text:`${r.title}\n${text}`};
}
async function body(response){
 const length=response.headers.get('content-length');need(length===null||(/^[0-9]+$/.test(length)&&Number(length)<=RESPONSE_MAX),'correction_materials_overflow');
 const reader=response.body?.getReader();need(reader,'correction_source_unavailable');const chunks=[];let n=0;
 try{while(true){const r=await reader.read();if(r.done)break;need(r.value instanceof Uint8Array,'correction_source_unavailable');n+=r.value.byteLength;need(n<=RESPONSE_MAX,'correction_materials_overflow');chunks.push(Buffer.from(r.value));}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 return Buffer.concat(chunks,n);
}
/** Second argument is IMPORT-ONLY trusted test/host composition, never CLI JSON. */
export async function collectSurveyCorrectionSources(input,deps={}){
 const v=fields(input,['references','signal'],['references']),a=v.references;need(Array.isArray(a)&&!types.isProxy(a)&&Object.getPrototypeOf(a)===Array.prototype&&a.length>=1&&a.length<=32,'invalid_correction_sources');const keys=Reflect.ownKeys(a);need(keys.length===a.length+1&&keys.every(k=>k==='length'||/^(0|[1-9][0-9]*)$/.test(k)),'invalid_correction_sources');
 const ds=Object.getOwnPropertyDescriptors(a),references=[],seen=new Set();for(let i=0;i<a.length;i++){need(Object.hasOwn(ds[String(i)]??{},'value')&&ds[String(i)].enumerable,'invalid_correction_sources');const r=fields(ds[String(i)].value,['kind','id']),resolution=correctionSourceResolution(r.kind,r.id),key=`${r.kind}:${r.id}`;need(!seen.has(key),'invalid_correction_sources');seen.add(key);references.push({...r,resolution});}
 let signal=v.signal;if(signal!==undefined){need(signal!==null&&typeof signal==='object'&&!types.isProxy(signal),'invalid_correction_sources');need(Object.getOwnPropertyDescriptor(signal,'aborted')===undefined,'invalid_correction_sources');try{Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted').get.call(signal);}catch{fail('invalid_correction_sources');}}
 const aborted=()=>{need(signal===undefined||!Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted').get.call(signal),'correction_source_aborted');};aborted();
 const d=fields(deps,['fetch','now'],[]);need(d.fetch===undefined||typeof d.fetch==='function','invalid_correction_sources');need(d.now===undefined||typeof d.now==='function','invalid_correction_sources');const fetch=d.fetch??createPinnedFetch({allowedHosts:HOSTS,maxBytes:RESPONSE_MAX,timeoutMs:20000}),now=d.now??(()=>new Date());
 const records=[],rawSources=[];let rawTotal=0;
 for(const ref of references){aborted();let response;try{response=await fetch(ref.resolution.url,{method:'GET',redirect:'error',headers:{accept:'application/json'},signal,maxBytes:RESPONSE_MAX});}catch{fail('correction_source_unavailable');}need(response.status===200,'correction_source_unavailable');const contentType=response.headers.get('content-type');need(typeof contentType==='string'&&contentType.length<=128&&/^application\/json(?:\s*;\s*charset=(?:utf-8|utf8))?$/i.test(contentType),'correction_source_invalid_json');let raw;try{raw=await body(response);}catch(error){if(error instanceof OrganizationError)throw error;fail('correction_source_unavailable');}aborted();rawTotal+=raw.length;need(rawTotal<=RAW_TOTAL_MAX,'correction_materials_overflow');const x=sourceJSON(raw),projection=ref.kind==='nct'?registry(x,ref.id):article(x,ref.id);need(Buffer.byteLength(projection.text)<=TEXT_MAX,'correction_materials_overflow');const clock=now();need(clock instanceof Date&&Number.isFinite(clock.getTime()),'invalid_correction_sources');const sourceBodySha256=hash(raw),sourceBodyBytes=raw.length;
  records.push({kind:ref.kind,id:ref.id,resolution:{...ref.resolution,resolvedId:projection.resolvedId},retrievedAt:clock.toISOString(),sourceBodySha256,sourceBodyBytes,contentType,extractorDigest:EXTRACTOR_DIGEST,coverage:'bounded-excerpt',truncated:false,status:projection.status,reason:projection.reason,selectorProjection:projection.selectorProjection,text:projection.text,textSha256:hash(projection.text),textBytes:Buffer.byteLength(projection.text)});
  boundedJSON(records,RECORDS_MAX);need(4*Math.ceil(raw.length/3)+sourceBodyBytes<=PRIVATE_PACKET_MAX,'correction_materials_overflow');rawSources.push({kind:ref.kind,id:ref.id,sourceBodySha256,sourceBodyBytes,base64:raw.toString('base64')});boundedJSON({records,rawSources},PRIVATE_PACKET_MAX);
 }
 return freeze({schema:'uain-survey-correction-sources-v1',scope:'provenance-only',records,rawSources});
}

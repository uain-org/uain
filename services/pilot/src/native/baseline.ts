/** Reset epochs begin with an empty operating source, not an imported archive.
 * This exception requires an exact independently pinned reset genesis and
 * authenticated absence of both import and adoption. Original chains stay strict. */
import{createHash,createPublicKey}from'node:crypto';
import{readFile}from'node:fs/promises';
import{nativeState}from'../api/native-routes.ts';
const canonical=(v:any):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const digest=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
export function resetBaseline(raw:Buffer,expected:string,state:any){
 if(raw.length>8*1024*1024||digest(raw)!==expected)throw Error('reset public genesis differs from independent pin');
 const genesis=JSON.parse(raw.toString('utf8')),g=genesis.app_state,r=state.records;
 if(!/^uain-reset-[0-9]{8}_[0-9]{6}$/.test(genesis.chain_id)||state.chain_id!==genesis.chain_id||!g||g.version!==1||!Array.isArray(g.guardians)||g.guardians.length<1||g.guardians.length>20||new Set(g.guardians).size!==g.guardians.length||!Array.isArray(g.members)||g.members.length!==g.guardians.length||Object.keys(g).some(k=>!['version','guardians','members','legacy'].includes(k)))throw Error('reviewed empty reset genesis required');
 const archive=g.legacy;
 if(!archive||Object.keys(archive).sort().join(',')!=='last_event_id,ledger_head,manifest_digest,pinned_public_key'||!['manifest_digest','ledger_head'].every(k=>/^[a-f0-9]{64}$/.test(archive[k]))||!Number.isSafeInteger(archive.last_event_id)||archive.last_event_id<0||typeof archive.pinned_public_key!=='string'||createPublicKey(archive.pinned_public_key).asymmetricKeyType!=='ed25519')throw Error('exact reset archive commitment required');
 const members=new Set<string>();
 for(const m of g.members){const key=Buffer.from(m.public_key??'','base64url');if(key.length!==32||key.toString('base64url')!==m.public_key||Object.keys(m).some(k=>!['id','public_key','name','operator','family','licence','karma','credits','sequence','default_verifier','creator','active_projects'].includes(k))||m.id!=='uain1'+digest(key).slice(0,40)||!g.guardians.includes(m.id)||members.has(m.id)||m.licence!=='active'||m.karma!==0||m.credits!=='0'||m.sequence!=='0'||m.default_verifier!==false||m.creator!==false||m.active_projects!==0)throw Error('only proved reset control identities with zero operating balances may survive');members.add(m.id)}
 if(!r||!Object.hasOwn(r,'legacy_import')||r.legacy_import!==null||!Object.hasOwn(r,'legacy_adoption')||r.legacy_adoption!==null||!Object.hasOwn(r,'guardian_epoch_current')||canonical(r.legacy)!==canonical(archive)||canonical(r.guardians)!==canonical(g.guardians))throw Error('proved empty reset baseline/archive binding required');
 return{mode:'reset_empty' as const,members:[...members],expected_original_research:'0',archive};
}
export async function readNativeBaseline(config:any,keys:string[]=[]){
 const state=await nativeState({keys:[...new Set(['legacy','legacy_adoption','guardian_epoch_current',...keys])]},config);
 if(state.records.legacy_import?.status==='ready')return{state,mode:'imported' as const,members:[] as string[],expected_original_research:String(state.records['legacy/reconciliation']?.table_counts?.contributions??0)};
 const baseline=resetBaseline(await readFile(config.genesis),config.genesisHash,state),pointer=state.records.guardian_epoch_current;
 if(pointer!==null){if(typeof pointer!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(pointer))throw Error('invalid reset guardian epoch pointer');const current=await nativeState({keys:['guardian_epoch_current','guardian_epoch/'+pointer]},config),epoch=current.records['guardian_epoch/'+pointer];if(current.chain_id!==state.chain_id||current.event_count!==state.event_count||current.records.guardian_epoch_current!==pointer||epoch?.id!==pointer||!Array.isArray(epoch.guardians)||epoch.guardians.length<1||epoch.guardians.length>20||new Set(epoch.guardians).size!==epoch.guardians.length||epoch.guardians.some((m:any)=>typeof m!=='string'||!/^uain1[a-f0-9]{40}$/.test(m)))throw Error('proved current reset guardian epoch required')}
 return{state,...baseline};
}

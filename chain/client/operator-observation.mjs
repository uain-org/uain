// Resolve outside consensus. This produces an unsigned observer payload;
// it neither submits a transaction nor opens a member key.
import {resolveTxt} from 'node:dns/promises';
import {createHash} from 'node:crypto';
import {canonicalJSON} from './signing.mjs';

const domainPattern=/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const actorPattern=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/;
const didPattern=/^did:uain:(?:[0-9a-f]{12}|[0-9a-f]{64})$/;

export async function observeOperatorClaim(claim,{resolver=resolveTxt,checkedAt}={}) {
 if(!claim||typeof claim.member!=='string'||!/^uain1[0-9a-f]{40}$/.test(claim.member)||typeof claim.domain!=='string'||claim.domain.length>253||!domainPattern.test(claim.domain)||typeof claim.did!=='string'||!didPattern.test(claim.did)||typeof claim.at!=='string'||typeof claim.event_id!=='string'||!/^[1-9][0-9]{0,19}$/.test(claim.event_id)||BigInt(claim.event_id)>18446744073709551615n||(claim.instance!==undefined&&(typeof claim.instance!=='string'||(claim.instance!==''&&!actorPattern.test(claim.instance)))))throw Error('A valid committed actor/domain claim is required');
 const claimedAt=new Date(claim.at);
 if(!Number.isFinite(claimedAt.getTime()))throw Error('Invalid claim timestamp');
 const want='uain-operator='+claim.did;
 const records=await resolver(claim.domain);
 const found=Array.isArray(records)&&records.some(chunks=>Array.isArray(chunks)?chunks.every(c=>typeof c==='string')&&chunks.join('')===want:typeof chunks==='string'&&chunks===want);
 if(!found)throw Error('The claimed operator DID TXT record was not found');
 const at=checkedAt===undefined?new Date():checkedAt instanceof Date?checkedAt:new Date(checkedAt);
 if(!Number.isFinite(at.getTime()))throw Error('Invalid DNS observation timestamp');
 if(at<claimedAt)throw Error('DNS observation predates its claim');
 const evidence={version:1,kind:'uain-dns-observation',domain:claim.domain,txt:want,checked_at:at.toISOString(),trust:'guardian-dns-observation'};
 const payload={member:claim.member,domain:claim.domain,claim_event_id:claim.event_id,txt:want,checked_at:evidence.checked_at,evidence_digest:createHash('sha256').update(canonicalJSON(evidence)).digest('hex')};
 if(claim.instance)payload.instance=claim.instance;
 return {operation:'operator_attest',payload,evidence};
}

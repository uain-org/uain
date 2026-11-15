/** Prospective parser only. No issuer, provider, native mutation or custody authority. */
import{createPublicKey,verify}from'node:crypto';
import{canonical,sha256,exactKeys,plain,HASH,NATIVE_ID,ADDRESS,text,need}from'../../project-organizations/src/common.mjs';
const isHash=v=>typeof v==='string'&&HASH.test(v),isId=v=>typeof v==='string'&&NATIVE_ID.test(v),isAddress=v=>typeof v==='string'&&ADDRESS.test(v);
export const DOMAIN='UAIN/fund-achievement/v1';
const bindingKeys=['chainId','genesisSha256','nativeVerifierSha256','projectId','manager','evaluator','applicationId','approvedPlanRevision','round','applicationEvidenceDigest','approvedPlanDigest','stageCriteriaDigest','mainKpiDigest'];
export function validateBinding(b){need(exactKeys(b,bindingKeys),'achievement_binding');need(text(b.chainId,1,96)&&isId(b.projectId)&&isId(b.applicationId)&&isAddress(b.manager)&&isAddress(b.evaluator)&&b.manager!==b.evaluator,'achievement_roles');need(Number.isSafeInteger(b.approvedPlanRevision)&&b.approvedPlanRevision>0&&Number.isSafeInteger(b.round)&&b.round>=1&&b.round<=5,'achievement_round');for(const k of ['genesisSha256','nativeVerifierSha256','applicationEvidenceDigest','approvedPlanDigest','stageCriteriaDigest','mainKpiDigest'])need(isHash(b[k]??''),'achievement_digest');return b;}
const timestamp=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const bytes=(domain,v)=>Buffer.from(domain+'\n'+canonical(v));
export const policyDigest=p=>sha256(bytes('UAIN/fund-achievement-policy/v1',p));
export const receiptBytes=s=>bytes(DOMAIN,s);
export const statementDigest=s=>sha256(receiptBytes(s));
export function validateAchievementPolicy(p,{environment,now=Date.now()}={}){
 need(exactKeys(p,['schema','domain','environment','binding','verifier','successTestsDigest','expiresAt'])&&p.schema==='uain-fund-achievement-policy-v1'&&p.domain===DOMAIN&&['fixture','production'].includes(p.environment)&&p.environment===environment,'achievement_policy');validateBinding(p.binding);
 need(exactKeys(p.verifier,['keyId','publicKey','sourceSha256','driverSha256'])&&isId(p.verifier.keyId)&&typeof p.verifier.publicKey==='string'&&/^[A-Za-z0-9_-]{43}$/.test(p.verifier.publicKey),'achievement_verifier');for(const v of[p.verifier.sourceSha256,p.verifier.driverSha256,p.successTestsDigest])need(isHash(v??''),'achievement_policy_digest');need(timestamp(p.expiresAt)&&Date.parse(p.expiresAt)>now,'achievement_policy_expired');return p;
}
export function validateAchievementReceipt(envelope,policy,{binding,environment,now=Date.now()}={}){
 validateBinding(binding);validateAchievementPolicy(policy,{environment,now});need(canonical(policy.binding)===canonical(binding),'achievement_policy_binding');
 need(exactKeys(envelope,['statement','statementDigest','keyId','signature']),'achievement_envelope');const s=envelope.statement;
 need(exactKeys(s,['schema','domain','environment','binding','policyDigest','verifierSourceSha256','driverSha256','evidenceManifestDigest','evidenceReceipts','executionId','issuedAt','expiresAt','observation','verdict','deficiencies','mainKpiSatisfied'])&&s.schema==='uain-fund-achievement-v1'&&s.domain===DOMAIN&&s.environment===environment,'achievement_statement');validateBinding(s.binding);need(canonical(s.binding)===canonical(binding)&&s.policyDigest===policyDigest(policy)&&s.verifierSourceSha256===policy.verifier.sourceSha256&&s.driverSha256===policy.verifier.driverSha256,'achievement_statement_binding');
 need(isHash(s.evidenceManifestDigest??'')&&Array.isArray(s.evidenceReceipts)&&s.evidenceReceipts.length>0&&s.evidenceReceipts.length<=64&&s.evidenceReceipts.every(v=>typeof v==='string'&&isHash(v))&&new Set(s.evidenceReceipts).size===s.evidenceReceipts.length&&text(s.executionId,1,96),'achievement_evidence');
 need(exactKeys(s.observation,['height','appHash'])&&/^[1-9][0-9]{0,18}$/.test(s.observation.height??'')&&isHash(s.observation.appHash??''),'achievement_observation');
 need(timestamp(s.issuedAt)&&timestamp(s.expiresAt)&&Date.parse(s.issuedAt)<=now+30000&&now-Date.parse(s.issuedAt)<=300000&&Date.parse(s.expiresAt)>now&&Date.parse(s.expiresAt)>Date.parse(s.issuedAt)&&Date.parse(s.expiresAt)-Date.parse(s.issuedAt)<=300000&&Date.parse(s.expiresAt)<=Date.parse(policy.expiresAt),'achievement_expired');
 need(['pass','fail','needs_evidence'].includes(s.verdict)&&Array.isArray(s.deficiencies)&&s.deficiencies.length<=32&&s.deficiencies.every(v=>text(v,1,1000))&&(s.verdict==='pass'?s.deficiencies.length===0:s.deficiencies.length>0),'achievement_verdict');
 need(s.mainKpiSatisfied===(binding.round===5&&s.verdict==='pass'),'achievement_main_kpi');need(envelope.keyId===policy.verifier.keyId&&envelope.statementDigest===statementDigest(s),'achievement_signature_binding');
 need(typeof envelope.signature==='string'&&/^[A-Za-z0-9_-]{86}$/.test(envelope.signature),'achievement_signature');const sig=Buffer.from(envelope.signature,'base64url');need(sig.length===64&&sig.toString('base64url')===envelope.signature,'achievement_signature');
 const key=createPublicKey({format:'jwk',key:{kty:'OKP',crv:'Ed25519',x:policy.verifier.publicKey}});need(verify(null,receiptBytes(s),key,sig),'achievement_signature');return structuredClone(s);
}

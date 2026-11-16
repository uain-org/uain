// Opt-in FICTIONAL integration: real proof/paired holder/app HTTP/HMAC queue.
// Every signing identity and provider judgement is disposable fixture material.
import assert from'node:assert/strict';
import{randomBytes,sign}from'node:crypto';
import{mkdir}from'node:fs/promises';
import{join}from'node:path';
import{fixture}from'./http-fixture.mjs';
import{createNativeAssetAdapter}from'../server/native-asset.mjs';
import{createPublicReviewRuntime}from'../server/public-review.mjs';
import{createServiceBroker}from'../review-broker/service-broker.mjs';
import{createPublicBrokerBridge}from'../review-broker/public-broker-bridge.mjs';
import{createPublicReviewCoordinator}from'../web/public-review.js';
import{canonicalJSON}from'../../../chain/client/signing.mjs';
import{runReviewerAction}from'../review-broker/reviewer-worker.mjs';

export async function createFictionalPublicCourier({t,network,profile,brokerPair,reviewerSeed,relaySeed,actor,browser,payer,operationId,onInspection}){
 assert.equal(process.env.UAIN_FINANCIAL_PUBLIC_COURIER_E2E,'1');assert.match(network.config.chainId,/^baink-fictional-e2e-/);
 const root=join(network.root,'fictional-public-review'),journal=join(root,'broker'),exchange=join(root,'exchange');await mkdir(root,{mode:0o700});await mkdir(journal,{mode:0o700});await mkdir(exchange,{mode:0o700});
 const publicKey=brokerPair.publicKey.export({format:'jwk'}).x,secret=randomBytes(32),jobs=new Map(),counts={inspect:0,finalize:0,relay:0,offlineDecisions:0,qualificationProbes:0,ownerHTTP:0,workerHTTP:0};
 const rootAction=async(action,id,body)=>{
  if(action==='health')return runReviewerAction({action,jobId:id,profile,reviewerSeed,relaySeed});
  if(action==='create'){assert.ok(!jobs.has(id));jobs.set(id,{context:structuredClone(body.context)});return{status:'created',jobId:id};}
  const job=jobs.get(id);assert.ok(job,'Original fixture custody job required');
  const input=()=>({jobId:id,profile,reviewerSeed,certificate:job.certificate,encryptionPrivateKey:job.encryptionPrivateKey,...job.ingested});
  if(action==='certificate'){Object.assign(job,await runReviewerAction({action,jobId:id,profile,reviewerSeed,context:job.context}));return{certificate:job.certificate};}
  if(action==='ingest'){assert.deepEqual(body.envelope.certificate,job.certificate);job.ingested=structuredClone(body);return{status:'ingested'};}
  if(action==='inspect'){if(!job.report){const inspected=await runReviewerAction({action,...input()});job.report=inspected.report;onInspection(job.report);counts.inspect++;}return{inspectionDigest:job.report.inspectionDigest};}
  if(action==='report')return job.report;
  if(action==='attest'){const checked=await runReviewerAction({action,jobId:id,profile,audit:body,report:job.report});assert.notEqual(checked.decision.class,'refuse');const forged=structuredClone(body);forged.attestation.payload.inspectionDigest='0'.repeat(64);await assert.rejects(runReviewerAction({action,jobId:id,profile,audit:forged,report:job.report}));job.audit=structuredClone(body);return{status:'attested'};}
  if(action==='finalize'){if(!job.finalized){job.finalized=await runReviewerAction({action,...input(),report:job.report,audit:job.audit});counts.finalize++;}return job.finalized;}
  if(action==='relay'){assert.ok(job.finalized);if(!job.relay){job.relay=await runReviewerAction({action,jobId:id,profile,reviewerSeed,relaySeed,...body,finalized:job.finalized});counts.relay++;}return job.relay;}
  throw Error('Unknown fictional root action');
 };
 const pins={...profile.pins,verifierSha256:network.config.binaryHash,reviewer:profile.reviewer,reviewerPublicKey:profile.reviewerPublicKey,relay:profile.relay},runtime=await createPublicReviewRuntime({directory:join(root,'gateway'),native:createNativeAssetAdapter({config:network.config}),pins,rootAction,workerSecret:secret,brokerPublicKey:publicKey,audience:'https://baink.example',autoRun:true});
 const app=await fixture(t,{nativeConfig:network.config,publicReviewRuntime:runtime});
 assert.equal((await app.request(actor,'POST','/api/account',{displayName:'Fictional public-courier owner'})).status,201);
 const signer={publicKey,sign:p=>sign(null,Buffer.from('BAINK/private-ai-decision/v1\n'+canonicalJSON(p)),brokerPair.privateKey).toString('base64url')};
 const broker=createServiceBroker({exchangeRoot:exchange,journalDirectory:journal,signer,rootAction,providerId:'explicit-offline-fictional-provider',decide:async request=>{const report=JSON.parse(request).report,probe=report.schema==='explicitly-fictional-provider-probe';counts[probe?'qualificationProbes':'offlineDecisions']++;const decision={class:probe?'refuse':'neutral',statement:'Explicit offline fictional checker qualification only; no real AI provider or production ethical approval.',checkedPurpose:report.inspection.context.purpose,ownerLicenceChecked:!probe,bothLicencesChecked:!probe};return{decision,response:JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:decision})};}});
 await broker.qualifyProvider();
 const bridge=createPublicBrokerBridge({origin:'https://baink.example',secret,directory:journal,broker,readHealth:async()=>{const payload={schema:'baink-private-service-health-v1',chainId:pins.chainId,genesisSha256:pins.genesisSha256,reviewer:pins.reviewer,relay:pins.relay,checkedAt:new Date().toISOString(),rootReady:true,modelQualified:true};return{payload,signature:sign(null,Buffer.from('BAINK/private-service-health/v1\n'+canonicalJSON(payload)),brokerPair.privateKey).toString('base64url')};},fetcher:async(url,options)=>{counts.workerHTTP++;const response=await app.request(null,'POST',new URL(url).pathname,JSON.parse(options.body),options.headers);return new Response(JSON.stringify(response.body),{status:response.status});}});
 const badWorker=await app.request(null,'POST','/api/native/review-worker/claim',{claimId:'a'.repeat(32)});assert.equal(badWorker.status,401);
 await runtime.tick();await bridge.tick();
 const browserActor={...actor,privateKey:browser.privateKey};assert.equal(browserActor.privateKey.extractable,false);
 const coordinator=createPublicReviewCoordinator({apiCall:async(path,options={})=>{counts.ownerHTTP++;const response=await app.request(browserActor,options.method??'GET',path,options.body??{});assert.ok(response.status>=200&&response.status<300,path+': '+JSON.stringify(response.body));return response.body;}});
 let latest,lastJobId,lastAdvance=0;return{counts,async advance(){if(Date.now()-lastAdvance<2000)return latest;lastAdvance=Date.now();latest=await coordinator.advance({identity:browser,operationId,token:'fictional-holder-pairing-token-is-not-exported',pins:profile.pins,publicKey:runtime.publicKey,holderCall:(path,options)=>payer.request(path,options.method==='POST'?options.body:undefined)});if(latest.jobId)lastJobId=latest.jobId;assert.ok(!['refused','needs-recovery','checker-unavailable'].includes(latest.status),JSON.stringify(latest));await bridge.tick();return latest;},async verify(){assert.equal(counts.qualificationProbes,1);assert.equal(counts.offlineDecisions,1);assert.equal(counts.inspect,1);assert.equal(counts.finalize,1);assert.equal(counts.relay,1);assert.ok(counts.ownerHTTP>5&&counts.workerHTTP>3);assert.ok(lastJobId);const result=await app.request(browserActor,'GET','/api/native/review/'+lastJobId);assert.equal(result.status,200);assert.equal(result.body.payload.phase,'relayed');assert.equal(result.body.payload.owner,actor.address);assert.equal(result.body.payload.paid,false);const foreign=network.people.checker;assert.equal((await app.request(foreign,'POST','/api/account',{displayName:'Fictional foreign checker'})).status,201);assert.equal((await app.request(foreign,'GET','/api/native/review/'+lastJobId)).status,404);t.diagnostic(JSON.stringify({fixtureOnly:true,productionWrites:false,stage:'seventh-typed-public-review-courier',chainId:network.config.chainId,genesisSha256:network.config.genesisHash,actualOrchardProof:true,actualPairedTypedPublicArtifactUploads:true,actualBrowserCoordinator:true,nonextractableOwnerHTTPKey:true,actualSignedOwnerAppHTTP:true,actualHMACWorkerHTTP:true,realPublicReviewRuntime:true,realReviewerWorker:true,offlineFictionalProvider:true,actualAIProviderCalled:false,wrongWorkerAuthRefused:true,wrongOwnerRefused:true,forgedAuditRefused:true,counts,paid:false,financialBroadcasts:0,productionOnionQualified:false}));}};
}

export async function exerciseNativePublicCourier({t,network}){const{exerciseNativeRecipientHTTP}=await import('./native-recipient-http-e2e-stage.mjs');await exerciseNativeRecipientHTTP({t,network,publicCourier:true});}

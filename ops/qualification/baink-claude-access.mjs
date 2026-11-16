#!/usr/bin/env node
/** Read-only Claude consumer qualification. Reuses the installed broker's signed
 * heartbeat and its own model qualification; never reads auth or invokes a model.
 * Supply the broker PUBLIC key from independently verified release pins, never
 * from the health response being checked. */
import {pathToFileURL} from 'node:url';
import {createPublicServiceHealth} from '../../apps/baink/review-broker/public-service-health.mjs';
export const PINS=Object.freeze({chainId:'uain-shadow-20261008-1',genesisSha256:'54140a9243c4591ccc9f2e9d49543fc68b87b3e0045416174c232e9dd498f8ff',reviewer:'uain17fae025e2b7492156d438712aab8efcb4113b0fd',relay:'uain1215c651b70db82b70532a496c26fdf424f3bb369'});
const ENDPOINT='https://baink.money/api/native/review';
export async function qualifyClaudeAccess({publicKey,fetcher=fetch,clock=Date.now}={}){
 if(typeof publicKey!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(publicKey)||Buffer.from(publicKey,'base64url').length!==32)throw Error('Independent broker public trust pin required');
 const health=await createPublicServiceHealth({endpoint:ENDPOINT,publicKey,pins:PINS,reviewer:PINS.reviewer,relay:PINS.relay,fetcher,clock})();
 return{schema:'baink-claude-consumer-qualification-v1',checkedAt:new Date(clock()).toISOString(),providerCallsMade:0,evidence:{kind:'existing-broker-signed-heartbeat',endpoint:ENDPOINT+'/health',brokerPublicKey:publicKey,chainId:PINS.chainId,...(health.checkedAt?{brokerCheckedAt:health.checkedAt}:{})},limitations:['Heartbeat qualifies the existing broker only; it does not prove fresh API billing, arbitrary Claude access, earnings, scientific acceptance or worker deployment.','Other consumers below are source scope references, not live runtime inventory.'],consumers:[{consumer:'private-payment-review',claudeAccess:health.configured?'qualified':'not-qualified',model:'claude-sonnet-5-5',basis:'existing signed broker capability and public availability',source:'apps/baink/holder/service-broker.mjs'},...[
 ['central-task-review','services/central-reviewer/src/provider-fence.py'],
 ['ceo-project-manager','services/project-organizations/ops/manager-stage.mjs'],
 ['fund-manager','services/fund-manager/src/planner.mjs'],
 ['house-solver-refuter','ops/agents/house-fleet.mjs'],
 ].map(([consumer,source])=>({consumer,claudeAccess:'not-qualified',basis:'outside broker heartbeat scope; independent execution evidence required',source}))]};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const args=process.argv.slice(2);
 if(args.length!==2||args[0]!=='--broker-public-key'){console.error('Usage: node ops/qualification/baink-claude-access.mjs --broker-public-key PUBLIC_KEY_FROM_VERIFIED_RELEASE');process.exitCode=2;}
 else try{const report=await qualifyClaudeAccess({publicKey:args[1]});console.log(JSON.stringify(report,null,2));if(report.consumers[0].claudeAccess!=='qualified')process.exitCode=1;}catch{console.error('Claude consumer qualification refused');process.exitCode=2;}
}

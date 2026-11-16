#!/usr/bin/env node
/** Runs only inside the dispatcher sandbox. API mode retains its nested cap;
 * subscription mode verifies owning-runtime authentication before model work.
 * A nested API ledger never substitutes for the Mac's shared admission journal. */
import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';
import {runClaudeStructured} from './claude-house-solver.mjs';import {validateRequest,privateDirectory} from './house-remote-solver.mjs';
import {parseSolverOutput,parseRefutation} from './house-fleet.mjs';
const EXECUTABLE='/var/lib/uain-house-solver/claude';
const PIN='b73676430af12f97316a798b8371f81d640f90a58bdcb8f3ce56a835bb47df56';
export async function executeRemote(request,{runStructured=runClaudeStructured,ensurePrivateDirectory=privateDirectory}={}){
 const r=validateRequest(request);await ensurePrivateDirectory('/var/lib/uain-house-solver/home');
 const outputSchema={type:'object',additionalProperties:false,required:r.role==='solver'?['verdict','evidence','selfCheck']:['verdict','reasons'],properties:r.role==='solver'?{verdict:{type:'string',enum:['FINDING','NO_FINDING']},evidence:{type:'string'},selfCheck:{type:'string'}}:{verdict:{type:'string',enum:['UPHELD','REFUTED']},reasons:{type:'string'}}};
 const result=await runStructured({executable:EXECUTABLE,sha256:PIN,role:r.role,prompt:r.prompt,projectId:r.projectId,budgetDirectory:'/var/lib/uain-house-solver/nested-compute',tools:'WebSearch,WebFetch',purpose:'remote-'+r.role,outputSchema,validateOutput:v=>(r.role==='solver'?parseSolverOutput:parseRefutation)(JSON.stringify(v)),timeoutMs:1200000,usageSource:r.usageSource??'api'});
 return {schema:'uain-house-remote-result-v1',executionId:r.executionId,role:r.role,projectId:r.projectId,promptDigest:r.promptDigest,value:result.value,costUsd:result.metadata.costUsd,nativeRawDigest:result.metadata.nativeRawDigest,usageSource:result.metadata.usageSource,costBasis:result.metadata.costBasis,...(result.metadata.authentication?{authentication:result.metadata.authentication}:{})};
}
async function main(){if(process.argv.length!==2)throw Error('runtime arguments refused');let n=0;const chunks=[];for await(const b of process.stdin){n+=b.length;if(n>262144)throw Error('request over limit');chunks.push(b);}return executeRemote(JSON.parse(Buffer.concat(chunks).toString('utf8')));}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){try{process.stdout.write(JSON.stringify(await main())+'\n');}catch{process.stderr.write('Remote solver refused or uncertain; preserve reservation.\n');process.exitCode=1;}}

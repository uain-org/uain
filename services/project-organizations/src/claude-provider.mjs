/** Optional Claude engine for proposal roles. Not installed or selected by default.
 * No custody or signing capability. Owning runtime supplies protected executable
 * pins, inherited authentication, OS isolation and a local shared budget journal. */
import {runClaudeStructured} from '../../../ops/agents/claude-house-solver.mjs';
import {plain,need,text,sha256} from './common.mjs';
import {mkdir,lstat,realpath,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute,resolve,join} from 'node:path';
const MODEL='claude-sonnet-5-5';
const str={type:'string'},bool={type:'boolean'};
const object=(properties,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
const array=(items,maxItems)=>({type:'array',items,maxItems});
const rationale=object({effort:str,difficulty:str,novelty:str,verificationCost:str});
const price=object({solver_amount:str,reviewer_amount:str,rationale});
const task=object({title:str,criteria:str,eligibility:{type:'string',enum:['hard','new','unresolved']},eligibility_basis:str,proposed_price:price,candidate_id:{type:['string','null']}},['title','criteria','eligibility','eligibility_basis','proposed_price']);
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
export const CLAUDE_ROLE_SCHEMAS=freeze({
 ceo:object({main_kpi:str,strategy:str,blockers:array(str,32)}),
 manager:object({main_kpi:str,round:{type:'integer',minimum:1,maximum:5},tasks:array(task,8)}),
 assessor:object({openSolutionFound:bool,knownAnswer:bool,rationale:str}),
});
function validates(value,schema){
 if(schema.type==='object')return plain(value)&&schema.required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>Object.hasOwn(schema.properties,k)&&validates(value[k],schema.properties[k]));
 if(schema.type==='array')return Array.isArray(value)&&value.length<=schema.maxItems&&value.every(v=>validates(v,schema.items));
 if(Array.isArray(schema.type))return value===null||typeof value==='string';
 if(schema.type==='integer')return Number.isSafeInteger(value)&&value>=schema.minimum&&value<=schema.maximum;
 return typeof value===schema.type&&(!schema.enum||schema.enum.includes(value));
}
async function claimExecution(directory,request){
 need(typeof directory==='string'&&isAbsolute(directory)&&resolve(directory)===directory,'invalid_claude_claim_directory');
 await mkdir(directory,{recursive:true,mode:0o700});
 for(const path of [directory,join(directory,'claude-executions')]){
  if(path!==directory)await mkdir(path,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  const info=await lstat(path);
  need(info.isDirectory()&&!info.isSymbolicLink()&&info.uid===process.getuid()&&!(info.mode&0o077)&&await realpath(path)===path,'invalid_claude_claim_directory');
 }
 const path=join(directory,'claude-executions',sha256(request.executionId)+'.json');
 let file;
 try{file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}
 catch(error){if(error.code==='EEXIST')need(false,'claude_execution_already_claimed');throw error;}
 try{await file.writeFile(JSON.stringify({schema:'uain-claude-execution-claim-v1',...request})+'\n');await file.sync();}
 finally{await file.close();}
 const parent=await open(join(directory,'claude-executions'),constants.O_RDONLY);
 try{await parent.sync();}finally{await parent.close();}
}
export function createClaudeProvider({executable,sha256:executableSha256,budgetDirectory,env,timeoutMs=300000,now=()=>new Date(),fixture=false,usageSource='api'}){
 need(['api','subscription'].includes(usageSource),'invalid_claude_usage_source');
 const used=new Set();
 return Object.freeze({model:MODEL,fixture:fixture===true,
  async execute({role,projectId,executionId,prompt}){
   need(Object.hasOwn(CLAUDE_ROLE_SCHEMAS,role)&&text(executionId,1,96)&&!used.has(executionId),'invalid_claude_execution');
   need(text(projectId,1,96)&&typeof prompt==='string'&&Buffer.byteLength(prompt)<=65536,'invalid_claude_input');
   await claimExecution(budgetDirectory,{executionId,role,projectId,promptDigest:sha256(prompt),model:MODEL,executableSha256,usageSource});
   used.add(executionId); // durable claim survives success, uncertainty and provider recreation
   const startedAt=now().toISOString();
   const result=await runClaudeStructured({executable,sha256:executableSha256,budgetDirectory,env,timeoutMs,projectId,prompt,usageSource,
    tools:'',purpose:'core-'+role,outputSchema:CLAUDE_ROLE_SCHEMAS[role],validateOutput:value=>{
     need(validates(value,CLAUDE_ROLE_SCHEMAS[role]),'invalid_claude_role_output');return value;
    }});
   const finishedAt=now().toISOString();
   const raw=JSON.stringify({schema:'uain-provider-answer-v1',provider:'claude',role,executionId,model:MODEL,answer:result.value});
   return {raw,receipt:{executionId,model:MODEL,startedAt,finishedAt,actual:fixture!==true,
    provider:'claude',format:'uain-provider-answer-v1',role,...result.metadata,normalizedAnswerDigest:sha256(raw)}};
  },
 });
}

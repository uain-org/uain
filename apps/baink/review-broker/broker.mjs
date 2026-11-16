/** Installed local broker entrypoint. Never prints invoices, keys or model text. */
import{homedir}from'node:os';import{constants}from'node:fs';import{join}from'node:path';import{mkdir,open,unlink,lstat,rename}from'node:fs/promises';
import{createServiceBroker,createRootServiceClient,createClaudeDecisionRunner,loadBrokerSigner,brokerProviderConfig}from'./service-broker.mjs';
import{createPublicBrokerBridge}from'./public-broker-bridge.mjs';
import{readCourierJSON,writeCourierJSON}from'./courier-executor.mjs';
const base=join(homedir(),'.local/share/uain/holder'),privateRoot=join(base,'review-broker'),wallet=join(base,'state/wallet'),healthFile=join(wallet,'service-broker-health.json');
const mode=process.argv[2];if(!['--once','--run'].includes(mode))throw Error('Choose --once or --run');
const cfg=await readCourierJSON(join(privateRoot,'config.json'),8192),providerConfig=brokerProviderConfig(cfg);
await mkdir(join(privateRoot,'journal'),{mode:0o700,recursive:true});await mkdir(join(privateRoot,'isolated'),{mode:0o700,recursive:true});
const signer=await loadBrokerSigner(join(privateRoot,'attestation.pk8'));if(signer.publicKey!==cfg.publicKey)throw Error('Broker public identity changed');
const lock=join(privateRoot,'runtime.lock');let locked=false;
for(let attempt=0;attempt<2&&!locked;attempt++){try{const fd=await open(lock,'wx',0o600);try{await fd.writeFile(JSON.stringify({pid:process.pid}));await fd.sync();}finally{await fd.close();}locked=true;}catch(error){if(error.code!=='EEXIST')throw error;const old=await readCourierJSON(lock,512);if(!Number.isInteger(old.pid)||old.pid<1)throw Error('Broker lock refused');try{process.kill(old.pid,0);throw Error('Broker is already running');}catch(e){if(e.code!=='ESRCH')throw e;}await unlink(lock);}}
if(!locked)throw Error('Broker lock unavailable');let stopping=false,providerHealthy=true,lastHealth=0,lastState=null,lastPublicSignature=null;
process.once('SIGTERM',()=>stopping=true);process.once('SIGINT',()=>stopping=true);
const rootAction=createRootServiceClient(),runModel=createClaudeDecisionRunner({...providerConfig,cwd:join(privateRoot,'isolated')});
const broker=createServiceBroker({exchangeRoot:join(wallet,'exchange'),journalDirectory:join(privateRoot,'journal'),signer,rootAction,providerId:runModel.providerId,usageSource:providerConfig.usageSource,decide:async request=>{try{const result=await runModel(request);providerHealthy=true;return result;}catch(error){providerHealthy=false;throw error;}}});
let publicBridge=null;
if(cfg.publicGateway){
 if(Object.keys(cfg.publicGateway).sort().join()!=='origin,workerKeyFile'||cfg.publicGateway.origin!=='https://baink.money'||cfg.publicGateway.workerKeyFile!==join(privateRoot,'public-worker.key'))throw Error('Public worker configuration refused');
 const f=await open(cfg.publicGateway.workerKeyFile,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let bytes;try{const st=await f.stat();if(!st.isFile()||st.uid!==process.getuid()||st.nlink!==1||st.mode&0o077||st.size!==32)throw Error('Public worker credential refused');bytes=await f.readFile();publicBridge=createPublicBrokerBridge({origin:cfg.publicGateway.origin,secret:bytes,directory:join(privateRoot,'journal'),broker,readHealth:()=>readCourierJSON(healthFile,8192)});}finally{bytes?.fill(0);await f.close();}
}
async function health(){let qualified=false;try{const q=await broker.qualifyProvider({force:!providerHealthy});qualified=q.validUntil>Date.now();}catch{providerHealthy=false;}let ready=false;try{const r=await rootAction('health','0'.repeat(32));ready=r.status==='ready'&&r.chainId==='uain-shadow-20261008-1'&&r.genesisSha256==='54140a9243c4591ccc9f2e9d49543fc68b87b3e0045416174c232e9dd498f8ff';}catch{}
 let budgetReady=false;try{budgetReady=await broker.budgetReady();}catch{}
 const payload={schema:'baink-private-service-health-v1',chainId:'uain-shadow-20261008-1',genesisSha256:'54140a9243c4591ccc9f2e9d49543fc68b87b3e0045416174c232e9dd498f8ff',reviewer:'uain17fae025e2b7492156d438712aab8efcb4113b0fd',relay:'uain1215c651b70db82b70532a496c26fdf424f3bb369',checkedAt:new Date().toISOString(),rootReady:ready,modelQualified:providerHealthy&&qualified&&budgetReady};
 const temp=healthFile+'.new';try{await unlink(temp);}catch(e){if(e.code!=='ENOENT')throw e;}await writeCourierJSON(temp,{payload,signature:signer.signHealth(payload)});await rename(temp,healthFile);lastHealth=Date.now();return{rootReady:ready,modelQualified:payload.modelQualified};}
try{do{if(Date.now()-lastHealth>60000)lastState=await health();const jobs=await broker.tick();let publicReview=null;try{publicReview=publicBridge?await publicBridge.tick():null;}catch{publicReview={status:'needs-review-or-recovery'};}const publicState={service:'private-review-broker',state:lastState,publicReview,jobs:jobs.map(j=>({directoryId:j.directoryId,status:j.status})),moneyMoved:false},signature=JSON.stringify(publicState);if(mode==='--once'||signature!==lastPublicSignature){console.log(signature);lastPublicSignature=signature;}if(mode==='--once')break;await new Promise(r=>setTimeout(r,2000));}while(!stopping);}finally{await unlink(lock);}

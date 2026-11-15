/** Fixed Linux service entrypoint. Never signs directly or accepts configuration via CLI/env. */
import{fileURLToPath}from'node:url';import{dirname}from'node:path';
import{loadConfig,trustedPath}from'./config.mjs';import{createLocalNativeSource}from'./native-source.mjs';import{createCliProvider}from'./cli-provider.mjs';import{createCustodyClient}from'./custody-client.mjs';import{openWorker}from'./worker.mjs';import{runLoop,openCursorStore}from'./runtime.mjs';
if(process.argv.length!==2||process.getuid()===0)throw Error('fixed nonroot service invocation required');
const config=await loadConfig();
// The complete release and executable parents must be owned by the operator.
await trustedPath(dirname(fileURLToPath(import.meta.url)),{directory:true});for(const path of [config.native.binary,config.native.genesis,config.fenceScript])await trustedPath(path);
const source=createLocalNativeSource({config:config.native,reviewer:config.reviewer}),abort=new AbortController();
const provider=createCliProvider({fenceScript:config.fenceScript,cwd:config.directory}),custody=createCustodyClient({socketPath:config.custodySocket});
const worker=await openWorker({directory:config.directory,reviewer:config.reviewer,source,provider,custody,timeoutMs:config.timeoutMs,hourlyAttempts:config.hourlyAttempts,dailyAttempts:config.dailyAttempts});
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>abort.abort());
const cursor=await openCursorStore(config.directory);
try{await runLoop({source,worker,cursor,intervalMs:config.intervalMs,signal:abort.signal,onItemError:event=>process.stderr.write(JSON.stringify({schema:'uain-central-review-item-error-v1',time:new Date().toISOString(),...event})+'\n'),onUnavailable:event=>process.stderr.write(JSON.stringify({schema:'uain-central-review-dependency-unavailable-v1',time:new Date().toISOString(),...event})+'\n'),onCycle:results=>process.stdout.write(JSON.stringify({schema:'uain-central-review-cycle-v1',time:new Date().toISOString(),jobs:results.map(j=>({submission:j.submission,state:j.state,phase:j.phase??null}))})+'\n')});}finally{await worker.close();await source.close();}

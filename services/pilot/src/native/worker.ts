import {ready,close,pool} from '../storage/store.ts';
import {nativeConfig} from '../api/native-routes.ts';
import {syncNativeProjection,projectNativeDocumentOne} from './projection.ts';
import {syncNativeJournals} from './journals.ts';
import {indexNativeResearchOne,nativeResearchStatus} from './research.ts';
if(process.env.UAIN_NATIVE_PROJECTION==='1'){
 await ready();try{
  const config=nativeConfig();if(!config)throw Error('native projection pins required');const deadline=Date.now()+240000;
  for(let i=0;i<128&&Date.now()<deadline;i++){const result=await syncNativeProjection(pool,config,32);if(!result.more)break}
  for(let i=0;i<128&&Date.now()<deadline;i++){const result=await syncNativeJournals(pool,config,32);if(!result.more)break}
  for(let i=0;i<128&&Date.now()<deadline&&await projectNativeDocumentOne(pool,config);i++){}
  if(process.env.UAIN_RESEARCH_SEARCH==='1')for(let i=0;i<128&&Date.now()<deadline&&await indexNativeResearchOne(pool,config);i++){}
  console.log(JSON.stringify(await nativeResearchStatus(pool,config)));
 }finally{await close()}
}

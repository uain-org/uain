import {ready,close,pool} from '../storage/store.ts';
import {nativeConfig} from '../api/native-routes.ts';
import {restorePublicationReplicas} from './restore-publications.ts';
if(process.env.UAIN_NATIVE_PROJECTION!=='1')throw Error('native projection must be explicitly configured for publication recovery');
await ready();try{
 const config=nativeConfig();if(!config)throw Error('native proof pins required');
 console.log(JSON.stringify(await restorePublicationReplicas(pool,config)));
}finally{await close()}

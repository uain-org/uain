import {nativeConfig,nativeState} from './native-routes.ts';
import {checkedNativeWalletBinding} from '../native/public-read.ts';
export async function handleNativeWalletPublicRoutes(req:any,res:any,url:URL,send:any,audit:any,env=process.env){
 if(!url.pathname.startsWith('/api/native/wallets/'))return false;
 if(req.method!=='GET'){send(res,405,{error:'method_not_allowed'});return true}
 const id=url.pathname.slice('/api/native/wallets/'.length);if(!/^\d{20}$/.test(id)||url.search){send(res,400,{error:'invalid_native_wallet_binding'});return true}
 try{
  const config=nativeConfig(env);if(!config){send(res,503,{error:'native_authority_not_configured'});return true}
  const immutable='external_wallet_binding/'+id,first=await nativeState({keys:[immutable]},config),binding=first.records[immutable];if(!binding){send(res,404,{error:'native_wallet_binding_not_found'});return true}
  if(binding.binding!==id||!/^uain1[0-9a-f]{40}$/.test(binding.member)||!['ethereum','solana'].includes(binding.network))throw Error('native wallet binding identity differs');
  const current='external_wallet/'+binding.member+'/'+binding.network,end='external_wallet_end/'+id,owner='external_wallet_owner/'+binding.network+'/'+binding.address,proof=await nativeState({keys:[immutable,current,end,owner]},config);
  if(first.chain_id!==proof.chain_id||JSON.stringify(proof.records[immutable])!==JSON.stringify(binding))throw Error('native wallet epoch/binding differs');
  if(proof.records[end]||proof.records[current]?.binding!==id){send(res,409,{authority:'native',error:'native_wallet_binding_not_active',binding:id,proof});return true}
  const wallet=checkedNativeWalletBinding(proof.records[current],binding.member,binding.network,proof.records);if(!wallet)throw Error('native active wallet proof absent');
  res.setHeader('x-uain-authority','native');res.setHeader('cache-control','no-store');audit(200,'native wallet proof');
  send(res,200,{authority:'native',epoch:config.genesisHash,state_height:proof.height,id,binding:id,member:binding.member,chain:binding.network,address:binding.address,signature:binding.signature,bound_at:null,bound_height:binding.height,in_force:true,message:`UAIN external wallet binding v1\nchain_id: ${proof.chain_id}\nmember: ${binding.member}\nsequence: ${binding.sequence}\nnetwork: ${binding.network}\naddress: ${binding.address}\nexpires_height: ${binding.expires_height}\n`,proof});
 }catch{audit(503,'native wallet proof refused');send(res,503,{error:'native_wallet_proof_unavailable'})}return true;
}

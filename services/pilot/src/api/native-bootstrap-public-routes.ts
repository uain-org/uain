// The downloadable native verifier and genesis were retired on 9 November 2026
// (Rahul: no-install only). Members use the one-file uain-agent kit, which reads
// proved state through BAINK; nothing is downloaded. Old clients get an explicit
// 410 that names the replacement instead of a silent 404.
export const NATIVE_BOOTSTRAP_RETIRED=Object.freeze({
 error:'native_bootstrap_retired',
 message:'The downloadable verifier was retired. Use the one-file uain-agent kit (Node 22, nothing else to install).',
 kit:'https://baink.money/uain-agent.mjs',guide:'https://uain.global/native-guide.md',retired:'2026-11-09',
});
export function createNativeBootstrapPublicHandler({env=process.env}:any={}){
 return async(req:any,res:any,url:URL,send:any)=>{
  if(!url.pathname.startsWith('/api/native/bootstrap')||env.UAIN_AUTHORITY!=='native')return false;
  res.setHeader('cache-control','no-store');
  send(res,410,NATIVE_BOOTSTRAP_RETIRED);return true;
 };
}
export const handleNativeBootstrapPublicRoutes=createNativeBootstrapPublicHandler();

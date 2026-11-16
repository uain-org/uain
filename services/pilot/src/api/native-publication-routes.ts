import {pool} from '../storage/store.ts';
import {nativeConfig} from './native-routes.ts';
import {publishNativeEvidence} from '../native/projection.ts';
import {nativeAuthorityStatus} from '../native/research.ts';
import {archivedResearchDocument,archivedNativeEpochs} from '../native/archive.ts';
/** `gate`, when given, is asked before a publication starts its proofs; it sends the refusal itself and answers false. */
export async function handleNativePublications(req:any,res:any,url:URL,send:any,audit:any,readBody:any,gate?:(body:any,audit?:any)=>Promise<boolean>){
 if(!['/api/native/evidence','/api/native/authority','/api/native/archive/epochs'].includes(url.pathname)&&!url.pathname.startsWith('/api/native/research/'))return false;
 try{
  const config=nativeConfig();if(!config||process.env.UAIN_NATIVE_PROJECTION!=='1'){send(res,503,{error:'native_projection_not_configured'});return true}
  if(url.pathname==='/api/native/archive/epochs'&&req.method==='GET'){
   const limit=Number(url.searchParams.get('limit')??20),after=url.searchParams.get('after')??'';
   if(!Number.isInteger(limit)||limit<1||limit>100||(after!==''&&!/^[a-f0-9]{64}$/.test(after))){send(res,400,{error:'invalid_native_archive_page'});return true}
   res.setHeader('x-uain-authority','native-archive');send(res,200,await archivedNativeEpochs(pool,after,limit));return true;
  }
  if(url.pathname==='/api/native/authority'&&req.method==='GET'){send(res,200,await nativeAuthorityStatus(pool,config));return true}
  if(url.pathname==='/api/native/evidence'&&req.method==='POST'){const body=await readBody(req,res,audit);if(!body)return true;if(gate&&!await gate(body,audit))return true;send(res,200,await publishNativeEvidence(pool,config,body));return true}
  if(url.pathname.startsWith('/api/native/research/')&&req.method==='GET'){
   const id=decodeURIComponent(url.pathname.slice('/api/native/research/'.length));if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(id))throw Error('invalid native research ID');
   if(url.searchParams.has('epoch')){const selected=url.searchParams.get('epoch')!;if(!/^[a-f0-9]{64}$/.test(selected)){send(res,400,{error:'invalid_native_archive_epoch'});return true}if(selected!==config.genesisHash){res.setHeader('x-uain-authority','native-archive');const result=await archivedResearchDocument(pool,config.genesis,selected,id);send(res,result.status,result.body);return true}}
   const row=(await pool.query('SELECT * FROM native_research_documents WHERE epoch=$1 AND id=$2',[config.genesisHash,id])).rows[0];
   send(res,row?200:404,row?{authority:'native',...row}:{error:'native_research_not_projected'});return true;
  }send(res,405,{error:'method_not_allowed'});return true;
 }catch{audit(503,'native publication/projection refused');send(res,503,{error:'native_publication_or_projection_unavailable'});return true}
}

// Activated native authority cannot execute a stale pilot mutation. Historical
// event/ledger URLs retain their original records and explicitly identify them.
export async function handleNativeAuthorityRoutes(req:any,res:any,url:URL,send:any){
 if(process.env.UAIN_AUTHORITY!=='native')return false;
 res.setHeader('x-uain-authority','native');
 if(req.method==='GET'&&(/^\/api\/(ledger|events)(\/|$)/.test(url.pathname))){res.setHeader('x-uain-authority','legacy-archive');return false}
 if(req.method==='GET'&&/^\/api\/contribution\/uain1[a-f0-9]{40}$/.test(url.pathname))return false;
 if(req.method==='GET'&&['/api/health','/api/ready','/api/build','/api/status','/api/research/search','/api/research/status'].includes(url.pathname))return false;
 if(req.method==='GET'&&url.pathname==='/api/descriptor'){
  send(res,200,{
   authority:'native',permissioned:true,independent_operator_count:1,private_keys:'member-held',
   mcp:'/mcp',state:'/api/native/state',command:'/api/native/command',receipt:'/api/native/receipt',evidence:'/api/native/evidence',research:'/api/research/search',readiness:'/api/native/authority',legacy_ledger:'/api/ledger/head',
   methods:{state:'POST',command:'POST',receipt:'POST',evidence:'POST',research:'GET',readiness:'GET'},
   discovery:{tasks:'/api/tasks?discover=1&status=open',projects:'/api/projects',directory:'/api/directory',contributions:'/api/contributions',membership_required:false},
   onboarding:{
    guide:'/native-guide.md',kit:'https://baink.money/uain-agent.mjs',kit_requires:'Node 22 or later; nothing else to install (no Docker, no client or verifier download)',
    enrolment_operation:'enrol',enrolment_licence:'pending',manual_approval_required:false,activation_wait:'uain-agent enrol (resumes; never enrols twice)',activation:'automatic objective enrolment screening and guardian-signed licence activation',
    legacy_sessions_supported:false,accepted_is_finalized:false,
    bootstrap:{status:'retired',retired:'2026-11-09',replacement:'uain-agent kit'},
    steps:['read public tasks and obtain operator approval','get the uain-agent kit and run init (the member key stays on this machine)','run enrol; the licence starts pending and activates automatically','find a task, join, submit; review and AI$ follow on the ledger','pay, get paid (receiving setup) and trade with the same kit'],
   },
  });return true;
 }
 send(res,409,{error:'native_route_required',authority:'native',message:'This pilot operation is unavailable under native authority. Use a locally signed native command and verify its finalized receipt.',descriptor:'/api/descriptor'});return true;
}

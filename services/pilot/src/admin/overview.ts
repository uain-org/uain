import {renderManagementPanel} from './management-panel.ts';
import {readManagementOverview} from './management-source.ts';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pool } from '../storage/store.ts';
import { statsSnapshot } from '../application/db.ts';
import { AdminAuthError, authorizeAdminRead, type AdminActor } from './auth.ts';
const bound = async (actor: AdminActor) => (await pool.query("SELECT 1 FROM portal_admin_grants WHERE actor_issuer=$1 AND actor_subject=$2 AND capability='overview:read' AND revoked_at IS NULL",[actor.issuer,actor.subject])).rowCount === 1;
export async function handleAdminOverview(req: IncomingMessage, res: ServerResponse, url: URL, send: (res: ServerResponse,status:number,body:unknown)=>unknown): Promise<boolean> {
  if (!url.pathname.startsWith('/api/admin/v1/')) return false;
  res.setHeader('Cache-Control','private, no-store');
  if (req.method!=='GET' || !['/api/admin/v1/overview','/api/admin/v1/capabilities','/api/admin/v1/management','/api/admin/v1/management/view'].includes(url.pathname)) { send(res,404,{error:'not_found'}); return true; }
  try {
    const token = /^Bearer ([^\s]{1,8192})$/.exec(req.headers.authorization || '')?.[1] || '';
    const {actor} = await authorizeAdminRead(token,bound);
    if (url.pathname==='/api/admin/v1/management'||url.pathname==='/api/admin/v1/management/view') {
      if(url.search) {send(res,400,{error:'invalid_management_query'});return true;}
      const data=await readManagementOverview();
      if(!await bound(actor))throw new AdminAuthError(403);
      await pool.query("INSERT INTO portal_admin_audit(actor_issuer,actor_subject,action) VALUES($1,$2,'management.read')",[actor.issuer,actor.subject]);
      await authorizeAdminRead(token,bound);
      if(url.pathname.endsWith('/view')){
        res.statusCode=200;res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.end(renderManagementPanel(data));
      }else send(res,200,{schemaVersion:1,product:'uain',...data});
      return true;
    }
    if (url.pathname.endsWith('/capabilities')) { send(res,200,{schemaVersion:1,product:'uain',capabilities:['overview:read']}); return true; }
    const {value:snapshot,observedAt} = await statsSnapshot();
    const metrics=[{id:'projects',label:'Projects',value:snapshot.projects,unit:'projects'},{id:'participants',label:'Participants',value:snapshot.participants,unit:'participants'},{id:'settled',label:'Settled contributions',value:snapshot.settled,unit:'contributions'}];
    if (!await bound(actor)) throw new AdminAuthError(403);
    await pool.query("INSERT INTO portal_admin_audit(actor_issuer,actor_subject,action) VALUES($1,$2,'overview.read')",[actor.issuer,actor.subject]);
    await authorizeAdminRead(token,bound);
    const at=new Date().toISOString();
    send(res,200,{schemaVersion:1,product:'uain',sourceRevision:createHash('sha256').update(JSON.stringify(metrics)).digest('hex'),observedAt,fetchedAt:at,state:'connected',metrics,capabilities:['overview:read']});
  } catch(error) { send(res,error instanceof AdminAuthError ? error.status : 503,{error:'admin_access_unavailable'}); }
  return true;
}

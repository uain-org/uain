import { decodeJwt, importSPKI, jwtVerify } from 'jose';
export class AdminAuthError extends Error { constructor(public status: number) { super('Administrative access denied'); } }
export type AdminActor = { issuer: string; subject: string };
export async function authorizeAdminRead(token: string, localBinding: (actor: AdminActor) => Promise<boolean>, env: Record<string,string|undefined> = process.env, now = new Date()) {
  let keys: Record<string,string>;
  try { keys = JSON.parse(env.ADMIN_DELEGATION_KEYS || '{}'); if (!Object.keys(keys).length || Object.keys(keys).length > 8) throw new Error(); }
  catch { throw new AdminAuthError(503); }
  let claims;
  try {
    const untrusted = decodeJwt(token), issuer = untrusted.iss;
    if (!issuer || typeof keys[issuer] !== 'string') throw new Error();
    const key = await importSPKI(keys[issuer], 'EdDSA');
    const { payload } = await jwtVerify(token,key,{ issuer, audience:env.ADMIN_DELEGATION_AUDIENCE || 'uain-admin', algorithms:['EdDSA'],typ:'admin-delegation+jwt',currentDate:now,maxTokenAge:90,clockTolerance:0,requiredClaims:['sub','iat','exp'] });
    const actor = payload.actor as AdminActor | undefined;
    if (payload.product !== 'uain' || payload.capability !== 'overview:read' || !Number.isInteger(payload.grantVersion) || Number(payload.grantVersion) < 1 || !actor || typeof actor.issuer !== 'string' || typeof actor.subject !== 'string' || !actor.subject || actor.subject.length>255 || actor.subject!==payload.sub || typeof payload.iat !== 'number' || typeof payload.exp !== 'number' || payload.exp-payload.iat>90 || payload.iat>Math.floor(now.getTime()/1000)) throw new Error();
    new URL(actor.issuer);
    claims={ actor, product:'uain', capability:'overview:read' };
  } catch { throw new AdminAuthError(401); }
  if (!await localBinding(claims.actor)) throw new AdminAuthError(403);
  return claims;
}

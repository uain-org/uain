/** Anonymous aggregate campaign traffic, separate from identity and ledger. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pool } from '../storage/store.ts';
import { AdminAuthError, authorizeAdminRead } from '../admin/auth.ts';

export const validCampaignRef = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{12,80}$/.test(value);

/** Anonymous on-page steps and one-click exit-poll answers, counted per day like landings. */
export const FUNNEL_STAGES = new Set([
  'view_for_ai', 'view_try', 'reached_faq', 'click_try', 'click_projects', 'click_example',
  'click_guide', 'click_quickstart', 'click_research_bench',
  'poll_unclear', 'poll_cost', 'poll_safety', 'poll_setup', 'poll_not_relevant', 'poll_browsing',
]);
const ATTRIBUTION_STAGES = ['landing', 'instructions_requested'];

/**
 * P2-2 (13 November 2026): any 12-80 character ref used to make a row of its
 * own, so an anonymous script could grow the table without bound. A day takes
 * at most this many distinct refs; a ref first seen after that is counted
 * under OVERFLOW_REF. A ref already counted that day keeps its own row.
 * Concurrent first sightings can pass the cap by a few rows; that is fine.
 */
export const CAMPAIGN_REFS_PER_DAY = 200;
export const OVERFLOW_REF = 'overflow-refs';
/** At most this many traffic rows, and as many waitlist rows, per export. */
const EXPORT_ROWS = 10000;

export async function countCampaign(ref: string, stage: string, test = false) {
  await pool.query(`INSERT INTO campaign_daily(day,ref,stage,is_test,count)
    SELECT $1, CASE WHEN EXISTS (SELECT 1 FROM campaign_daily WHERE day=$1 AND ref=$2)
      OR (SELECT count(DISTINCT ref) FROM campaign_daily WHERE day=$1) < $5 THEN $2 ELSE $6 END,
      $3,$4,1
    ON CONFLICT(day,ref,stage,is_test)
    DO UPDATE SET count=campaign_daily.count+1`,
  [new Date().toISOString().slice(0,10),ref,stage,test,CAMPAIGN_REFS_PER_DAY,OVERFLOW_REF]);
}

export async function campaignCounts(since: string) {
  // The most recent rows when there are more than the export carries; the
  // answer says `truncated` instead of failing (P2-2, 13 November 2026).
  const traffic = await pool.query(`SELECT day,ref,stage,is_test,count FROM (
    SELECT day,ref,stage,is_test,count FROM campaign_daily WHERE day >= $1
    ORDER BY day DESC,count DESC,ref,stage,is_test LIMIT $2) AS recent
    ORDER BY day,ref,stage,is_test`,[since,EXPORT_ROWS+1]);
  const trafficTruncated = traffic.rows.length > EXPORT_ROWS;
  if (trafficTruncated) traffic.rows.shift(); // ordered by day, so this is from the oldest day
  // Funnel rows are reported separately so older readers of `rows` keep their stage set.
  const rows = traffic.rows.filter(r => ATTRIBUTION_STAGES.includes(r.stage));
  const funnel_rows = traffic.rows.filter(r => FUNNEL_STAGES.has(r.stage));
  const waitlist = await pool.query(`SELECT left(registered_at,10) AS day,
    substring(referrer from 10) AS ref, 'waitlist' AS stage, false AS is_test, count(*)::int AS count
    FROM waitlist WHERE referrer ~ '^campaign:[A-Za-z0-9_-]{12,80}$' AND registered_at >= $1
    GROUP BY left(registered_at,10),referrer ORDER BY day DESC,ref LIMIT $2`,[since,EXPORT_ROWS+1]);
  const waitlistTruncated = waitlist.rows.length > EXPORT_ROWS;
  const order = (x: {day:string;ref:string}, y: {day:string;ref:string}) => x.day < y.day ? -1 : x.day > y.day ? 1 : x.ref < y.ref ? -1 : x.ref > y.ref ? 1 : 0;
  const waitlistRows = waitlist.rows.slice(0,EXPORT_ROWS).sort(order);
  return { schema_version:1, observed_at:new Date().toISOString(), since,
    rows:[...rows,...waitlistRows], funnel_rows,
    ...(trafficTruncated || waitlistTruncated ? { truncated:true } : {}),
    semantics:'Aggregate requests, not unique people. Instructions requested is not proof of download. Waitlist is not enrolment. Funnel rows count page steps and exit-poll answers once per stage, tab and day; ref organic-visitor means no campaign ref.',
    unsupported_stages:['bootstrap','enrolment','first_submission'] };
}

export async function handleCampaign(req: IncomingMessage,res: ServerResponse,url: URL,
  send: (res: ServerResponse,status:number,body:unknown)=>unknown,
  readBody: (req: IncomingMessage,res: ServerResponse,audit:(status:number,detail?:string)=>unknown)=>Promise<Record<string,unknown>|null>) {
  if (!url.pathname.startsWith('/api/campaign/')) return false;
  res.setHeader('Cache-Control','no-store');
  const audit = () => undefined;
  if (req.method==='GET' && url.pathname==='/api/campaign/attribution') {
    try {
      const token=/^Bearer ([^\s]{1,8192})$/.exec(req.headers.authorization || '')?.[1] || '';
      const bound=async (actor: {issuer:string;subject:string}) =>
        (await pool.query("SELECT 1 FROM portal_admin_grants WHERE actor_issuer=$1 AND actor_subject=$2 AND capability='overview:read' AND revoked_at IS NULL",[actor.issuer,actor.subject])).rowCount===1;
      const {actor}=await authorizeAdminRead(token,bound);
      const since=url.searchParams.get('since') || new Date(Date.now()-30*86400000).toISOString().slice(0,10);
      if (!/^20\d{2}-\d{2}-\d{2}$/.test(since) || !Number.isFinite(Date.parse(since+'T00:00:00Z')) || new Date(since+'T00:00:00Z').toISOString().slice(0,10)!==since) {
        send(res,422,{error:'invalid_since'}); return true;
      }
      const data=await campaignCounts(since);
      if (!await bound(actor)) throw new AdminAuthError(403);
      await pool.query("INSERT INTO portal_admin_audit(actor_issuer,actor_subject,action) VALUES($1,$2,'campaign.attribution.read')",[actor.issuer,actor.subject]);
      send(res,200,data);
    } catch (error) { send(res,error instanceof AdminAuthError?error.status:503,{error:'campaign_read_unavailable'}); }
    return true;
  }
  const ref=url.searchParams.get('ref');
  if (req.method==='GET' && url.pathname==='/api/campaign/instructions') {
    if (!validCampaignRef(ref)) { send(res,422,{error:'invalid_ref'}); return true; }
    await countCampaign(ref,'instructions_requested',url.searchParams.get('test')==='1');
    res.writeHead(302,{Location:'/access-guide.md','Cache-Control':'no-store'}); res.end(); return true;
  }
  if (req.method==='POST' && url.pathname==='/api/campaign/visit') {
    const body=await readBody(req,res,audit);
    if (!body) return true;
    const stage=body.stage;
    if (!validCampaignRef(body.ref) || typeof stage!=='string' || (stage!=='landing' && !FUNNEL_STAGES.has(stage))
      || typeof body.is_test!=='boolean') {
      send(res,422,{error:'invalid_visit'}); return true;
    }
    await countCampaign(body.ref,stage,body.is_test);
    send(res,202,{recorded:true}); return true;
  }
  send(res,404,{error:'not_found'}); return true;
}

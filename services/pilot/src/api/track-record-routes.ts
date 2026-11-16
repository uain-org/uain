/**
 * The track record over HTTP (application/track-record.ts), for a member and
 * for one agent:
 *
 *   GET /api/members/{address}/track-record
 *   GET /api/directory/{id}/track-record
 *
 * Both take ?page= and ?page_size= for the karma history. Public, like the
 * records they are derived from. Wired from api/server.ts's API handler:
 *   if (await handleTrackRecord(req, res, url, send, audit)) return undefined;
 */
import { trackRecord } from '../application/track-record.ts';

const MEMBER = /^\/api\/members\/(uain1[0-9a-f]{40})\/track-record$/;
const AGENT = /^\/api\/directory\/([a-z0-9-]+)\/track-record$/;

/** Returns true when the request was a track record route and has been answered. */
export async function handleTrackRecord(req, res, url, send, audit): Promise<boolean> {
  if (req.method !== 'GET') return false;
  const member = url.pathname.match(MEMBER);
  const agent = member ? null : url.pathname.match(AGENT);
  if (!member && !agent) return false;
  const key = (member ?? agent)[1];
  const record = await trackRecord(member ? { member: key } : { participant: key }, {
    page: url.searchParams.get('page'),
    pageSize: url.searchParams.get('page_size'),
  });
  audit(record ? 200 : 404, key);
  if (!record) send(res, 404, { error: 'not_found', ...(member ? { address: key } : { id: key }) });
  else send(res, 200, record);
  return true;
}

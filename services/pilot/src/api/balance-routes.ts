/**
 * The live public balance of a member's bound wallet addresses, over HTTP
 * (integrations/chain-balances.ts):
 *
 *   GET /api/directory/{id}/balances         for the member of one agent
 *   GET /api/members/{address}/balances      for a member
 *
 * Public and read-only, like the addresses themselves. A chain with no bound
 * address is null. A chain whose node failed has `balance: null` with an
 * `error` and a `reason`, and the response is still 200: one slow node never
 * fails the other chain or the page that asked. Wired from api/server.ts:
 *   if (await handleBalances(req, res, url, send, audit)) return undefined;
 */
import { getMember, getParticipant } from '../application/db.ts';
import { walletsOf } from '../application/wallets.ts';
import { BALANCES_NOTE, balances, type BalanceChain } from '../integrations/chain-balances.ts';

const MEMBER = /^\/api\/members\/(uain1[0-9a-f]{40})\/balances$/;
const AGENT = /^\/api\/directory\/([a-z0-9-]+)\/balances$/;
const CHAINS: BalanceChain[] = ['ethereum', 'solana'];

/** Returns true when the request was a balances route and has been answered. */
export async function handleBalances(req, res, url: URL, send, audit): Promise<boolean> {
  if (req.method !== 'GET') return false;
  const member = url.pathname.match(MEMBER);
  const agent = member ? null : url.pathname.match(AGENT);
  if (!member && !agent) return false;

  const key = (member ?? agent)[1];
  let memberId: string | null = null;
  if (member) {
    const m = await getMember(key);
    if (!m) {
      audit(404, key);
      send(res, 404, { error: 'not_found', address: key });
      return true;
    }
    memberId = m.address;
  } else {
    const row = await getParticipant(key);
    if (!row) {
      audit(404, key);
      send(res, 404, { error: 'not_found', id: key });
      return true;
    }
    memberId = row.member_id ?? null;
  }

  const wallets = (await walletsOf(memberId)) as Record<string, { address: string } | null | string>;
  const read = await Promise.all(
    CHAINS.map(async (chain) => {
      const w = wallets[chain];
      return [chain, w && typeof w === 'object' ? await balances.read(chain, w.address) : null] as const;
    }),
  );
  audit(200, key);
  send(res, 200, {
    ...(member ? {} : { id: key }),
    member: memberId,
    balances: Object.fromEntries(read),
    cache_seconds: balances.cacheSeconds(),
    note: BALANCES_NOTE,
  });
  return true;
}

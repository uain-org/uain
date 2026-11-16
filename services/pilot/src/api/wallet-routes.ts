/**
 * The wallet calls over HTTP (application/wallets.ts), for systems without an
 * MCP client:
 *
 *   POST /api/wallets/challenge  { chain, address }                      a challenge to sign
 *   POST /api/wallets            { chain, address, signature, message }  bind the address
 *   POST /api/wallets/unbind     { chain }                               remove it
 *   GET  /api/wallets/<n>        one binding, in force or ended, with its proof
 *
 * The POSTs need the agent's session as a Bearer header. Wired from
 * api/server.ts's API handler.
 */
import { hit } from '../storage/ratelimit.ts';
import { bindWallet, explained, getBinding, issueChallenge, unbindWallet } from '../application/wallets.ts';

interface Helpers {
  send: (res: any, status: number, body: unknown, extra?: Record<string, string>) => unknown;
  readBody: (req: any, res: any, audit: Helpers['audit']) => Promise<Record<string, unknown> | null>;
  audit: (status: number, detail?: string | null) => unknown;
  authenticate: () => Promise<{ id: string } | null>;
  notAuthenticated: () => Promise<unknown>;
  audience: string | null;
}

const STATUS: Record<string, number> = {
  not_acting: 403,
  wrong_member: 403,
  challenge_unknown: 404,
  not_bound: 404,
  challenge_used: 409,
  wallet_taken: 409,
  challenge_expired: 410,
};

/** Returns true when the request was a wallet route and has been answered. */
export async function handleWallets(req, res, url: URL, h: Helpers): Promise<boolean> {
  const one = url.pathname.match(/^\/api\/wallets\/([0-9]{1,15})$/);
  if (req.method === 'GET' && one) {
    const w = await getBinding(one[1]);
    h.audit(w ? 200 : 404, one[1]);
    h.send(res, w ? 200 : 404, w ?? { error: 'not_found', id: Number(one[1]) });
    return true;
  }

  const route = { '/api/wallets/challenge': 'challenge', '/api/wallets': 'bind', '/api/wallets/unbind': 'unbind' }[url.pathname];
  if (req.method !== 'POST' || !route) return false;
  const me = await h.authenticate();
  if (!me) {
    await h.notAuthenticated();
    return true;
  }
  const body = await h.readBody(req, res, h.audit);
  if (!body) return true;
  const gate = await hit('wallets', `agent:${me.id}`);
  if (!gate.allowed) {
    h.audit(429, 'wallet_rate_limited');
    h.send(
      res,
      429,
      {
        error: 'rate_limited',
        message: `At most ${gate.limit} wallet calls an hour for one agent.`,
        retry_after_seconds: gate.retryAfter,
      },
      { 'retry-after': String(gate.retryAfter) },
    );
    return true;
  }
  const r: Record<string, any> =
    route === 'challenge'
      ? await issueChallenge({ participant: me.id, chain: body.chain, address: body.address, audience: h.audience })
      : route === 'bind'
        ? await bindWallet({
            participant: me.id,
            chain: body.chain,
            address: body.address,
            signature: body.signature,
            message: body.message,
            audience: h.audience,
          })
        : await unbindWallet({ participant: me.id, chain: body.chain });
  const status = r.error ? (STATUS[r.error] ?? 422) : 200;
  h.audit(status, r.error ?? `${me.id}:${route}:${body.chain}`);
  const refused = route === 'bind' ? { bound: false } : route === 'unbind' ? { unbound: false } : {};
  h.send(res, status, explained(r.error ? { ...refused, ...r } : r));
  return true;
}

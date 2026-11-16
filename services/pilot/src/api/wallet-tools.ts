/**
 * The wallet tools over MCP: uain_wallet_challenge, uain_wallet_bind and
 * uain_wallet_unbind (application/wallets.ts). Registered by buildMcpServer
 * in api/mcp.ts, with the helpers every tool there uses.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { hit, RATE_LIMITS } from '../storage/ratelimit.ts';
import { bindWallet, explained, issueChallenge, NEVER_SEND, unbindWallet, WALLETS_NOTE } from '../application/wallets.ts';
import { CHAINS } from '../identity/wallet-proof.ts';

interface Helpers {
  ctx: { audience: string | null };
  whoami: (token?: string | null) => Promise<{ id: string } | null>;
  unauthenticated: (token?: string | null) => Promise<CallToolResult>;
  audit: (action: string, detail?: string | null) => unknown;
  text: (value: unknown) => CallToolResult;
}

const NO_PAYOUT =
  'Nothing is paid to these addresses yet: bounties are still credits, and UAIN holds no keys or funds.';

export function registerWalletTools(server: McpServer, { ctx, whoami, unauthenticated, audit, text }: Helpers) {
  const token = z.string().optional().describe('Only needed if your client cannot send an Authorization header.');
  const chain = z.enum(CHAINS).describe('ethereum or solana');
  const address = z
    .string()
    .max(100)
    .describe(
      'The wallet address: Ethereum 0x and 40 hex characters (EIP-55 checksum case, or all lower ' +
        'case); Solana the base58 of its 32-byte public key.',
    );

  /** Counted per agent, challenges and changes together, as profile updates are. */
  const limited = async (tool: string, id: string) => {
    const gate = await hit('wallets', `agent:${id}`);
    if (gate.allowed) return null;
    audit(tool, 'rejected:rate_limited');
    return text({
      error: 'rate_limited',
      message: `At most ${gate.limit} wallet calls an hour for one agent.`,
      retry_after_seconds: gate.retryAfter,
    });
  };

  server.registerTool(
    'uain_wallet_challenge',
    {
      title: 'Get a challenge to prove a wallet address',
      description:
        'Step 1 of tying an Ethereum or Solana address to your member, one of each at most, so it ' +
        'appears on your public profile. Returns a message naming your member, the chain, the ' +
        'address and this server. Sign it with that address\'s own wallet (Ethereum: EIP-191 ' +
        'personal_sign; Solana: Ed25519 over its UTF-8 bytes), on your own computer, then call ' +
        'uain_wallet_bind within ten minutes. ' +
        NEVER_SEND +
        ' ' +
        NO_PAYOUT +
        ` At most ${RATE_LIMITS.wallets.limit} wallet calls an hour per agent.`,
      inputSchema: { token, chain, address },
    },
    async ({ token: t, chain: c, address: a }) => {
      const me = await whoami(t);
      if (!me) return await unauthenticated(t);
      const stop = await limited('uain_wallet_challenge', me.id);
      if (stop) return stop;
      const r = await issueChallenge({ participant: me.id, chain: c, address: a, audience: ctx.audience });
      audit('uain_wallet_challenge', 'error' in r ? `rejected:${r.error}` : `${me.id}:${c}`);
      return text(explained(r));
    },
  );

  server.registerTool(
    'uain_wallet_bind',
    {
      title: 'Tie a proven wallet address to your member',
      description:
        'Step 2: send the challenge from uain_wallet_challenge, unchanged, with the address\'s ' +
        'signature over it. The server checks the signature came from that address\'s key, and ties ' +
        'the address to your member: it replaces the one already bound on that chain, if any. Any ' +
        'agent of your member may do this. The address, message and signature are public, and ' +
        'the binding is committed on the ledger. An address belongs to one member at a time. ' +
        NEVER_SEND +
        ' ' +
        NO_PAYOUT,
      inputSchema: {
        token,
        chain,
        address,
        signature: z
          .string()
          .max(200)
          .describe(
            'Ethereum: the 65-byte personal_sign signature, 0x and 130 hex characters. Solana: the ' +
              '64-byte Ed25519 signature, base58.',
          ),
        message: z.string().max(1000).describe('The challenge message, exactly as uain_wallet_challenge gave it.'),
      },
    },
    async ({ token: t, chain: c, address: a, signature, message }) => {
      const me = await whoami(t);
      if (!me) return await unauthenticated(t);
      const stop = await limited('uain_wallet_bind', me.id);
      if (stop) return stop;
      const r = await bindWallet({ participant: me.id, chain: c, address: a, signature, message, audience: ctx.audience });
      audit('uain_wallet_bind', r.error ? `rejected:${r.error}` : `${me.id}:${c}:${r.bound ? 'bound' : 'unchanged'}`);
      return text(explained(r.error ? { bound: false, ...r } : r));
    },
  );

  server.registerTool(
    'uain_wallet_unbind',
    {
      title: 'Remove a wallet address from your member',
      description:
        'Removes the address bound to your member on one chain. Any agent of your member may do ' +
        'this. The removal goes on the ledger; the binding stays on the record as ended. ' +
        WALLETS_NOTE,
      inputSchema: { token, chain },
    },
    async ({ token: t, chain: c }) => {
      const me = await whoami(t);
      if (!me) return await unauthenticated(t);
      const stop = await limited('uain_wallet_unbind', me.id);
      if (stop) return stop;
      const r = await unbindWallet({ participant: me.id, chain: c });
      audit('uain_wallet_unbind', r.error ? `rejected:${r.error}` : `${me.id}:${c}`);
      return text(explained(r.error ? { unbound: false, ...r } : r));
    },
  );
}

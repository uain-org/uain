/**
 * One MCP server for every request a copy answers.
 *
 * MCP here has no sessions (api/server.ts): each HTTP request carries its
 * messages and gets its answers. The SDK's server object is built for one
 * long connection, so each request used to borrow one of its own, and a
 * copy held as many as it ever had requests at once: 764 KB each, the tool
 * definitions again, which took copies past their memory at 800 requests at
 * once (the k3s rehearsal of 2026-09-30). This is the one connection the one
 * server object has. A request's messages go in under ids of the hub's own,
 * since two clients may both send id 1, and each answer goes back to the
 * request that asked under the id it sent.
 */
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, JSONRPCRequest, RequestId } from '@modelcontextprotocol/sdk/types.js';

type Answer = JSONRPCMessage & { id: RequestId };

const answerMs = Number(process.env.UAIN_MCP_ANSWER_MS);
/**
 * How long a request may wait for its answer: 10 minutes unless
 * UAIN_MCP_ANSWER_MS says otherwise. Above the citation check's own bound
 * (integrations/sources.ts, 4 minutes), so a tool that checks sources finishes
 * or refuses before its caller is told no answer will come.
 */
export const MCP_ANSWER_MS = Number.isInteger(answerMs) && answerMs > 0 ? answerMs : 600_000;

export class McpHub implements Transport {
  onmessage?: Transport['onmessage'];
  onclose?: () => void;
  onerror?: (error: Error) => void;

  private next = 0;
  private waiting = new Map<number, (answer: Answer) => void>();

  async start() {}

  async close() {
    this.onclose?.();
  }

  /** From the server: an answer goes to the request that asked. */
  async send(message: JSONRPCMessage) {
    if (!('id' in message) || 'method' in message) return; // UAIN sends clients nothing unasked
    const answer = this.waiting.get(message.id as number);
    this.waiting.delete(message.id as number);
    answer?.(message as Answer);
  }

  /**
   * Put one request to the server; its answer comes back under the request's own id.
   * A request not answered within timeoutMs (baseline 06a-10, 13 November 2026)
   * gets a JSON-RPC error and is forgotten, so a tool that never answers cannot
   * hold its HTTP response and this entry for ever. The default is above the
   * longest legitimate tool call: a citation check is bounded below it.
   */
  ask(request: JSONRPCRequest, timeoutMs: number = MCP_ANSWER_MS): Promise<Answer> {
    const id = ++this.next;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.waiting.delete(id)) return;
        resolve({ jsonrpc: '2.0', id: request.id, error: { code: -32001, message: 'Request timed out: the server did not answer in time. Nothing more will be sent for this request.' } } as Answer);
      }, timeoutMs);
      timer.unref?.();
      this.waiting.set(id, (answer) => { clearTimeout(timer); resolve({ ...answer, id: request.id }); });
      this.onmessage?.({ ...request, id });
    });
  }

  /** Requests still waiting for their answer. */
  get pending() {
    return this.waiting.size;
  }
}

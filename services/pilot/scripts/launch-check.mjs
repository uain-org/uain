/** On-demand, anonymous checks; does not send alerts or schedule a monitor. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { probePilot, monitorOrigin } from '../dist/src/operations/monitor.js';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--base') throw new Error('Usage: launch-check.mjs --base <origin>');
const origin = monitorOrigin(args[1]);
const report = await probePilot(origin.origin);
const client = new Client({ name: 'uain-launch-check', version: '0.1.0' });
const started = performance.now();
const signal = AbortSignal.timeout(15_000);
let inventory = { name: 'mcp_inventory', ok: false, latency_ms: 0, error: 'transport' };
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin)), { signal, timeout: 5000 });
  const names = new Set();
  let cursor;
  const seen = new Set();
  do {
    const page = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 5000 });
    for (const tool of page.tools) names.add(tool.name);
    cursor = page.nextCursor;
    if (names.size > 200 || (cursor && seen.has(cursor))) throw new Error('Unexpected inventory');
    if (cursor) seen.add(cursor);
  } while (cursor);
  const required = ['uain_describe', 'uain_principles', 'uain_enrol', 'uain_login', 'uain_projects', 'uain_contribute', 'uain_verify', 'uain_claim_review'];
  const missing = required.filter(name => !names.has(name));
  inventory = { name: 'mcp_inventory', ok: missing.length === 0, tool_count: names.size, missing, latency_ms: Math.round(performance.now() - started), ...(missing.length ? { error: 'missing_tools' } : {}) };
} catch { inventory.latency_ms = Math.round(performance.now() - started); }
finally { await client.close().catch(() => {}); }
report.checks.push(inventory);
report.ok &&= inventory.ok;
const directory = resolve(import.meta.dirname, '../../../work/monitoring');
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, 'latest.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;

// Read-only health check: does the endpoint speak MCP and list its tools?
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.argv[2] ?? 'http://localhost:8787/mcp';
const client = new Client({ name: 'uain-healthcheck', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
const { tools } = await client.listTools();
const r = await client.callTool({ name: 'uain_describe', arguments: {} });
const d = JSON.parse(r.content[0].text);
console.log(`ok  ${url}`);
console.log(
  `    ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`,
);
console.log(`    enrolled: ${d.status.participants_enrolled}`);
await client.close();

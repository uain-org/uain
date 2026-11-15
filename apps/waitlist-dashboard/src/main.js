/**
 * Starts the dashboard. Without its three secrets it still starts, answers
 * /healthz, and serves 503 everywhere else (src/config.js).
 *
 * Logs are JSON lines on stdout: `kind: "audit"` for sign-ins, sign-outs,
 * views and exports; `kind: "service"` for the rest. Never a password, a
 * cookie or a row.
 */
import http from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db.js';

const log = (entry) =>
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
  );

const config = loadConfig(process.env);
const db = config.configured ? createDb(config.databaseUrl, { log }) : null;
const server = http.createServer(createApp({ config, db, log }));
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.keepAliveTimeout = 5000;

server.listen(config.port, config.host, () => {
  log({
    kind: 'service',
    event: 'listening',
    port: config.port,
    configured: config.configured,
    ...(config.configured ? {} : { problems: config.problems }),
    trusted_proxy_hops: config.trustedProxyHops,
    insecure_cookies: config.insecureCookies,
  });
});

let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  log({ kind: 'service', event: 'stopping', signal });
  server.close(() => {
    void Promise.resolve(db?.close()).finally(() => process.exit(0));
  });
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

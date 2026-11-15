/**
 * Configuration from the environment. Missing or unusable secrets do not stop
 * the process: it starts "not configured", answers /healthz, and serves no
 * data, so a deploy never fails because the secrets do not exist yet.
 */
import { parsePasswordHash } from './auth.js';

function hops(text) {
  if (text === undefined || text === '') return 1;
  const n = Number(text);
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : 1;
}

export function loadConfig(env = process.env) {
  /** Names and reasons only: never a value. */
  const problems = [];

  const databaseUrl = env.DATABASE_URL ?? '';
  if (!databaseUrl) problems.push('DATABASE_URL is not set');
  else {
    let u = null;
    try {
      u = new URL(databaseUrl);
    } catch {
      problems.push('DATABASE_URL is not a URL');
    }
    if (u && u.protocol !== 'postgres:' && u.protocol !== 'postgresql:')
      problems.push('DATABASE_URL is not a postgres:// URL');
    // compose.yaml fills the password from a secret that may not exist yet.
    else if (u && !u.password) problems.push('DATABASE_URL has no password');
  }

  const passwordHash = parsePasswordHash(
    env.WAITLIST_ADMIN_PASSWORD_HASH ?? '',
  );
  if (!env.WAITLIST_ADMIN_PASSWORD_HASH)
    problems.push('WAITLIST_ADMIN_PASSWORD_HASH is not set');
  else if (!passwordHash)
    problems.push(
      'WAITLIST_ADMIN_PASSWORD_HASH is not scrypt$N$r$p$salt$hash with N a power of two of at least 16384',
    );

  const sessionSecret = env.WAITLIST_SESSION_SECRET ?? '';
  if (!sessionSecret) problems.push('WAITLIST_SESSION_SECRET is not set');
  else if (Buffer.byteLength(sessionSecret) < 32)
    problems.push('WAITLIST_SESSION_SECRET is shorter than 32 bytes');

  return {
    configured: problems.length === 0,
    problems,
    databaseUrl,
    passwordHash,
    sessionSecret,
    // For local development over plain HTTP only: browsers drop Secure
    // cookies there.
    insecureCookies: env.WAITLIST_INSECURE_COOKIES === '1',
    // The proxies in front that append to X-Forwarded-For. In production
    // that is the shared TLS front door alone.
    trustedProxyHops: hops(env.WAITLIST_TRUSTED_PROXY_HOPS),
    host: env.HOST || '0.0.0.0',
    port: Number(env.PORT) || 8080,
  };
}

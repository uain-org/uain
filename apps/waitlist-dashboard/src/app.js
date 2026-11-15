/**
 * The request handler. Every page but /login and /healthz needs a session;
 * every response carries the security headers; every POST needs a CSRF token.
 */
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { FailureLimiter, Sessions, safeEqual, verifyPassword } from './auth.js';
import { toCsv } from './csv.js';
import { readQuery } from './db.js';
import { candidateId, seqOf } from './fields.js';
import {
  detailPage,
  loginPage,
  messagePage,
  overviewPage,
  signupsPage,
} from './views.js';

export const CSP =
  "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; " +
  "form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

const MAX_FORM_BYTES = 8 * 1024;
const SESSION_MAX_AGE = 12 * 60 * 60;

/**
 * The client's address. Each trusted proxy appends the address it was
 * reached from to X-Forwarded-For, so the client is `hops` entries from the
 * right; anything further left was written by the client and proves
 * nothing. The same rule as clientAddress in services/pilot/src/api/server.ts.
 */
export function clientIp(req, hops) {
  const socket = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (hops === 0) return socket;
  const chain = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const candidate = chain[chain.length - hops];
  if (!candidate) return socket;
  const ip = candidate.replace(/^::ffff:/, '');
  return isIP(ip) ? ip : socket;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    if (!Object.hasOwn(out, name)) out[name] = part.slice(i + 1).trim();
  }
  return out;
}

/** Where to go after signing in: a path on this site, never another site. */
export function safeNext(next) {
  if (typeof next !== 'string' || !next.startsWith('/') || next.length > 1000)
    return '/';
  let u;
  try {
    u = new URL(next, 'http://dashboard.invalid');
  } catch {
    return '/';
  }
  // `/.//evil.example` normalises to `//evil.example`, which a browser would
  // read as another host.
  if (u.origin !== 'http://dashboard.invalid' || u.pathname.startsWith('//'))
    return '/';
  if (u.pathname.startsWith('/login') || u.pathname.startsWith('/logout'))
    return '/';
  return u.pathname + u.search;
}

function readForm(req) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (type !== 'application/x-www-form-urlencoded') {
      req.resume();
      resolve(null);
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_FORM_BYTES) {
        const err = new Error('form too large');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () =>
      resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))),
    );
    req.on('error', reject);
  });
}

export function createApp({ config, db, log = () => {}, now = Date.now }) {
  const audit = (event, fields) => log({ kind: 'audit', event, ...fields });
  const sessions = config.configured
    ? new Sessions({ secret: config.sessionSecret, now })
    : null;
  const limiter = new FailureLimiter({ now });
  const secure = !config.insecureCookies;
  // The __Host- prefix makes a browser refuse the cookie unless it is Secure,
  // for this host only and for every path: no other subdomain can set it.
  const SESSION_COOKIE = secure ? '__Host-wl_session' : 'wl_session';
  const LOGIN_COOKIE = secure ? '__Host-wl_login' : 'wl_login';

  const cookie = (name, value, maxAge) =>
    [
      `${name}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      ...(secure ? ['Secure'] : []),
      ...(maxAge === undefined ? [] : [`Max-Age=${maxAge}`]),
    ].join('; ');

  function isHttps(req) {
    if (config.trustedProxyHops === 0) return false;
    const proto = String(req.headers['x-forwarded-proto'] ?? '')
      .split(',')
      .at(-1)
      .trim()
      .toLowerCase();
    return proto === 'https';
  }

  function headers(req, extra = {}) {
    return {
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy':
        'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      // Nothing here is worth caching, and most of it is personal data.
      'Cache-Control': 'no-store',
      ...(isHttps(req)
        ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' }
        : {}),
      ...extra,
    };
  }

  function send(req, res, status, body, extra = {}) {
    const type = extra['Content-Type'] ?? 'text/html; charset=utf-8';
    const buf = Buffer.from(body ?? '');
    res.writeHead(
      status,
      headers(req, {
        'Content-Type': type,
        'Content-Length': buf.length,
        ...extra,
      }),
    );
    res.end(req.method === 'HEAD' ? undefined : buf);
  }

  const redirect = (req, res, location, extra = {}) =>
    send(req, res, 303, '', {
      Location: location,
      'Content-Type': 'text/plain; charset=utf-8',
      ...extra,
    });

  function currentSession(req) {
    if (!sessions) return null;
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    return token ? sessions.verify(token) : null;
  }

  /** The sign-in form's CSRF pair: a nonce cookie (kept if already set) and its token. */
  function loginCsrf(req) {
    const existing = parseCookies(req.headers.cookie)[LOGIN_COOKIE];
    if (existing && /^[A-Za-z0-9_-]{43}$/.test(existing))
      return {
        nonce: existing,
        token: sessions.loginToken(existing),
        setCookie: null,
      };
    const nonce = randomBytes(32).toString('base64url');
    return {
      nonce,
      token: sessions.loginToken(nonce),
      setCookie: cookie(LOGIN_COOKIE, nonce),
    };
  }

  function showLogin(
    req,
    res,
    status,
    { next = '/', error = null, extra = {} } = {},
  ) {
    const csrf = loginCsrf(req);
    const setCookies = [
      ...(extra['Set-Cookie'] ?? []),
      ...(csrf.setCookie ? [csrf.setCookie] : []),
    ];
    send(req, res, status, loginPage({ csrf: csrf.token, next, error }), {
      ...extra,
      ...(setCookies.length ? { 'Set-Cookie': setCookies } : {}),
    });
  }

  async function login(req, res) {
    const ip = clientIp(req, config.trustedProxyHops);
    const gate = limiter.check(ip);
    if (gate.blocked) {
      req.resume();
      audit('login_failure', { ip, reason: 'rate_limited' });
      const minutes = Math.ceil(gate.retryAfter / 60);
      return send(
        req,
        res,
        429,
        messagePage(
          429,
          'Too many attempts',
          `Too many failed sign-ins${gate.scope === 'all' ? '' : ' from this address'}. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        ),
        { 'Retry-After': String(gate.retryAfter) },
      );
    }
    const form = await readForm(req);
    const next = safeNext(form?.get('next') ?? '/');
    const nonce = parseCookies(req.headers.cookie)[LOGIN_COOKIE];
    if (!form || !sessions.checkLoginToken(nonce, form.get('csrf'))) {
      audit('login_failure', { ip, reason: 'csrf' });
      return showLogin(req, res, 403, {
        next,
        error: 'The form had expired. Please sign in again.',
      });
    }
    // Counted before the check, forgiven after a success (see FailureLimiter).
    limiter.fail(ip);
    const ok = await verifyPassword(
      form.get('password') ?? '',
      config.passwordHash,
    );
    if (!ok) {
      audit('login_failure', { ip, reason: 'wrong_password' });
      return showLogin(req, res, 401, {
        next,
        error: 'That password is not right.',
      });
    }
    limiter.reset(ip);
    // A fresh session every time: an id from before sign-in is never reused.
    const old = currentSession(req);
    if (old) sessions.destroy(old.sid);
    const s = sessions.create();
    audit('login_success', { ip });
    return redirect(req, res, next, {
      'Set-Cookie': [
        cookie(SESSION_COOKIE, s.token, SESSION_MAX_AGE),
        cookie(LOGIN_COOKIE, '', 0),
      ],
    });
  }

  async function logout(req, res) {
    const ip = clientIp(req, config.trustedProxyHops);
    const session = currentSession(req);
    const form = await readForm(req);
    if (!session)
      return redirect(req, res, '/login', {
        'Set-Cookie': [cookie(SESSION_COOKIE, '', 0)],
      });
    if (!form || !safeEqual(form.get('csrf') ?? '', session.csrf)) {
      audit('logout_refused', { ip, reason: 'csrf' });
      return send(
        req,
        res,
        403,
        messagePage(
          403,
          'Not signed out',
          'The form had expired. Go back, reload the page and try again.',
        ),
      );
    }
    sessions.destroy(session.sid);
    audit('logout', { ip });
    return redirect(req, res, '/login', {
      'Set-Cookie': [cookie(SESSION_COOKIE, '', 0)],
    });
  }

  async function route(req, res) {
    if (typeof req.url !== 'string' || !req.url.startsWith('/'))
      return send(req, res, 400, 'Bad request', {
        'Content-Type': 'text/plain; charset=utf-8',
      });
    const url = new URL(`http://dashboard.invalid${req.url}`);
    const path = url.pathname;
    const method = req.method;
    const read = method === 'GET' || method === 'HEAD';

    if (path === '/healthz') {
      if (!read)
        return send(req, res, 405, 'Method not allowed', {
          Allow: 'GET, HEAD',
          'Content-Type': 'text/plain; charset=utf-8',
        });
      return send(
        req,
        res,
        200,
        JSON.stringify({ ok: true, configured: config.configured }),
        {
          'Content-Type': 'application/json',
        },
      );
    }

    if (!config.configured)
      return send(
        req,
        res,
        503,
        messagePage(
          503,
          'Not configured',
          'This dashboard is not configured yet: it needs its database password, admin password hash and session secret. See apps/waitlist-dashboard/README.md.',
        ),
      );

    // A cross-site POST never gets this far with a session (the cookie is
    // SameSite=Strict), and a browser says where a request came from.
    const site = req.headers['sec-fetch-site'];
    if (!read && site && site !== 'same-origin' && site !== 'none')
      return send(
        req,
        res,
        403,
        messagePage(403, 'Refused', 'A form on another site cannot post here.'),
      );

    if (path === '/login') {
      if (method === 'POST') return login(req, res);
      if (!read)
        return send(req, res, 405, 'Method not allowed', {
          Allow: 'GET, HEAD, POST',
          'Content-Type': 'text/plain; charset=utf-8',
        });
      if (currentSession(req))
        return redirect(
          req,
          res,
          safeNext(url.searchParams.get('next') ?? '/'),
        );
      return showLogin(req, res, 200, {
        next: safeNext(url.searchParams.get('next') ?? '/'),
      });
    }

    if (path === '/logout') {
      if (method !== 'POST')
        return send(req, res, 405, 'Method not allowed', {
          Allow: 'POST',
          'Content-Type': 'text/plain; charset=utf-8',
        });
      return logout(req, res);
    }

    const session = currentSession(req);
    if (!session) {
      if (!read)
        return send(req, res, 401, 'Sign in first', {
          'Content-Type': 'text/plain; charset=utf-8',
        });
      const next = safeNext(path + url.search);
      return redirect(
        req,
        res,
        next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`,
      );
    }
    if (!read)
      return send(req, res, 405, 'Method not allowed', {
        Allow: 'GET, HEAD',
        'Content-Type': 'text/plain; charset=utf-8',
      });

    const ip = clientIp(req, config.trustedProxyHops);
    const csrf = session.csrf;

    if (path === '/') {
      const current = now();
      const data = await db.overview({ now: current });
      return send(
        req,
        res,
        200,
        overviewPage({
          csrf,
          data,
          today: new Date(current).toISOString().slice(0, 10),
        }),
      );
    }

    if (path === '/signups') {
      const filter = readQuery(url.searchParams);
      const [result, options] = await Promise.all([
        db.list(filter),
        db.filterOptions(),
      ]);
      return send(
        req,
        res,
        200,
        signupsPage({ csrf, filter, result, options }),
      );
    }

    const detail = /^\/signups\/([^/]+)$/.exec(path);
    if (detail) {
      const seq = seqOf(detail[1]);
      const found = seq ? await db.get(seq) : null;
      audit('view', {
        ip,
        id: seq ? candidateId(seq) : detail[1].slice(0, 40),
        found: Boolean(found?.row),
      });
      if (!found?.row)
        return send(
          req,
          res,
          404,
          messagePage(
            404,
            'No such sign-up',
            'There is no sign-up with that id.',
          ),
        );
      return send(req, res, 200, detailPage({ csrf, ...found }));
    }

    if (path === '/export.csv') {
      const filter = readQuery(url.searchParams);
      const { columns, rows } = await db.exportRows(filter);
      const out = rows.map((r) => ({ id: candidateId(r.seq), ...r }));
      audit('export', {
        ip,
        rows: rows.length,
        filter: {
          q: filter.q,
          status: filter.status,
          channel: filter.channel,
          type: filter.type,
        },
      });
      const day = new Date(now()).toISOString().slice(0, 10);
      return send(req, res, 200, toCsv(['id', ...columns], out), {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="uain-waitlist-${day}.csv"`,
      });
    }

    return send(
      req,
      res,
      404,
      messagePage(404, 'Not found', 'There is no page here.'),
    );
  }

  return async function handle(req, res) {
    try {
      await route(req, res);
    } catch (err) {
      const status = err.status === 413 ? 413 : 500;
      log({
        kind: 'service',
        event: 'request_error',
        status,
        message: err.message,
      });
      if (!res.headersSent)
        send(
          req,
          res,
          status,
          messagePage(
            status,
            status === 413 ? 'Too large' : 'Something went wrong',
            'The request could not be completed.',
          ),
        );
      else res.destroy();
    }
  };
}

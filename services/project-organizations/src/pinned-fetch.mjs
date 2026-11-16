/**
 * Pinned-address HTTPS fetch for trusted retrieval (closes DNS rebinding).
 *
 * `createPinnedFetch` returns a fetch-compatible function. For every request it
 * resolves the host once, refuses the request unless every answer is a public
 * address, and then connects to the exact address that passed the check: the
 * `lookup` hook handed to node:https returns that pre-validated address and
 * never resolves again, so a second DNS answer (rebinding to a private or
 * metadata address) cannot redirect the connection. The certificate is still
 * validated against the hostname (servername = host for SNI and identity,
 * rejectUnauthorized always true).
 *
 * Deliberately narrow:
 *   - https only, GET only, host must be on `allowedHosts`, no IP literals, no
 *     credentials in the URL;
 *   - redirects are never followed: a 3xx comes back as an ordinary Response so
 *     the caller's redirect policy (createRetriever re-checks every hop) applies;
 *   - the body is capped at `maxBytes` (or a smaller per-call `init.maxBytes`)
 *     and the request is destroyed as soon as the cap is passed;
 *   - one overall timeout covers lookup, connect, headers and body;
 *   - no connection pooling (agent: false), no cookies, no decompression.
 *
 * `ca` exists only so tests can trust a locally generated certificate; it adds
 * trust anchors and never disables verification.
 */
import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { OrganizationError, need, refuse } from './common.mjs';
import { isPublicAddress as defaultIsPublicAddress } from './verification.mjs';

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const MAX_BYTES = 64 * 1024 * 1024;
const NULL_BODY = new Set([101, 204, 205, 304]);
/** Request headers the caller may not set: the transport owns them. */
const OWNED_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding', 'cookie', 'proxy-authorization',
  'upgrade', 'te', 'keep-alive']);
export const PINNED_FETCH_USER_AGENT = 'uain-trusted-retrieval/1';

const defaultLookup = (hostname, options, callback) => dnsLookup(hostname, options, callback);

function resolveAll(lookup, hostname) {
  return new Promise((resolve, reject) => {
    try {
      const pending = lookup(hostname, { all: true, verbatim: true }, (error, answers) => (error ? reject(error) : resolve(answers)));
      // An injected promise-style lookup is accepted too.
      if (pending && typeof pending.then === 'function') pending.then(resolve, reject);
    } catch (error) {
      reject(error);
    }
  });
}

function headerEntries(headers) {
  if (headers == null) return [];
  if (typeof headers.entries === 'function' && typeof headers.get === 'function') return [...headers.entries()];
  if (Array.isArray(headers)) return headers;
  need(typeof headers === 'object', 'invalid_request', 'headers');
  return Object.entries(headers);
}

/**
 * createPinnedFetch({ lookup, allowedHosts, isPublicAddress, timeoutMs, maxBytes, ca })
 *   -> async (url, init) => Response
 *
 * Rejections are OrganizationError with codes: https_required, credentials_in_url,
 * ip_literal_refused, host_not_allowed, method_refused, dns_failed,
 * private_address_refused, timeout, size_exceeded, retrieval_failed.
 */
export function createPinnedFetch({ lookup = defaultLookup, allowedHosts, isPublicAddress = defaultIsPublicAddress, timeoutMs = 30000,
  maxBytes = MAX_BYTES, ca } = {}) {
  need(typeof lookup === 'function' && typeof isPublicAddress === 'function', 'invalid_pinned_fetch', 'lookup and isPublicAddress');
  need(Array.isArray(allowedHosts) && allowedHosts.length >= 1 && allowedHosts.every((h) => typeof h === 'string' && HOSTNAME.test(h) && !isIP(h)) &&
    new Set(allowedHosts).size === allowedHosts.length, 'invalid_pinned_fetch', 'allowedHosts');
  need(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000, 'invalid_pinned_fetch', 'timeoutMs');
  need(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= MAX_BYTES, 'invalid_pinned_fetch', 'maxBytes');
  const hosts = new Set(allowedHosts);

  async function pinnedAddress(hostname) {
    let answers;
    try {
      answers = await resolveAll(lookup, hostname);
    } catch {
      refuse('dns_failed');
    }
    const list = (Array.isArray(answers) ? answers : [answers])
      .map((a) => (typeof a === 'string' ? { address: a, family: isIP(a) } : { address: a?.address, family: isIP(a?.address ?? '') }));
    need(list.length >= 1 && list.every((a) => a.family === 4 || a.family === 6), 'dns_failed');
    need(list.every((a) => isPublicAddress(a.address)), 'private_address_refused');
    return list[0];
  }

  return async function pinnedFetch(input, init = {}) {
    let url;
    try {
      url = new URL(typeof input === 'string' ? input : input?.href ?? input?.url);
    } catch {
      refuse('invalid_url');
    }
    need(url.protocol === 'https:', 'https_required');
    need(!url.username && !url.password, 'credentials_in_url');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    need(!isIP(host), 'ip_literal_refused');
    need(hosts.has(host), 'host_not_allowed');
    need((init.method ?? 'GET').toUpperCase() === 'GET' && init.body == null, 'method_refused');
    const limit = init.maxBytes === undefined ? maxBytes : init.maxBytes;
    need(Number.isSafeInteger(limit) && limit > 0 && limit <= maxBytes, 'invalid_request', 'maxBytes');
    const headers = { accept: '*/*', 'user-agent': PINNED_FETCH_USER_AGENT };
    for (const [name, value] of headerEntries(init.headers)) {
      const key = String(name).toLowerCase();
      if (!OWNED_HEADERS.has(key)) headers[key] = String(value);
    }
    headers['accept-encoding'] = 'identity';

    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([deadline, init.signal]) : deadline;
    const aborted = () => (deadline.aborted || init.signal?.reason?.name === 'TimeoutError'
      ? new OrganizationError('timeout') : new OrganizationError('retrieval_failed', 'aborted'));
    if (signal.aborted) throw aborted();

    const onAbort = new Promise((_, reject) => signal.addEventListener('abort', () => reject(aborted()), { once: true }));
    onAbort.catch(() => {});
    const pinned = await Promise.race([pinnedAddress(host), onAbort]);

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        req.destroy();
        reject(error instanceof OrganizationError ? error : new OrganizationError('retrieval_failed'));
      };
      // The connection goes to `pinned` and nowhere else: this hook never resolves.
      const pinnedLookup = (_hostname, options, callback) => {
        const cb = typeof options === 'function' ? options : callback;
        if (options?.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
        else cb(null, pinned.address, pinned.family);
      };
      const req = httpsRequest({
        protocol: 'https:',
        hostname: host,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'GET',
        headers,
        agent: false,
        lookup: pinnedLookup,
        family: pinned.family,
        autoSelectFamily: false,
        servername: host,
        rejectUnauthorized: true,
        ...(ca ? { ca } : {}),
      });
      signal.addEventListener('abort', () => fail(aborted()), { once: true });
      req.once('error', fail);
      req.once('response', (res) => {
        const declared = res.headers['content-length'];
        if (declared !== undefined && (!/^[0-9]+$/.test(declared) || Number(declared) > limit)) return fail(new OrganizationError('size_exceeded'));
        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > limit) return fail(new OrganizationError('size_exceeded'));
          chunks.push(chunk);
        });
        res.once('error', fail);
        res.once('aborted', () => fail(new OrganizationError('retrieval_failed', 'response aborted')));
        res.once('end', () => {
          if (settled) return;
          try {
            const responseHeaders = new Headers();
            for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) responseHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
            const status = res.statusCode;
            need(Number.isInteger(status) && status >= 200 && status <= 599, 'retrieval_failed', 'status');
            const body = NULL_BODY.has(status) ? null : Buffer.concat(chunks, total);
            const response = new Response(body, { status, statusText: res.statusMessage ?? '', headers: responseHeaders });
            settled = true;
            resolve(response);
          } catch (error) {
            fail(error);
          }
        });
      });
      req.end();
    });
  };
}

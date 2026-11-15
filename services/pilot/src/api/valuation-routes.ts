/**
 * The valuation over HTTP, so an agent without this code can still recompute
 * a budget. Stateless: nothing here reads or writes the store.
 *
 * Wire from api/server.ts's API handler:
 *   if (await handleValuation(req, res, url, send)) return;
 */
import {
  FORMULA_V0,
  canonicalDigest,
  computeValuation,
  extractInputs,
  reconcile,
  validateInputs,
} from '../domain/valuation.ts';

const MAX_BODY = 16 * 1024;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** Returns true when the request was a valuation route and has been answered. */
export async function handleValuation(req, res, url, send) {
  if (!url.pathname.startsWith('/api/valuation')) return false;

  if (req.method === 'GET' && url.pathname === '/api/valuation/formula') {
    send(res, 200, FORMULA_V0);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/valuation/compute') {
    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      send(res, e.status ?? 400, { error: 'bad_request', message: e.message });
      return true;
    }
    const inputs = extractInputs(body);
    const problems = validateInputs(inputs);
    if (problems.length) {
      send(res, 422, { error: 'invalid_inputs', problems });
      return true;
    }
    const result = computeValuation(inputs);
    send(res, 200, { ...result, digest: canonicalDigest(inputs, result) });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/valuation/reconcile') {
    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      send(res, e.status ?? 400, { error: 'bad_request', message: e.message });
      return true;
    }
    try {
      send(res, 200, reconcile(body?.a, body?.b));
    } catch (e) {
      send(res, 422, { error: 'invalid_inputs', message: e.message });
    }
    return true;
  }

  send(res, 404, {
    error: 'not_found',
    routes: [
      'GET /api/valuation/formula',
      'POST /api/valuation/compute',
      'POST /api/valuation/reconcile',
    ],
  });
  return true;
}

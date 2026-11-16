import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FORMULA_V0,
  canonicalDigest,
  computeValuation,
  extractInputs,
  reconcile,
  validateInputs,
} from '../dist/src/domain/valuation.js';
import { handleValuation } from '../dist/src/api/valuation-routes.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const within = (actual, expected, pct) =>
  assert.ok(
    Math.abs(actual - expected) / expected <= pct,
    `${actual} not within ${pct * 100}% of ${expected}`,
  );

describe('formula v0', () => {
  test('the published parameters are the ones the code uses', () => {
    const published = JSON.parse(
      readFileSync(join(root, 'docs', 'valuation', 'formula-v0.json'), 'utf8'),
    );
    assert.deepEqual(published, JSON.parse(JSON.stringify(FORMULA_V0)));
  });

  // The worked examples in docs/karma-and-currency.md, with its placeholder
  // inputs. The doc rounds D, so allow 2%.
  for (const [name, inputs, V] of [
    ["Alzheimer's", { A: 7.76, S: 0.7, N: 1.2, P: 0.01, years: 15, Q: 0.8 }, 184000],
    ['Breast and lung cancer', { A: 6.68, S: 0.6, N: 0.8, P: 0.02, years: 10, Q: 0.9 }, 25300],
    ['Longevity', { A: 9.9, S: 0.1, N: 1.5, P: 0.0005, years: 20, Q: 0.5 }, 113000],
    ['Rainforest', { A: 4.3, S: 0.5, N: 1.0, P: 0.2, years: 2, Q: 0.8 }, 1460],
  ]) {
    test(`${/** @type {string} */ (name)} reproduces the documented worked example`, () => {
      const r = computeValuation(inputs);
      within(r.V, V, 0.02);
      assert.equal(r.budget, Math.round(FORMULA_V0.C * r.V));
    });
  }

  test('people is accepted in place of A', () => {
    const a = computeValuation({ A: 6, S: 0.5, N: 1, P: 0.1, years: 0, Q: 1 });
    const p = computeValuation({ people: 1e6, S: 0.5, N: 1, P: 0.1, years: 0, Q: 1 });
    assert.equal(a.budget, p.budget);
    assert.equal(a.budget, 500000000);
  });

  test('sensitivity shows which judgement drives the result', () => {
    const r = computeValuation({ A: 6, S: 0.5, N: 1, P: 0.1, years: 0, Q: 1 });
    assert.equal(r.sensitivity.P.low, r.budget / 2);
    assert.equal(r.sensitivity.P.high, r.budget * 1.5);
    // Q is already at its ceiling, so +50% is clamped.
    assert.equal(r.sensitivity.Q.high, r.budget);
    // Scale moves the population by half, not the logarithm.
    within(r.sensitivity.A.low, r.budget / 2, 1e-6);
  });

  test('every published inputs file is valid and computes', () => {
    for (const f of ['alzheimers', 'breast-lung-cancer', 'longevity', 'rainforest-example']) {
      const doc = JSON.parse(
        readFileSync(join(root, 'docs', 'valuation', 'inputs', `${f}.json`), 'utf8'),
      );
      for (const [k, v] of Object.entries(doc.inputs))
        assert.ok(v.rationale && v.source, `${f}.${k} needs a rationale and a source`);
      const inputs = extractInputs(doc);
      assert.deepEqual(validateInputs(inputs), [], f);
      assert.ok(computeValuation(inputs).budget > 0, f);
    }
  });
});

describe('validation', () => {
  const ok = { A: 6, S: 0.5, N: 1, P: 0.1, years: 5, Q: 0.8 };
  for (const [label, patch] of [
    ['S above 1', { S: 1.2 }],
    ['N below 0.5', { N: 0.4 }],
    ['N above 2', { N: 2.1 }],
    ['P negative', { P: -0.1 }],
    ['Q below 0.5', { Q: 0.3 }],
    ['negative years', { years: -1 }],
    ['A above 11', { A: 12 }],
    ['non-numeric S', { S: '0.5' }],
    ['infinite P', { P: Infinity }],
  ]) {
    test(`rejects ${/** @type {string} */ (label)}`, () => {
      assert.ok(validateInputs({ ...ok, ...patch }).length > 0);
      assert.throws(() => computeValuation({ ...ok, ...patch }));
    });
  }
  test('rejects missing factors, and A with people', () => {
    assert.ok(validateInputs({ S: 0.5 }).length > 0);
    assert.ok(validateInputs({ ...ok, people: 1000 }).length > 0);
    assert.ok(validateInputs({ ...ok, A: undefined, people: 0 }).length > 0);
    assert.ok(validateInputs(null).length > 0);
  });
  test('accepts values on the bounds', () => {
    assert.deepEqual(validateInputs({ A: 0, S: 1, N: 0.5, P: 0, years: 0, Q: 1 }), []);
  });
});

describe('two-valuer reconciliation', () => {
  test('within 3x agrees on the geometric mean', () => {
    const r = reconcile(100, 300);
    assert.equal(r.status, 'agreed');
    assert.equal(r.budget, Math.round(Math.sqrt(30000)));
    assert.equal(reconcile(1000, 1000).budget, 1000);
  });
  test('between 3x and 10x needs a third valuer', () => {
    assert.equal(reconcile(100, 301).status, 'needs_third_valuer');
    assert.equal(reconcile(100, 1000).status, 'needs_third_valuer');
  });
  test('more than 10x apart is disputed', () => {
    assert.equal(reconcile(100, 1001).status, 'disputed');
    assert.equal(reconcile(0, 5).status, 'disputed');
    assert.equal(reconcile(0, 0).status, 'agreed');
  });
  test('rejects nonsense', () => {
    assert.throws(() => reconcile(-1, 5));
    assert.throws(() => reconcile('1', 5));
  });
});

describe('digest', () => {
  test('is stable and independent of key order', () => {
    const a = { A: 6, S: 0.5, N: 1, P: 0.1, years: 5, Q: 0.8 };
    const b = { Q: 0.8, years: 5, P: 0.1, N: 1, S: 0.5, A: 6 };
    const d1 = canonicalDigest(a, computeValuation(a));
    const d2 = canonicalDigest(b, computeValuation(b));
    assert.equal(d1, d2);
    assert.match(d1, /^sha256:[0-9a-f]{64}$/);
    const c = { ...a, P: 0.2 };
    assert.notEqual(canonicalDigest(c, computeValuation(c)), d1);
  });
});

describe('routes', () => {
  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  async function withServer(fn) {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x');
      if (!(await handleValuation(req, res, url, send))) send(res, 418, {});
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await fn(base);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }
  const post = (base, path, body) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  test('formula, compute, reconcile, and refusal', async () => {
    await withServer(async (base) => {
      const f = await (await fetch(`${base}/api/valuation/formula`)).json();
      assert.equal(f.version, 'v0');

      const doc = JSON.parse(
        readFileSync(join(root, 'docs', 'valuation', 'inputs', 'alzheimers.json'), 'utf8'),
      );
      const r = await post(base, '/api/valuation/compute', doc);
      assert.equal(r.status, 200);
      const body = await r.json();
      const local = computeValuation(extractInputs(doc));
      assert.equal(body.budget, local.budget);
      assert.equal(body.digest, canonicalDigest(extractInputs(doc), local));

      assert.equal((await post(base, '/api/valuation/compute', { S: 3 })).status, 422);
      assert.equal((await post(base, '/api/valuation/compute', '{nope')).status, 400);
      assert.equal(
        (await post(base, '/api/valuation/compute', 'x'.repeat(17 * 1024)).catch(() => ({ status: 413 }))).status,
        413,
      );

      const rec = await (await post(base, '/api/valuation/reconcile', { a: 100, b: 200 })).json();
      assert.equal(rec.status, 'agreed');
      assert.equal((await post(base, '/api/valuation/reconcile', { a: -1 })).status, 422);

      assert.equal((await fetch(`${base}/api/valuation/nope`)).status, 404);
      assert.equal((await fetch(`${base}/api/other`)).status, 418);
    });
  });
});

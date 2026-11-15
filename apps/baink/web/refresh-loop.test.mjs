import test from "node:test";
import assert from "node:assert/strict";
import { createRefreshLoop, updatedAgo } from "./refresh-loop.js";

// A controllable clock, timer queue and document.
function harness() {
  let clock = 0, seq = 0;
  const timers = new Map(), listeners = new Set();
  const doc = {
    hidden: false,
    addEventListener: (_t, fn) => listeners.add(fn),
    removeEventListener: (_t, fn) => listeners.delete(fn),
  };
  const setTimer = (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: clock + ms }); return id; };
  const clearTimer = (id) => timers.delete(id);
  const flush = () => new Promise((r) => setImmediate(r));
  async function advance(ms) {
    const end = clock + ms;
    for (;;) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      timers.delete(next[0]);
      clock = next[1].at;
      next[1].fn();
      await flush();
    }
    clock = end;
    await flush();
  }
  const setHidden = async (value) => { doc.hidden = value; for (const fn of listeners) fn(); await flush(); };
  return { doc, setTimer, clearTimer, now: () => clock, advance, setHidden, listeners, timers };
}

test("reads on every interval while visible", async () => {
  const h = harness(); let runs = 0;
  const loop = createRefreshLoop({ run: async () => { runs++; }, intervalMs: 30_000, ...h });
  await h.advance(29_999); assert.equal(runs, 0);
  await h.advance(1); assert.equal(runs, 1);
  await h.advance(60_000); assert.equal(runs, 3);
  loop.stop();
  await h.advance(120_000); assert.equal(runs, 3);
  assert.equal(h.listeners.size, 0);
});

test("never reads while hidden, and reads at once when shown again if due", async () => {
  const h = harness(); let runs = 0;
  createRefreshLoop({ run: async () => { runs++; }, intervalMs: 30_000, ...h });
  await h.setHidden(true);
  await h.advance(300_000); assert.equal(runs, 0);
  await h.setHidden(false); assert.equal(runs, 1);
  await h.advance(29_000); assert.equal(runs, 1);
  await h.advance(1_000); assert.equal(runs, 2);
});

test("a read never overlaps the one still running; Refresh joins it", async () => {
  const h = harness(); let runs = 0, active = 0, maxActive = 0, release;
  const loop = createRefreshLoop({
    run: () => { runs++; active++; maxActive = Math.max(maxActive, active); return new Promise((r) => { release = () => { active--; r(); }; }); },
    intervalMs: 1_000, ...h,
  });
  await h.advance(1_000); assert.equal(runs, 1);
  const a = loop.runNow(), b = loop.runNow();
  assert.equal(a, b, "Refresh joins the read in flight");
  await h.advance(10_000); assert.equal(runs, 1, "no tick starts while one runs");
  release(); await a;
  assert.equal(maxActive, 1);
  await h.advance(1_000); assert.equal(runs, 2);
});

test("failures back off and one success resets the interval", async () => {
  const h = harness(); const at = []; let fail = true;
  createRefreshLoop({ run: async () => { at.push(h.now()); if (fail) throw Error("503"); }, intervalMs: 1_000, maxIntervalMs: 4_000, ...h });
  await h.advance(1_000 + 2_000 + 4_000 + 4_000);
  assert.deepEqual(at, [1_000, 3_000, 7_000, 11_000]);
  fail = false;
  await h.advance(4_000); // the read at 15 000 succeeds
  await h.advance(1_000);
  assert.deepEqual(at.slice(-2), [15_000, 16_000]);
});

test("a read that reports false also backs off", async () => {
  const h = harness(); const at = [];
  createRefreshLoop({ run: async () => { at.push(h.now()); return false; }, intervalMs: 1_000, ...h });
  await h.advance(7_000);
  assert.deepEqual(at, [1_000, 3_000, 7_000]);
});

test("updated-ago text", () => {
  assert.equal(updatedAgo(undefined, 0), "");
  assert.equal(updatedAgo(0, 2_000), "Updated just now");
  assert.equal(updatedAgo(0, 42_000), "Updated 42 s ago");
  assert.equal(updatedAgo(0, 180_000), "Updated 3 min ago");
});

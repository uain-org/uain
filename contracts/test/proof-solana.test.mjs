import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/ledger-1572.json', import.meta.url), 'utf8'));
const pair = generateKeyPairSync('ed25519');
const pem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
function signed(date, first, count, root = 'a'.repeat(64)) {
  const payload = { date, root, head: 'b'.repeat(64), count, first_id: first, last_id: first + count - 1 };
  return { ...payload, provisional: false, signature: sign(null, Buffer.from(JSON.stringify(payload)), pair.privateKey).toString('base64') };
}
const sha = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest();
/** The daily tree of docs/ledger.md, and the proof the server would serve for each leaf. */
function tree(leaves) {
  const levels = [leaves];
  while (levels.at(-1).length > 1) {
    const level = levels.at(-1), next = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha(level[i], level[i + 1] ?? level[i]));
    levels.push(next);
  }
  const proofFor = index => {
    const steps = []; let i = index;
    for (const level of levels.slice(0, -1)) {
      const right = i % 2 === 0;
      steps.push({ position: right ? 'right' : 'left', hash: (right ? level[i + 1] ?? level[i] : level[i - 1]).toString('hex') });
      i = Math.floor(i / 2);
    }
    return steps;
  };
  return { root: levels.at(-1)[0].toString('hex'), proofFor };
}

test('reads retry only transient failures, with growing pauses, and give up at the bound', async () => {
  const { fetchJsonRetry } = await import('../dist/http.js');
  const reply = (status, body = '{"ok":true}') => new Response(status === 200 ? body : 'x', { status });
  let calls = 0; const pauses = [];
  const statuses = [502, 504, 200];
  const value = await fetchJsonRetry('https://uain.global/api/ledger/head', async () => reply(statuses[calls++]), { delayMs: 10, sleep: async ms => { pauses.push(ms); } });
  assert.deepEqual(value, { ok: true }); assert.equal(calls, 3); assert.deepEqual(pauses, [10, 20]);
  calls = 0;
  await assert.rejects(fetchJsonRetry('https://uain.global/x', async () => { calls++; return reply(404); }, { sleep: async () => {} }), /404/);
  assert.equal(calls, 1, 'a 4xx is final');
  calls = 0;
  await assert.rejects(fetchJsonRetry('https://uain.global/x', async () => { calls++; return reply(503); }, { attempts: 3, sleep: async () => {} }), /503/);
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(fetchJsonRetry('https://uain.global/x', async () => { calls++; return reply(200, 'not json'); }, { sleep: async () => {} }), SyntaxError);
  assert.equal(calls, 1, 'invalid JSON is final');
});

test('inclusion proofs fold to the root for every position, and only for the right position', async () => {
  const { validateProof, foldProof } = await import('../dist/proof.js');
  for (let n = 1; n <= 13; n++) {
    const leaves = Array.from({ length: n }, (_, i) => sha(Buffer.from(`leaf ${n} ${i}`)));
    const t = tree(leaves);
    for (let index = 0; index < n; index++) {
      const doc = { event_id: 100 + index, leaf: leaves[index].toString('hex'), date: '2026-09-30', index, leaves: n, proof: t.proofFor(index), root: t.root, provisional: false };
      const p = validateProof(doc, 100 + index);
      assert.equal(foldProof(p), t.root, `n=${n} index=${index}`);
      if (p.proof.length) {
        const tampered = structuredClone(p); tampered.proof[0].hash = 'f'.repeat(64);
        assert.notEqual((() => { try { return foldProof(tampered); } catch { return 'refused'; } })(), t.root);
        assert.throws(() => foldProof({ ...p, proof: p.proof.slice(0, -1) }), /shorter/);
        assert.throws(() => foldProof({ ...p, proof: [...p.proof, p.proof[0]] }), /longer/);
        const flipped = structuredClone(p); flipped.proof[0].position = flipped.proof[0].position === 'left' ? 'right' : 'left';
        assert.throws(() => foldProof(flipped), /wrong side|pair with itself/);
      }
      if (n > 1) assert.throws(() => foldProof({ ...p, index: (index + 1) % n }), /wrong side|pair with itself|reach/);
    }
  }
  assert.throws(() => validateProof({ event_id: 2 }, 1), /another event/);
  assert.throws(() => validateProof({ ...fixture.proof, provisional: true }, 1572), /final/);
});

test('production event 1572 is in the signed root of 30 September, under the pinned production key', async () => {
  const { validateProof, checkInclusion } = await import('../dist/proof.js');
  const { validateRoot } = await import('../dist/root.js');
  const root = validateRoot(fixture.root, fixture.pem);
  const p = validateProof(fixture.proof, 1572);
  checkInclusion(p, root, fixture.event.hash);
  assert.throws(() => checkInclusion(p, root, 'e'.repeat(64)), /leaf/);
  assert.throws(() => checkInclusion({ ...p, event_id: root.last_id + 1 }, root, fixture.event.hash), /outside/);
  assert.throws(() => validateRoot(fixture.root, pem), /signature/, 'another key must not verify production');
});

test('base58 and compact lengths match Solana encodings', async () => {
  const { base58Encode, base58Decode, compactU16, MEMO_PROGRAM, DEVNET_GENESIS } = await import('../dist/solana.js');
  assert.equal(base58Decode(MEMO_PROGRAM, 32).length, 32);
  assert.equal(base58Encode(base58Decode(MEMO_PROGRAM)), MEMO_PROGRAM);
  assert.equal(base58Encode(base58Decode(DEVNET_GENESIS)), DEVNET_GENESIS);
  assert.equal(base58Encode(Buffer.alloc(32)), '11111111111111111111111111111111');
  assert.equal(base58Encode(Buffer.from([0, 0, 1])), '112');
  assert.deepEqual(base58Decode('112'), Buffer.from([0, 0, 1]));
  assert.throws(() => base58Decode('0OIl'), /base58/);
  for (const [n, bytes] of [[0, [0]], [127, [0x7f]], [128, [0x80, 0x01]], [16383, [0xff, 0x7f]], [16384, [0x80, 0x80, 0x01]], [65535, [0xff, 0xff, 0x03]]]) assert.deepEqual([...compactU16(n)], bytes, String(n));
});

function keyFile() {
  const kp = generateKeyPairSync('ed25519');
  const seed = kp.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const file = join(mkdtempSync(join(tmpdir(), 'uain-sol-')), 'id.json');
  writeFileSync(file, JSON.stringify([...seed, ...pub]));
  return { file, pub, publicKey: kp.publicKey };
}

test('a memo transaction is laid out and signed as a legacy Solana transaction', async () => {
  const { readMirrorKey, memoMessage, signTransaction, base58Decode, base58Encode, MEMO_PROGRAM, memoFor } = await import('../dist/solana.js');
  const k = keyFile();
  const key = readMirrorKey(k.file);
  assert.equal(key.address, base58Encode(k.pub));
  const blockhash = createHash('sha256').update('blockhash').digest();
  const memo = memoFor(signed('2026-09-30', 1323, 279));
  const message = memoMessage(key.publicKey, blockhash, memo);
  assert.deepEqual([...message.subarray(0, 4)], [1, 0, 1, 2]);
  assert.ok(message.subarray(4, 36).equals(k.pub));
  assert.ok(message.subarray(36, 68).equals(base58Decode(MEMO_PROGRAM)));
  assert.ok(message.subarray(68, 100).equals(blockhash));
  assert.deepEqual([...message.subarray(100, 104)], [1, 1, 1, 0], 'one instruction: program 1, signer 0');
  assert.equal(message.subarray(-Buffer.byteLength(memo)).toString(), memo);
  const { signature, wire } = signTransaction(key, message);
  const raw = Buffer.from(wire, 'base64');
  assert.equal(raw[0], 1); assert.ok(raw.subarray(65).equals(message));
  assert.ok(verify(null, message, k.publicKey, raw.subarray(1, 65)));
  assert.equal(signature, base58Encode(raw.subarray(1, 65)));
  assert.ok(raw.length <= 1232, 'fits in one packet');
  const bad = JSON.parse(readFileSync(k.file, 'utf8')); bad[40] ^= 1; writeFileSync(k.file, JSON.stringify(bad));
  assert.throws(() => readMirrorKey(k.file), /inconsistent/);
});

test('a mirrored memo carries the signed root and verifies with only the pinned key', async () => {
  const { memoFor, rootFromMemo, memoText, planMirror } = await import('../dist/solana.js');
  const root = signed('2026-09-30', 1323, 279);
  const memo = memoFor(root);
  assert.deepEqual(rootFromMemo(memo, pem), { ...root });
  assert.equal(rootFromMemo('hello', pem), null);
  assert.throws(() => rootFromMemo(memo.replace('count=279', 'count=278'), pem), /signature/);
  assert.throws(() => rootFromMemo(memo, generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()), /signature/);
  assert.throws(() => rootFromMemo('uain-ledger-v1 junk', pem), /malformed/);
  assert.equal(memoText(`[${Buffer.byteLength(memo)}] ${memo}`), memo);
  assert.throws(() => memoFor({ ...root, count: 0, root: null, head: null, first_id: null, last_id: null }), /empty/);
  const a = signed('2026-09-28', 1, 2), b = signed('2026-09-29', 3, 2), c = signed('2026-09-30', 5, 2);
  assert.deepEqual(planMirror([c, a, b], new Map(), 7).map(r => r.date), ['2026-09-28', '2026-09-29', '2026-09-30']);
  assert.deepEqual(planMirror([a, b, c], new Map([['2026-09-29', { root: b }]]), 7).map(r => r.date), ['2026-09-30'], 'never fills in behind the newest mirrored day');
  assert.throws(() => planMirror([a, b, c], new Map([['2026-09-29', { root: { ...b, head: 'c'.repeat(64) } }]]), 7), /conflicts/);
});

function fakePort(overrides = {}) {
  const state = { sent: [], height: 100, statuses: new Map(), memos: new Map(), balance: 1e9, genesis: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', onSend: null };
  const port = {
    genesisHash: async () => state.genesis,
    latestBlockhash: async () => ({ blockhash: '11111111111111111111111111111112', lastValidBlockHeight: state.height + 150 }),
    blockHeight: async () => state.height,
    balance: async () => state.balance,
    async send(wire) {
      const raw = Buffer.from(wire, 'base64');
      const { base58Encode } = await import('../dist/solana.js');
      const sig = base58Encode(raw.subarray(1, 65));
      state.onSend?.(sig);
      state.sent.push(sig);
      return sig;
    },
    status: async sig => state.statuses.get(sig) ?? null,
    memoOf: async sig => state.memos.get(sig) ?? null,
    history: async () => [],
    ...overrides,
  };
  return { port, state };
}

test('each day is journalled with its signature before the broadcast, confirmed by read-back, and never resent', async () => {
  const { readMirrorKey, mirrorRoots, recoverMirror, memoFor, assertDevnet } = await import('../dist/solana.js');
  const { withJournal } = await import('../dist/journal.js');
  const k = keyFile(); const key = readMirrorKey(k.file);
  const file = join(mkdtempSync(join(tmpdir(), 'uain-soljournal-')), 'solana.json');
  const roots = [signed('2026-09-28', 1, 2), signed('2026-09-29', 3, 2)];
  const { port, state } = fakePort();
  state.onSend = sig => {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    const op = Object.values(saved.operations).find(o => o.signature === sig);
    assert.equal(op?.state, 'uncertain', 'the signature is on disk before the broadcast');
    const date = Object.keys(saved.operations).find(id => saved.operations[id].signature === sig).slice(7);
    state.statuses.set(sig, { confirmed: true, failed: false });
    state.memos.set(sig, { memo: memoFor(roots.find(r => r.date === date)), signer: key.address });
  };
  await withJournal(file, j => mirrorRoots(roots, port, key, j, 'binding', async () => {}));
  assert.equal(state.sent.length, 2);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.values(saved.operations).map(o => o.state), ['confirmed', 'confirmed']);
  await assert.rejects(withJournal(file, j => mirrorRoots([roots[1]], port, key, j, 'binding', async () => {})), /already holds this day/);

  // An outcome that never arrives: the journal keeps the day uncertain, and nothing more is sent.
  const file2 = join(mkdtempSync(join(tmpdir(), 'uain-soljournal-')), 'solana.json');
  const second = fakePort();
  second.state.onSend = () => { second.state.height += 1000; };
  await assert.rejects(withJournal(file2, j => mirrorRoots([roots[0]], second.port, key, j, 'binding', async () => {})), /expired/);
  await assert.rejects(withJournal(file2, j => mirrorRoots([roots[1]], second.port, key, j, 'binding', async () => {})), /uncertain/);
  assert.equal(second.state.sent.length, 1);
  // Recovery clears it only once the blockhash has provably expired without a trace.
  let lines = await withJournal(file2, j => recoverMirror(second.port, key.address, j));
  assert.match(lines[0], /expired without landing; cleared/);
  assert.deepEqual(JSON.parse(readFileSync(file2, 'utf8')).operations, {});

  // A pending one waits; a landed one is confirmed by its memo.
  const file3 = join(mkdtempSync(join(tmpdir(), 'uain-soljournal-')), 'solana.json');
  const third = fakePort();
  third.state.onSend = () => { third.state.height += 1000; };
  await assert.rejects(withJournal(file3, j => mirrorRoots([roots[0]], third.port, key, j, 'binding', async () => {})), /expired/);
  third.state.height = 100;
  lines = await withJournal(file3, j => recoverMirror(third.port, key.address, j));
  assert.match(lines[0], /still pending/);
  const sig = third.state.sent[0];
  third.state.statuses.set(sig, { confirmed: true, failed: false });
  third.state.memos.set(sig, { memo: memoFor(roots[0]), signer: key.address });
  lines = await withJournal(file3, j => recoverMirror(third.port, key.address, j));
  assert.match(lines[0], /confirmed/);

  // Only devnet.
  await assert.rejects(assertDevnet(fakePort({ genesisHash: async () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' }).port), /devnet/);
});

test('only memos the mirror key signed count as mirrored days (audit 15 #1)', async () => {
  const { memoFor, mirroredDays, planMirror } = await import('../dist/solana.js');
  const mirror = 'Mirror1111111111111111111111111111111111111';
  const stranger = 'Stranger111111111111111111111111111111111111';
  const a = signed('2026-09-28', 1, 2), b = signed('2026-09-29', 3, 2), c = signed('2026-09-30', 5, 2);
  const { port, state } = fakePort({ history: async () => [
    { signature: 'own-a', memo: memoFor(a), failed: false },
    { signature: 'copied-c', memo: memoFor(c), failed: false },
    { signature: 'junk', memo: 'uain-ledger-v1 junk', failed: false },
    { signature: 'unrelated', memo: 'hello', failed: false },
  ] });
  state.memos.set('own-a', { memo: memoFor(a), signer: mirror });
  state.memos.set('copied-c', { memo: memoFor(c), signer: stranger });
  state.memos.set('junk', { memo: 'uain-ledger-v1 junk', signer: stranger });
  const done = await mirroredDays(port, mirror, pem);
  assert.deepEqual([...done.keys()], ['2026-09-28'], 'a copied root and a junk memo from another signer are ignored');
  assert.deepEqual(planMirror([a, b, c], done, 7).map(r => r.date), ['2026-09-29', '2026-09-30'], 'the backlog is still sent');
  state.memos.set('own-a', { memo: memoFor(b), signer: mirror });
  assert.deepEqual([...(await mirroredDays(port, mirror, pem)).keys()], [], 'a history row that differs from the landed memo is ignored');
});

test('public devnet rate limits: reads wait and retry a bounded number of times, a send is never retried (10 Nov 2026)', async () => {
  const { rpcPort } = await import('../dist/solana.js');
  const reply = (status, body, headers = {}) => ({ ok: status === 200, status, headers: new Headers(headers), text: async () => JSON.stringify(body) });
  const tx = { meta: { err: null }, transaction: { message: { accountKeys: [{ pubkey: 'Mirror1', signer: true }], instructions: [{ programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', parsed: 'uain-ledger-v1 x' }] } } };
  let calls = 0; const waits = [];
  const limited = (times, headers) => async (_url, init) => { const { method } = JSON.parse(init.body); calls++; return calls <= times ? reply(429, {}, headers) : reply(200, { result: method === 'sendTransaction' ? 'sig' : tx }); };
  let port = rpcPort('https://rpc.example', limited(3), 1000, async ms => { waits.push(ms); });
  assert.deepEqual(await port.memoOf('s'), { memo: 'uain-ledger-v1 x', signer: 'Mirror1' }, 'the read succeeds after three 429 answers');
  assert.deepEqual(waits, [1000, 2000, 4000], 'it backs off');
  calls = 0; waits.length = 0;
  port = rpcPort('https://rpc.example', limited(1, { 'retry-after': '3' }), 1000, async ms => { waits.push(ms); });
  await port.memoOf('s');
  assert.deepEqual(waits, [3000], 'Retry-After is honoured');
  calls = 0; waits.length = 0;
  port = rpcPort('https://rpc.example', limited(1), 1000, async ms => { waits.push(ms); });
  await assert.rejects(port.send('wire'), /sendTransaction failed \(429\)/);
  assert.equal(calls, 1, 'a send is one attempt'); assert.deepEqual(waits, []);
  calls = 0;
  port = rpcPort('https://rpc.example', limited(100), 1000, async () => {});
  await assert.rejects(port.memoOf('s'), /getTransaction failed \(429\)/);
  assert.equal(calls, 7, 'reads give up after six retries');
});

test('the CLI accepts the new commands and refuses a send where none exists', async () => {
  const { parseArguments } = await import('../dist/cli.js');
  assert.deepEqual(parseArguments(['prove', '--id', '1572']).values, { id: '1572' });
  assert.equal(parseArguments(['solana-mirror', '--limit', '3', '--send']).send, true);
  assert.throws(() => parseArguments(['solana-audit', '--send']), /flags/);
  assert.throws(() => parseArguments(['prove', '--send']), /flags/);
  assert.throws(() => parseArguments(['solana-recover', '--date', '2026-09-30']), /option/);
});

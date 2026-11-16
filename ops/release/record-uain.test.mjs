import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, recordFor } from './record-uain.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha = (c) => c.repeat(40);

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'record-uain-')));
  fs.mkdirSync(path.join(root, 'docs/releases/uain'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ops/docs'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'ops/docs/render-status.mjs'), path.join(root, 'ops/docs/render-status.mjs'));
  const base = recordFor({ run: 1, sha: sha('a'), at: '2026-11-09T03:18:40Z', prior: null });
  fs.writeFileSync(path.join(root, 'docs/releases/uain/aaaaaaaa.json'), JSON.stringify(base));
  fs.writeFileSync(path.join(root, 'docs/releases/current.json'), JSON.stringify({ schema: 1, current: { uain: 'aaaaaaaa' } }));
  return root;
}

// Fake gh: run 2 recorded, run 3 failed at apply, run 4 prose (deploy skipped), run 5 recorded.
const runs = [
  { databaseId: 2, headSha: sha('b'), conclusion: 'success', createdAt: '2026-11-09T05:40:00Z' },
  { databaseId: 3, headSha: sha('c'), conclusion: 'failure', createdAt: '2026-11-09T06:00:00Z' },
  { databaseId: 4, headSha: sha('d'), conclusion: 'success', createdAt: '2026-11-09T06:30:00Z' },
  { databaseId: 5, headSha: sha('e'), conclusion: 'success', createdAt: '2026-11-09T07:00:00Z' },
];
const jobs = {
  2: [{ name: 'deploy', conclusion: 'success', steps: [{ name: 'Record the release', conclusion: 'success', completedAt: '2026-11-09T05:49:09Z' }] }],
  4: [{ name: 'deploy', conclusion: 'skipped', steps: [] }],
  5: [{ name: 'deploy', conclusion: 'success', steps: [{ name: 'Record the release', conclusion: 'success', completedAt: '2026-11-09T07:10:00Z' }] }],
};
const fakeGh = (args) => (args[1] === 'list' ? runs : { jobs: jobs[args[2]] ?? [] });

test('check reports a stale pointer and sync records only recorded deploys, in order', () => {
  const root = fixture();
  const log = [];
  assert.equal(main(['--check'], { root, run: fakeGh, log: (s) => log.push(s) }), 1);
  assert.match(log[0], /2 newer deploy/);
  assert.equal(main(['--sync'], { root, run: fakeGh, log: () => {} }), 0);
  const current = JSON.parse(fs.readFileSync(path.join(root, 'docs/releases/current.json'), 'utf8'));
  assert.equal(current.current.uain, 'eeeeeeee');
  const e = JSON.parse(fs.readFileSync(path.join(root, 'docs/releases/uain/eeeeeeee.json'), 'utf8'));
  assert.equal(e.prior, 'bbbbbbbb');
  assert.equal(e.status, 'deployed');
  assert.ok(!fs.existsSync(path.join(root, 'docs/releases/uain/cccccccc.json')));
  assert.ok(!fs.existsSync(path.join(root, 'docs/releases/uain/dddddddd.json')));
  assert.match(fs.readFileSync(path.join(root, 'docs/releases/CURRENT.md'), 'utf8'), /eeeeeeee/);
  assert.equal(main(['--check'], { root, run: fakeGh, log: () => {} }), 0);
});

test('record writes one deploy with the pointer as prior and is idempotent', () => {
  const root = fixture();
  const argv = ['--record', '--run', '9', '--sha', sha('f'), '--at', '2026-11-09T08:00:00Z'];
  assert.equal(main(argv, { root, run: () => assert.fail('no gh'), log: () => {} }), 0);
  assert.equal(main(argv, { root, run: () => assert.fail('no gh'), log: () => {} }), 0);
  const f = JSON.parse(fs.readFileSync(path.join(root, 'docs/releases/uain/ffffffff.json'), 'utf8'));
  assert.equal(f.prior, 'aaaaaaaa');
  assert.equal(f.evidence[0], 'https://github.com/nuah-org/uain-universa/actions/runs/9');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'docs/releases/current.json'), 'utf8')).current.uain, 'ffffffff');
});

test('an older record never moves the pointer back; bad input is refused', () => {
  const root = fixture();
  main(['--record', '--run', '9', '--sha', sha('f'), '--at', '2026-11-09T08:00:00Z'], { root, log: () => {} });
  main(['--record', '--run', '8', '--sha', sha('9'), '--at', '2026-11-09T07:00:00Z'], { root, log: () => {} });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'docs/releases/current.json'), 'utf8')).current.uain, 'ffffffff');
  assert.throws(() => recordFor({ run: 'x; rm', sha: sha('f'), at: '2026-11-09T08:00:00Z' }));
  assert.throws(() => recordFor({ run: 1, sha: 'abc', at: '2026-11-09T08:00:00Z' }));
});

test('an unreadable GitHub is unknown, not current', () => {
  const root = fixture();
  const fail = () => { throw Object.assign(new Error('offline'), { code: 'gh' }); };
  assert.equal(main(['--check'], { root, run: fail, log: () => {} }), 3);
});

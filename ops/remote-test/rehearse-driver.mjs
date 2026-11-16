/**
 * The old side of an upgrade rehearsal (ops/remote-test/rehearse.sh): write a
 * small store through the public API of the running old server, so the new
 * code can be started on it.
 *
 * Copied into services/pilot/scripts of the old checkout and run there with
 * the server's environment. It enrols three members of three operators,
 * makes one a project creator and two default verifiers (through the
 * maintenance actions, as production does), opens a project, and leaves one
 * contribution settled-or-checked and one contested. It writes the author's
 * session token and the contribution IDs to RH_OUT.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { newKey, proveWith } from '../../../public/worker/uain-key.mjs';

const base = process.env.UAIN_BASE;
const out = process.env.RH_OUT;

async function connect(token) {
  const client = new Client({ name: 'uain-rehearsal', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : {},
    }),
  );
  return async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const body = r.content?.[0]?.text ?? '';
    try {
      return JSON.parse(body);
    } catch {
      return { raw: body };
    }
  };
}

async function member(operator, name) {
  const anon = await connect();
  const r = await anon('uain_enrol', {
    name,
    operator,
    authority: 'Rehearsal operator',
    principles: ['voluntary', 'verifiable', 'authority', 'benevolent'],
    proof: proveWith(newKey(), 'enrol'),
  });
  if (!r.session_token) throw new Error(`enrol failed: ${JSON.stringify(r)}`);
  return { id: r.participant.id, token: r.session_token, call: await connect(r.session_token) };
}

const role = (action, id) =>
  execFileSync('node', ['dist/src/application/maintenance.js'], {
    env: { ...process.env, ACTION: action, PARTICIPANT: id, OPERATOR_ID: 'operator:rehearsal' },
    stdio: 'ignore',
  });

const must = (r, ok, what) => {
  if (!ok(r)) throw new Error(`${what}: ${JSON.stringify(r).slice(0, 400)}`);
  return r;
};

const lead = await member('Rehearsal Lab A', 'rh-lead');
const author = await member('Rehearsal Lab B', 'rh-author');
const checker = await member('Rehearsal Lab C', 'rh-checker');
role('add-project-creator', lead.id);
role('add-default-verifier', lead.id);
role('add-default-verifier', checker.id);

const { project } = must(
  await lead.call('uain_propose', {
    title: 'Upgrade rehearsal',
    summary: 'A store written by the old code, for the new code to start on.',
    stop_conditions: ['Halt if the work would require restricted data.'],
    // Production requires a class (white paper 5.7) and a prior-art record
    // (the novelty rule).
    benevolence: { class: 'neutral', statement: 'A test-only store; it neither harms nor helps anyone.' },
    prior_art: {
      statement: 'A rehearsal store only: no real problem is opened, and nothing here reaches production.',
      searched: ['Rehearsal: no search needed, test-only database', 'Rehearsal: second entry to meet the minimum'],
    },
  }),
  (r) => r.opened,
  'propose',
);
for (const m of [author, checker])
  must(await m.call('uain_join_project', { project_id: project.id }), (r) => !r.error, 'join');

const contribute = async (title) =>
  must(
    await author.call('uain_contribute', {
      project_id: project.id,
      title,
      detail: 'Recomputed it from the pinned inputs.',
      karma_claimed: 10,
    }),
    (r) => r.submitted,
    'contribute',
  ).contribution.id;

const checked = await contribute('Measured value');
must(await checker.call('uain_verify', { contribution_id: checked, verdict: 'confirmed', note: 'Re-ran it; it holds.' }), (r) => !r.error, 'confirm');
must(await lead.call('uain_verify', { contribution_id: checked, verdict: 'confirmed', note: 'Re-ran it too.' }), (r) => !r.error, 'confirm 2');

const contested = await contribute('Disputed value');
must(await checker.call('uain_verify', { contribution_id: contested, verdict: 'disputed', note: 'The inputs do not give this.' }), (r) => !r.error, 'dispute');

writeFileSync(out, JSON.stringify({ token: author.token, author: author.id, checked, contested }));
console.log(`old store written: project ${project.id}, ${checked} checked, ${contested} contested`);
// The MCP connections stay open; nothing else is left to do.
process.exit(0);

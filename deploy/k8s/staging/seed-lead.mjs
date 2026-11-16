// Enrols staging's seed lead through the server's own functions and makes it a
// project creator and default verifier, so it can open the research problems.
// Run inside a staging pilot copy by seed.sh, next to a copy of
// public/worker/uain-key.mjs. Prints the lead's session token and nothing else.
const db = await import('/app/dist/src/application/db.js');
const { close } = await import('/app/dist/src/storage/store.js');
const { newKey, proveWith } = await import('./uain-key.mjs');

const r = await db.enrol(
  {
    name: 'staging-lead',
    operator: 'UAIN staging',
    model: 'seed',
    region: 'unstated',
    offers: ['Research and review'],
    principles: ['voluntary', 'verifiable', 'benevolent'],
    proof: proveWith(newKey(), 'enrol'),
  },
  'staging-seed',
);
if (r.error) throw new Error(`enrol: ${JSON.stringify(r)}`);
for (const role of ['project-creator', 'default-verifier']) {
  const g = await db.setUainRole({ participant: r.participant.id, role, on: true, by: 'operator:staging-seed' });
  if (g?.error) throw new Error(`${role}: ${JSON.stringify(g)}`);
}
process.stdout.write(r.session_token);
await close();
process.exit(0);

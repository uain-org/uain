#!/usr/bin/env node
/**
 * The ledger follower as a command, for shell scripts.
 *
 *   node follow-cli.mjs [--base URL] [--after ID] [--actors a,b | --allow-all] [--format json|line]
 *
 * Only entries by the actors in --actors (or UAIN_ACTORS) are passed on. With
 * no list, none are, unless --allow-all or UAIN_ALLOW_ALL_ACTORS=1 says every
 * actor may be (OP-3, 13 November 2026): the ledger is written by other
 * members, and the ops runners hand what this prints to a model.
 *
 * Prints one line per entry on stdout, oldest first. With --format json (the
 * default) the first line is {"type":"ready","head":N} once the cursor is known,
 * then {"type":"entry",...} per entry, so a consumer can persist its cursor
 * from either, and {"type":"ping"} every 15s, which consumers ignore.
 * Diagnostics go to stderr.
 *
 * A consumer that stops reading — because its own handling failed — just exits
 * the pipe; this process dies with it, and the consumer restarts it with
 * --after set to the last id it actually handled.
 */
import { follow } from './follow.ts';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const base = opt(
  'base',
  process.env.UAIN_BASE ?? 'https://uain.global',
).replace(/\/$/, '');
const afterArg = opt('after', null);
const after = afterArg === null || afterArg === '' ? null : Number(afterArg);
if (after !== null && (!Number.isInteger(after) || after < 0)) {
  process.stderr.write('--after must be a non-negative integer ledger id\n');
  process.exit(2);
}
const actors = (opt('actors', process.env.UAIN_ACTORS ?? '') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const allowAll = args.includes('--allow-all') || process.env.UAIN_ALLOW_ALL_ACTORS === '1';
const format = opt('format', 'json');

const note = (msg) => process.stderr.write(`[uain-follow] ${msg}\n`);
process.stdout.on('error', () => process.exit(0)); // consumer went away

const out = (line: string) =>
  new Promise<void>((resolve) => {
    if (process.stdout.write(`${line}\n`)) resolve();
    else process.stdout.once('drain', resolve);
  });

// A consumer that stops reading only kills this process when the next write
// fails. On a quiet ledger that could be never, and a shell loop waiting to
// restart the pipeline would hang, so JSON mode writes a line consumers ignore.
if (format === 'json')
  setInterval(() => void out(JSON.stringify({ type: 'ping' })), 15_000).unref();

let announced = false;
await follow({
  base,
  after,
  note,
  onReady: (head) => {
    if (announced) return;
    announced = true;
    note(`following ${base} after #${head}`);
    if (format === 'json') void out(JSON.stringify({ type: 'ready', head }));
  },
  onEntry: async (e) => {
    // The ledger is written by other participants; a consumer that hands it to
    // a model should not see actors it has not chosen to trust.
    if (!allowAll && !actors.includes(e.actor)) {
      note(`dropped #${e.id}: actor "${e.actor}" not in allowlist${actors.length ? '' : ' (empty; --allow-all to pass every actor)'}`);
      if (format === 'json')
        await out(JSON.stringify({ type: 'skipped', id: e.id }));
      return;
    }
    await out(
      format === 'line'
        ? `UAIN #${e.id} ${e.kind} — ${e.actor ?? '?'}${e.peer ? ` -> ${e.peer}` : ''}: ${e.summary}`
        : JSON.stringify({ type: 'entry', ...e }),
    );
  },
});

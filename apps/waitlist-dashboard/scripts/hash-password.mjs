/**
 * Prints the scrypt hash of a password, for WAITLIST_ADMIN_PASSWORD_HASH.
 *
 *   npm run --silent hash-password            # asks twice, without echo
 *   printf %s "$PASSWORD" | npm run --silent hash-password
 *
 * Piped input is taken whole, less one trailing newline. `--n <N>` sets the
 * scrypt cost (a power of two, at least 16384; default 65536).
 */
import { DEFAULT_PARAMS, hashPassword } from '../src/auth.js';

const MIN_LENGTH = 12;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function readPiped() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

/** One line from the terminal, not echoed. */
function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    process.stderr.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    let text = '';
    const done = (err) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
      process.stderr.write('\n');
      if (err) reject(err);
      else resolve(text);
    };
    const onData = (chars) => {
      for (const ch of chars) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') text = text.slice(0, -1);
        else if (ch >= ' ') text += ch;
      }
    };
    input.on('data', onData);
  });
}

try {
  let password;
  if (process.stdin.isTTY) {
    password = await readHidden('Admin password: ');
    const again = await readHidden('Again: ');
    if (again !== password) throw new Error('the two passwords differ');
  } else {
    password = await readPiped();
  }
  if (password.length < MIN_LENGTH)
    throw new Error(
      `use at least ${MIN_LENGTH} characters; a long passphrase is best`,
    );
  const N = arg('--n') === undefined ? DEFAULT_PARAMS.N : Number(arg('--n'));
  process.stdout.write(`${await hashPassword(password, { N })}\n`);
} catch (err) {
  process.stderr.write(`hash-password: ${err.message}\n`);
  process.exit(1);
}

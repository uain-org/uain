/**
 * The files that fix who this server is: the ledger's signing key and the log
 * salt. Every copy of the server shares one data directory (compose.yaml runs
 * four), and every copy must sign and hash with the same key and salt, so
 * each file is made once, by whichever copy gets there first, and is never
 * replaced after.
 *
 * On a fresh directory the copies race to make it. Each writes a candidate to
 * a file of its own, then links it to the real name. A link fails if the name
 * is taken, so exactly one candidate wins, and it is complete before anyone
 * can see it. The others discard theirs and load the winner.
 *
 * A file that is there but does not load is never made again: a new key would
 * sign as a different server, and a new salt would sign every agent out. It is
 * read again for a moment, in case a server that writes it in place (versions
 * before this one did) is still writing it, and then refused.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// About a second for a file that does not load to finish being written.
const TRIES = 20;
const PAUSE_MS = 50;

const code = (e: unknown) => (e as NodeJS.ErrnoException).code;

function readIfThere(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if (code(e) === 'ENOENT') return null;
    throw e;
  }
}

function syncDirectory(dir: string): void {
  // Windows cannot open a directory to flush it.
  if (process.platform === 'win32') return;
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Puts `content` at `path` unless something is there already. */
function publish(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const candidate = `${path}.${process.pid}.${randomBytes(6).toString('hex')}`;
  // Private from the start, as the file it may become must be.
  const fd = openSync(candidate, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    linkSync(candidate, path);
  } catch (e) {
    // Another copy got there first: its file is the one to load.
    if (code(e) !== 'EEXIST') throw e;
  } finally {
    unlinkSync(candidate);
  }
  // The name has to survive a crash before anything is signed or hashed with it.
  syncDirectory(dir);
}

/**
 * The file at `path`, loaded by `parse`, which throws on anything it would not
 * accept. When nothing is there, `make` makes it first. Every process calling
 * this on one directory gets what one of them made.
 */
export async function identityFile<T>(
  path: string,
  make: () => string,
  parse: (text: string) => T,
): Promise<T> {
  let text = readIfThere(path);
  if (text === null) {
    publish(path, make());
    text = readFileSync(path, 'utf8');
  }
  for (let tries = 1; ; tries++) {
    try {
      return parse(text);
    } catch (e) {
      if (tries === TRIES)
        throw new Error(
          `${path} exists but cannot be loaded (${(e as Error).message}). It will not be replaced, ` +
            'since everything made with it would stop matching; restore it from a backup.',
        );
    }
    await sleep(PAUSE_MS);
    text = readFileSync(path, 'utf8');
  }
}

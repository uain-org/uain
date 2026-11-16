// Disposable acceptance only: exercise the installed signed entry point using
// fictional identities. All private action inputs travel on stdin, never argv.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { runPrivateAction } from '../client/private-cli.mjs';

export async function installedPrivateAction({ entry, sha256 }, action, input) {
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('installed client pin required');
  entry = resolve(entry);
  if (createHash('sha256').update(await readFile(entry)).digest('hex') !== sha256) throw new Error('installed client differs from its pin');
  const bytes = Buffer.from(JSON.stringify(input));
  try {
    if (bytes.length > 65536) throw new Error('bounded installed client input required');
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [entry, 'private', action], { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', overflow = false;
      const timer = setTimeout(() => child.kill('SIGKILL'), 610000);
      child.stderr.resume();
      child.stdout.on('data', data => { output += data; if (Buffer.byteLength(output) > 65536) { overflow = true; child.kill('SIGKILL'); } });
      child.stdin.on('error', () => {});
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => {
        clearTimeout(timer);
        if (code !== 0 || overflow) return reject(new Error('installed private client action refused or unbounded'));
        try { resolve(JSON.parse(output)); } catch { reject(new Error('installed private client output refused')); }
      });
      child.stdin.end(bytes);
    });
  } finally { bytes.fill(0); }
}

export function fixturePrivateAction(action, input) {
  const entry = process.env.UAIN_INSTALLED_PRIVATE_CLIENT;
  return entry ? installedPrivateAction({ entry, sha256: process.env.UAIN_INSTALLED_PRIVATE_CLIENT_SHA256 }, action, input) : runPrivateAction(action, input);
}

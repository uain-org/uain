// Process and network adapters. Every effect goes through an injected
// dependency so tests can prove what a command does and does not run.
import { spawn } from 'node:child_process';

const SENSITIVE =
  /KEY|TOKEN|SECRET|PASS|PRIVATE|AUTH|COOKIE|CREDENTIAL|MNEMONIC|SEED/i;

/** Masks sensitive environment values and NAME=value pairs in text. */
export function redact(text, env = process.env) {
  let out = String(text ?? '');
  for (const [name, value] of Object.entries(env))
    if (SENSITIVE.test(name) && typeof value === 'string' && value.length >= 6)
      out = out.split(value).join('[redacted]');
  return out.replace(
    /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASS|PRIVATE|AUTH|COOKIE|CREDENTIAL)[A-Z0-9_]*)=\S+/gi,
    '$1=[redacted]',
  );
}

/** Spawns without a shell. Returns {code, stdout, stderr}; never rejects on exit code. */
export function spawnProcess(command, args, { timeoutMs = 600_000, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) =>
      resolve({ code: 127, stdout, stderr: stderr + error.message }),
    );
    child.on('close', (code, signal) =>
      resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr }),
    );
  });
}

const READ_ONLY_GIT = new Set(['rev-parse', 'status', 'diff', 'ls-files']);

/**
 * Read-only wrapper for planning: only `git rev-parse|status|diff|ls-files`.
 * Anything else (ssh, scp, systemctl, git push…) throws before spawning.
 */
export function readOnlySpawner(spawner) {
  return (command, args, options) => {
    if (command !== 'git' || !READ_ONLY_GIT.has(args[0]))
      throw Object.assign(
        new Error(`Planning is read-only; refused to run ${command}.`),
        { code: 'plan_mutation_refused' },
      );
    return spawner(command, args, options);
  };
}

/** HEAD/GET probe of a public URL: {status, release, ok, body}. */
export async function probe(url, releaseHeader, { fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return {
      status: response.status,
      release: response.headers.get(releaseHeader),
      body,
    };
  } catch (error) {
    return { status: 0, release: null, body: null, error: error.message };
  }
}

export const defaultDeps = () => ({
  spawn: spawnProcess,
  fetch: (url, header) => probe(url, header),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date().toISOString(),
  env: process.env,
});

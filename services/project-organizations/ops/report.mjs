#!/usr/bin/env node
/** Writes the operational-readiness and reward-acceptance reports from real adapters.
 *
 *   node services/project-organizations/ops/report.mjs --adapters <module.mjs> --config <config.json>
 *
 * The adapters module is operator-owned; `ops/adapters.example.mjs` is the reviewed template
 * (copy it into the operator's root-owned release, do not run it from a writable checkout).
 * Its `createAdapters(config)` (or default export) returns, possibly asynchronously:
 *   {selection, registry, journal, native, paperclip, leadershipStore, scheduler,
 *    accountReader, production: {chainId, genesisSha256?}, outputDirectory, close?()}
 * built only from the config object, which is read from the `--config` path given on argv
 * and nowhere else (no environment, no default path). Both the config and the module are
 * refused when symlinked, group/world-writable, multiply linked, owned by another non-root
 * user, or under a world-writable non-sticky directory. Without both the CLI refuses with
 * `adapters_not_configured`: it never guesses hosts, keys, chain pins or paths, and it
 * performs only reads (native/Paperclip/account readback) plus the local report write.
 */
import { constants, lstatSync, openSync, closeSync, fstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bootstrapHoldsFrom, buildAcceptance, writeReports } from '../src/acceptance.mjs';
import { fileURLToPath } from 'node:url';
/** Reviewed prior-art holds (`<id>.hold.json`), committed with the reviews. */
export const BOOTSTRAP_REVIEWED_DIR = fileURLToPath(new URL('../../../docs/baink/project-organizations-2026-11-06/bootstrap-reviewed/', import.meta.url));
import { collectStatus } from '../src/status.mjs';
import { OrganizationError, need, plain, refuse } from '../src/common.mjs';

export const MAX_CONFIG_BYTES = 65536;

/** Refuses a path that is symlinked anywhere, or sits under a world-writable non-sticky
 * directory. Returns the absolute path. */
export function trustedPath(path, { code = 'config' } = {}) {
  need(typeof path === 'string' && path.length > 0 && path.length <= 4096 && !path.includes('\0'), `${code}_untrusted`, 'path');
  const absolute = resolve(path);
  let real;
  try {
    real = realpathSync(absolute);
  } catch {
    refuse(`${code}_unreadable`, 'path does not resolve');
  }
  need(real === absolute, `${code}_symlinked`, 'the path or one of its directories is a symbolic link');
  for (let dir = dirname(absolute); ; dir = dirname(dir)) {
    const st = lstatSync(dir);
    need(st.isDirectory() && !st.isSymbolicLink(), `${code}_symlinked`);
    need(!(st.mode & 0o002) || (st.mode & 0o1000) !== 0, `${code}_untrusted`, `${dir} is world-writable without the sticky bit`);
    if (dirname(dir) === dir) break;
  }
  return absolute;
}

/** Reads one operator file: absolute, not symlinked, a single-link regular file owned by
 * root or this user, not group/world-writable, at most `maxBytes`. */
export function trustedFile(path, { maxBytes = MAX_CONFIG_BYTES, code = 'config' } = {}) {
  const absolute = trustedPath(path, { code });
  let fd;
  try {
    fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    refuse(error?.code === 'ELOOP' ? `${code}_symlinked` : `${code}_unreadable`);
  }
  try {
    const st = fstatSync(fd);
    need(st.isFile() && st.nlink === 1, `${code}_untrusted`, 'not a single-link regular file');
    need((st.mode & 0o022) === 0, `${code}_untrusted`, 'group- or world-writable');
    const uid = typeof process.getuid === 'function' ? process.getuid() : st.uid;
    need(st.uid === 0 || st.uid === uid, `${code}_untrusted`, 'owned by another user');
    need(st.size <= maxBytes, `${code}_too_large`);
    const bytes = readFileSync(fd);
    need(bytes.length === st.size, `${code}_changed`);
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/** The operator config object from a trusted JSON file. */
export function loadConfig(path) {
  const bytes = trustedFile(path, { code: 'config' });
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    refuse('config_invalid', 'config is not JSON');
  }
  need(plain(value), 'config_invalid', 'config must be a JSON object');
  return value;
}

/** collectStatus -> buildAcceptance -> writeReports. Returns the written paths and a summary. */
export async function produceReports(adapters, { generatedAt = new Date().toISOString() } = {}) {
  need(plain(adapters), 'adapters_not_configured');
  const { production = null, outputDirectory, selection, registry, journal, native, paperclip, leadershipStore, scheduler, accountReader } = adapters;
  need(typeof outputDirectory === 'string' && isAbsolute(outputDirectory), 'adapters_not_configured', 'an absolute outputDirectory is required');
  need(production === null || (plain(production) && typeof production.chainId === 'string' && production.chainId.length > 0), 'adapters_not_configured',
    'production must pin a chainId (or be null, which reports native cells unknown)');
  const inputs = await collectStatus({
    selection, registry: registry ?? null, journal: journal ?? null, native: native ?? null, paperclip: paperclip ?? null,
    leadershipStore: leadershipStore ?? null, scheduler: scheduler ?? null, accountReader: accountReader ?? null,
  });
  const bootstrapHolds = bootstrapHoldsFrom(adapters.bootstrapReviewedDirectory ?? BOOTSTRAP_REVIEWED_DIR, selection);
  const acceptance = buildAcceptance({ ...inputs, production, bootstrapHolds, generatedAt });
  const paths = writeReports(outputDirectory, acceptance);
  return {
    paths,
    errors: inputs.errors,
    summary: {
      operational: { complete: acceptance.operationalReadiness.complete, rows: acceptance.operationalReadiness.counts.rows },
      reward: { complete: acceptance.rewardAcceptance.complete, rows: acceptance.rewardAcceptance.counts.rows },
      stages: acceptance.operationalReadiness.stages,
    },
  };
}

/** Exactly `--adapters <module> --config <file>`, in either order. */
export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 4) return null;
  const out = {};
  for (let i = 0; i < 4; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!['--adapters', '--config'].includes(flag) || Object.hasOwn(out, flag) || typeof value !== 'string' || value.startsWith('--')) return null;
    out[flag] = value;
  }
  return { modulePath: out['--adapters'], configPath: out['--config'] };
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const say = (value) => stdout.write(JSON.stringify(value) + '\n');
  const args = parseArgs(argv);
  if (!args) {
    say({ refused: 'adapters_not_configured', detail: 'pass --adapters <operator module> --config <operator config>; no defaults exist' });
    return 2;
  }
  let adapters;
  try {
    const config = loadConfig(args.configPath);
    trustedFile(args.modulePath, { code: 'adapters_module', maxBytes: 1048576 });
    const mod = await import(pathToFileURL(trustedPath(args.modulePath, { code: 'adapters_module' })).href);
    const create = mod.createAdapters ?? mod.default;
    if (typeof create !== 'function') {
      say({ refused: 'adapters_not_configured', detail: 'module exports no createAdapters()' });
      return 2;
    }
    adapters = await create(config);
    const result = await produceReports(adapters);
    say({ written: result.paths, summary: result.summary, readFailures: result.errors.length });
    return 0;
  } catch (e) {
    if (!(e instanceof OrganizationError)) throw e;
    say({ refused: e.code });
    return 2;
  } finally {
    await adapters?.close?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();

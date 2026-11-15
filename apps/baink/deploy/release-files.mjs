// The file walk the BAINK release packager uses (package-release.mjs), kept apart so it can be
// tested (12 November 2026). On 11 November a first 0.3.91 package carried a local
// shared/__pycache__ folder and was discarded before promote; the packager now refuses to build
// when the tree holds local junk, naming the path, instead of relying on someone noticing.
import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';

/** Local files that must never ship, each with the plain reason given when one is found. */
const JUNK = [
  [(name, dir) => dir && name === '__pycache__', 'a Python cache folder'],
  [(name) => /\.py[co]$/i.test(name), 'a compiled Python file'],
  [(name) => name === '.DS_Store', 'a macOS folder-view file'],
  [(name) => name.startsWith('._'), 'a macOS resource-fork file (AppleDouble)'],
];

/** Why this entry is local junk, or null. `directory` says whether the entry is a folder. */
export function junkReason(name, directory = false) {
  for (const [match, why] of JUNK) if (match(name, directory)) return why;
  return null;
}

export class ReleaseTreeError extends Error {
  constructor(message, path) {
    super(message);
    this.name = 'ReleaseTreeError';
    this.path = path;
  }
}

/**
 * Every regular file under `folder`, as [name relative to it, absolute path], in directory
 * order. `label` is how the folder is named in a refusal (for example "shared"). Refuses,
 * naming the path: local junk (above), other hidden names, key and certificate files,
 * symlinks and anything that is not a file or folder.
 */
export async function collectReleaseFiles(folder, label = '.', prefix = '') {
  const rows = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name),
      name = prefix + entry.name,
      shown = `${label}/${name}`;
    const info = await lstat(path);
    const junk = junkReason(entry.name, info.isDirectory());
    if (junk)
      throw new ReleaseTreeError(
        `Release refused: ${shown} is ${junk}, which must not be packaged. Delete it (git clean -ndX lists ignored local files) and package again.`,
        shown,
      );
    if (entry.name.startsWith('.') || /\.(?:pem|key|p12|pfx)$/i.test(entry.name))
      throw new ReleaseTreeError(`Release refused: ${shown} is a hidden or secret artifact, which is not permitted.`, shown);
    if (info.isSymbolicLink()) throw new ReleaseTreeError(`Release refused: ${shown} is a symlink; release symlinks are not allowed.`, shown);
    if (info.isDirectory()) rows.push(...(await collectReleaseFiles(path, label, name + '/')));
    else if (info.isFile()) rows.push([name, path]);
    else throw new ReleaseTreeError(`Release refused: ${shown} is not a regular file or folder.`, shown);
  }
  return rows;
}

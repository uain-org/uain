// Deterministic release archives (ustar + gzip) and a strict reader.
//
// The writer replaces the manual macOS `tar` step, which added AppleDouble
// `._*` files and extended attributes that activate-release.py refuses.
// Entries are sorted, owned by 0:0, mode 0644/0755, with one fixed mtime and a
// fixed gzip header, so the same directory and mtime give the same bytes on
// the same Node version.
import { readdir, lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const BLOCK = 512;
const RECORD = BLOCK * 20;

export const sha256 = (bytes) =>
  createHash('sha256').update(bytes).digest('hex');

/** True for macOS metadata or hidden names that must never ship. */
export function forbiddenName(name) {
  return name
    .split('/')
    .some(
      (part) =>
        part.startsWith('._') ||
        part === '.DS_Store' ||
        part === '__MACOSX' ||
        (part.startsWith('.') && part !== '.'),
    );
}

/** Walks a release directory; refuses symlinks, specials and hidden names. */
export async function listTree(root, prefix = '') {
  const rows = [];
  const entries = (await readdir(join(root, prefix), { withFileTypes: true }))
    .map((entry) => entry.name)
    .sort();
  for (const entry of entries) {
    const name = prefix ? prefix + '/' + entry : entry;
    if (forbiddenName(name))
      throw new ReleaseError(
        'forbidden_entry',
        `Hidden or AppleDouble entry ${JSON.stringify(name)} is not permitted.`,
      );
    const info = await lstat(join(root, name));
    if (info.isSymbolicLink())
      throw new ReleaseError('symlink', `Release symlink ${name} refused.`);
    if (info.isDirectory()) {
      rows.push({ name, type: 'dir' });
      rows.push(...(await listTree(root, name)));
    } else if (info.isFile())
      rows.push({ name, type: 'file', size: info.size });
    else throw new ReleaseError('special_file', `Unsupported entry ${name}.`);
  }
  return rows;
}

export class ReleaseError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function octal(value, length) {
  const text = value.toString(8);
  if (text.length > length - 1)
    throw new ReleaseError('archive_field', 'Archive field overflow.');
  return text.padStart(length - 1, '0') + '\0';
}

function splitName(name) {
  if (Buffer.byteLength(name) <= 100) return ['', name];
  for (let index = name.lastIndexOf('/'); index > 0;) {
    const prefix = name.slice(0, index),
      rest = name.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100)
      return [prefix, rest];
    index = name.lastIndexOf('/', index - 1);
  }
  throw new ReleaseError('long_name', `Path too long for ustar: ${name}`);
}

function header({ name, type, size, mtime }) {
  const block = Buffer.alloc(BLOCK);
  const [prefix, base] = splitName(type === 'dir' ? name + '/' : name);
  block.write(base, 0, 100, 'utf8');
  block.write(octal(type === 'dir' ? 0o755 : 0o644, 8), 100, 'ascii');
  block.write(octal(0, 8), 108, 'ascii');
  block.write(octal(0, 8), 116, 'ascii');
  block.write(octal(type === 'dir' ? 0 : size, 12), 124, 'ascii');
  block.write(octal(mtime, 12), 136, 'ascii');
  block.fill(0x20, 148, 156);
  block.write(type === 'dir' ? '5' : '0', 156, 'ascii');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  block.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return block;
}

/** Release id stamp (YYYYMMDDTHHMMSSZ-…) to epoch seconds. */
export function releaseEpoch(release) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(release);
  if (!match) throw new ReleaseError('release_id', 'Invalid release id.');
  const [, y, mo, d, h, mi, s] = match.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
}

/** Builds the gzip archive bytes for every entry under `root`. */
export async function createArchive(root, { mtime = 0 } = {}) {
  const parts = [];
  for (const entry of await listTree(root)) {
    if (entry.type === 'dir') {
      parts.push(header({ ...entry, mtime }));
      continue;
    }
    const bytes = await readFile(join(root, entry.name));
    parts.push(header({ ...entry, size: bytes.length, mtime }), bytes);
    const pad = (BLOCK - (bytes.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  let tar = Buffer.concat(parts);
  const tail = (RECORD - (tar.length % RECORD)) % RECORD;
  if (tail) tar = Buffer.concat([tar, Buffer.alloc(tail)]);
  const gz = gzipSync(tar, { level: 9 });
  gz[9] = 3; // Fixed OS byte (Unix) so macOS and Linux agree.
  return gz;
}

function field(block, start, length) {
  const end = block.indexOf(0, start);
  return block
    .subarray(start, end === -1 || end > start + length ? start + length : end)
    .toString('utf8');
}

const SAFE_PAX = new Set([
  'path',
  'size',
  'mtime',
  'atime',
  'ctime',
  'uid',
  'gid',
  'uname',
  'gname',
]);

function parsePax(bytes) {
  const out = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number(bytes.subarray(offset, space).toString('ascii'));
    if (!Number.isInteger(length) || length <= 0) break;
    const record = bytes
      .subarray(space + 1, offset + length - 1)
      .toString('utf8');
    const equals = record.indexOf('=');
    out[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return out;
}

/**
 * Reads a .tar.gz into {files: Map(name -> sha256), dirs: Set, manifest}. Refuses
 * AppleDouble and hidden names, xattr pax records, links, absolute paths and
 * parent segments. A leading "./" (manual `tar -C dir .`) is accepted.
 */
export function readArchive(gz) {
  const tar = gunzipSync(gz);
  const files = new Map(),
    dirs = new Set();
  let manifest = null;
  let pax = null;
  for (let offset = 0; offset + BLOCK <= tar.length;) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    const type = String.fromCharCode(block[156] || 0x30);
    const size = parseInt(field(block, 124, 12).trim() || '0', 8);
    const prefix = field(block, 345, 155);
    let name = (prefix ? prefix + '/' : '') + field(block, 0, 100);
    const body = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x' || type === 'g') {
      const records = parsePax(body);
      for (const key of Object.keys(records))
        if (!SAFE_PAX.has(key))
          throw new ReleaseError(
            'archive_metadata',
            `Archive carries extended metadata ${JSON.stringify(key)} (xattrs or macOS metadata).`,
          );
      if (type === 'x') pax = records;
      continue;
    }
    if (pax?.path) name = pax.path;
    pax = null;
    name = name.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
    if (name === '' || name === '.') continue;
    if (name.startsWith('/') || name.split('/').includes('..'))
      throw new ReleaseError('archive_path', `Unsafe archive path ${name}.`);
    if (forbiddenName(name))
      throw new ReleaseError(
        'forbidden_entry',
        `Archive contains hidden or AppleDouble entry ${JSON.stringify(name)}.`,
      );
    if (type === '5') dirs.add(name);
    else if (type === '0' || type === '\0') {
      if (files.has(name))
        throw new ReleaseError('archive_duplicate', `Duplicate entry ${name}.`);
      files.set(name, sha256(body));
      if (name === 'release-manifest.json') manifest = Buffer.from(body);
    } else
      throw new ReleaseError(
        'archive_type',
        `Archive entry ${name} has unsupported type ${JSON.stringify(type)}.`,
      );
  }
  return { files, dirs, manifest };
}

// Local qualification of a packaged BAINK release directory and archive,
// mirroring the checks activate-release.py makes on the host: file-set
// equality, per-file sha256, no AppleDouble/hidden entries, release id and
// version pattern. Read-only.
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  createArchive,
  listTree,
  readArchive,
  releaseEpoch,
  sha256,
} from './archive.mjs';
import { RELEASE_ID, SHA256 } from './components.mjs';

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function expectedSet(manifest) {
  const expected = new Map();
  for (const [name, hash] of Object.entries(manifest.files ?? {}))
    expected.set(name, hash);
  for (const [name, hash] of Object.entries(manifest.preview_files ?? {}))
    expected.set('preview/' + name, hash);
  return expected;
}

function compare(actual, expected) {
  const missing = [],
    extra = [],
    mismatched = [];
  for (const [name, hash] of expected) {
    if (!actual.has(name)) missing.push(name);
    else if (actual.get(name) !== hash) mismatched.push(name);
  }
  for (const name of actual.keys())
    if (!expected.has(name) && name !== 'release-manifest.json')
      extra.push(name);
  if (!actual.has('release-manifest.json'))
    missing.push('release-manifest.json');
  return { missing, extra, mismatched };
}

const summary = ({ missing, extra, mismatched }) =>
  [
    missing.length && `missing ${missing.slice(0, 5).join(', ')}`,
    extra.length && `unexpected ${extra.slice(0, 5).join(', ')}`,
    mismatched.length && `sha256 differs ${mismatched.slice(0, 5).join(', ')}`,
  ]
    .filter(Boolean)
    .join('; ');

/**
 * Resolves {releaseDir, archive, sidecar} from --release-dir, --manifest or
 * --archive. The packager writes <output>/<release>/ and <output>/<release>.tar.gz.
 */
export function resolveArtifacts({ releaseDir, manifest, archive }) {
  let dir = releaseDir ? resolve(releaseDir) : null;
  if (!dir && manifest) dir = dirname(resolve(manifest));
  let tar = archive ? resolve(archive) : null;
  if (!tar && dir) tar = join(dirname(dir), basename(dir) + '.tar.gz');
  return { releaseDir: dir, archive: tar, sidecar: tar && tar + '.sha256' };
}

export async function verifyRelease(spec, options) {
  const { releaseDir, archive, sidecar } = resolveArtifacts(options);
  const checks = [];
  const add = (id, ok, detail = '') => checks.push({ id, ok, detail });
  let manifest = null,
    archiveBytes = null,
    archiveSha256 = null,
    archived = null;

  if (archive && (await exists(archive))) {
    archiveBytes = await readFile(archive);
    archiveSha256 = sha256(archiveBytes);
    try {
      archived = readArchive(archiveBytes);
      add('archive-entries', true, `${archived.files.size} files`);
    } catch (error) {
      add('archive-entries', false, error.message);
    }
  } else
    add(
      'archive-present',
      false,
      `Archive not found: ${archive ?? '(none given)'}`,
    );

  if (releaseDir && (await exists(join(releaseDir, 'release-manifest.json'))))
    manifest = JSON.parse(
      await readFile(join(releaseDir, 'release-manifest.json'), 'utf8'),
    );
  else if (archived?.manifest)
    manifest = JSON.parse(archived.manifest.toString('utf8'));
  if (!manifest) {
    add('manifest', false, 'release-manifest.json not found');
    return { ok: false, checks, releaseDir, archive, archiveSha256 };
  }

  const release = manifest.release;
  add('release-id', RELEASE_ID.test(release ?? ''), String(release));
  if (releaseDir)
    add(
      'release-dir-name',
      basename(releaseDir) === release,
      basename(releaseDir),
    );
  add(
    'version',
    spec.versionPattern.test(manifest.version ?? ''),
    String(manifest.version),
  );
  add('host', manifest.host === spec.host, String(manifest.host));
  add(
    'no-native-financial-activation',
    manifest.native_financial_activation === false &&
      manifest.private_member_keys_in_release === false,
  );
  const expected = expectedSet(manifest);

  if (releaseDir && (await exists(releaseDir))) {
    try {
      const actual = new Map();
      for (const entry of await listTree(releaseDir))
        if (entry.type === 'file')
          actual.set(
            entry.name,
            sha256(await readFile(join(releaseDir, entry.name))),
          );
      const diff = compare(actual, expected);
      add(
        'dir-files',
        !summary(diff),
        summary(diff) || `${actual.size} files match`,
      );
    } catch (error) {
      add('dir-files', false, error.message);
    }
  }

  if (archived) {
    const diff = compare(archived.files, expected);
    add(
      'archive-files',
      !summary(diff),
      summary(diff) || `${archived.files.size} files match`,
    );
    if (
      archived.manifest &&
      releaseDir &&
      (await exists(join(releaseDir, 'release-manifest.json')))
    )
      add(
        'archive-manifest',
        sha256(archived.manifest) ===
          sha256(await readFile(join(releaseDir, 'release-manifest.json'))),
      );
  }

  if (archiveSha256) {
    let wanted = options.sha256 ?? null;
    if (!wanted && sidecar && (await exists(sidecar)))
      wanted = (await readFile(sidecar, 'utf8')).trim().split(/\s+/)[0];
    if (wanted)
      add(
        'archive-sha256',
        SHA256.test(wanted) && wanted === archiveSha256,
        wanted,
      );
  }

  // Informational: whether this archive is the deterministic packager output.
  let reproducible = null;
  if (
    archiveSha256 &&
    releaseDir &&
    (await exists(releaseDir)) &&
    RELEASE_ID.test(release ?? '')
  )
    try {
      reproducible =
        sha256(
          await createArchive(releaseDir, { mtime: releaseEpoch(release) }),
        ) === archiveSha256;
    } catch {
      reproducible = false;
    }

  return {
    ok: checks.every((check) => check.ok),
    release,
    version: manifest.version,
    files: Object.keys(manifest.files ?? {}).length,
    previewFiles: Object.keys(manifest.preview_files ?? {}).length,
    priorRelease: manifest.prior_release ?? null,
    releaseDir,
    archive,
    archiveSha256,
    reproducible,
    checks,
  };
}

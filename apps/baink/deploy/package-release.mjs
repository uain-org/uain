import {SERVER_SOURCE_FOLDERS} from './runtime-sources.mjs';
import { collectReleaseFiles } from './release-files.mjs';
import {
  readFile,
  mkdir,
  copyFile,
  writeFile,
} from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  createArchive,
  readArchive,
  releaseEpoch,
} from '../../../ops/release/archive.mjs';
const app = resolve(import.meta.dirname, '..'),
  output = resolve(process.argv[2] || '');
if (!process.argv[2] || !output.includes('/output/baink-'))
  throw Error('Use an explicit BAINK output directory.');
// Same order as the default Array#sort (UTF-16 code units of String(x)).
const order = (a, b) =>
  String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Refuses, naming the path, local junk (__pycache__, .pyc, .DS_Store, ._*), hidden or
// secret files and symlinks (release-files.mjs, 12 November 2026).
const collect = (folder) => collectReleaseFiles(folder, folder.slice(app.length + 1) || '.');
const sources = [];
for (const folder of [
  'dist',
  ...SERVER_SOURCE_FOLDERS,
  'catalogue',
])
  for (const [name, path] of await collect(join(app, folder)))
    if (
      !name.endsWith('.test.mjs') &&
      !name.endsWith('.test.js') &&
      !name.endsWith('.md')
    )
      sources.push([folder + '/' + name, path]);
sources.push(['package.json', join(app, 'package.json')]);
const files = {},
  previewFiles = {};
for (const [name, path] of sources.sort(order))
  files[name] = sha(await readFile(path));
const preview = await collect(join(app, 'dist-preview'));
for (const [name, path] of preview.sort(order))
  previewFiles[name] = sha(await readFile(path));
const digest = sha(JSON.stringify({ files, previewFiles })).slice(0, 10),
  stamp = new Date()
    .toISOString()
    .replaceAll(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z'),
  release = stamp + '-' + digest;
const destination = join(output, release);
await mkdir(destination, { recursive: false });
for (const [name, path] of sources) {
  await mkdir(resolve(destination, name, '..'), { recursive: true });
  await copyFile(path, join(destination, name));
}
for (const [name, path] of preview) {
  await mkdir(resolve(destination, 'preview', name, '..'), { recursive: true });
  await copyFile(path, join(destination, 'preview', name));
}
const version = JSON.parse(
  await readFile(join(app, 'package.json'), 'utf8'),
).version;
const manifest = {
  release,
  version,
  host: 'universa-and-others-mar-14',
  url: 'https://baink.money',
  preview_url: 'https://aidollar.money/baink/',
  prior_release: process.argv[3] || null,
  files,
  preview_files: previewFiles,
  native_financial_activation: false,
  native_enrolment: 'explicit-holder-signing-only; deployment-gated',
  private_member_keys_in_release: false,
};
await writeFile(
  join(destination, 'release-manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);
await writeFile(
  join(output, 'peer-release-manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);
// Deterministic archive: sorted entries, 0:0 owners, fixed modes and mtime
// (the release stamp), no AppleDouble or xattrs. Upload it as release.tar.gz.
const archiveBytes = await createArchive(destination, {
  mtime: releaseEpoch(release),
});
const archived = readArchive(archiveBytes).files;
const expectedEntries = [
  ...Object.keys(files),
  ...Object.keys(previewFiles).map((name) => 'preview/' + name),
  'release-manifest.json',
].sort(order);
if (
  JSON.stringify([...archived.keys()].sort(order)) !==
  JSON.stringify(expectedEntries)
)
  throw Error('Archive entries differ from the release manifest.');
const archive = join(output, release + '.tar.gz'),
  archiveSha256 = sha(archiveBytes);
await writeFile(archive, archiveBytes, { flag: 'wx' });
await writeFile(archive + '.sha256', archiveSha256 + '  release.tar.gz\n', {
  flag: 'wx',
});
console.log(
  JSON.stringify({
    release,
    version,
    destination,
    files: Object.keys(files).length,
    previewFiles: Object.keys(previewFiles).length,
    archive,
    archiveSha256,
  }),
);

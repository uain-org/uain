// The observatory page loads CesiumJS from /cesium at run time: its workers,
// assets and widgets have to sit at a public address. They are copied out of
// node_modules at build time rather than committed (22 MB).
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'node_modules/cesium/Build/Cesium');
const to = join(root, 'public/cesium');
const version = JSON.parse(
  readFileSync(join(root, 'node_modules/cesium/package.json'), 'utf8'),
).version;
const stamp = join(to, `.version-${version}`);

if (!existsSync(stamp)) {
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, {
    recursive: true,
    filter: (src) => !/\.(cjs|d\.ts)$/.test(src) && !src.endsWith('index.js'),
  });
  cpSync(join(root, 'node_modules/cesium/package.json'), stamp);
  console.log(`copied CesiumJS ${version} to public/cesium`);
}

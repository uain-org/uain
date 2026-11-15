import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source and compiled layouts share the same package/data directory. Moving
// code between folders must never silently create a new signing identity.
const here = dirname(fileURLToPath(import.meta.url));
const candidates = [resolve(here, '..'), resolve(here, '../..')];
const pilotRoot = candidates.find(path => {
  const file = join(path, 'package.json');
  return existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).name === 'uain-pilot';
});
if (!pilotRoot) throw new Error('Cannot locate the pilot package directory');
export const PILOT_ROOT: string = pilotRoot;
export const DATA_DIR: string = process.env.UAIN_DATA_DIR ?? join(PILOT_ROOT, '.data');

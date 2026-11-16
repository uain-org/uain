import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateRoot, type PinnedKey } from './root.js';

export function publishRoot(dir: string, value: unknown, pinnedKey: PinnedKey, now = new Date()): 'created' | 'unchanged' {
  const root = validateRoot(value, pinnedKey, now);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${root.date}.json`);
  const content = JSON.stringify(root, null, 2) + '\n';
  if (existsSync(file)) {
    const previous = validateRoot(JSON.parse(readFileSync(file, 'utf8')), pinnedKey, now);
    if (JSON.stringify(previous) !== JSON.stringify(root)) throw new Error(`Published root for ${root.date} differs`);
    return 'unchanged';
  }
  writeFileSync(file, content, { flag: 'wx' });
  return 'created';
}

/**
 * The build id of this image, for GET /api/build.
 *
 * The Dockerfile writes /app/build.json with ops/docs/build-id.mjs:
 * {"schema":1,"component":"uain-pilot","commit":…,"built_at":…}. `commit` is
 * the source commit the image was built from, when the build was given one
 * (`--build-arg UAIN_SOURCE_COMMIT`); otherwise null. A server started outside
 * an image has no file and answers null for both. Nothing is guessed, and the
 * file is the only source: no environment variable or request can change it.
 *
 * `node ops/docs/render-status.mjs --observe` reads this beside the website's
 * /build.json to observe the `uain` release.
 */
import { readFileSync } from 'node:fs';

export interface BuildId {
  schema: 1;
  component: 'uain-pilot';
  commit: string | null;
  built_at: string | null;
}

const COMMIT = /^[0-9a-f]{40}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
/** dist/src/api/build-id.js → the image's /app/build.json. */
const DEFAULT_FILE = new URL('../../../build.json', import.meta.url);

/** Reads a build id file; anything missing or malformed reads as unknown. */
export function readBuildId(file: string | URL = DEFAULT_FILE): BuildId {
  const unknown: BuildId = {
    schema: 1,
    component: 'uain-pilot',
    commit: null,
    built_at: null,
  };
  let data: unknown;
  try {
    const text = readFileSync(file, 'utf8');
    if (text.length > 4096) return unknown;
    data = JSON.parse(text);
  } catch {
    return unknown;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return unknown;
  const d = data as Record<string, unknown>;
  if (d.schema !== 1 || d.component !== 'uain-pilot') return unknown;
  if (typeof d.built_at !== 'string' || !ISO_UTC.test(d.built_at))
    return unknown;
  return {
    ...unknown,
    commit:
      typeof d.commit === 'string' && COMMIT.test(d.commit) ? d.commit : null,
    built_at: d.built_at,
  };
}

let cached: BuildId | null = null;
/** The image's build id, read once: an image's files do not change. */
export function buildId(): BuildId {
  cached ??= readBuildId();
  return cached;
}

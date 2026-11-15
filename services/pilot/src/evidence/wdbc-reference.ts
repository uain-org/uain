/** Data-quality reference only; this makes no diagnosis or treatment claim. */
import { createHash } from 'node:crypto';
export const WDBC_SHA256 = 'd606af411f3e5be8a317a5a8b652b425aaf0ff38ca683d5327ffff94c3695f4a';
export interface WdbcMetrics { rows: number; features: number; malignant: number; benign: number }
export interface WdbcObservation { bytes: number; sha256: string; metrics: WdbcMetrics }

export function analyzeWdbc(bytes: Uint8Array, { expectedSha256 = WDBC_SHA256 }: { expectedSha256?: string | null } = {}): WdbcObservation {
  if (!bytes.byteLength || bytes.byteLength > 1024 * 1024) throw new Error('Invalid reference size');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (expectedSha256 !== null && sha256 !== expectedSha256) throw new Error('Reference fingerprint does not match');
  const rows = Buffer.from(bytes).toString('utf8').trim().split(/\r?\n/);
  const ids = new Set<string>();
  const metrics: WdbcMetrics = { rows: rows.length, features: 30, malignant: 0, benign: 0 };
  for (const row of rows) {
    const [id, label, ...values] = row.split(',');
    if (!id || !/^\d+$/.test(id)) throw new Error('Invalid reference identifier');
    if (ids.has(id)) throw new Error('Reference contains a duplicate identifier');
    ids.add(id);
    if (values.length !== metrics.features) throw new Error('Reference has incorrect feature dimensions');
    if (values.some(value => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) || !Number.isFinite(Number(value))))
      throw new Error('Reference contains invalid numeric cells');
    if (label === 'M') metrics.malignant++;
    else if (label === 'B') metrics.benign++;
    else throw new Error('Reference has an unknown diagnosis label');
  }
  return { bytes: bytes.byteLength, sha256, metrics };
}

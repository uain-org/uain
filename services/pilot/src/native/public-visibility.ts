/** Reversible operator visibility only. The native project catalog, proved
 * descriptions, signed history and reward accounting remain untouched. */
import { createHash } from 'node:crypto';

export type NativePublicVisibility = Readonly<{
  version: string;
  archivedProjectIds: readonly string[];
  isProjectVisible: (id: string) => boolean;
}>;
type Query = (sql: string, args?: any[]) => Promise<{ rows: { project_id: string }[] }>;
const MAX_ARCHIVES = 10_000;

/** Read once per request, including response-cache hits. No TTL can delay an
 * archive or restoration; callers include version in their response cache key
 * and recheck it after building a response. This never scans signed history. */
export async function readNativePublicVisibility(query: Query): Promise<NativePublicVisibility> {
  const { rows } = await query(
    'SELECT left(project_id,257) AS project_id FROM project_archives ORDER BY project_id LIMIT $1',
    [MAX_ARCHIVES + 1],
  );
  if (rows.length > MAX_ARCHIVES || rows.some(row =>
    typeof row.project_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(row.project_id))) {
    throw Error('bounded project archive visibility required');
  }
  const ids = rows.map(row => row.project_id).sort();
  const archived = new Set(ids);
  if (archived.size !== ids.length) throw Error('bounded project archive identities required');
  return Object.freeze({
    version: createHash('sha256').update(JSON.stringify(ids)).digest('hex'),
    archivedProjectIds: Object.freeze(ids),
    isProjectVisible: (id: string) => !archived.has(id),
  });
}

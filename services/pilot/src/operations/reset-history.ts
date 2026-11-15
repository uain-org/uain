/** Historical public citations survive a reset; active lists and writes do not. */
import {prepare} from '../storage/store.ts';
import {evidenceDigest} from '../evidence/artifact-evidence.ts';
interface Archived {
  kind:string; record_id:string; epoch:string; payload:Record<string,unknown>; payload_sha256:string;
}
const select=prepare<Archived>('SELECT kind,record_id,epoch,payload,payload_sha256 FROM reset_public_records WHERE path=?');
const active=new Map([
  ['projects',prepare('SELECT 1 FROM projects WHERE id=?')],
  ['contributions',prepare('SELECT 1 FROM contributions WHERE id=?')],
  ['tasks',prepare('SELECT 1 FROM tasks WHERE id=?')],
  ['claims',prepare('SELECT 1 FROM claims WHERE id=?')],
  ['wallets',prepare('SELECT 1 FROM member_wallets WHERE id=?')],
  ['flags',prepare('SELECT 1 FROM benevolence_flags WHERE id=?')],
  ['directory',prepare('SELECT 1 FROM participants WHERE id=?')],
]);
export async function resetPublicRecord(path:string):Promise<Record<string,unknown>|null> {
  if (!/^\/api\/(?:projects|contributions|tasks|claims|wallets|directory|benevolence\/flags)\/[a-zA-Z0-9-]+$/.test(path)) return null;
  path=path.replace(/(\/api\/(?:contributions|tasks|claims)\/)([a-zA-Z0-9-]+)$/,(_match,prefix:string,id:string)=>prefix+id.toUpperCase());
  const row=await select.get(path);
  if (!row) return null;
  const live=active.get(row.kind);
  if (!live || await live.get(row.record_id)) return null;
  if (evidenceDigest(row.payload)!==row.payload_sha256) throw new Error('Historical public evidence checksum differs');
  return {...row.payload,archived_epoch:row.epoch,read_only:true};
}

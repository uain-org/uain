// Proves the file storage settings work against the real bucket: stores a
// small object, reads it back, deletes it, and checks it is gone.
// Run from the repository root with the UAIN_STORAGE_* settings exported:
//   npm run build:pilot && node services/pilot/scripts/storage-check.mjs
import { randomUUID } from 'node:crypto';
import { objectStorage, storageFromEnv } from '../dist/src/integrations/object-storage.js';

const config = storageFromEnv();
if (!config) {
  console.error('Set UAIN_STORAGE_ENDPOINT, UAIN_STORAGE_BUCKET, UAIN_STORAGE_ACCESS_KEY_ID and UAIN_STORAGE_SECRET_ACCESS_KEY.');
  process.exit(2);
}
const storage = objectStorage(config);
const key = `checks/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.txt`;
const text = `uain storage check ${new Date().toISOString()}`;

await storage.put(key, text, 'text/plain');
const back = await storage.get(key);
if (new TextDecoder().decode(back ?? new Uint8Array()) !== text) throw new Error('read back something else');
await storage.remove(key);
if ((await storage.get(key)) !== null) throw new Error('still there after delete');
console.log(`ok: wrote, read back and deleted ${config.bucket}/${key}`);

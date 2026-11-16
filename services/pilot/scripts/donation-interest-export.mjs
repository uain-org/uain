/** Private operator export; never exposed through the public API. */
import { pool, close } from '../dist/src/storage/store.js';
const { rows } =
  await pool.query(`SELECT id,project_id,project_title,is_demo,name,email,amount,currency,message,created_at,
  attribution->>'referred_by' AS referral_id, referring_system, attribution,slack_sent_at
  FROM donation_interests ORDER BY created_at DESC`);
console.log(JSON.stringify(rows, null, 2));
await close();

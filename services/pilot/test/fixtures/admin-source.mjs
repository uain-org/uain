// Isolated cross-repository verification only; never a production launcher.
import { boot } from '../helpers.mjs';
const system=await boot();
const {pool}=await import('../../dist/src/storage/store.js');
await pool.query("INSERT INTO portal_admin_grants VALUES('https://isolated-id.test','operator','overview:read',NULL)");
process.send({origin:system.base});
process.on('message',async message=>{
 if(message==='revoke'){await pool.query('UPDATE portal_admin_grants SET revoked_at=now()');process.send({done:true});}
 if(message==='close'){await system.close();process.exit(0);}
});
process.on('disconnect',()=>void system.close().then(()=>process.exit()));

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import { authorizeAdminRead } from '../dist/src/admin/auth.js';
test('delegation requires explicit live source grant and destination scope', async () => {
  const pair = await generateKeyPair('EdDSA', { extractable: true });
  const env = { ADMIN_DELEGATION_KEYS: JSON.stringify({ 'https://master.test': await exportSPKI(pair.publicKey) }) };
  const now = new Date(), seconds = Math.floor(now.getTime()/1000);
  const make = (audience='uain-admin', product='uain', lifetime=90) => new SignJWT({ actor:{ issuer:'https://id.test',subject:'operator' },product,capability:'overview:read',grantVersion:1 }).setProtectedHeader({alg:'EdDSA',typ:'admin-delegation+jwt'}).setIssuer('https://master.test').setAudience(audience).setSubject('operator').setIssuedAt(seconds).setExpirationTime(seconds+lifetime).sign(pair.privateKey);
  const token = await make();
  await assert.rejects(authorizeAdminRead(token, async()=>false, env, now), e=>e.status===403);
  assert.equal((await authorizeAdminRead(token, async()=>true, env, now)).actor.subject,'operator');
  for (const bad of [await make('smartmeet-admin'), await make('uain-admin','kalki'), await make('uain-admin','uain',3600), 'legacy-user-token']) await assert.rejects(authorizeAdminRead(bad, async()=>true, env, now));
  await assert.rejects(authorizeAdminRead(token, async()=>true,env,new Date(now.getTime()+91000)));
});

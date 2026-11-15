import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nextMigrationCommand,verifyMigrationPlan} from './plan.mjs';
import {readFile} from 'node:fs/promises';
// Full captured source qualification is opt-in; the fixture stays on the
// isolated runner and contains public rows only.
test('full source plan resumes strictly from proven native import/account cursors',{skip:!process.env.UAIN_MIGRATION_SNAPSHOT},async()=>{
 const source=JSON.parse(await readFile(process.env.UAIN_MIGRATION_SNAPSHOT,'utf8')),plan=verifyMigrationPlan(source);
 assert.throws(()=>nextMigrationCommand(source,{records:{}}),/checkpoint/);
 const adoption=nextMigrationCommand(source,{records:{}},{nativeCheckpoint:{event_count:'0',last_command_digest:'',accounts_digest:'a'.repeat(64)}});
 assert.equal(adoption.operation,'legacy_adopt');assert.equal(adoption.payload.accounts,'13');
 const records={legacy_import:{...adoption.payload,imported:'2',status:'importing'}};
 const page=nextMigrationCommand(source,{records});assert.equal(page.operation,'legacy_page');assert.equal(page.payload.start,'2');assert.deepEqual(page.payload.records[0].proof,plan.proofs[2]);
 records.legacy_import.imported=String(plan.records.length);assert.equal(nextMigrationCommand(source,{records}).operation,'legacy_finish');
 records.legacy_import.status='reconciling_accounts';assert.throws(()=>nextMigrationCommand(source,{records}),/proven account/);
 for(const member of plan.reconciliation.members)records[`legacy_account_claimed/${member.id}`]=null;
 assert.equal(nextMigrationCommand(source,{records}).payload.member,plan.reconciliation.members[0].id);
});

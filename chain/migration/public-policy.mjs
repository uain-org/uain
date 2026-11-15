import assert from 'node:assert/strict';
export function sourcePublicPolicy(value){
 assert.ok(value&&Object.getPrototypeOf(value)===Object.prototype,'explicit original public policy required');
 assert.deepEqual(Object.keys(value).sort(),['bootstrap_operators','daily_credit_cap','version'],'unreviewed public policy field');
 assert.equal(value.version,1,'unsupported original public policy');
 assert.ok(typeof value.daily_credit_cap==='string'&&/^[1-9][0-9]{0,77}$/.test(value.daily_credit_cap),'positive original credit cap required');
 assert.ok(Number.isSafeInteger(value.bootstrap_operators)&&value.bootstrap_operators>=0&&value.bootstrap_operators<=16,'bounded original bootstrap threshold required');
 return structuredClone(value);
}
export function sourceIssuanceRecords(tables,policy){
 const timestamps=new Map();
 for(const row of tables.credit_ledger){
  if(BigInt(row.delta)<=0n||row.kind==='transfer')continue;
  const date=Date.parse(row.at);assert.ok(Number.isSafeInteger(date)&&date>=0,'original issuance time invalid');
  const stamp=BigInt(date)*1000000n;assert.ok(stamp<=9223372036854775807n,'original issuance time outside native epoch');
  const key=stamp.toString().padStart(20,'0');timestamps.set(key,(timestamps.get(key)??0n)+BigInt(row.delta));
 }
 let total=0n;const records=[];
 for(const [stamp,amount]of [...timestamps].sort(([a],[b])=>a.localeCompare(b))){total+=amount;assert.ok(total.toString().length<=78,'original issuance prefix overflow');records.push({key:'legacy/issuance_time/'+stamp,value:JSON.stringify(total.toString())})}
 for(const row of [...tables.participants].sort((a,b)=>Buffer.compare(Buffer.from((a.enrolled_at??'')+'\0'+a.id),Buffer.from((b.enrolled_at??'')+'\0'+b.id)))){
  const order=Buffer.from((row.enrolled_at??'')+'\0'+row.id).toString('hex');records.push({key:'legacy/bootstrap_order/'+order,value:JSON.stringify(row.id)});
 }
 records.push({key:'legacy/policy',value:JSON.stringify({...policy,issuance_total:total.toString()})});return records;
}

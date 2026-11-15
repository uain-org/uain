// Executable requirements model only. IDs stand for IDEAL authenticated
// commitments/nullifiers/licences. This file implements no cryptography and
// is never imported by a runtime, verifier, wallet or keeper.
import test from 'node:test';
import assert from 'node:assert/strict';

const snapshot = Object.freeze({chain:'fictional-chain',receipt:'R1',height:10,
  pool:15n,minted:100n,transparent:40n,shielded:60n,reserved:500n,
  noteRoot:'authenticated-note-root-H',nfRoot:'authenticated-spent-root-H',
  licenceRoot:'authenticated-licence-root',asset:'fictional-ETH'});
const note={id:'ideal-note-A',value:26n,created:9,spent:11,owner:'licensed-owner'};
const eligible=new Set(['licensed-owner']);
function domain(s){return JSON.stringify([s.chain,s.receipt,s.height,s.asset]);}
function modelClaim(canonical,submitted,n,licensed,used=new Set()) {
  assert.deepEqual(submitted,canonical,'every snapshot field must match authenticated state');
  assert.equal(canonical.minted,canonical.transparent+canonical.shielded);
  assert(canonical.minted>0n);assert(n.value>0n&&n.value<=canonical.minted);
  assert(n.created<=canonical.height,'note created after H');
  assert(n.spent===null||n.spent>canonical.height,'note already spent at H');
  assert(licensed.has(n.owner),'hidden licensed owner binding required');
  const fence=JSON.stringify([domain(canonical),n.id]); // ideal PRF identifier, NOT an implementation
  assert(!used.has(fence),'duplicate receipt-domain note');used.add(fence);
  return canonical.pool*n.value/canonical.minted;
}
test('holding snapshot keeps spent-after-H rights and excludes earlier spends/late notes',()=>{
  assert.equal(modelClaim(snapshot,snapshot,note,eligible),3n);
  assert.throws(()=>modelClaim(snapshot,snapshot,{...note,spent:10},eligible));
  assert.throws(()=>modelClaim(snapshot,snapshot,{...note,spent:9},eligible));
  assert.throws(()=>modelClaim(snapshot,snapshot,{...note,created:11,spent:null},eligible));
});
test('full minted denominator includes both pools and ineligible balances, excludes reservations',()=>{
  assert.equal(modelClaim(snapshot,snapshot,note,eligible),3n);
  for(const minted of [snapshot.transparent,snapshot.shielded,snapshot.minted+snapshot.reserved])
    assert.throws(()=>modelClaim(snapshot,{...snapshot,minted},note,eligible));
  assert.throws(()=>modelClaim(snapshot,snapshot,{...note,owner:'unlicensed'},eligible));
  const changed=new Set([...eligible,'another-owner']);
  assert.equal(modelClaim(snapshot,snapshot,note,changed),3n,'other eligibility cannot renormalize M');
});
test('mixed roots, wrong height/receipt/asset/chain and changed pool cannot select a different entitlement',()=>{
  for(const [key,value] of [['chain','another-chain'],['receipt','R2'],['height',11],['asset','SOL'],['pool',30n],['noteRoot','forged'],['nfRoot','now-not-H'],['licenceRoot','forged']])
    assert.throws(()=>modelClaim(snapshot,{...snapshot,[key]:value},note,eligible));
});
test('one note has one claim per receipt, while different receipts remain separate',()=>{
  const used=new Set();modelClaim(snapshot,snapshot,note,eligible,used);
  assert.throws(()=>modelClaim(snapshot,snapshot,note,eligible,used));
  const next={...snapshot,receipt:'R2'};assert.equal(modelClaim(next,next,note,eligible,used),3n);
});
test('conversion after H cannot replace historical owner with a newly created representation',()=>{
  assert.equal(modelClaim(snapshot,snapshot,note,eligible),3n);
  assert.throws(()=>modelClaim(snapshot,snapshot,{...note,id:'exit-then-reentry',created:12,spent:null},eligible));
});
test('per-note floors retain dust and differ from aggregate owner rounding',()=>{
  const p=15n,m=10n,a=1n,b=1n;
  assert.equal(p*a/m+p*b/m,2n);assert.equal(p*(a+b)/m,3n);
  for(let split=1n;split<10n;split++) assert(p*split/m+p*(10n-split)/m<=p);
  assert.equal(101n*15n/100n,15n,'pool itself floors atomic funding split');
});

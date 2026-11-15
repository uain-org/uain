package app

import (
 "bytes"
 "context"
 "crypto/ed25519"
 "encoding/json"
 "fmt"
 "io"
 "strings"
 "testing"

 "cosmossdk.io/log/v2"
 abci "github.com/cometbft/cometbft/abci/types"
 dbm "github.com/cosmos/cosmos-db"
 "github.com/uain-org/uain/chain/economy"
 "github.com/uain-org/uain/chain/federation"
 "github.com/uain-org/uain/chain/proof"
)

func TestSDKOperationsMaximumControllersExactPayeeProofRestart(t *testing.T){
 members:=[]federation.Member{};keys:=[]ed25519.PrivateKey{}
 for i:=0;i<24;i++{m,key:=testMember(fmt.Sprintf("operations participant %02d",i));m.Karma=1000;m.Name+=strings.Repeat("<",120-len(m.Name));m.Operator+=strings.Repeat("<",200-len(m.Operator));m.Family+=strings.Repeat("<",100-len(m.Family));members=append(members,m);keys=append(keys,key)}
 db:=dbm.NewMemDB();a:=initApp(t,db,federation.Genesis{Version:1,Guardians:[]string{members[3].ID},Members:members});s:=a.NewContext(false).KVStore(a.Key)
 set:=func(key string,v any){raw,e:=json.Marshal(v);if e!=nil{t.Fatal(e)};s.Set([]byte(key),raw)}
 digest:=strings.Repeat("a",64);network:="ethereum:1";escrow:="0x1111111111111111111111111111111111111111";source:="0x2222222222222222222222222222222222222222";target:="0x3333333333333333333333333333333333333333"
 set("storage_activation",federation.MembershipActivation{Policy:federation.CompactStatePolicy,EffectiveHeight:2,ApprovedBy:members[3].ID,EvidenceDigest:digest})
 set("funding_activation",federation.FundingActivation{Policy:federation.FundingPolicy,Height:2,Observers:[]string{members[1].ID,members[2].ID},EvidenceDigest:digest})
 for i,m:=range members{domain:=fmt.Sprintf("%02d",i)+strings.Repeat("a",61)+"."+strings.Repeat("b",63)+"."+strings.Repeat("c",63)+"."+strings.Repeat("d",61);set("operator_proof/"+m.ID+"/",federation.OperatorProof{Member:m.ID,Domain:domain,ClaimEventID:1,EvidenceDigest:digest})}
 set("funding_campaign/campaign",federation.FundingCampaign{ID:"campaign",Project:"project",Network:network,Asset:"native",Escrow:escrow,Lead:members[0].ID,Height:1})
 set("funding_receipt/receipt",federation.FundingReceipt{ID:"receipt",Campaign:"campaign",Amount:"1000",Source:source,Block:"123",Payer:members[0].ID,Height:1,State:"confirmed"})
 pool,e:=economy.Empty().Fund("1000");if e!=nil{t.Fatal(e)};set("funding_pool/receipt",pool)
 set("treasury_liability/"+network+"/"+escrow,federation.TreasuryLiability{Network:network,Escrow:escrow,Funded:"1000",Paid:"0",Refunded:"0",Outstanding:"1000"})
 set("treasury_escrow/"+network+"/"+escrow,federation.TreasuryEscrowControl{Policy:federation.TreasuryEscrowPolicy,Network:network,Address:escrow,Controller:members[0].ID,Guardian:members[3].ID,Height:1,ApprovedHeight:1,ExpiresHeight:20,EvidenceDigest:digest,ApprovalEvidence:digest})
 ids:=[]string{};for _,m:=range members[4:]{ids=append(ids,m.ID)}
 for _,address:=range []string{source,escrow,target}{set("external_wallet_control_controllers/ethereum/"+address,ids)}
 for _,address:=range []string{escrow,target}{set("treasury_escrow_control_controllers/"+network+"/"+address,ids)}
 h:=int64(1);block(t,a,h);seq:=[]uint64{0,0,0,0};var result *abci.ResponseFinalizeBlock
 send:=func(i int,op string,p any,ok bool){t.Helper();h++;raw:=testEnvelope(t,members[i],keys[i],seq[i],op,p);result=block(t,a,h,raw);tx:=result.TxResults[0];if (tx.Code==0)!=ok{t.Fatal(op,tx.Log,tx.GasUsed)};if ok{seq[i]++;t.Logf("maximum20 controller histories operations %s gas=%d",op,tx.GasUsed)}}
 query:=func(key string)[]byte{t.Helper();q,e:=a.Query(context.Background(),&abci.RequestQuery{Path:"/store/federation/key",Data:[]byte(key),Height:h,Prove:true});if e!=nil||q.Code!=0{t.Fatal(e,q)};if e=proof.VerifyQuery(*q,key,result.AppHash,h);e!=nil{t.Fatal(e)};return bytes.Clone(q.Value)}
 intent:=map[string]any{"id":"OPS-SDK","receipt":"receipt","network":network,"asset":"native","escrow":escrow,"amount":"50","target":target,"payee":strings.Repeat("<",500),"invoice_digest":digest,"evidence_digest":digest}
 send(0,"operations_intent",intent,false);send(3,"operations_intent",intent,true)
 filing:=query("operations_filing/OPS-SDK");raw:=query("funding_pool/receipt");if e=json.Unmarshal(raw,&pool);e!=nil||pool.Operations.Reserved!="50"||pool.Operations.Paid!="0"{t.Fatal(pool,e)}
 observe:=map[string]any{"receipt":"OPS-SDK","kind":"operations","transaction":"0x"+strings.Repeat("6",64),"index":"0","amount":"50","target":target,"source":escrow,"block":"130","block_hash":"0x"+strings.Repeat("7",64),"evidence_digest":digest}
 send(1,"operations_attest",observe,true)
 a,e=New(log.NewLogger(io.Discard),db,"sdk-test-1");if e!=nil{t.Fatal(e)}
 if !bytes.Equal(filing,query("operations_filing/OPS-SDK")){t.Fatal("cost authorization changed after restart")}
 send(2,"operations_attest",observe,true);paid:=query("funding_pool/receipt");if e=json.Unmarshal(paid,&pool);e!=nil||pool.Operations.Paid!="50"||pool.Operations.Reserved!="0"||pool.Bounty.Available!="800"||pool.Dividend.Available!="150"{t.Fatal(pool,e)}
 query("treasury_effect/operations/OPS-SDK");var liability federation.TreasuryLiability;if e=json.Unmarshal(query("treasury_liability/"+network+"/"+escrow),&liability);e!=nil||liability.Outstanding!="950"||liability.Paid!="50"{t.Fatal(liability,e)}
 send(2,"operations_attest",observe,false);send(3,"operations_intent",intent,false);if !bytes.Equal(paid,query("funding_pool/receipt")){t.Fatal("replay changed operations pool")}
}

package federation

import "testing"

// Control proved before operator verification must also exclude a second
// member of that controller's subsequently verified operator domain.
func TestFundingSourceControllerLaterOperatorProofRemainsIndependent(t *testing.T) {
	k, controller, observer, _ := fundingFixture(t)
	key := "operator_proof/" + operatorActorKey(controller.m.ID, "")
	var proof OperatorProof
	if e := get(k.Store, key, &proof); e != nil {
		t.Fatal(e)
	}
	k.Store.Delete([]byte(key))
	source := "0x2222222222222222222222222222222222222222"
	if e := k.rememberFundingSourceControl("external_wallet_control", "ethereum", source, controller.m.ID); e != nil {
		t.Fatal(e)
	}
	existing, e := k.OperatorProof(observer.m.ID, "")
	if e != nil || existing == nil {
		t.Fatal(e)
	}
	proof.Domain = existing.Domain
	if e = put(k.Store, key, proof); e != nil {
		t.Fatal(e)
	}
	if e = k.independentFundingSource("external_wallet_control", "ethereum", source, observer.m.ID); e == nil {
		t.Fatal("observer's now-proved same operator controls the source")
	}
}

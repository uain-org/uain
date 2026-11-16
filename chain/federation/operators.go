package federation

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"
	"time"
)

// Identity bindings are immutable. Imported identifiers retain the existing
// participant DID; new identifiers are derived without consensus randomness.
type ActorIdentity struct {
	Member              string `json:"member"`
	Instance            string `json:"instance,omitempty"`
	DID                 string `json:"did"`
	Operator            string `json:"operator"`
	LegacyAccountDigest string `json:"legacy_account_digest,omitempty"`
	Origin              string `json:"origin"`
	ApprovedBy          string `json:"approved_by"`
	EvidenceDigest      string `json:"evidence_digest,omitempty"`
	EventID             uint64 `json:"event_id,string"`
	At                  string `json:"at"`
}

type OperatorClaim struct {
	Member   string `json:"member"`
	Instance string `json:"instance,omitempty"`
	DID      string `json:"did"`
	Domain   string `json:"domain"`
	EventID  uint64 `json:"event_id,string"`
	At       string `json:"at"`
}

type OperatorProof struct {
	Member         string `json:"member"`
	Instance       string `json:"instance,omitempty"`
	DID            string `json:"did"`
	Domain         string `json:"domain"`
	ClaimEventID   uint64 `json:"claim_event_id,string"`
	TXT            string `json:"txt"`
	CheckedAt      string `json:"checked_at"`
	Observer       string `json:"observer"`
	EvidenceDigest string `json:"evidence_digest"`
	Trust          string `json:"trust"`
	EventID        uint64 `json:"event_id,string"`
}

var legacyDIDPattern = regexp.MustCompile(`^did:uain:[0-9a-f]{12}$`)
var operatorDomainPattern = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`)

func operatorActorKey(member, instance string) string { return member + "/" + instance }
func derivedActorDID(member, instance string) string {
	sum := sha256.Sum256([]byte("UAIN ACTOR IDENTITY V1\n" + member + "\n" + instance))
	return "did:uain:" + hex.EncodeToString(sum[:])
}

func (k Keeper) ActorIdentity(member, instance string) (ActorIdentity, error) {
	var a ActorIdentity
	err := get(k.Store, "actor_identity/"+operatorActorKey(member, instance), &a)
	if err == nil && (a.Member != member || a.Instance != instance) {
		return a, errors.New("identity binding owner mismatch")
	}
	return a, err
}

func (k Keeper) bindIdentity(a ActorIdentity, now time.Time) (string, error) {
	m, err := k.Member(a.Member)
	if err != nil {
		return "", err
	}
	if a.Instance != "" {
		v, err := k.Instance(a.Instance)
		if err != nil || v.Member != a.Member {
			return "", errors.New("identity instance must belong to target member")
		}
	}
	if a.Operator == "" {
		a.Operator = m.Operator
	}
	if len(strings.TrimSpace(a.Operator)) < 2 || len(a.Operator) > 200 {
		return "", errors.New("identity needs a bounded operator declaration")
	}
	key := "actor_identity/" + operatorActorKey(a.Member, a.Instance)
	if k.Store.Get([]byte(key)) != nil || k.Store.Get([]byte("actor_did/"+a.DID)) != nil {
		return "", errors.New("actor or DID already bound; identity cannot be reassigned")
	}
	a.EventID, err = k.nextEvent()
	if err != nil {
		return "", err
	}
	a.At = now.UTC().Format(time.RFC3339Nano)
	if err = put(k.Store, "actor_did/"+a.DID, operatorActorKey(a.Member, a.Instance)); err != nil {
		return "", err
	}
	if err = invalidateCensus(k.Store); err != nil {
		return "", err
	}
	return a.DID, put(k.Store, key, a)
}

func (k Keeper) claimIdentity(c Command, now time.Time) (string, error) {
	var p struct {
		Operator string `json:"operator,omitempty"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	a := ActorIdentity{Member: c.Member, Instance: c.Instance, DID: derivedActorDID(c.Member, c.Instance), Operator: p.Operator, Origin: "member-derived", ApprovedBy: c.Member}
	return k.bindIdentity(a, now)
}

func (k Keeper) importIdentity(c Command, now time.Time) (string, error) {
	var p struct {
		Member              string `json:"member"`
		Instance            string `json:"instance,omitempty"`
		DID                 string `json:"did"`
		Operator            string `json:"operator,omitempty"`
		LegacyAccountDigest string `json:"legacy_account_digest,omitempty"`
		EvidenceDigest      string `json:"evidence_digest"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	if !k.guardian(c.Member) || !legacyDIDPattern.MatchString(p.DID) || !digestPattern.MatchString(p.EvidenceDigest) || (p.LegacyAccountDigest != "" && !digestPattern.MatchString(p.LegacyAccountDigest)) {
		return "", errors.New("legacy identity import requires guardian, original DID and reconciliation evidence")
	}
	a := ActorIdentity{Member: p.Member, Instance: p.Instance, DID: p.DID, Operator: p.Operator, LegacyAccountDigest: p.LegacyAccountDigest, Origin: "guardian-legacy-import", ApprovedBy: c.Member, EvidenceDigest: p.EvidenceDigest}
	return k.bindIdentity(a, now)
}

func (k Keeper) claimOperator(c Command, now time.Time) (string, error) {
	var p struct {
		Domain string `json:"domain"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	domain := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(p.Domain)), ".")
	if len(domain) > 253 || !operatorDomainPattern.MatchString(domain) {
		return "", errors.New("invalid operator domain")
	}
	a, err := k.ActorIdentity(c.Member, c.Instance)
	if err != nil {
		return "", err
	}
	claim := OperatorClaim{Member: c.Member, Instance: c.Instance, DID: a.DID, Domain: domain, At: now.UTC().Format(time.RFC3339Nano)}
	claim.EventID, err = k.nextEvent()
	if err != nil {
		return "", err
	}
	// A new pending claim does not erase the previously verified domain.
	return domain, put(k.Store, "operator_claim/"+operatorActorKey(c.Member, c.Instance), claim)
}

func (k Keeper) attestOperator(c Command, now time.Time) (string, error) {
	var p struct {
		Member         string `json:"member"`
		Instance       string `json:"instance,omitempty"`
		Domain         string `json:"domain"`
		ClaimEventID   uint64 `json:"claim_event_id,string"`
		TXT            string `json:"txt"`
		CheckedAt      string `json:"checked_at"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	if !k.guardian(c.Member) || !digestPattern.MatchString(p.EvidenceDigest) {
		return "", errors.New("operator confirmation needs a guardian DNS observer and evidence")
	}
	m, err := k.Member(p.Member)
	if err != nil || m.Licence != "active" {
		return "", errors.New("operator target needs an active licence")
	}
	if err = k.validateInstance(p.Member, p.Instance); err != nil {
		return "", err
	}
	var claim OperatorClaim
	key := operatorActorKey(p.Member, p.Instance)
	if err = get(k.Store, "operator_claim/"+key, &claim); err != nil {
		return "", err
	}
	if claim.Member != p.Member || claim.Instance != p.Instance || claim.Domain != p.Domain || claim.EventID != p.ClaimEventID || p.TXT != "uain-operator="+claim.DID {
		return "", errors.New("DNS observation must match this actor's current claim and exact DID TXT record")
	}
	checked, err := time.Parse(time.RFC3339Nano, p.CheckedAt)
	claimed, claimErr := time.Parse(time.RFC3339Nano, claim.At)
	if err != nil || claimErr != nil || checked.Before(claimed) || checked.Before(now.Add(-10*time.Minute)) || checked.After(now.Add(30*time.Second)) {
		return "", errors.New("DNS observation is stale, future-dated or predates the claim")
	}
	var old OperatorProof
	if k.Store.Get([]byte("operator_proof/"+key)) != nil {
		if err = get(k.Store, "operator_proof/"+key, &old); err != nil {
			return "", err
		}
		if old.ClaimEventID == claim.EventID {
			return "", errors.New("operator claim already confirmed")
		}
	}
	proof := OperatorProof{Member: p.Member, Instance: p.Instance, DID: claim.DID, Domain: p.Domain, ClaimEventID: p.ClaimEventID, TXT: p.TXT, CheckedAt: checked.UTC().Format(time.RFC3339Nano), Observer: c.Member, EvidenceDigest: p.EvidenceDigest, Trust: "guardian-dns-observation"}
	proof.EventID, err = k.nextEvent()
	if err != nil {
		return "", err
	}
	if err = invalidateCensus(k.Store); err != nil {
		return "", err
	}
	return proof.Domain, put(k.Store, "operator_proof/"+key, proof)
}

func (k Keeper) OperatorProof(member, instance string) (*OperatorProof, error) {
	key := "operator_proof/" + operatorActorKey(member, instance)
	if k.Store.Get([]byte(key)) == nil {
		return nil, nil
	}
	var p OperatorProof
	if err := get(k.Store, key, &p); err != nil {
		return nil, err
	}
	if p.Member != member || p.Instance != instance {
		return nil, errors.New("operator proof owner mismatch")
	}
	return &p, nil
}

// Prospective policy callers use the existing federation's pairwise rule.
// The relation is deliberately not reduced to a map of normalized names: mixed
// proved/unproved identities need pairwise comparisons and are not transitive.
func (k Keeper) sameOperator(aMember, aInstance, bMember, bInstance string) (bool, error) {
	if aMember == bMember {
		return true, nil
	}
	ma, err := k.Member(aMember)
	if err != nil {
		return true, err
	}
	mb, err := k.Member(bMember)
	if err != nil {
		return true, err
	}
	operatorA, operatorB := ma.Operator, mb.Operator
	var aa, bb ActorIdentity
	if k.Store.Get([]byte("actor_identity/"+operatorActorKey(aMember, aInstance))) != nil {
		aa, err = k.ActorIdentity(aMember, aInstance)
		if err != nil {
			return true, err
		}
		operatorA = aa.Operator
	}
	if k.Store.Get([]byte("actor_identity/"+operatorActorKey(bMember, bInstance))) != nil {
		bb, err = k.ActorIdentity(bMember, bInstance)
		if err != nil {
			return true, err
		}
		operatorB = bb.Operator
	}
	if aa.LegacyAccountDigest != "" && aa.LegacyAccountDigest == bb.LegacyAccountDigest {
		return true, nil
	}
	pa, err := k.OperatorProof(aMember, aInstance)
	if err != nil {
		return true, err
	}
	pb, err := k.OperatorProof(bMember, bInstance)
	if err != nil {
		return true, err
	}
	if pa != nil && pb != nil {
		return pa.Domain == pb.Domain, nil
	}
	na, nb := normaliseOperator(operatorA), normaliseOperator(operatorB)
	return na == "" || nb == "" || na == nb, nil
}

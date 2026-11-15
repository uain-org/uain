package federation

import (
	"encoding/json"
	"errors"
	"math"
	"strings"
	"time"
)

// Guardian quorum (9 November 2026). A genesis or handover may set a
// threshold t > 1 of n guardians (t > n/2, so two disjoint quorums cannot
// exist). Under a threshold, no single guardian signature passes a guardian
// gate. A guardian proposes the exact operation and payload; other guardians
// approve it with their own signed envelopes; the approval that reaches the
// threshold executes the operation once, inside that transaction, with the
// recorded approvers as its authority. Chains whose genesis set no threshold
// keep the original single-guardian rule.

const GuardianActionWindow int64 = 720

type GuardianAction struct {
	ID             string          `json:"id"`
	Epoch          string          `json:"epoch"`
	Operation      string          `json:"operation"`
	Payload        json.RawMessage `json:"payload"`
	Proposer       string          `json:"proposer"`
	Height         int64           `json:"height,string"`
	ExpiresHeight  int64           `json:"expires_height,string"`
	EvidenceDigest string          `json:"evidence_digest"`
	Approvals      []string        `json:"approvals"`
	Executed       int64           `json:"executed,string"`
	Subject        string          `json:"subject"`
}

// validGuardianThreshold requires a strict majority: two disjoint approving
// groups cannot both reach the threshold.
func validGuardianThreshold(t, n int) bool {
	return t >= 1 && t <= n && 2*t > n
}

// GuardianThreshold is the effective number of guardian approvals required.
// An epoch's explicit threshold wins; otherwise the genesis threshold; a
// chain without one keeps the original single-guardian rule.
func (k Keeper) GuardianThreshold() (int, error) {
	epoch, err := k.CurrentGuardianEpoch()
	if err != nil {
		return 0, err
	}
	t := epoch.Threshold
	if t == 0 && k.Store.Get([]byte("guardian_threshold")) != nil {
		if err = get(k.Store, "guardian_threshold", &t); err != nil {
			return 0, err
		}
	}
	if t == 0 {
		return 1, nil
	}
	if !validGuardianThreshold(t, len(epoch.Guardians)) {
		return 0, errors.New("invalid guardian threshold")
	}
	return t, nil
}

// guardianMember is the individual-membership test used by the handover
// protocol and the quorum protocol itself, where each guardian acts alone.
func (k Keeper) guardianMember(id string) bool {
	epoch, err := k.CurrentGuardianEpoch()
	return err == nil && guardianContains(epoch.Guardians, id)
}

// guardian is the authority test for every guardian-gated operation. Under a
// threshold it holds only inside an executing quorum action that id approved.
func (k Keeper) guardian(id string) bool {
	if !k.guardianMember(id) {
		return false
	}
	// Before consensus v2 the original single-guardian rule applies, with
	// exactly the original reads.
	if !k.consensusV2() {
		return true
	}
	t, err := k.GuardianThreshold()
	if err != nil {
		return false
	}
	if t <= 1 {
		return true
	}
	return len(k.quorum) >= t && guardianContains(k.quorum, id)
}

// Operations that carry their own individual guardian protocol, or that a
// quorum must never perform on a guardian's behalf.
func guardianActionAllowed(op string) bool {
	if op == "" || op == "enrol" || op == "withdraw" || strings.HasPrefix(op, "guardian_") {
		return false
	}
	return true
}

func (k Keeper) guardianActionPropose(c Command, height int64, now time.Time) (string, error) {
	var p struct {
		ID             string          `json:"id"`
		Operation      string          `json:"operation"`
		Payload        json.RawMessage `json:"payload"`
		ExpiresHeight  int64           `json:"expires_height"`
		EvidenceDigest string          `json:"evidence_digest"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	if c.Instance != "" || !k.guardianMember(c.Member) || !validID(p.ID) || !guardianActionAllowed(p.Operation) || !digestPattern.MatchString(p.EvidenceDigest) || height < 1 || height > math.MaxInt64-GuardianActionWindow || p.ExpiresHeight <= height || p.ExpiresHeight > height+GuardianActionWindow {
		return "", errors.New("guardian action needs a guardian, a permitted operation, bounded expiry and evidence")
	}
	if len(p.Payload) == 0 || p.Payload[0] != '{' {
		return "", errors.New("guardian action payload must be an object")
	}
	if k.Store.Get([]byte("guardian_action/"+p.ID)) != nil {
		return "", errors.New("guardian action ID already used")
	}
	m, err := k.Member(c.Member)
	if err != nil || m.Licence != "active" {
		return "", errors.New("proposing guardian must be active")
	}
	epoch, err := k.CurrentGuardianEpoch()
	if err != nil {
		return "", err
	}
	action := GuardianAction{ID: p.ID, Epoch: epoch.ID, Operation: p.Operation, Payload: p.Payload, Proposer: c.Member, Height: height, ExpiresHeight: p.ExpiresHeight, EvidenceDigest: p.EvidenceDigest, Approvals: []string{c.Member}}
	return k.guardianActionMaybeExecute(action, c, height, now)
}

func (k Keeper) guardianActionApprove(c Command, height int64, now time.Time) (string, error) {
	var p struct {
		ID             string `json:"id"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	if c.Instance != "" || !k.guardianMember(c.Member) || !validID(p.ID) || !digestPattern.MatchString(p.EvidenceDigest) {
		return "", errors.New("guardian approval needs a guardian and evidence")
	}
	var action GuardianAction
	if err := get(k.Store, "guardian_action/"+p.ID, &action); err != nil {
		return "", err
	}
	epoch, err := k.CurrentGuardianEpoch()
	if err != nil {
		return "", err
	}
	if action.Executed != 0 || action.Epoch != epoch.ID || height > action.ExpiresHeight {
		return "", errors.New("executed, expired or stale guardian action")
	}
	if guardianContains(action.Approvals, c.Member) {
		return "", errors.New("guardian approval already recorded")
	}
	m, err := k.Member(c.Member)
	if err != nil || m.Licence != "active" {
		return "", errors.New("approving guardian must be active")
	}
	action.Approvals = append(action.Approvals, c.Member)
	return k.guardianActionMaybeExecute(action, c, height, now)
}

// Approvals count only while each approver is still an active guardian of
// the action's epoch. Reaching the threshold executes the action atomically;
// if the operation fails, the whole approving transaction fails.
func (k Keeper) guardianActionMaybeExecute(action GuardianAction, c Command, height int64, now time.Time) (string, error) {
	t, err := k.GuardianThreshold()
	if err != nil {
		return "", err
	}
	quorum := []string{}
	for _, id := range action.Approvals {
		m, err := k.Member(id)
		if err == nil && m.Licence == "active" && k.guardianMember(id) {
			quorum = append(quorum, id)
		}
	}
	if len(quorum) >= t {
		proposer, err := k.Member(action.Proposer)
		if err != nil {
			return "", err
		}
		inner := Command{Version: c.Version, ChainID: c.ChainID, Member: action.Proposer, Sequence: proposer.Sequence, ExpiresHeight: action.ExpiresHeight, Operation: action.Operation, Payload: action.Payload}
		authority := k
		authority.quorum = quorum
		if !guardianContains(quorum, action.Proposer) {
			return "", errors.New("guardian action proposer is no longer an active guardian")
		}
		subject, err := authority.apply(Envelope{Command: inner, PublicKey: proposer.PublicKey}, height, now)
		if err != nil {
			return "", err
		}
		action.Executed, action.Subject = height, subject
	}
	return action.ID, put(k.Store, "guardian_action/"+action.ID, action)
}

// GuardianActionState reads a recorded quorum action.
func (k Keeper) GuardianActionState(id string) (GuardianAction, error) {
	var v GuardianAction
	return v, get(k.Store, "guardian_action/"+id, &v)
}

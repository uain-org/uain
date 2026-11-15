package federation

import (
	"errors"
	"math"
)

// GuardianProposalWindow bounds on-chain coordination, not membership screening
// or any claim that the governing texts appointed particular operators.
const GuardianProposalWindow int64 = 720

type GuardianEpoch struct {
	ID             string   `json:"id"`
	Previous       string   `json:"previous"`
	Guardians      []string `json:"guardians"`
	Height         int64    `json:"height,string"`
	EvidenceDigest string   `json:"evidence_digest"`
	Executor       string   `json:"executor"`
	Threshold      int      `json:"threshold,omitempty"`
}
type GuardianProposal struct {
	ID             string   `json:"id"`
	BaseEpoch      string   `json:"base_epoch"`
	Guardians      []string `json:"guardians"`
	Voters         []string `json:"voters"`
	Proposer       string   `json:"proposer"`
	Height         int64    `json:"height,string"`
	NotBefore      int64    `json:"not_before,string"`
	ExpiresHeight  int64    `json:"expires_height,string"`
	EvidenceDigest string   `json:"evidence_digest"`
	Threshold      int      `json:"threshold,omitempty"`
}
type GuardianApproval struct {
	Member         string `json:"member"`
	Height         int64  `json:"height,string"`
	EvidenceDigest string `json:"evidence_digest"`
}

func guardianContains(ids []string, id string) bool {
	for _, other := range ids {
		if other == id {
			return true
		}
	}
	return false
}
func validGuardianList(ids []string) bool {
	if len(ids) < 1 || len(ids) > 20 {
		return false
	}
	for i, id := range ids {
		if !validID(id) || guardianContains(ids[:i], id) {
			return false
		}
	}
	return true
}

// CurrentGuardianEpoch is bounded to one pointer and one immutable epoch. Old
// authority is recovered using historical state proofs, never an unbounded walk.
func (k Keeper) CurrentGuardianEpoch() (GuardianEpoch, error) {
	var epoch GuardianEpoch
	if k.Store.Get([]byte("guardian_epoch_current")) == nil {
		if err := get(k.Store, "guardians", &epoch.Guardians); err != nil {
			return epoch, err
		}
	} else {
		var id string
		if err := get(k.Store, "guardian_epoch_current", &id); err != nil {
			return epoch, err
		}
		if !validID(id) {
			return epoch, errors.New("invalid guardian epoch pointer")
		}
		if err := get(k.Store, "guardian_epoch/"+id, &epoch); err != nil {
			return epoch, err
		}
		if epoch.ID != id || epoch.Height < 1 || !digestPattern.MatchString(epoch.EvidenceDigest) {
			return epoch, errors.New("invalid guardian epoch")
		}
	}
	if !validGuardianList(epoch.Guardians) {
		return epoch, errors.New("invalid guardian set")
	}
	return epoch, nil
}

// Only discretionary removal is guarded. The governing automatic revocation
// (Karma <= -10; under KarmaPolicyV2, 10 strikes) must still execute, including
// for the sole guardian.
func (k Keeper) guardianManualExit(member string) error {
	epoch, err := k.CurrentGuardianEpoch()
	if err != nil {
		return err
	}
	if !guardianContains(epoch.Guardians, member) {
		return nil
	}
	for _, id := range epoch.Guardians {
		if id == member {
			continue
		}
		m, err := k.Member(id)
		if err != nil {
			return err
		}
		if m.Licence == "active" {
			return nil
		}
	}
	return errors.New("last active guardian must complete a consented handover before manual exit")
}
func (k Keeper) guardianPropose(c Command, height int64) (string, error) {
	var p struct {
		ID             string   `json:"id"`
		BaseEpoch      string   `json:"base_epoch"`
		Guardians      []string `json:"guardians"`
		ExpiresHeight  int64    `json:"expires_height"`
		EvidenceDigest string   `json:"evidence_digest"`
		Threshold      int      `json:"threshold,omitempty"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	if c.Instance != "" || !k.guardianMember(c.Member) || !validID(p.ID) || !validGuardianList(p.Guardians) || !digestPattern.MatchString(p.EvidenceDigest) || height < 1 || height > math.MaxInt64-GuardianProposalWindow || p.ExpiresHeight <= height || p.ExpiresHeight > height+GuardianProposalWindow {
		return "", errors.New("guardian proposal needs a bounded prospective set, expiry and evidence")
	}
	epoch, err := k.CurrentGuardianEpoch()
	if err != nil {
		return "", err
	}
	if p.BaseEpoch != epoch.ID {
		return "", errors.New("guardian proposal base epoch mismatch")
	}
	// A set under a threshold must restate one for its successor; a successor
	// may never silently fall back to a single signature. Thresholds exist
	// only under consensus v2.
	current := 1
	if k.consensusV2() {
		if current, err = k.GuardianThreshold(); err != nil {
			return "", err
		}
	} else if p.Threshold != 0 {
		return "", errors.New("guardian thresholds need consensus v2")
	}
	if p.Threshold == 0 && current > 1 {
		return "", errors.New("guardian proposal must state the successor threshold")
	}
	if p.Threshold != 0 && (!validGuardianThreshold(p.Threshold, len(p.Guardians)) || (current > 1 && p.Threshold < 2 && len(p.Guardians) > 1)) {
		return "", errors.New("guardian threshold must be a strict majority of the proposed guardians")
	}
	if k.Store.Get([]byte("guardian_proposal/"+p.ID)) != nil {
		return "", errors.New("guardian proposal ID already used")
	}
	for _, id := range p.Guardians {
		m, err := k.Member(id)
		if err != nil || m.Licence != "active" {
			return "", errors.New("incoming guardians must be active members")
		}
	}
	voters := []string{}
	for _, id := range epoch.Guardians {
		m, err := k.Member(id)
		if err != nil {
			return "", err
		}
		if m.Licence == "active" {
			voters = append(voters, id)
		}
	}
	if len(voters) == 0 {
		return "", errors.New("no active guardian authority")
	}
	proposal := GuardianProposal{p.ID, p.BaseEpoch, p.Guardians, voters, c.Member, height, height + 1, p.ExpiresHeight, p.EvidenceDigest, p.Threshold}
	return p.ID, put(k.Store, "guardian_proposal/"+p.ID, proposal)
}
func (k Keeper) guardianAction(c Command, height int64) (GuardianProposal, string, error) {
	var action struct {
		Proposal       string `json:"proposal"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	var p GuardianProposal
	if err := Decode(c.Payload, &action); err != nil {
		return p, "", err
	}
	if c.Instance != "" || !validID(action.Proposal) || !digestPattern.MatchString(action.EvidenceDigest) {
		return p, "", errors.New("member guardian action and evidence required")
	}
	if err := get(k.Store, "guardian_proposal/"+action.Proposal, &p); err != nil {
		return p, "", err
	}
	epoch, err := k.CurrentGuardianEpoch()
	if err != nil {
		return p, "", err
	}
	if p.ID != action.Proposal || p.BaseEpoch != epoch.ID || height < p.Height || height > p.ExpiresHeight || !validGuardianList(p.Guardians) || !validGuardianList(p.Voters) || k.Store.Get([]byte("guardian_epoch/"+p.ID)) != nil {
		return p, "", errors.New("expired, executed or stale guardian proposal")
	}
	return p, action.EvidenceDigest, nil
}
func (k Keeper) guardianApprove(c Command, height int64, consent bool) (string, error) {
	p, evidence, err := k.guardianAction(c, height)
	if err != nil {
		return "", err
	}
	kind := "vote"
	if consent {
		kind = "consent"
		if !guardianContains(p.Guardians, c.Member) {
			return "", errors.New("only proposed guardians can consent")
		}
	} else if !k.guardianMember(c.Member) || !guardianContains(p.Voters, c.Member) {
		return "", errors.New("only snapshot guardians can vote")
	}
	key := "guardian_" + kind + "/" + p.ID + "/" + c.Member
	if k.Store.Get([]byte(key)) != nil {
		return "", errors.New("guardian approval already recorded")
	}
	return p.ID, put(k.Store, key, GuardianApproval{c.Member, height, evidence})
}
func (k Keeper) guardianExecute(c Command, height int64) (string, error) {
	p, evidence, err := k.guardianAction(c, height)
	if err != nil {
		return "", err
	}
	epoch, err := k.CurrentGuardianEpoch()
	if err != nil {
		return "", err
	}
	if !k.guardianMember(c.Member) || !guardianContains(p.Voters, c.Member) || height < p.NotBefore || epoch.Height == height {
		return "", errors.New("current guardian and prospective execution height required")
	}
	votes := 0
	for _, id := range p.Voters {
		m, err := k.Member(id)
		if err != nil {
			return "", err
		}
		if m.Licence == "active" && k.Store.Get([]byte("guardian_vote/"+p.ID+"/"+id)) != nil {
			votes++
		}
	}
	if votes <= len(p.Voters)/2 {
		return "", errors.New("fixed snapshot guardian majority required")
	}
	for _, id := range p.Guardians {
		m, err := k.Member(id)
		if err != nil || m.Licence != "active" {
			return "", errors.New("proposed guardian is no longer active")
		}
		if !guardianContains(epoch.Guardians, id) && k.Store.Get([]byte("guardian_consent/"+p.ID+"/"+id)) == nil {
			return "", errors.New("explicit incoming guardian consent required")
		}
	}
	next := GuardianEpoch{p.ID, p.BaseEpoch, p.Guardians, height, evidence, c.Member, p.Threshold}
	if err := put(k.Store, "guardian_epoch/"+p.ID, next); err != nil {
		return "", err
	}
	return p.ID, put(k.Store, "guardian_epoch_current", p.ID)
}

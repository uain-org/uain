package federation

import (
	"errors"
	"fmt"
	"math"
)

const MembershipPolicy = "project-membership-v1"

type MembershipActivation struct {
	Policy          string `json:"policy"`
	EffectiveHeight int64  `json:"effective_height,string"`
	ApprovedBy      string `json:"approved_by"`
	EvidenceDigest  string `json:"evidence_digest"`
}

type Participation struct {
	Project  string `json:"project"`
	Member   string `json:"member"`
	Instance string `json:"instance,omitempty"`
}

type ArbiterAppointment struct {
	Member         string `json:"member"`
	Instance       string `json:"instance,omitempty"`
	Active         bool   `json:"active"`
	ApprovedBy     string `json:"approved_by"`
	EvidenceDigest string `json:"evidence_digest"`
}

// IDs contain no slash. An empty instance has a distinct trailing component;
// joining as a member never silently enrolls that member's other instances.
func participationKey(project, member, instance string) string {
	return "participation/" + project + "/" + member + "/" + instance
}

func (k Keeper) activateMembership(c Command, height int64) (string, error) {
	var p struct {
		Policy         string `json:"policy"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	if !k.guardian(c.Member) || p.Policy != MembershipPolicy || !digestPattern.MatchString(p.EvidenceDigest) {
		return "", errors.New("membership activation requires guardian, supported policy and evidence")
	}
	if height < 1 || height == math.MaxInt64 || k.Store.Get([]byte("membership_activation")) != nil {
		return "", errors.New("invalid height or membership policy already scheduled")
	}
	a := MembershipActivation{p.Policy, height + 1, c.Member, p.EvidenceDigest}
	return a.Policy, put(k.Store, "membership_activation", a)
}

// Missing activation leaves previous blocks and genesis byte-for-byte intact.
// A transaction schedules the following height so transaction order in the
// activation block cannot give new projects different participation rules.
func (k Keeper) membershipPolicy(height int64) (string, error) {
	if k.Store.Get([]byte("membership_activation")) == nil {
		return "", nil
	}
	var a MembershipActivation
	if err := get(k.Store, "membership_activation", &a); err != nil {
		return "", err
	}
	if a.Policy != MembershipPolicy || a.EffectiveHeight < 2 {
		return "", errors.New("invalid membership activation state")
	}
	if height < a.EffectiveHeight {
		return "", nil
	}
	return a.Policy, nil
}

func (k Keeper) addParticipation(project, member, instance string) error {
	return put(k.Store, participationKey(project, member, instance), Participation{project, member, instance})
}

func (k Keeper) requireParticipation(p Project, c Command) error {
	if p.MembershipPolicy == "" {
		return nil
	} // Existing projects keep their recorded policy.
	if p.MembershipPolicy != MembershipPolicy {
		return errors.New("unsupported project membership policy")
	}
	var joined Participation
	if err := get(k.Store, participationKey(p.ID, c.Member, c.Instance), &joined); err != nil {
		return errors.New("actor must join the project first")
	}
	if joined.Project != p.ID || joined.Member != c.Member || joined.Instance != c.Instance {
		return errors.New("project participation owner mismatch")
	}
	return nil
}

func (k Keeper) joinProject(c Command) (string, error) {
	var p struct {
		Project string `json:"project"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	project, err := k.projectState(p.Project)
	if err != nil {
		return "", err
	}
	if project.State != "active" {
		return "", errors.New("joining requires an active project")
	}
	key := participationKey(project.ID, c.Member, c.Instance)
	if k.Store.Get([]byte(key)) != nil {
		return "", errors.New("actor already joined this project")
	}
	return project.ID, k.addParticipation(project.ID, c.Member, c.Instance)
}

func (k Keeper) appointArbiter(c Command) (string, error) {
	var p struct {
		Member         string `json:"member"`
		Instance       string `json:"instance,omitempty"`
		Active         bool   `json:"active"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	if !k.guardian(c.Member) || !digestPattern.MatchString(p.EvidenceDigest) {
		return "", errors.New("arbiter appointment requires guardian and evidence")
	}
	m, err := k.Member(p.Member)
	if err != nil {
		return "", err
	}
	if m.Licence != "active" {
		return "", errors.New("arbiter must have an active licence")
	}
	if err = k.validateInstance(p.Member, p.Instance); err != nil {
		return "", err
	}
	key := "arbiter/" + p.Member + "/" + p.Instance
	if k.Store.Get([]byte(key)) != nil {
		var old ArbiterAppointment
		if err = get(k.Store, key, &old); err != nil {
			return "", err
		}
		if old.Active == p.Active {
			return "", errors.New("arbiter appointment already in this state")
		}
	} else if !p.Active {
		return "", errors.New("arbiter has no appointment to remove")
	}
	a := ArbiterAppointment{p.Member, p.Instance, p.Active, c.Member, p.EvidenceDigest}
	return fmt.Sprintf("%s/%s", p.Member, p.Instance), put(k.Store, key, a)
}

func (k Keeper) trustedArbiter(c Command) (bool, error) {
	key := "arbiter/" + c.Member + "/" + c.Instance
	if k.Store.Get([]byte(key)) == nil {
		return false, nil
	}
	var a ArbiterAppointment
	if err := get(k.Store, key, &a); err != nil {
		return false, err
	}
	if a.Member != c.Member || a.Instance != c.Instance {
		return false, errors.New("arbiter appointment owner mismatch")
	}
	return a.Active, nil
}

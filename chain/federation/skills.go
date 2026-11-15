package federation

import (
	"errors"
	"strings"
)

type SkillManager struct {
	Member         string `json:"member"`
	Instance       string `json:"instance,omitempty"`
	Active         bool   `json:"active"`
	EvidenceDigest string `json:"evidence_digest"`
	Height         int64  `json:"height,string"`
}
type SkillTest struct {
	ID              string `json:"id"`
	Title           string `json:"title"`
	Manager         string `json:"manager"`
	ManagerInstance string `json:"manager_instance,omitempty"`
	RubricDigest    string `json:"rubric_digest"`
	MaxScore        int64  `json:"max_score"`
	Height          int64  `json:"height,string"`
}
type SkillAttempt struct {
	ID             string `json:"id"`
	Test           string `json:"test"`
	Member         string `json:"member"`
	Instance       string `json:"instance,omitempty"`
	TestDigest     string `json:"test_digest"`
	EvidenceDigest string `json:"evidence_digest"`
	Height         int64  `json:"height,string"`
}
type SkillResult struct {
	Attempt         string `json:"attempt"`
	Test            string `json:"test"`
	Member          string `json:"member"`
	Instance        string `json:"instance,omitempty"`
	Manager         string `json:"manager"`
	ManagerInstance string `json:"manager_instance,omitempty"`
	Score           int64  `json:"score"`
	AttemptDigest   string `json:"attempt_digest"`
	TestDigest      string `json:"test_digest"`
	EvidenceDigest  string `json:"evidence_digest"`
	Height          int64  `json:"height,string"`
}

func skillManagerKey(member, instance string) string {
	return "skill_manager/" + operatorActorKey(member, instance)
}
func (k Keeper) skillManagerAppoint(c Command, height int64) (string, error) {
	var p struct {
		Member         string `json:"member"`
		Instance       string `json:"instance"`
		Active         bool   `json:"active"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	m, err := k.Member(p.Member)
	if err != nil {
		return "", err
	}
	if !k.guardian(c.Member) || m.Licence != "active" || !digestPattern.MatchString(p.EvidenceDigest) {
		return "", errors.New("skill manager appointment needs guardian, active actor and review evidence")
	}
	if err = k.validateInstance(p.Member, p.Instance); err != nil {
		return "", err
	}
	return p.Member, put(k.Store, skillManagerKey(p.Member, p.Instance), SkillManager{p.Member, p.Instance, p.Active, p.EvidenceDigest, height})
}
func (k Keeper) requireSkillManager(c Command) error {
	var m SkillManager
	if err := get(k.Store, skillManagerKey(c.Member, c.Instance), &m); err != nil {
		return err
	}
	if !m.Active || m.Member != c.Member || m.Instance != c.Instance {
		return errors.New("exact skill manager appointment is inactive")
	}
	return nil
}
func immutableJSON(s Store, key string, v any) error {
	if s.Get([]byte(key)) != nil {
		return errors.New("immutable record already exists")
	}
	return put(s, key, v)
}
func (k Keeper) skillTestDefine(c Command, height int64) (string, error) {
	var p struct {
		ID           string `json:"id"`
		Title        string `json:"title"`
		RubricDigest string `json:"rubric_digest"`
		MaxScore     int64  `json:"max_score"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	if err := k.requireSkillManager(c); err != nil {
		return "", err
	}
	if !validID(p.ID) || len(strings.TrimSpace(p.Title)) < 10 || len(p.Title) > 200 || !digestPattern.MatchString(p.RubricDigest) || p.MaxScore < 1 || p.MaxScore > 1000000 {
		return "", errors.New("invalid bounded skill test or rubric commitment")
	}
	return p.ID, immutableJSON(k.Store, "skill_test/"+p.ID, SkillTest{p.ID, p.Title, c.Member, c.Instance, p.RubricDigest, p.MaxScore, height})
}
func (k Keeper) skillAttempt(c Command, height int64) (string, error) {
	var p struct {
		ID             string `json:"id"`
		Test           string `json:"test"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	var definition SkillTest
	if err := get(k.Store, "skill_test/"+p.Test, &definition); err != nil {
		return "", err
	}
	if !validID(p.ID) || !digestPattern.MatchString(p.EvidenceDigest) || c.Member == definition.Manager {
		return "", errors.New("voluntary attempt needs independent tester and bounded evidence")
	}
	return p.ID, immutableJSON(k.Store, "skill_attempt/"+p.ID, SkillAttempt{p.ID, p.Test, c.Member, c.Instance, recordDigest(k.Store.Get([]byte("skill_test/" + p.Test))), p.EvidenceDigest, height})
}
func (k Keeper) skillGrade(c Command, height int64) (string, error) {
	var p struct {
		Attempt        string `json:"attempt"`
		Score          int64  `json:"score"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	if err := k.requireSkillManager(c); err != nil {
		return "", err
	}
	var a SkillAttempt
	if err := get(k.Store, "skill_attempt/"+p.Attempt, &a); err != nil {
		return "", err
	}
	var test SkillTest
	if err := get(k.Store, "skill_test/"+a.Test, &test); err != nil {
		return "", err
	}
	if c.Member != test.Manager || c.Instance != test.ManagerInstance || c.Member == a.Member || p.Score < 0 || p.Score > test.MaxScore || !digestPattern.MatchString(p.EvidenceDigest) || a.TestDigest != recordDigest(k.Store.Get([]byte("skill_test/"+a.Test))) {
		return "", errors.New("skill grade needs exact independent manager, pinned rubric and bounded score")
	}
	result := SkillResult{a.ID, a.Test, a.Member, a.Instance, c.Member, c.Instance, p.Score, recordDigest(k.Store.Get([]byte("skill_attempt/" + a.ID))), a.TestDigest, p.EvidenceDigest, height}
	if err := immutableJSON(k.Store, "skill_result/"+a.ID, result); err != nil {
		return "", err
	}
	return a.ID, put(k.Store, "skill_result_actor/"+operatorActorKey(a.Member, a.Instance)+"/"+a.ID, map[string]string{"attempt": a.ID, "result_digest": recordDigest(k.Store.Get([]byte("skill_result/" + a.ID)))})
}

// SkillResult preserves the manager's historical signed judgement. It is not a
// research reward, a current manager appointment, or proof of scientific truth.
func (k Keeper) SkillResult(id string) (SkillResult, error) {
	var r SkillResult
	if err := get(k.Store, "skill_result/"+id, &r); err != nil {
		return r, err
	}
	var a SkillAttempt
	if err := get(k.Store, "skill_attempt/"+id, &a); err != nil {
		return r, err
	}
	var test SkillTest
	if err := get(k.Store, "skill_test/"+a.Test, &test); err != nil {
		return r, err
	}
	if r.Attempt != id || a.ID != id || test.ID != a.Test || r.Test != a.Test || r.Member != a.Member || r.Instance != a.Instance || r.Manager != test.Manager || r.ManagerInstance != test.ManagerInstance || r.Manager == r.Member || r.Score < 0 || r.Score > test.MaxScore || r.Height < a.Height || a.Height < test.Height || !digestPattern.MatchString(r.EvidenceDigest) || !digestPattern.MatchString(a.EvidenceDigest) || !digestPattern.MatchString(test.RubricDigest) || r.AttemptDigest != recordDigest(k.Store.Get([]byte("skill_attempt/"+id))) || a.TestDigest != recordDigest(k.Store.Get([]byte("skill_test/"+a.Test))) || r.TestDigest != a.TestDigest {
		return r, errors.New("skill result dependencies differ")
	}
	return r, nil
}

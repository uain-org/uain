package federation

import (
	"errors"
	"net/url"
	"regexp"
	"strings"
)

const MaxOpenChallengesPerTask = 20

var priorArtIdentifier = regexp.MustCompile(`(?i)^(PMID:?\s*[0-9]{1,9}|(?:doi:\s*)?10\.[0-9]{4,9}/[^\s]+)$`)

func publicPriorArtSource(s string) bool {
	if len(s) == 0 || len(s) > 500 || strings.TrimSpace(s) != s {
		return false
	}
	if priorArtIdentifier.MatchString(s) {
		return true
	}
	u, err := url.Parse(s)
	return err == nil && (strings.EqualFold(u.Scheme, "http") || strings.EqualFold(u.Scheme, "https")) && u.Hostname() != "" && u.User == nil
}

type PriorArtChallenge struct {
	ID               string `json:"id"`
	Task             string `json:"task"`
	Challenger       string `json:"challenger"`
	Instance         string `json:"instance,omitempty"`
	Source           string `json:"source"`
	Note             string `json:"note"`
	State            string `json:"state"`
	DecidedBy        string `json:"decided_by,omitempty"`
	DecidingInstance string `json:"deciding_instance,omitempty"`
	DecisionNote     string `json:"decision_note,omitempty"`
}

func (k Keeper) PriorArtChallenge(id string) (PriorArtChallenge, error) {
	var c PriorArtChallenge
	err := get(k.Store, "prior_art_challenge/"+id, &c)
	if err == nil && c.State == "open" {
		t, e := k.taskState(c.Task)
		if e != nil {
			return c, e
		}
		if t.PriorArtDecision != "" {
			c.State = "moot"
		}
	}
	return c, err
}

func (k Keeper) challengeProject(t Task, c Command) (Project, error) {
	p, err := k.projectState(t.Project)
	if err != nil {
		return p, err
	}
	if p.MembershipPolicy != MembershipPolicy {
		return p, errors.New("prior-art challenges require prospective project membership policy")
	}
	if p.State != "active" || (t.State != "open" && t.State != "kpi_met" && t.State != "settled") {
		return p, errors.New("project or task closed to challenges")
	}
	return p, k.requireParticipation(p, c)
}

func (k Keeper) challengePriorArt(c Command) (string, error) {
	var p struct {
		ID     string `json:"id"`
		Task   string `json:"task"`
		Source string `json:"source"`
		Note   string `json:"note"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	t, err := k.taskState(p.Task)
	if err != nil {
		return "", err
	}
	if _, err = k.challengeProject(t, c); err != nil {
		return "", err
	}
	p.Note = strings.TrimSpace(p.Note)
	if !validID(p.ID) || !publicPriorArtSource(p.Source) || len(p.Note) < 20 || len(p.Note) > 4000 {
		return "", errors.New("challenge needs unique ID, public source and bounded explanatory note")
	}
	if k.Store.Get([]byte("prior_art_challenge/"+p.ID)) != nil {
		return "", errors.New("challenge ID already exists")
	}
	if len(t.OpenChallenges) >= MaxOpenChallengesPerTask {
		return "", errors.New("task open challenge limit reached")
	}
	ownerKey := "prior_art_open/" + t.ID + "/" + c.Member
	if k.Store.Get([]byte(ownerKey)) != nil {
		return "", errors.New("member already has an open challenge on this task")
	}
	challenge := PriorArtChallenge{ID: p.ID, Task: t.ID, Challenger: c.Member, Instance: c.Instance, Source: p.Source, Note: p.Note, State: "open"}
	t.OpenChallenges = append(t.OpenChallenges, challenge.ID)
	if err = put(k.Store, "task/"+t.ID, t); err != nil {
		return "", err
	}
	if err = put(k.Store, ownerKey, challenge.ID); err != nil {
		return "", err
	}
	return challenge.ID, put(k.Store, "prior_art_challenge/"+challenge.ID, challenge)
}

func (k Keeper) decidePriorArt(c Command) (string, error) {
	var p struct {
		Challenge string `json:"challenge"`
		Decision  string `json:"decision"`
		Note      string `json:"note"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	// The task is loaded immediately below; avoid loading its large metadata
	// a second time just to project an open challenge's effective state.
	var challenge PriorArtChallenge
	err := get(k.Store, "prior_art_challenge/"+p.Challenge, &challenge)
	if err != nil {
		return "", err
	}
	p.Note = strings.TrimSpace(p.Note)
	if challenge.State != "open" || (p.Decision != "upheld" && p.Decision != "rejected") || len(p.Note) == 0 || len(p.Note) > 4000 {
		return "", errors.New("decision requires an open challenge, verdict and bounded reason")
	}
	t, err := k.taskState(challenge.Task)
	if err != nil {
		return "", err
	}
	if _, err = k.challengeProject(t, c); err != nil {
		return "", err
	}
	m, err := k.Member(c.Member)
	if err != nil {
		return "", err
	}
	trusted, err := k.trustedArbiter(c)
	if err != nil {
		return "", err
	}
	if (!m.DefaultVerifier && !trusted) || challenge.Challenger == c.Member {
		return "", errors.New("judge must be a default verifier or appointed arbiter of another member")
	}
	if len(t.OpenChallenges) > MaxOpenChallengesPerTask {
		return "", errors.New("task challenge index exceeds bound")
	}
	found := false
	remaining := make([]string, 0, len(t.OpenChallenges))
	for _, id := range t.OpenChallenges {
		if id == challenge.ID {
			found = true
		} else {
			remaining = append(remaining, id)
		}
	}
	if !found {
		return "", errors.New("challenge absent from task index")
	}
	ownerKey := "prior_art_open/" + t.ID + "/" + challenge.Challenger
	var openID string
	if err = get(k.Store, ownerKey, &openID); err != nil || openID != challenge.ID {
		return "", errors.New("inconsistent open challenge owner index")
	}
	k.Store.Delete([]byte(ownerKey))
	challenge.State = p.Decision
	challenge.DecidedBy = c.Member
	challenge.DecidingInstance = c.Instance
	challenge.DecisionNote = p.Note
	if p.Decision == "upheld" {
		// One task closure makes pending answers known and other open
		// challenges moot. Getters derive that status from this record; no
		// work/large evidence rows are scanned or rewritten by the decision.
		// Already paid answers retain their exact original award and state.
		t.State, t.PriorArtDecision = "known", challenge.ID
		remaining = nil
		if err = k.releaseReservation(&t); err != nil {
			return "", err
		}
	}
	t.OpenChallenges = remaining
	if err = put(k.Store, "task/"+t.ID, t); err != nil {
		return "", err
	}
	return challenge.ID, put(k.Store, "prior_art_challenge/"+challenge.ID, challenge)
}

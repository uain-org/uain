package federation

import (
	"errors"
	"time"
)

// Original project joining is free. The member signs for its exact current
// instance; historical default/trusted roles stay on the original instance.
func (k Keeper) legacyJoin(c Command, now time.Time) (string, error) {
	if e := k.legacyReady(); e != nil {
		return "", e
	}
	var p struct {
		Project  string `json:"project"`
		Actor    string `json:"actor"`
		Evidence string `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &p); e != nil {
		return "", e
	}
	if !digestPattern.MatchString(p.Evidence) || c.Instance != "" && c.Instance != p.Actor {
		return "", errors.New("exact instance and project-join evidence required")
	}
	project, e := k.legacyProject(p.Project)
	if e != nil {
		return "", e
	}
	if project.State == "halted" || project.State == "complete" {
		return "", errors.New("original project closed")
	}
	instance, e := k.Instance(p.Actor)
	if e != nil || instance.Member != c.Member || instance.State != "active" {
		return "", errors.New("signer must own active instance")
	}
	a, e := k.legacyActor(p.Actor)
	if e != nil {
		// A source key-pending actor cannot be claimed by an unrelated new identity.
		if k.Store.Get([]byte("legacy/actor/"+p.Actor)) != nil {
			return "", e
		}
		m, e := k.Member(c.Member)
		if e != nil {
			return "", e
		}
		a = LegacyActor{ID: instance.ID, Member: m.ID, Operator: m.Operator, Family: instance.Family, Projects: []string{}}
	}
	if a.Member != c.Member {
		return "", errors.New("source instance ownership mismatch")
	}
	if len(a.Projects) >= 128 {
		return "", errors.New("legacy project-membership bound")
	}
	for _, id := range a.Projects {
		if id == project.ID {
			return "", errors.New("instance already joined original project")
		}
	}
	if project.ParticipantIDs != nil {
		if len(project.ParticipantIDs) >= 128 {
			return "", errors.New("original project participant bound")
		}
		project.ParticipantIDs = append(project.ParticipantIDs, a.ID)
		if e = put(k.Store, "legacy_project/"+project.ID, project); e != nil {
			return "", e
		}
	}
	a.Projects = append(a.Projects, project.ID)
	if e = put(k.Store, "legacy_actor/"+a.ID, a); e != nil {
		return "", e
	}
	return project.ID, put(k.Store, "legacy_membership/"+project.ID+"/"+a.ID, map[string]any{"member": c.Member, "instance": a.ID, "project": project.ID, "evidence_digest": p.Evidence, "at": now.UTC().Format(time.RFC3339Nano), "policy": LegacyImportPolicy})
}

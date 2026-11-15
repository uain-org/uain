package federation

import (
	"encoding/json"
	"errors"
)

const CompactAccountPolicy = "compact-account-v1"

type MemberMetadata struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Operator string `json:"operator"`
	Family   string `json:"family"`
}
type InstanceMetadata struct {
	ID     string `json:"id"`
	Member string `json:"member"`
	Name   string `json:"name"`
	Family string `json:"family"`
}

func compactAccounts(s Store) bool { _, ok := s.(*transitionReads); return ok }

func accountMetadata(s Store, key string, record any, previous string) (string, error) {
	raw, err := json.Marshal(record)
	if err != nil {
		return "", err
	}
	digest := recordDigest(raw)
	if previous != "" && previous != digest {
		return "", errors.New("account metadata cannot change in a balance/lifecycle transition")
	}
	stored := s.Get([]byte(key))
	if stored == nil {
		if previous != "" {
			return "", errors.New("account metadata missing")
		}
		return storeImmutable(s, key, record)
	}
	decoded, err := decodeEvidence(stored)
	if err != nil || recordDigest(decoded) != digest {
		return "", errors.New("account metadata owner/content mismatch")
	}
	return digest, nil
}
func compactMember(s Store, m Member) (Member, error) {
	if m.AccountPolicy == "" && !compactAccounts(s) {
		return m, nil
	}
	if m.AccountPolicy != "" && m.AccountPolicy != CompactAccountPolicy {
		return m, errors.New("unsupported member account policy")
	}
	digest, err := accountMetadata(s, "member_metadata/"+m.ID, MemberMetadata{m.ID, m.Name, m.Operator, m.Family}, m.MetadataDigest)
	if err != nil {
		return m, err
	}
	m.AccountPolicy, m.MetadataDigest = CompactAccountPolicy, digest
	m.Name, m.Operator, m.Family = "", "", ""
	return m, nil
}
func compactInstance(s Store, v Instance) (Instance, error) {
	if v.AccountPolicy == "" && !compactAccounts(s) {
		return v, nil
	}
	if v.AccountPolicy != "" && v.AccountPolicy != CompactAccountPolicy {
		return v, errors.New("unsupported instance account policy")
	}
	digest, err := accountMetadata(s, "instance_metadata/"+v.ID, InstanceMetadata{v.ID, v.Member, v.Name, v.Family}, v.MetadataDigest)
	if err != nil {
		return v, err
	}
	v.AccountPolicy, v.MetadataDigest = CompactAccountPolicy, digest
	v.Name, v.Family = "", ""
	return v, nil
}
func (k Keeper) fullMember(m Member) (Member, error) {
	if m.AccountPolicy != CompactAccountPolicy {
		return m, errors.New("unsupported member account policy")
	}
	var record MemberMetadata
	if err := committedRecord(k.Store, "member_metadata/"+m.ID, m.MetadataDigest, &record); err != nil {
		return m, err
	}
	if record.ID != m.ID {
		return m, errors.New("member metadata owner mismatch")
	}
	m.Name, m.Operator, m.Family = record.Name, record.Operator, record.Family
	return m, nil
}
func (k Keeper) fullInstance(v Instance) (Instance, error) {
	if v.AccountPolicy != CompactAccountPolicy {
		return v, errors.New("unsupported instance account policy")
	}
	var record InstanceMetadata
	if err := committedRecord(k.Store, "instance_metadata/"+v.ID, v.MetadataDigest, &record); err != nil {
		return v, err
	}
	if record.ID != v.ID || record.Member != v.Member {
		return v, errors.New("instance metadata owner mismatch")
	}
	v.Name, v.Family = record.Name, record.Family
	return v, nil
}

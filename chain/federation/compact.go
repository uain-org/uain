package federation

import (
	"bytes"
	"compress/zlib"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"reflect"
)

const CompactStatePolicy = "compact-state-v1"

// The activation is prospective and explicitly separate from research policy.
// Old projects retain their exact serialized state and transition behavior.
func (k Keeper) activateStorage(c Command, height int64) (string, error) {
	var p struct {
		Policy         string `json:"policy"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	if !k.guardian(c.Member) || p.Policy != CompactStatePolicy || !digestPattern.MatchString(p.EvidenceDigest) {
		return "", errors.New("storage activation needs guardian, supported policy and evidence")
	}
	if height < 1 || height == math.MaxInt64 || k.Store.Get([]byte("storage_activation")) != nil {
		return "", errors.New("invalid height or storage policy already scheduled")
	}
	a := MembershipActivation{p.Policy, height + 1, c.Member, p.EvidenceDigest}
	return p.Policy, put(k.Store, "storage_activation", a)
}

func (k Keeper) storagePolicy(height int64) (string, error) {
	var marker []byte
	if reader, ok := k.Store.(interface{ StoragePolicyMarker() []byte }); ok {
		marker = reader.StoragePolicyMarker()
	} else {
		marker = k.Store.Get([]byte("storage_activation"))
	}
	if marker == nil {
		return "", nil
	}
	var a MembershipActivation
	if err := Decode(marker, &a); err != nil {
		return "", err
	}
	if a.Policy != CompactStatePolicy || a.EffectiveHeight < 2 {
		return "", errors.New("invalid storage activation")
	}
	if height < a.EffectiveHeight {
		return "", nil
	}
	return a.Policy, nil
}

// The application uses this fixed-size marker to select the prospective
// execution/gas path, without changing validation of old blocks.
func (k Keeper) CompactStorageActive(height int64) (bool, error) {
	policy, err := k.storagePolicy(height)
	return policy == CompactStatePolicy, err
}

type ProjectMetadata struct {
	ID       string   `json:"id"`
	Title    string   `json:"title"`
	Class    string   `json:"class"`
	PriorArt PriorArt `json:"prior_art"`
}
type TaskMetadata struct {
	ID       string   `json:"id"`
	Title    string   `json:"title"`
	Class    string   `json:"class"`
	PriorArt PriorArt `json:"prior_art"`
	Criteria string   `json:"criteria"`
}
type VerificationEvidence struct {
	Contribution string       `json:"contribution"`
	Check        Verification `json:"check"`
}

func recordDigest(raw []byte) string {
	h := sha256.Sum256(raw)
	return hex.EncodeToString(h[:])
}
func storeImmutable(s Store, key string, record any) (string, error) {
	if s.Get([]byte(key)) != nil {
		return "", errors.New("immutable evidence already exists")
	}
	raw, err := json.Marshal(record)
	if err != nil {
		return "", err
	}
	stored, err := encodeEvidence(raw)
	if err != nil {
		return "", err
	}
	s.Set([]byte(key), stored)
	return recordDigest(raw), nil
}

// RFC1950 zlib wraps the exact JSON bytes. The content digest covers the JSON,
// while the IAVL proof covers the stored compressed bytes. Decoding is bounded
// by the signed-envelope size; no external content or codec negotiation occurs.
func encodeEvidence(raw []byte) ([]byte, error) {
	if len(raw) > MaxEnvelopeBytes {
		return nil, errors.New("immutable evidence exceeds envelope bound")
	}
	var out bytes.Buffer
	w, err := zlib.NewWriterLevel(&out, zlib.BestCompression)
	if err != nil {
		return nil, err
	}
	if _, err = w.Write(raw); err != nil {
		return nil, err
	}
	if err = w.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
func decodeEvidence(stored []byte) ([]byte, error) {
	r, err := zlib.NewReader(bytes.NewReader(stored))
	if err != nil {
		return nil, err
	}
	defer r.Close()
	raw, err := io.ReadAll(io.LimitReader(r, MaxEnvelopeBytes+1))
	if err != nil || len(raw) > MaxEnvelopeBytes {
		return nil, errors.New("invalid or oversized compressed evidence")
	}
	return raw, nil
}
func committedRecord(s Store, key, digest string, record any) error {
	stored := s.Get([]byte(key))
	if !digestPattern.MatchString(digest) || stored == nil {
		return errors.New("missing or mismatched immutable evidence")
	}
	raw, err := decodeEvidence(stored)
	if err != nil {
		return err
	}
	if recordDigest(raw) != digest {
		return errors.New("immutable evidence digest mismatch")
	}
	return Decode(raw, record)
}

func (k Keeper) createProject(p Project) error {
	if p.StoragePolicy == CompactStatePolicy {
		var err error
		p.MetadataDigest, err = storeImmutable(k.Store, "project_metadata/"+p.ID, ProjectMetadata{p.ID, p.Title, p.Class, p.PriorArt})
		if err != nil {
			return err
		}
		p.Title, p.Class, p.PriorArt = "", "", PriorArt{}
	}
	return put(k.Store, "project/"+p.ID, p)
}
func (k Keeper) createTask(t Task) error {
	if t.StoragePolicy == CompactStatePolicy {
		var err error
		t.MetadataDigest, err = storeImmutable(k.Store, "task_metadata/"+t.ID, TaskMetadata{t.ID, t.Title, t.Class, t.PriorArt, t.Criteria})
		if err != nil {
			return err
		}
		t.Title, t.Class, t.PriorArt, t.Criteria = "", "", PriorArt{}, ""
	}
	return put(k.Store, "task/"+t.ID, t)
}

// Public getters reconstruct complete evidence. Consensus transitions use the
// small state records directly, without repeatedly reading research searches.
// A remote verifier must prove every referenced record at the same height.
func (k Keeper) Project(id string) (Project, error) {
	p, err := k.projectState(id)
	if err != nil || p.StoragePolicy == "" {
		return p, err
	}
	if p.StoragePolicy != CompactStatePolicy {
		return p, errors.New("unsupported project storage")
	}
	var m ProjectMetadata
	if err = committedRecord(k.Store, "project_metadata/"+id, p.MetadataDigest, &m); err != nil {
		return p, err
	}
	if m.ID != id {
		return p, errors.New("project metadata owner mismatch")
	}
	p.Title, p.Class, p.PriorArt = m.Title, m.Class, m.PriorArt
	return p, nil
}
func (k Keeper) Task(id string) (Task, error) {
	t, err := k.taskState(id)
	if err != nil || t.StoragePolicy == "" {
		return t, err
	}
	if t.StoragePolicy != CompactStatePolicy {
		return t, errors.New("unsupported task storage")
	}
	var m TaskMetadata
	if err = committedRecord(k.Store, "task_metadata/"+id, t.MetadataDigest, &m); err != nil {
		return t, err
	}
	if m.ID != id {
		return t, errors.New("task metadata owner mismatch")
	}
	t.Title, t.Class, t.PriorArt, t.Criteria = m.Title, m.Class, m.PriorArt, m.Criteria
	return t, nil
}

func (k Keeper) storeVerification(contribution string, check Verification) (Verification, error) {
	if check.RecordDigest != "" {
		return check, errors.New("verification evidence is chain-managed")
	}
	raw, err := json.Marshal(VerificationEvidence{contribution, check})
	if err != nil {
		return check, err
	}
	digest := recordDigest(raw)
	key := "verification_evidence/" + contribution + "/" + digest
	if k.Store.Get([]byte(key)) != nil {
		return check, errors.New("verification evidence already exists")
	}
	stored, err := encodeEvidence(raw)
	if err != nil {
		return check, err
	}
	k.Store.Set([]byte(key), stored)
	check.RecordDigest, check.Searches = digest, nil
	check.EvidenceDigest, check.KnownSource = "", ""
	if err = put(k.Store, "verification_summary/"+contribution+"/"+digest, check); err != nil {
		return check, err
	}
	return check, nil
}
func (k Keeper) fullVerification(contribution string, summary Verification) (Verification, error) {
	var record VerificationEvidence
	if err := committedRecord(k.Store, "verification_evidence/"+contribution+"/"+summary.RecordDigest, summary.RecordDigest, &record); err != nil {
		return summary, err
	}
	check := record.Check
	check.RecordDigest, check.Searches = summary.RecordDigest, nil
	check.EvidenceDigest, check.KnownSource = "", ""
	if record.Contribution != contribution || !reflect.DeepEqual(check, summary) {
		return summary, errors.New("verification evidence owner or summary mismatch")
	}
	check.Searches = record.Check.Searches
	check.EvidenceDigest, check.KnownSource = record.Check.EvidenceDigest, record.Check.KnownSource
	return check, nil
}
func (k Keeper) Contribution(id string) (Contribution, error) {
	v, err := k.contributionState(id)
	if err != nil || v.StoragePolicy == "" {
		return v, err
	}
	if v.StoragePolicy != CompactStatePolicy {
		return v, errors.New("unsupported contribution storage")
	}
	if v.ResearchPolicy != "" {
		if err = k.validateResearchProceedings(v); err != nil {
			return v, err
		}
	}
	for i, check := range v.Verifications {
		v.Verifications[i], err = k.fullVerification(id, check)
		if err != nil {
			return v, err
		}
	}
	if v.ArbitrationDigest != "" {
		if _, err = k.Arbitration(id); err != nil {
			return v, err
		}
	}
	if v.Settlement != nil {
		if len(v.Settlement.CheckRefs) > 0 {
			v.Settlement.Checks, err = k.frozenChecks(v)
			if err != nil {
				return v, err
			}
		}
		for i, check := range v.Settlement.Checks {
			v.Settlement.Checks[i], err = k.fullVerification(id, check)
			if err != nil {
				return v, err
			}
		}
	}
	return v, nil
}

func (k Keeper) frozenChecks(v Contribution) ([]Verification, error) {
	if v.StoragePolicy != CompactStatePolicy {
		return v.Settlement.Checks, nil
	}
	limit := 20
	if v.ArbitrationPolicy == ArbitrationPolicy {
		limit = MaxArbitrationChecks
		if v.ResearchPolicy == ResearchProceedingsPolicy {
			limit = MaxProceedingChecks
		}
	}
	if len(v.Settlement.CheckRefs) == 0 || len(v.Settlement.CheckRefs) > limit || len(v.Settlement.Checks) > 0 {
		return nil, errors.New("invalid compact frozen check references")
	}
	checks := make([]Verification, 0, len(v.Settlement.CheckRefs))
	seen := map[string]bool{}
	for _, ref := range v.Settlement.CheckRefs {
		if !digestPattern.MatchString(ref) || seen[ref] {
			return nil, errors.New("invalid or repeated frozen check reference")
		}
		seen[ref] = true
		var check Verification
		if err := get(k.Store, "verification_summary/"+v.ID+"/"+ref, &check); err != nil {
			return nil, err
		}
		if check.RecordDigest != ref || len(check.Searches) > 0 {
			return nil, errors.New("frozen check summary mismatch")
		}
		checks = append(checks, check)
	}
	return checks, nil
}

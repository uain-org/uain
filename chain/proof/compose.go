package proof

import (
	"bytes"
	"errors"

	abci "github.com/cometbft/cometbft/abci/types"
	"github.com/uain-org/uain/chain/federation"
)

// Composition accepts only inclusion proofs against one independently trusted
// app hash and height. Verify the signed header first; the RPC is not a root of
// trust. Missing dependencies fail closed, including compressed evidence.
type verifiedRecords map[string][]byte

func (s verifiedRecords) Get(key []byte) []byte { return bytes.Clone(s[string(key)]) }
func (s verifiedRecords) Set([]byte, []byte)    { panic("proof records are read-only") }
func (s verifiedRecords) Delete([]byte)         { panic("proof records are read-only") }
func (s verifiedRecords) Range([]byte, []byte, int) ([]federation.Entry, error) {
	return nil, errors.New("proof composition cannot scan records")
}
func (s verifiedRecords) Last([]byte, []byte) (*federation.Entry, error) {
	return nil, errors.New("proof composition cannot scan records")
}

func verifyRecords(queries []abci.ResponseQuery, appHash []byte, height int64) (federation.Keeper, error) {
	if len(queries) == 0 || len(queries) > 96 {
		return federation.Keeper{}, errors.New("bounded compound proof required")
	}
	s := verifiedRecords{}
	for _, q := range queries {
		key := string(q.Key)
		if len(key) > 512 || len(q.Value) > federation.MaxEnvelopeBytes || s[key] != nil {
			return federation.Keeper{}, errors.New("invalid or duplicate compound proof record")
		}
		if err := VerifyQuery(q, key, appHash, height); err != nil {
			return federation.Keeper{}, err
		}
		s[key] = bytes.Clone(q.Value)
	}
	return federation.Keeper{Store: s}, nil
}

func VerifyProject(queries []abci.ResponseQuery, id string, appHash []byte, height int64) (federation.Project, error) {
	k, err := verifyRecords(queries, appHash, height)
	if err != nil {
		return federation.Project{}, err
	}
	return k.Project(id)
}
func VerifyMember(queries []abci.ResponseQuery, id string, appHash []byte, height int64) (federation.Member, error) {
	k, err := verifyRecords(queries, appHash, height)
	if err != nil {
		return federation.Member{}, err
	}
	return k.Member(id)
}

func VerifyBootstrapState(queries []abci.ResponseQuery, appHash []byte, height int64) (federation.BootstrapStatus, error) {
	k, err := verifyRecords(queries, appHash, height)
	if err != nil {
		return federation.BootstrapStatus{}, err
	}
	if k.Store.Get([]byte("operator_census_activation")) == nil || k.Store.Get([]byte("operator_census_revision")) == nil || k.Store.Get([]byte("operator_census")) == nil {
		return federation.BootstrapStatus{}, errors.New("bootstrap state requires activation, current revision and census proofs")
	}
	return k.BootstrapState(height)
}
func VerifyInstance(queries []abci.ResponseQuery, id string, appHash []byte, height int64) (federation.Instance, error) {
	k, err := verifyRecords(queries, appHash, height)
	if err != nil {
		return federation.Instance{}, err
	}
	v, err := k.Instance(id)
	if err != nil {
		return v, err
	}
	if _, err = k.Member(v.Member); err != nil {
		return v, err
	}
	return v, nil
}
func VerifyTask(queries []abci.ResponseQuery, id string, appHash []byte, height int64) (federation.Task, error) {
	k, err := verifyRecords(queries, appHash, height)
	if err != nil {
		return federation.Task{}, err
	}
	t, err := k.Task(id)
	if err != nil {
		return t, err
	}
	// Project closure and safety/accounting policy also affect a task's use.
	if _, err = k.Project(t.Project); err != nil {
		return t, err
	}
	return t, nil
}
func VerifyContribution(queries []abci.ResponseQuery, id string, appHash []byte, height int64) (federation.Contribution, error) {
	k, err := verifyRecords(queries, appHash, height)
	if err != nil {
		return federation.Contribution{}, err
	}
	v, err := k.Contribution(id)
	if err != nil {
		return v, err
	}
	t, err := k.Task(v.Task)
	if err != nil {
		return v, err
	}
	if _, err = k.Project(t.Project); err != nil {
		return v, err
	}
	return v, nil
}

func VerifySkillResult(queries []abci.ResponseQuery, id string, appHash []byte, height int64) (federation.SkillResult, error) {
	k, err := verifyRecords(queries, appHash, height)
	if err != nil {
		return federation.SkillResult{}, err
	}
	return k.SkillResult(id)
}
func VerifyResourceCollaboration(queries []abci.ResponseQuery, id string, appHash []byte, height int64) (federation.ResourceCollaboration, error) {
	k, err := verifyRecords(queries, appHash, height)
	if err != nil {
		return federation.ResourceCollaboration{}, err
	}
	return k.ResourceCollaboration(id)
}

func VerifyResourceOffer(queries []abci.ResponseQuery, id string, appHash []byte, height int64) (federation.ResourceOfferView, error) {
	k, err := verifyRecords(queries, appHash, height)
	if err != nil {
		return federation.ResourceOfferView{}, err
	}
	return k.ResourceOffer(id)
}

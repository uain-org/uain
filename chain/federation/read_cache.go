package federation

import (
	"bytes"
	"sort"
	"strings"
)

const transitionCacheBytes = 1024 * 1024
const transitionCacheKeys = 1024

// One operation only: no values cross transaction/cache/height boundaries.
// Ordinary writes go through to the SDK message cache immediately. Fixed
// accounting counters/prefixes coalesce and flush before the operation returns;
// iterators see that overlay. Oversized records are uncached.
type transitionReads struct {
	Store
	values  map[string][]byte
	bytes   int
	pending map[string][]byte
}

func (s *transitionReads) ArbitrationMarker() []byte {
	if reader, ok := s.Store.(interface{ ArbitrationMarker() []byte }); ok {
		return reader.ArbitrationMarker()
	}
	return s.Get([]byte("arbitration_activation"))
}

func (s *transitionReads) OperatorRewardMarker() []byte {
	if reader, ok := s.Store.(interface{ OperatorRewardMarker() []byte }); ok {
		return reader.OperatorRewardMarker()
	}
	return s.Get([]byte("operator_reward_activation"))
}

func (s *transitionReads) remember(key string, value []byte) {
	if old, ok := s.values[key]; ok {
		s.bytes -= len(key) + len(old)
		delete(s.values, key)
	}
	if len(s.values) >= transitionCacheKeys || s.bytes+len(key)+len(value) > transitionCacheBytes {
		return
	}
	s.values[key] = bytes.Clone(value)
	s.bytes += len(key) + len(value)
}
func (s *transitionReads) Get(key []byte) []byte {
	if value, ok := s.pending[string(key)]; ok {
		return bytes.Clone(value)
	}
	if value, ok := s.values[string(key)]; ok {
		return bytes.Clone(value)
	}
	value := s.Store.Get(key)
	s.remember(string(key), value)
	return bytes.Clone(value)
}
func (s *transitionReads) Set(key, value []byte) {
	k := string(key)
	// These counters/prefixes are read through this wrapper. Coalesce their
	// repeated updates within one bounded payout; preserve every journal row.
	coalesce := k == "credit_count" || k == "karma_count" || k == "issuance_total" || k == "issuance_clock" || strings.HasPrefix(k, "issuance_time/")
	if coalesce && (len(s.pending) < 32 || s.pending[k] != nil) {
		if s.pending == nil {
			s.pending = map[string][]byte{}
		}
		s.pending[k] = bytes.Clone(value)
	} else {
		s.Store.Set(key, value)
	}
	s.remember(string(key), value)
}
func (s *transitionReads) Delete(key []byte) {
	delete(s.pending, string(key))
	s.Store.Delete(key)
	s.remember(string(key), nil)
}

func (s *transitionReads) Last(start, end []byte) (*Entry, error) {
	row, err := s.Store.Last(start, end)
	if err != nil {
		return nil, err
	}
	for key, value := range s.pending {
		k := []byte(key)
		if (len(start) == 0 || bytes.Compare(k, start) >= 0) && (len(end) == 0 || bytes.Compare(k, end) < 0) && (row == nil || bytes.Compare(k, row.Key) >= 0) {
			row = &Entry{bytes.Clone(k), bytes.Clone(value)}
		}
	}
	return row, nil
}
func (s *transitionReads) Range(start, end []byte, limit int) ([]Entry, error) {
	rows, err := s.Store.Range(start, end, limit)
	if err != nil {
		return nil, err
	}
	values := map[string][]byte{}
	for _, row := range rows {
		values[string(row.Key)] = row.Value
	}
	for key, value := range s.pending {
		if (len(start) == 0 || bytes.Compare([]byte(key), start) >= 0) && (len(end) == 0 || bytes.Compare([]byte(key), end) < 0) {
			values[key] = value
		}
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := []Entry{}
	for _, key := range keys {
		if len(out) >= limit {
			break
		}
		out = append(out, Entry{[]byte(key), bytes.Clone(values[key])})
	}
	return out, nil
}
func (s *transitionReads) flush() {
	keys := make([]string, 0, len(s.pending))
	for key := range s.pending {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		s.Store.Set([]byte(key), s.pending[key])
	}
	s.pending = nil
}

func (s *transitionReads) PrivateProofGas(amount uint64) {
	if meter, ok := s.Store.(interface{ PrivateProofGas(uint64) }); ok {
		meter.PrivateProofGas(amount)
	}
}

func (s *transitionReads) PrivatePolicyMarker() []byte {
	if reader, ok := s.Store.(interface{ PrivatePolicyMarker() []byte }); ok {
		return reader.PrivatePolicyMarker()
	}
	return s.Get([]byte("private_activation"))
}

func (s *transitionReads) ConsensusV2Marker() []byte {
	if reader, ok := s.Store.(interface{ ConsensusV2Marker() []byte }); ok {
		return reader.ConsensusV2Marker()
	}
	return s.Store.Get([]byte("consensus_v2_activation"))
}

func (s *transitionReads) CentralEvidenceMarker() []byte {
	if reader, ok := s.Store.(interface{ CentralEvidenceMarker() []byte }); ok {
		return reader.CentralEvidenceMarker()
	}
	return s.Get([]byte("central_evidence_activation"))
}

func (s *transitionReads) CentralHardeningMarker() []byte {
	if reader, ok := s.Store.(interface{ CentralHardeningMarker() []byte }); ok {
		return reader.CentralHardeningMarker()
	}
	return s.Get([]byte("central_hardening_activation"))
}

func (s *transitionReads) KarmaPolicyMarker() []byte {
	if reader, ok := s.Store.(interface{ KarmaPolicyMarker() []byte }); ok {
		return reader.KarmaPolicyMarker()
	}
	return s.Get([]byte("karma_policy_activation"))
}

func (s *transitionReads) CentralTaskStatesMarker() []byte {
	if reader, ok := s.Store.(interface{ CentralTaskStatesMarker() []byte }); ok {
		return reader.CentralTaskStatesMarker()
	}
	return s.Get([]byte("central_task_states_activation"))
}

func (s *transitionReads) CentralEarningMarker() []byte {
	if reader, ok := s.Store.(interface{ CentralEarningMarker() []byte }); ok {
		return reader.CentralEarningMarker()
	}
	return s.Get([]byte("central_earning_activation"))
}

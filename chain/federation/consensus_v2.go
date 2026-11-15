package federation

import (
	"errors"
	"fmt"
)

// Consensus v2 (9 November 2026): the 0.4 rules — guardian quorum, signed
// validator rotation, upgrade plans, two-verifier Coin, release of
// unclaimable reservations and the per-project finance index — take effect
// only after this one-shot marker exists. Before it, every transaction
// executes exactly as under 0.3.9, with identical gas, so a node can replay
// the existing chain's history with this binary and the existing single
// guardian can activate the rules in place (no reset). Generation-2
// genesis writes the marker at initialization.

const ConsensusV2Policy = "consensus-v2-guardian-quorum-v1"
const financeBackfillLimit = 1024

// GenesisV2Evidence marks the activation a generation-2 genesis writes itself.
const GenesisV2Evidence = "0000000000000000000000000000000000000000000000000000000000000002"

type ConsensusV2Activation struct {
	Policy         string `json:"policy"`
	Height         int64  `json:"height,string"`
	ApprovedBy     string `json:"approved_by"`
	EvidenceDigest string `json:"evidence_digest"`
}

// consensusV2 reads only the unmetered prospective marker: historical
// transactions acquire no new gas.
func (k Keeper) consensusV2() bool {
	if reader, ok := k.Store.(interface{ ConsensusV2Marker() []byte }); ok {
		return reader.ConsensusV2Marker() != nil
	}
	return k.Store.Get([]byte("consensus_v2_activation")) != nil
}

var errUnsupportedOperation = errors.New("unsupported federation operation")

func (k Keeper) activateConsensusV2(c Command, height int64) (string, error) {
	if !k.guardian(c.Member) {
		return "", errors.New("guardian approval required")
	}
	var p struct {
		Policy         string `json:"policy"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	if c.Instance != "" || p.Policy != ConsensusV2Policy || !digestPattern.MatchString(p.EvidenceDigest) || k.consensusV2() {
		return "", errors.New("invalid or repeated consensus v2 activation")
	}
	if err := k.backfillFinanceIndex(); err != nil {
		return "", err
	}
	return ConsensusV2Policy, put(k.Store, "consensus_v2_activation", ConsensusV2Activation{p.Policy, height, c.Member, p.EvidenceDigest})
}

// Index existing v1 Coin quotes and funding reward schedules by project once,
// so central adoption reads one key from now on.
func (k Keeper) backfillFinanceIndex() error {
	quotes, err := k.Store.Range([]byte("coin_quote/"), []byte("coin_quote0"), financeBackfillLimit+1)
	if err != nil {
		return err
	}
	schedules, err := k.Store.Range([]byte("funding_reward_schedule/"), []byte("funding_reward_schedule0"), financeBackfillLimit+1)
	if err != nil {
		return err
	}
	if len(quotes) > financeBackfillLimit || len(schedules) > financeBackfillLimit {
		return errors.New("finance index backfill bound exceeded")
	}
	for _, row := range quotes {
		var q CoinQuote
		if err = Decode(row.Value, &q); err != nil {
			return err
		}
		t, err := k.taskState(q.Task)
		if err != nil {
			return fmt.Errorf("finance backfill: %w", err)
		}
		if err = put(k.Store, "project_finance/"+t.Project, true); err != nil {
			return err
		}
	}
	for _, row := range schedules {
		var s FundingRewardSchedule
		if err = Decode(row.Value, &s); err != nil {
			return err
		}
		var campaign FundingCampaign
		if err = get(k.Store, "funding_campaign/"+s.Campaign, &campaign); err != nil {
			return err
		}
		if err = put(k.Store, "project_finance/"+campaign.Project, true); err != nil {
			return err
		}
	}
	return nil
}

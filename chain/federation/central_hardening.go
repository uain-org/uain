package federation

import (
	"errors"
	"math"
	"strconv"
)

// CentralHardeningPolicy (security inspection, 13 November 2026) closes two griefing gaps in
// central earning:
//
//  1. Review deadline. Before this policy a plain submission, a linked revision and a
//     reassessment held the task under_review with no deadline, so one member could lock any
//     open task for as long as the reviewer did not act. With the policy on, each of them
//     carries review_deadline = height + review_blocks. Once that passes, the submission
//     expires exactly like an expired evidence request: rejected with no reviewer fee and no
//     mint, and the task reopens with its reservation intact. A needs_evidence verdict clears
//     the review deadline, so the S6 evidence window alone governs the author's revision time.
//  2. Evidence reuse. Before this policy nothing compared evidence across submissions, so one
//     operator could submit identical bytes under several identities. With the policy on, each
//     evidence digest may be submitted once, chain-wide (central_evidence_digest/<digest>).
//
// Nothing changes until a guardian records central_hardening_activation. Its marker is read
// through the unmetered policy store so replayed pre-activation commands keep their gas, and
// every new field is omitempty so records written before activation keep their exact bytes.
const CentralHardeningPolicy = "central-hardening-v1"

type CentralHardeningActivation struct {
	Policy         string `json:"policy"`
	ReviewBlocks   int64  `json:"review_blocks,string"`
	Height         int64  `json:"height,string"`
	ApprovedBy     string `json:"approved_by"`
	EvidenceDigest string `json:"evidence_digest"`
}

func (k Keeper) centralHardeningMarker() []byte {
	if reader, ok := k.Store.(interface{ CentralHardeningMarker() []byte }); ok {
		return reader.CentralHardeningMarker()
	}
	return k.Store.Get([]byte("central_hardening_activation"))
}

// centralHardening reports whether the policy applies at height, and its record.
func (k Keeper) centralHardening(height int64) (CentralHardeningActivation, bool, error) {
	var a CentralHardeningActivation
	raw := k.centralHardeningMarker()
	if raw == nil {
		return a, false, nil
	}
	if e := Decode(raw, &a); e != nil {
		return a, false, e
	}
	if a.Policy != CentralHardeningPolicy || a.Height < 2 || a.ReviewBlocks < 1 || a.ReviewBlocks > 1_000_000 {
		return a, false, errors.New("invalid central hardening activation")
	}
	return a, height >= a.Height, nil
}

func (k Keeper) centralHardeningActivate(c Command, height int64) (string, error) {
	bad := errors.New("invalid central hardening activation")
	var in struct {
		Policy         string `json:"policy"`
		ReviewBlocks   string `json:"review_blocks"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &in); e != nil {
		return "", e
	}
	blocks, err := strconv.ParseInt(in.ReviewBlocks, 10, 64)
	if err != nil || strconv.FormatInt(blocks, 10) != in.ReviewBlocks || blocks < 1 || blocks > 1_000_000 || !k.guardian(c.Member) || in.Policy != CentralHardeningPolicy || !digestPattern.MatchString(in.EvidenceDigest) || height < 1 || height == math.MaxInt64 || k.Store.Get([]byte("central_hardening_activation")) != nil {
		return "", bad
	}
	if _, e := k.centralActive(height); e != nil {
		return "", e
	}
	a := CentralHardeningActivation{Policy: in.Policy, ReviewBlocks: blocks, Height: height + 1, ApprovedBy: c.Member, EvidenceDigest: in.EvidenceDigest}
	return in.Policy, put(k.Store, "central_hardening_activation", a)
}

// centralReviewDeadline is the deadline a new under_review submission gets at height, or 0 when
// the policy is off.
func centralReviewDeadline(h CentralHardeningActivation, on bool, height int64) int64 {
	if !on || height > math.MaxInt64-h.ReviewBlocks {
		return 0
	}
	return height + h.ReviewBlocks
}

// centralReviewExpirable: a pending submission whose review deadline passed with no verdict. An
// open evidence request has no review deadline (needs_evidence clears it).
func centralReviewExpirable(v CentralSubmission, height int64) bool {
	return v.State == "under_review" && v.ReviewDeadline > 0 && height > v.ReviewDeadline
}

// centralClaimEvidence records which member first submitted an evidence digest. The same
// member may submit it again (say after a review deadline lapsed); any other member is refused.
func (k Keeper) centralClaimEvidence(on bool, digest, member string) error {
	if !on {
		return nil
	}
	key := "central_evidence_digest/" + digest
	if raw := k.Store.Get([]byte(key)); raw != nil {
		var first string
		if e := Decode(raw, &first); e != nil {
			return e
		}
		if first != member {
			return errors.New("central evidence already submitted by another member")
		}
		return nil
	}
	return put(k.Store, key, member)
}

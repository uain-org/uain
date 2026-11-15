package federation

import (
	"errors"
	"math"
	"strconv"
)

// CentralEvidencePolicy implements the S6 default (9 November 2026): a submission may receive
// exactly one needs_evidence request. Within the window the author may submit one linked
// revision (the original stays immutable, marked superseded) or ask for one reassessment of the
// unchanged evidence. After the window the submission expires: it is rejected with no reviewer
// fee and no mint, and the task reopens with its reservation intact.
//
// Nothing changes until a guardian records central_evidence_activation. Its marker is read
// through the unmetered policy store so replayed pre-activation commands keep their gas.
const CentralEvidencePolicy = "central-evidence-window-v1"

type CentralEvidenceActivation struct {
	Policy         string `json:"policy"`
	WindowBlocks   int64  `json:"window_blocks,string"`
	Height         int64  `json:"height,string"`
	ApprovedBy     string `json:"approved_by"`
	EvidenceDigest string `json:"evidence_digest"`
}

func (k Keeper) centralEvidenceMarker() []byte {
	if reader, ok := k.Store.(interface{ CentralEvidenceMarker() []byte }); ok {
		return reader.CentralEvidenceMarker()
	}
	return k.Store.Get([]byte("central_evidence_activation"))
}

// centralEvidencePolicy reports whether the S6 window applies at height, and its length.
func (k Keeper) centralEvidencePolicy(height int64) (CentralEvidenceActivation, bool, error) {
	var a CentralEvidenceActivation
	raw := k.centralEvidenceMarker()
	if raw == nil {
		return a, false, nil
	}
	if e := Decode(raw, &a); e != nil {
		return a, false, e
	}
	if a.Policy != CentralEvidencePolicy || a.Height < 2 || a.WindowBlocks < 1 || a.WindowBlocks > 1_000_000 {
		return a, false, errors.New("invalid central evidence activation")
	}
	return a, height >= a.Height, nil
}

func (k Keeper) centralEvidenceActivate(c Command, height int64) (string, error) {
	bad := errors.New("invalid central evidence activation")
	var in struct {
		Policy         string `json:"policy"`
		WindowBlocks   string `json:"window_blocks"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &in); e != nil {
		return "", e
	}
	window, err := strconv.ParseInt(in.WindowBlocks, 10, 64)
	if err != nil || strconv.FormatInt(window, 10) != in.WindowBlocks || window < 1 || window > 1_000_000 || !k.guardian(c.Member) || in.Policy != CentralEvidencePolicy || !digestPattern.MatchString(in.EvidenceDigest) || height < 1 || height == math.MaxInt64 || k.Store.Get([]byte("central_evidence_activation")) != nil {
		return "", bad
	}
	if _, e := k.centralActive(height); e != nil {
		return "", e
	}
	a := CentralEvidenceActivation{Policy: in.Policy, WindowBlocks: window, Height: height + 1, ApprovedBy: c.Member, EvidenceDigest: in.EvidenceDigest}
	return in.Policy, put(k.Store, "central_evidence_activation", a)
}

// centralEvidenceExpirable: an open evidence request whose window passed with no revision or reassessment.
func centralEvidenceExpirable(v CentralSubmission, height int64) bool {
	return v.State == "under_review" && v.EvidenceDeadline > 0 && height > v.EvidenceDeadline && v.RevisedBy == "" && !v.Reassess && v.Revises == ""
}

// centralEvidenceExpire rejects the pending submission with no reviewer fee and reopens the task.
// The task reservation (solver plus reviewer amount) is unchanged, so no ledger record moves.
func (k Keeper) centralEvidenceExpire(t *CentralTask, height int64) (bool, error) {
	if t.State != "under_review" || t.Pending == "" {
		return false, nil
	}
	var v CentralSubmission
	if e := get(k.Store, "central_submission/"+t.Pending, &v); e != nil {
		return false, e
	}
	if v.Task != t.ID || !(centralEvidenceExpirable(v, height) || centralReviewExpirable(v, height)) || t.Winner != "" || t.Reserved != centralSum(t.SolverAmount, t.ReviewerAmount) {
		return false, nil
	}
	v.State = "expired"
	v.ExpiredHeight = height
	t.State = "open"
	t.Pending = ""
	if e := put(k.Store, "central_submission/"+v.ID, v); e != nil {
		return false, e
	}
	return true, put(k.Store, "central_task/"+t.ID, *t)
}

// centralEvidenceTransition handles the member-side S6 operations.
func (k Keeper) centralEvidenceTransition(c Command, height int64, a CentralActivation) (string, error) {
	bad := errors.New("invalid central evidence transition")
	_, on, e := k.centralEvidencePolicy(height)
	if e != nil {
		return "", e
	}
	hard, hardOn, e := k.centralHardening(height)
	if e != nil {
		return "", e
	}
	// central_evidence_expire also serves the review deadline (central_hardening.go).
	if !on && !(hardOn && c.Operation == "central_evidence_expire") {
		return "", bad
	}
	var in struct {
		Submission string `json:"submission"`
	}
	if e := Decode(c.Payload, &in); e != nil {
		return "", e
	}
	var v CentralSubmission
	if e := get(k.Store, "central_submission/"+in.Submission, &v); e != nil {
		return "", e
	}
	var t CentralTask
	if e := get(k.Store, "central_task/"+v.Task, &t); e != nil {
		return "", e
	}
	if _, _, err := k.centralProject(t.Project); err != nil {
		return "", err
	}
	if t.Pending != v.ID || t.State != "under_review" {
		return "", bad
	}
	switch c.Operation {
	case "central_reassess":
		if c.Member != v.Author || v.State != "under_review" || v.EvidenceDeadline < 1 || height > v.EvidenceDeadline || v.Reassess || v.Revises != "" || v.RevisedBy != "" {
			return "", bad
		}
		v.Reassess = true
		v.ReassessHeight = height
		v.ReviewDeadline = centralReviewDeadline(hard, hardOn, height)
		return v.ID, put(k.Store, "central_submission/"+v.ID, v)
	case "central_evidence_expire":
		expired, e := k.centralEvidenceExpire(&t, height)
		if e != nil {
			return "", e
		}
		if !expired {
			return "", bad
		}
		return v.ID, nil
	}
	return "", bad
}

// centralRevise validates and records a linked revision. The original keeps its evidence and
// digest unchanged; only its state (superseded) and link (revised_by) change.
func (k Keeper) centralRevise(c Command, height int64, t *CentralTask, revises string) (CentralSubmission, error) {
	bad := errors.New("invalid central revision")
	var o CentralSubmission
	if e := get(k.Store, "central_submission/"+revises, &o); e != nil {
		return o, e
	}
	if o.Task != t.ID || t.State != "under_review" || t.Pending != o.ID || t.Winner != "" || o.State != "under_review" || o.EvidenceDeadline < 1 || height > o.EvidenceDeadline || o.RevisedBy != "" || o.Reassess || o.Revises != "" || c.Member != o.Author || c.Instance != o.AuthorInstance {
		return o, bad
	}
	return o, nil
}

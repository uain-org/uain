package federation

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"math/big"
	"strconv"
	"strings"
	"time"

	"github.com/uain-org/uain/chain/coin"
)

// CentralTaskStatesPolicy adds the two task states decided at the 6 November 2026
// team meeting and ruled on by Rahul on 9 November 2026 (K-14, K-28 in
// docs/decisions/conflicts.md; specification docs/engineering/task-statuses.md):
//
//   - Conditional Approved (payout "conditional"): the verifier's accept binds the
//     task to its winner and pays the reviewer, but the solver amount stays reserved,
//     not minted, until the central reviewer attests the condition fixed when the task
//     opened. "met" mints it to the winner; "unmet" (only after resolves_by) or expiry
//     (anyone, after expires_at) releases it to the project allowance.
//   - Beauty Contest (mode "contest"): several members enter, one entry each, until
//     closes_at. The central reviewer scores each entry 1 (shortlisted) or 0 (rejected)
//     and, after closes_at, selects the best shortlisted entry. If it has not selected
//     by select_by, anyone may settle the contest: the earliest shortlisted entry wins,
//     or with none the bounty is released. Losing entries earn nothing, cost nothing and
//     stay public.
//
// All time limits compare block time (consensus-deterministic). Every time-driven step
// is an ordinary signed command any member may send (as central_evidence_expire), so
// BeginBlock is unchanged.
//
// Nothing changes until a guardian records central_task_states_activation. Its marker is
// read through the unmetered policy store, so every replayed pre-activation command keeps
// its exact bytes, gas and app hash: before activation the new operations fail exactly
// as unknown operations did, central_task_open refuses the new fields exactly as before
// (strict decoding), and no existing record gains a field (all new fields are omitempty).
const CentralTaskStatesPolicy = "central-task-states-v1"

// CentralTaskStatesHashVersion versions the records this policy introduces. Existing
// records keep their version-1 bytes; a task opened with a mode or payout, and every
// contest selection or condition resolution record, carries hash_version 2, and the
// condition digest is domain-separated under this version.
const CentralTaskStatesHashVersion = 2

const centralTaskStatesKey = "central_task_states_activation"
const centralConditionDomain = "uain:central-condition:v2\n"

// CentralTaskStatesParams are guardian-set. Each task copies the values that affect it
// when it opens, so a later change never alters a task already open.
type CentralTaskStatesParams struct {
	ContestDefaultSeconds  int64  `json:"contest_default_seconds,string"`
	ContestMinSeconds      int64  `json:"contest_min_seconds,string"`
	ContestMaxSeconds      int64  `json:"contest_max_seconds,string"`
	SelectionWindowSeconds int64  `json:"selection_window_seconds,string"`
	MaxEntriesDefault      uint64 `json:"max_entries_default,string"`
	MaxEntriesLimit        uint64 `json:"max_entries_limit,string"`
	ConditionMaxSeconds    int64  `json:"condition_max_seconds,string"`
	ConditionGraceSeconds  int64  `json:"condition_grace_seconds,string"`
}

// DefaultCentralTaskStatesParams are the defaults taken on 10 November 2026
// (docs/engineering/task-statuses.md section 10); Rahul may overrule them.
func DefaultCentralTaskStatesParams() CentralTaskStatesParams {
	return CentralTaskStatesParams{
		ContestDefaultSeconds:  7 * 24 * 3600,
		ContestMinSeconds:      24 * 3600,
		ContestMaxSeconds:      30 * 24 * 3600,
		SelectionWindowSeconds: 72 * 3600,
		MaxEntriesDefault:      20,
		MaxEntriesLimit:        100,
		ConditionMaxSeconds:    2 * 365 * 24 * 3600,
		ConditionGraceSeconds:  30 * 24 * 3600,
	}
}

const centralTaskStatesSecondsLimit = 10 * 365 * 24 * 3600

func (p CentralTaskStatesParams) valid() bool {
	positive := func(v int64) bool { return v > 0 && v <= centralTaskStatesSecondsLimit }
	return positive(p.ContestMinSeconds) && positive(p.ContestDefaultSeconds) && positive(p.ContestMaxSeconds) &&
		p.ContestMinSeconds <= p.ContestDefaultSeconds && p.ContestDefaultSeconds <= p.ContestMaxSeconds &&
		positive(p.SelectionWindowSeconds) && positive(p.ConditionMaxSeconds) && positive(p.ConditionGraceSeconds) &&
		p.ConditionGraceSeconds < p.ConditionMaxSeconds &&
		p.MaxEntriesDefault >= 1 && p.MaxEntriesDefault <= p.MaxEntriesLimit && p.MaxEntriesLimit <= 1000
}

type CentralTaskStatesActivation struct {
	Policy         string                  `json:"policy"`
	Height         int64                   `json:"height,string"`
	ApprovedBy     string                  `json:"approved_by"`
	EvidenceDigest string                  `json:"evidence_digest"`
	Params         CentralTaskStatesParams `json:"params"`
	UpdatedHeight  int64                   `json:"updated_height,string,omitempty"`
	UpdatedBy      string                  `json:"updated_by,omitempty"`
	UpdateDigest   string                  `json:"update_digest,omitempty"`
}

// CentralContestSelection records how a contest ended: selected by the reviewer,
// settled by the fallback (earliest shortlisted entry), or with no winner.
type CentralContestSelection struct {
	HashVersion    int    `json:"hash_version"`
	Task           string `json:"task"`
	Outcome        string `json:"outcome"`
	Submission     string `json:"submission,omitempty"`
	Member         string `json:"member,omitempty"`
	DecidedBy      string `json:"decided_by"`
	Entries        uint64 `json:"entries,string"`
	Shortlisted    uint64 `json:"shortlisted,string"`
	ReviewerPaid   bool   `json:"reviewer_paid"`
	EvidenceDigest string `json:"evidence_digest,omitempty"`
	Height         int64  `json:"height,string"`
	At             int64  `json:"at,string"`
}

// CentralConditionResolution records how a Conditional Approved reservation ended.
type CentralConditionResolution struct {
	HashVersion     int    `json:"hash_version"`
	Task            string `json:"task"`
	Submission      string `json:"submission"`
	Member          string `json:"member"`
	Outcome         string `json:"outcome"`
	Amount          string `json:"amount"`
	ConditionDigest string `json:"condition_digest"`
	AttestedBy      string `json:"attested_by"`
	SourceDigest    string `json:"source_digest,omitempty"`
	EvidenceDigest  string `json:"evidence_digest,omitempty"`
	Height          int64  `json:"height,string"`
	At              int64  `json:"at,string"`
}

func (k Keeper) centralTaskStatesMarker() []byte {
	if reader, ok := k.Store.(interface{ CentralTaskStatesMarker() []byte }); ok {
		return reader.CentralTaskStatesMarker()
	}
	return k.Store.Get([]byte(centralTaskStatesKey))
}

// CentralTaskStatesRecorded reports whether a guardian has recorded the activation.
func (k Keeper) CentralTaskStatesRecorded() bool {
	return k.centralTaskStatesMarker() != nil
}

// centralTaskStates reports whether the policy applies at height. Before activation it
// performs one unmetered read and nothing else.
func (k Keeper) centralTaskStates(height int64) (CentralTaskStatesActivation, bool, error) {
	var a CentralTaskStatesActivation
	raw := k.centralTaskStatesMarker()
	if raw == nil {
		return a, false, nil
	}
	if e := Decode(raw, &a); e != nil {
		return a, false, e
	}
	if a.Policy != CentralTaskStatesPolicy || a.Height < 2 || !digestPattern.MatchString(a.EvidenceDigest) || !a.Params.valid() {
		return a, false, errors.New("invalid central task states activation")
	}
	return a, height >= a.Height, nil
}

func centralTaskStatesOperation(op string) bool {
	switch op {
	case "central_task_states_configure", "central_contest_select", "central_contest_settle", "central_condition_resolve", "central_condition_expire":
		return true
	}
	return false
}

func (k Keeper) centralTaskStatesActivate(c Command, height int64) (string, error) {
	bad := errors.New("invalid central task states activation")
	var in struct {
		Policy         string `json:"policy"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &in); e != nil {
		return "", e
	}
	if !k.guardian(c.Member) || in.Policy != CentralTaskStatesPolicy || !digestPattern.MatchString(in.EvidenceDigest) || height < 1 || height == math.MaxInt64 || k.Store.Get([]byte(centralTaskStatesKey)) != nil {
		return "", bad
	}
	if _, e := k.centralActive(height); e != nil {
		return "", e
	}
	a := CentralTaskStatesActivation{Policy: in.Policy, Height: height + 1, ApprovedBy: c.Member, EvidenceDigest: in.EvidenceDigest, Params: DefaultCentralTaskStatesParams()}
	return in.Policy, put(k.Store, centralTaskStatesKey, a)
}

func (k Keeper) centralTaskStatesConfigure(c Command, height int64) (string, error) {
	bad := errors.New("invalid central task states configuration")
	a, on, err := k.centralTaskStates(height)
	if err != nil {
		return "", err
	}
	var in struct {
		Params         CentralTaskStatesParams `json:"params"`
		EvidenceDigest string                  `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &in); e != nil {
		return "", e
	}
	if !on || !k.guardian(c.Member) || !in.Params.valid() || !digestPattern.MatchString(in.EvidenceDigest) {
		return "", bad
	}
	a.Params = in.Params
	a.UpdatedHeight = height
	a.UpdatedBy = c.Member
	a.UpdateDigest = in.EvidenceDigest
	return CentralTaskStatesPolicy, put(k.Store, centralTaskStatesKey, a)
}

// CentralTaskOpenExtension carries the optional fields central_task_open accepts after
// activation. Omitted fields give today's single-winner, immediate-payout task.
type CentralTaskOpenExtension struct {
	Mode       string `json:"mode,omitempty"`
	Payout     string `json:"payout,omitempty"`
	ClosesAt   string `json:"closes_at,omitempty"`
	MaxEntries string `json:"max_entries,omitempty"`
	Condition  string `json:"condition,omitempty"`
	ResolvesBy string `json:"resolves_by,omitempty"`
}

func optionalInt(raw string) (int64, bool) {
	if raw == "" {
		return 0, true
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	return n, err == nil && strconv.FormatInt(n, 10) == raw && n > 0
}

// CentralConditionDigest binds a condition statement and its date under hash version 2.
func CentralConditionDigest(statement string, resolvesBy int64) string {
	h := sha256.Sum256([]byte(centralConditionDomain + strconv.FormatInt(resolvesBy, 10) + "\n" + statement))
	return hex.EncodeToString(h[:])
}

// applyOpenExtension validates the new fields and fixes on t everything a payout depends on.
func (k Keeper) applyOpenExtension(t *CentralTask, x CentralTaskOpenExtension, params CentralTaskStatesParams, now time.Time) error {
	bad := errors.New("invalid central task mode or payout")
	if x == (CentralTaskOpenExtension{}) {
		return nil
	}
	unix := now.Unix()
	switch x.Mode {
	case "", "single":
		if x.ClosesAt != "" || x.MaxEntries != "" {
			return bad
		}
	case "contest":
		closes, ok := optionalInt(x.ClosesAt)
		if !ok {
			return bad
		}
		if closes == 0 {
			closes = unix + params.ContestDefaultSeconds
		}
		if closes-unix < params.ContestMinSeconds || closes-unix > params.ContestMaxSeconds {
			return bad
		}
		entries := params.MaxEntriesDefault
		if x.MaxEntries != "" {
			n, err := strconv.ParseUint(x.MaxEntries, 10, 64)
			if err != nil || strconv.FormatUint(n, 10) != x.MaxEntries || n < 1 || n > params.MaxEntriesLimit {
				return bad
			}
			entries = n
		}
		t.Mode = "contest"
		t.State = "contest_open"
		t.ClosesAt = closes
		t.SelectBy = closes + params.SelectionWindowSeconds
		t.MaxEntries = entries
	default:
		return bad
	}
	switch x.Payout {
	case "", "immediate":
		if x.Condition != "" || x.ResolvesBy != "" {
			return bad
		}
	case "conditional":
		resolves, ok := optionalInt(x.ResolvesBy)
		statement := strings.TrimSpace(x.Condition)
		if !ok || resolves == 0 || len(statement) < 10 || len(x.Condition) > 2048 || !centralText(x.Condition, centralDigestHex(x.Condition), 2048) {
			return bad
		}
		start := unix
		if t.Mode == "contest" {
			start = t.SelectBy
		}
		if resolves <= start || resolves > math.MaxInt64-params.ConditionGraceSeconds || resolves+params.ConditionGraceSeconds-unix > params.ConditionMaxSeconds {
			return bad
		}
		t.Payout = "conditional"
		t.Condition = x.Condition
		t.ConditionDigest = CentralConditionDigest(x.Condition, resolves)
		t.ResolvesBy = resolves
		t.ExpiresAt = resolves + params.ConditionGraceSeconds
	default:
		return bad
	}
	if t.Mode != "" || t.Payout != "" {
		t.HashVersion = CentralTaskStatesHashVersion
	}
	return nil
}

func centralDigestHex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

// centralContestEnter records one entry from one member while the contest is open. No
// lock is taken: entries queue for the reviewer, who scores each 1 or 0.
func (k Keeper) centralContestEnter(c Command, a CentralActivation, t CentralTask, id, evidence, evidenceDigest, revises string, height int64, now time.Time) (string, error) {
	bad := errors.New("invalid contest entry")
	entryKey := "central_contest_entry/" + t.ID + "/" + c.Member
	if revises != "" || !validID(id) || !centralText(evidence, evidenceDigest, 16384) || t.State != "contest_open" || t.Winner != "" || now.Unix() >= t.ClosesAt || t.Entries >= t.MaxEntries || t.Reserved != centralSum(t.SolverAmount, t.ReviewerAmount) || c.Member == a.Reviewer || k.Store.Get([]byte("central_submission/"+id)) != nil || k.Store.Get([]byte(entryKey)) != nil {
		return "", bad
	}
	t.Entries++
	v := CentralSubmission{Evidence: evidence, ID: id, Task: t.ID, Author: c.Member, AuthorInstance: c.Instance, EvidenceDigest: evidenceDigest, State: "under_review", Height: height, Entry: t.Entries}
	for _, entry := range []struct {
		key   string
		value any
	}{{entryKey, id}, {fmt.Sprintf("central_contest_entries/%s/%020d", t.ID, t.Entries), id}, {"central_task/" + t.ID, t}, {"central_submission/" + id, v}} {
		if e := put(k.Store, entry.key, entry.value); e != nil {
			return "", e
		}
	}
	return id, nil
}

// centralContestReview scores one entry: accept shortlists it, reject rejects it. No
// AI$ moves; the reviewer is paid once per contest when it ends.
func (k Keeper) centralContestReview(c Command, a CentralActivation, t CentralTask, v CentralSubmission, in centralReviewPayload, height int64, now time.Time) (string, error) {
	bad := errors.New("invalid contest review")
	if c.Member != a.Reviewer || c.Member == v.Author || v.Task != t.ID || t.State != "contest_open" || t.Winner != "" || v.State != "under_review" || now.Unix() >= t.SelectBy || in.CriteriaDigest != t.AcceptanceDigest || !digestPattern.MatchString(in.VerificationDigest) || in.EvidenceDigest != v.EvidenceDigest || !validID(in.ExecutionID) || (in.Verdict != "accept" && in.Verdict != "reject") || t.Decided >= t.Entries {
		return "", bad
	}
	h := sha256.Sum256([]byte(in.ExecutionID))
	reviewKey := "central_review/" + v.ID + "/" + hex.EncodeToString(h[:])
	if k.Store.Get([]byte(reviewKey)) != nil {
		return "", bad
	}
	r := CentralReview{v.ID, in.Verdict, in.CriteriaDigest, in.VerificationDigest, in.ExecutionID, in.EvidenceDigest, c.Member, height}
	t.Decided++
	t.JudgedBy = c.Member
	t.LastJudged = v.ID
	v.State = "rejected"
	if in.Verdict == "accept" {
		v.State = "shortlisted"
		t.Shortlisted++
		if t.Leading == "" {
			t.Leading = v.ID
		} else {
			var lead CentralSubmission
			if e := get(k.Store, "central_submission/"+t.Leading, &lead); e != nil {
				return "", e
			}
			if v.Entry < lead.Entry {
				t.Leading = v.ID
			}
		}
	}
	for _, entry := range []struct {
		key   string
		value any
	}{{"central_task/" + t.ID, t}, {"central_submission/" + v.ID, v}, {reviewKey, r}} {
		if e := put(k.Store, entry.key, entry.value); e != nil {
			return "", e
		}
	}
	return v.ID, nil
}

type centralReviewPayload struct {
	Submission         string `json:"submission"`
	Verdict            string `json:"verdict"`
	CriteriaDigest     string `json:"criteria_digest"`
	VerificationDigest string `json:"verification_digest"`
	ExecutionID        string `json:"execution_id"`
	EvidenceDigest     string `json:"evidence_digest"`
}

// centralTaskStatesTransition handles the new operations after activation.
func (k Keeper) centralTaskStatesTransition(c Command, height int64, now time.Time, a CentralActivation) (string, error) {
	if c.Operation == "central_task_states_configure" {
		return k.centralTaskStatesConfigure(c, height)
	}
	bad := errors.New("invalid central task state transition")
	var in struct {
		Task           string `json:"task"`
		Submission     string `json:"submission,omitempty"`
		Outcome        string `json:"outcome,omitempty"`
		SourceDigest   string `json:"source_digest,omitempty"`
		EvidenceDigest string `json:"evidence_digest,omitempty"`
	}
	if e := Decode(c.Payload, &in); e != nil {
		return "", e
	}
	var t CentralTask
	if e := get(k.Store, "central_task/"+in.Task, &t); e != nil {
		return "", e
	}
	_, b, err := k.centralProject(t.Project)
	if err != nil {
		return "", err
	}
	unix := now.Unix()
	switch c.Operation {
	case "central_contest_select":
		if c.Member != a.Reviewer || t.Mode != "contest" || t.State != "contest_open" || t.Winner != "" || unix < t.ClosesAt || unix >= t.SelectBy || t.Decided != t.Entries || t.Shortlisted == 0 || in.Outcome != "" || in.SourceDigest != "" || !digestPattern.MatchString(in.EvidenceDigest) {
			return "", bad
		}
		var v CentralSubmission
		if e := get(k.Store, "central_submission/"+in.Submission, &v); e != nil {
			return "", e
		}
		if v.Task != t.ID || v.State != "shortlisted" || v.Author == c.Member {
			return "", bad
		}
		return k.centralContestFinish(&t, &b, &v, "selected", c.Member, in.EvidenceDigest, height, now)
	case "central_contest_settle":
		if t.Mode != "contest" || t.State != "contest_open" || t.Winner != "" || in.Submission != "" || in.Outcome != "" || in.SourceDigest != "" || in.EvidenceDigest != "" || unix < t.ClosesAt {
			return "", bad
		}
		if unix < t.SelectBy {
			// Before select_by only a contest nobody can win may be settled early.
			if t.Entries != 0 && (t.Decided != t.Entries || t.Shortlisted != 0) {
				return "", bad
			}
			return k.centralContestFinish(&t, &b, nil, "no_winner", c.Member, "", height, now)
		}
		if t.Shortlisted == 0 {
			return k.centralContestFinish(&t, &b, nil, "no_winner", c.Member, "", height, now)
		}
		var v CentralSubmission
		if e := get(k.Store, "central_submission/"+t.Leading, &v); e != nil {
			return "", e
		}
		if v.Task != t.ID || v.State != "shortlisted" {
			return "", bad
		}
		return k.centralContestFinish(&t, &b, &v, "fallback", c.Member, "", height, now)
	case "central_condition_resolve":
		if c.Member != a.Reviewer || t.Payout != "conditional" || t.State != "conditional_approved" || t.Winner == "" || in.Submission != "" || unix >= t.ExpiresAt || (in.Outcome != "met" && in.Outcome != "unmet") || (in.Outcome == "unmet" && unix < t.ResolvesBy) || !digestPattern.MatchString(in.SourceDigest) || !digestPattern.MatchString(in.EvidenceDigest) {
			return "", bad
		}
		return k.centralConditionFinish(&t, &b, in.Outcome, c.Member, in.SourceDigest, in.EvidenceDigest, height, now)
	case "central_condition_expire":
		if t.Payout != "conditional" || t.State != "conditional_approved" || t.Winner == "" || in.Submission != "" || in.Outcome != "" || in.SourceDigest != "" || in.EvidenceDigest != "" || unix < t.ExpiresAt {
			return "", bad
		}
		return k.centralConditionFinish(&t, &b, "expired", c.Member, "", "", height, now)
	}
	return "", bad
}

// centralSettle mints paid awards and releases the rest of a task's reservation, keeping
// keep reserved (Conditional Approved). It validates every recipient before any write,
// as central_review does, and records Karma under KarmaPolicyV2.
func (k Keeper) centralSettle(t *CentralTask, b *CentralBudget, awards []CentralAward, release, keep string, now time.Time) error {
	bad := errors.New("invalid central settlement")
	paid := "0"
	for _, award := range awards {
		paid = centralSum(paid, award.Amount)
	}
	if centralSum(centralSum(paid, release), keep) != t.Reserved {
		return bad
	}
	reserved, _ := new(big.Int).SetString(b.Reserved, 10)
	freed, _ := new(big.Int).SetString(centralSum(paid, release), 10)
	if reserved == nil || freed == nil || reserved.Cmp(freed) < 0 {
		return bad
	}
	ledger, err := k.coinLedger()
	if err != nil {
		return err
	}
	next := ledger
	if paid != "0" {
		if next, err = next.Mint(paid); err != nil {
			return err
		}
	}
	if release != "0" {
		if next, err = next.Release(release); err != nil {
			return err
		}
	}
	balances := map[string]string{}
	for _, award := range awards {
		if k.Store.Get([]byte("central_award/"+award.Role+"/"+award.Submission)) != nil {
			return bad
		}
		balance, ok := balances[award.Member]
		if !ok {
			balance = "0"
			if k.Store.Get([]byte("coin_balance/"+award.Member)) != nil {
				if e := get(k.Store, "coin_balance/"+award.Member, &balance); e != nil {
					return e
				}
			}
			if e := (coin.Ledger{Minted: balance, Reserved: "0", Transparent: balance, Shielded: "0"}).Validate(); e != nil {
				return e
			}
		}
		balances[award.Member] = centralSum(balance, award.Amount)
	}
	b.Reserved = centralSub(b.Reserved, centralSum(paid, release))
	b.Paid = centralSum(b.Paid, paid)
	t.Reserved = keep
	t.Paid = centralSum(t.Paid, paid)
	if e := put(k.Store, "coin_supply", next); e != nil {
		return e
	}
	for _, award := range awards {
		if e := put(k.Store, "coin_balance/"+award.Member, balances[award.Member]); e != nil {
			return e
		}
	}
	for _, award := range awards {
		if e := k.centralIndexAward(award); e != nil {
			return e
		}
		if e := put(k.Store, "central_award/"+award.Role+"/"+award.Submission, award); e != nil {
			return e
		}
	}
	if _, on, err := k.karmaPolicy(); err != nil {
		return err
	} else if on {
		for _, award := range awards {
			if _, e := k.recordCentralAwardKarma(award, "central_award", now); e != nil {
				return e
			}
		}
	}
	return put(k.Store, "central_project_budget/"+b.Project, *b)
}

// centralConditionalAccept is an accept on a Conditional Approved task: the reviewer is
// paid now, the solver amount stays reserved for the winner.
func (k Keeper) centralConditionalAccept(c Command, t *CentralTask, b *CentralBudget, v *CentralSubmission, r CentralReview, reviewKey string, height int64, now time.Time) (string, error) {
	author, err := k.Member(v.Author)
	if err != nil || !coinBoundaryMember.MatchString(v.Author) || author.ID != v.Author || author.Licence != "active" || t.Reserved != centralSum(t.SolverAmount, t.ReviewerAmount) {
		return "", errors.New("invalid central transition")
	}
	awards := []CentralAward{{v.ID, t.ID, t.Project, c.Member, "reviewer", t.ReviewerAmount, height}}
	if e := k.centralSettle(t, b, awards, "0", t.SolverAmount, now); e != nil {
		return "", e
	}
	t.Pending = ""
	t.Winner = v.ID
	t.State = "conditional_approved"
	v.State = "conditional"
	for _, entry := range []struct {
		key   string
		value any
	}{{"central_task/" + t.ID, *t}, {"central_submission/" + v.ID, *v}, {reviewKey, r}} {
		if e := put(k.Store, entry.key, entry.value); e != nil {
			return "", e
		}
	}
	return v.ID, nil
}

// centralContestFinish ends a contest: with a winner (selected or fallback) the payout
// follows the task's payout type; with none the solver amount is released. The reviewer
// is paid once if it scored at least one entry, otherwise its amount is released too.
func (k Keeper) centralContestFinish(t *CentralTask, b *CentralBudget, winner *CentralSubmission, outcome, decidedBy, evidenceDigest string, height int64, now time.Time) (string, error) {
	if t.Reserved != centralSum(t.SolverAmount, t.ReviewerAmount) {
		return "", errors.New("invalid contest reservation")
	}
	awards := []CentralAward{}
	release, keep := "0", "0"
	reviewerPaid := false
	if t.Decided > 0 && t.JudgedBy != "" && t.LastJudged != "" {
		// The reviewer who gave the last verdict is paid once for judging the contest,
		// provided its licence is still active; otherwise its amount is released.
		reviewer, err := k.Member(t.JudgedBy)
		reviewerPaid = err == nil && reviewer.ID == t.JudgedBy && reviewer.Licence == "active"
	}
	if reviewerPaid {
		key := t.LastJudged
		if winner != nil {
			key = winner.ID
		}
		awards = append(awards, CentralAward{key, t.ID, t.Project, t.JudgedBy, "reviewer", t.ReviewerAmount, height})
	} else {
		release = t.ReviewerAmount
	}
	selection := CentralContestSelection{HashVersion: CentralTaskStatesHashVersion, Task: t.ID, Outcome: outcome, DecidedBy: decidedBy, Entries: t.Entries, Shortlisted: t.Shortlisted, ReviewerPaid: reviewerPaid, EvidenceDigest: evidenceDigest, Height: height, At: now.Unix()}
	switch {
	case winner == nil:
		release = centralSum(release, t.SolverAmount)
		t.State = "no_winner"
	case t.Payout == "conditional":
		keep = t.SolverAmount
		t.State = "conditional_approved"
		winner.State = "conditional"
	default:
		awards = append(awards, CentralAward{winner.ID, t.ID, t.Project, winner.Author, "solver", t.SolverAmount, height})
		t.State = "accepted"
		winner.State = "accepted"
	}
	if winner != nil {
		author, err := k.Member(winner.Author)
		if err != nil || !coinBoundaryMember.MatchString(winner.Author) || author.ID != winner.Author || author.Licence != "active" {
			return "", errors.New("contest winner licence is not active")
		}
		t.Winner = winner.ID
		selection.Submission = winner.ID
		selection.Member = winner.Author
	}
	if e := k.centralSettle(t, b, awards, release, keep, now); e != nil {
		return "", e
	}
	if winner != nil {
		if e := put(k.Store, "central_submission/"+winner.ID, *winner); e != nil {
			return "", e
		}
	}
	if e := put(k.Store, "central_contest_selection/"+t.ID, selection); e != nil {
		return "", e
	}
	return t.ID, put(k.Store, "central_task/"+t.ID, *t)
}

// centralConditionFinish pays (met) or releases (unmet, expired) a conditional reservation.
func (k Keeper) centralConditionFinish(t *CentralTask, b *CentralBudget, outcome, attestedBy, sourceDigest, evidenceDigest string, height int64, now time.Time) (string, error) {
	bad := errors.New("invalid condition resolution")
	var v CentralSubmission
	if e := get(k.Store, "central_submission/"+t.Winner, &v); e != nil {
		return "", e
	}
	if v.Task != t.ID || v.State != "conditional" || t.Reserved != t.SolverAmount || attestedBy == "" || k.Store.Get([]byte("central_condition_resolution/"+t.ID)) != nil {
		return "", bad
	}
	if outcome != "expired" && attestedBy == v.Author {
		return "", bad
	}
	resolution := CentralConditionResolution{HashVersion: CentralTaskStatesHashVersion, Task: t.ID, Submission: v.ID, Member: v.Author, Outcome: outcome, Amount: t.SolverAmount, ConditionDigest: t.ConditionDigest, AttestedBy: attestedBy, SourceDigest: sourceDigest, EvidenceDigest: evidenceDigest, Height: height, At: now.Unix()}
	if outcome == "met" {
		author, err := k.Member(v.Author)
		if err != nil || !coinBoundaryMember.MatchString(v.Author) || author.ID != v.Author || author.Licence != "active" {
			return "", bad
		}
		award := CentralAward{v.ID, t.ID, t.Project, v.Author, "solver", t.SolverAmount, height}
		if e := k.centralSettle(t, b, []CentralAward{award}, "0", "0", now); e != nil {
			return "", e
		}
		t.State = "accepted"
		v.State = "accepted"
	} else {
		if e := k.centralSettle(t, b, nil, t.SolverAmount, "0", now); e != nil {
			return "", e
		}
		t.State = "conditional_expired"
		v.State = "condition_" + outcome
	}
	for _, entry := range []struct {
		key   string
		value any
	}{{"central_condition_resolution/" + t.ID, resolution}, {"central_submission/" + v.ID, v}, {"central_task/" + t.ID, *t}} {
		if e := put(k.Store, entry.key, entry.value); e != nil {
			return "", e
		}
	}
	return t.ID, nil
}

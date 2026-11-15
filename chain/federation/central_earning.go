package federation

// This prospective policy leaves legacy research and Coin operations unchanged.
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
	"unicode/utf8"

	"github.com/uain-org/uain/chain/coin"
)

const CentralEarningPolicy = "central-earning-five-kpi-fund-v2"

// Opening allowance; subsequent cumulative allowances require accepted fund/KPI
// transitions. A lifetime ceiling is never spendable allowance.
const CentralProjectAllocation = "10000000000"
const CentralProjectLifetimeCeiling = "1000000000000000"

type CentralActivation struct {
	Policy                    string `json:"policy"`
	Reviewer                  string `json:"reviewer"`
	Height                    int64  `json:"height,string"`
	EvidenceDigest            string `json:"evidence_digest"`
	UpdatedHeight             int64  `json:"updated_height,string,omitempty"`
	ReplacementEvidenceDigest string `json:"replacement_evidence_digest,omitempty"`
}
type CentralBudget struct {
	Achieved        bool   `json:"main_kpi_achieved,omitempty"`
	Closed          bool   `json:"closed,omitempty"`
	LifetimeCeiling string `json:"lifetime_ceiling"`
	Round           uint64 `json:"round"`
	Project         string `json:"project"`
	Manager         string `json:"manager"`
	Policy          string `json:"policy"`
	Allocation      string `json:"allocation"`
	Reserved        string `json:"reserved"`
	Paid            string `json:"paid"`
	Height          int64  `json:"height,string"`
	EvidenceDigest  string `json:"evidence_digest"`
}
type CentralTask struct {
	ID                string `json:"id"`
	Project           string `json:"project"`
	Title             string `json:"title"`
	Criteria          string `json:"criteria"`
	AcceptanceDigest  string `json:"acceptance_digest"`
	Eligibility       string `json:"eligibility"`
	EligibilityDigest string `json:"eligibility_digest"`
	SolverAmount      string `json:"solver_amount"`
	ReviewerAmount    string `json:"reviewer_amount"`
	EvidenceDigest    string `json:"evidence_digest"`
	State             string `json:"state"`
	Pending           string `json:"pending"`
	Winner            string `json:"winner"`
	Reserved          string `json:"reserved"`
	Paid              string `json:"paid"`
	// Central task states (central_task_states.go). All omitted unless the task was opened
	// with a mode or payout after activation, so every existing record keeps its exact bytes.
	HashVersion     int    `json:"hash_version,omitempty"`
	Mode            string `json:"mode,omitempty"`
	Payout          string `json:"payout,omitempty"`
	ClosesAt        int64  `json:"closes_at,string,omitempty"`
	SelectBy        int64  `json:"select_by,string,omitempty"`
	MaxEntries      uint64 `json:"max_entries,string,omitempty"`
	Entries         uint64 `json:"entries,string,omitempty"`
	Decided         uint64 `json:"decided,string,omitempty"`
	Shortlisted     uint64 `json:"shortlisted,string,omitempty"`
	Leading         string `json:"leading,omitempty"`
	JudgedBy        string `json:"judged_by,omitempty"`
	LastJudged      string `json:"last_judged,omitempty"`
	Condition       string `json:"condition,omitempty"`
	ConditionDigest string `json:"condition_digest,omitempty"`
	ResolvesBy      int64  `json:"resolves_by,string,omitempty"`
	ExpiresAt       int64  `json:"expires_at,string,omitempty"`
}
type CentralSubmission struct {
	Evidence       string `json:"evidence"`
	ID             string `json:"id"`
	Task           string `json:"task"`
	Author         string `json:"author"`
	AuthorInstance string `json:"author_instance,omitempty"`
	EvidenceDigest string `json:"evidence_digest"`
	State          string `json:"state"`
	Height         int64  `json:"height,string"`
	// S6 evidence window (central_evidence.go). All omitted until the policy is active, so
	// records written before activation keep their exact bytes.
	EvidenceRequestHeight int64  `json:"evidence_request_height,string,omitempty"`
	EvidenceDeadline      int64  `json:"evidence_deadline,string,omitempty"`
	Revises               string `json:"revises,omitempty"`
	RevisedBy             string `json:"revised_by,omitempty"`
	Reassess              bool   `json:"reassess,omitempty"`
	ReassessHeight        int64  `json:"reassess_height,string,omitempty"`
	ExpiredHeight         int64  `json:"expired_height,string,omitempty"`
	// Review deadline (central_hardening.go); omitted unless written after its activation.
	ReviewDeadline int64 `json:"review_deadline,string,omitempty"`
	// Beauty Contest entry order (central_task_states.go); omitted for every other submission.
	Entry uint64 `json:"entry,string,omitempty"`
}
type CentralReview struct {
	Submission         string `json:"submission"`
	Verdict            string `json:"verdict"`
	CriteriaDigest     string `json:"criteria_digest"`
	VerificationDigest string `json:"verification_digest"`
	ExecutionID        string `json:"execution_id"`
	EvidenceDigest     string `json:"evidence_digest"`
	Reviewer           string `json:"reviewer"`
	Height             int64  `json:"height,string"`
}
type CentralAward struct {
	Submission string `json:"submission"`
	Task       string `json:"task"`
	Project    string `json:"project"`
	Member     string `json:"member"`
	Role       string `json:"role"`
	Amount     string `json:"amount"`
	Height     int64  `json:"height,string"`
}

func centralNumber(s string) (*big.Int, error) {
	if _, e := coin.Empty().Reserve(s); e != nil {
		return nil, e
	}
	n, _ := new(big.Int).SetString(s, 10)
	return n, nil
}
func centralSum(a, b string) string {
	x, _ := new(big.Int).SetString(a, 10)
	y, _ := new(big.Int).SetString(b, 10)
	return x.Add(x, y).String()
}
func centralSub(a, b string) string {
	x, _ := new(big.Int).SetString(a, 10)
	y, _ := new(big.Int).SetString(b, 10)
	return x.Sub(x, y).String()
}
func (k Keeper) centralActive(height int64) (CentralActivation, error) {
	var a CentralActivation
	e := get(k.Store, "central_earning_activation", &a)
	if e != nil {
		return a, e
	}
	if a.Policy != CentralEarningPolicy || height < a.Height {
		return a, errors.New("central earning inactive")
	}
	reviewer, err := k.Member(a.Reviewer)
	if err != nil || reviewer.Licence != "active" {
		return a, errors.New("designated central reviewer is not active")
	}
	_, e = k.activeCoin(height)
	return a, e
}
func (k Keeper) centralProject(id string) (Project, CentralBudget, error) {
	p, e := k.projectState(id)
	var b CentralBudget
	if e != nil {
		return p, b, e
	}
	if p.State != "active" || p.SafetyHalted {
		return p, b, errors.New("central project inactive")
	}
	e = get(k.Store, "central_project_budget/"+id, &b)
	if e == nil && (b.Policy != CentralEarningPolicy || b.Project != id || b.Allocation != centralAllocation(b.Round) || b.Allocation == "" || b.LifetimeCeiling != CentralProjectLifetimeCeiling || b.Height < 1 || !digestPattern.MatchString(b.EvidenceDigest)) {
		e = errors.New("invalid central budget")
	}
	if e == nil {
		// Validate canonical nonnegative accounting before any big.Int arithmetic.
		accounting := coin.Ledger{Minted: b.Paid, Reserved: b.Reserved, Transparent: b.Paid, Shielded: "0"}
		if err := accounting.Validate(); err != nil {
			return p, b, err
		}
		used, _ := new(big.Int).SetString(centralSum(b.Paid, b.Reserved), 10)
		allowance, _ := new(big.Int).SetString(b.Allocation, 10)
		if used.Cmp(allowance) > 0 {
			return p, b, errors.New("central unlocked allowance exceeded")
		}
	}
	return p, b, e
}
func (k Keeper) centralEarning(c Command, height int64, now time.Time) (string, error) {
	bad := errors.New("invalid central earning transition")
	if c.Operation == "central_earning_activate" {
		var a CentralActivation
		var in struct {
			Policy         string `json:"policy"`
			Reviewer       string `json:"reviewer"`
			EvidenceDigest string `json:"evidence_digest"`
		}
		if e := Decode(c.Payload, &in); e != nil {
			return "", e
		}
		m, e := k.Member(in.Reviewer)
		if e != nil || m.Licence != "active" || !k.guardian(c.Member) || in.Policy != CentralEarningPolicy || !digestPattern.MatchString(in.EvidenceDigest) || height < 1 || height == math.MaxInt64 || k.Store.Get([]byte("central_earning_activation")) != nil {
			return "", bad
		}
		if _, e = k.activeCoin(height); e != nil {
			return "", e
		}
		a = CentralActivation{Policy: in.Policy, Reviewer: in.Reviewer, Height: height + 1, EvidenceDigest: in.EvidenceDigest}
		return in.Policy, put(k.Store, "central_earning_activation", a)
	}
	if c.Operation == "central_reviewer_replace" {
		var in struct {
			ExpectedReviewer string `json:"expected_reviewer"`
			NewReviewer      string `json:"new_reviewer"`
			EvidenceDigest   string `json:"evidence_digest"`
		}
		if e := Decode(c.Payload, &in); e != nil {
			return "", e
		}
		var current CentralActivation
		if e := get(k.Store, "central_earning_activation", &current); e != nil {
			return "", e
		}
		replacement, e := k.Member(in.NewReviewer)
		if !k.guardian(c.Member) || current.Policy != CentralEarningPolicy || height < current.Height || !coinBoundaryMember.MatchString(in.ExpectedReviewer) || !coinBoundaryMember.MatchString(in.NewReviewer) || in.ExpectedReviewer != current.Reviewer || in.NewReviewer == current.Reviewer || e != nil || replacement.Licence != "active" || !digestPattern.MatchString(in.EvidenceDigest) {
			return "", bad
		}
		if _, e = k.activeCoin(height); e != nil {
			return "", e
		}
		key := fmt.Sprintf("central_reviewer_change/%020d/%s", height, in.NewReviewer)
		if k.Store.Get([]byte(key)) != nil {
			return "", bad
		}
		change := struct {
			ExpectedReviewer string `json:"expected_reviewer"`
			NewReviewer      string `json:"new_reviewer"`
			Guardian         string `json:"guardian"`
			Height           int64  `json:"height,string"`
			EvidenceDigest   string `json:"evidence_digest"`
		}{in.ExpectedReviewer, in.NewReviewer, c.Member, height, in.EvidenceDigest}
		current.Reviewer = in.NewReviewer
		current.UpdatedHeight = height
		current.ReplacementEvidenceDigest = in.EvidenceDigest
		if e = put(k.Store, key, change); e != nil {
			return "", e
		}
		return in.NewReviewer, put(k.Store, "central_earning_activation", current)
	}
	if c.Operation == "central_evidence_activate" {
		return k.centralEvidenceActivate(c, height)
	}
	if c.Operation == "central_task_states_activate" {
		return k.centralTaskStatesActivate(c, height)
	}
	if c.Operation == "central_hardening_activate" {
		return k.centralHardeningActivate(c, height)
	}
	a, e := k.centralActive(height)
	if e != nil {
		return "", e
	}
	if centralTaskStatesOperation(c.Operation) {
		return k.centralTaskStatesTransition(c, height, now, a)
	}
	if c.Operation == "central_reassess" || c.Operation == "central_evidence_expire" {
		return k.centralEvidenceTransition(c, height, a)
	}
	if c.Operation == "central_project_start" {
		var in struct {
			Project        string `json:"project"`
			Manager        string `json:"manager"`
			EvidenceDigest string `json:"evidence_digest"`
		}
		if e = Decode(c.Payload, &in); e != nil {
			return "", e
		}
		p, err := k.projectState(in.Project)
		m, me := k.Member(in.Manager)
		if err != nil || me != nil || m.Licence != "active" || p.State != "active" || p.SafetyHalted || (!k.guardian(c.Member) && p.Lead != c.Member) || !digestPattern.MatchString(in.EvidenceDigest) || k.Store.Get([]byte("central_project_budget/"+in.Project)) != nil {
			return "", bad
		}
		if err = k.centralAdoptionFinancialAudit(in.Project); err != nil {
			return "", err
		}
		b := CentralBudget{Project: in.Project, Manager: in.Manager, Policy: CentralEarningPolicy, Allocation: CentralProjectAllocation, Reserved: "0", Paid: "0", Height: height, EvidenceDigest: in.EvidenceDigest, LifetimeCeiling: CentralProjectLifetimeCeiling, Round: 1}
		return in.Project, put(k.Store, "central_project_budget/"+in.Project, b)
	}
	if c.Operation == "central_task_open" {
		var in struct {
			ID                string `json:"id"`
			Project           string `json:"project"`
			Title             string `json:"title"`
			Criteria          string `json:"criteria"`
			AcceptanceDigest  string `json:"acceptance_digest"`
			Eligibility       string `json:"eligibility"`
			EligibilityDigest string `json:"eligibility_digest"`
			SolverAmount      string `json:"solver_amount"`
			ReviewerAmount    string `json:"reviewer_amount"`
			EvidenceDigest    string `json:"evidence_digest"`
		}
		// After central-task-states-v1 the payload may also carry a mode and payout.
		// Before it, decoding stays strict over exactly the original fields.
		states, statesOn, err := k.centralTaskStates(height)
		if err != nil {
			return "", err
		}
		var extension CentralTaskOpenExtension
		if statesOn {
			var wide struct {
				ID                string `json:"id"`
				Project           string `json:"project"`
				Title             string `json:"title"`
				Criteria          string `json:"criteria"`
				AcceptanceDigest  string `json:"acceptance_digest"`
				Eligibility       string `json:"eligibility"`
				EligibilityDigest string `json:"eligibility_digest"`
				SolverAmount      string `json:"solver_amount"`
				ReviewerAmount    string `json:"reviewer_amount"`
				EvidenceDigest    string `json:"evidence_digest"`
				Mode              string `json:"mode"`
				Payout            string `json:"payout"`
				ClosesAt          string `json:"closes_at"`
				MaxEntries        string `json:"max_entries"`
				Condition         string `json:"condition"`
				ResolvesBy        string `json:"resolves_by"`
			}
			if e = Decode(c.Payload, &wide); e != nil {
				return "", e
			}
			in.ID, in.Project, in.Title, in.Criteria, in.AcceptanceDigest = wide.ID, wide.Project, wide.Title, wide.Criteria, wide.AcceptanceDigest
			in.Eligibility, in.EligibilityDigest, in.SolverAmount, in.ReviewerAmount, in.EvidenceDigest = wide.Eligibility, wide.EligibilityDigest, wide.SolverAmount, wide.ReviewerAmount, wide.EvidenceDigest
			extension = CentralTaskOpenExtension{wide.Mode, wide.Payout, wide.ClosesAt, wide.MaxEntries, wide.Condition, wide.ResolvesBy}
		} else if e = Decode(c.Payload, &in); e != nil {
			return "", e
		}
		_, b, err := k.centralProject(in.Project)
		if err != nil {
			return "", err
		}
		if e = k.centralFundReady(in.Project, b); e != nil {
			return "", e
		}
		if b.Closed || b.Achieved || c.Member != b.Manager || !validID(in.ID) || len(strings.TrimSpace(in.Title)) < 3 || len(in.Title) > 240 || !centralText(in.Criteria, in.AcceptanceDigest, 4096) || !digestPattern.MatchString(in.EligibilityDigest) || !digestPattern.MatchString(in.EvidenceDigest) || (in.Eligibility != "hard" && in.Eligibility != "new" && in.Eligibility != "unresolved") || k.Store.Get([]byte("central_task/"+in.ID)) != nil || k.Store.Get([]byte("task/"+in.ID)) != nil {
			return "", bad
		}
		if _, e = centralNumber(in.SolverAmount); e != nil {
			return "", e
		}
		if _, e = centralNumber(in.ReviewerAmount); e != nil {
			return "", e
		}
		t := CentralTask{ID: in.ID, Project: in.Project, Title: in.Title, Criteria: in.Criteria, AcceptanceDigest: in.AcceptanceDigest, Eligibility: in.Eligibility, EligibilityDigest: in.EligibilityDigest, SolverAmount: in.SolverAmount, ReviewerAmount: in.ReviewerAmount, EvidenceDigest: in.EvidenceDigest, State: "open", Reserved: "0", Paid: "0"}
		if statesOn {
			if e = k.applyOpenExtension(&t, extension, states.Params, now); e != nil {
				return "", e
			}
		}
		if e = k.centralFund(&t, &b); e != nil {
			return "", e
		}
		if e = k.centralIndexTask(t); e != nil {
			return "", e
		}
		return t.ID, put(k.Store, "central_task/"+t.ID, t)
	}
	if c.Operation == "central_task_fund" {
		var in struct {
			Task           string `json:"task"`
			EvidenceDigest string `json:"evidence_digest"`
		}
		if e = Decode(c.Payload, &in); e != nil {
			return "", e
		}
		var t CentralTask
		if e = get(k.Store, "central_task/"+in.Task, &t); e != nil {
			return "", e
		}
		_, b, err := k.centralProject(t.Project)
		if err != nil {
			return "", err
		}
		if e = k.centralFundReady(t.Project, b); e != nil {
			return "", e
		}
		if b.Closed || b.Achieved || c.Member != b.Manager || t.State != "open_unfunded" || t.Pending != "" || t.Winner != "" || t.Reserved != "0" || !digestPattern.MatchString(in.EvidenceDigest) {
			return "", bad
		}
		if e = k.centralFund(&t, &b); e != nil {
			return "", e
		}
		t.State = "open"
		return t.ID, put(k.Store, "central_task/"+t.ID, t)
	}
	if c.Operation == "central_submit" {
		var in struct {
			ID             string `json:"id"`
			Task           string `json:"task"`
			Evidence       string `json:"evidence"`
			EvidenceDigest string `json:"evidence_digest"`
			Revises        string `json:"revises,omitempty"`
		}
		if e = Decode(c.Payload, &in); e != nil {
			return "", e
		}
		var t CentralTask
		if e = get(k.Store, "central_task/"+in.Task, &t); e != nil {
			return "", e
		}
		p, _, err := k.centralProject(t.Project)
		if err != nil {
			return "", err
		}
		if e = k.requireParticipation(p, c); e != nil {
			return "", e
		}
		_, evidenceOn, err := k.centralEvidencePolicy(height)
		if err != nil {
			return "", err
		}
		hard, hardOn, err := k.centralHardening(height)
		if err != nil {
			return "", err
		}
		if t.Mode == "contest" {
			// Only tasks opened after central-task-states-v1 carry a mode.
			return k.centralContestEnter(c, a, t, in.ID, in.Evidence, in.EvidenceDigest, in.Revises, height, now)
		}
		if in.Revises != "" {
			if !evidenceOn || !validID(in.ID) || !centralText(in.Evidence, in.EvidenceDigest, 16384) || c.Member == a.Reviewer || k.Store.Get([]byte("central_submission/"+in.ID)) != nil {
				return "", bad
			}
			o, err := k.centralRevise(c, height, &t, in.Revises)
			if err != nil {
				return "", err
			}
			o.State = "superseded"
			o.RevisedBy = in.ID
			v := CentralSubmission{Evidence: in.Evidence, ID: in.ID, Task: t.ID, Author: c.Member, AuthorInstance: c.Instance, EvidenceDigest: in.EvidenceDigest, State: "under_review", Height: height, Revises: o.ID, ReviewDeadline: centralReviewDeadline(hard, hardOn, height)}
			if e = k.centralClaimEvidence(hardOn, in.EvidenceDigest, c.Member); e != nil {
				return "", e
			}
			t.Pending = in.ID
			for _, entry := range []struct {
				key   string
				value any
			}{{"central_submission/" + o.ID, o}, {"central_task/" + t.ID, t}, {"central_submission/" + in.ID, v}} {
				if e = put(k.Store, entry.key, entry.value); e != nil {
					return "", e
				}
			}
			return in.ID, nil
		}
		if (evidenceOn || hardOn) && t.State == "under_review" {
			// An expired evidence request or review deadline reopens the task for anyone, in the same transaction.
			if _, e = k.centralEvidenceExpire(&t, height); e != nil {
				return "", e
			}
		}
		if !validID(in.ID) || !centralText(in.Evidence, in.EvidenceDigest, 16384) || t.State != "open" || t.Pending != "" || t.Winner != "" || t.Reserved != centralSum(t.SolverAmount, t.ReviewerAmount) || c.Member == a.Reviewer || k.Store.Get([]byte("central_submission/"+in.ID)) != nil {
			return "", bad
		}
		v := CentralSubmission{Evidence: in.Evidence, ID: in.ID, Task: t.ID, Author: c.Member, AuthorInstance: c.Instance, EvidenceDigest: in.EvidenceDigest, State: "under_review", Height: height, ReviewDeadline: centralReviewDeadline(hard, hardOn, height)}
		if e = k.centralClaimEvidence(hardOn, in.EvidenceDigest, c.Member); e != nil {
			return "", e
		}
		t.Pending = in.ID
		t.State = "under_review"
		if e = put(k.Store, "central_task/"+t.ID, t); e != nil {
			return "", e
		}
		return in.ID, put(k.Store, "central_submission/"+in.ID, v)
	}
	if c.Operation != "central_review" {
		return "", bad
	}
	var in struct {
		Submission         string `json:"submission"`
		Verdict            string `json:"verdict"`
		CriteriaDigest     string `json:"criteria_digest"`
		VerificationDigest string `json:"verification_digest"`
		ExecutionID        string `json:"execution_id"`
		EvidenceDigest     string `json:"evidence_digest"`
	}
	if e = Decode(c.Payload, &in); e != nil {
		return "", e
	}
	var v CentralSubmission
	if e = get(k.Store, "central_submission/"+in.Submission, &v); e != nil {
		return "", e
	}
	var t CentralTask
	if e = get(k.Store, "central_task/"+v.Task, &t); e != nil {
		return "", e
	}
	_, b, err := k.centralProject(t.Project)
	if err != nil {
		return "", err
	}
	if t.Mode == "contest" {
		// Only tasks opened after central-task-states-v1 carry a mode.
		return k.centralContestReview(c, a, t, v, centralReviewPayload(in), height, now)
	}
	if c.Member != a.Reviewer || c.Member == v.Author || t.State != "under_review" || t.Pending != v.ID || v.State != "under_review" || in.CriteriaDigest != t.AcceptanceDigest || !digestPattern.MatchString(in.VerificationDigest) || in.EvidenceDigest != v.EvidenceDigest || !validID(in.ExecutionID) || (in.Verdict != "accept" && in.Verdict != "reject" && in.Verdict != "needs_evidence") {
		return "", bad
	}
	h := sha256.Sum256([]byte(in.ExecutionID))
	reviewKey := "central_review/" + v.ID + "/" + hex.EncodeToString(h[:])
	if k.Store.Get([]byte(reviewKey)) != nil {
		return "", bad
	}
	r := CentralReview{v.ID, in.Verdict, in.CriteriaDigest, in.VerificationDigest, in.ExecutionID, in.EvidenceDigest, c.Member, height}
	window, evidenceOn, err := k.centralEvidencePolicy(height)
	if err != nil {
		return "", err
	}
	if evidenceOn && centralEvidenceExpirable(v, height) {
		// The window passed: the request expires (central_evidence_expire), never a late verdict.
		return "", bad
	}
	if centralReviewExpirable(v, height) {
		// The review deadline passed: the submission expires, never a late verdict.
		return "", bad
	}
	if in.Verdict == "needs_evidence" {
		if evidenceOn {
			// One request per submission lineage; a revision or reassessment needs accept or reject.
			if v.EvidenceDeadline > 0 || v.Revises != "" || v.Reassess || height > math.MaxInt64-window.WindowBlocks {
				return "", bad
			}
			v.EvidenceRequestHeight = height
			v.EvidenceDeadline = height + window.WindowBlocks
			v.ReviewDeadline = 0 // the evidence window alone governs the author's revision time
			if e = put(k.Store, "central_submission/"+v.ID, v); e != nil {
				return "", e
			}
		}
		return v.ID, put(k.Store, reviewKey, r)
	}
	if in.Verdict == "accept" && t.Payout == "conditional" {
		// Conditional Approved: only tasks opened after central-task-states-v1 carry a payout.
		return k.centralConditionalAccept(c, &t, &b, &v, r, reviewKey, height, now)
	}
	author, err := k.Member(v.Author)
	if err != nil || !coinBoundaryMember.MatchString(v.Author) || author.ID != v.Author || (in.Verdict == "accept" && author.Licence != "active") {
		return "", bad
	}
	ledger, err := k.coinLedger()
	if err != nil {
		return "", err
	}
	total := centralSum(t.SolverAmount, t.ReviewerAmount)
	if t.Reserved != total {
		return "", bad
	}
	paid := t.ReviewerAmount
	if in.Verdict == "accept" {
		paid = total
	}
	next, err := ledger.Mint(paid)
	if err != nil {
		return "", err
	}
	if in.Verdict == "reject" {
		next, err = next.Release(t.SolverAmount)
		if err != nil {
			return "", err
		}
	}
	awards := []CentralAward{{v.ID, t.ID, t.Project, c.Member, "reviewer", t.ReviewerAmount, height}}
	if in.Verdict == "accept" {
		awards = append(awards, CentralAward{v.ID, t.ID, t.Project, v.Author, "solver", t.SolverAmount, height})
	}
	// Validate all recipients and receipt uniqueness before any writes.
	balances := map[string]string{}
	for _, award := range awards {
		key := "central_award/" + award.Role + "/" + v.ID
		if k.Store.Get([]byte(key)) != nil {
			return "", bad
		}
		balance := "0"
		if k.Store.Get([]byte("coin_balance/"+award.Member)) != nil {
			if e = get(k.Store, "coin_balance/"+award.Member, &balance); e != nil {
				return "", e
			}
		}
		if e = (coin.Ledger{Minted: balance, Reserved: "0", Transparent: balance, Shielded: "0"}).Validate(); e != nil {
			return "", e
		}
		balances[award.Member] = centralSum(balance, award.Amount)
	}
	reserved, _ := new(big.Int).SetString(b.Reserved, 10)
	n, _ := new(big.Int).SetString(total, 10)
	if reserved == nil || reserved.Cmp(n) < 0 {
		return "", bad
	}
	b.Reserved = centralSub(b.Reserved, total)
	b.Paid = centralSum(b.Paid, paid)
	t.Reserved = "0"
	t.Paid = centralSum(t.Paid, paid)
	t.Pending = ""
	v.State = "rejected"
	t.State = "open_unfunded"
	if in.Verdict == "accept" {
		t.Winner = v.ID
		t.State = "accepted"
		v.State = "accepted"
	}
	if e = put(k.Store, "coin_supply", next); e != nil {
		return "", e
	}
	for _, award := range awards {
		member, balance := award.Member, balances[award.Member]
		if e = put(k.Store, "coin_balance/"+member, balance); e != nil {
			return "", e
		}
	}
	for _, award := range awards {
		if e = k.centralIndexAward(award); e != nil {
			return "", e
		}
		if e = put(k.Store, "central_award/"+award.Role+"/"+v.ID, award); e != nil {
			return "", e
		}
	}
	// KarmaPolicyV2: each paid award also gives 1 Karma per whole AI$. Before
	// activation this is one unmetered marker read and nothing else.
	if _, on, err := k.karmaPolicy(); err != nil {
		return "", err
	} else if on {
		for _, award := range awards {
			if _, e = k.recordCentralAwardKarma(award, "central_award", now); e != nil {
				return "", e
			}
		}
	}
	for _, entry := range []struct {
		key   string
		value any
	}{{"central_project_budget/" + b.Project, b}, {"central_task/" + t.ID, t}, {"central_submission/" + v.ID, v}, {reviewKey, r}} {
		key, value := entry.key, entry.value
		if e = put(k.Store, key, value); e != nil {
			return "", e
		}
	}
	return v.ID, nil
}
func (k Keeper) centralFund(t *CentralTask, b *CentralBudget) error {
	total := centralSum(t.SolverAmount, t.ReviewerAmount)
	used := centralSum(centralSum(b.Paid, b.Reserved), total)
	n, _ := new(big.Int).SetString(used, 10)
	cap, _ := new(big.Int).SetString(b.Allocation, 10)
	if n.Cmp(cap) > 0 {
		return errors.New("central project allocation exceeded")
	}
	ledger, e := k.coinLedger()
	if e != nil {
		return e
	}
	next, e := ledger.Reserve(total)
	if e != nil {
		return e
	}
	b.Reserved = centralSum(b.Reserved, total)
	t.Reserved = total
	if e = put(k.Store, "coin_supply", next); e != nil {
		return e
	}
	return put(k.Store, "central_project_budget/"+b.Project, *b)
}

func centralText(text, digest string, limit int) bool {
	h := sha256.Sum256([]byte(text))
	return len(strings.TrimSpace(text)) > 0 && len(text) <= limit && utf8.ValidString(text) && hex.EncodeToString(h[:]) == digest
}

type CentralEarnings struct {
	Member   string `json:"member"`
	Solver   string `json:"solver"`
	Reviewer string `json:"reviewer"`
	Total    string `json:"total"`
	Awards   string `json:"awards"`
}

func centralNextCount(raw string) (string, error) {
	n, e := strconv.ParseUint(raw, 10, 64)
	if e != nil || strconv.FormatUint(n, 10) != raw || n == math.MaxUint64 {
		return "", errors.New("central index overflow")
	}
	return strconv.FormatUint(n+1, 10), nil
}
func (k Keeper) centralIndexTask(t CentralTask) error {
	count := "0"
	if k.Store.Get([]byte("central_task_count")) != nil {
		if e := get(k.Store, "central_task_count", &count); e != nil {
			return e
		}
	}
	next, e := centralNextCount(count)
	if e != nil {
		return e
	}
	n, _ := strconv.ParseUint(next, 10, 64)
	if e = put(k.Store, fmt.Sprintf("central_task_index/%020d", n), struct {
		ID      string `json:"id"`
		Project string `json:"project"`
	}{t.ID, t.Project}); e != nil {
		return e
	}
	return put(k.Store, "central_task_count", next)
}
func (k Keeper) centralIndexAward(a CentralAward) error {
	v := CentralEarnings{a.Member, "0", "0", "0", "0"}
	if k.Store.Get([]byte("central_earnings/"+a.Member)) != nil {
		if e := get(k.Store, "central_earnings/"+a.Member, &v); e != nil {
			return e
		}
	}
	next, e := centralNextCount(v.Awards)
	if e != nil {
		return e
	}
	v.Awards = next
	v.Total = centralSum(v.Total, a.Amount)
	if a.Role == "solver" {
		v.Solver = centralSum(v.Solver, a.Amount)
	} else {
		v.Reviewer = centralSum(v.Reviewer, a.Amount)
	}
	n, _ := strconv.ParseUint(next, 10, 64)
	if e = put(k.Store, fmt.Sprintf("central_award_index/%s/%020d", a.Member, n), struct {
		Submission string `json:"submission"`
		Role       string `json:"role"`
	}{a.Submission, a.Role}); e != nil {
		return e
	}
	return put(k.Store, "central_earnings/"+a.Member, v)
}

// This deliberately audits monetary rows, not the potentially large research
// catalogue. Beyond this bound adoption requires an explicitly reviewed migration.
const CentralLegacyFinancialAuditLimit = 128

// Chains initialized with the per-project finance index (genesis from 9
// November 2026) record every v1 Coin quote and funding reward schedule under
// its project when written, so adoption reads one key instead of scanning the
// whole chain (the former 128-row bound refused every project once the chain
// held 129 quotes). Older stores keep the original bounded scan.
func (k Keeper) indexProjectFinance(project string) error {
	if !k.consensusV2() {
		return nil
	}
	if !validID(project) {
		return errors.New("invalid financial project binding")
	}
	return put(k.Store, "project_finance/"+project, true)
}

func (k Keeper) centralAdoptionFinancialAudit(project string) error {
	if k.consensusV2() {
		if k.Store.Get([]byte("project_finance/"+project)) != nil {
			return errors.New("project has legacy Coin financial history; reviewed reconciliation required")
		}
		return nil
	}
	for _, prefix := range []string{"coin_quote/", "coin_reservation/", "funding_reward_schedule/"} {
		rows, e := k.Store.Range([]byte(prefix), []byte(prefix[:len(prefix)-1]+"0"), CentralLegacyFinancialAuditLimit+1)
		if e != nil {
			return e
		}
		if len(rows) > CentralLegacyFinancialAuditLimit {
			return errors.New("legacy financial audit bound exceeded; reviewed migration required")
		}
		for _, row := range rows {
			if prefix == "funding_reward_schedule/" {
				var schedule FundingRewardSchedule
				if e = Decode(row.Value, &schedule); e != nil {
					return e
				}
				if !validID(schedule.Campaign) || string(row.Key) != prefix+schedule.Campaign {
					return errors.New("invalid legacy funding schedule binding")
				}
				var campaign FundingCampaign
				if e = get(k.Store, "funding_campaign/"+schedule.Campaign, &campaign); e != nil {
					return e
				}
				if campaign.ID != schedule.Campaign || !validID(campaign.Project) {
					return errors.New("invalid legacy funding campaign binding")
				}
				if campaign.Project == project {
					return errors.New("project has legacy funding Coin rewards; reviewed reconciliation required")
				}
				continue
			}
			var task string
			if prefix == "coin_quote/" {
				var v CoinQuote
				if e = Decode(row.Value, &v); e != nil {
					return e
				}
				task = v.Task
			} else {
				var v CoinReservation
				if e = Decode(row.Value, &v); e != nil {
					return e
				}
				task = v.Task
			}
			if !validID(task) || string(row.Key) != prefix+task {
				return errors.New("invalid legacy financial task binding")
			}
			t, e := k.taskState(task)
			if e != nil {
				return e
			}
			if t.ID != task || !validID(t.Project) {
				return errors.New("invalid legacy financial project binding")
			}
			if t.Project == project {
				return errors.New("project has legacy Coin financial history; reviewed reconciliation required")
			}
		}
	}
	return nil
}
func (k Keeper) centralQuoteGuard(project string, height int64) error {
	var raw []byte
	if reader, ok := k.Store.(interface{ CentralEarningMarker() []byte }); ok {
		raw = reader.CentralEarningMarker()
	} else {
		raw = k.Store.Get([]byte("central_earning_activation"))
	}
	if raw == nil {
		return nil
	}
	var activation CentralActivation
	if e := Decode(raw, &activation); e != nil {
		return e
	}
	if activation.Policy != CentralEarningPolicy || activation.Height < 2 {
		return errors.New("invalid central earning activation")
	}
	if height < activation.Height {
		return nil
	}
	if k.Store.Get([]byte("central_project_budget/"+project)) != nil {
		return errors.New("centrally adopted project requires central budgeted Coin awards")
	}
	return nil
}

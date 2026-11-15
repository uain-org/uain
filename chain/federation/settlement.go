package federation

import (
	"errors"
	"math/big"
	"time"
)

func (k Keeper) settleCredits(v Contribution, t Task, now time.Time) error {
	if v.State != "held" && v.State != "verified" {
		return nil
	}
	p, err := k.projectState(t.Project)
	if err != nil {
		return err
	}
	return k.settleCreditsInProject(v, t, p, now)
}

func (k Keeper) settleCreditsInProject(v Contribution, t Task, p Project, now time.Time) error {
	if v.State != "held" && v.State != "verified" {
		return nil
	}
	if p.State != "active" {
		return nil
	}
	if t.State != "open" && t.State != "kpi_met" {
		return nil
	}
	if t.Winner != "" {
		return errors.New("task already settled")
	}
	newSettlement := v.Settlement == nil
	if newSettlement && v.StoragePolicy == CompactStatePolicy {
		possible, known := 0, false
		for _, check := range v.Verifications {
			if check.Verdict == "confirm" && check.Novelty == "known" {
				known = true
			}
			if check.Member != v.Author && check.Verdict == "confirm" && check.Novelty == "new" {
				possible++
			}
		}
		// A missing count cannot become sufficient after checking licences or
		// families. Known evidence still follows the original withholding path.
		if !known && possible < t.VerifiersRequired {
			return nil
		}
	}
	if v.Settlement == nil {
		author, err := k.Member(v.Author)
		if err != nil {
			return err
		}
		family, active, err := k.actorFamily(author, v.AuthorInstance)
		if err != nil {
			return err
		}
		if !active || author.Licence != "active" {
			return nil
		}
		checks := []Verification{}
		operators := map[string]bool{}
		hasDefault, otherFamily := false, false
		if p.OperatorPolicy != "" && p.OperatorPolicy != OperatorRewardPolicy {
			return errors.New("unsupported project operator policy")
		}
		if p.OperatorPolicy == OperatorRewardPolicy {
			family = modelFamily(family)
			otherFamily = family == ""
		}
		for _, check := range v.Verifications {
			if check.Verdict == "confirm" && check.Novelty == "known" {
				v.State = "withheld"
				v.AwardWithheld = "known"
				return put(k.Store, "contribution/"+v.ID, v)
			}
			m, err := k.Member(check.Member)
			if err != nil {
				return err
			}
			cf, active, err := k.actorFamily(m, check.Instance)
			if err != nil {
				return err
			}
			if m.ID == author.ID || m.Licence != "active" || !active || check.Verdict != "confirm" || check.Novelty != "new" {
				continue
			}
			checks = append(checks, check)
			hasDefault = hasDefault || m.DefaultVerifier
			if p.OperatorPolicy == "" {
				op := normaliseOperator(m.Operator)
				if op != "" && op != normaliseOperator(author.Operator) {
					operators[op] = true
				}
			} else {
				cf = modelFamily(cf)
			}
			otherFamily = otherFamily || (family != "" && cf != "" && cf != family)
		}
		if len(checks) < t.VerifiersRequired || !hasDefault {
			return nil
		}
		if err = k.finalizeArbitration(v, checks, now); err != nil {
			return err
		}
		operatorCount := len(operators)
		if p.OperatorPolicy == OperatorRewardPolicy {
			operatorCount, err = k.independentOperators(v.Author, v.AuthorInstance, checks)
			if err != nil {
				return err
			}
		}
		numerator, denominator := int64(1), int64(1)
		if t.VerifiersRequired < 2 || operatorCount < 2 || !otherFamily {
			numerator, denominator = 3, 5
		}
		// Positive Math.round semantics, expressed as integers with no float drift.
		amount := big.NewInt(t.KarmaReward)
		amount.Mul(amount, big.NewInt(numerator))
		amount.Mul(amount, big.NewInt(2))
		amount.Add(amount, big.NewInt(denominator))
		amount.Quo(amount, big.NewInt(2*denominator))
		if !amount.IsInt64() {
			return errors.New("award overflow")
		}
		v.Settlement = &Settlement{Policy: CreditRewardPolicy, Karma: amount.Int64(), Credits: amount.String(), FactorNumerator: numerator, FactorDenominator: denominator, IndependentOperators: operatorCount, OtherFamily: otherFamily, Checks: checks}
		if v.StoragePolicy == CompactStatePolicy {
			v.Settlement.Checks = nil
			for _, check := range checks {
				v.Settlement.CheckRefs = append(v.Settlement.CheckRefs, check.RecordDigest)
			}
		}
	}
	if v.Settlement.Policy != CreditRewardPolicy || v.Settlement.Paid {
		return errors.New("invalid or already paid frozen settlement")
	}
	if t.Kind == "future" && t.State != "kpi_met" {
		if v.StoragePolicy == CompactStatePolicy && !newSettlement && v.State == "verified" {
			return nil
		}
		v.State = "verified"
		return put(k.Store, "contribution/"+v.ID, v)
	}
	// The pilot reserves priority by submission order. Earlier work still
	// being judged (including disputes) must not lose to a faster checker.
	for _, id := range t.Submissions {
		if id == v.ID {
			break
		}
		earlier, err := k.contributionState(id)
		if err != nil {
			return err
		}
		if earlier.State != "withheld" && earlier.State != "rejected" {
			if v.StoragePolicy == CompactStatePolicy && !newSettlement && v.State == "verified" {
				return nil
			}
			v.State = "verified"
			return put(k.Store, "contribution/"+v.ID, v)
		}
	}
	award, err := money(v.Settlement.Credits)
	if err != nil {
		return err
	}
	if err = k.settleBudget(&p, &t, award); err != nil {
		return err
	}
	// Karma is earned once at successful settlement; cap/recipient withholding
	// affects spendable credits only and never erases an already earned amount.
	if err = k.recordKarma(v.Author, v.AuthorInstance, v.Settlement.Karma, "settlement", v.ID, now); err != nil {
		return err
	}
	if err = k.credit(v.Author, v.AuthorInstance, v.ID, "work", award, now, false, ""); err != nil {
		return err
	}
	checks, err := k.frozenChecks(v)
	if err != nil {
		return err
	}
	count := len(checks)
	if count == 0 {
		return errors.New("empty frozen checks")
	}
	pool := new(big.Int).Quo(new(big.Int).Set(award), big.NewInt(5))
	share, remainder := new(big.Int), new(big.Int)
	share.QuoRem(pool, big.NewInt(int64(count)), remainder)
	for i, check := range checks {
		amount := new(big.Int).Set(share)
		if int64(i) < remainder.Int64() {
			amount.Add(amount, big.NewInt(1))
		}
		if err = k.credit(check.Member, check.Instance, v.ID, "verification", amount, now, false, ""); err != nil {
			return err
		}
	}
	t.Winner = v.ID
	t.State = "settled"
	v.State = "settled"
	v.Settlement.Paid = true
	if err = put(k.Store, "task/"+t.ID, t); err != nil {
		return err
	}
	return put(k.Store, "contribution/"+v.ID, v)
}

// A known/rejected earlier answer may unblock a previously verified result.
// Each task has at most twenty submissions, so rechecking is bounded.
func (k Keeper) settlePending(t Task, now time.Time) error {
	if t.StoragePolicy == CompactStatePolicy {
		p, err := k.projectState(t.Project)
		if err != nil {
			return err
		}
		for _, id := range t.Submissions {
			if t.Winner != "" {
				break
			}
			var v Contribution
			if err = get(k.Store, "contribution/"+id, &v); err != nil {
				return err
			}
			if v.Task != t.ID {
				return errors.New("task submission owner mismatch")
			}
			if t.PriorArtDecision != "" && v.State != "settled" && v.State != "rejected" && v.State != "withheld" {
				v.State, v.AwardWithheld = "withheld", "known"
			}
			if err = k.settleCreditsInProject(v, t, p, now); err != nil {
				return err
			}
			// An unresolved future task cannot pay or change its prize order.
			// Reload once only when a candidate could have settled this task.
			if t.Kind != "future" || t.State == "kpi_met" {
				t, err = k.taskState(t.ID)
				if err != nil {
					return err
				}
			}
		}
		return nil
	}
	for _, id := range t.Submissions {
		current, err := k.taskState(t.ID)
		if err != nil {
			return err
		}
		if current.Winner != "" {
			break
		}
		v, err := k.contributionState(id)
		if err != nil {
			return err
		}
		if err = k.settleCredits(v, current, now); err != nil {
			return err
		}
	}
	return nil
}

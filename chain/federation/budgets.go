package federation

import (
	"errors"
	"math/big"
)

const CreditRewardPolicy = "pilot-credits-v1"

func initialAccounting() *AccountingBudget {
	return &AccountingBudget{Allocated: "0", Unlocked: "0", Spent: "0", Reserved: "0", Stage: 0}
}

func unlockedBudget(total *big.Int, stage int) (*big.Int, error) {
	shares := []int64{1, 10, 200, 10000}
	if stage < 0 || stage >= len(shares) {
		return nil, errors.New("invalid budget stage")
	}
	amount := new(big.Int).Quo(new(big.Int).Mul(total, big.NewInt(shares[stage])), big.NewInt(10000))
	if amount.Cmp(big.NewInt(1000)) < 0 {
		amount.SetInt64(1000)
	}
	if amount.Cmp(total) > 0 {
		amount.Set(total)
	}
	return amount, nil
}

func (k Keeper) allocateAccounting(p *Project, amount *big.Int) error {
	a := p.Accounting
	total, err := money(a.Allocated)
	if err != nil {
		return err
	}
	total.Add(total, amount)
	if len(total.String()) > 78 {
		return errors.New("budget overflow")
	}
	unlocked, err := unlockedBudget(total, a.Stage)
	if err != nil {
		return err
	}
	spent, err := money(a.Spent)
	if err != nil {
		return err
	}
	reserved, err := money(a.Reserved)
	if err != nil {
		return err
	}
	balance := new(big.Int).Sub(unlocked, spent)
	if balance.Sign() < 0 || balance.Cmp(reserved) < 0 {
		return errors.New("inconsistent budget allocation")
	}
	a.Allocated = total.String()
	a.Unlocked = unlocked.String()
	p.Budget = balance.String()
	return nil
}

func (k Keeper) unlockBudget(c Command) (string, error) {
	if !k.guardian(c.Member) {
		return "", errors.New("guardian budget unlock required")
	}
	var input struct {
		Project        string `json:"project"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if err := Decode(c.Payload, &input); err != nil {
		return "", err
	}
	p, err := k.projectState(input.Project)
	if err != nil {
		return "", err
	}
	if p.Accounting == nil || p.State != "active" || !digestPattern.MatchString(input.EvidenceDigest) || p.Accounting.Stage >= 3 {
		return "", errors.New("active staged budget and evidence required")
	}
	p.Accounting.Stage++
	if err = k.allocateAccounting(&p, big.NewInt(0)); err != nil {
		return "", err
	}
	return p.ID, put(k.Store, "project/"+p.ID, p)
}

func (k Keeper) reserveTask(p *Project, t *Task) error {
	if p.Accounting == nil {
		return nil
	}
	if t.RewardPolicy != "" || t.BudgetReserved != "" {
		return errors.New("reward policy is chain-managed")
	}
	if t.VerifiersRequired == 0 {
		t.VerifiersRequired = 2
	}
	if t.VerifiersRequired < 1 || t.VerifiersRequired > 20 {
		return errors.New("verifier count out of bounds")
	}
	amount, err := money(t.CreditReward)
	if err != nil {
		return err
	}
	if amount.Cmp(big.NewInt(t.KarmaReward)) != 0 {
		return errors.New("work Karma and credit price must agree")
	}
	allocated, err := money(p.Accounting.Allocated)
	if err != nil {
		return err
	}
	if allocated.Sign() == 0 {
		if t.KarmaReward > 100 {
			return errors.New("unbudgeted task price exceeds 100")
		}
		t.BudgetReserved = "0"
		if p.MembershipPolicy == MembershipPolicy {
			// An unbudgeted task changes no project balance. Avoid rewriting
			// its potentially large prior-art record under the new policy.
			t.RewardPolicy = CreditRewardPolicy
			return nil
		}
	} else {
		budget, err := money(p.Budget)
		if err != nil {
			return err
		}
		reserved, err := money(p.Accounting.Reserved)
		if err != nil {
			return err
		}
		reserved.Add(reserved, amount)
		if budget.Cmp(reserved) < 0 {
			return errors.New("task price exceeds unlocked unreserved budget")
		}
		p.Accounting.Reserved = reserved.String()
		t.BudgetReserved = amount.String()
	}
	t.RewardPolicy = CreditRewardPolicy
	return put(k.Store, "project/"+p.ID, p)
}

func (k Keeper) settleBudget(p *Project, t *Task, reward *big.Int) error {
	if p.Accounting == nil {
		return errors.New("missing accounting policy")
	}
	if t.BudgetReserved == "0" {
		return nil
	}
	reserved, err := money(p.Accounting.Reserved)
	if err != nil {
		return err
	}
	price, err := money(t.BudgetReserved)
	if err != nil {
		return err
	}
	if reserved.Cmp(price) < 0 || reward.Cmp(price) > 0 {
		return errors.New("task reservation inconsistent")
	}
	spent, err := money(p.Accounting.Spent)
	if err != nil {
		return err
	}
	unlocked, err := money(p.Accounting.Unlocked)
	if err != nil {
		return err
	}
	spent.Add(spent, reward)
	if spent.Cmp(unlocked) > 0 {
		return errors.New("budget overspent")
	}
	p.Accounting.Reserved = new(big.Int).Sub(reserved, price).String()
	t.BudgetReserved = "0"
	p.Accounting.Spent = spent.String()
	p.Budget = new(big.Int).Sub(unlocked, spent).String()
	return put(k.Store, "project/"+p.ID, p)
}

// Failed/expired milestones release their reservation without spending it.
func (k Keeper) releaseReservation(t *Task) error {
	if t.RewardPolicy != CreditRewardPolicy || t.BudgetReserved == "0" {
		return nil
	}
	p, err := k.projectState(t.Project)
	if err != nil {
		return err
	}
	return k.settleBudget(&p, t, big.NewInt(0))
}

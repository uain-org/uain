package federation

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"regexp"
	"strings"
	"time"
)

func validateMember(m Member) error {
	if m.AccountPolicy != "" || m.MetadataDigest != "" {
		return errors.New("genesis/enrolment account metadata is chain-managed")
	}
	key, e := base64.RawURLEncoding.DecodeString(m.PublicKey)
	if e != nil || !validNativeEd25519Key(key) || Address(key) != m.ID {
		return errors.New("invalid member identity")
	}
	if len(strings.TrimSpace(m.Name)) < 2 || len(m.Name) > 120 || len(strings.TrimSpace(m.Operator)) < 2 || len(m.Operator) > 200 || len(m.Family) > 100 {
		return errors.New("invalid member metadata")
	}
	if m.Licence != "active" && m.Licence != "pending" && m.Licence != "revoked" && m.Licence != "withdrawn" {
		return errors.New("invalid licence state")
	}
	if m.Karma <= -10 && m.Licence == "active" {
		return errors.New("active member below revocation threshold")
	}
	// Strikes are chain-managed (KarmaPolicyV2); no new member starts with any.
	if m.Strikes != 0 {
		return errors.New("strikes are chain-managed")
	}
	if m.ActiveProjects < 0 {
		return errors.New("invalid project count")
	}
	_, e = money(m.Credits)
	return e
}
func (k Keeper) Validate(env Envelope) error {
	c := env.Command
	m, e := k.Member(c.Member)
	if c.Operation == "enrol" {
		if c.Instance != "" {
			return errors.New("enrolment cannot impersonate an existing instance")
		}
		if e == nil {
			return errors.New("identity already enrolled")
		}
		if c.Sequence != 0 {
			return errors.New("enrolment sequence must be zero")
		}
		return nil
	}
	if e != nil {
		return e
	}
	if m.PublicKey != env.PublicKey {
		return errors.New("member key mismatch")
	}
	if m.Sequence != c.Sequence || m.Sequence == math.MaxUint64 {
		return errors.New("wrong or exhausted sequence")
	}
	if m.Licence != "active" {
		return errors.New("member has no active licence")
	}
	return k.validateInstance(c.Member, c.Instance)
}
func (k Keeper) Execute(raw []byte, chain string, height int64, now time.Time) (string, error) {
	k.height = height
	env, e := Authenticate(raw, chain, height)
	if e != nil {
		return "", e
	}
	if e = k.Validate(env); e != nil {
		return "", e
	}
	c := env.Command
	quotaKey := fmt.Sprintf("quota/%s", c.Member)
	var quota struct {
		Height int64 `json:"height"`
		Count  int   `json:"count"`
	}
	_ = get(k.Store, quotaKey, &quota)
	if quota.Height == height && quota.Count >= 100 {
		return "", errors.New("member block quota exceeded")
	}
	transition := k
	active, err := k.CompactStorageActive(height)
	if err != nil {
		return "", err
	}
	if active {
		transition.Store = &transitionReads{Store: k.Store, values: map[string][]byte{}}
	}
	subject, e := transition.apply(env, height, now)
	if e != nil {
		return "", e
	}
	k = transition
	// Reload: applying a command may change the signing member's Karma/licence.
	m, e := k.Member(c.Member)
	if e != nil {
		return "", e
	}
	m.Sequence = c.Sequence + 1
	if e = put(k.Store, "member/"+m.ID, m); e != nil {
		return "", e
	}
	if quota.Height != height {
		quota.Height = height
		quota.Count = 0
	}
	quota.Count++
	if e = put(k.Store, quotaKey, quota); e != nil {
		return "", e
	}
	var id uint64
	if k.Store.Get([]byte("event_count")) != nil {
		if e = get(k.Store, "event_count", &id); e != nil {
			return "", e
		}
	}
	if id == math.MaxUint64 {
		return "", errors.New("event ID exhausted")
	}
	id++
	b, e := SigningBytes(c)
	if e != nil {
		return "", e
	}
	digest := sha256.Sum256(b)
	event := Event{ID: id, Height: height, Member: c.Member, Instance: c.Instance, Operation: c.Operation, Subject: subject, CommandDigest: hex.EncodeToString(digest[:])}
	if e = put(k.Store, fmt.Sprintf("event/%020d", id), event); e != nil {
		return "", e
	}
	if e = put(k.Store, "event_count", id); e != nil {
		return "", e
	}
	if reads, ok := k.Store.(*transitionReads); ok {
		reads.flush()
	}
	return subject, nil
}
func (k Keeper) apply(env Envelope, height int64, now time.Time) (string, error) {
	c := env.Command
	if err := k.legacyGuard(c); err != nil {
		return "", err
	}
	switch c.Operation {
	case "guardian_propose":
		return k.guardianPropose(c, height)
	case "guardian_consent":
		return k.guardianApprove(c, height, true)
	case "guardian_vote":
		return k.guardianApprove(c, height, false)
	case "guardian_execute":
		return k.guardianExecute(c, height)
	case "activate_consensus_v2":
		return k.activateConsensusV2(c, height)
	case "guardian_action_propose", "guardian_action_approve", "validator_set_update", "upgrade_schedule":
		if !k.consensusV2() {
			return "", errUnsupportedOperation
		}
	case "central_task_states_configure", "central_contest_select", "central_contest_settle", "central_condition_resolve", "central_condition_expire":
		// Unknown before central-task-states-v1 activation; the marker read is unmetered.
		if _, on, err := k.centralTaskStates(height); err != nil || !on {
			return "", errUnsupportedOperation
		}
	}
	switch c.Operation {
	case "guardian_action_propose":
		return k.guardianActionPropose(c, height, now)
	case "guardian_action_approve":
		return k.guardianActionApprove(c, height, now)
	case "validator_set_update":
		return k.updateValidatorSet(c, height)
	case "upgrade_schedule":
		return k.scheduleUpgrade(c, height)
	case "funding_review_restart":
		return k.restartFundingReview(c, height)
	case "funding_observers_rotate":
		return k.rotateFundingObservers(c, height)
	case "funding_reward_release":
		return k.releaseFundingReward(c, height)
	case "funding_reward_schedule":
		return k.scheduleFundingReward(c, height)
	case "funding_reward_claim":
		return k.claimFundingReward(c, height, now)
	case "funding_reward_forfeit":
		return k.forfeitFundingReward(c, height)
	case "fiat_beneficiary_bind":
		return k.bindFiatBeneficiary(c, height)
	case "fiat_beneficiary_attest":
		return k.attestFiatBeneficiary(c, height)
	case "fiat_beneficiary_unbind":
		return k.unbindFiatBeneficiary(c, height)
	case "external_bounty_quote":
		return k.quoteExternalBounty(c, height)
	case "external_bounty_intent":
		return k.intentExternalBounty(c, height)
	case "external_bounty_attest":
		return k.attestExternalBounty(c, height)
	case "external_bounty_release":
		return k.releaseExternalBounty(c, height)
	case "external_wallet_bind":
		return k.bindExternalWallet(c, height)
	case "external_wallet_unbind":
		return k.unbindExternalWallet(c, height)
	case "activate_funding":
		return k.activateFunding(c, height)
	case "treasury_escrow_bind":
		return k.bindTreasuryEscrow(c, height)
	case "treasury_escrow_approve":
		return k.approveTreasuryEscrow(c, height)
	case "funding_campaign":
		return k.fundingCampaign(c, height)
	case "human_bank_end":
		return k.humanBankEnd(c, height)
	case "human_bank_bind":
		return k.humanBankBind(c, height)
	case "human_bank_attest":
		return k.humanBankAttest(c, height)
	case "human_funding_file":
		return k.humanFundingFile(c, height)
	case "human_funding_refund":
		return k.humanFundingRefund(c, height)
	case "funding_file":
		return k.fileFunding(c, height)
	case "funding_attest":
		return k.attestFunding(c, height)
	case "funding_refund":
		return k.refundFunding(c, height)
	case "skill_manager_appoint":
		return k.skillManagerAppoint(c, height)
	case "skill_test_define":
		return k.skillTestDefine(c, height)
	case "skill_attempt":
		return k.skillAttempt(c, height)
	case "skill_grade":
		return k.skillGrade(c, height)
	case "resource_offer":
		return k.resourceOffer(c, height)
	case "resource_withdraw":
		return k.resourceWithdraw(c)
	case "resource_accept":
		return k.resourceAccept(c, height)
	case "resource_receipt":
		return k.resourceReceipt(c, height)
	case "resource_acknowledge":
		return k.resourceAcknowledge(c, height)
	case "activate_research_proceedings":
		return k.activateResearchProceedings(c, height)
	case "close_arbitration":
		return k.closeArbitration(c, height, now)
	case "appeal_arbitration":
		return k.appealArbitration(c, height, now)
	case "resolve_appeal":
		return k.resolveAppeal(c, height, now)
	case "legacy_adopt":
		return k.legacyAdopt(c)
	case "legacy_begin":
		return k.legacyBegin(c)
	case "legacy_page":
		return k.legacyPage(c)
	case "legacy_finish":
		return k.legacyFinish(c)
	case "legacy_claim_account":
		return k.legacyClaimAccount(c)
	case "legacy_bootstrap_census_page":
		return k.legacyBootstrapCensusPage(c)
	case "legacy_join":
		return k.legacyJoin(c, now)
	case "legacy_submit":
		return k.legacySubmit(c, now)
	case "legacy_task_open":
		return k.legacyTaskOpen(c, now)
	case "operations_intent":
		return k.operationsIntent(c, height)
	case "operations_attest":
		return k.operationsAttest(c, height)
	case "operations_review_restart":
		return k.operationsReviewRestart(c, height)
	case "legacy_budget_allocate":
		return k.legacyBudgetChange(c, now, false)
	case "legacy_budget_unlock":
		return k.legacyBudgetChange(c, now, true)
	case "legacy_project_done_when":
		return k.legacyProjectDoneWhen(c, now)
	case "legacy_task_price":
		return k.legacyTaskPrice(c, now)
	case "legacy_task_close":
		return k.legacyTaskClose(c, now)
	case "legacy_future_apply":
		return k.legacyFutureApply(c, now)
	case "legacy_kpi_set":
		return k.legacyKPISet(c, now)
	case "legacy_kpi_expire":
		return k.legacyKPIExpire(c, now)
	case "legacy_challenge":
		return k.legacyChallengeFile(c, now, "")
	case "legacy_prior_art_challenge":
		return k.legacyChallengeFile(c, now, "prior_art")
	case "legacy_benevolence_flag":
		return k.legacyChallengeFile(c, now, "benevolence")
	case "legacy_challenge_decide":
		return k.legacyChallengeDecide(c, now, "")
	case "legacy_prior_art_decide":
		return k.legacyChallengeDecide(c, now, "prior_art")
	case "legacy_benevolence_decide":
		return k.legacyChallengeDecide(c, now, "benevolence")
	case "legacy_kpi_resolve":
		return k.legacyResolveKPI(c, now)
	case "legacy_claim_assert", "legacy_claim_create":
		return k.legacyClaimWrite(c, now, false)
	case "legacy_claim_edit":
		return k.legacyClaimWrite(c, now, true)
	case "legacy_claim_review":
		return k.legacyClaimReview(c, now)
	case "legacy_check":
		return k.legacyCheck(c, now)
	case "legacy_settle":
		return k.legacySettle(c, now)
	case "legacy_release":
		return k.legacyRelease(c, now)
	case "activate_arbitration":
		return k.activateArbitration(c, height)
	case "arbitrate":
		return k.arbitrate(c, height, now)
	case "activate_recipient_history":
		return k.activateRecipientHistory(c, height)
	case "recipient_history_page":
		return k.advanceRecipientHistory(c, height)
	case "central_fund_configure", "central_fund_plan", "central_fund_plan_review", "central_fund_apply", "central_fund_decide", "central_fund_close":
		return k.centralFundTransition(c, height)
	case "central_earning_activate", "central_reviewer_replace", "central_project_start", "central_task_open", "central_task_fund", "central_submit", "central_review",
		"central_evidence_activate", "central_reassess", "central_evidence_expire", "central_hardening_activate",
		"central_task_states_activate", "central_task_states_configure", "central_contest_select", "central_contest_settle", "central_condition_resolve", "central_condition_expire":
		return k.centralEarning(c, height, now)
	case "karma_policy_activate":
		return k.karmaPolicyActivate(c, height)
	case "karma_central_backfill":
		return k.karmaCentralBackfill(c, height, now)
	case "karma_penalty_convert":
		return k.karmaPenaltyConvert(c, height, now)
	case "activate_coin":
		return k.activateCoin(c, height)
	case "coin_quote":
		return k.quoteCoin(c, height)
	case "coin_reserve":
		return k.reserveCoin(c, height)
	case "coin_claim":
		return k.claimCoin(c, height)
	case "coin_release":
		return k.releaseCoin(c, height)
	case "coin_shield":
		return k.coinBoundary(c, height, "shield")
	case "coin_exit":
		return k.coinBoundary(c, height, "exit")
	case "activate_private_exchange":
		return k.activatePrivateExchange(c, height)
	case "private_reviewer":
		return k.appointPrivateReviewer(c)
	case "dividend_spent_rebuild":
		return k.rebuildDividendSpent(c)
	case "private_payment":
		return k.privatePayment(c, height)
	case "activate_operator_census":
		return k.activateOperatorCensus(c, height)
	case "operator_census_page":
		return k.advanceOperatorCensus(c, height)
	case "activate_operator_rewards":
		return k.activateOperatorRewards(c, height)
	case "research_standing":
		return k.recordResearchStanding(c, height)
	case "activate_storage":
		return k.activateStorage(c, height)
	case "identity_claim":
		return k.claimIdentity(c, now)
	case "identity_import":
		return k.importIdentity(c, now)
	case "operator_claim":
		return k.claimOperator(c, now)
	case "operator_attest":
		return k.attestOperator(c, now)
	case "activate_membership":
		return k.activateMembership(c, height)
	case "project_join":
		return k.joinProject(c)
	case "arbiter_appoint":
		return k.appointArbiter(c)
	case "challenge_prior_art":
		return k.challengePriorArt(c)
	case "decide_prior_art":
		return k.decidePriorArt(c)
	case "instance_create":
		return k.createInstance(c)
	case "instance_state":
		return k.instanceState(c)
	case "enrol":
		var p struct {
			Name     string `json:"name"`
			Operator string `json:"operator"`
			Family   string `json:"family"`
		}
		if e := Decode(c.Payload, &p); e != nil {
			return "", e
		}
		m := Member{ID: c.Member, PublicKey: env.PublicKey, Name: p.Name, Operator: p.Operator, Family: p.Family, Licence: "pending", Credits: "0"}
		if e := validateMember(m); e != nil {
			return "", e
		}
		return m.ID, put(k.Store, "member/"+m.ID, m)
	case "licence":
		if !k.guardian(c.Member) {
			return "", errors.New("guardian approval required")
		}
		var p struct {
			Member         string `json:"member"`
			Status         string `json:"status"`
			EvidenceDigest string `json:"evidence_digest"`
		}
		if e := Decode(c.Payload, &p); e != nil {
			return "", e
		}
		m, e := k.Member(p.Member)
		if e != nil {
			return "", e
		}
		if !digestPattern.MatchString(p.EvidenceDigest) {
			return "", errors.New("screening or revocation evidence required")
		}
		if p.Status != "active" && p.Status != "revoked" {
			return "", errors.New("invalid licence action")
		}
		// Strikes are zero before KarmaPolicyV2; after it, 10 strikes end a licence.
		if m.Licence == "withdrawn" || m.Licence == "revoked" || m.Karma <= -10 || m.Strikes >= StrikeRevocationLimit {
			return "", errors.New("licence is permanently ended")
		}
		if p.Status == "revoked" {
			if err := k.guardianManualExit(m.ID); err != nil {
				return "", err
			}
		}
		m.Licence = p.Status
		return m.ID, put(k.Store, "member/"+m.ID, m)
	case "roles":
		if !k.guardian(c.Member) {
			return "", errors.New("guardian approval required")
		}
		var p struct {
			Member          string `json:"member"`
			DefaultVerifier bool   `json:"default_verifier"`
			Creator         bool   `json:"creator"`
			EvidenceDigest  string `json:"evidence_digest"`
		}
		if e := Decode(c.Payload, &p); e != nil {
			return "", e
		}
		m, e := k.Member(p.Member)
		if e != nil {
			return "", e
		}
		if m.Licence != "active" || !digestPattern.MatchString(p.EvidenceDigest) {
			return "", errors.New("roles need active member and appointment evidence")
		}
		m.DefaultVerifier = p.DefaultVerifier
		m.Creator = p.Creator
		return m.ID, put(k.Store, "member/"+m.ID, m)
	case "withdraw":
		var p struct{}
		if e := Decode(c.Payload, &p); e != nil {
			return "", e
		}
		m, e := k.Member(c.Member)
		if e != nil {
			return "", e
		}
		if err := k.guardianManualExit(m.ID); err != nil {
			return "", err
		}
		m.Licence = "withdrawn"
		return m.ID, put(k.Store, "member/"+m.ID, m)
	case "open_project":
		var p struct {
			ID       string   `json:"id"`
			Title    string   `json:"title"`
			Class    string   `json:"class"`
			PriorArt PriorArt `json:"prior_art"`
		}
		if e := Decode(c.Payload, &p); e != nil {
			return "", e
		}
		m, e := k.Member(c.Member)
		if e != nil {
			return "", e
		}
		if !m.Creator && (m.Karma < 1000 || m.ActiveProjects >= 1+(m.Karma-1000)/10) {
			return "", errors.New("project Karma gate or allowance")
		}
		if !validID(p.ID) || len(p.Title) < 5 || len(p.Title) > 250 || !allowedClass(p.Class) || !basis(p.PriorArt) {
			return "", errors.New("project needs valid metadata, permitted class and prior art")
		}
		if k.Store.Get([]byte("project/"+p.ID)) != nil {
			return "", errors.New("project already exists")
		}
		if m.ActiveProjects == math.MaxInt64 {
			return "", errors.New("project count exhausted")
		}
		m.ActiveProjects++
		if e = put(k.Store, "member/"+m.ID, m); e != nil {
			return "", e
		}
		project := Project{ID: p.ID, Lead: m.ID, LeadInstance: c.Instance, Title: p.Title, Class: p.Class, PriorArt: p.PriorArt, State: "active", Budget: "0", Accounting: initialAccounting()}
		project.MembershipPolicy, e = k.membershipPolicy(height)
		if e != nil {
			return "", e
		}
		if project.MembershipPolicy != "" {
			if e = k.addParticipation(project.ID, c.Member, c.Instance); e != nil {
				return "", e
			}
		}
		project.StoragePolicy, e = k.storagePolicy(height)
		if e != nil {
			return "", e
		}
		project.OperatorPolicy, e = k.operatorRewardPolicy(height)
		if e != nil {
			return "", e
		}
		return p.ID, k.createProject(project)
	case "project_state":
		var p struct {
			Project string `json:"project"`
			State   string `json:"state"`
		}
		if e := Decode(c.Payload, &p); e != nil {
			return "", e
		}
		project, e := k.projectState(p.Project)
		if e != nil {
			return "", e
		}
		if project.Lead != c.Member {
			return "", errors.New("only project lead changes lifecycle")
		}
		if p.State != "halted" && p.State != "complete" && p.State != "active" {
			return "", errors.New("invalid project state")
		}
		if project.State == p.State {
			return "", errors.New("project already in state")
		}
		m, e := k.Member(c.Member)
		if e != nil {
			return "", e
		}
		if p.State == "active" {
			if project.SafetyHalted {
				return "", errors.New("upheld safety decision prevents reopening")
			}
			if !m.Creator && (m.Karma < 1000 || m.ActiveProjects >= 1+(m.Karma-1000)/10) {
				return "", errors.New("reopening exceeds allowance")
			}
			m.ActiveProjects++
		} else if project.State == "active" {
			if m.ActiveProjects == 0 {
				return "", errors.New("project count inconsistent")
			}
			m.ActiveProjects--
		}
		project.State = p.State
		if e = put(k.Store, "member/"+m.ID, m); e != nil {
			return "", e
		}
		return project.ID, put(k.Store, "project/"+project.ID, project)
	case "allocate_budget":
		if !k.guardian(c.Member) {
			return "", errors.New("guardian allocation required")
		}
		var p struct {
			Project        string `json:"project"`
			Credits        string `json:"credits"`
			EvidenceDigest string `json:"evidence_digest"`
		}
		if e := Decode(c.Payload, &p); e != nil {
			return "", e
		}
		project, e := k.projectState(p.Project)
		if e != nil {
			return "", e
		}
		amount, e := money(p.Credits)
		if e != nil || amount.Sign() == 0 || !digestPattern.MatchString(p.EvidenceDigest) {
			return "", errors.New("positive accounting allocation and evidence required")
		}
		if project.Accounting != nil {
			if project.State != "active" {
				return "", errors.New("allocation needs active project")
			}
			if e = k.allocateAccounting(&project, amount); e != nil {
				return "", e
			}
			return project.ID, put(k.Store, "project/"+project.ID, project)
		}
		budget, e := money(project.Budget)
		if e != nil {
			return "", e
		}
		budget.Add(budget, amount)
		if len(budget.String()) > 78 {
			return "", errors.New("budget overflow")
		}
		project.Budget = budget.String()
		return project.ID, put(k.Store, "project/"+project.ID, project)
	case "unlock_budget":
		return k.unlockBudget(c)
	case "release_deferred":
		return k.releaseDeferred(c, now)
	case "open_task":
		return k.openTask(c, now)
	case "submit":
		return k.submit(c, height, now)
	case "verify":
		return k.verify(c, now)
	case "kpi_set":
		return k.setKPI(c, now)
	case "resolve_kpi":
		return k.resolveKPI(c, now, height)
	case "flag":
		var p struct {
			ID             string `json:"id"`
			Project        string `json:"project"`
			EvidenceDigest string `json:"evidence_digest"`
		}
		if e := Decode(c.Payload, &p); e != nil {
			return "", e
		}
		if _, e := k.projectState(p.Project); e != nil {
			return "", e
		}
		project, err := k.projectState(p.Project)
		if err != nil {
			return "", err
		}
		if err = k.requireParticipation(project, c); err != nil {
			return "", err
		}
		if project.SafetyHalted {
			return "", errors.New("project already has an upheld safety decision")
		}
		if !validID(p.ID) || !digestPattern.MatchString(p.EvidenceDigest) || k.Store.Get([]byte("flag/"+p.ID)) != nil {
			return "", errors.New("invalid or existing flag")
		}
		flag := Flag{ID: p.ID, Project: p.Project, Reporter: c.Member, EvidenceDigest: p.EvidenceDigest, State: "open"}
		return p.ID, put(k.Store, "flag/"+p.ID, flag)
	case "decide_flag":
		return k.decideFlag(c, now)
	default:
		return "", errors.New("unsupported federation operation")
	}
}
func (k Keeper) openTask(c Command, now time.Time) (string, error) {
	var t Task
	if e := Decode(c.Payload, &t); e != nil {
		return "", e
	}
	p, e := k.projectState(t.Project)
	if e != nil {
		return "", e
	}
	if p.Lead != c.Member || p.State != "active" {
		return "", errors.New("task needs active project lead")
	}
	if e = k.requireParticipation(p, c); e != nil {
		return "", e
	}
	if !validID(t.ID) || len(t.Title) < 5 || len(t.Title) > 250 || !allowedClass(t.Class) || !basis(t.PriorArt) || len(t.Criteria) < 40 || len(t.Criteria) > 4000 {
		return "", errors.New("task metadata, prior art or verification criteria invalid")
	}
	if t.KarmaReward < 0 || t.KarmaReward > MaxReward {
		return "", errors.New("Karma reward out of bounds")
	}
	if _, e = money(t.CreditReward); e != nil {
		return "", e
	}
	if t.State != "" || t.Winner != "" || len(t.Submissions) > 0 || t.OpenedByInstance != "" || t.RewardPolicy != "" || t.BudgetReserved != "" || len(t.OpenChallenges) > 0 || t.PriorArtDecision != "" || t.StoragePolicy != "" || t.MetadataDigest != "" {
		return "", errors.New("task state is chain-managed")
	}
	if t.Kind != "instant" && t.Kind != "future" {
		return "", errors.New("invalid task kind")
	}
	if t.Kind == "future" && t.KPI == nil {
		return "", errors.New("future task needs a KPI")
	}
	if t.KPI != nil {
		if e = validateKPI(t.KPI, now); e != nil {
			return "", e
		}
	}
	if k.Store.Get([]byte("task/"+t.ID)) != nil {
		return "", errors.New("task already exists")
	}
	t.StoragePolicy = p.StoragePolicy
	if e = k.reserveTask(&p, &t); e != nil {
		return "", e
	}
	t.State = "open"
	t.OpenedByInstance = c.Instance
	t.Submissions = []string{}
	if e = k.scheduleKPI(t); e != nil {
		return "", e
	}
	return t.ID, k.createTask(t)
}
func (k Keeper) submit(c Command, height int64, now time.Time) (string, error) {
	var p struct {
		ID             string `json:"id"`
		Task           string `json:"task"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &p); e != nil {
		return "", e
	}
	t, e := k.taskState(p.Task)
	if e != nil {
		return "", e
	}
	project, e := k.projectState(t.Project)
	if e != nil {
		return "", e
	}
	if e = k.requireParticipation(project, c); e != nil {
		return "", e
	}
	if t.State != "open" || project.State != "active" || len(t.Submissions) >= 20 {
		return "", errors.New("task closed or submission limit reached")
	}
	if t.Kind == "future" && t.KPI != nil && deadlineDue(t.KPI.ResolvesBy, now) {
		return "", errors.New("KPI date passed; no new submissions")
	}
	if !validID(p.ID) || !digestPattern.MatchString(p.EvidenceDigest) || k.Store.Get([]byte("contribution/"+p.ID)) != nil {
		return "", errors.New("invalid or duplicate submission")
	}
	if project.MembershipPolicy == MembershipPolicy {
		if k.Store.Get([]byte("task_author/"+t.ID+"/"+c.Member)) != nil {
			return "", errors.New("member already submitted")
		}
	} else {
		for _, id := range t.Submissions {
			v, e := k.contributionState(id)
			if e != nil {
				return "", e
			}
			if v.Author == c.Member {
				return "", errors.New("member already submitted")
			}
		}
	}
	v := Contribution{ID: p.ID, Task: t.ID, Author: c.Member, AuthorInstance: c.Instance, EvidenceDigest: p.EvidenceDigest, State: "held", Verifications: []Verification{}, MembershipPolicy: project.MembershipPolicy, StoragePolicy: project.StoragePolicy}
	policy, e := k.arbitrationPolicy(height)
	if e != nil {
		return "", e
	}
	if policy != "" && project.StoragePolicy == CompactStatePolicy && project.OperatorPolicy == OperatorRewardPolicy {
		v.ArbitrationPolicy = policy
		if e = k.assignResearchProceedings(&v, height); e != nil {
			return "", e
		}
	}
	t.Submissions = append(t.Submissions, p.ID)
	if e = put(k.Store, "task/"+t.ID, t); e != nil {
		return "", e
	}
	if project.MembershipPolicy == MembershipPolicy {
		if e = put(k.Store, "task_author/"+t.ID+"/"+c.Member, v.ID); e != nil {
			return "", e
		}
	}
	return p.ID, put(k.Store, "contribution/"+p.ID, v)
}
func (k Keeper) verify(c Command, now time.Time) (string, error) {
	var p struct {
		Contribution   string   `json:"contribution"`
		Verdict        string   `json:"verdict"`
		Novelty        string   `json:"novelty"`
		Searches       []string `json:"searches"`
		EvidenceDigest string   `json:"evidence_digest"`
		KnownSource    string   `json:"known_source"`
	}
	if e := Decode(c.Payload, &p); e != nil {
		return "", e
	}
	v, e := k.contributionState(p.Contribution)
	if e != nil {
		return "", e
	}
	t, e := k.taskState(v.Task)
	if e != nil {
		return "", e
	}
	project, e := k.projectState(t.Project)
	if e != nil {
		return "", e
	}
	m, e := k.Member(c.Member)
	if e != nil {
		return "", e
	}
	if e = k.requireParticipation(project, c); e != nil {
		return "", e
	}
	if v.Author == c.Member {
		return "", errors.New("same member cannot verify")
	}
	if !m.DefaultVerifier && m.Karma < 100 {
		return "", errors.New("verification needs 100 Karma")
	}
	if project.MembershipPolicy != "" && !m.DefaultVerifier {
		if k.Store.Get([]byte("task_author/"+t.ID+"/"+c.Member)) != nil {
			return "", errors.New("a task author cannot check another answer to the same task")
		}
	}
	if v.State != "held" || (t.State != "open" && t.State != "kpi_met") || project.State != "active" {
		return "", errors.New("work is closed, contested or already verified")
	}
	if t.Kind == "future" && t.State == "open" && kpiExpired(t.KPI, now) {
		return "", errors.New("unresolved KPI expired")
	}
	if t.RewardPolicy == CreditRewardPolicy {
		if p.Verdict == "partial" {
			p.Verdict = "dispute"
		}
		if p.Novelty == "known" && !kpiSource(p.KnownSource) {
			return "", errors.New("known novelty needs a public source")
		}
	}
	if (p.Verdict != "confirm" && p.Verdict != "dispute") || (p.Novelty != "new" && p.Novelty != "known") || !digestPattern.MatchString(p.EvidenceDigest) {
		return "", errors.New("invalid verdict, novelty or evidence")
	}
	if !basis(PriorArt{Basis: strings.Repeat("x", 40), Searches: p.Searches}) {
		return "", errors.New("novelty needs distinct searches")
	}
	reconsiders, e := k.reconsideredDispute(v, m, c.Instance, p.Verdict)
	if e != nil {
		return "", e
	}
	for _, check := range v.Verifications {
		if check.Member == c.Member {
			if reconsiders == "" || check.RecordDigest != reconsiders {
				return "", errors.New("member already verified")
			}
		}
	}
	limit := 20
	if v.ArbitrationPolicy == ArbitrationPolicy && m.DefaultVerifier && p.Verdict == "confirm" && k.Store.Get([]byte("arbitration/"+v.ID)) != nil {
		limit = MaxArbitrationChecks
		if v.ResearchPolicy == ResearchProceedingsPolicy {
			limit = MaxProceedingChecks
		}
	}
	if len(v.Verifications) >= limit {
		return "", errors.New("verification limit")
	}
	check := Verification{Member: c.Member, Instance: c.Instance, Verdict: p.Verdict, Novelty: p.Novelty, Searches: p.Searches, EvidenceDigest: p.EvidenceDigest, KnownSource: p.KnownSource}
	check.Reconsiders = reconsiders
	if v.StoragePolicy == CompactStatePolicy {
		check, e = k.storeVerification(v.ID, check)
		if e != nil {
			return "", e
		}
	}
	v.Verifications = append(v.Verifications, check)
	if p.Verdict == "dispute" {
		v.State = "contested"
	}
	if e = put(k.Store, "contribution/"+v.ID, v); e != nil {
		return "", e
	}
	if t.RewardPolicy == CreditRewardPolicy {
		return v.ID, k.settlePending(t, now)
	}
	return v.ID, k.maybeSettle(v, t, now)
}
func (k Keeper) maybeSettle(v Contribution, t Task, now time.Time) error {
	if t.RewardPolicy == CreditRewardPolicy {
		return k.settleCredits(v, t, now)
	}
	if v.State != "held" && v.State != "verified" {
		return nil
	}
	p, e := k.projectState(t.Project)
	if e != nil {
		return e
	}
	author, e := k.Member(v.Author)
	if e != nil {
		return e
	}
	if p.State != "active" || author.Licence != "active" {
		return nil
	}
	authorFamily, authorActive, e := k.actorFamily(author, v.AuthorInstance)
	if e != nil {
		return e
	}
	if !authorActive {
		return nil
	}
	// One standing known-result attestation prevents an award. Additional new
	// attestations must never outvote already discovered public prior art.
	for _, check := range v.Verifications {
		if check.Verdict == "confirm" && check.Novelty == "known" {
			v.State = "withheld"
			v.AwardWithheld = "known"
			return put(k.Store, "contribution/"+v.ID, v)
		}
	}
	operators := map[string]bool{}
	hasDefault := false
	otherFamily := false
	for _, check := range v.Verifications {
		m, e := k.Member(check.Member)
		if e != nil {
			return e
		}
		if m.Licence != "active" || m.ID == author.ID || normaliseOperator(m.Operator) == normaliseOperator(author.Operator) || check.Verdict != "confirm" || check.Novelty != "new" {
			continue
		}
		family, active, err := k.actorFamily(m, check.Instance)
		if err != nil {
			return err
		}
		if !active {
			continue
		}
		operator := normaliseOperator(m.Operator)
		if operator == "" {
			continue
		}
		operators[operator] = true
		hasDefault = hasDefault || m.DefaultVerifier
		otherFamily = otherFamily || (family != "" && authorFamily != "" && family != authorFamily)
	}
	if len(operators) < 2 || !hasDefault || !otherFamily {
		return nil
	}
	if t.Kind == "future" && t.State != "kpi_met" {
		v.State = "verified"
		return put(k.Store, "contribution/"+v.ID, v)
	}
	if t.Winner != "" {
		return errors.New("task already settled")
	}
	budget, e := money(p.Budget)
	if e != nil {
		return e
	}
	reward, e := money(t.CreditReward)
	if e != nil {
		return e
	}
	if budget.Cmp(reward) < 0 {
		return errors.New("project has insufficient accounting budget")
	}
	if e = k.recordKarma(author.ID, v.AuthorInstance, t.KarmaReward, "legacy_settlement", v.ID, now); e != nil {
		return e
	}
	if e = k.credit(author.ID, v.AuthorInstance, v.ID, "legacy_work", reward, now, true, ""); e != nil {
		return e
	}
	p.Budget = new(big.Int).Sub(budget, reward).String()
	t.Winner = v.ID
	t.State = "settled"
	v.State = "settled"
	if e = put(k.Store, "project/"+p.ID, p); e != nil {
		return e
	}
	if e = put(k.Store, "task/"+t.ID, t); e != nil {
		return e
	}
	return put(k.Store, "contribution/"+v.ID, v)
}

var operatorSeparators = regexp.MustCompile(`[^a-z0-9]+`)
var operatorSuffixes = regexp.MustCompile(`\b(inc|ltd|llc|gmbh|bv|ag|sa|plc|corp|corporation|co|company|limited)\b`)

// Preserve the existing federation's declared-name comparison. This is still
// a declaration; verified operator-domain attestations remain a separate gate.
func normaliseOperator(s string) string {
	s = operatorSeparators.ReplaceAllString(strings.ToLower(s), " ")
	s = operatorSuffixes.ReplaceAllString(s, " ")
	return strings.ReplaceAll(s, " ", "")
}
func (k Keeper) resolveKPI(c Command, now time.Time, height int64) (string, error) {
	var p struct {
		Task           string          `json:"task"`
		Observed       json.RawMessage `json:"observed"`
		Source         string          `json:"source"`
		Note           string          `json:"note"`
		EvidenceDigest string          `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &p); e != nil {
		return "", e
	}
	t, e := k.taskState(p.Task)
	if e != nil {
		return "", e
	}
	m, e := k.Member(c.Member)
	if e != nil {
		return "", e
	}
	project, e := k.projectState(t.Project)
	if e != nil {
		return "", e
	}
	if !m.DefaultVerifier || m.ID == project.Lead || t.Kind != "future" || t.KPI == nil || t.State != "open" || kpiExpired(t.KPI, now) || !digestPattern.MatchString(p.EvidenceDigest) || !kpiSource(p.Source) || len(strings.TrimSpace(p.Note)) < 20 || len(p.Note) > 2000 {
		return "", errors.New("KPI needs unexpired future task and independent resolver source/note/evidence")
	}
	if e = k.requireParticipation(project, c); e != nil {
		return "", e
	}
	for _, id := range t.Submissions {
		if t.StoragePolicy == CompactStatePolicy {
			if k.Store.Get([]byte("task_author/"+t.ID+"/"+m.ID)) != nil {
				return "", errors.New("resolver contributed to task")
			}
			// Without membership activation, the old author index is absent.
			if project.MembershipPolicy == MembershipPolicy {
				break
			}
		}
		v, e := k.contributionState(id)
		if e != nil {
			return "", e
		}
		if v.Author == m.ID {
			return "", errors.New("resolver contributed to task")
		}
	}
	met, e := observedKPI(t.KPI, p.Observed)
	if e != nil {
		return "", e
	}
	t.State = "kpi_unmet"
	if !met {
		if e = k.releaseReservation(&t); e != nil {
			return "", e
		}
	}
	if met {
		t.State = "kpi_met"
	}
	if e = put(k.Store, "task/"+t.ID, t); e != nil {
		return "", e
	}
	if e = put(k.Store, "kpi_resolution/"+t.ID, map[string]any{"member": c.Member, "height": height, "at": now.UTC().Format(time.RFC3339Nano), "observed": p.Observed, "source": p.Source, "note": p.Note, "evidence_digest": p.EvidenceDigest, "met": met}); e != nil {
		return "", e
	}
	if t.StoragePolicy == CompactStatePolicy {
		if !met {
			return t.ID, nil
		}
		return t.ID, k.settlePending(t, now)
	}
	for _, id := range t.Submissions {
		v, e := k.contributionState(id)
		if e != nil {
			return "", e
		}
		if met {
			if e = k.maybeSettle(v, t, now); e != nil {
				return "", e
			}
			t, e = k.taskState(t.ID)
			if e != nil {
				return "", e
			}
			if t.Winner != "" {
				break
			}
		} else {
			v.State = "withheld"
			if e = put(k.Store, "contribution/"+id, v); e != nil {
				return "", e
			}
		}
	}
	return t.ID, nil
}
func (k Keeper) decideFlag(c Command, now time.Time) (string, error) {
	var p struct {
		Flag           string `json:"flag"`
		Decision       string `json:"decision"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &p); e != nil {
		return "", e
	}
	var f Flag
	if e := get(k.Store, "flag/"+p.Flag, &f); e != nil {
		return "", e
	}
	m, e := k.Member(c.Member)
	if e != nil {
		return "", e
	}
	project, e := k.projectState(f.Project)
	if e != nil {
		return "", e
	}
	if e = k.requireParticipation(project, c); e != nil {
		return "", e
	}
	lead, e := k.Member(project.Lead)
	if e != nil {
		return "", e
	}
	if project.SafetyHalted {
		return "", errors.New("project safety violation already decided")
	}
	if !m.DefaultVerifier || m.ID == lead.ID || m.ID == f.Reporter || normaliseOperator(m.Operator) == normaliseOperator(lead.Operator) || f.State != "open" || !digestPattern.MatchString(p.EvidenceDigest) || (p.Decision != "upheld" && p.Decision != "rejected") {
		return "", errors.New("flag needs independent default verifier and evidence")
	}
	f.State = p.Decision
	f.DecidedBy = m.ID
	if p.Decision == "upheld" {
		if lead.Karma < math.MinInt64+2 {
			return "", errors.New("Karma underflow")
		}
		if e = k.recordKarma(lead.ID, project.LeadInstance, -2, "malevolent", project.ID, now); e != nil {
			return "", e
		}
		lead, e = k.Member(lead.ID)
		if e != nil {
			return "", e
		}
		if lead.Karma <= -10 || lead.Strikes >= StrikeRevocationLimit {
			lead.Licence = "revoked"
		}
		if project.State == "active" {
			if lead.ActiveProjects == 0 {
				return "", errors.New("project count inconsistent")
			}
			lead.ActiveProjects--
		}
		project.State = "halted"
		project.SafetyHalted = true
		if e = put(k.Store, "member/"+lead.ID, lead); e != nil {
			return "", e
		}
		if e = put(k.Store, "project/"+project.ID, project); e != nil {
			return "", e
		}
	}
	return f.ID, put(k.Store, "flag/"+f.ID, f)
}

// JSONRecord is used by the query adapter; consensus state owns the record.
func (k Keeper) JSONRecord(kind, id string) ([]byte, error) {
	if !validID(id) {
		return nil, errors.New("invalid record ID")
	}
	switch kind {
	case "member", "instance", "project", "task", "contribution", "flag", "event", "kpi_resolution", "credit", "credit_owed", "karma", "strike", "accounting_opening", "instance_opening":
	default:
		return nil, errors.New("unknown record type")
	}
	b := k.Store.Get([]byte(kind + "/" + id))
	if b == nil {
		return nil, errors.New("record not found")
	}
	if !json.Valid(b) {
		return nil, errors.New("corrupt record")
	}
	return b, nil
}

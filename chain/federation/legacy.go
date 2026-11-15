package federation

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"
)

// Legacy import is an explicitly approved, independently verified source
// snapshot. Merkle inclusion authenticates the approved bytes; it does not
// turn the source operator's old attestations into new member signatures.
const LegacyImportPolicy = "legacy-preservation-v1"
const MaxLegacyRecordBytes = 16384
const MaxLegacyRecordsPerPage = 16
const MaxLegacyPageValueBytes = 24 * 1024

type LegacyImportState struct {
	Policy          string `json:"policy"`
	ManifestDigest  string `json:"manifest_digest"`
	RecordsRoot     string `json:"records_root"`
	TotalRecords    uint64 `json:"total_records,string"`
	Imported        uint64 `json:"imported,string"`
	Accounts        uint64 `json:"accounts,string"`
	ClaimedAccounts uint64 `json:"claimed_accounts,string"`
	LastKey         string `json:"last_key"`
	Status          string `json:"status"`
}
type LegacyImportRecord struct {
	Key   string   `json:"key"`
	Value string   `json:"value"`
	Proof []string `json:"proof"`
}
type legacySourceInstance struct {
	ID       string `json:"id"`
	Member   string `json:"member"`
	Name     string `json:"name"`
	Family   string `json:"family"`
	Operator string `json:"operator"`
	State    string `json:"state"`
	Karma    int64  `json:"karma"`
	Credits  string `json:"credits"`
}
type legacyAccount struct {
	Member
	Instances []legacySourceInstance `json:"instances"`
}
type LegacyObligation struct {
	ID           string          `json:"id"`
	Kind         string          `json:"kind"`
	Table        string          `json:"table"`
	Source       string          `json:"source"`
	Member       string          `json:"member"`
	LegacyMember string          `json:"legacy_member"`
	Instance     string          `json:"instance"`
	Amount       string          `json:"amount"`
	Record       json.RawMessage `json:"record"`
}

func (k Keeper) legacyState() (LegacyImportState, error) {
	var state LegacyImportState
	err := get(k.Store, "legacy_import", &state)
	return state, err
}
func (k Keeper) legacyGuard(c Command) error {
	if k.Store.Get([]byte("legacy_import")) == nil {
		if k.Store.Get([]byte("legacy_adoption")) != nil && !strings.HasPrefix(c.Operation, "legacy_") {
			return errors.New("approved legacy adoption must complete before native writes resume")
		}
		return nil
	}
	state, err := k.legacyState()
	if err != nil {
		return err
	}
	if strings.HasPrefix(c.Operation, "legacy_") {
		return nil
	}
	if state.Status != "ready" {
		return errors.New("legacy import/account reconciliation is incomplete")
	}
	// Old IDs are reserved permanently. An imported row cannot be overwritten or
	// re-opened under a prospective policy by using a new native command.
	var fields map[string]json.RawMessage
	if err = json.Unmarshal(c.Payload, &fields); err != nil {
		return err
	}
	if c.Operation == "instance_create" {
		var id string
		if json.Unmarshal(fields["id"], &id) == nil && k.Store.Get([]byte("legacy/actor/"+id)) != nil {
			return errors.New("historical instance ID is reserved for its original ownership/recovery")
		}
	}
	for _, name := range []string{"id", "project", "task", "contribution", "claim"} {
		var id string
		if raw := fields[name]; raw != nil && json.Unmarshal(raw, &id) == nil {
			for _, table := range []string{"projects", "tasks", "contributions", "claims", "skill_tests"} {
				if k.Store.Get([]byte("legacy/reserved/"+table+"/"+id)) != nil {
					return errors.New("historical record requires the legacy compatibility path")
				}
			}
		}
	}
	return nil
}
func (k Keeper) legacyBegin(c Command) (string, error) {
	if !k.guardian(c.Member) {
		return "", errors.New("guardian-approved migration required")
	}
	if k.Store.Get([]byte("legacy_import")) != nil {
		return "", errors.New("legacy import already exists")
	}
	// Import targets a newly initialized chain. It never rewrites native member
	// balances, command sequences, journals or obligations on an operating chain.
	if k.Store.Get([]byte("event_count")) != nil && k.Store.Get([]byte("legacy_adoption")) == nil {
		return "", errors.New("operating chain requires guarded legacy_adopt approval")
	}
	var p struct {
		ManifestDigest string `json:"manifest_digest"`
		RecordsRoot    string `json:"records_root"`
		TotalRecords   uint64 `json:"total_records,string"`
		Accounts       uint64 `json:"accounts,string"`
		LedgerHead     string `json:"ledger_head"`
		LastEventID    int64  `json:"last_event_id,string"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	var legacy LegacyCommitment
	if err := get(k.Store, "legacy", &legacy); err != nil && k.Store.Get([]byte("legacy_adoption")) == nil {
		return "", errors.New("independently pinned genesis legacy commitment or existing-chain adoption required")
	}
	if k.Store.Get([]byte("legacy_adoption")) != nil {
		var adoption LegacyAdoption
		if err := get(k.Store, "legacy_adoption", &adoption); err != nil {
			return "", err
		}
		if adoption.RecordsRoot != p.RecordsRoot || adoption.TotalRecords != p.TotalRecords || adoption.Accounts != p.Accounts {
			return "", errors.New("page root/count differs from approved existing-chain adoption")
		}
		legacy = LegacyCommitment{ManifestDigest: adoption.ManifestDigest, LedgerHead: adoption.LedgerHead, LastEventID: adoption.LastEventID, PinnedPublicKey: adoption.PinnedPublicKey}
	}
	if !digestPattern.MatchString(p.RecordsRoot) || p.TotalRecords == 0 || p.TotalRecords > 10000000 || p.Accounts == 0 || p.Accounts > 10000 || p.ManifestDigest != legacy.ManifestDigest || p.LedgerHead != legacy.LedgerHead || p.LastEventID != legacy.LastEventID {
		return "", errors.New("import does not match pinned legacy genesis")
	}
	state := LegacyImportState{Policy: LegacyImportPolicy, ManifestDigest: p.ManifestDigest, RecordsRoot: p.RecordsRoot, TotalRecords: p.TotalRecords, Accounts: p.Accounts, Status: "importing"}
	return p.ManifestDigest, put(k.Store, "legacy_import", state)
}
func legacyRecordHash(record LegacyImportRecord, index uint64) [32]byte {
	value := sha256.Sum256([]byte(record.Value))
	return sha256.Sum256([]byte(fmt.Sprintf("uain:legacy-record:v1\n%d\n%s\n%x", index, record.Key, value)))
}
func verifyLegacyRecord(record LegacyImportRecord, index, total uint64, root string) bool {
	if index >= total || len(record.Proof) > 24 {
		return false
	}
	depth := 0
	for n := total; n > 1; n = (n + 1) / 2 {
		depth++
	}
	if len(record.Proof) != depth {
		return false
	}
	value := legacyRecordHash(record, index)
	for _, text := range record.Proof {
		sibling, err := hex.DecodeString(text)
		if err != nil || len(sibling) != 32 {
			return false
		}
		buf := make([]byte, 0, 64)
		if index%2 == 0 {
			buf = append(buf, value[:]...)
			buf = append(buf, sibling...)
		} else {
			buf = append(buf, sibling...)
			buf = append(buf, value[:]...)
		}
		value = sha256.Sum256(buf)
		index /= 2
	}
	return hex.EncodeToString(value[:]) == root
}
func (k Keeper) legacyPage(c Command) (string, error) {
	state, err := k.legacyState()
	if err != nil {
		return "", err
	}
	if state.Status != "importing" {
		return "", errors.New("legacy import is not accepting pages")
	}
	var p struct {
		Start   uint64               `json:"start,string"`
		Records []LegacyImportRecord `json:"records"`
	}
	if err = Decode(c.Payload, &p); err != nil {
		return "", err
	}
	if p.Start != state.Imported || len(p.Records) == 0 || len(p.Records) > MaxLegacyRecordsPerPage || uint64(len(p.Records)) > state.TotalRecords-state.Imported {
		return "", errors.New("wrong import cursor or page bound")
	}
	bytes := 0
	for _, record := range p.Records {
		bytes += len(record.Value)
	}
	if bytes > MaxLegacyPageValueBytes {
		return "", errors.New("legacy page aggregate bytes exceeded")
	}
	for i, record := range p.Records {
		if len(record.Key) > 512 || len(record.Value) == 0 || len(record.Value) > MaxLegacyRecordBytes || strings.ContainsAny(record.Key, "\x00\r\n") || !strings.HasPrefix(record.Key, "legacy/") || record.Key <= state.LastKey || !json.Valid([]byte(record.Value)) || !verifyLegacyRecord(record, p.Start+uint64(i), state.TotalRecords, state.RecordsRoot) {
			return "", errors.New("invalid legacy record/proof/order")
		}
		if k.Store.Get([]byte(record.Key)) != nil {
			return "", errors.New("legacy record already imported")
		}
		if err = rejectDuplicateKeys([]byte(record.Value)); err != nil {
			return "", err
		}
		// Exact source bytes are queryable and independently provable in IAVL.
		k.Store.Set([]byte(record.Key), []byte(record.Value))
		state.LastKey = record.Key
	}
	state.Imported += uint64(len(p.Records))
	return state.ManifestDigest, put(k.Store, "legacy_import", state)
}
func (k Keeper) legacyFinish(c Command) (string, error) {
	if !k.guardian(c.Member) {
		return "", errors.New("guardian completion required")
	}
	var p struct{}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	state, err := k.legacyState()
	if err != nil {
		return "", err
	}
	if state.Status != "importing" || state.Imported != state.TotalRecords {
		return "", errors.New("legacy import incomplete or already completed")
	}
	var reconciliation struct {
		ManifestDigest string `json:"manifest_digest"`
		CoinIssued     string `json:"coin_issued"`
	}
	if err = get(k.Store, "legacy/reconciliation", &reconciliation); err != nil || reconciliation.ManifestDigest != state.ManifestDigest || reconciliation.CoinIssued != "0" {
		return "", errors.New("missing original-source reconciliation/no-Coin commitment")
	}
	state.Status = "reconciling_accounts"
	return state.ManifestDigest, put(k.Store, "legacy_import", state)
}
func (k Keeper) legacyClaimAccount(c Command) (string, error) {
	var p struct {
		Member string `json:"member"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	if c.Member != p.Member && !k.guardian(c.Member) {
		return "", errors.New("only owner or migration guardian may install an account")
	}
	state, err := k.legacyState()
	if err != nil {
		return "", err
	}
	if state.Status != "reconciling_accounts" {
		return "", errors.New("account import is not open")
	}
	claimed := "legacy_account_claimed/" + p.Member
	if k.Store.Get([]byte(claimed)) != nil {
		return "", errors.New("legacy account already reconciled")
	}
	var source legacyAccount
	if err = get(k.Store, "legacy/account/"+p.Member, &source); err != nil {
		return "", err
	}
	m, err := k.Member(p.Member)
	absent := err != nil
	if absent {
		if k.Store.Get([]byte("legacy_adoption")) == nil {
			return "", err
		}
		m = source.Member
		m.Sequence = 0
		if err = validateMember(m); err != nil {
			return "", err
		}
	}
	// Sequence belongs to the new chain and advances while pages are imported.
	// No source sequence can reset it. Every other aggregate is pinned in genesis.
	if source.ID != m.ID || source.PublicKey != m.PublicKey || source.Karma != m.Karma || source.Credits != m.Credits || source.Licence != m.Licence || source.DefaultVerifier != m.DefaultVerifier || source.Creator != m.Creator || source.ActiveProjects != m.ActiveProjects {
		return "", errors.New("source account differs from pinned genesis aggregate")
	}
	if len(source.Instances) > MaxInstancesPerMember || k.Store.Get([]byte("instance_count/"+m.ID)) != nil {
		return "", errors.New("account instances not empty or exceed bound")
	}
	totalCredits := big.NewInt(0)
	totalKarma := big.NewInt(0)
	seen := map[string]bool{}
	for _, i := range source.Instances {
		if i.Member != m.ID || !validID(i.ID) || len(i.Name) < 2 || len(i.Name) > 120 || len(i.Family) > 100 || seen[i.ID] || k.Store.Get([]byte("instance/"+i.ID)) != nil {
			return "", errors.New("invalid source instance ownership/identity")
		}
		seen[i.ID] = true
		credits, err := money(i.Credits)
		if err != nil {
			return "", err
		}
		totalCredits.Add(totalCredits, credits)
		totalKarma.Add(totalKarma, big.NewInt(i.Karma))
	}
	if totalCredits.String() != m.Credits || !totalKarma.IsInt64() || totalKarma.Int64() != m.Karma {
		return "", errors.New("instance attribution does not reconcile to member aggregate")
	}
	for _, i := range source.Instances {
		status := "active"
		if i.State == "revoked" || i.State == "withdrawn" {
			status = "paused"
		}
		v := Instance{ID: i.ID, Member: m.ID, Name: i.Name, Family: i.Family, State: status, Karma: i.Karma, Credits: i.Credits}
		if err = put(k.Store, "instance/"+v.ID, v); err != nil {
			return "", err
		}
	}
	if err = put(k.Store, "instance_count/"+m.ID, len(source.Instances)); err != nil {
		return "", err
	}
	if absent {
		if err = put(k.Store, "member/"+m.ID, m); err != nil {
			return "", err
		}
		if err = put(k.Store, "legacy_account_delta/"+m.ID, map[string]any{"kind": "imported_nonmonetary_opening", "source_manifest": state.ManifestDigest, "source_credits": source.Credits, "source_karma": source.Karma, "prior_native_credits": "0", "prior_native_karma": 0, "credit_delta": source.Credits, "karma_delta": source.Karma, "issuance": "0", "coin": "0"}); err != nil {
			return "", err
		}
	}
	if !absent {
		prior := sha256.Sum256(k.Store.Get([]byte("member/" + m.ID)))
		sourceDigest := sha256.Sum256(k.Store.Get([]byte("legacy/account/" + m.ID)))
		if err = put(k.Store, "legacy_account_delta/"+m.ID, map[string]any{"kind": "reconciled_nonmonetary_balance", "source_manifest": state.ManifestDigest, "source_account_digest": hex.EncodeToString(sourceDigest[:]), "prior_native_record_digest": hex.EncodeToString(prior[:]), "source_credits": source.Credits, "source_karma": source.Karma, "prior_native_credits": m.Credits, "prior_native_karma": m.Karma, "credit_delta": "0", "karma_delta": 0, "issuance": "0", "coin": "0"}); err != nil {
			return "", err
		}
	}
	if err = put(k.Store, claimed, map[string]any{"manifest_digest": state.ManifestDigest, "instances": len(source.Instances)}); err != nil {
		return "", err
	}
	state.ClaimedAccounts++
	if state.ClaimedAccounts > state.Accounts {
		return "", errors.New("too many claimed source accounts")
	}
	if state.ClaimedAccounts == state.Accounts {
		state.Status = "ready"
	}
	return m.ID, put(k.Store, "legacy_import", state)
}
func (k Keeper) legacyRelease(c Command, now time.Time) (string, error) {
	if !k.guardian(c.Member) {
		return "", errors.New("original operator release requires guardian authorization")
	}
	state, err := k.legacyState()
	if err != nil || state.Status != "ready" {
		return "", errors.New("complete imported accounts required")
	}
	var p struct {
		Obligations    []string `json:"obligations"`
		EvidenceDigest string   `json:"evidence_digest"`
	}
	if err = Decode(c.Payload, &p); err != nil {
		return "", err
	}
	if len(p.Obligations) < 1 || len(p.Obligations) > 8 || !digestPattern.MatchString(p.EvidenceDigest) {
		return "", errors.New("bounded original obligations and evidence required")
	}
	seen := map[string]bool{}
	for _, id := range p.Obligations {
		if len(id) > 256 || seen[id] || k.Store.Get([]byte("legacy_resolution/"+id)) != nil {
			return "", errors.New("duplicate or resolved legacy obligation")
		}
		seen[id] = true
		var obligation LegacyObligation
		if err = get(k.Store, "legacy/obligation/"+id, &obligation); err != nil {
			return "", err
		}
		if obligation.ID != id || obligation.Kind != "credit_deferral" || obligation.Table != "credit_deferrals" || obligation.Member == "" {
			return "", errors.New("only determined, owned original deferrals may be released")
		}
		var row struct {
			ID           string  `json:"id"`
			Participant  string  `json:"participant"`
			Contribution string  `json:"contribution_id"`
			Amount       string  `json:"amount"`
			ReleasedAt   *string `json:"released_at"`
		}
		if err = json.Unmarshal(obligation.Record, &row); err != nil {
			return "", err
		}
		if row.ReleasedAt != nil || row.Participant != obligation.Instance || row.Amount != obligation.Amount {
			return "", errors.New("deferral source/recipient mismatch")
		}
		amount, err := money(row.Amount)
		if err != nil || amount.Sign() == 0 {
			return "", errors.New("invalid original amount")
		}
		// Eligibility remains withheld while revoked/withdrawn. Neither a fresh
		// approval nor a new reward formula can alter the frozen source amount.
		if why, err := k.recipientReason(obligation.Member, obligation.Instance); err != nil || why != "" {
			return "", errors.New("original deferral recipient remains ineligible")
		}
		if err = k.credit(obligation.Member, obligation.Instance, row.Contribution, "legacy_release", amount, now, true, "legacy:"+id); err != nil {
			return "", err
		}
		if err = put(k.Store, "legacy_resolution/"+id, map[string]any{"policy": LegacyImportPolicy, "manifest_digest": state.ManifestDigest, "amount": row.Amount, "member": obligation.Member, "instance": obligation.Instance, "contribution": row.Contribution, "evidence_digest": p.EvidenceDigest, "at": now.UTC().Format(time.RFC3339Nano)}); err != nil {
			return "", err
		}
	}
	return state.ManifestDigest, nil
}

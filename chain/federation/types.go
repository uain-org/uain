// Package federation implements deterministic UAIN transitions. It performs no
// network or model calls: evidence is examined by independently signing members.
package federation

import "encoding/json"

const (
	ProtocolVersion  = 1
	MaxEnvelopeBytes = 65536
	MaxReward        = int64(1000000)
)

type Command struct {
	Version       int             `json:"version"`
	ChainID       string          `json:"chain_id"`
	Member        string          `json:"member"`
	Sequence      uint64          `json:"sequence,string"`
	ExpiresHeight int64           `json:"expires_height,string"`
	Operation     string          `json:"operation"`
	Payload       json.RawMessage `json:"payload"`
	Instance      string          `json:"instance,omitempty"`
}
type Envelope struct {
	Command   Command `json:"command"`
	PublicKey string  `json:"public_key"`
	Signature string  `json:"signature"`
}
type Member struct {
	ID              string `json:"id"`
	PublicKey       string `json:"public_key"`
	Name            string `json:"name"`
	Operator        string `json:"operator"`
	Family          string `json:"family"`
	Licence         string `json:"licence"`
	Karma           int64  `json:"karma"`
	Credits         string `json:"credits"`
	Sequence        uint64 `json:"sequence,string"`
	DefaultVerifier bool   `json:"default_verifier"`
	Creator         bool   `json:"creator"`
	ActiveProjects  int64  `json:"active_projects"`
	AccountPolicy   string `json:"account_policy,omitempty"`
	MetadataDigest  string `json:"metadata_digest,omitempty"`
	// Strikes are penalty points under KarmaPolicyV2. Omitted at zero, so every
	// record written before activation keeps its exact bytes.
	Strikes int64 `json:"strikes,omitempty"`
}

// Instances share their member's key, licence, sequence, operator and gates.
// Their earned standing is attribution within that aggregate, never new funds.
type Instance struct {
	ID             string `json:"id"`
	Member         string `json:"member"`
	Name           string `json:"name"`
	Family         string `json:"family"`
	State          string `json:"state"`
	Karma          int64  `json:"karma"`
	Credits        string `json:"credits"`
	AccountPolicy  string `json:"account_policy,omitempty"`
	MetadataDigest string `json:"metadata_digest,omitempty"`
}
type PriorArt struct {
	Basis    string   `json:"basis"`
	Searches []string `json:"searches"`
}
type Project struct {
	ID               string            `json:"id"`
	Lead             string            `json:"lead"`
	LeadInstance     string            `json:"lead_instance,omitempty"`
	Title            string            `json:"title"`
	Class            string            `json:"class"`
	PriorArt         PriorArt          `json:"prior_art"`
	State            string            `json:"state"`
	Budget           string            `json:"budget"`
	SafetyHalted     bool              `json:"safety_halted"`
	KPI              *KPI              `json:"kpi,omitempty"`
	Accounting       *AccountingBudget `json:"accounting,omitempty"`
	MembershipPolicy string            `json:"membership_policy,omitempty"`
	OperatorPolicy   string            `json:"operator_policy,omitempty"`
	StoragePolicy    string            `json:"storage_policy,omitempty"`
	MetadataDigest   string            `json:"metadata_digest,omitempty"`
}
type AccountingBudget struct {
	Allocated string `json:"allocated"`
	Unlocked  string `json:"unlocked"`
	Spent     string `json:"spent"`
	Reserved  string `json:"reserved"`
	Stage     int    `json:"stage"`
}
type KPI struct {
	Statement  string `json:"statement"`
	Metric     string `json:"metric"`
	Source     string `json:"source"`
	Comparator string `json:"comparator"`
	Threshold  string `json:"threshold,omitempty"`
	Unit       string `json:"unit,omitempty"`
	ResolvesBy string `json:"resolves_by"`
}
type Task struct {
	ID                string   `json:"id"`
	Project           string   `json:"project"`
	Title             string   `json:"title"`
	Class             string   `json:"class"`
	PriorArt          PriorArt `json:"prior_art"`
	Criteria          string   `json:"criteria"`
	Kind              string   `json:"kind"`
	KPI               *KPI     `json:"kpi"`
	KarmaReward       int64    `json:"karma_reward"`
	CreditReward      string   `json:"credit_reward"`
	State             string   `json:"state"`
	Winner            string   `json:"winner"`
	Submissions       []string `json:"submissions"`
	OpenedByInstance  string   `json:"opened_by_instance,omitempty"`
	RewardPolicy      string   `json:"reward_policy,omitempty"`
	VerifiersRequired int      `json:"verifiers_required,omitempty"`
	BudgetReserved    string   `json:"budget_reserved,omitempty"`
	OpenChallenges    []string `json:"open_challenges,omitempty"`
	PriorArtDecision  string   `json:"prior_art_decision,omitempty"`
	StoragePolicy     string   `json:"storage_policy,omitempty"`
	MetadataDigest    string   `json:"metadata_digest,omitempty"`
}
type Contribution struct {
	ID                   string         `json:"id"`
	Task                 string         `json:"task"`
	Author               string         `json:"author"`
	AuthorInstance       string         `json:"author_instance,omitempty"`
	EvidenceDigest       string         `json:"evidence_digest"`
	State                string         `json:"state"`
	Verifications        []Verification `json:"verifications"`
	AwardWithheld        string         `json:"award_withheld,omitempty"`
	Settlement           *Settlement    `json:"settlement,omitempty"`
	MembershipPolicy     string         `json:"membership_policy,omitempty"`
	StoragePolicy        string         `json:"storage_policy,omitempty"`
	ArbitrationPolicy    string         `json:"arbitration_policy,omitempty"`
	ArbitrationDigest    string         `json:"arbitration_digest,omitempty"`
	ResearchPolicy       string         `json:"research_policy,omitempty"`
	AppealWindowBlocks   int64          `json:"appeal_window_blocks,string,omitempty"`
	AppealUntil          int64          `json:"appeal_until,string,omitempty"`
	AppealDigest         string         `json:"appeal_digest,omitempty"`
	AppealDecisionDigest string         `json:"appeal_decision_digest,omitempty"`
	ArbitrationClosed    bool           `json:"arbitration_closed,omitempty"`
}
type Verification struct {
	Member         string   `json:"member"`
	Instance       string   `json:"instance,omitempty"`
	Verdict        string   `json:"verdict"`
	Novelty        string   `json:"novelty"`
	Searches       []string `json:"searches"`
	EvidenceDigest string   `json:"evidence_digest"`
	KnownSource    string   `json:"known_source,omitempty"`
	RecordDigest   string   `json:"record_digest,omitempty"`
	Bootstrap      bool     `json:"bootstrap,omitempty"`
	Reconsiders    string   `json:"reconsiders,omitempty"`
}
type Settlement struct {
	Policy               string         `json:"policy"`
	Karma                int64          `json:"karma"`
	Credits              string         `json:"credits"`
	FactorNumerator      int64          `json:"factor_numerator"`
	FactorDenominator    int64          `json:"factor_denominator"`
	IndependentOperators int            `json:"independent_operators"`
	OtherFamily          bool           `json:"other_family"`
	Checks               []Verification `json:"checks"`
	CheckRefs            []string       `json:"check_refs,omitempty"`
	Paid                 bool           `json:"paid"`
}
type CreditEntry struct {
	ID           string `json:"id"`
	EventID      uint64 `json:"event_id,string"`
	Member       string `json:"member"`
	Instance     string `json:"instance,omitempty"`
	Contribution string `json:"contribution"`
	Kind         string `json:"kind"`
	Amount       string `json:"amount"`
	Minted       string `json:"minted"`
	Deferred     string `json:"deferred"`
	Withheld     string `json:"withheld,omitempty"`
	At           string `json:"at"`
	ReleaseOf    string `json:"release_of,omitempty"`
}
type CreditOwed struct {
	Entry        string `json:"entry"`
	Member       string `json:"member"`
	Instance     string `json:"instance,omitempty"`
	Contribution string `json:"contribution"`
	Remaining    string `json:"remaining"`
}
type KarmaEntry struct {
	ID       string `json:"id"`
	EventID  uint64 `json:"event_id,string"`
	Member   string `json:"member"`
	Instance string `json:"instance,omitempty"`
	Delta    int64  `json:"delta"`
	Kind     string `json:"kind"`
	Ref      string `json:"ref"`
	At       string `json:"at"`
}
type Flag struct {
	ID             string `json:"id"`
	Project        string `json:"project"`
	Reporter       string `json:"reporter"`
	EvidenceDigest string `json:"evidence_digest"`
	State          string `json:"state"`
	DecidedBy      string `json:"decided_by"`
}

// CurrentGenesisGeneration 2: guardian quorum, recorded validators and the
// per-project finance index (9 November 2026).
const CurrentGenesisGeneration = 2

type Genesis struct {
	Version    int      `json:"version"`
	Generation int      `json:"generation,omitempty"`
	Guardians  []string `json:"guardians"`
	// GuardianThreshold > 1 requires that many guardian approvals for every
	// guardian-gated operation (guardian_quorum.go). Zero keeps one signature.
	GuardianThreshold int               `json:"guardian_threshold,omitempty"`
	Members           []Member          `json:"members"`
	Legacy            *LegacyCommitment `json:"legacy,omitempty"`
	// Validators optionally pins the consensus set in application state, so
	// state proofs can authenticate later signed rotations.
	Validators []GenesisValidator `json:"validators,omitempty"`
}
type LegacyCommitment struct {
	ManifestDigest  string `json:"manifest_digest"`
	LedgerHead      string `json:"ledger_head"`
	LastEventID     int64  `json:"last_event_id"`
	PinnedPublicKey string `json:"pinned_public_key"`
}
type Event struct {
	ID            uint64 `json:"id,string"`
	Height        int64  `json:"height,string"`
	Member        string `json:"member"`
	Operation     string `json:"operation"`
	Subject       string `json:"subject"`
	CommandDigest string `json:"command_digest"`
	Origin        string `json:"origin,omitempty"`
	Instance      string `json:"instance,omitempty"`
}

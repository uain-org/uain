package federation

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"sort"
	"strings"
	"testing"
	"time"
)

type memory map[string][]byte

func (s memory) Get(k []byte) []byte { return s[string(k)] }
func (s memory) Set(k, v []byte)     { s[string(k)] = bytes.Clone(v) }
func (s memory) Delete(k []byte)     { delete(s, string(k)) }
func (s memory) Last(start, end []byte) (*Entry, error) {
	rows, err := s.Range(start, end, len(s))
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	last := rows[len(rows)-1]
	return &last, nil
}
func (s memory) Range(start, end []byte, limit int) ([]Entry, error) {
	keys := []string{}
	for key := range s {
		if bytes.Compare([]byte(key), start) >= 0 && bytes.Compare([]byte(key), end) < 0 {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	out := []Entry{}
	for _, key := range keys {
		if len(out) == limit {
			break
		}
		out = append(out, Entry{Key: []byte(key), Value: bytes.Clone(s[key])})
	}
	return out, nil
}

type actor struct {
	m   Member
	key ed25519.PrivateKey
}

func newActor(name, operator string, karma int64, defaultVerifier, creator bool) actor {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	return actor{Member{ID: Address(pub), PublicKey: base64.RawURLEncoding.EncodeToString(pub), Name: name, Operator: operator, Family: name, Licence: "active", Karma: karma, Credits: "0", DefaultVerifier: defaultVerifier, Creator: creator}, priv}
}
func signed(t *testing.T, k Keeper, a actor, op string, p any, height int64) []byte {
	t.Helper()
	payload, e := json.Marshal(p)
	if e != nil {
		t.Fatal(e)
	}
	seq := uint64(0)
	if m, e := k.Member(a.m.ID); e == nil {
		seq = m.Sequence
	}
	c := Command{Version: 1, ChainID: "uain-test-1", Member: a.m.ID, Sequence: seq, ExpiresHeight: height + 10, Operation: op, Payload: payload}
	b, e := SigningBytes(c)
	if e != nil {
		t.Fatal(e)
	}
	raw, e := json.Marshal(Envelope{Command: c, PublicKey: a.m.PublicKey, Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(a.key, b))})
	if e != nil {
		t.Fatal(e)
	}
	return raw
}

// Match the SDK message cache: no write survives an unsuccessful command.
func apply(k Keeper, raw []byte, height int64) (string, error) {
	base := k.Store.(memory)
	next := memory{}
	for key, v := range base {
		next[key] = bytes.Clone(v)
	}
	subject, e := (Keeper{Store: next}).Execute(raw, "uain-test-1", height, time.Unix(height, 0).UTC())
	if e == nil {
		for key := range base {
			delete(base, key)
		}
		for key, v := range next {
			base[key] = v
		}
	}
	return subject, e
}
func fixture(t *testing.T) (Keeper, actor, actor, actor) {
	t.Helper()
	lead := newActor("author", "operator A", 1000, false, false)
	peer := newActor("peer", "operator B", 100, false, false)
	def := newActor("default", "operator C", 100, true, false)
	k := Keeper{Store: memory{}}
	if e := k.Init(Genesis{Version: 1, Guardians: []string{def.m.ID}, Members: []Member{lead.m, peer.m, def.m}}); e != nil {
		t.Fatal(e)
	}
	return k, lead, peer, def
}

var prior = PriorArt{Basis: "The open literature does not contain a solution to this bounded question.", Searches: []string{"search one result and timestamp", "search two result and timestamp"}}
var digest = strings.Repeat("a", 64)

func command(t *testing.T, k Keeper, a actor, op string, p any, h int64) {
	t.Helper()
	if _, e := apply(k, signed(t, k, a, op, p, h), h); e != nil {
		t.Fatalf("%s: %v", op, e)
	}
}
func open(t *testing.T, k Keeper, lead, guardian actor, future bool) {
	t.Helper()
	command(t, k, lead, "open_project", map[string]any{"id": "P-1", "title": "Research question", "class": "benevolent", "prior_art": prior}, 1)
	// These original bootstrap tests preserve the 0.1.2 project/task policy.
	// New credit policy tests exercise actual current project creation separately.
	p, _ := k.Project("P-1")
	p.Accounting = nil
	_ = put(k.Store, "project/P-1", p)
	command(t, k, guardian, "allocate_budget", map[string]any{"project": "P-1", "credits": "100", "evidence_digest": digest}, 2)
	task := Task{ID: "T-1", Project: "P-1", Title: "Resolve bounded question", Class: "benevolent", PriorArt: prior, Criteria: "Reproduce the result independently and verify the sources and novelty.", Kind: "instant", KarmaReward: 10, CreditReward: "100"}
	if future {
		task.Kind = "future"
		task.KPI = &KPI{Statement: "The independently observed count reaches at least five.", Metric: "observed_count", Source: "https://example.invalid/evidence", Comparator: "gte", Threshold: "5", ResolvesBy: time.Unix(100, 0).UTC().Format(time.RFC3339)}
	}
	command(t, k, lead, "open_task", task, 3)
	command(t, k, lead, "submit", map[string]any{"id": "RC-1", "task": "T-1", "evidence_digest": digest}, 4)
}
func verdict(t *testing.T, k Keeper, a actor, h int64) {
	t.Helper()
	command(t, k, a, "verify", map[string]any{"contribution": "RC-1", "verdict": "confirm", "novelty": "new", "searches": prior.Searches, "evidence_digest": digest}, h)
}
func TestSignedWorkSettlementAndReplay(t *testing.T) {
	k, lead, peer, guardian := fixture(t)
	open(t, k, lead, guardian, false)
	if _, e := apply(k, signed(t, k, lead, "verify", map[string]any{"contribution": "RC-1", "verdict": "confirm", "novelty": "new", "searches": prior.Searches, "evidence_digest": digest}, 5), 5); e == nil {
		t.Fatal("self verification allowed")
	}
	verdict(t, k, peer, 5)
	m, _ := k.Member(lead.m.ID)
	if m.Credits != "0" {
		t.Fatal("paid before default double-check")
	}
	raw := signed(t, k, guardian, "verify", map[string]any{"contribution": "RC-1", "verdict": "confirm", "novelty": "new", "searches": prior.Searches, "evidence_digest": digest}, 6)
	if _, e := apply(k, raw, 6); e != nil {
		t.Fatal(e)
	}
	m, _ = k.Member(lead.m.ID)
	if m.Credits != "100" || m.Karma != 1010 {
		t.Fatalf("unexpected settlement: %+v", m)
	}
	p, _ := k.Project("P-1")
	if p.Budget != "0" {
		t.Fatal("budget not conserved")
	}
	before, _ := json.Marshal(k.Store)
	if _, e := apply(k, raw, 7); e == nil {
		t.Fatal("replay accepted")
	}
	after, _ := json.Marshal(k.Store)
	if !bytes.Equal(before, after) {
		t.Fatal("failed replay changed state")
	}
}
func TestFutureMilestoneWithholdsUntilResolution(t *testing.T) {
	k, lead, peer, guardian := fixture(t)
	open(t, k, lead, guardian, true)
	verdict(t, k, peer, 5)
	verdict(t, k, guardian, 6)
	m, _ := k.Member(lead.m.ID)
	if m.Credits != "0" {
		t.Fatal("future work paid early")
	}
	p := map[string]any{"task": "T-1", "observed": "5", "evidence_digest": digest, "source": "https://example.invalid/evidence", "note": "The published source independently confirms that the milestone occurred."}
	command(t, k, guardian, "resolve_kpi", p, 99) // Public milestones can resolve before their deadline.
	m, _ = k.Member(lead.m.ID)
	if m.Credits != "100" {
		t.Fatal("verified met milestone not settled")
	}
	if _, e := apply(k, signed(t, k, guardian, "resolve_kpi", p, 101), 101); e == nil {
		t.Fatal("KPI resolved twice")
	}
}
func TestWrongChainKeyPayloadAndJSONAmbiguity(t *testing.T) {
	k, lead, _, _ := fixture(t)
	raw := signed(t, k, lead, "withdraw", map[string]any{}, 1)
	if _, e := Authenticate(raw, "wrong-chain", 1); e == nil {
		t.Fatal("cross-chain replay")
	}
	if _, e := Authenticate(raw, "uain-test-1", 12); e == nil {
		t.Fatal("expired command")
	}
	var env Envelope
	_ = json.Unmarshal(raw, &env)
	env.Command.Operation = "roles"
	tampered, _ := json.Marshal(env)
	if _, e := Authenticate(tampered, "uain-test-1", 1); e == nil {
		t.Fatal("tampered payload")
	}
	duplicate := bytes.Replace(raw, []byte(`"version":1`), []byte(`"version":1,"version":1`), 1)
	if _, e := Authenticate(duplicate, "uain-test-1", 1); e == nil {
		t.Fatal("duplicate JSON accepted")
	}
	if _, e := Authenticate(append(raw, []byte(" {}")...), "uain-test-1", 1); e == nil {
		t.Fatal("trailing document accepted")
	}
}
func TestProjectAllowanceAndPermanentLicence(t *testing.T) {
	k, lead, _, guardian := fixture(t)
	p := map[string]any{"id": "P-1", "title": "Research project", "class": "benevolent", "prior_art": prior}
	command(t, k, lead, "open_project", p, 1)
	p["id"] = "P-2"
	if _, e := apply(k, signed(t, k, lead, "open_project", p, 2), 2); e == nil {
		t.Fatal("1000 Karma opened two projects")
	}
	command(t, k, lead, "project_state", map[string]any{"project": "P-1", "state": "halted"}, 3)
	command(t, k, lead, "open_project", p, 4)
	if _, e := apply(k, signed(t, k, lead, "project_state", map[string]any{"project": "P-1", "state": "active"}, 5), 5); e == nil {
		t.Fatal("reopening bypassed allowance")
	}
	command(t, k, guardian, "licence", map[string]any{"member": lead.m.ID, "status": "revoked", "evidence_digest": digest}, 6)
	if _, e := apply(k, signed(t, k, lead, "withdraw", map[string]any{}, 7), 7); e == nil {
		t.Fatal("revoked member acted")
	}
	if _, e := apply(k, signed(t, k, guardian, "licence", map[string]any{"member": lead.m.ID, "status": "active", "evidence_digest": digest}, 8), 8); e == nil {
		t.Fatal("permanent revocation undone")
	}
}
func TestRevokedRecipientAndCorrelatedReviewersDoNotGetPaid(t *testing.T) {
	k, lead, peer, guardian := fixture(t)
	open(t, k, lead, guardian, false)
	verdict(t, k, peer, 5)
	command(t, k, guardian, "licence", map[string]any{"member": lead.m.ID, "status": "revoked", "evidence_digest": digest}, 6)
	verdict(t, k, guardian, 7)
	m, _ := k.Member(lead.m.ID)
	if m.Credits != "0" {
		t.Fatal("paid revoked author")
	}
	k, lead, peer, guardian = fixture(t)
	peer.m.Operator = lead.m.Operator
	_ = put(k.Store, "member/"+peer.m.ID, peer.m)
	open(t, k, lead, guardian, false)
	verdict(t, k, peer, 5)
	verdict(t, k, guardian, 6)
	m, _ = k.Member(lead.m.ID)
	if m.Credits != "0" {
		t.Fatal("correlated operators counted as independent")
	}
}
func TestPendingAdmissionAndUnknownOperationAtomic(t *testing.T) {
	k, _, _, guardian := fixture(t)
	a := newActor("new member", "operator D", 0, false, false)
	command(t, k, a, "enrol", map[string]any{"name": a.m.Name, "operator": a.m.Operator, "family": a.m.Family}, 1)
	if _, e := apply(k, signed(t, k, a, "withdraw", map[string]any{}, 2), 2); e == nil {
		t.Fatal("pending member acted without licence")
	}
	command(t, k, guardian, "licence", map[string]any{"member": a.m.ID, "status": "active", "evidence_digest": digest}, 3)
	before, _ := json.Marshal(k.Store)
	if _, e := apply(k, signed(t, k, a, "unrecognized", map[string]any{}, 4), 4); e == nil {
		t.Fatal("unknown operation accepted")
	}
	after, _ := json.Marshal(k.Store)
	if !bytes.Equal(before, after) {
		t.Fatal("failure changed state")
	}
	command(t, k, a, "withdraw", map[string]any{}, 5)
}

func TestSafetyPenaltyRevokesAndCannotBeRepeatedOrReopened(t *testing.T) {
	k, lead, peer, guardian := fixture(t)
	lead.m.Karma = -8
	lead.m.Creator = true
	_ = put(k.Store, "member/"+lead.m.ID, lead.m)
	command(t, k, lead, "open_project", map[string]any{"id": "P-1", "title": "Research project", "class": "benevolent", "prior_art": prior}, 1)
	command(t, k, peer, "flag", map[string]any{"id": "F-1", "project": "P-1", "evidence_digest": digest}, 2)
	command(t, k, peer, "flag", map[string]any{"id": "F-2", "project": "P-1", "evidence_digest": digest}, 3)
	command(t, k, guardian, "decide_flag", map[string]any{"flag": "F-1", "decision": "upheld", "evidence_digest": digest}, 4)
	m, _ := k.Member(lead.m.ID)
	if m.Karma != -10 || m.Licence != "revoked" || m.ActiveProjects != 0 {
		t.Fatalf("wrong sanction: %+v", m)
	}
	p, _ := k.Project("P-1")
	if p.State != "halted" || !p.SafetyHalted {
		t.Fatal("safety halt not recorded")
	}
	if _, e := apply(k, signed(t, k, guardian, "decide_flag", map[string]any{"flag": "F-2", "decision": "upheld", "evidence_digest": digest}, 5), 5); e == nil {
		t.Fatal("same violation penalized twice")
	}
}
func TestMissingModelCannotProveModelDiversity(t *testing.T) {
	k, lead, peer, guardian := fixture(t)
	lead.m.Family = ""
	_ = put(k.Store, "member/"+lead.m.ID, lead.m)
	if e := validateMember(lead.m); e != nil {
		t.Fatal("historical unspecified model must remain unspecified")
	}
	open(t, k, lead, guardian, false)
	verdict(t, k, peer, 5)
	verdict(t, k, guardian, 6)
	m, _ := k.Member(lead.m.ID)
	if m.Credits != "0" {
		t.Fatal("absent model counted as independent model family")
	}
}
func TestDeepJSONRejectedBeforeSignatureWork(t *testing.T) {
	raw := []byte(strings.Repeat("[", 200) + "0" + strings.Repeat("]", 200))
	var v any
	if e := Decode(raw, &v); e == nil {
		t.Fatal("excessive JSON nesting accepted")
	}
}

func TestCaseAliasesCannotChangeTypedCommandMeaning(t *testing.T) {
	k, lead, _, _ := fixture(t)
	raw := signed(t, k, lead, "withdraw", map[string]any{}, 1)
	alias := bytes.Replace(raw, []byte(`"version":1`), []byte(`"Version":1`), 1)
	if _, e := Authenticate(alias, "uain-test-1", 1); e == nil {
		t.Fatal("incorrectly cased signed command field accepted")
	}
	var member Member
	if e := Decode([]byte(`{"credits":"0","Credits":"100"}`), &member); e == nil {
		t.Fatal("case-alias payload fields accepted")
	}
}

func TestKnownAttestationWithholdsEveryReward(t *testing.T) {
	k, lead, peer, guardian := fixture(t)
	open(t, k, lead, guardian, false)
	command(t, k, peer, "verify", map[string]any{"contribution": "RC-1", "verdict": "confirm", "novelty": "known", "searches": prior.Searches, "evidence_digest": digest}, 5)
	v, _ := k.Contribution("RC-1")
	m, _ := k.Member(lead.m.ID)
	p, _ := k.Project("P-1")
	if v.AwardWithheld != "known" || v.State != "withheld" || m.Karma != 1000 || m.Credits != "0" || p.Budget != "100" {
		t.Fatalf("known work was not withheld: %+v %+v %+v", v, m, p)
	}
	if _, e := apply(k, signed(t, k, guardian, "verify", map[string]any{"contribution": "RC-1", "verdict": "confirm", "novelty": "new", "searches": prior.Searches, "evidence_digest": digest}, 6), 6); e == nil {
		t.Fatal("another verifier revived a known-result award")
	}
}

func TestFutureTaskRejectsAnswersAtItsDeadline(t *testing.T) {
	k, lead, peer, guardian := fixture(t)
	open(t, k, lead, guardian, true)
	before, _ := json.Marshal(k.Store)
	if _, e := apply(k, signed(t, k, peer, "submit", map[string]any{"id": "RC-late", "task": "T-1", "evidence_digest": digest}, 100), 100); e == nil {
		t.Fatal("late future-task submission accepted")
	}
	after, _ := json.Marshal(k.Store)
	if !bytes.Equal(before, after) {
		t.Fatal("late submission changed state")
	}
}

func TestOperatorVariantsCannotEstablishIndependence(t *testing.T) {
	k, lead, peer, guardian := fixture(t)
	lead.m.Operator = "Senti Global Ltd."
	peer.m.Operator = "senti-global"
	_ = put(k.Store, "member/"+lead.m.ID, lead.m)
	_ = put(k.Store, "member/"+peer.m.ID, peer.m)
	if normaliseOperator(lead.m.Operator) != normaliseOperator(peer.m.Operator) {
		t.Fatal("legacy operator normalization differs")
	}
	open(t, k, lead, guardian, false)
	verdict(t, k, peer, 5)
	verdict(t, k, guardian, 6)
	m, _ := k.Member(lead.m.ID)
	if m.Credits != "0" {
		t.Fatal("operator spelling counted as a second independent operator")
	}
}

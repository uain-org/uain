package federation

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

func TestExactScientificKPIObservationsAndUTCDate(t *testing.T) {
	kpi := &KPI{Statement: "Observed energy meets this exact fractional threshold.", Metric: "energy", Source: "doi:10.1234/fixture", Comparator: ">=", Threshold: "-0.00000000000000000001", Unit: "joule", ResolvesBy: "2026-10-09"}
	now := time.Date(2026, 10, 8, 0, 0, 0, 0, time.UTC)
	if e := validateKPI(kpi, now); e != nil {
		t.Fatal(e)
	}
	for _, v := range []struct {
		observed string
		met      bool
	}{{`"-0.00000000000000000001"`, true}, {`"-0.00000000000000000002"`, false}, {`"0"`, true}} {
		met, e := observedKPI(kpi, json.RawMessage(v.observed))
		if e != nil || met != v.met {
			t.Fatalf("exact observation %s: %v %v", v.observed, met, e)
		}
	}
	if _, e := observedKPI(kpi, json.RawMessage(`0.1`)); e == nil {
		t.Fatal("floating JSON observation accepted")
	}
	if _, e := decimal("1/3"); e == nil {
		t.Fatal("non-decimal observation accepted")
	}
	due, e := deadline(kpi.ResolvesBy)
	if e != nil || due.Format(time.RFC3339) != "2026-10-10T00:00:00Z" {
		t.Fatal("date did not end at UTC midnight")
	}
	if _, e := deadline("2026-02-30"); e == nil {
		t.Fatal("invalid calendar date accepted")
	}
	if kpiExpired(kpi, due.Add(KPIGrace-time.Nanosecond)) || !kpiExpired(kpi, due.Add(KPIGrace)) {
		t.Fatal("expiry boundary wrong")
	}
}

func TestEventKPIRequiresBooleanAndNoNumericThreshold(t *testing.T) {
	kpi := &KPI{Statement: "The milestone occurs and is published independently.", Metric: "milestone", Comparator: "occurs", Source: "NCT12345678", ResolvesBy: "2027-01-01"}
	if e := validateKPI(kpi, time.Date(2026, 10, 8, 0, 0, 0, 0, time.UTC)); e != nil {
		t.Fatal(e)
	}
	met, e := observedKPI(kpi, json.RawMessage(`true`))
	if e != nil || !met {
		t.Fatal("occurrence failed")
	}
	met, e = observedKPI(kpi, json.RawMessage(`false`))
	if e != nil || met {
		t.Fatal("non-occurrence met")
	}
	if _, e = observedKPI(kpi, json.RawMessage(`"true"`)); e == nil {
		t.Fatal("string accepted as boolean")
	}
	kpi.Threshold = "1"
	if e = validateKPI(kpi, time.Date(2026, 10, 8, 0, 0, 0, 0, time.UTC)); e == nil {
		t.Fatal("occurs numeric threshold accepted")
	}
}

func TestKPIBecomesFrozenAfterFirstSubmissionAndExpiredCannotPay(t *testing.T) {
	k, lead, peer, guardian := fixture(t)
	open(t, k, lead, guardian, true)
	task, _ := k.Task("T-1")
	if _, e := apply(k, signed(t, k, lead, "kpi_set", map[string]any{"task": "T-1", "kpi": task.KPI}, 5), 5); e == nil {
		t.Fatal("submitted task KPI changed")
	}
	verdict(t, k, peer, 5)
	verdict(t, k, guardian, 6)
	height := int64(100) + int64(KPIGrace/time.Second)
	p := map[string]any{"task": "T-1", "observed": "5", "source": task.KPI.Source, "note": "The public source confirms this metric independently.", "evidence_digest": digest}
	if _, e := apply(k, signed(t, k, guardian, "resolve_kpi", p, height), height); e == nil {
		t.Fatal("expired KPI paid")
	}
	m, _ := k.Member(lead.m.ID)
	if m.Credits != "0" {
		t.Fatal("expired award changed balance")
	}
}

func TestBoundedExpiryAndRestatementCannotStarveTheQueue(t *testing.T) {
	k, _, _, _ := fixture(t)
	kpi := &KPI{Statement: "A fixture milestone is observed and independently published.", Metric: "event", Source: "NCT12345678", Comparator: "occurs", ResolvesBy: time.Unix(100, 0).UTC().Format(time.RFC3339)}
	for i := 0; i < KPIExpiryPerBlock+1; i++ {
		task := Task{ID: fmt.Sprintf("T-%03d", i), State: "open", Kind: "future", KPI: kpi}
		if e := put(k.Store, "task/"+task.ID, task); e != nil {
			t.Fatal(e)
		}
		if e := k.scheduleKPI(task); e != nil {
			t.Fatal(e)
		}
	}
	at := time.Unix(100, 0).Add(KPIGrace)
	ids, e := k.ExpireKPIs(100, at.Add(-time.Nanosecond))
	if e != nil || len(ids) != 0 {
		t.Fatal("expiry ran early")
	}
	ids, e = k.ExpireKPIs(101, at)
	if e != nil || len(ids) != KPIExpiryPerBlock {
		t.Fatalf("expiry bound: %v %v", ids, e)
	}
	ids, e = k.ExpireKPIs(102, at)
	if e != nil || len(ids) != 1 {
		t.Fatal("expiry queue did not make progress")
	}
	ids, e = k.ExpireKPIs(103, at)
	if e != nil || len(ids) != 0 {
		t.Fatal("expiry repeated")
	}
	var event Event
	if e = get(k.Store, "event/00000000000000000001", &event); e != nil || event.Origin != "consensus" || event.Member != "" {
		t.Fatal("automatic event impersonated a member")
	}
	// A stale scheduling key must be repaired rather than sitting forever at
	// the front of the expiry queue and preventing other tasks from closing.
	future := *kpi
	future.ResolvesBy = at.Add(24 * time.Hour).Format(time.RFC3339)
	task := Task{ID: "T-stale", State: "open", Kind: "future", KPI: &future}
	_ = put(k.Store, "task/"+task.ID, task)
	_ = put(k.Store, "kpi_expiry/00000000000000000001/T-stale", task.ID)
	ids, e = k.ExpireKPIs(104, at)
	if e != nil || len(ids) != 0 {
		t.Fatal("stale queue key decided a milestone")
	}
	if k.Store.Get([]byte("kpi_expiry/00000000000000000001/T-stale")) != nil {
		t.Fatal("stale key remained at queue head")
	}
}

package federation

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const KPIGrace = 30 * 24 * time.Hour
const KPIExpiryPerBlock = 10

var decimalPattern = regexp.MustCompile(`^-?(0|[1-9][0-9]*)(\.[0-9]+)?$`)
var identifierSource = regexp.MustCompile(`(?i)^(NCT[0-9]{8}|PMID[ :]*[0-9]{1,12}|(doi: *)?10\.[0-9]{4,9}/[^\s]+)$`)

// Scientific measurements are exact decimal strings, independent of floating
// point and architecture. Money continues using unsigned integer units.
func decimal(s string) (*big.Rat, error) {
	if len(s) > 256 || !decimalPattern.MatchString(s) {
		return nil, errors.New("bounded decimal string required")
	}
	n, ok := new(big.Rat).SetString(s)
	if !ok {
		return nil, errors.New("invalid decimal measurement")
	}
	return n, nil
}
func deadline(value string) (time.Time, error) {
	if len(value) == 10 {
		t, e := time.Parse("2006-01-02", value)
		if e != nil {
			return t, e
		}
		return t.Add(24 * time.Hour), nil // The end of the named UTC day.
	}
	return time.Parse(time.RFC3339Nano, value)
}
func validDeadline(value string, now time.Time) bool {
	t, e := deadline(value)
	return e == nil && t.After(now) && !t.After(now.AddDate(50, 0, 0))
}
func deadlineDue(value string, now time.Time) bool {
	t, e := deadline(value)
	return e == nil && !now.Before(t)
}
func kpiExpired(kpi *KPI, now time.Time) bool {
	if kpi == nil {
		return false
	}
	t, e := deadline(kpi.ResolvesBy)
	return e == nil && !now.Before(t.Add(KPIGrace))
}
func kpiSource(s string) bool {
	if len(s) == 0 || len(s) > 500 || strings.TrimSpace(s) != s {
		return false
	}
	if identifierSource.MatchString(s) {
		return true
	}
	u, e := url.Parse(s)
	return e == nil && u.Scheme == "https" && u.Hostname() != "" && u.User == nil
}
func validateKPI(kpi *KPI, now time.Time) error {
	if kpi == nil || len(strings.TrimSpace(kpi.Statement)) < 20 || len(kpi.Statement) > 2000 || len(strings.TrimSpace(kpi.Metric)) < 1 || len(kpi.Metric) > 200 || len(kpi.Unit) > 50 || !kpiSource(kpi.Source) || !validDeadline(kpi.ResolvesBy, now) {
		return errors.New("KPI needs statement, metric, public source and bounded future deadline")
	}
	if kpi.Comparator == "occurs" {
		if kpi.Threshold != "" || kpi.Unit != "" {
			return errors.New("occurs has no numeric threshold or unit")
		}
		return nil
	}
	if kpi.Comparator != "gte" && kpi.Comparator != "lte" && kpi.Comparator != "eq" && kpi.Comparator != ">=" && kpi.Comparator != "<=" && kpi.Comparator != "==" {
		return errors.New("invalid KPI comparator")
	}
	_, e := decimal(kpi.Threshold)
	return e
}
func observedKPI(kpi *KPI, raw json.RawMessage) (bool, error) {
	if kpi.Comparator == "occurs" {
		if string(raw) != "true" && string(raw) != "false" {
			return false, errors.New("occurs observation must be a boolean")
		}
		return string(raw) == "true", nil
	}
	var value string
	if e := Decode(raw, &value); e != nil {
		return false, errors.New("numeric observations use exact decimal strings")
	}
	observed, e := decimal(value)
	if e != nil {
		return false, e
	}
	threshold, e := decimal(kpi.Threshold)
	if e != nil {
		return false, e
	}
	cmp := observed.Cmp(threshold)
	switch kpi.Comparator {
	case "gte", ">=":
		return cmp >= 0, nil
	case "lte", "<=":
		return cmp <= 0, nil
	case "eq", "==":
		return cmp == 0, nil
	default:
		return false, errors.New("invalid KPI comparator")
	}
}
func (k Keeper) setKPI(c Command, now time.Time) (string, error) {
	var p struct {
		Task    string `json:"task"`
		Project string `json:"project"`
		KPI     *KPI   `json:"kpi"`
	}
	if e := Decode(c.Payload, &p); e != nil {
		return "", e
	}
	if (p.Task == "") == (p.Project == "") {
		return "", errors.New("select one task or project KPI")
	}
	if p.KPI != nil {
		if e := validateKPI(p.KPI, now); e != nil {
			return "", e
		}
	}
	if p.Project != "" {
		v, e := k.projectState(p.Project)
		if e != nil {
			return "", e
		}
		if v.Lead != c.Member || v.State != "active" {
			return "", errors.New("KPI needs active project lead")
		}
		if e = k.requireParticipation(v, c); e != nil {
			return "", e
		}
		v.KPI = p.KPI
		return v.ID, put(k.Store, "project/"+v.ID, v)
	}
	t, e := k.taskState(p.Task)
	if e != nil {
		return "", e
	}
	v, e := k.projectState(t.Project)
	if e != nil {
		return "", e
	}
	if v.Lead != c.Member || v.State != "active" || t.State != "open" || len(t.Submissions) > 0 {
		return "", errors.New("task KPI is frozen or signer is not the active project lead")
	}
	if e = k.requireParticipation(v, c); e != nil {
		return "", e
	}
	if t.Kind == "future" && p.KPI == nil {
		return "", errors.New("future task must retain a KPI")
	}
	if t.Kind == "future" && t.KPI != nil {
		old, e := expiryKey(t)
		if e != nil {
			return "", e
		}
		k.Store.Delete(old)
	}
	t.KPI = p.KPI
	if e = k.scheduleKPI(t); e != nil {
		return "", e
	}
	return t.ID, put(k.Store, "task/"+t.ID, t)
}

func expiryKey(t Task) ([]byte, error) {
	due, e := deadline(t.KPI.ResolvesBy)
	if e != nil {
		return nil, e
	}
	return []byte(fmt.Sprintf("kpi_expiry/%020d/%s", due.Add(KPIGrace).Unix(), t.ID)), nil
}
func (k Keeper) scheduleKPI(t Task) error {
	if t.Kind != "future" || t.KPI == nil {
		return nil
	}
	key, e := expiryKey(t)
	if e != nil {
		return e
	}
	return put(k.Store, string(key), t.ID)
}

// Expiry is deterministic and bounded: at most ten task markers per block.
// It does not rewrite every contribution. Closed expiry state permanently
// prevents payout; clients derive withholding from that committed task marker.
func (k Keeper) ExpireKPIs(height int64, now time.Time) ([]string, error) {
	k.height = height
	end := []byte(fmt.Sprintf("kpi_expiry/%020d/", now.Unix()+1))
	entries, e := k.Store.Range([]byte("kpi_expiry/"), end, KPIExpiryPerBlock)
	if e != nil {
		return nil, e
	}
	expired := []string{}
	for _, entry := range entries {
		var id string
		if e = Decode(entry.Value, &id); e != nil {
			return nil, e
		}
		t, e := k.taskState(id)
		if e != nil {
			return nil, e
		}
		if t.State != "open" || t.Kind != "future" || t.KPI == nil {
			k.Store.Delete(entry.Key)
			continue
		}
		current, e := expiryKey(t)
		if e != nil {
			return nil, e
		}
		if string(current) != string(entry.Key) {
			k.Store.Delete(entry.Key)
			if e = k.scheduleKPI(t); e != nil {
				return nil, e
			}
			continue
		}
		// A subsecond deadline may share the current Unix second. Wait for its
		// exact timestamp, without recording an early expiry.
		if !kpiExpired(t.KPI, now) {
			continue
		}
		if e = k.releaseReservation(&t); e != nil {
			return nil, e
		}
		t.State = "kpi_expired"
		if e = put(k.Store, "task/"+t.ID, t); e != nil {
			return nil, e
		}
		resolution := map[string]any{"outcome": "expired", "task": t.ID, "height": height, "at": now.UTC().Format(time.RFC3339Nano), "kpi": t.KPI}
		if e = put(k.Store, "kpi_resolution/"+t.ID, resolution); e != nil {
			return nil, e
		}
		var count uint64
		if k.Store.Get([]byte("event_count")) != nil {
			if e = get(k.Store, "event_count", &count); e != nil {
				return nil, e
			}
		}
		if count == math.MaxUint64 {
			return nil, errors.New("event ID exhausted")
		}
		count++
		raw, e := json.Marshal(resolution)
		if e != nil {
			return nil, e
		}
		digest := sha256.Sum256(append([]byte("uain:kpi-expiry:v1\n"), raw...))
		event := Event{ID: count, Height: height, Operation: "expire_kpi", Subject: t.ID, CommandDigest: hex.EncodeToString(digest[:]), Origin: "consensus"}
		if e = put(k.Store, fmt.Sprintf("event/%020d", count), event); e != nil {
			return nil, e
		}
		if e = put(k.Store, "event_count", count); e != nil {
			return nil, e
		}
		k.Store.Delete(entry.Key)
		expired = append(expired, t.ID)
	}
	return expired, nil
}

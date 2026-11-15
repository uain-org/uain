package federation

import (
	"errors"
	"math"
	"strings"
)

const MaxInstancesPerMember = 128

func (k Keeper) Instance(id string) (Instance, error) {
	var v Instance
	err := get(k.Store, "instance/"+id, &v)
	if err == nil && v.AccountPolicy != "" {
		v, err = k.fullInstance(v)
	}
	return v, err
}

func (k Keeper) validateInstance(member, id string) error {
	if id == "" {
		return nil
	} // Previously signed member-only commands stay valid.
	if !validID(id) {
		return errors.New("invalid instance ID")
	}
	v, err := k.Instance(id)
	if err != nil {
		return err
	}
	if v.Member != member || v.State != "active" {
		return errors.New("instance must be active and belong to signing member")
	}
	return nil
}

func (k Keeper) createInstance(c Command) (string, error) {
	var p struct {
		ID     string `json:"id"`
		Name   string `json:"name"`
		Family string `json:"family"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	if !validID(p.ID) || len(strings.TrimSpace(p.Name)) < 2 || len(p.Name) > 120 || len(p.Family) > 100 {
		return "", errors.New("invalid instance metadata")
	}
	if k.Store.Get([]byte("instance/"+p.ID)) != nil {
		return "", errors.New("instance ID already exists")
	}
	countKey := "instance_count/" + c.Member
	var count int
	if k.Store.Get([]byte(countKey)) != nil {
		if err := get(k.Store, countKey, &count); err != nil {
			return "", err
		}
	}
	if count < 0 || count >= MaxInstancesPerMember {
		return "", errors.New("member instance limit reached")
	}
	v := Instance{ID: p.ID, Member: c.Member, Name: p.Name, Family: p.Family, State: "active", Credits: "0"}
	if err := put(k.Store, "instance/"+v.ID, v); err != nil {
		return "", err
	}
	return v.ID, put(k.Store, countKey, count+1)
}

func (k Keeper) instanceState(c Command) (string, error) {
	var p struct {
		ID    string `json:"id"`
		State string `json:"state"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	v, err := k.Instance(p.ID)
	if err != nil {
		return "", err
	}
	if v.Member != c.Member || (p.State != "active" && p.State != "paused") || v.State == p.State {
		return "", errors.New("instance lifecycle needs owner and a changed valid state")
	}
	v.State = p.State
	return v.ID, put(k.Store, "instance/"+v.ID, v)
}

func (k Keeper) actorFamily(m Member, id string) (string, bool, error) {
	if id == "" {
		return m.Family, true, nil
	}
	v, err := k.Instance(id)
	if err != nil {
		return "", false, err
	}
	return v.Family, v.Member == m.ID && v.State == "active", nil
}

// Credit/karma attribution updates only the instance sub-account. The caller
// updates the member aggregate once in the same cached SDK transaction.
func (k Keeper) attribute(member, id string, karma int64, credits string) error {
	if id == "" {
		return nil
	}
	v, err := k.Instance(id)
	if err != nil {
		return err
	}
	if v.Member != member {
		return errors.New("instance attribution owner mismatch")
	}
	if (karma > 0 && v.Karma > math.MaxInt64-karma) || (karma < 0 && v.Karma < math.MinInt64-karma) {
		return errors.New("instance Karma overflow")
	}
	balance, err := money(v.Credits)
	if err != nil {
		return err
	}
	amount, err := money(credits)
	if err != nil {
		return err
	}
	balance.Add(balance, amount)
	if len(balance.String()) > 78 {
		return errors.New("instance credit overflow")
	}
	v.Karma += karma
	v.Credits = balance.String()
	return put(k.Store, "instance/"+v.ID, v)
}

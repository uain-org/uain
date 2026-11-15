package federation

import (
	"encoding/base64"
	"encoding/hex"
	"errors"
	pd "github.com/uain-org/uain/chain/privatedividend"
	"math"
)

// This handler has no activation route. Future dispatch must call it only after
// Authenticate/Validate, using the immutable APP genesis pin, never Tx input.
// The original Ed25519 member command consents to the exact Orchard control;
// delegated instances cannot register or reset per-member carry authority.
type DividendOwnerRegistration struct {
	Control   string `json:"control"`
	Public    string `json:"public"`
	Proof     string `json:"proof"`
	Signature string `json:"signature"`
}
type DividendOwner struct {
	Version   string `json:"version"`
	Member    string `json:"member"`
	PublicKey string `json:"public_key"`
	Control   string `json:"control"`
	Index     uint32 `json:"index,string"`
	Active    bool   `json:"active"`
}
type dividendOwnerState struct {
	Version  string `json:"version"`
	Revision uint64 `json:"revision,string"`
}

func (k Keeper) DividendOwner(member string) (DividendOwner, error) {
	var v DividendOwner
	e := get(k.Store, "dividend_owner/"+member, &v)
	return v, e
}
func (k Keeper) registerDividendOwner(c Command, genesis [32]byte, height int64) (string, error) {
	if !pd.HashAvailable() {
		return "", pd.ErrUnavailable
	}
	return k.registerDividendOwnerWithHash(c, genesis, height, pd.Poseidon{}, k.meterDividendOwnerHash())
}
func (k Keeper) registerDividendOwnerWithHash(c Command, genesis [32]byte, height int64, verifier pd.RegistrationVerifier, hash pd.OwnerHasher) (string, error) {
	active, e := k.dividendPolicyAt(height)
	if e != nil {
		return "", e
	}
	if !active {
		return "", errors.New("dividend policy inactive")
	}
	if c.Instance != "" || c.Operation != "dividend_register" || genesis == [32]byte{} || verifier == nil || hash == nil {
		return "", errors.New("original member registration and canonical app genesis required")
	}
	m, e := k.Member(c.Member)
	if e != nil {
		return "", e
	}
	if m.ID != c.Member || m.Licence != "active" {
		return "", errors.New("active original licensed member required")
	}
	memberBytes, e := base64.RawURLEncoding.DecodeString(m.PublicKey)
	if e != nil || !validNativeEd25519Key(memberBytes) || Address(memberBytes) != m.ID {
		return "", errors.New("invalid original member key")
	}
	var member [32]byte
	copy(member[:], memberBytes)
	if k.Store.Get([]byte("dividend_owner/"+c.Member)) != nil {
		return "", errors.New("per-member carry control already registered and immutable")
	}
	var p DividendOwnerRegistration
	if e = Decode(c.Payload, &p); e != nil {
		return "", e
	}
	decode := func(v string, maxBytes int) ([]byte, error) {
		if len(v) > maxBytes*2 || len(v)%2 != 0 {
			return nil, errors.New("registration input exceeds fixed bound")
		}
		b, e := hex.DecodeString(v)
		if e != nil || hex.EncodeToString(b) != v {
			return nil, errors.New("noncanonical registration encoding")
		}
		return b, nil
	}
	cb, e := decode(p.Control, 32)
	if e != nil || len(cb) != 32 {
		return "", pd.ErrInvalid
	}
	var control [32]byte
	copy(control[:], cb)
	if k.Store.Get([]byte("dividend_owner_control/"+p.Control)) != nil {
		return "", errors.New("carry control already registered to a member")
	}
	public, e := decode(p.Public, pd.RegistrationPublicSize)
	if e != nil {
		return "", e
	}
	statement, e := pd.MatchRegistration(public, c.ChainID, genesis, member, control)
	if e != nil {
		return "", e
	}
	proof, e := decode(p.Proof, 64*1024)
	if e != nil || len(proof) == 0 {
		return "", pd.ErrInvalid
	}
	sig, e := decode(p.Signature, 64)
	if e != nil || len(sig) != 64 {
		return "", pd.ErrInvalid
	}
	var signature [64]byte
	copy(signature[:], sig)
	if meter, ok := k.Store.(interface{ PrivateProofGas(uint64) }); ok {
		meter.PrivateProofGas(1_000_000)
	}
	if e = verifier.VerifyRegistration(statement, proof, signature); e != nil {
		return "", e
	}
	state, e := nextDividendOwnerState(k.Store)
	if e != nil {
		return "", e
	}
	tree := pd.OwnerTree{Store: k.Store, Hash: hash}
	index, e := tree.Append(member, control, true)
	if e != nil {
		return "", e
	}
	record := DividendOwner{pd.RegistrationVersion, c.Member, m.PublicKey, p.Control, index, true}
	if e = put(k.Store, "dividend_owner/"+c.Member, record); e != nil {
		return "", e
	}
	if e = put(k.Store, "dividend_owner_control/"+p.Control, c.Member); e != nil {
		return "", e
	}
	if e = put(k.Store, "dividend_owner_state", state); e != nil {
		return "", e
	}
	return c.Member, nil
}
func nextDividendOwnerState(s Store) (dividendOwnerState, error) {
	v := dividendOwnerState{Version: pd.RegistrationVersion}
	if s.Get([]byte("dividend_owner_state")) != nil {
		if e := get(s, "dividend_owner_state", &v); e != nil {
			return v, e
		}
	}
	if v.Version != pd.RegistrationVersion || v.Revision == math.MaxUint64 {
		return v, errors.New("invalid or exhausted owner registry revision")
	}
	v.Revision++
	return v, nil
}
func updateDividendOwnerLicence(s Store, m Member) error {
	var tracked bool
	if native, ok := s.(interface{ DividendOwnerTracking() bool }); ok {
		tracked = native.DividendOwnerTracking()
	} else {
		tracked = s.Get([]byte("dividend_owner1/count")) != nil
	}
	if !tracked {
		return nil
	}
	return updateDividendOwnerLicenceWithHash(s, m, (Keeper{Store: s}).meterDividendOwnerHash())
}
func updateDividendOwnerLicenceWithHash(s Store, m Member, hash pd.OwnerHasher) error {
	if s.Get([]byte("dividend_owner/"+m.ID)) == nil {
		return nil
	}
	k := Keeper{Store: s}
	record, e := k.DividendOwner(m.ID)
	if e != nil {
		return e
	}
	if record.Version != pd.RegistrationVersion || record.Member != m.ID || record.PublicKey != m.PublicKey {
		return errors.New("registered original member key is immutable")
	}
	active := m.Licence == "active"
	if record.Active == active {
		return nil
	}
	mb, e := base64.RawURLEncoding.DecodeString(record.PublicKey)
	if e != nil || len(mb) != 32 {
		return pd.ErrInvalid
	}
	cb, e := hex.DecodeString(record.Control)
	if e != nil || len(cb) != 32 {
		return pd.ErrInvalid
	}
	var member, control [32]byte
	copy(member[:], mb)
	copy(control[:], cb)
	state, e := nextDividendOwnerState(s)
	if e != nil {
		return e
	}
	if e = (pd.OwnerTree{Store: s, Hash: hash}).Update(record.Index, member, control, active); e != nil {
		return e
	}
	record.Active = active
	if e = put(s, "dividend_owner/"+m.ID, record); e != nil {
		return e
	}
	return put(s, "dividend_owner_state", state)
}

type dividendOwnerMeteredHash struct {
	base   pd.OwnerHasher
	charge func(uint64)
}

func (h dividendOwnerMeteredHash) OwnerEmpty(level uint8) ([32]byte, error) {
	return h.base.OwnerEmpty(level)
}
func (h dividendOwnerMeteredHash) OwnerLeaf(m, c [32]byte, a bool) ([32]byte, error) {
	h.charge(200)
	return h.base.OwnerLeaf(m, c, a)
}
func (h dividendOwnerMeteredHash) OwnerNode(level uint8, l, r [32]byte) ([32]byte, error) {
	h.charge(100)
	return h.base.OwnerNode(level, l, r)
}
func (k Keeper) meterDividendOwnerHash() pd.OwnerHasher {
	if meter, ok := k.Store.(interface{ PrivateProofGas(uint64) }); ok {
		return dividendOwnerMeteredHash{pd.Poseidon{}, meter.PrivateProofGas}
	}
	return pd.Poseidon{}
}

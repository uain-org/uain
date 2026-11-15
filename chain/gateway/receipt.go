package gateway

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/uain-org/uain/chain/federation"
)

// The event is written only after successful execution. Its inclusion proof
// binds the complete canonical signed command, even after later member changes.
// CheckTx responses and transaction-indexer hints confer no finality.
type ReceiptRequest struct {
	Envelope federation.Envelope `json:"envelope"`
	EventID  uint64              `json:"event_id,string"`
}
type Receipt struct {
	Authority   string           `json:"authority"`
	Finalized   bool             `json:"finalized"`
	ChainID     string           `json:"chain_id"`
	StateHeight int64            `json:"state_height,string"`
	AppHash     string           `json:"app_hash"`
	Event       federation.Event `json:"event"`
}

func commandReceipt(s Snapshot, r ReceiptRequest) (Receipt, error) {
	var event federation.Event
	if e := json.Unmarshal(s.Records[fmt.Sprintf("event/%020d", r.EventID)], &event); e != nil {
		return Receipt{}, errors.New("command event is not finalized at selected cursor")
	}
	if event.ID != r.EventID || event.Height < 1 || event.Height > s.Height {
		return Receipt{}, errors.New("invalid finalized event context")
	}
	raw, e := json.Marshal(r.Envelope)
	if e != nil {
		return Receipt{}, e
	}
	env, e := federation.Authenticate(raw, s.ChainID, event.Height)
	if e != nil {
		return Receipt{}, e
	}
	signing, e := federation.SigningBytes(env.Command)
	if e != nil {
		return Receipt{}, e
	}
	digest := sha256.Sum256(signing)
	c := env.Command
	if event.CommandDigest != hex.EncodeToString(digest[:]) || event.Member != c.Member || event.Instance != c.Instance || event.Operation != c.Operation || s.Member == nil || s.Member.ID != c.Member || s.Member.Sequence <= c.Sequence {
		return Receipt{}, errors.New("finalized event differs from signed command")
	}
	return Receipt{Authority: "native", Finalized: true, ChainID: s.ChainID, StateHeight: s.Height, AppHash: s.AppHash, Event: event}, nil
}

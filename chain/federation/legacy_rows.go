package federation

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
)

// LegacyRow reconstructs the original immutable public row. It is intentionally
// separate from prospective native objects; neither can reinterpret the other.
// The fixed 2 MiB bound limits consensus work even on an approved snapshot.
func (k Keeper) LegacyRow(table, id string) (json.RawMessage, error) {
	if !validID(table) || len(id) > 256 {
		return nil, errors.New("invalid historical row identity")
	}
	var alias struct {
		Source string `json:"source"`
	}
	if err := get(k.Store, "legacy/lookup/"+table+"/"+id, &alias); err != nil {
		return nil, err
	}
	return k.legacyRowSource(table, alias.Source)
}
func (k Keeper) legacyRowSource(table, source string) (json.RawMessage, error) {
	if len(source) > 512 {
		return nil, errors.New("invalid historical source")
	}
	raw := k.Store.Get([]byte("legacy/row/" + table + "/" + source))
	if raw == nil {
		return nil, errors.New("historical row missing")
	}
	var row struct {
		Table string          `json:"table"`
		Row   json.RawMessage `json:"row"`
		Hash  string          `json:"row_sha256"`
		Parts int             `json:"parts"`
	}
	if err := json.Unmarshal(raw, &row); err != nil {
		return nil, err
	}
	if row.Table != table {
		return nil, errors.New("historical table mismatch")
	}
	if row.Row != nil {
		return row.Row, nil
	}
	if row.Parts < 1 || row.Parts > 210 || !digestPattern.MatchString(row.Hash) {
		return nil, errors.New("invalid historical chunks")
	}
	data := []byte{}
	for n := 0; n < row.Parts; n++ {
		var text string
		if err := get(k.Store, fmt.Sprintf("legacy/chunk/%s/%s/%06d", table, source, n), &text); err != nil {
			return nil, err
		}
		part, err := base64.StdEncoding.DecodeString(text)
		if err != nil || len(part) > 10000 {
			return nil, errors.New("invalid historical chunk")
		}
		data = append(data, part...)
		if len(data) > 2*1024*1024 {
			return nil, errors.New("historical row exceeds reconstruction bound")
		}
	}
	hash := sha256.Sum256(data)
	if hex.EncodeToString(hash[:]) != row.Hash {
		return nil, errors.New("historical chunks differ from approved source")
	}
	if err := json.Unmarshal(data, &row); err != nil {
		return nil, err
	}
	if row.Table != table || row.Row == nil {
		return nil, errors.New("invalid reconstructed source")
	}
	return row.Row, nil
}

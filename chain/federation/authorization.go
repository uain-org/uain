package federation

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strings"
)

func Address(key []byte) string { h := sha256.Sum256(key); return "uain1" + hex.EncodeToString(h[:20]) }

// rejectDuplicateKeys rejects ambiguity before either command or payload is
// decoded. Different JSON parsers must never sign/execute different meanings.
func rejectDuplicateKeys(raw []byte) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	var walk func(int) error
	walk = func(depth int) error {
		if depth > 128 {
			return errors.New("JSON nesting limit")
		}
		t, e := d.Token()
		if e != nil {
			return e
		}
		delim, ok := t.(json.Delim)
		if !ok {
			return nil
		}
		switch delim {
		case '{':
			seen := map[string]bool{}
			for d.More() {
				k, e := d.Token()
				if e != nil {
					return e
				}
				s, ok := k.(string)
				if !ok || seen[s] {
					return errors.New("duplicate or invalid JSON key")
				}
				seen[s] = true
				if e = walk(depth + 1); e != nil {
					return e
				}
			}
		case '[':
			for d.More() {
				if e := walk(depth + 1); e != nil {
					return e
				}
			}
		default:
			return errors.New("invalid JSON delimiter")
		}
		_, e = d.Token()
		return e
	}
	if e := walk(0); e != nil {
		return e
	}
	if _, e := d.Token(); e != io.EOF {
		return errors.New("trailing JSON")
	}
	return nil
}
func Decode(raw []byte, out any) error {
	return decodeBounded(raw, out, MaxEnvelopeBytes)
}

const MaxGenesisBytes = 8 * 1024 * 1024

// Genesis is a separately pinned bootstrap artifact, not a member envelope.
// It retains identical duplicate/field/nesting validation with its own bound.
func DecodeGenesis(raw []byte, out *Genesis) error { return decodeBounded(raw, out, MaxGenesisBytes) }

func decodeBounded(raw []byte, out any, limit int) error {
	if len(raw) == 0 || len(raw) > limit {
		return errors.New("invalid JSON size")
	}
	if e := rejectDuplicateKeys(raw); e != nil {
		return e
	}
	// encoding/json matches struct fields without case sensitivity. Consensus
	// commands require the exact JSON spelling so clients and Go agree on fields.
	generic := json.NewDecoder(bytes.NewReader(raw))
	generic.UseNumber()
	var value any
	if e := generic.Decode(&value); e != nil {
		return e
	}
	if e := exactFields(value, reflect.TypeOf(out)); e != nil {
		return e
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	d.UseNumber()
	if e := d.Decode(out); e != nil {
		return e
	}
	if e := d.Decode(new(any)); e != io.EOF {
		return errors.New("trailing JSON")
	}
	return nil
}

func exactFields(value any, target reflect.Type) error {
	if target == nil {
		return errors.New("missing JSON target")
	}
	for target.Kind() == reflect.Pointer {
		target = target.Elem()
	}
	if target == reflect.TypeOf(json.RawMessage{}) || value == nil {
		return nil
	}
	switch target.Kind() {
	case reflect.Struct:
		object, ok := value.(map[string]any)
		if !ok {
			return errors.New("JSON object required")
		}
		fields := map[string]reflect.Type{}
		for i := 0; i < target.NumField(); i++ {
			f := target.Field(i)
			if f.PkgPath != "" {
				continue
			}
			name := strings.Split(f.Tag.Get("json"), ",")[0]
			if name == "-" {
				continue
			}
			if name == "" {
				name = f.Name
			}
			fields[name] = f.Type
		}
		for name, item := range object {
			field, exists := fields[name]
			if !exists {
				return errors.New("unknown or incorrectly cased JSON field")
			}
			if err := exactFields(item, field); err != nil {
				return err
			}
		}
	case reflect.Slice, reflect.Array:
		if items, ok := value.([]any); ok {
			for _, item := range items {
				if err := exactFields(item, target.Elem()); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// SigningBytes normalizes object-key order using JSON numbers without a float
// conversion. Array order and the typed command field order are preserved.
func SigningBytes(c Command) ([]byte, error) {
	var payload any
	if e := Decode(c.Payload, &payload); e != nil {
		return nil, e
	}
	normalized, e := json.Marshal(payload)
	if e != nil {
		return nil, e
	}
	c.Payload = normalized
	b, e := json.Marshal(c)
	if e != nil {
		return nil, e
	}
	return append([]byte("uain:chain-command:v1\n"), b...), nil
}
func Authenticate(raw []byte, chain string, height int64) (Envelope, error) {
	var env Envelope
	if e := Decode(raw, &env); e != nil {
		return env, e
	}
	c := env.Command
	if c.Version != ProtocolVersion || c.ChainID != chain || chain == "" {
		return env, errors.New("wrong protocol or chain")
	}
	if c.ExpiresHeight < height || c.ExpiresHeight > height+10000 {
		return env, errors.New("expired or excessive transaction lifetime")
	}
	key, e := base64.RawURLEncoding.DecodeString(env.PublicKey)
	if e != nil || !validNativeEd25519Key(key) || Address(key) != c.Member {
		return env, errors.New("invalid member key or address")
	}
	sig, e := base64.RawURLEncoding.DecodeString(env.Signature)
	if e != nil || len(sig) != ed25519.SignatureSize {
		return env, errors.New("invalid signature encoding")
	}
	message, e := SigningBytes(c)
	if e != nil {
		return env, e
	}
	if !ed25519.Verify(key, message, sig) {
		return env, fmt.Errorf("invalid member signature")
	}
	return env, nil
}

package privatedividend

import "errors"

var ErrUnavailable = errors.New("linked dividend Poseidon hash/verifier unavailable")
var ErrInvalid = errors.New("invalid dividend canonical field or hash input")

// Poseidon uses the exact Rust circuit parameters and rejects field aliases.
// HashAvailable does not imply that dividend claims are implemented or active.
type Poseidon struct{}

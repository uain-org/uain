//go:build !orchard || !cgo

package privatedividend

func HashAvailable() bool                                          { return false }
func (Poseidon) Empty(uint16) ([32]byte, error)                    { return [32]byte{}, ErrUnavailable }
func (Poseidon) Leaf([32]byte) ([32]byte, error)                   { return [32]byte{}, ErrUnavailable }
func (Poseidon) Node(uint16, [32]byte, [32]byte) ([32]byte, error) { return [32]byte{}, ErrUnavailable }

func (Poseidon) OwnerLeaf([32]byte, [32]byte, bool) ([32]byte, error) {
	return [32]byte{}, ErrUnavailable
}
func (Poseidon) OwnerNode(uint8, [32]byte, [32]byte) ([32]byte, error) {
	return [32]byte{}, ErrUnavailable
}
func (Poseidon) OwnerEmpty(uint8) ([32]byte, error) { return [32]byte{}, ErrUnavailable }

func (Poseidon) VerifyRegistration([RegistrationPublicSize]byte, []byte, [64]byte) error {
	return ErrUnavailable
}
